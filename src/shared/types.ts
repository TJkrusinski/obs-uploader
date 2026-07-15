export type RecordingStatus = 'waiting' | 'uploading' | 'processing' | 'completed' | 'failed'
export type RecordingDateFormat = 'yy-MM-dd' | 'M.d.yy' | 'MM.dd.yy'

export interface AppSettings {
  descriptDestinationRoot: string
  recordingTimezone: string
  recordingDateFormat: RecordingDateFormat
  recordingsDirectory: string | null
  reconciliationDirectory: string | null
  obsHost: string
  obsPort: number
}

export interface Recording {
  id: string
  localPath: string
  originalFilename: string
  recordedAt: string
  fileSize: number
  descriptFolderPath: string
  descriptProjectName: string
  descriptProjectId: string | null
  descriptJobId: string | null
  status: RecordingStatus
  errorMessage: string | null
  hidden: boolean
  discoveredAt: string
  updatedAt: string
}

export interface ActivityItem {
  id: string
  kind: 'info' | 'success' | 'warning' | 'error'
  message: string
  createdAt: string
}

export interface ConnectionState {
  obs: 'connected' | 'disconnected' | 'connecting'
  descript: 'connected' | 'disconnected' | 'checking' | 'rejected'
  watcher: 'watching' | 'stopped'
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
  recordings: Recording[]
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
  startMonitoring: () => Promise<void>
  stopMonitoring: () => Promise<void>
  reconcile: () => Promise<void>
  retryRecording: (id: string) => Promise<void>
  setRecordingHidden: (id: string, hidden: boolean) => Promise<void>
  checkForUpdates: () => Promise<UpdateState>
  openUpdatePage: () => Promise<void>
  onStateChanged: (callback: (state: AppSnapshot) => void) => () => void
}

declare global {
  interface Window {
    desktopApi: DesktopApi
  }
}
