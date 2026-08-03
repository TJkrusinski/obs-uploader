import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import keytar from 'keytar'
import type { AppSettings, RecorderType, RecordingDateFormat, SettingsInput } from '../shared/types.js'

const SERVICE_NAME = 'OBS Descript Uploader'
const DESCRIPT_ACCOUNT = 'descript-api-token'
const OBS_ACCOUNT = 'obs-websocket-password'

const defaults = (): AppSettings => ({
  uploadsEnabled: true,
  descriptDestinationRoot: '',
  recordingTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  recordingDateFormat: 'yy-MM-dd',
  recordingsDirectory: null,
  reconciliationDirectory: null,
  vmixRecordingRoots: [],
  obsHost: '127.0.0.1',
  obsPort: 4455,
  recorderType: 'obs',
  vmixHost: '127.0.0.1',
  vmixPort: 8088,
  vmixUseApi: true
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

function normalizeRecorderType(input: Partial<AppSettings> & { monitorVmix?: boolean }): RecorderType {
  if (input.recorderType === 'obs' || input.recorderType === 'vmix') return input.recorderType
  // OBS was enabled by default in legacy settings, so a legacy vMix selection
  // takes precedence when both old checkboxes were saved.
  return input.monitorVmix ? 'vmix' : 'obs'
}

export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = defaults()

  constructor(appDataPath: string) {
    this.filePath = join(appDataPath, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    try {
      const saved = JSON.parse(await readFile(this.filePath, 'utf8')) as Partial<AppSettings> & {
        recordingDateFormat?: string
        monitorObs?: boolean
        monitorVmix?: boolean
        vmixDirectory?: string | null
        vmixRecordingLocations?: Array<{ path?: string; enabled?: boolean }>
      }
      const {
        monitorObs: _monitorObs,
        monitorVmix: _monitorVmix,
        vmixDirectory: legacyVmixDirectory,
        vmixRecordingLocations: legacyLocations,
        ...current
      } = saved
      const recorderType = normalizeRecorderType(saved)
      this.settings = {
        ...defaults(),
        ...current,
        reconciliationDirectory: saved.reconciliationDirectory
          ?? (recorderType === 'vmix' ? legacyVmixDirectory ?? legacyLocations?.find((location) => location.enabled !== false)?.path : null)
          ?? null,
        vmixRecordingRoots: Array.isArray(saved.vmixRecordingRoots)
          ? saved.vmixRecordingRoots.filter((path): path is string => typeof path === 'string' && Boolean(path.trim()))
          : [],
        recorderType,
        recordingDateFormat: normalizeDateFormat(saved.recordingDateFormat ?? defaults().recordingDateFormat)
      }
    } catch {
      this.settings = defaults()
    }
    return this.settings
  }

  get(): AppSettings { return this.settings }

  async save(input: SettingsInput): Promise<AppSettings> {
    const next: AppSettings = {
      uploadsEnabled: Boolean(input.uploadsEnabled),
      descriptDestinationRoot: normalizeDestination(input.descriptDestinationRoot),
      recordingTimezone: input.recordingTimezone || defaults().recordingTimezone,
      recordingDateFormat: normalizeDateFormat(input.recordingDateFormat),
      recordingsDirectory: input.recordingsDirectory || null,
      reconciliationDirectory: input.reconciliationDirectory || null,
      vmixRecordingRoots: [...new Set(input.vmixRecordingRoots.map((path) => path.trim()).filter(Boolean))],
      obsHost: input.obsHost.trim() || '127.0.0.1',
      obsPort: Number(input.obsPort) || 4455,
      recorderType: normalizeRecorderType(input),
      vmixHost: input.vmixHost.trim() || '127.0.0.1',
      vmixPort: Number(input.vmixPort) || 8088,
      vmixUseApi: Boolean(input.vmixUseApi)
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
