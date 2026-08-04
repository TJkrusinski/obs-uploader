import { createReadStream, promises as fs } from 'node:fs'
import { createHash, randomUUID } from 'node:crypto'
import { basename, dirname, extname, join, resolve } from 'node:path'
import { Readable } from 'node:stream'
import { watch, type FSWatcher, type Stats } from 'node:fs'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { CaptureSession, ConnectionState, RecordingDateFormat, SessionFile, VmixState } from '../shared/types.js'
import { LedgerDatabase, type NewSessionFile } from './database.js'
import { buildDescriptImportBody } from './descript-import.js'
import { SettingsStore } from './settings.js'
import { filenameFromVmixPath, parseVmixTimeline, vmixProjectNameFromManifest, type VmixTimeline } from './vmix-manifest.js'
import { resolveVmixSourcePath, VmixMediaNotFoundError } from './vmix-file-resolution.js'
import { inspectVmixProjectContents, type VmixProjectContents } from './vmix-reconciliation.js'
import { validateFinalizedVideo, type ExpectedVideoMetadata } from './media-validation.js'

const SUPPORTED_VIDEO_EXTENSIONS = new Set(['.mp4', '.m4v', '.mov', '.mkv', '.webm'])
const FILE_STABILITY_DELAY_MS = 2_000
const VMIX_QUIET_WINDOW_MS = 30_000
const VMIX_MEDIA_READY_TIMEOUT_MS = 10 * 60_000

type RemoteProject = { id: string; name: string; folder_path: string }
type RemoteProjectDetails = RemoteProject & VmixProjectContents

async function descriptApiError(context: string, response: Response): Promise<Error> {
  const body = await response.text()
  const status = `${response.status}${response.statusText ? ` ${response.statusText}` : ''}`
  return new Error(`${context} (${status})${body ? `: ${body}` : ''}`)
}

function retryDelayMs(response: Response | null, attempt: number): number {
  const retryAfter = response?.headers.get('Retry-After')
  if (retryAfter) {
    const seconds = Number(retryAfter)
    if (Number.isFinite(seconds)) return Math.min(60_000, Math.max(0, seconds * 1000))
    const date = Date.parse(retryAfter)
    if (Number.isFinite(date)) return Math.min(60_000, Math.max(0, date - Date.now()))
  }
  return Math.min(10_000, 500 * 2 ** attempt) * (0.5 + Math.random() * 0.5)
}

function retryableResponse(response: Response): boolean {
  return response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
}

class SourceChangedError extends Error {}

async function fetchWithRetry(input: string | URL, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    let response: Response | null = null
    try {
      response = await fetch(input, init)
      if (!retryableResponse(response) || attempt === attempts - 1) return response
      await response.body?.cancel()
    } catch (error) {
      if (init.signal?.aborted || attempt === attempts - 1) throw error
      lastError = error
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs(response, attempt)))
  }
  throw lastError instanceof Error ? lastError : new Error('Request failed after retries.')
}

async function putWholeFile(url: string, file: SessionFile, signal: AbortSignal): Promise<Response> {
  let lastError: unknown
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const stats = await fs.stat(file.localPath)
      if (!stats.isFile() || stats.size !== file.fileSize || stats.mtime.toISOString() !== file.modifiedAt) {
        throw new SourceChangedError(`${file.sourceLabel} — ${file.originalFilename} changed before upload.`)
      }
      const stream = Readable.toWeb(createReadStream(file.localPath)) as ReadableStream
      const response = await fetch(url, {
        method: 'PUT',
        body: stream,
        duplex: 'half',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(stats.size) },
        signal
      } as RequestInit & { duplex: 'half' })
      if (!retryableResponse(response) || attempt === 2) return response
      await response.body?.cancel()
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs(response, attempt)))
    } catch (error) {
      if (error instanceof SourceChangedError) throw error
      if (signal.aborted || attempt === 2) throw error
      lastError = error
      await new Promise((resolvePromise) => setTimeout(resolvePromise, retryDelayMs(null, attempt)))
    }
  }
  throw lastError instanceof Error ? lastError : new Error('File upload failed after retries.')
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

