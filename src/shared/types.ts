export type DesiredMode = 'standby' | 'watching'
export type RecordingDateFormat = 'yy-MM-dd' | 'M.d.yy' | 'MM.dd.yy'
export type ConnectionHealth = 'connecting' | 'connected' | 'degraded' | 'disconnected'
export type RecordStatus =
  | 'recording' | 'connection_lost' | 'finalizing' | 'validating' | 'reconciling'
  | 'uploading' | 'processing' | 'completed' | 'needs_review' | 'failed' | 'skipped'

export interface AppConfig {
  schemaVersion: 1
  desiredMode: DesiredMode
  server: { host: '127.0.0.1'; port: number; openBrowser: boolean }
  softron: {
    baseUrl: string
    password: string | null
    primarySourceId: string | null
    enabledSourceIds: string[]
    destinationMappings: Record<string, string>
  }
  descript: {
    apiKey: string | null
    destinationRoot: string
    recordingTimezone: string
    recordingDateFormat: RecordingDateFormat
  }
  tools: { ffprobePath: string }
}

export interface EditableConfig {
  desiredMode: DesiredMode
  server: { port: number; openBrowser: boolean }
  softron: Omit<AppConfig['softron'], 'password'>
  descript: Omit<AppConfig['descript'], 'apiKey'>
  tools: AppConfig['tools']
}

export interface RedactedConfig extends EditableConfig {
  schemaVersion: 1
  configPath: string
  secrets: {
    descriptApiKey: { configured: boolean; verified: boolean | null; verifiedAt: string | null }
    softronPassword: { configured: boolean; verified: boolean | null; verifiedAt: string | null }
  }
  warnings: string[]
}

export interface SoftronSource {
  uniqueId: string
  displayName: string
  deviceName: string
  recordingName: string
  recordingStartDate: string
  recordingEndDate: string
  isRecording: boolean
  isPaused: boolean
  isEnabled: boolean
  enabledDestinationIds: string[]
  recordingPaths: string[]
}

export interface SoftronDestination { uniqueId: string; name: string; path: string | null }

export interface DestinationSnapshot extends SoftronDestination {
  localPath: string | null
  readable: boolean
}

export interface SourceSnapshot extends Omit<SoftronSource, 'isRecording' | 'isPaused' | 'isEnabled'> {
  startedAt: string | null
  stoppedAt: string | null
}

export interface FileFingerprint {
  size: number
  mtimeMs: number
  birthtimeMs: number
  sha256: string
}

export interface MediaValidation {
  checkedAt: string
  ok: boolean
  ffprobeVersion: string | null
  durationSeconds: number | null
  streams: Array<{ index: number; codecType: string; codecName: string | null }>
  formatName: string | null
  error: string | null
}

export interface RecordingFile {
  id: string
  sourceId: string | null
  sourceLabel: string
  role: 'primary' | 'iso'
  localPath: string
  originalFilename: string
  mediaKey: string
  contentType: string
  segmentIndex: number
  timelineOffsetSeconds: number
  fingerprint: FileFingerprint
  stability: 'pending' | 'probing' | 'stable' | 'unstable' | 'missing'
  validation: MediaValidation | null
  uploadStatus: 'pending' | 'uploading' | 'transferred' | 'uploaded' | 'failed'
  error: string | null
}

export interface SessionConfigSnapshot {
  softronBaseUrl: string
  primarySourceId: string | null
  enabledSourceIds: string[]
  destinationMappings: Record<string, string>
  descriptDestinationRoot: string
  recordingTimezone: string
  recordingDateFormat: RecordingDateFormat
  ffprobePath: string
}

export interface RecordingRecord {
  id: string
  createdAt: string
  updatedAt: string
  recorderIdentity: string
  status: RecordStatus
  reasonCode: string | null
  error: string | null
  retryCount: number
  eligibilityDate: string | null
  eligibilityTimezone: string
  sessionStart: string | null
  sessionEnd: string | null
  primarySourceId: string | null
  sources: SourceSnapshot[]
  destinations: DestinationSnapshot[]
  directoryBaselines: Record<string, Record<string, { size: number; mtimeMs: number; birthtimeMs: number }>>
  files: RecordingFile[]
  configSnapshot: SessionConfigSnapshot
  descriptFolder: string
  descriptProjectName: string
  importPayloadHash: string | null
  importAttemptId: string | null
  descriptProjectId: string | null
  descriptJobId: string | null
  descriptProjectUrl: string | null
}

export interface ActivityEntry {
  id: string
  at: string
  level: 'info' | 'success' | 'warning' | 'error'
  recordId: string | null
  message: string
}

export interface RecordsDocument { schemaVersion: 1; records: RecordingRecord[]; activity: ActivityEntry[] }

export interface HealthSnapshot {
  server: 'ok'
  configuration: 'valid' | 'invalid'
  movierecorder: ConnectionHealth
  destinations: 'ready' | 'unresolved' | 'unknown'
  ffprobe: 'available' | 'unavailable' | 'unknown'
  descript: 'configured' | 'verified' | 'rejected' | 'missing'
  watcher: 'standby' | 'starting' | 'watching' | 'degraded' | 'error'
  recovery: 'pending' | 'running' | 'complete' | 'error'
}

export interface AppSnapshot {
  version: string
  startedAt: string
  mode: DesiredMode
  health: HealthSnapshot
  config: RedactedConfig
  softron: { sources: SoftronSource[]; destinations: DestinationSnapshot[]; lastSuccessfulSnapshot: string | null }
  records: RecordingRecord[]
  activity: ActivityEntry[]
  bootstrapToken: string
}

export interface ApiErrorBody { error: { code: string; message: string } }
