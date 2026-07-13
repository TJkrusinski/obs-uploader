import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import keytar from 'keytar'
import type { AppSettings, RecordingDateFormat, SettingsInput } from '../shared/types.js'

const SERVICE_NAME = 'OBS Descript Uploader'
const DESCRIPT_ACCOUNT = 'descript-api-token'
const OBS_ACCOUNT = 'obs-websocket-password'

const defaults = (): AppSettings => ({
  descriptDestinationRoot: '',
  recordingTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  recordingDateFormat: 'yy-MM-dd',
  recordingsDirectory: null,
  reconciliationDirectory: null,
  obsHost: '127.0.0.1',
  obsPort: 4455
})

export function normalizeDestination(input: string): string {
  const value = input.trim().replace(/[\\/]+/g, '/') .replace(/^\/+|\/+$/g, '')
  if (/[\x00-\x1F\x7F]/.test(value)) throw new Error('The destination root cannot contain control characters.')
  return value
}

function normalizeDateFormat(input: string): RecordingDateFormat {
  if (input === 'yy-MM-dd' || input === 'M.d.yy' || input === 'MM.dd.yy') return input
  if (input === 'yyyy-MM-dd') return 'yy-MM-dd'
  if (input === 'M.d.yyyy') return 'M.d.yy'
  if (input === 'MM.dd.yyyy') return 'MM.dd.yy'
  throw new Error('Choose a supported date-folder format.')
}

export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = defaults()

  constructor(appDataPath: string) {
    this.filePath = join(appDataPath, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppSettings> & { recordingDateFormat?: string }
      this.settings = { ...defaults(), ...saved, recordingDateFormat: normalizeDateFormat(saved.recordingDateFormat ?? defaults().recordingDateFormat) }
    } catch {
      this.settings = defaults()
    }
    return this.settings
  }

  get(): AppSettings { return this.settings }

  async save(input: SettingsInput): Promise<AppSettings> {
    const next: AppSettings = {
      descriptDestinationRoot: normalizeDestination(input.descriptDestinationRoot),
      recordingTimezone: input.recordingTimezone || defaults().recordingTimezone,
      recordingDateFormat: normalizeDateFormat(input.recordingDateFormat),
      recordingsDirectory: this.settings.recordingsDirectory ?? input.recordingsDirectory ?? null,
      reconciliationDirectory: input.reconciliationDirectory || null,
      obsHost: input.obsHost.trim() || '127.0.0.1',
      obsPort: Number(input.obsPort) || 4455
    }
    this.settings = next
    await writeFile(this.filePath, JSON.stringify(next, null, 2), 'utf8')
    if (input.descriptToken?.trim()) await this.setDescriptToken(input.descriptToken)
    if (input.obsPassword !== undefined && input.obsPassword !== '') await keytar.setPassword(SERVICE_NAME, OBS_ACCOUNT, input.obsPassword)
    return next
  }

  async setRecordingsDirectory(recordingsDirectory: string): Promise<AppSettings> {
    this.settings = { ...this.settings, recordingsDirectory }
    await writeFile(this.filePath, JSON.stringify(this.settings, null, 2), 'utf8')
    return this.settings
  }

  getDescriptToken(): Promise<string | null> { return keytar.getPassword(SERVICE_NAME, DESCRIPT_ACCOUNT) }
  setDescriptToken(token: string): Promise<void> { return keytar.setPassword(SERVICE_NAME, DESCRIPT_ACCOUNT, token.trim()) }
  async hasDescriptToken(): Promise<boolean> { return Boolean(await this.getDescriptToken()) }
  getObsPassword(): Promise<string | null> { return keytar.getPassword(SERVICE_NAME, OBS_ACCOUNT) }
}
