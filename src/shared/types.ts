export type RecordingDateFormat = 'yy-MM-dd' | 'M.d.yy' | 'MM.dd.yy'
export type RecorderType = 'obs' | 'vmix'
export type CaptureSessionStatus =
  | 'recording'
  | 'connection_lost'
  | 'finalizing'
  | 'needs_review'
  | 'ready'
  | 'uploading'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'canceled'
export type SessionFileRole = 'primary' | 'iso'
export type SessionFileUploadStatus = 'pending' | 'uploading' | 'uploaded' | 'failed' | 'excluded' | 'missing'
export type SessionFileStabilityStatus = 'pending' | 'probing' | 'stable' | 'unsupported' | 'missing'

export interface RecordingLocation {
  id: string
  path: string
  label: string
  role: SessionFileRole
  enabled: boolean
  filenameFilter: string | null
}

export interface AppSettings {
  descriptDestinationRoot: string
  recordingTimezone: string
  recordingDateFormat: RecordingDateFormat
  recordingsDirectory: string | null
  reconciliationDirectory: string | null
  obsHost: string
  obsPort: number
  monitorObs: boolean
  monitorVmix: boolean
  vmixHost: string
  vmixPort: number
  vmixUseApi: boolean
  vmixRecordingLocations: RecordingLocation[]
}

export interface SessionFile {
  id: string
  sessionId: string
  locationId: string
  sourceLabel: string
  sourceRole: SessionFileRole
  localPath: string
  originalFilename: string
  descriptMediaKey: string
  contentType: string
  fileSize: number
  modifiedAt: string
  segmentIndex: number
  stabilityStatus: SessionFileStabilityStatus
  uploadStatus: SessionFileUploadStatus
  errorMessage: string | null
  discoveredAt: string
  updatedAt: string
}

export interface CaptureSession {
  id: string
  recorderType: RecorderType
  status: CaptureSessionStatus
  sessionStart: string
  sessionEnd: string | null
  finalizationSource: 'obs_event' | 'vmix_api' | 'filesystem' | 'manual' | null
  descriptFolderPath: string
  descriptProjectName: string
  descriptProjectId: string | null
  descriptJobId: string | null
  configurationSnapshot: string
  errorMessage: string | null
  hidden: boolean
  createdAt: string
  updatedAt: string
  files: SessionFile[]
}

export interface ActivityItem {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  createdAt: string
}

export interface ConnectionState {
  obs: 'connected' | 'disconnected' | 'connecting'
  vmix: 'connected' | 'disconnected' | 'connecting'
  descript: 'connected' | 'disconnected' | 'checking' | 'rejected'
  watcher: 'watching' | 'stopped'
}

export interface VmixState {
  recording: boolean
  multiCorder: boolean
  lastSuccessfulPoll: string | null
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'available' | 'error'
  currentVersion: string
  latestVersion: string | null
  releaseUrl: string | null
  checkedAt: string | null
  message: string | null
}

export interface AppSnapshot {
  settings: AppSettings
  hasDescriptToken: boolean
  connections: ConnectionState
  vmix: VmixState
  sessions: CaptureSession[]
  activity: ActivityItem[]
  activeRecording: string | null
  update: UpdateState
}

export interface SettingsInput extends AppSettings {
  descriptToken?: string
  obsPassword?: string
}

export interface DesktopApi {
  getSnapshot: () => Promise<AppSnapshot>
  saveSettings: (settings: SettingsInput) => Promise<AppSettings>
  chooseReconciliationDirectory: () => Promise<string | null>
  testDescript: (token?: string) => Promise<{ ok: boolean; message: string }>
  connectObs: (input: { host: string; port: number; password?: string }) => Promise<{ ok: boolean; message: string; recordingDirectory?: string }>
  connectVmix: (input: { host: string; port: number }) => Promise<{ ok: boolean; message: string; recording: boolean; multiCorder: boolean }>
  chooseRecordingDirectory: () => Promise<string | null>
  startMonitoring: () => Promise<void>
  stopMonitoring: () => Promise<void>
  reconcile: () => Promise<void>
  resetToday: () => Promise<number>
  hideBeforeToday: () => Promise<number>
  resetSession: (id: string) => Promise<void>
  cancelSession: (id: string) => Promise<void>
  deleteSession: (id: string) => Promise<void>
  setSessionHidden: (id: string, hidden: boolean) => Promise<void>
  finalizeSession: (id: string) => Promise<void>
  recheckSession: (id: string) => Promise<void>
  setSessionFileExcluded: (sessionId: string, fileId: string, excluded: boolean) => Promise<void>
  setPrimarySource: (sessionId: string, sourceLabel: string) => Promise<void>
  checkForUpdates: () => Promise<UpdateState>
  openUpdatePage: () => Promise<void>
  onStateChanged: (callback: (state: AppSnapshot) => void) => () => void
}

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}
