import { createReadStream, promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { Readable } from 'node:stream'
import { watch, type FSWatcher } from 'node:fs'
import OBSWebSocket, { EventSubscription } from 'obs-websocket-js'
import type { ConnectionState, Recording, RecordingDateFormat } from '../shared/types.js'
import { LedgerDatabase } from './database.js'
import { SettingsStore } from './settings.js'

const SUPPORTED_EXTENSIONS = new Set(['.mkv', '.mp4', '.mov', '.avi', '.webm', '.mp3', '.wav', '.m4a'])

function recordingDate(date: Date, timeZone: string, format: RecordingDateFormat): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(date)
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? ''
  const year = value('year').slice(-2); const month = value('month'); const day = value('day')
  if (format === 'M.d.yy') return `${month}.${day}.${year}`
  if (format === 'MM.dd.yy') return `${month.padStart(2, '0')}.${day.padStart(2, '0')}.${year}`
  return `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}`
}
function projectName(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const value = (kind: string) => parts.find((part) => part.type === kind)?.value ?? '00'
  return `${value('year')}-${value('month')}-${value('day')}_${value('hour')}-${value('minute')}-${value('second')}`
}
function contentType(path: string): string {
  return ({ '.mkv': 'video/x-matroska', '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.avi': 'video/x-msvideo', '.webm': 'video/webm', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4' } as Record<string, string>)[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

export class DescriptService {
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
    const pending = this.ledger.getPending()
    const remote = await this.listProjects(token)
    for (const recording of pending.filter((item) => item.status === 'waiting')) {
      const match = remote.find((project) => project.folder_path === recording.descriptFolderPath && project.name === recording.descriptProjectName)
      if (match) this.ledger.update(recording.id, { status: 'completed', descriptProjectId: match.id, errorMessage: null })
    }
    this.ledger.addActivity('info', `Reconciliation checked ${pending.length} queued recording${pending.length === 1 ? '' : 's'}.`)
    for (const recording of this.ledger.getPending().filter((item) => item.status === 'waiting')) await this.upload(recording)
  }

  async upload(recording: Recording): Promise<void> {
    const token = await this.settings.getDescriptToken()
    if (!token) throw new Error('Connect Descript before uploading recordings.')
    this.ledger.update(recording.id, { status: 'uploading', errorMessage: null })
    try {
      const source = await fs.stat(recording.localPath)
      const body = {
        project_name: recording.descriptProjectName,
        folder_name: recording.descriptFolderPath,
        team_access: 'edit',
        add_media: { [recording.originalFilename]: { content_type: contentType(recording.localPath), file_size: source.size } },
        add_compositions: [{ name: 'Recording', clips: [{ media: recording.originalFilename }] }]
      }
      const response = await fetch('https://descriptapi.com/v1/jobs/import/project_media', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body)
      })
      if (!response.ok) throw new Error(`Descript import request failed (${response.status}): ${await response.text()}`)
      const result = await response.json() as { job_id: string; project_id: string; upload_urls?: Record<string, { upload_url: string }> }
      this.ledger.update(recording.id, { status: 'processing', descriptJobId: result.job_id, descriptProjectId: result.project_id })
      const uploadUrl = result.upload_urls?.[recording.originalFilename]?.upload_url
      if (uploadUrl) {
        const stream = Readable.toWeb(createReadStream(recording.localPath)) as ReadableStream
        const upload = await fetch(uploadUrl, { method: 'PUT', body: stream, duplex: 'half', headers: { 'Content-Type': contentType(recording.localPath), 'Content-Length': String(source.size) } } as RequestInit & { duplex: 'half' })
        if (!upload.ok) throw new Error(`File transfer to Descript failed (${upload.status}).`)
      }
      this.ledger.addActivity('info', `Sent ${recording.originalFilename} to Descript for processing.`)
    } catch (error) {
      this.ledger.update(recording.id, { status: 'failed', errorMessage: error instanceof Error ? error.message : String(error) })
      this.ledger.addActivity('error', `Upload failed for ${recording.originalFilename}.`)
      throw error
    }
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
    for (const recording of this.ledger.getPending().filter((item) => item.status === 'processing' && item.descriptJobId)) {
      const response = await fetch(`https://descriptapi.com/v1/jobs/${recording.descriptJobId}`, { headers: { Authorization: `Bearer ${token}` } })
      if (!response.ok) continue
      const job = await response.json() as { job_state?: string; result?: { status?: string } }
      if (job.job_state !== 'stopped') continue
      if (job.result?.status === 'success') {
        this.ledger.update(recording.id, { status: 'completed', errorMessage: null })
        this.ledger.addActivity('success', `${recording.originalFilename} finished processing in Descript.`)
      } else {
        this.ledger.update(recording.id, { status: 'failed', errorMessage: 'Descript processing did not complete successfully.' })
      }
    }
  }
}

