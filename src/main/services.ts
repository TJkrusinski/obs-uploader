import { createReadStream, promises as fs } from 'node:fs'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { CaptureSession, ConnectionState, RecordingDateFormat, VmixState } from '../shared/types.js'
import { LedgerDatabase } from './database.js'
import { buildDescriptImportBody } from './descript-import.js'
import { SettingsStore } from './settings.js'
import { parseVmixManifestMediaNames, vmixProjectNameFromManifest } from './vmix-manifest.js'
import { inspectVmixProjectContents, type VmixProjectContents } from './vmix-reconciliation.js'

const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm'])
const FILE_STABILITY_DELAY_MS = 2_000

type RemoteProject = { id: string; name: string; folder_path: string }
type RemoteProjectDetails = RemoteProject & VmixProjectContents

async function descriptApiError(context: string, response: Response): Promise<Error> {
  const body = await response.text()
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  return new Error(`${context} (${status})${body ? `: ${body}` : ''}`)
}

function recordingDate(date: Date, timeZone: string, format: RecordingDateFormat): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date)
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? ''
  const year = value('year').slice(-2); const month = value('month'); const day = value('day')
  if (format === 'M.d.yy') return `${month}.${day}.${year}`
  if (format === 'MM.dd.yy') return `${month.padStart(2, '0')}.${day.padStart(2, '0')}.${year}`
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}
function fileRecordingDate(stats: Stats): Date {
  return stats.birthtimeMs ? stats.birthtime : stats.mtime
}
function recordingDayKey(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? ''
  return `${value('year')}-${value('month')}-${value('day')}`
}
export function isSameRecordingDay(left: Date, right: Date, timeZone: string): boolean {
  return recordingDayKey(left, timeZone) === recordingDayKey(right, timeZone)
}
export function isBeforeRecordingDay(left: Date, right: Date, timeZone: string): boolean {
  return recordingDayKey(left, timeZone) < recordingDayKey(right, timeZone)
}
function projectName(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}_${value('hour')}-${value('minute')}-${value('second')}`
}
function contentType(path: string): string {
  return ({
    '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.m4v': 'video/x-m4v', '.mov': 'video/quicktime',
    '.webm': 'video/webm'
  } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export class DescriptService {
  private readonly activeUploads = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly activePolls = new Map<string, Set<AbortController>>()

  constructor(private readonly settings: SettingsStore, private readonly ledger: LedgerDatabase) {}

  async test(tokenOverride?: string): Promise<{ ok: boolean; message: string }> {
    const token = tokenOverride?.trim() || await this.settings.getDescriptToken()
    if (!token) return { ok: false, message: 'Add a Descript API token first.' }
    const response = await fetch('https://descriptapi.com/v1/projects?limit=1', { headers: { Authorization: `Bearer ${token}` } })
    if (response.ok) return { ok: true, message: 'Token verified. Your destination folder will be created on the first import if needed.' }
    return { ok: false, message: (await descriptApiError('Descript rejected this token', response)).message }
  }

  async reconcile(): Promise<void> {
    const uploadsEnabled = this.settings.get().uploadsEnabled
    const token = await this.settings.getDescriptToken()
    if (!token && uploadsEnabled) throw new Error('Connect Descript before reconciling recordings.')
    const pending = this.ledger.getPendingSessions()
    if (token) {
      await this.pollProcessing(token)
      const remote = await this.listProjects(token)
      for (const session of pending.filter((item) => item.status === 'ready')) {
        const match = remote.find((project) => project.folder_path === session.descriptFolderPath && project.name === session.descriptProjectName)
        if (!match) continue
        if (session.recorderType === 'vmix') {
          await this.reconcileVmixProject(token, session, match)
        } else {
          session.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
          this.ledger.updateSession(session.id, { status: 'completed', descriptProjectId: match.id, errorMessage: null })
        }
      }
    }
    this.ledger.addActivity('info', `Reconciliation checked ${pending.length} queued session${pending.length === 1 ? '' : 's'}.`)
    if (uploadsEnabled) {
      for (const session of this.ledger.getPendingSessions().filter((item) => item.status === 'ready')) await this.upload(session)
    }
  }

  async upload(session: CaptureSession): Promise<void> {
    if (!this.settings.get().uploadsEnabled || session.uploadExcluded) return
    if (this.activeUploads.has(session.id)) return
    const controller = new AbortController()
    let finish!: () => void
    const operation = { controller, done: new Promise<void>((resolve) => { finish = resolve }) }
    this.activeUploads.set(session.id, operation)
    try {
      const token = await this.settings.getDescriptToken()
      if (!token) throw new Error('Connect Descript before uploading sessions.')
      controller.signal.throwIfAborted()
      const current = this.ledger.getSession(session.id)
      if (!this.settings.get().uploadsEnabled || !current || current.uploadExcluded || current.status !== 'ready') return
      const files = current.files.filter((file) => file.uploadStatus !== 'excluded')
      const nonVideoFiles = files.filter((file) => !file.contentType.startsWith('video/'))
      if (nonVideoFiles.length) {
        throw new Error(`Only video files can be uploaded. Remove or exclude: ${nonVideoFiles.map((file) => `${file.sourceLabel} — ${file.originalFilename}`).join('; ')}`)
      }
      const filesToUpload = files.filter((file) => file.uploadStatus !== 'uploaded')
      const primary = files.filter((file) => file.sourceRole === 'primary')
      if (!primary.length) throw new Error('This session has no primary recording.')
      if (files.some((file) => file.stabilityStatus !== 'stable')) throw new Error('Every included file must be stable before upload.')
      this.ledger.updateSession(session.id, { status: 'uploading', errorMessage: null })
      const body = buildDescriptImportBody(current, {
        projectId: current.recorderType === 'vmix' ? current.descriptProjectId ?? undefined : undefined,
        directUploadFileIds: new Set(filesToUpload.map((file) => file.id))
      })
      const response = await fetch('https://descriptapi.com/v1/jobs/import/project_media', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
      })
      if (!response.ok) throw await descriptApiError('Descript import request failed', response)
      const result = await response.json() as { job_id: string; project_id: string; upload_urls?: Record<string, { upload_url: string }> }
      controller.signal.throwIfAborted()
      this.ledger.updateSession(session.id, { descriptJobId: result.job_id, descriptProjectId: result.project_id })
      for (const file of filesToUpload) {
        controller.signal.throwIfAborted()
        const source = await fs.stat(file.localPath)
        if (!source.isFile() || source.size !== file.fileSize) throw new Error(`${file.sourceLabel} — ${file.originalFilename} changed before upload.`)
        const uploadUrl = result.upload_urls?.[file.descriptMediaKey]?.upload_url
        if (!uploadUrl) throw new Error(`Descript did not return an upload target for ${file.sourceLabel} — ${file.originalFilename}.`)
        this.ledger.updateFile(file.id, { uploadStatus: 'uploading', errorMessage: null })
        const stream = Readable.toWeb(createReadStream(file.localPath)) as ReadableStream
        const upload = await fetch(uploadUrl, { method: 'PUT', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(source.size) }, signal: controller.signal } as RequestInit & { duplex: 'half' })
        if (!upload.ok) throw await descriptApiError(`File transfer to Descript failed for ${file.sourceLabel} — ${file.originalFilename}`, upload)
        this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null })
      }
      controller.signal.throwIfAborted()
      this.ledger.updateSession(session.id, { status: 'processing' })
      this.ledger.addActivity('info', `Sent ${filesToUpload.length} file${filesToUpload.length === 1 ? '' : 's'} from ${current.descriptProjectName} to Descript for processing.`)
    } catch (error) {
      if (controller.signal.aborted || this.ledger.getSession(session.id)?.status === 'canceled') return
      const uploading = this.ledger.getSession(session.id)?.files.find((file) => file.uploadStatus === 'uploading')
      if (uploading) this.ledger.updateFile(uploading.id, { uploadStatus: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
      this.ledger.updateSession(session.id, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
      this.ledger.addActivity('error', `Upload failed for session ${session.descriptProjectName}: ${error instanceof Error ? error.message : String(error)}`)
      throw error
    } finally {
      if (this.activeUploads.get(session.id) === operation) this.activeUploads.delete(session.id)
      finish()
    }
  }

  async cancel(session: CaptureSession): Promise<void> {
    if (!['ready', 'uploading', 'processing'].includes(session.status)) throw new Error('Only queued or active sessions can be canceled.')
    this.ledger.updateSession(session.id, { status: 'canceled', errorMessage: null })
    const operation = this.activeUploads.get(session.id)
    operation?.controller.abort()
    for (const controller of this.activePolls.get(session.id) ?? []) controller.abort()
    if (operation) await operation.done
    this.ledger.addActivity('warning', `Canceled session ${session.descriptProjectName}.`)

    if (!session.descriptJobId) return
    const token = await this.settings.getDescriptToken()
    if (!token) throw new Error('The upload was stopped locally, but the Descript job could not be canceled because no API token is available.')
    const response = await fetch(`https://descriptapi.com/v1/jobs/${session.descriptJobId}`, {
      method: 'DELETE', headers: { Authorization: `Bearer ${token}` }
    })
    if (!response.ok && response.status !== 404) throw await descriptApiError('The upload was stopped locally, but Descript could not cancel the remote job', response)
  }

  async stopLocalWork(sessions: CaptureSession[]): Promise<void> {
    const operations: Promise<void>[] = []
    for (const session of sessions) {
      const operation = this.activeUploads.get(session.id)
      if (operation) {
        operation.controller.abort()
        operations.push(operation.done)
      }
      for (const controller of this.activePolls.get(session.id) ?? []) controller.abort()
    }
    await Promise.all(operations)
  }

  private async listProjects(token: string): Promise<RemoteProject[]> {
    const results: RemoteProject[] = []
    let cursor: string | undefined
    do {
      const url = new URL('https://descriptapi.com/v1/projects')
      url.searchParams.set('limit', '100')
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw await descriptApiError('Unable to list Descript projects', response)
      const page = await response.json() as { data: RemoteProject[]; pagination?: { next_cursor?: string } }
      results.push(...page.data); cursor = page.pagination?.next_cursor
    } while (cursor)
    return results
  }

  private async reconcileVmixProject(token: string, session: CaptureSession, project: RemoteProject): Promise<void> {
    const response = await fetch(`https://descriptapi.com/v1/projects/${project.id}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw await descriptApiError(`Unable to inspect Descript project ${project.name}`, response)
    const details = await response.json() as RemoteProjectDetails
    const inspection = inspectVmixProjectContents(session.files, details)
    for (const fileId of inspection.uploadedFileIds) this.ledger.updateFile(fileId, { uploadStatus: 'uploaded', errorMessage: null })
    if (inspection.invalidFiles.length) {
      const message = `Descript returned incomplete or incorrectly classified media: ${inspection.invalidFiles.map((file) => `${file.mediaKey} is ${file.actualType}; expected ${file.expectedType}`).join('; ')}. Reset and retry to upload into a fresh project.`
      for (const file of inspection.invalidFiles) this.ledger.updateFile(file.id, { uploadStatus: 'failed', errorMessage: message })
      this.ledger.updateSession(session.id, { status: 'failed', descriptProjectId: project.id, errorMessage: message })
      this.ledger.addActivity('error', `${session.descriptProjectName}: ${message}`)
      return
    }
    this.ledger.updateSession(session.id, { descriptProjectId: project.id, errorMessage: null })
    if (inspection.complete) {
      this.ledger.updateSession(session.id, { status: 'completed', descriptProjectId: project.id, errorMessage: null })
    }
  }

  private async pollProcessing(token: string): Promise<void> {
    for (const session of this.ledger.getSessions().filter((item) => ['processing', 'needs_review'].includes(item.status) && item.descriptJobId)) {
      const controller = new AbortController()
      const controllers = this.activePolls.get(session.id) ?? new Set<AbortController>()
      controllers.add(controller)
      this.activePolls.set(session.id, controllers)
      try {
        const response = await fetch(`https://descriptapi.com/v1/jobs/${session.descriptJobId}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        if (!response.ok) throw await descriptApiError(`Unable to check Descript job ${session.descriptJobId}`, response)
        const job = await response.json() as { job_state?: string; result?: { status?: string; [key: string]: unknown } }
        if (!['stopped', 'cancelled', 'canceled'].includes(job.job_state ?? '')) continue
        const current = this.ledger.getSession(session.id)
        if (!current || !['processing', 'needs_review'].includes(current.status) || current.descriptJobId !== session.descriptJobId) continue
        if (job.result?.status === 'success') {
          current.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
          this.ledger.updateSession(session.id, { status: 'completed', errorMessage: null })
          this.ledger.addActivity('success', `${session.descriptProjectName} finished processing in Descript.`)
        } else {
          const details = job.result ? JSON.stringify(job.result) : JSON.stringify(job)
          const message = `Descript processing did not complete successfully: ${details}`
          this.ledger.updateSession(session.id, { status: 'failed', errorMessage: message })
          this.ledger.addActivity('error', `${session.descriptProjectName}: ${message}`)
        }
      } catch (error) {
        if (!controller.signal.aborted) throw error
      } finally {
        controllers.delete(controller)
        if (controllers.size === 0 && this.activePolls.get(session.id) === controllers) this.activePolls.delete(session.id)
      }
    }
  }
}

