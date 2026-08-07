import { homedir } from 'node:os'
import { access } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import type { AppConfig, EditableConfig, RedactedConfig, RecordingDateFormat } from '../shared/types.js'
import { SerializedJsonStore, UnsupportedSchemaError, atomicWriteJson, ensurePrivateDirectory, permissionWarning, readRecoverableJson } from './atomic-json.js'

const DATE_FORMATS = new Set<RecordingDateFormat>(['yy-MM-dd', 'M.d.yy', 'MM.dd.yy'])

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object.`)
  return value as Record<string, unknown>
}
function string(value: unknown, label: string, nullable = false): string | null {
  if (nullable && value === null) return null
  if (typeof value !== 'string') throw new Error(`${label} must be a string${nullable ? ' or null' : ''}.`)
  return value
}
function stringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) throw new Error(`${label} must be an array of strings.`)
  return [...new Set(value)]
}

export function defaultConfig(): AppConfig {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  return {
    schemaVersion: 1,
    desiredMode: 'standby',
    server: { host: '127.0.0.1', port: 8503, openBrowser: false },
    softron: { baseUrl: 'http://127.0.0.1:8080', password: null, primarySourceId: null, enabledSourceIds: [], destinationMappings: {} },
    descript: { apiKey: null, destinationRoot: 'Recordings', recordingTimezone: timezone, recordingDateFormat: 'yy-MM-dd' },
    tools: { ffprobePath: 'ffprobe' }
  }
}

export function validateConfig(value: unknown, path = 'config.json'): AppConfig {
  const root = object(value, 'Configuration')
  if (root.schemaVersion !== 1) throw new UnsupportedSchemaError(path, root.schemaVersion)
  if (root.desiredMode !== 'standby' && root.desiredMode !== 'watching') throw new Error('desiredMode must be standby or watching.')
  const server = object(root.server, 'server')
  if (server.host !== '127.0.0.1') throw new Error('server.host must be 127.0.0.1; non-loopback binding is not supported.')
  if (!Number.isInteger(server.port) || Number(server.port) < 1 || Number(server.port) > 65535) throw new Error('server.port must be an integer from 1 to 65535.')
  if (typeof server.openBrowser !== 'boolean') throw new Error('server.openBrowser must be a boolean.')
  const softron = object(root.softron, 'softron')
  const baseUrl = string(softron.baseUrl, 'softron.baseUrl')!
  let parsed: URL
  try { parsed = new URL(baseUrl) } catch { throw new Error('softron.baseUrl must be a valid URL.') }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) throw new Error('softron.baseUrl must use HTTP(S) and must not contain credentials.')
  const mappings = object(softron.destinationMappings, 'softron.destinationMappings')
  if (Object.values(mappings).some((entry) => typeof entry !== 'string')) throw new Error('Every destination mapping must be a path string.')
  const descript = object(root.descript, 'descript')
  const timezone = string(descript.recordingTimezone, 'descript.recordingTimezone')!
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { throw new Error('descript.recordingTimezone must be a valid IANA timezone.') }
  if (!DATE_FORMATS.has(descript.recordingDateFormat as RecordingDateFormat)) throw new Error('descript.recordingDateFormat is unsupported.')
  const tools = object(root.tools, 'tools')
  return {
    schemaVersion: 1,
    desiredMode: root.desiredMode,
    server: { host: '127.0.0.1', port: Number(server.port), openBrowser: server.openBrowser as boolean },
    softron: {
      baseUrl: parsed.toString().replace(/\/$/, ''), password: string(softron.password, 'softron.password', true),
      primarySourceId: string(softron.primarySourceId, 'softron.primarySourceId', true),
      enabledSourceIds: stringArray(softron.enabledSourceIds, 'softron.enabledSourceIds'),
      destinationMappings: Object.fromEntries(Object.entries(mappings).map(([key, entry]) => [key, String(entry)]))
    },
    descript: {
      apiKey: string(descript.apiKey, 'descript.apiKey', true), destinationRoot: string(descript.destinationRoot, 'descript.destinationRoot')!.replace(/^\/+|\/+$/g, ''),
      recordingTimezone: timezone, recordingDateFormat: descript.recordingDateFormat as RecordingDateFormat
    },
    tools: { ffprobePath: string(tools.ffprobePath, 'tools.ffprobePath')! }
  }
}

export class ConfigStore {
  private constructor(readonly dataDir: string, private readonly store: SerializedJsonStore<AppConfig>, private warnings: string[], private loadError: string | null) {}
  static async open(dataDir: string): Promise<ConfigStore> {
    await ensurePrivateDirectory(dataDir)
    const path = resolve(dataDir, 'config.json')
    let config: AppConfig
    try {
      const activeExists = await access(path).then(() => true, () => false)
      const backupExists = await access(`${path}.bak`).then(() => true, () => false)
      if (!activeExists && !backupExists) throw Object.assign(new Error('Configuration does not exist.'), { code: 'ENOENT' })
      const loaded = await readRecoverableJson(path, validateConfig)
      config = loaded.value
      if (loaded.recovered) await atomicWriteJson(path, config, validateConfig, false)
    } catch (error) {
      if (error instanceof UnsupportedSchemaError) throw error
      config = defaultConfig()
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') await atomicWriteJson(path, config, validateConfig)
      else {
        const message = `Configuration recovery error: ${error instanceof Error ? error.message : String(error)}`
        return new ConfigStore(dataDir, new SerializedJsonStore(path, validateConfig, config), [message], message)
      }
    }
    const warning = await permissionWarning(path)
    return new ConfigStore(dataDir, new SerializedJsonStore(path, validateConfig, config), warning ? [warning] : [], null)
  }
  get path(): string { return this.store.path }
  get(): AppConfig { return this.store.get() }
  async setMode(mode: AppConfig['desiredMode']): Promise<void> { await this.store.update((config) => { config.desiredMode = mode }) }
  async updateEditable(input: EditableConfig): Promise<void> {
    await this.store.update((config) => validateConfig({
      ...config, desiredMode: config.desiredMode,
      server: { ...config.server, ...input.server, host: '127.0.0.1' },
      softron: { ...input.softron, password: config.softron.password },
      descript: { ...input.descript, apiKey: config.descript.apiKey }, tools: input.tools
    }, this.path))
    this.loadError = null
    this.warnings = this.warnings.filter((warning) => !warning.startsWith('Configuration recovery error:'))
  }
  redacted(verification: { descript: { ok: boolean; at: string } | null; softron: { ok: boolean; at: string } | null }): RedactedConfig {
    const config = this.get()
    return {
      schemaVersion: 1, configPath: this.path, desiredMode: config.desiredMode,
      server: { port: config.server.port, openBrowser: config.server.openBrowser },
      softron: { baseUrl: config.softron.baseUrl, primarySourceId: config.softron.primarySourceId, enabledSourceIds: config.softron.enabledSourceIds, destinationMappings: config.softron.destinationMappings },
      descript: { destinationRoot: config.descript.destinationRoot, recordingTimezone: config.descript.recordingTimezone, recordingDateFormat: config.descript.recordingDateFormat },
      tools: config.tools,
      secrets: {
        descriptApiKey: { configured: Boolean(config.descript.apiKey), verified: verification.descript?.ok ?? null, verifiedAt: verification.descript?.at ?? null },
        softronPassword: { configured: Boolean(config.softron.password), verified: verification.softron?.ok ?? null, verifiedAt: verification.softron?.at ?? null }
      }, warnings: [...this.warnings]
    }
  }
  async flush(): Promise<void> { await this.store.flush() }
  isValid(): boolean { return this.loadError === null }
}

export function resolveDataDir(input?: string): string {
  if (!input) return resolve(homedir(), '.movie-recorder-upload')
  return isAbsolute(input) ? resolve(input) : resolve(process.cwd(), input)
}
