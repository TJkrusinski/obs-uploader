import { createHash, randomUUID } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { Readable } from 'node:stream'
import type { AppConfig, RecordingFile, RecordingRecord } from '../shared/types.js'
import { buildDescriptImportBody } from './descript-import.js'
import { RecordLedger } from './ledger.js'

type RemoteProject = { id: string; name: string; folder_path: string; project_url?: string }
const API = 'https://descriptapi.com/v1'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const retryable = (response: Response) => [408, 425, 429].includes(response.status) || response.status >= 500

async function apiError(label: string, response: Response): Promise<Error> {
  const body = (await response.text()).slice(0, 500)
  return new Error(`${label} (${response.status})${body ? `: ${body}` : ''}`)
}

async function fetchRetry(input: string | URL, init: RequestInit = {}, attempts = 4): Promise<Response> {
  let last: unknown
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(input, init)
      if (!retryable(response) || attempt === attempts - 1) return response
      await response.body?.cancel()
    } catch (error) { if (init.signal?.aborted || attempt === attempts - 1) throw error; last = error }
    await sleep(Math.min(8_000, 500 * 2 ** attempt))
  }
  throw last instanceof Error ? last : new Error('Request failed after retries.')
}

async function putFile(url: string, file: RecordingFile): Promise<Response> {
  let response: Response | null = null
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metadata = await stat(file.localPath)
    if (!metadata.isFile() || metadata.size !== file.fingerprint.size || metadata.mtimeMs !== file.fingerprint.mtimeMs) throw new Error(`${file.originalFilename} changed before upload.`)
    const stream = Readable.toWeb(createReadStream(file.localPath)) as ReadableStream
    response = await fetch(url, { method: 'PUT', body: stream, duplex: 'half', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(metadata.size) } } as RequestInit & { duplex: 'half' })
    if (!retryable(response) || attempt === 2) return response
    await response.body?.cancel(); await sleep(500 * 2 ** attempt)
  }
  return response!
}