export class RecordingWatcher {
  private readonly watchers: FSWatcher[] = []
  private scanTimer: NodeJS.Timeout | null = null
  private readonly pendingIngestions = new Map<string, Promise<void>>()
  private readonly pendingVmixManifests = new Map<string, Promise<void>>()
  private readonly vmixManifestErrors = new Map<string, string>()
  private active = false
  private obsStopEventsAvailable = false
  constructor(
    private readonly settings: SettingsStore,
    private readonly ledger: LedgerDatabase,
    private readonly onChange: () => void,
    private readonly onRecordingReady: (session: CaptureSession) => Promise<void>
  ) {}
  isWatching(): boolean { return this.active }
  async start(): Promise<void> {
    this.stop()
    const settings = this.settings.get()
    const directories: string[] = []
    if (settings.recorderType === 'obs') {
      if (!settings.recordingsDirectory) throw new Error('Connect OBS or choose its recordings folder before monitoring it.')
      await fs.access(settings.recordingsDirectory)
      directories.push(settings.recordingsDirectory)
      this.watchDirectory(settings.recordingsDirectory, (filename) => {
        if (filename && !this.obsStopEventsAvailable) void this.ingest(join(settings.recordingsDirectory!, filename.toString()))
      })
    }
    if (settings.recorderType === 'vmix') {
      if (!settings.reconciliationDirectory) throw new Error('Choose the reconciliation folder where vMix writes MultiCorder XML manifests.')
      await fs.access(settings.reconciliationDirectory)
      directories.push(settings.reconciliationDirectory)
      this.watchDirectory(settings.reconciliationDirectory, (filename) => {
        if (filename && extname(filename.toString()).toLowerCase() === '.xml') {
          void this.ingestVmixManifest(join(settings.reconciliationDirectory!, filename.toString()))
        }
      })
    }
    if (!directories.length) throw new Error('Choose OBS or vMix before starting monitoring.')
    this.scanTimer = setInterval(() => void this.scan(), 10_000)
    this.active = true
    await this.scan()
    this.ledger.addActivity('success', `Monitoring ${directories.length} recording location${directories.length === 1 ? '' : 's'}.`)
    this.onChange()
  }
  stop(): void {
    this.watchers.splice(0).forEach((watcher) => watcher.close())
    if (this.scanTimer) clearInterval(this.scanTimer)
    this.scanTimer = null; this.active = false; this.onChange()
  }
  setObsStopEventsAvailable(available: boolean): void { this.obsStopEventsAvailable = available }
  private watchDirectory(directory: string, onFilename: (filename: string | Buffer | null) => void): void {
    try {
      const directoryWatcher = watch(directory, { persistent: false }, (_event, filename) => onFilename(filename))
      directoryWatcher.on('error', (error) => {
        this.ledger.addActivity('warning', `Native watching failed for ${directory}; periodic scanning will continue (${error.message}).`)
        this.onChange()
      })
      this.watchers.push(directoryWatcher)
    } catch (error) {
      this.ledger.addActivity('warning', `Native watching could not start for ${directory}; periodic scanning will continue (${error instanceof Error ? error.message : String(error)}).`)
    }
  }
  async scan(): Promise<void> {
    const settings = this.settings.get()
    const dir = settings.recordingsDirectory
    if (settings.recorderType === 'obs' && dir && !this.obsStopEventsAvailable) await this.scanDirectory(dir)
    if (settings.recorderType === 'vmix') await this.scanVmixManifests()
  }
  async scanReconciliationDirectory(): Promise<void> {
    const settings = this.settings.get()
    if (settings.recorderType === 'vmix') {
      await this.scanVmixManifests()
      return
    }
    const dir = settings.reconciliationDirectory ?? settings.recordingsDirectory
    const today = new Date()
    if (dir) await this.scanDirectory(dir, (stats) => isSameRecordingDay(fileRecordingDate(stats), today, settings.recordingTimezone))
  }
  async recordingStopped(path: string): Promise<void> {
    if (this.active) await this.ingest(path)
  }
  async vmixStateChanged(recording: boolean, multiCorder: boolean): Promise<void> {
    void recording
    void multiCorder
  }
  async finalizeSessionManually(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session || session.recorderType !== 'vmix') throw new Error('vMix session not found.')
    if (!['needs_review', 'connection_lost', 'finalizing'].includes(session.status)) throw new Error('Only a session awaiting review can be finalized manually.')
    const included = session.files.filter((file) => file.uploadStatus !== 'excluded')
    const stable = await Promise.all(included.map((file) => this.stableFile(file.localPath)))
    stable.forEach((stats, index) => this.ledger.updateFile(included[index].id, {
      fileSize: stats.size, modifiedAt: stats.mtime.toISOString(), stabilityStatus: 'stable', errorMessage: null
    }))
    if (!included.some((file) => file.sourceRole === 'primary')) throw new Error('No primary recording was discovered.')
    this.ledger.updateSession(id, { status: 'ready', sessionEnd: new Date().toISOString(), finalizationSource: 'manual', errorMessage: null })
    const ready = this.ledger.getSession(id)!
    this.onChange()
    void this.onRecordingReady(ready).catch(() => this.onChange())
  }
  async recheckSession(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session) throw new Error('Session not found.')
    for (const file of session.files.filter((item) => item.uploadStatus !== 'excluded')) {
      try {
        const stats = await this.stableFile(file.localPath)
        this.ledger.updateFile(file.id, { fileSize: stats.size, modifiedAt: stats.mtime.toISOString(), stabilityStatus: 'stable', errorMessage: null })
      } catch {
        this.ledger.updateFile(file.id, { stabilityStatus: 'missing', uploadStatus: 'missing', errorMessage: 'File is missing or still changing.' })
      }
    }
    this.onChange()
  }
  vmixConnectionLost(): void {}
  private async scanDirectory(dir: string, include?: (stats: Stats) => boolean): Promise<void> {
    for (const name of await fs.readdir(dir)) {
      const path = join(dir, name)
      if (!include) {
        await this.ingest(path)
        continue
      }
      try {
        const stats = await fs.stat(path)
        if (include(stats)) await this.ingest(path)
      } catch { /* A file may disappear while the directory is being scanned. */ }
    }
  }
  private async scanVmixManifests(): Promise<void> {
    const directory = this.settings.get().reconciliationDirectory
    if (directory) {
      for (const name of await fs.readdir(directory)) {
        if (extname(name).toLowerCase() === '.xml') await this.ingestVmixManifest(join(directory, name))
      }
    }
  }
  private async ingestVmixManifest(path: string): Promise<void> {
    const canonical = canonicalPath(path)
    if (this.ledger.hasVmixManifest(path, canonical)) return
    const pending = this.pendingVmixManifests.get(canonical)
    if (pending) return pending
    const operation = this.ingestVmixManifestWhenReady(path).catch((error) => {
      const message = error instanceof Error ? error.message : String(error)
      if (this.vmixManifestErrors.get(canonical) !== message) {
        this.vmixManifestErrors.set(canonical, message)
        this.ledger.addActivity('warning', `${basename(path)} is not ready: ${message}`)
        this.onChange()
      }
    }).finally(() => {
      if (this.pendingVmixManifests.get(canonical) === operation) this.pendingVmixManifests.delete(canonical)
    })
    this.pendingVmixManifests.set(canonical, operation)
    return operation
  }
  private async ingestVmixManifestWhenReady(path: string): Promise<void> {
    const canonical = canonicalPath(path)
    const xml = await fs.readFile(path, 'utf8')
    const filenames = parseVmixManifestMediaNames(xml)
    const directory = dirname(path)
    const directoryEntries = new Map<string, string>()
    for (const name of await fs.readdir(directory)) directoryEntries.set(process.platform === 'win32' ? name.toLowerCase() : name, name)
    const resolvedPaths: string[] = []
    for (const filename of filenames) {
      const actual = directoryEntries.get(process.platform === 'win32' ? filename.toLowerCase() : filename)
      if (!actual) throw new Error(`Referenced media file was not found beside the XML manifest: ${filename}`)
      const mediaPath = join(directory, actual)
      if (!SUPPORTED_VIDEO_EXTENSIONS.has(extname(mediaPath).toLowerCase())) throw new Error(`Referenced media file is not a supported video: ${filename}`)
      if (this.ledger.getByPath(mediaPath)) throw new Error(`Referenced media file already belongs to another session: ${filename}`)
      resolvedPaths.push(mediaPath)
    }
    const resolvedFiles = await Promise.all(resolvedPaths.map(async (filePath) => ({ path: filePath, stats: await this.stableFile(filePath) })))
    const manifestStats = await fs.stat(path)
    const settings = this.settings.get()
    const startedAt = new Date(Math.min(...resolvedFiles.map((file) => file.stats.birthtimeMs || file.stats.mtimeMs)))
    const folder = [settings.descriptDestinationRoot, recordingDate(startedAt, settings.recordingTimezone, settings.recordingDateFormat)].filter(Boolean).join('/')
    const usedKeys = new Set<string>()
    const primaryIndex = Math.max(0, resolvedFiles.findIndex((file) => /\bOutput\s+\d+\b/i.test(basename(file.path))))
    const files = resolvedFiles.map((file, index) => {
      const filename = basename(file.path)
      const sourceLabel = sourceLabelFromVmixFilename(filename)
      const mediaKey = uniqueMediaKeyFromSet(usedKeys, sourceLabel, filename)
      return {
        locationId: `vmix-track-${index + 1}`, sourceLabel, sourceRole: index === primaryIndex ? 'primary' as const : 'iso' as const,
        localPath: file.path, originalFilename: filename, descriptMediaKey: mediaKey, contentType: contentType(file.path),
        fileSize: file.stats.size, modifiedAt: file.stats.mtime.toISOString(), segmentIndex: 0,
        stabilityStatus: 'stable' as const, uploadStatus: 'pending' as const
      }
    })
    const hasPrimary = files.some((file) => file.sourceRole === 'primary')
    const manifestProjectName = vmixProjectNameFromManifest(path)
    const session = this.ledger.createSession({
      recorderType: 'vmix', status: hasPrimary ? 'ready' : 'needs_review', sessionStart: startedAt.toISOString(),
      sessionEnd: manifestStats.mtime.toISOString(), finalizationSource: 'filesystem',
      descriptFolderPath: folder, descriptProjectName: manifestProjectName,
      descriptProjectId: null, descriptJobId: null,
      configurationSnapshot: JSON.stringify({
        recorderType: 'vmix', confirmation: 'multicorder_manifest', manifestPath: path, manifestKey: canonical,
        host: settings.vmixHost, port: settings.vmixPort, useApi: settings.vmixUseApi, directory
      })
    }, files)
    this.vmixManifestErrors.delete(canonical)
    if (!hasPrimary) {
      this.ledger.updateSession(session.id, { errorMessage: 'No primary recording was referenced by the MultiCorder manifest.' })
      this.ledger.addActivity('warning', `MultiCorder manifest needs review: ${basename(path)}.`)
    } else {
      this.ledger.addActivity('success', `MultiCorder manifest ready: ${files.length} file${files.length === 1 ? '' : 's'} from ${basename(path)}.`)
      void this.onRecordingReady(session).catch(() => this.onChange())
    }
    this.onChange()
  }
  private async stableFile(path: string): Promise<Stats> {
    let stats = await fs.stat(path)
    if (!stats.isFile() || stats.size === 0) throw new Error(`${basename(path)} is empty or unavailable.`)
    for (let probe = 1; probe < 3; probe += 1) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, FILE_STABILITY_DELAY_MS))
      const next = await fs.stat(path)
      if (!next.isFile() || next.size === 0 || next.size !== stats.size || next.mtimeMs !== stats.mtimeMs) {
        throw new Error(`${basename(path)} is still changing.`)
      }
      stats = next
    }
    return stats
  }
  async ingest(path: string): Promise<void> {
    if (!SUPPORTED_VIDEO_EXTENSIONS.has(extname(path).toLowerCase()) || this.ledger.getByPath(path)) return
    const pending = this.pendingIngestions.get(path)
    if (pending) return pending
    const ingestion = this.ingestWhenReady(path).finally(() => {
      if (this.pendingIngestions.get(path) === ingestion) this.pendingIngestions.delete(path)
    })
    this.pendingIngestions.set(path, ingestion)
    return ingestion
  }
  private async ingestWhenReady(path: string): Promise<void> {
    try {
      let stable = await fs.stat(path)
      if (!stable.isFile() || stable.size === 0) return
      for (let probe = 1; probe < 3; probe += 1) {
        await new Promise((resolve) => setTimeout(resolve, FILE_STABILITY_DELAY_MS))
        const next = await fs.stat(path)
        if (!next.isFile() || next.size === 0 || next.size !== stable.size || next.mtimeMs !== stable.mtimeMs) return
        stable = next
      }
      if (this.ledger.getByPath(path)) return
      const settings = this.settings.get(); const date = fileRecordingDate(stable)
      const folder = [settings.descriptDestinationRoot, recordingDate(date, settings.recordingTimezone, settings.recordingDateFormat)].filter(Boolean).join('/')
      const filename = basename(path)
      const session = this.ledger.createSession({
        recorderType: 'obs', status: 'ready', sessionStart: date.toISOString(), sessionEnd: new Date().toISOString(),
        finalizationSource: 'obs_event', descriptFolderPath: folder, descriptProjectName: projectName(date, settings.recordingTimezone),
        descriptProjectId: null, descriptJobId: null,
        configurationSnapshot: JSON.stringify({ recorderType: 'obs', recordingsDirectory: settings.recordingsDirectory })
      }, [{
        locationId: 'obs-primary', sourceLabel: 'Program', sourceRole: 'primary', localPath: path,
        originalFilename: filename, descriptMediaKey: filename, contentType: contentType(path), fileSize: stable.size,
        modifiedAt: stable.mtime.toISOString(), segmentIndex: 0, stabilityStatus: 'stable', uploadStatus: 'pending'
      }])
      this.ledger.addActivity('info', `Discovered ${basename(path)}.`); this.onChange()
      void this.onRecordingReady(session).catch(() => this.onChange())
    } catch { /* File may have been removed or is still being written. */ }
  }
}

