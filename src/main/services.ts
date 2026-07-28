import { createReadStream, promises as fs } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { CaptureSession, ConnectionState, RecordingDateFormat, RecordingLocation, VmixState } from '../shared/types.js'
import { LedgerDatabase } from './database.js'
import { SettingsStore } from './settings.js'

const SUPPORTED_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm', '.wav', '.mp3', '.m4a', '.aiff', '.flac', '.opus', '.aac'])
const FILE_STABILITY_DELAY_MS = 2_000

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
    '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4',
    '.aiff': 'audio/aiff', '.flac': 'audio/flac', '.opus': 'audio/opus', '.aac': 'audio/aac'
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
    return { ok: false, message: `Descript rejected this token (${response.status}).` }
  }

  async reconcile(): Promise<void> {
    const token = await this.settings.getDescriptToken()
    if (!token) throw new Error('Connect Descript before reconciling recordings.')
    await this.pollProcessing(token)
    const pending = this.ledger.getPendingSessions()
    const remote = await this.listProjects(token)
    for (const session of pending.filter((item) => item.status === 'ready')) {
      const match = remote.find((project) => project.folder_path === session.descriptFolderPath && project.name === session.descriptProjectName)
      if (!match) continue
      session.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
      this.ledger.updateSession(session.id, { status: 'completed', descriptProjectId: match.id, errorMessage: null })
    }
    this.ledger.addActivity('info', `Reconciliation checked ${pending.length} queued session${pending.length === 1 ? '' : 's'}.`)
    for (const session of this.ledger.getPendingSessions().filter((item) => item.status === 'ready')) await this.upload(session)
  }

  async upload(session: CaptureSession): Promise<void> {
    if (this.activeUploads.has(session.id)) return
    const controller = new AbortController()
    let finish!: () => void
    const operation = { controller, done: new Promise<void>((resolve) => { finish = resolve }) }
    this.activeUploads.set(session.id, operation)
    try {
      const token = await this.settings.getDescriptToken()
      if (!token) throw new Error('Connect Descript before uploading sessions.')
      controller.signal.throwIfAborted()
      if (this.ledger.getSession(session.id)?.status === 'canceled') return
      const files = session.files.filter((file) => file.uploadStatus !== 'excluded')
      const primary = files.filter((file) => file.sourceRole === 'primary')
      if (!primary.length) throw new Error('This session has no primary recording.')
      if (files.some((file) => file.stabilityStatus !== 'stable')) throw new Error('Every included file must be stable before upload.')
      this.ledger.updateSession(session.id, { status: 'uploading', errorMessage: null })
      const body = {
        project_name: session.descriptProjectName,
        folder_name: session.descriptFolderPath,
        team_access: 'edit',
        add_media: Object.fromEntries(files.map((file) => [file.descriptMediaKey, { content_type: file.contentType, file_size: file.fileSize }])),
        add_compositions: [{ name: 'Recording', clips: primary.map((file) => ({ media: file.descriptMediaKey })) }]
      }
      const response = await fetch('https://descriptapi.com/v1/jobs/import/project_media', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
      })
      if (!response.ok) throw new Error(`Descript import request failed (${response.status}): ${await response.text()}`)
      const result = await response.json() as { job_id: string; project_id: string; upload_urls?: Record<string, { upload_url: string }> }
      controller.signal.throwIfAborted()
      this.ledger.updateSession(session.id, { descriptJobId: result.job_id, descriptProjectId: result.project_id })
      for (const file of files) {
        controller.signal.throwIfAborted()
        const source = await fs.stat(file.localPath)
        if (!source.isFile() || source.size !== file.fileSize) throw new Error(`${file.sourceLabel} — ${file.originalFilename} changed before upload.`)
        const uploadUrl = result.upload_urls?.[file.descriptMediaKey]?.upload_url
        if (!uploadUrl) throw new Error(`Descript did not return an upload target for ${file.sourceLabel} — ${file.originalFilename}.`)
        this.ledger.updateFile(file.id, { uploadStatus: 'uploading', errorMessage: null })
        const stream = Readable.toWeb(createReadStream(file.localPath)) as ReadableStream
        const upload = await fetch(uploadUrl, { method: 'PUT', body: stream, duplex: 'half', headers: { 'Content-Type': file.contentType, 'Content-Length': String(source.size) }, signal: controller.signal } as RequestInit & { duplex: 'half' })
        if (!upload.ok) throw new Error(`File transfer to Descript failed (${upload.status}).`)
        this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null })
      }
      controller.signal.throwIfAborted()
      this.ledger.updateSession(session.id, { status: 'processing' })
      this.ledger.addActivity('info', `Sent ${files.length} file${files.length === 1 ? '' : 's'} from ${session.descriptProjectName} to Descript for processing.`)
    } catch (error) {
      if (controller.signal.aborted || this.ledger.getSession(session.id)?.status === 'canceled') return
      const uploading = this.ledger.getSession(session.id)?.files.find((file) => file.uploadStatus === 'uploading')
      if (uploading) this.ledger.updateFile(uploading.id, { uploadStatus: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
      this.ledger.updateSession(session.id, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
      this.ledger.addActivity('error', `Upload failed for session ${session.descriptProjectName}.`)
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
    if (!response.ok && response.status !== 404) {
      throw new Error(`The upload was stopped locally, but Descript could not cancel the remote job (${response.status}).`)
    }
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

  private async listProjects(token: string): Promise<Array<{ id: string; name: string; folder_path: string }>> {
    const results: Array<{ id: string; name: string; folder_path: string }> = []
    let cursor: string | undefined
    do {
      const url = new URL('https://descriptapi.com/v1/projects')
      url.searchParams.set('limit', '100')
      if (cursor) url.searchParams.set('cursor', cursor)
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw new Error(`Unable to list Descript projects (${response.status}).`)
      const page = await response.json() as { data: Array<{ id: string; name: string; folder_path: string }>; pagination?: { next_cursor?: string } }
      results.push(...page.data); cursor = page.pagination?.next_cursor
    } while (cursor)
    return results
  }

  private async pollProcessing(token: string): Promise<void> {
    for (const session of this.ledger.getSessions().filter((item) => ['processing', 'needs_review'].includes(item.status) && item.descriptJobId)) {
      const controller = new AbortController()
      const controllers = this.activePolls.get(session.id) ?? new Set<AbortController>()
      controllers.add(controller)
      this.activePolls.set(session.id, controllers)
      try {
        const response = await fetch(`https://descriptapi.com/v1/jobs/${session.descriptJobId}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        if (!response.ok) continue
        const job = await response.json() as { job_state?: string; result?: { status?: string } }
        if (job.job_state !== 'stopped') continue
        const current = this.ledger.getSession(session.id)
        if (!current || !['processing', 'needs_review'].includes(current.status) || current.descriptJobId !== session.descriptJobId) continue
        if (job.result?.status === 'success') {
          current.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
          this.ledger.updateSession(session.id, { status: 'completed', errorMessage: null })
          this.ledger.addActivity('success', `${session.descriptProjectName} finished processing in Descript.`)
        } else {
          this.ledger.updateSession(session.id, { status: 'failed', errorMessage: 'Descript processing did not complete successfully.' })
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
  private readonly pendingVmixProbes = new Map<string, Promise<void>>()
  private active = false
  private obsStopEventsAvailable = false
  private vmixSessionId: string | null = null
  private activeVmixLocations: RecordingLocation[] | null = null
  private vmixBaseline = new Map<string, Set<string>>()
  private vmixFalseSince: number | null = null
  private vmixFinalizationTimer: NodeJS.Timeout | null = null
  private vmixFinalizationStartedAt: number | null = null
  private lastVmixActivity = 0
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
    if (settings.monitorObs) {
      if (!settings.recordingsDirectory) throw new Error('Connect OBS or choose its recordings folder before monitoring it.')
      await fs.access(settings.recordingsDirectory)
      directories.push(settings.recordingsDirectory)
      this.watchDirectory(settings.recordingsDirectory, (filename) => {
        if (filename && !this.obsStopEventsAvailable) void this.ingest(join(settings.recordingsDirectory!, filename.toString()))
      })
    }
    if (settings.monitorVmix) {
      const locations = settings.vmixRecordingLocations.filter((location) => location.enabled)
      if (!locations.length) throw new Error('Add at least one enabled vMix recording location.')
      for (const location of locations) {
        await fs.access(location.path)
        directories.push(location.path)
        this.watchDirectory(location.path, (filename) => {
          if (filename) void this.observeVmixFile(join(location.path, filename.toString()), location)
        })
      }
      await this.refreshVmixBaseline()
    }
    if (!directories.length) throw new Error('Enable OBS, vMix, or both before starting monitoring.')
    this.scanTimer = setInterval(() => void this.scan(), 10_000)
    this.active = true
    await this.recoverVmixSession()
    await this.scan()
    this.ledger.addActivity('success', `Monitoring ${directories.length} recording location${directories.length === 1 ? '' : 's'}.`)
    this.onChange()
  }
  stop(): void {
    this.watchers.splice(0).forEach((watcher) => watcher.close())
    if (this.scanTimer) clearInterval(this.scanTimer)
    if (this.vmixFinalizationTimer) clearTimeout(this.vmixFinalizationTimer)
    this.scanTimer = null; this.vmixFinalizationTimer = null; this.active = false; this.onChange()
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
    if (settings.monitorObs && dir && !this.obsStopEventsAvailable) await this.scanDirectory(dir)
    if (settings.monitorVmix) {
      if (this.vmixSessionId) {
        await this.scanVmixLocations()
        if (!settings.vmixUseApi && Date.now() - this.lastVmixActivity >= 60_000) await this.enterVmixFinalization('filesystem')
      } else if (!settings.vmixUseApi) {
        await this.scanForFilesystemVmixStart()
      }
    }
  }
  async scanReconciliationDirectory(): Promise<void> {
    const settings = this.settings.get()
    const dir = settings.reconciliationDirectory ?? settings.recordingsDirectory
    const today = new Date()
    if (dir) await this.scanDirectory(dir, (stats) => isSameRecordingDay(fileRecordingDate(stats), today, settings.recordingTimezone))
  }
  async recordingStopped(path: string): Promise<void> {
    if (this.active) await this.ingest(path)
  }
  async vmixStateChanged(recording: boolean, multiCorder: boolean): Promise<void> {
    if (!this.active || !this.settings.get().monitorVmix) return
    if (recording || multiCorder) {
      this.vmixFalseSince = null
      if (!this.vmixSessionId) await this.openVmixSession('vmix_api')
      else this.ledger.updateSession(this.vmixSessionId, { status: 'recording', errorMessage: null })
      return
    }
    if (!this.vmixSessionId) return
    if (this.vmixFalseSince === null) this.vmixFalseSince = Date.now()
    if (Date.now() - this.vmixFalseSince >= 5_000) await this.enterVmixFinalization('vmix_api')
  }
  async finalizeSessionManually(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session || session.recorderType !== 'vmix') throw new Error('vMix session not found.')
    if (!['needs_review', 'connection_lost', 'finalizing'].includes(session.status)) throw new Error('Only a session awaiting review can be finalized manually.')
    this.vmixSessionId = session.id
    this.activeVmixLocations = snapshotLocations(session) ?? this.settings.get().vmixRecordingLocations.filter((location) => location.enabled)
    this.vmixFinalizationStartedAt = null
    await this.buildRecoveryBaseline(session)
    await this.enterVmixFinalization('manual')
  }
  async recheckSession(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session) throw new Error('Session not found.')
    await Promise.all(session.files.filter((file) => file.uploadStatus !== 'excluded').map((file) => this.probeVmixFile(file.id)))
    this.onChange()
  }
  vmixConnectionLost(): void {
    if (!this.vmixSessionId) return
    this.vmixFalseSince = null
    this.ledger.updateSession(this.vmixSessionId, { status: 'connection_lost', errorMessage: 'The vMix API connection was lost. File monitoring is continuing.' })
    this.onChange()
  }
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
  private vmixLocations(): RecordingLocation[] {
    return this.activeVmixLocations ?? this.settings.get().vmixRecordingLocations.filter((location) => location.enabled)
  }
  private async recoverVmixSession(): Promise<void> {
    const recoverable = this.ledger.getRecoverableSessions().filter((session) => session.recorderType === 'vmix' && ['recording', 'connection_lost', 'finalizing'].includes(session.status))
    const session = recoverable.at(-1)
    for (const stale of recoverable.slice(0, -1)) this.ledger.updateSession(stale.id, { status: 'needs_review', errorMessage: 'Another unfinished vMix session was recovered. Review this session manually.' })
    if (!session) return
    this.activeVmixLocations = snapshotLocations(session) ?? this.settings.get().vmixRecordingLocations.filter((location) => location.enabled)
    try {
      for (const location of this.activeVmixLocations) await fs.readdir(location.path)
    } catch {
      this.ledger.updateSession(session.id, { status: 'needs_review', errorMessage: 'A persisted recording location is unavailable.' })
      this.activeVmixLocations = null
      return
    }
    this.vmixSessionId = session.id
    this.lastVmixActivity = Date.parse(session.updatedAt)
    await this.buildRecoveryBaseline(session)
    await this.scanVmixLocations()
    if (session.status === 'finalizing') {
      this.vmixFinalizationStartedAt = session.sessionEnd ? Date.parse(session.sessionEnd) : Date.now()
      this.ledger.getSession(session.id)?.files.forEach((file) => void this.probeVmixFile(file.id))
      this.resetVmixFinalizationGrace()
    }
    this.ledger.addActivity('info', `Recovered unfinished vMix session ${session.descriptProjectName}.`)
  }
  private async buildRecoveryBaseline(session: CaptureSession): Promise<void> {
    const assigned = new Set(session.files.map((file) => canonicalPath(file.localPath)))
    const started = Date.parse(session.sessionStart)
    const baseline = new Map<string, Set<string>>()
    for (const location of this.vmixLocations()) {
      const paths = new Set<string>()
      for (const name of await fs.readdir(location.path)) {
        const path = join(location.path, name)
        const canonical = canonicalPath(path)
        if (assigned.has(canonical)) continue
        try {
          const stats = await fs.stat(path)
          if (stats.mtimeMs < started) paths.add(canonical)
        } catch { /* Startup scans tolerate files disappearing. */ }
      }
      baseline.set(location.id, paths)
    }
    this.vmixBaseline = baseline
  }
  private async refreshVmixBaseline(): Promise<void> {
    const baseline = new Map<string, Set<string>>()
    for (const location of this.vmixLocations()) {
      const paths = new Set<string>()
      for (const name of await fs.readdir(location.path)) paths.add(canonicalPath(join(location.path, name)))
      baseline.set(location.id, paths)
    }
    this.vmixBaseline = baseline
  }
  private async scanForFilesystemVmixStart(): Promise<void> {
    for (const location of this.vmixLocations()) {
      const baseline = this.vmixBaseline.get(location.id) ?? new Set<string>()
      for (const name of await fs.readdir(location.path)) {
        const path = join(location.path, name)
        if (!baseline.has(canonicalPath(path)) && eligibleForLocation(path, location)) {
          await this.openVmixSession('filesystem')
          await this.observeVmixFile(path, location)
          return
        }
      }
    }
  }
  private async openVmixSession(source: 'vmix_api' | 'filesystem'): Promise<void> {
    if (this.vmixSessionId) return
    const settings = this.settings.get()
    const date = new Date()
    const folder = [settings.descriptDestinationRoot, recordingDate(date, settings.recordingTimezone, settings.recordingDateFormat)].filter(Boolean).join('/')
    const session = this.ledger.createSession({
      recorderType: 'vmix', status: 'recording', sessionStart: date.toISOString(), sessionEnd: null,
      finalizationSource: null, descriptFolderPath: folder, descriptProjectName: projectName(date, settings.recordingTimezone),
      descriptProjectId: null, descriptJobId: null,
      configurationSnapshot: JSON.stringify({
        recorderType: 'vmix', confirmation: source === 'vmix_api' ? 'vmix_confirmed' : 'filesystem_inferred',
        host: settings.vmixHost, port: settings.vmixPort, useApi: settings.vmixUseApi, locations: this.vmixLocations()
      })
    }, [])
    this.vmixSessionId = session.id
    this.activeVmixLocations = settings.vmixRecordingLocations.filter((location) => location.enabled)
    this.vmixFinalizationStartedAt = null
    this.lastVmixActivity = Date.now()
    this.ledger.addActivity('info', `${source === 'vmix_api' ? 'vMix confirmed' : 'Filesystem inferred'} session opened: ${session.descriptProjectName}.`)
    this.onChange()
    await this.scanVmixLocations()
  }
  private async scanVmixLocations(): Promise<void> {
    for (const location of this.vmixLocations()) {
      for (const name of await fs.readdir(location.path)) await this.observeVmixFile(join(location.path, name), location)
    }
  }
  private async observeVmixFile(path: string, location: RecordingLocation): Promise<void> {
    if (!eligibleForLocation(path, location)) return
    if (!this.vmixSessionId) {
      if (this.settings.get().vmixUseApi) return
      await this.openVmixSession('filesystem')
    }
    if ((this.vmixBaseline.get(location.id) ?? new Set<string>()).has(canonicalPath(path))) return
    const existing = this.ledger.getByPath(path)
    if (existing) {
      try {
        const stats = await fs.stat(path)
        if (stats.size !== existing.fileSize || stats.mtime.toISOString() !== existing.modifiedAt) {
          this.ledger.updateFile(existing.id, { fileSize: stats.size, modifiedAt: stats.mtime.toISOString(), stabilityStatus: 'pending' })
          this.lastVmixActivity = Date.now()
          if (this.vmixFinalizationStartedAt) this.resetVmixFinalizationGrace()
        }
      } catch {
        this.ledger.updateFile(existing.id, { stabilityStatus: 'missing', uploadStatus: 'missing', errorMessage: 'File disappeared before upload.' })
      }
      return
    }
    try {
      const stats = await fs.stat(path)
      if (!stats.isFile()) return
      const session = this.ledger.getSession(this.vmixSessionId!)
      if (!session) return
      const filename = basename(path)
      const mediaKey = uniqueMediaKey(session, location.label, filename)
      const segmentIndex = session.files.filter((file) => file.locationId === location.id).length
      const file = this.ledger.addSessionFile(session.id, {
        locationId: location.id, sourceLabel: location.label, sourceRole: location.role, localPath: path,
        originalFilename: filename, descriptMediaKey: mediaKey, contentType: contentType(path), fileSize: stats.size,
        modifiedAt: stats.mtime.toISOString(), segmentIndex, stabilityStatus: 'pending', uploadStatus: 'pending'
      })
      this.lastVmixActivity = Date.now()
      this.ledger.addActivity('info', `Discovered ${location.label} — ${filename}.`)
      if (this.vmixFinalizationStartedAt) {
        this.resetVmixFinalizationGrace()
        void this.probeVmixFile(file.id)
      }
      this.onChange()
    } catch { /* File may be mid-rename or temporarily unavailable. */ }
  }
  private async enterVmixFinalization(source: 'vmix_api' | 'filesystem' | 'manual'): Promise<void> {
    if (!this.vmixSessionId || this.vmixFinalizationStartedAt) return
    this.vmixFinalizationStartedAt = Date.now()
    this.ledger.updateSession(this.vmixSessionId, {
      status: 'finalizing', sessionEnd: new Date().toISOString(), finalizationSource: source, errorMessage: null
    })
    await this.scanVmixLocations()
    const session = this.ledger.getSession(this.vmixSessionId)
    session?.files.forEach((file) => void this.probeVmixFile(file.id))
    this.resetVmixFinalizationGrace()
    this.ledger.addActivity('info', `Finalizing ${session?.files.length ?? 0} vMix file${session?.files.length === 1 ? '' : 's'}.`)
    this.onChange()
  }
  private resetVmixFinalizationGrace(): void {
    if (this.vmixFinalizationTimer) clearTimeout(this.vmixFinalizationTimer)
    this.vmixFinalizationTimer = setTimeout(() => void this.tryCompleteVmixFinalization(), 15_000)
  }
  private async probeVmixFile(fileId: string): Promise<void> {
    if (this.pendingVmixProbes.has(fileId)) return this.pendingVmixProbes.get(fileId)
    const operation = (async () => {
      const file = this.ledger.getSessions().flatMap((session) => session.files).find((candidate) => candidate.id === fileId)
      if (!file) return
      try {
        let stats = await fs.stat(file.localPath)
        if (!stats.isFile() || stats.size === 0) return
        for (let probe = 1; probe < 3; probe += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, FILE_STABILITY_DELAY_MS))
          const next = await fs.stat(file.localPath)
          if (!next.isFile() || next.size === 0 || next.size !== stats.size || next.mtimeMs !== stats.mtimeMs) {
            this.ledger.updateFile(file.id, { fileSize: next.size, modifiedAt: next.mtime.toISOString(), stabilityStatus: 'pending' })
            return
          }
          stats = next
        }
        this.ledger.updateFile(file.id, { fileSize: stats.size, modifiedAt: stats.mtime.toISOString(), stabilityStatus: 'stable', errorMessage: null })
      } catch {
        this.ledger.updateFile(file.id, { stabilityStatus: 'missing', uploadStatus: 'missing', errorMessage: 'File disappeared before upload.' })
      } finally {
        this.onChange()
      }
    })().finally(() => this.pendingVmixProbes.delete(fileId))
    this.pendingVmixProbes.set(fileId, operation)
    return operation
  }
  private async tryCompleteVmixFinalization(): Promise<void> {
    if (!this.vmixSessionId || !this.vmixFinalizationStartedAt) return
    await this.scanVmixLocations()
    const session = this.ledger.getSession(this.vmixSessionId)
    if (!session) return
    const includedFiles = session.files.filter((file) => file.uploadStatus !== 'excluded')
    if (includedFiles.some((file) => file.stabilityStatus === 'missing')) {
      this.ledger.updateSession(session.id, { status: 'needs_review', errorMessage: 'One or more recording files are missing.' })
      return this.closeVmixSession()
    }
    const pending = includedFiles.filter((file) => file.stabilityStatus !== 'stable')
    if (pending.length) {
      pending.forEach((file) => void this.probeVmixFile(file.id))
      if (Date.now() - this.vmixFinalizationStartedAt >= 10 * 60_000) {
        this.ledger.updateSession(session.id, { status: 'needs_review', errorMessage: 'File finalization did not finish within ten minutes.' })
        return this.closeVmixSession()
      }
      return this.resetVmixFinalizationGrace()
    }
    if (!includedFiles.some((file) => file.sourceRole === 'primary')) {
      this.ledger.updateSession(session.id, { status: 'needs_review', errorMessage: 'No primary recording was discovered.' })
      return this.closeVmixSession()
    }
    this.ledger.updateSession(session.id, { status: 'ready', errorMessage: null })
    this.ledger.addActivity('success', `vMix session ready: ${session.files.length} file${session.files.length === 1 ? '' : 's'}.`)
    const ready = this.ledger.getSession(session.id)!
    await this.closeVmixSession()
    void this.onRecordingReady(ready).catch(() => this.onChange())
  }
  private async closeVmixSession(): Promise<void> {
    this.vmixSessionId = null; this.vmixFalseSince = null; this.vmixFinalizationStartedAt = null
    this.activeVmixLocations = null
    if (this.vmixFinalizationTimer) clearTimeout(this.vmixFinalizationTimer)
    this.vmixFinalizationTimer = null
    await this.refreshVmixBaseline()
    this.onChange()
  }
  async ingest(path: string): Promise<void> {
    if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()) || this.ledger.getByPath(path)) return
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

function snapshotLocations(session: CaptureSession): RecordingLocation[] | null {
  try {
    const snapshot = JSON.parse(session.configurationSnapshot) as { locations?: unknown }
    if (!Array.isArray(snapshot.locations)) return null
    return snapshot.locations.filter((location): location is RecordingLocation => {
      if (!location || typeof location !== 'object') return false
      const value = location as Partial<RecordingLocation>
      return typeof value.id === 'string' && typeof value.path === 'string' && typeof value.label === 'string' &&
        (value.role === 'primary' || value.role === 'iso') && value.enabled !== false
    })
  } catch { return null }
}

function canonicalPath(path: string): string {
  const value = resolve(path)
  return process.platform === 'win32' ? value.toLowerCase() : value
}
function eligibleForLocation(path: string, location: RecordingLocation): boolean {
  if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase())) return false
  const name = basename(path)
  if (/(\.part|\.partial|\.tmp|\.temp)$/i.test(name)) return false
  if (!location.filenameFilter) return true
  const escaped = location.filenameFilter.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, process.platform === 'win32' ? 'i' : '').test(name)
}
function uniqueMediaKey(session: CaptureSession, sourceLabel: string, filename: string): string {
  const extension = extname(filename)
  const stem = filename.slice(0, filename.length - extension.length)
  const base = `${sourceLabel} — ${stem}`
  let candidate = `${base}${extension}`
  let suffix = 2
  const used = new Set(session.files.map((file) => file.descriptMediaKey.toLowerCase()))
  while (used.has(candidate.toLowerCase())) candidate = `${base} (${suffix++})${extension}`
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