export class RecordingWatcher {
  private watcher: FSWatcher | null = null
  private scanTimer: NodeJS.Timeout | null = null
  private active = false
  private obsStopEventsAvailable = false
  constructor(
    private readonly settings: SettingsStore,
    private readonly ledger: LedgerDatabase,
    private readonly onChange: () => void,
    private readonly onRecordingReady: (recording: Recording) => Promise<void>
  ) {}
  isWatching(): boolean { return this.active }
  async start(): Promise<void> {
    const dir = this.settings.get().recordingsDirectory
    if (!dir) throw new Error('Choose an OBS recordings folder before starting monitoring.')
    await fs.access(dir)
    this.stop()
    this.watcher = watch(dir, { persistent: false }, (_event, filename) => { if (filename && !this.obsStopEventsAvailable) void this.ingest(join(dir, filename.toString())) })
    this.scanTimer = setInterval(() => void this.scan(), 30_000)
    this.active = true
    await this.scan(); this.ledger.addActivity('success', `Monitoring ${dir}.`); this.onChange()
  }
  stop(): void { this.watcher?.close(); this.watcher = null; if (this.scanTimer) clearInterval(this.scanTimer); this.scanTimer = null; this.active = false; this.onChange() }
  setObsStopEventsAvailable(available: boolean): void { this.obsStopEventsAvailable = available }
  async scan(): Promise<void> { const dir = this.settings.get().recordingsDirectory; if (dir && !this.obsStopEventsAvailable) await this.scanDirectory(dir) }
  async scanReconciliationDirectory(): Promise<void> {
    const settings = this.settings.get()
    const dir = settings.reconciliationDirectory ?? settings.recordingsDirectory
    if (dir) await this.scanDirectory(dir)
  }
  async recordingStopped(path: string): Promise<void> {
    if (this.active) await this.ingest(path, false)
  }
  private async scanDirectory(dir: string): Promise<void> { for (const name of await fs.readdir(dir)) await this.ingest(join(dir, name)) }
  async ingest(path: string, waitForStable = true): Promise<void> {
    if (!SUPPORTED_EXTENSIONS.has(extname(path).toLowerCase()) || this.ledger.getByPath(path)) return
    try {
      const initial = await fs.stat(path); if (!initial.isFile()) return
      if (waitForStable) await new Promise((resolve) => setTimeout(resolve, 1500))
      const stable = waitForStable ? await fs.stat(path) : initial
      if (waitForStable && stable.size !== initial.size) return
      const settings = this.settings.get(); const date = stable.birthtimeMs ? stable.birthtime : stable.mtime
      const folder = [settings.descriptDestinationRoot, recordingDate(date, settings.recordingTimezone, settings.recordingDateFormat)].filter(Boolean).join('/')
      const recording = this.ledger.create({ localPath: path, originalFilename: basename(path), recordedAt: date.toISOString(), fileSize: stable.size, descriptFolderPath: folder, descriptProjectName: projectName(date, settings.recordingTimezone), descriptProjectId: null, descriptJobId: null })
      this.ledger.addActivity('info', `Discovered ${basename(path)}.`); this.onChange()
      void this.onRecordingReady(recording).catch(() => this.onChange())
    } catch { /* File may have been removed or is still being written. */ }
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