function canonicalPath(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function sourceLabelFromVmixFilename(filename: string): string {
  const stem = filename.slice(0, filename.length - extname(filename).length)
  return stem.replace(/^MultiCorder\d*\s*-\s*/i, '').replace(/\s+-\s+\d{1,2}\s+\w+\s+\d{4}\s+-\s+.*$/i, '').trim() || stem
}
function uniqueMediaKeyFromSet(used: Set<string>, sourceLabel: string, filename: string): string {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  const base = `${sourceLabel} — ${stem}`
  let candidate = `${base}${extension}`
  let suffix = 2
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${suffix++})${extension}`
  used.add(candidate.toLowerCase())
  return candidate
}

export class VmixService {
  private state: ConnectionState['vmix'] = 'disconnected'
  private recorderState: VmixState = { recording: false, multiCorder: false, lastSuccessfulPoll: null }
  private pollTimer: NodeJS.Timeout | null = null
  private polling = false
  constructor(
    private readonly onChange: () => void,
    private readonly onState: (recording: boolean, multiCorder: boolean) => Promise<void>,
    private readonly onConnectionLost: () => void
  ) {}
  getState(): ConnectionState['vmix'] { return this.state }
  getRecorderState(): VmixState { return this.recorderState }
  async connect(input: { host: string; port: number }): Promise<{ ok: boolean; message: string; recording: boolean; multiCorder: boolean }> {
    this.state = 'connecting'; this.onChange()
    try {
      const recorderState = await this.fetchState(input)
      this.state = 'connected'; this.recorderState = recorderState; this.onChange()
      await this.onState(recorderState.recording, recorderState.multiCorder)
      return { ok: true, message: 'Connected to vMix.', recording: recorderState.recording, multiCorder: recorderState.multiCorder }
    } catch (error) {
      this.state = 'disconnected'; this.onChange()
      return { ok: false, message: error instanceof Error ? error.message : 'Could not connect to vMix.', recording: false, multiCorder: false }
    }
  }
  start(input: { host: string; port: number }): void {
    this.stop()
    void this.poll(input)
    this.pollTimer = setInterval(() => void this.poll(input), 2_000)
  }
  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
    this.pollTimer = null
  }
  private async poll(input: { host: string; port: number }): Promise<void> {
    if (this.polling) return
    this.polling = true
    try {
      const next = await this.fetchState(input)
      this.state = 'connected'; this.recorderState = next
      await this.onState(next.recording, next.multiCorder)
    } catch {
      const wasConnected = this.state === 'connected'
      this.state = 'disconnected'
      if (wasConnected) this.onConnectionLost()
    } finally {
      this.polling = false; this.onChange()
    }
  }
  private async fetchState(input: { host: string; port: number }): Promise<VmixState> {
    const response = await fetch(`http://${input.host}:${input.port}/api`, { signal: AbortSignal.timeout(5_000) })
    if (!response.ok) throw new Error(`vMix returned ${response.status}.`)
    const xml = await response.text()
    const value = (tag: string) => new RegExp(`<${tag}>\\s*True\\s*</${tag}>`, 'i').test(xml)
    if (!/<vmix[\s>]/i.test(xml)) throw new Error('The server response was not a vMix API document.')
    return { recording: value('recording'), multiCorder: value('multiCorder'), lastSuccessfulPoll: new Date().toISOString() }
  }
}

