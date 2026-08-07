import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { ActivityEntry, RecordStatus, RecordingFile, RecordingRecord, RecordsDocument } from '../shared/types.js'
import { SerializedJsonStore, UnsupportedSchemaError, atomicWriteJson, readRecoverableJson } from './atomic-json.js'

function isObject(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === 'object' && !Array.isArray(value) }
const STATUSES = new Set<RecordStatus>(['recording', 'connection_lost', 'finalizing', 'validating', 'reconciling', 'uploading', 'processing', 'completed', 'needs_review', 'failed', 'skipped'])

export function validateRecords(value: unknown, path = 'records.json'): RecordsDocument {
  if (!isObject(value)) throw new Error('Recording ledger must be an object.')
  if (value.schemaVersion !== 1) throw new UnsupportedSchemaError(path, value.schemaVersion)
  if (!Array.isArray(value.records) || !Array.isArray(value.activity)) throw new Error('Recording ledger must contain records and activity arrays.')
  for (const [index, record] of value.records.entries()) {
    if (!isObject(record) || typeof record.id !== 'string' || typeof record.createdAt !== 'string' || typeof record.updatedAt !== 'string' ||
      typeof record.recorderIdentity !== 'string' || !STATUSES.has(record.status as RecordStatus) || !Array.isArray(record.files) || !Array.isArray(record.sources) ||
      !Array.isArray(record.destinations) || !isObject(record.directoryBaselines) || !isObject(record.configSnapshot) || typeof record.descriptFolder !== 'string' ||
      typeof record.descriptProjectName !== 'string' || typeof record.retryCount !== 'number') {
      throw new Error(`Record ${index} is invalid.`)
    }
    if (Object.hasOwn(record.configSnapshot, 'apiKey') || Object.hasOwn(record.configSnapshot, 'password')) throw new Error(`Record ${index} contains a secret in its configuration snapshot.`)
    for (const [fileIndex, file] of record.files.entries()) {
      if (!isObject(file) || typeof file.id !== 'string' || typeof file.localPath !== 'string' || typeof file.mediaKey !== 'string' ||
        (file.role !== 'primary' && file.role !== 'iso') || !isObject(file.fingerprint) || typeof file.fingerprint.sha256 !== 'string' ||
        typeof file.fingerprint.size !== 'number' || typeof file.timelineOffsetSeconds !== 'number') throw new Error(`Record ${index} file ${fileIndex} is invalid.`)
    }
  }
  for (const [index, item] of value.activity.entries()) {
    if (!isObject(item) || typeof item.id !== 'string' || typeof item.at !== 'string' || typeof item.message !== 'string' ||
      !['info', 'success', 'warning', 'error'].includes(String(item.level))) throw new Error(`Activity ${index} is invalid.`)
  }
  return structuredClone(value) as unknown as RecordsDocument
}

const emptyDocument = (): RecordsDocument => ({ schemaVersion: 1, records: [], activity: [] })

export type NewRecord = Omit<RecordingRecord, 'id' | 'createdAt' | 'updatedAt' | 'retryCount' | 'error' | 'reasonCode' | 'files' | 'importPayloadHash' | 'importAttemptId' | 'descriptProjectId' | 'descriptJobId' | 'descriptProjectUrl'> & {
  files?: RecordingFile[]
}

export class RecordLedger {
  private constructor(private readonly store: SerializedJsonStore<RecordsDocument>) {}
  static async open(dataDir: string): Promise<{ ledger: RecordLedger; recovered: boolean }> {
    const path = resolve(dataDir, 'records.json')
    let value: RecordsDocument
    let recovered = false
    try {
      const activeExists = await access(path).then(() => true, () => false)
      const backupExists = await access(`${path}.bak`).then(() => true, () => false)
      if (!activeExists && !backupExists) throw Object.assign(new Error('Recording ledger does not exist.'), { code: 'ENOENT' })
      const loaded = await readRecoverableJson(path, validateRecords)
      value = loaded.value; recovered = loaded.recovered
      if (recovered) await atomicWriteJson(path, value, validateRecords, false)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      value = emptyDocument()
      await atomicWriteJson(path, value, validateRecords)
    }
    return { ledger: new RecordLedger(new SerializedJsonStore(path, validateRecords, value)), recovered }
  }
  get path(): string { return this.store.path }
  document(): RecordsDocument { return this.store.get() }
  records(): RecordingRecord[] { return this.document().records.sort((left, right) => right.createdAt.localeCompare(left.createdAt)) }
  activity(): ActivityEntry[] { return this.document().activity.sort((left, right) => right.at.localeCompare(left.at)) }
  find(id: string): RecordingRecord | undefined { return this.document().records.find((record) => record.id === id) }
  findByFilePath(path: string): RecordingRecord | undefined { return this.document().records.find((record) => record.files.some((file) => file.localPath === path)) }
  active(): RecordingRecord | undefined { return this.document().records.find((record) => ['recording', 'connection_lost', 'finalizing', 'validating'].includes(record.status)) }
  async create(input: NewRecord): Promise<RecordingRecord> {
    const now = new Date().toISOString()
    const created: RecordingRecord = {
      ...input, id: randomUUID(), createdAt: now, updatedAt: now, retryCount: 0, reasonCode: null, error: null,
      files: input.files ?? [], importPayloadHash: null, importAttemptId: null, descriptProjectId: null, descriptJobId: null, descriptProjectUrl: null
    }
    await this.store.update((document) => { document.records.push(created) })
    return structuredClone(created)
  }
  async update(id: string, changes: Partial<RecordingRecord>): Promise<RecordingRecord> {
    let updated!: RecordingRecord
    await this.store.update((document) => {
      const index = document.records.findIndex((record) => record.id === id)
      if (index < 0) throw new Error('Recording record not found.')
      updated = { ...document.records[index], ...structuredClone(changes), id, updatedAt: new Date().toISOString() }
      document.records[index] = updated
    })
    return structuredClone(updated)
  }
  async transition(id: string, status: RecordStatus, error: string | null = null, reasonCode: string | null = null): Promise<RecordingRecord> {
    const before = this.find(id)
    const updated = await this.update(id, { status, error, reasonCode })
    if (before?.status !== status) await this.addActivity(error ? 'warning' : 'info', `${before?.status ?? 'new'} → ${status}${error ? `: ${error}` : ''}`, id)
    return updated
  }
  async updateFile(recordId: string, fileId: string, changes: Partial<RecordingFile>): Promise<void> {
    await this.store.update((document) => {
      const record = document.records.find((item) => item.id === recordId)
      const file = record?.files.find((item) => item.id === fileId)
      if (!record || !file) throw new Error('Recording file not found.')
      Object.assign(file, structuredClone(changes)); record.updatedAt = new Date().toISOString()
    })
  }
  async addActivity(level: ActivityEntry['level'], message: string, recordId: string | null = null): Promise<void> {
    const sanitized = message.replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, '$1[REDACTED]').replace(/([?&](?:password|token|key)=)[^&\s]+/gi, '$1[REDACTED]')
    await this.store.update((document) => {
      document.activity.push({ id: randomUUID(), at: new Date().toISOString(), level, recordId, message: sanitized })
      if (document.activity.length > 250) document.activity.splice(0, document.activity.length - 250)
    })
  }
  async flush(): Promise<void> { await this.store.flush() }
}