function mergeExpectedVideoMetadata(
  left: ExpectedVideoMetadata | undefined,
  right: ExpectedVideoMetadata,
  mediaPath: string
): ExpectedVideoMetadata {
  if (!left) return right
  const merge = (label: string, first: number | null | undefined, second: number | null | undefined): number | null => {
    if (first && second && first !== second) throw new Error(`${basename(mediaPath)} has conflicting ${label} declarations in the vMix XML.`)
    return first ?? second ?? null
  }
  return {
    frameCount: merge('frame-count', left.frameCount, right.frameCount)
  }
}

export class DescriptService {
  private readonly activeUploads = new Map<string, { controller: AbortController; done: Promise<void> }>()
  private readonly activePolls = new Map<string, Set<AbortController>>()

  constructor(private readonly settings: SettingsStore, private readonly ledger: LedgerDatabase) {}

  async test(tokenOverride?: string): Promise<{ ok: boolean; message: string }> {
    const token = tokenOverride?.trim() || await this.settings.getDescriptToken()
    if (!token) return { ok: false, message: 'Add a Descript API token first.' }
    const response = await fetchWithRetry('https://descriptapi.com/v1/projects?limit=1', { headers: { Authorization: `Bearer ${token}` } })
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
      const candidates = pending.filter((item) => item.status === 'ready')
      for (const session of candidates) {
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
      const primary = files.filter((file) => file.sourceRole === 'primary')
      if (!primary.length) throw new Error('This session has no primary recording.')
      if (files.some((file) => file.stabilityStatus !== 'stable')) throw new Error('Every included file must be stable before upload.')
      if (current.recorderType === 'vmix') {
        if (!current.manifestPath || !current.manifestHash) throw new Error('The vMix session has no persisted manifest identity.')
        const manifestHash = createHash('sha256').update(await fs.readFile(current.manifestPath)).digest('hex')
        if (manifestHash !== current.manifestHash) {
          this.ledger.updateSession(session.id, { status: 'needs_review', errorMessage: 'The vMix manifest changed after timing was parsed. It must be reprocessed before upload.' })
          this.ledger.addActivity('warning', `${current.descriptProjectName}: the vMix manifest changed and will be reprocessed.`)
          return
        }
      }
      for (const file of files) {
        const stats = await fs.stat(file.localPath)
        if (!stats.isFile() || stats.size !== file.fileSize || stats.mtime.toISOString() !== file.modifiedAt) {
          throw new SourceChangedError(`${file.sourceLabel} — ${file.originalFilename} changed before the import job was created.`)
        }
      }
      const body = buildDescriptImportBody(current)
      const importPayloadHash = createHash('sha256').update(JSON.stringify(body)).digest('hex')
      const importAttemptId = randomUUID()
      this.ledger.updateSession(session.id, { status: 'uploading', errorMessage: null, importAttemptId, importPayloadHash })
      // Descript's endpoint-specific project_media schema and direct-upload guide are authoritative when
      // top-level getting-started text differs. Keep the live three-file integration check in the release runbook.
      const response = await fetch('https://descriptapi.com/v1/jobs/import/project_media', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal
      })
      if (!response.ok) throw await descriptApiError('Descript import request failed', response)
      const result = await response.json() as { job_id: string; project_id: string; project_url?: string; upload_urls?: Record<string, { upload_url: string }> }
      controller.signal.throwIfAborted()
      if (!result.job_id || !result.project_id) throw new Error('Descript created an invalid import response without a job or project ID.')
      this.ledger.updateSession(session.id, {
        descriptJobId: result.job_id,
        descriptProjectId: result.project_id,
        descriptProjectUrl: result.project_url ?? `https://web.descript.com/${result.project_id}`
      })
      const missingTargets = files.filter((file) => !result.upload_urls?.[file.descriptMediaKey]?.upload_url)
      if (missingTargets.length) {
        throw new Error(`Descript did not return upload targets for: ${missingTargets.map((file) => file.sourceLabel).join(', ')}.`)
      }
      const physicalKeys = new Set(files.map((file) => file.descriptMediaKey))
      const logicalUploadTargets = Object.keys(result.upload_urls ?? {}).filter((key) => !physicalKeys.has(key))
      if (logicalUploadTargets.length) throw new Error(`Descript unexpectedly returned upload targets for logical media: ${logicalUploadTargets.join(', ')}.`)
      for (let start = 0; start < files.length; start += 2) {
        const outcomes = await Promise.allSettled(files.slice(start, start + 2).map(async (file) => {
          controller.signal.throwIfAborted()
          const uploadUrl = result.upload_urls![file.descriptMediaKey].upload_url
          this.ledger.updateFile(file.id, { uploadStatus: 'uploading', errorMessage: null })
          const upload = await putWholeFile(uploadUrl, file, controller.signal)
          if (!upload.ok) throw await descriptApiError(`File transfer to Descript failed for ${file.sourceLabel} — ${file.originalFilename}`, upload)
          this.ledger.updateFile(file.id, { uploadStatus: 'transferred', errorMessage: null })
        }))
        const failed = outcomes.find((outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected')
        if (failed) throw failed.reason
      }
      controller.signal.throwIfAborted()
      this.ledger.updateSession(session.id, { status: 'processing' })
      this.ledger.addActivity('info', `Transferred ${files.length} file${files.length === 1 ? '' : 's'} from ${current.descriptProjectName}; Descript is processing them.`)
    } catch (error) {
      if (controller.signal.aborted || this.ledger.getSession(session.id)?.status === 'canceled') return
      const message = error instanceof Error ? error.message : String(error)
      const uploading = this.ledger.getSession(session.id)?.files.filter((file) => file.uploadStatus === 'uploading') ?? []
      for (const file of uploading) this.ledger.updateFile(file.id, { uploadStatus: 'failed', errorMessage: message })
      this.ledger.updateSession(session.id, { status: error instanceof SourceChangedError ? 'needs_review' : 'failed', errorMessage: message })
      this.ledger.addActivity('error', `Upload failed for session ${session.descriptProjectName}: ${message}`)
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
      const response = await fetchWithRetry(url, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) throw await descriptApiError('Unable to list Descript projects', response)
      const page = await response.json() as { data: RemoteProject[]; pagination?: { next_cursor?: string } }
      results.push(...page.data); cursor = page.pagination?.next_cursor
    } while (cursor)
    return results
  }

  private async reconcileVmixProject(token: string, session: CaptureSession, project: RemoteProject): Promise<void> {
    const response = await fetchWithRetry(`https://descriptapi.com/v1/projects/${project.id}`, { headers: { Authorization: `Bearer ${token}` } })
    if (!response.ok) throw await descriptApiError(`Unable to inspect Descript project ${project.name}`, response)
    const details = await response.json() as RemoteProjectDetails
    const inspection = inspectVmixProjectContents(session.files, details)
    if (inspection.complete) {
      session.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
      this.ledger.updateSession(session.id, { status: 'completed', descriptProjectId: project.id, descriptProjectUrl: `https://web.descript.com/${project.id}`, errorMessage: null })
      return
    }
    const retryName = this.ledger.retryProjectName(session)
    session.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'pending', errorMessage: null }))
    const detail = inspection.invalidFiles.length
      ? `Existing media has unexpected types: ${inspection.invalidFiles.map((file) => `${file.mediaKey} is ${file.actualType}`).join('; ')}.`
      : 'An incomplete project with the same name already exists.'
    this.ledger.updateSession(session.id, {
      status: 'ready', descriptProjectName: retryName, descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null,
      importAttemptId: null, importPayloadHash: null, errorMessage: null
    })
    this.ledger.addActivity('warning', `${detail} The complete vMix import will use a fresh project named ${retryName}.`)
  }

  private async pollProcessing(token: string): Promise<void> {
    for (const session of this.ledger.getSessions().filter((item) => ['processing', 'needs_review'].includes(item.status) && item.descriptJobId)) {
      const controller = new AbortController()
      const controllers = this.activePolls.get(session.id) ?? new Set<AbortController>()
      controllers.add(controller)
      this.activePolls.set(session.id, controllers)
      try {
        const response = await fetchWithRetry(`https://descriptapi.com/v1/jobs/${session.descriptJobId}`, { headers: { Authorization: `Bearer ${token}` }, signal: controller.signal })
        if (!response.ok) throw await descriptApiError(`Unable to check Descript job ${session.descriptJobId}`, response)
        const job = await response.json() as {
          job_state?: string
          project_url?: string
          result?: {
            status?: string
            media_status?: Record<string, { status?: string }>
            created_compositions?: Array<{ name?: string }>
            [key: string]: unknown
          }
        }
        if (!['stopped', 'cancelled', 'canceled'].includes(job.job_state ?? '')) continue
        const current = this.ledger.getSession(session.id)
        if (!current || !['processing', 'needs_review'].includes(current.status) || current.descriptJobId !== session.descriptJobId) continue
        const expectedMedia = current.files.filter((file) => file.uploadStatus !== 'excluded').map((file) => file.descriptMediaKey)
        const failedMedia = expectedMedia.filter((key) => job.result?.media_status?.[key]?.status !== 'success')
        const hasComposition = job.result?.created_compositions?.some((composition) => composition.name === 'Recording') ?? false
        if (job.result?.status === 'success' && failedMedia.length === 0 && hasComposition) {
          current.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'uploaded', errorMessage: null }))
          this.ledger.updateSession(session.id, {
            status: 'completed',
            descriptProjectUrl: job.project_url ?? current.descriptProjectUrl,
            errorMessage: null
          })
          this.ledger.addActivity('success', `${session.descriptProjectName} finished processing in Descript.`)
        } else {
          const validation = [
            failedMedia.length ? `media not successful: ${failedMedia.join(', ')}` : '',
            !hasComposition ? 'Recording composition was not created' : ''
          ].filter(Boolean).join('; ')
          const details = validation || (job.result ? JSON.stringify(job.result) : JSON.stringify(job))
          const message = `Descript processing did not complete successfully: ${details}`
          current.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => this.ledger.updateFile(file.id, { uploadStatus: 'failed', errorMessage: message }))
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
  private readonly vmixObservations = new Map<string, { signature: string; firstSeenAt: number }>()
  private vmixRecording = false
  private vmixMultiCorder = false
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
    const stopped = (this.vmixRecording || this.vmixMultiCorder) && !recording && !multiCorder
    this.vmixRecording = recording
    this.vmixMultiCorder = multiCorder
    if (stopped) await this.scanVmixManifests()
  }
  async finalizeSessionManually(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session || session.recorderType !== 'vmix') throw new Error('vMix session not found.')
    if (!['needs_review', 'connection_lost', 'finalizing'].includes(session.status)) throw new Error('Only a session awaiting review can be finalized manually.')
    if (session.syncMode !== 'manifest') throw new Error('This session has no exact manifest timing. Choose “Assume simultaneous start” instead.')
    const included = session.files.filter((file) => file.uploadStatus !== 'excluded')
    if (included.length > 14) throw new Error(`This session has ${included.length} physical clips, exceeding Descript's 14-track sequence limit.`)
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
  async assumeVmixStartsAtZero(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session || session.recorderType !== 'vmix') throw new Error('vMix session not found.')
    if (session.status !== 'needs_review') throw new Error('Only a vMix session awaiting review can use assumed synchronization.')
    const included = session.files.filter((file) => file.uploadStatus !== 'excluded')
    if (!included.length || included.some((file) => file.stabilityStatus !== 'stable' || file.manifestTrackIndex == null)) {
      throw new Error('Every included manifest track must resolve to one stable local file before assuming simultaneous start.')
    }
    const counts = new Map<number, number>()
    for (const file of included) counts.set(file.manifestTrackIndex!, (counts.get(file.manifestTrackIndex!) ?? 0) + 1)
    if ([...counts.values()].some((count) => count !== 1)) throw new Error('Assumed synchronization is available only when there is one physical file per manifest video track.')
    const knownStarts = included.map((file) => file.timelineStartFrame).filter((value): value is number => value != null)
    if (knownStarts.length && new Set(knownStarts).size > 1) throw new Error('The manifest contains evidence of delayed starts, so zero-offset fallback is unsafe.')
    if (!included.some((file) => file.sourceRole === 'primary')) throw new Error('Select a primary source before assuming simultaneous start.')
    this.ledger.updateSession(id, { status: 'ready', syncMode: 'assumed_zero', finalizationSource: 'manual', errorMessage: null })
    const ready = this.ledger.getSession(id)!
    this.ledger.addActivity('warning', `${ready.descriptProjectName} will upload with an operator-approved simultaneous-start assumption.`)
    this.onChange()
    void this.onRecordingReady(ready).catch(() => this.onChange())
  }
  async recheckSession(id: string): Promise<void> {
    const session = this.ledger.getSession(id)
    if (!session) throw new Error('Session not found.')
    if (session.recorderType === 'vmix' && session.manifestPath) {
      await this.ingestVmixManifest(session.manifestPath, true)
      this.onChange()
      return
    }
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
  private async ingestVmixManifest(path: string, force = false): Promise<void> {
    const canonical = canonicalPath(path)
    const existing = this.ledger.getVmixSessionByManifest(path, canonical)
    if (existing?.descriptJobId || (existing && !['ready', 'finalizing', 'needs_review'].includes(existing.status))) return
    const pending = this.pendingVmixManifests.get(canonical)
    if (pending) return pending
    const operation = this.ingestVmixManifestWhenReady(path, force).catch((error) => {
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
  private async ingestVmixManifestWhenReady(path: string, force = false): Promise<void> {
    const canonical = canonicalPath(path)
    const settings = this.settings.get()
    if (settings.vmixUseApi && (this.vmixRecording || this.vmixMultiCorder)) {
      throw new Error('vMix is still recording; waiting for Recorder and MultiCorder to stop.')
    }
    const manifestStats = await fs.stat(path)
    const xml = await fs.readFile(path, 'utf8')
    if (!/<\/xmeml>\s*$/i.test(xml)) throw new Error('The vMix MultiCorder XML manifest is incomplete or invalid.')
    const xmlHash = createHash('sha256').update(xml).digest('hex')
    const existing = this.ledger.getVmixSessionByManifest(path, canonical)
    if (!force && existing?.status === 'ready' && existing.manifestHash === xmlHash) return
    if (existing?.status === 'ready' && existing.manifestHash !== xmlHash) {
      this.ledger.updateSession(existing.id, { status: 'finalizing', syncMode: 'unknown', errorMessage: 'The vMix manifest changed; timing metadata is being rebuilt.' })
    }
    let timeline: VmixTimeline
    try {
      timeline = parseVmixTimeline(xml)
    } catch (error) {
      const signature = `${manifestStats.size}:${manifestStats.mtimeMs}:${xmlHash}`
      const observed = this.vmixObservations.get(canonical)
      if (!observed || observed.signature !== signature) {
        this.vmixObservations.set(canonical, { signature, firstSeenAt: Date.now() })
        throw new Error('XML changed; starting the 30-second quiet window before review.')
      }
      if (Date.now() - observed.firstSeenAt < VMIX_QUIET_WINDOW_MS) {
        throw new Error(`Waiting ${Math.ceil((VMIX_QUIET_WINDOW_MS - (Date.now() - observed.firstSeenAt)) / 1000)} more seconds for the XML to remain unchanged.`)
      }
      const message = error instanceof Error ? error.message : String(error)
      const review = this.upsertVmixManifestSession(path, canonical, xmlHash, manifestStats, null, [], 'needs_review', 'unknown', message)
      this.vmixObservations.delete(canonical)
      this.ledger.addActivity('warning', `${review.descriptProjectName} needs review: ${message}`)
      this.onChange()
      return
    }
    const directory = dirname(path)
    const allowedRoot = settings.reconciliationDirectory
    if (!allowedRoot) throw new Error('Choose a vMix reconciliation directory.')
    const allowedRoots = [...new Set([allowedRoot, ...settings.vmixRecordingRoots])]
    const resolved = await Promise.all(timeline.clips.map(async (clip) => {
      let mediaPath = clip.sourcePath
      try {
        mediaPath = await resolveVmixSourcePath(clip.sourcePath, directory, allowedRoots)
        if (!SUPPORTED_VIDEO_EXTENSIONS.has(extname(mediaPath).toLowerCase())) throw new Error(`Referenced media file is not a supported video: ${filenameFromVmixPath(clip.sourcePath)}`)
        const stats = await fs.stat(mediaPath)
        if (!stats.isFile()) throw new Error(`${basename(mediaPath)} is not a regular file.`)
        if (stats.size <= 0) {
          return { clip, mediaPath, stats, error: `${basename(mediaPath)} is still empty.`, retryable: true }
        }
        return { clip, mediaPath, stats, error: null as string | null, retryable: false }
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code
        const retryable = error instanceof VmixMediaNotFoundError
          || ['ENOENT', 'EBUSY', 'EACCES', 'EPERM', 'ETXTBSY'].includes(code ?? '')
        return { clip, mediaPath, stats: null, error: error instanceof Error ? error.message : String(error), retryable }
      }
    }))
    const signature = createHash('sha256')
      .update(`${manifestStats.size}:${manifestStats.mtimeMs}:${xmlHash}`)
      .update(resolved.map(({ mediaPath, stats, error }) => `${mediaPath}:${stats?.size ?? 0}:${stats?.mtimeMs ?? 0}:${error ?? ''}`).sort().join('|'))
      .digest('hex')
    const observed = this.vmixObservations.get(canonical)
    if (!observed || observed.signature !== signature) {
      this.vmixObservations.set(canonical, { signature, firstSeenAt: Date.now() })
      throw new Error('XML or referenced media changed; starting the 30-second quiet window.')
    }
    const quietFor = Date.now() - observed.firstSeenAt
    if (quietFor < VMIX_QUIET_WINDOW_MS) {
      throw new Error(`Waiting ${Math.ceil((VMIX_QUIET_WINDOW_MS - quietFor) / 1000)} more seconds for the recording session to remain unchanged.`)
    }
    const pendingMediaErrors = resolved.filter((item) => item.retryable).map((item) => item.error).filter((value): value is string => Boolean(value))
    if (pendingMediaErrors.length && quietFor < VMIX_MEDIA_READY_TIMEOUT_MS) {
      throw new Error(`Waiting for vMix to finish creating its media files: ${[...new Set(pendingMediaErrors)].join(' ')}`)
    }
    const resolutionErrors = resolved.map((item) => item.error).filter((value): value is string => Boolean(value))
    if (!resolutionErrors.length) {
      const uniquePaths = [...new Set(resolved.map((item) => item.mediaPath))]
      const expectedMetadataByPath = new Map<string, ExpectedVideoMetadata>()
      for (const item of resolved) {
        const expected: ExpectedVideoMetadata = {
          frameCount: item.clip.mediaDurationFrames
        }
        expectedMetadataByPath.set(
          item.mediaPath,
          mergeExpectedVideoMetadata(expectedMetadataByPath.get(item.mediaPath), expected, item.mediaPath)
        )
      }
      const stableByPath = new Map<string, Stats>()
      for (let start = 0; start < uniquePaths.length; start += 2) {
        const validations = await Promise.all(uniquePaths.slice(start, start + 2).map(async (mediaPath) => {
          const stable = await this.stableFile(mediaPath)
          return [mediaPath, await validateFinalizedVideo(mediaPath, expectedMetadataByPath.get(mediaPath)!, stable)] as const
        }))
        for (const [mediaPath, validation] of validations) stableByPath.set(mediaPath, validation.stats)
      }
      for (const item of resolved) item.stats = stableByPath.get(item.mediaPath) ?? null

      const finalManifestStats = await fs.stat(path)
      const finalXmlHash = createHash('sha256').update(await fs.readFile(path)).digest('hex')
      if (finalManifestStats.size !== manifestStats.size || finalManifestStats.mtimeMs !== manifestStats.mtimeMs || finalXmlHash !== xmlHash) {
        throw new Error('The vMix XML changed during media finalization validation; starting the quiet window again.')
      }
    }
    const firstClipByTrack = new Map<number, (typeof timeline.clips)[number]>()
    timeline.clips.forEach((clip) => { if (!firstClipByTrack.has(clip.trackIndex)) firstClipByTrack.set(clip.trackIndex, clip) })
    const detectedProgramTracks = [...firstClipByTrack.values()]
      .filter((clip) => /\b(?:Output\s*1|Program)\b/i.test(clip.displayName))
      .map((clip) => clip.trackIndex)
    const programTracks = detectedProgramTracks.length === 0 && firstClipByTrack.size === 1
      ? [[...firstClipByTrack.keys()][0]]
      : detectedProgramTracks
    const sourceLabels = new Map<number, string>()
    const usedSourceLabels = new Set<string>()
    for (const [trackIndex, clip] of firstClipByTrack) {
      const base = sourceLabelFromVmixFilename(clip.displayName)
      let candidate = base
      let suffix = 2
      while (usedSourceLabels.has(candidate.toLowerCase())) candidate = `${base} (${suffix++})`
      usedSourceLabels.add(candidate.toLowerCase())
      sourceLabels.set(trackIndex, candidate)
    }
    const usedKeys = new Set<string>()
    const files: NewSessionFile[] = resolved.map(({ clip, mediaPath, stats, error }) => {
      const filename = filenameFromVmixPath(clip.sourcePath)
      const sourceLabel = programTracks.length === 1 && clip.trackIndex === programTracks[0] ? 'Program' : sourceLabels.get(clip.trackIndex) ?? clip.displayName
      const mediaKey = uniqueMediaKeyFromSet(usedKeys, sourceLabel, filename)
      return {
        locationId: `vmix-track-${clip.trackIndex + 1}`, sourceLabel,
        sourceRole: programTracks.length === 1 && clip.trackIndex === programTracks[0] ? 'primary' as const : 'iso' as const,
        localPath: mediaPath, originalFilename: filename, descriptMediaKey: mediaKey, contentType: contentType(mediaPath),
        fileSize: stats?.size ?? 0, modifiedAt: stats?.mtime.toISOString() ?? manifestStats.mtime.toISOString(), segmentIndex: clip.clipIndex,
        manifestTrackIndex: clip.trackIndex, manifestClipIndex: clip.clipIndex, manifestClipId: clip.clipId,
        timelineStartFrame: clip.startFrame, timelineEndFrame: clip.endFrame,
        stabilityStatus: error ? 'missing' as const : 'stable' as const, uploadStatus: error ? 'missing' as const : 'pending' as const
      }
    })
    const errors = [
      ...new Set(resolutionErrors),
      ...(timeline.clips.length > 14 ? [`This session has ${timeline.clips.length} physical clips, exceeding Descript's 14-track sequence limit.`] : []),
      ...(timeline.clips.some((clip) => clip.startFrame < 0) ? ['The vMix manifest contains a negative clip start and cannot be synchronized automatically.'] : []),
      ...(programTracks.length !== 1 ? ['Program could not be identified unambiguously. Select the primary source before uploading.'] : [])
    ]
    const syncMode = resolutionErrors.length || timeline.clips.some((clip) => clip.startFrame < 0) ? 'unknown' as const : 'manifest' as const
    const status = errors.length ? 'needs_review' as const : 'ready' as const
    const session = this.upsertVmixManifestSession(path, canonical, xmlHash, manifestStats, timeline, files, status, syncMode, errors.join(' '))
    this.vmixManifestErrors.delete(canonical)
    this.vmixObservations.delete(canonical)
    this.ledger.addActivity(status === 'ready' ? 'success' : 'warning', status === 'ready'
      ? `MultiCorder manifest ready with ${files.length} physical clip${files.length === 1 ? '' : 's'} from ${basename(path)}.`
      : `${session.descriptProjectName} needs review: ${errors.join(' ')}`)
    if (status === 'ready') void this.onRecordingReady(session).catch(() => this.onChange())
    this.onChange()
  }
  private upsertVmixManifestSession(
    path: string,
    canonical: string,
    xmlHash: string,
    manifestStats: Stats,
    timeline: VmixTimeline | null,
    files: NewSessionFile[],
    status: 'ready' | 'needs_review',
    syncMode: 'manifest' | 'unknown',
    errorMessage: string
  ): CaptureSession {
    const settings = this.settings.get()
    const datedFrom = files.length
      ? new Date(Math.min(...files.map((file) => Date.parse(file.modifiedAt)).filter(Number.isFinite)))
      : manifestStats.mtime
    const folder = [settings.descriptDestinationRoot, recordingDate(datedFrom, settings.recordingTimezone, settings.recordingDateFormat)].filter(Boolean).join('/')
    const snapshot = JSON.stringify({
      recorderType: 'vmix', confirmation: 'multicorder_manifest', manifestPath: path, manifestKey: canonical,
      manifestSha256: xmlHash, host: settings.vmixHost, port: settings.vmixPort, useApi: settings.vmixUseApi,
      directory: dirname(path), physicalClipCount: timeline?.clips.length ?? 0,
      logicalSourceCount: timeline ? new Set(timeline.clips.map((clip) => clip.trackIndex)).size : 0
    })
    const existing = this.ledger.getVmixSessionByManifest(path, canonical)
    if (existing) {
      this.ledger.replaceSessionFiles(existing.id, files)
      this.ledger.updateSession(existing.id, {
        status, sessionStart: datedFrom.toISOString(), sessionEnd: manifestStats.mtime.toISOString(), finalizationSource: 'filesystem',
        descriptFolderPath: folder, timelineTimebase: timeline?.rate.timebase ?? null, timelineNtsc: timeline?.rate.ntsc ?? null,
        syncMode, manifestPath: path, manifestHash: xmlHash, importAttemptId: null, importPayloadHash: null,
        descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null, configurationSnapshot: snapshot,
        errorMessage: errorMessage || null
      })
      return this.ledger.getSession(existing.id)!
    }
    return this.ledger.createSession({
      recorderType: 'vmix', status, sessionStart: datedFrom.toISOString(), sessionEnd: manifestStats.mtime.toISOString(),
      finalizationSource: 'filesystem', descriptFolderPath: folder, descriptProjectName: vmixProjectNameFromManifest(path),
      descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null,
      timelineTimebase: timeline?.rate.timebase ?? null, timelineNtsc: timeline?.rate.ntsc ?? null,
      syncMode, manifestPath: path, manifestHash: xmlHash, importAttemptId: null, importPayloadHash: null,
      configurationSnapshot: snapshot
    }, files)
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
        descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null,
        timelineTimebase: null, timelineNtsc: null, syncMode: 'unknown', manifestPath: null, manifestHash: null,
        importAttemptId: null, importPayloadHash: null,
        configurationSnapshot: JSON.stringify({ recorderType: 'obs', recordingsDirectory: settings.recordingsDirectory })
      }, [{
        locationId: 'obs-primary', sourceLabel: 'Program', sourceRole: 'primary', localPath: path,
        originalFilename: filename, descriptMediaKey: filename, contentType: contentType(path), fileSize: stable.size,
        modifiedAt: stable.mtime.toISOString(), segmentIndex: 0,
        manifestTrackIndex: null, manifestClipIndex: null, manifestClipId: null, timelineStartFrame: null, timelineEndFrame: null,
        stabilityStatus: 'stable', uploadStatus: 'pending'
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