export class ObsService {
  private readonly obs = new OBSWebSocket()
  private state: ConnectionState['obs'] = 'disconnected'
  constructor(
    private readonly settings: SettingsStore,
    private readonly onChange: () => void,
    private readonly onRecordingStopped: (path: string) => Promise<void>,
    private readonly onStopEventsAvailabilityChange: (available: boolean) => void
  ) {
    this.obs.on('ConnectionClosed', () => { this.state = 'disconnected'; this.onStopEventsAvailabilityChange(false); this.onChange() })
    this.obs.on('RecordStateChanged', ({ outputActive, outputPath }) => {
      if (!outputActive && outputPath) void this.onRecordingStopped(outputPath).catch(() => undefined)
    })
  }
  getState(): ConnectionState['obs'] { return this.state }
  async connect(input: { host: string; port: number; password?: string }): Promise<{ ok: boolean; message: string; recordingDirectory?: string }> {
    this.state = 'connecting'; this.onChange()
    try {
      const password = input.password || await this.settings.getObsPassword() || undefined
      await this.obs.connect(`ws://${input.host}:${input.port}`, password, { eventSubscriptions: EventSubscription.Outputs })
      const { recordDirectory } = await this.obs.call('GetRecordDirectory') as { recordDirectory: string }
      this.state = 'connected'; this.onStopEventsAvailabilityChange(true); this.onChange()
      return { ok: true, message: 'Connected to OBS.', recordingDirectory: recordDirectory }
    } catch (error) { this.state = 'disconnected'; this.onStopEventsAvailabilityChange(false); this.onChange(); return { ok: false, message: error instanceof Error ? error.message : 'Could not connect to OBS.' } }
  }
}
