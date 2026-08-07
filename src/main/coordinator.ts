import { access, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { AppConfig, DestinationSnapshot, RecordingFile, RecordingRecord, SessionConfigSnapshot, SoftronSource, SourceSnapshot } from '../shared/types.js'
import { ConfigStore } from './config.js'
import { DescriptClient } from './descript.js'
import { RecordLedger } from './ledger.js'
import { changedPaths, contentType, snapshotDirectory, stableFingerprint, validateMediaFile } from './media.js'
import { type MovieRecorderSnapshot, resolveDestinations } from './softron.js'
import { dayEligibility, deterministicProjectName, localDateKey, parseApiDate, recordingFolderDate } from './time.js'

const COALESCE_MS = 10_000
export function normalizeSoftronName(value: string): string { return value.normalize('NFKD').replace(/[^a-z0-9]+/gi, '').toLowerCase() }

export function matchSoftronSource(filename: string, sources: SourceSnapshot[]): SourceSnapshot | null {
  const stem = normalizeSoftronName(filename.slice(0, filename.length - extname(filename).length))
  const exact = sources.filter((source) => source.recordingPaths.some((path) => normalizeSoftronName(basename(path).replace(extname(path), '')) === stem))
  if (exact.length === 1) return exact[0]
  const matches = sources.filter((source) => [source.recordingName, source.displayName, source.deviceName].map(normalizeSoftronName).filter((value) => value.length >= 3).some((value) => stem.includes(value)))
  return matches.length === 1 ? matches[0] : null
}

const sourceSnapshot = (source: SoftronSource): SourceSnapshot => ({
  uniqueId: source.uniqueId, displayName: source.displayName, deviceName: source.deviceName, recordingName: source.recordingName,
  recordingStartDate: source.recordingStartDate, recordingEndDate: source.recordingEndDate,
  enabledDestinationIds: source.enabledDestinationIds, recordingPaths: source.recordingPaths,
  startedAt: parseApiDate(source.recordingStartDate)?.toISOString() ?? null, stoppedAt: parseApiDate(source.recordingEndDate)?.toISOString() ?? null
})

function snapshotConfig(config: AppConfig): SessionConfigSnapshot {
  return {
    softronBaseUrl: config.softron.baseUrl, primarySourceId: config.softron.primarySourceId, enabledSourceIds: config.softron.enabledSourceIds,
    destinationMappings: config.softron.destinationMappings, descriptDestinationRoot: config.descript.destinationRoot,
    recordingTimezone: config.descript.recordingTimezone, recordingDateFormat: config.descript.recordingDateFormat, ffprobePath: config.tools.ffprobePath
  }
}

async function readable(path: string): Promise<boolean> { try { await access(path); return true } catch { return false } }

export class RecordingCoordinator {
  private finalizing = new Set<string>()
  constructor(private readonly config: ConfigStore, private readonly ledger: RecordLedger, private readonly descript: DescriptClient, private readonly changed: () => void) {}

  selected(sources: SoftronSource[]): SoftronSource[] {
    const configured = this.config.get().softron.enabledSourceIds
    return sources.filter((source) => source.isEnabled && (!configured.length || configured.includes(source.uniqueId))).slice(0, 8)
  }

  async assertDestinations(snapshot: MovieRecorderSnapshot): Promise<DestinationSnapshot[]> {
    const config = this.config.get(); const destinations = await resolveDestinations(snapshot.destinations, config)
    const byId = new Map(destinations.map((destination) => [destination.uniqueId, destination]))
    const unresolved = this.selected(snapshot.sources).flatMap((source) => source.enabledDestinationIds.filter((id) => !byId.get(id)?.readable).map((id) => `${source.displayName}: ${id}`))
    if (unresolved.length) throw new Error(`Resolve locally readable destinations before watching: ${unresolved.join(', ')}`)
    return destinations
  }

  async connectionLost(): Promise<void> {
    const record = this.ledger.active()
    if (record?.status === 'recording') await this.ledger.transition(record.id, 'connection_lost', 'MovieRecorder disconnected while the gang was recording.', 'movierecorder_connection_lost')
    this.changed()
  }

  async onSnapshot(snapshot: MovieRecorderSnapshot): Promise<void> {
    const selected = this.selected(snapshot.sources)
    const recording = selected.filter((source) => source.isRecording)
    let active = this.ledger.active()
    if (!active && recording.length) active = await this.begin(snapshot, recording)
    if (!active) { this.changed(); return }
    if (['recording', 'connection_lost'].includes(active.status)) active = await this.reconcileMembership(active, recording)
    const participantIds = new Set(active.sources.map((source) => source.uniqueId))
    const stillRecording = recording.some((source) => participantIds.has(source.uniqueId))
    if (stillRecording) {
      if (active.status === 'connection_lost') await this.ledger.transition(active.id, 'recording')
      this.changed(); return
    }
    if (active.status === 'recording' || active.status === 'connection_lost') void this.finalize(active.id).catch(() => undefined)
    this.changed()
  }

  private async begin(snapshot: MovieRecorderSnapshot, sources: SoftronSource[]): Promise<RecordingRecord> {
    const config = this.config.get(); const destinations = await this.assertDestinations(snapshot)
    const dates = sources.map((source) => parseApiDate(source.recordingStartDate)).filter((date): date is Date => Boolean(date))
    const started = dates.length ? new Date(Math.min(...dates.map((date) => date.getTime()))) : new Date()
    const eligibilityDate = localDateKey(started, config.descript.recordingTimezone)
    const destinationFolder = [config.descript.destinationRoot, recordingFolderDate(started, config.descript.recordingTimezone, config.descript.recordingDateFormat)].filter(Boolean).join('/')
    const record = await this.ledger.create({
      recorderIdentity: snapshot.identity, status: 'recording', eligibilityDate, eligibilityTimezone: config.descript.recordingTimezone,
      sessionStart: started.toISOString(), sessionEnd: null, primarySourceId: config.softron.primarySourceId,
      sources: sources.map(sourceSnapshot), destinations, directoryBaselines: {}, configSnapshot: snapshotConfig(config),
      descriptFolder: destinationFolder, descriptProjectName: deterministicProjectName(started, config.descript.recordingTimezone, sources[0]?.recordingName)
    })
    await this.ledger.addActivity('info', `Gang recording started with ${sources.length} source${sources.length === 1 ? '' : 's'}.`, record.id)
    const baselines: RecordingRecord['directoryBaselines'] = {}
    for (const destination of destinations.filter((item) => item.readable && item.localPath)) baselines[destination.uniqueId] = await snapshotDirectory(destination.localPath!)
    await this.ledger.update(record.id, { directoryBaselines: baselines })
    this.changed(); return this.ledger.find(record.id)!
  }

  private async reconcileMembership(record: RecordingRecord, recording: SoftronSource[]): Promise<RecordingRecord> {
    const participants = new Map(record.sources.map((source) => [source.uniqueId, source])); let ambiguous: string | null = null
    const sessionStart = Date.parse(record.sessionStart ?? record.createdAt)
    for (const source of recording) {
      const current = participants.get(source.uniqueId)
      if (current) { participants.set(source.uniqueId, sourceSnapshot(source)); continue }
      const start = parseApiDate(source.recordingStartDate)?.getTime()
      if (participants.size >= 8 || start == null || Math.abs(start - sessionStart) > COALESCE_MS) ambiguous = `${source.displayName} started outside the gang coalescing window.`
      else participants.set(source.uniqueId, sourceSnapshot(source))
    }
    const updated = await this.ledger.update(record.id, { sources: [...participants.values()] })
    if (ambiguous) return this.ledger.transition(record.id, 'needs_review', ambiguous, 'ambiguous_late_start')
    return updated
  }

  async finalize(recordId: string): Promise<void> {
    if (this.finalizing.has(recordId)) return
    this.finalizing.add(recordId)
    try {
      let record = this.ledger.find(recordId); if (!record) throw new Error('Recording not found.')
      if (record.status === 'needs_review' && record.reasonCode === 'ambiguous_late_start') return
      await this.ledger.transition(recordId, 'finalizing')
      record = this.ledger.find(recordId)!
      const candidatePaths = new Set<string>()
      const destinationById = new Map(record.destinations.map((destination) => [destination.uniqueId, destination]))
      for (const source of record.sources) for (const remotePath of source.recordingPaths) {
        if (await readable(remotePath)) candidatePaths.add(remotePath)
        else for (const destinationId of source.enabledDestinationIds) {
          const root = destinationById.get(destinationId)?.localPath
          if (root) { const mapped = join(root, basename(remotePath)); if (await readable(mapped)) candidatePaths.add(mapped) }
        }
      }
      for (const destination of record.destinations.filter((item) => item.localPath)) {
        const current = await snapshotDirectory(destination.localPath!)
        changedPaths(record.directoryBaselines[destination.uniqueId] ?? {}, current).forEach((path) => candidatePaths.add(path))
      }
      const eligible: Array<{ path: string; source: SourceSnapshot | null; metadata: Awaited<ReturnType<typeof stat>> }> = []
      let dateError: string | null = null
      for (const path of candidatePaths) {
        if (this.ledger.findByFilePath(path) && !record.files.some((file) => file.localPath === path)) continue
        const metadata = await stat(path); const source = matchSoftronSource(basename(path), record.sources)
        const recordingDate = source ? parseApiDate(source.recordingStartDate) : metadata.birthtimeMs > 0 ? metadata.birthtime : null
        const eligibility = dayEligibility(recordingDate, new Date(), record.eligibilityTimezone)
        const fixedLiveDay = record.eligibilityDate === localDateKey(new Date(record.sessionStart ?? record.createdAt), record.eligibilityTimezone)
        if (eligibility === 'after_today') dateError = `${basename(path)} is dated after the next local-day boundary.`
        else if (eligibility === 'unknown') dateError = `${basename(path)} has no trustworthy recording or creation date.`
        else if (eligibility === 'today' || fixedLiveDay) eligible.push({ path, source, metadata })
      }
      if (!eligible.length || dateError) {
        await this.ledger.transition(recordId, 'needs_review', dateError ?? 'No eligible current-day media files were found.', dateError ? 'invalid_recording_date' : 'no_media')
        return
      }
      await this.ledger.transition(recordId, 'validating')
      const primaryId = record.primarySourceId
      const grouped = new Map<string, number>()
      const results = await Promise.all(eligible.map(async ({ path, source, metadata }, index): Promise<RecordingFile> => {
        const fingerprint = await stableFingerprint(path)
        const validation = await validateMediaFile(path, record!.configSnapshot.ffprobePath, fingerprint)
        const group = source?.uniqueId ?? `unmatched-${index}`; const segmentIndex = grouped.get(group) ?? 0; grouped.set(group, segmentIndex + 1)
        const sourceStart = source ? parseApiDate(source.recordingStartDate)?.getTime() : null
        const start = sourceStart ?? Number(metadata.birthtimeMs)
        const timelineOffsetSeconds = Math.max(0, (start - Date.parse(record!.sessionStart ?? record!.createdAt)) / 1000)
        return {
          id: randomUUID(), sourceId: source?.uniqueId ?? null, sourceLabel: source?.displayName ?? basename(path), role: source?.uniqueId === primaryId ? 'primary' : 'iso',
          localPath: path, originalFilename: basename(path), mediaKey: `${source?.displayName ?? 'Unmatched'} — ${basename(path)}`,
          contentType: contentType(path), segmentIndex, timelineOffsetSeconds, fingerprint,
          stability: 'stable', validation, uploadStatus: 'pending', error: validation.error
        }
      }))
      const problems = [
        ...results.filter((file) => !file.validation?.ok).map((file) => `${file.originalFilename}: ${file.validation?.error}`),
        ...results.filter((file) => !file.sourceId).map((file) => `${file.originalFilename} could not be associated with a source.`),
        ...(!results.some((file) => file.role === 'primary') ? ['No primary source was identified.'] : [])
      ]
      const endDates = record.sources.map((source) => parseApiDate(source.recordingEndDate)).filter((date): date is Date => Boolean(date))
      await this.ledger.update(recordId, { files: results, sessionEnd: (endDates.length ? new Date(Math.max(...endDates.map((date) => date.getTime()))) : new Date()).toISOString() })
      if (problems.length) { await this.ledger.transition(recordId, 'needs_review', problems.join(' '), 'validation_failed'); return }
      await this.ledger.addActivity('success', `Validated ${results.length} file${results.length === 1 ? '' : 's'} for one multitrack import.`, recordId)
      await this.descript.upload(recordId)
    } catch (error) {
      const record = this.ledger.find(recordId)
      if (record && !['needs_review', 'failed', 'processing', 'completed'].includes(record.status)) await this.ledger.transition(recordId, 'needs_review', error instanceof Error ? error.message : String(error), 'finalization_failed')
    } finally { this.finalizing.delete(recordId); this.changed() }
  }

  async recover(): Promise<void> {
    const today = localDateKey(new Date(), this.config.get().descript.recordingTimezone)
    for (const record of this.ledger.records().reverse()) {
      const prior = record.eligibilityDate != null && record.eligibilityDate < today
      const hasRemote = Boolean(record.descriptJobId || record.descriptProjectId)
      if (prior && !hasRemote && !['completed', 'skipped'].includes(record.status)) {
        await this.ledger.transition(record.id, 'skipped', 'This recording is outside the current local calendar day.', 'outside_local_day'); continue
      }
      if (hasRemote && ['reconciling', 'uploading', 'processing'].includes(record.status)) {
        try { await this.descript.reconcile(record.id) } catch (error) { await this.ledger.transition(record.id, 'needs_review', error instanceof Error ? error.message : String(error), 'recovery_reconciliation_failed') }
      } else if (!prior && ['finalizing', 'validating'].includes(record.status)) await this.finalize(record.id)
      else if (record.status === 'uploading' && !hasRemote) await this.ledger.transition(record.id, 'needs_review', 'The prior import request has no remote ID; reconcile before retrying.', 'ambiguous_import')
    }
  }

  async retry(recordId: string): Promise<void> {
    const record = this.ledger.find(recordId); if (!record) throw new Error('Recording not found.')
    const today = localDateKey(new Date(), record.eligibilityTimezone)
    if (record.eligibilityDate !== today && !record.descriptJobId && !record.descriptProjectId) throw new Error('Prior-day recordings cannot begin a new upload.')
    await this.ledger.update(recordId, { retryCount: record.retryCount + 1, error: null, reasonCode: null })
    if (record.descriptJobId || record.descriptProjectId || ['reconciling', 'uploading', 'processing'].includes(record.status)) {
      const outcome = await this.descript.reconcile(recordId)
      if (outcome === 'missing' && record.eligibilityDate === today) await this.descript.upload(recordId)
    } else await this.finalize(recordId)
    this.changed()
  }

  async setPrimary(recordId: string, sourceId: string): Promise<void> {
    const record = this.ledger.find(recordId); if (!record || !record.sources.some((source) => source.uniqueId === sourceId)) throw new Error('Selected source does not belong to this recording.')
    const files = record.files.map((file) => ({ ...file, role: file.sourceId === sourceId ? 'primary' as const : 'iso' as const }))
    await this.ledger.update(recordId, { primarySourceId: sourceId, files, status: 'needs_review', error: 'Primary source updated. Retry to validate and reconcile.', reasonCode: 'primary_updated' }); this.changed()
  }
}