export class DescriptClient {
  constructor(private readonly getConfig: () => AppConfig, private readonly ledger: RecordLedger) {}
  private token(): string { const value = this.getConfig().descript.apiKey?.trim(); if (!value) throw new Error('The Descript API key is missing from config.json.'); return value }
  private headers(): Record<string, string> { return { Authorization: `Bearer ${this.token()}` } }
  async test(): Promise<{ ok: boolean; message: string }> {
    try {
      const response = await fetchRetry(`${API}/projects?limit=1`, { headers: this.headers(), signal: AbortSignal.timeout(10_000) })
      return response.ok ? { ok: true, message: 'Descript credentials verified.' } : { ok: false, message: `Descript rejected the configured key (${response.status}).` }
    } catch (error) { return { ok: false, message: error instanceof Error ? error.message : String(error) } }
  }
  async listProjects(): Promise<RemoteProject[]> {
    const projects: RemoteProject[] = []; let cursor: string | undefined
    do {
      const url = new URL(`${API}/projects`); url.searchParams.set('limit', '100'); if (cursor) url.searchParams.set('cursor', cursor)
      const response = await fetchRetry(url, { headers: this.headers() }); if (!response.ok) throw await apiError('Unable to list Descript projects', response)
      const page = await response.json() as { data?: RemoteProject[]; pagination?: { next_cursor?: string } }
      projects.push(...(page.data ?? [])); cursor = page.pagination?.next_cursor
    } while (cursor)
    return projects
  }
  async reconcile(recordId: string): Promise<'remote' | 'missing' | 'pending'> {
    let record = this.ledger.find(recordId); if (!record) throw new Error('Recording not found.')
    await this.ledger.transition(record.id, 'reconciling')
    if (record.descriptJobId) {
      const outcome = await this.pollJob(record)
      if (outcome !== 'missing') return outcome
    }
    record = this.ledger.find(recordId)!
    if (record.descriptProjectId) {
      const response = await fetchRetry(`${API}/projects/${encodeURIComponent(record.descriptProjectId)}`, { headers: this.headers() })
      if (response.ok) { await this.ledger.transition(record.id, 'completed'); return 'remote' }
      if (response.status !== 404) throw await apiError('Unable to verify Descript project', response)
    }
    const project = (await this.listProjects()).find((candidate) => candidate.folder_path === record!.descriptFolder && candidate.name === record!.descriptProjectName)
    if (project) {
      await this.ledger.update(record.id, { descriptProjectId: project.id, descriptProjectUrl: project.project_url ?? null })
      await this.ledger.transition(record.id, 'completed'); return 'remote'
    }
    return 'missing'
  }
  async upload(recordId: string): Promise<void> {
    let record = this.ledger.find(recordId); if (!record) throw new Error('Recording not found.')
    const previousAttempt = { id: record.importAttemptId, hash: record.importPayloadHash, reason: record.reasonCode }
    const remote = await this.reconcile(recordId)
    if (remote !== 'missing') return
    record = this.ledger.find(recordId)!
    const body = buildDescriptImportBody(record)
    const payload = JSON.stringify(body); const payloadHash = createHash('sha256').update(payload).digest('hex')
    const attemptId = previousAttempt.reason === 'ambiguous_import' && previousAttempt.hash === payloadHash && previousAttempt.id
      ? previousAttempt.id
      : randomUUID()
    await this.ledger.update(recordId, { status: 'uploading', importPayloadHash: payloadHash, importAttemptId: attemptId, error: null })
    let response: Response
    try {
      response = await fetch(`${API}/jobs/import/project_media`, { method: 'POST', headers: { ...this.headers(), 'Content-Type': 'application/json', 'Idempotency-Key': attemptId }, body: payload })
    } catch (error) {
      await this.ledger.transition(recordId, 'needs_review', 'The Descript import response was ambiguous. Reconcile before retrying.', 'ambiguous_import')
      throw error
    }
    if (!response.ok) { const error = await apiError('Descript import request failed', response); await this.ledger.transition(recordId, 'failed', error.message, 'import_rejected'); throw error }
    const result = await response.json() as { job_id?: string; project_id?: string; project_url?: string; upload_urls?: Record<string, { upload_url?: string }> }
    if (!result.job_id || !result.project_id) { await this.ledger.transition(recordId, 'needs_review', 'Descript returned no durable job or project ID.', 'ambiguous_import'); throw new Error('Descript returned an incomplete import response.') }
    await this.ledger.update(recordId, { descriptJobId: result.job_id, descriptProjectId: result.project_id, descriptProjectUrl: result.project_url ?? null })
    record = this.ledger.find(recordId)!
    const missing = record.files.filter((file) => !result.upload_urls?.[file.mediaKey]?.upload_url)
    if (missing.length) { await this.ledger.transition(recordId, 'failed', `Descript omitted upload targets for ${missing.map((file) => file.sourceLabel).join(', ')}.`, 'missing_upload_target'); return }
    try {
      for (let offset = 0; offset < record.files.length; offset += 2) {
        await Promise.all(record.files.slice(offset, offset + 2).map(async (file) => {
          await this.ledger.updateFile(recordId, file.id, { uploadStatus: 'uploading', error: null })
          const upload = await putFile(result.upload_urls![file.mediaKey].upload_url!, file)
          if (!upload.ok) throw await apiError(`Upload failed for ${file.originalFilename}`, upload)
          await this.ledger.updateFile(recordId, file.id, { uploadStatus: 'transferred', error: null })
        }))
      }
      await this.ledger.transition(recordId, 'processing')
    } catch (error) {
      await this.ledger.transition(recordId, 'needs_review', error instanceof Error ? error.message : String(error), 'upload_interrupted')
      throw error
    }
  }
  async pollJob(record: RecordingRecord): Promise<'remote' | 'missing' | 'pending'> {
    if (!record.descriptJobId) return 'missing'
    const response = await fetchRetry(`${API}/jobs/${encodeURIComponent(record.descriptJobId)}`, { headers: this.headers() })
    if (response.status === 404) return 'missing'
    if (!response.ok) throw await apiError('Unable to check Descript job', response)
    const job = await response.json() as { job_state?: string; project_url?: string; result?: { status?: string; media_status?: Record<string, { status?: string }>; created_compositions?: Array<{ name?: string }> } }
    if (!['stopped', 'cancelled', 'canceled'].includes(job.job_state ?? '')) { await this.ledger.transition(record.id, 'processing'); return 'pending' }
    const files = record.files; const failed = files.filter((file) => job.result?.media_status?.[file.mediaKey]?.status !== 'success')
    const hasRecording = job.result?.created_compositions?.some((composition) => composition.name === 'Recording') ?? false
    if (job.result?.status === 'success' && !failed.length && hasRecording) {
      for (const file of files) await this.ledger.updateFile(record.id, file.id, { uploadStatus: 'uploaded', error: null })
      await this.ledger.update(record.id, { descriptProjectUrl: job.project_url ?? record.descriptProjectUrl }); await this.ledger.transition(record.id, 'completed'); return 'remote'
    }
    await this.ledger.transition(record.id, 'failed', 'Descript processing failed or did not create the Recording composition.', 'processing_failed'); return 'remote'
  }
}
