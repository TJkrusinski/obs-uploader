import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { AppSnapshot, ConnectionState, SettingsInput, UpdateState } from '../shared/types.js'
import { LedgerDatabase } from './database.js'
import { DescriptService, isBeforeRecordingDay, isSameRecordingDay, ObsService, RecordingWatcher, VmixService } from './services.js'
import { SettingsStore } from './settings.js'

let window: BrowserWindow | null = null
let settings: SettingsStore
let ledger: LedgerDatabase
let descript: DescriptService
let obs: ObsService
let vmix: VmixService
let watcher: RecordingWatcher
let descriptState: ConnectionState['descript'] = 'disconnected'
let hasDescriptToken = false
const releasesUrl = 'https://github.com/TJkrusinski/obs-uploader/releases'
let updateState: UpdateState = { status: 'idle', currentVersion: app.getVersion(), latestVersion: null, releaseUrl: null, checkedAt: null, message: null }

function snapshot(): AppSnapshot {
  return {
    settings: settings.get(),
    hasDescriptToken,
    connections: { obs: obs.getState(), vmix: vmix.getState(), descript: descriptState, watcher: watcher.isWatching() ? 'watching' : 'stopped' },
    vmix: vmix.getRecorderState(),
    sessions: ledger.getSessions(), activity: ledger.getActivity(),
    activeRecording: ledger.getPendingSessions()[0]?.files[0]?.originalFilename ?? null,
    update: updateState
  }
}
function broadcast(): void {
  const target = window
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return
  target.webContents.send('app:stateChanged', snapshot())
}

async function connectObsAndSync(input: { host: string; port: number; password?: string }): Promise<{ ok: boolean; message: string; recordingDirectory?: string }> {
  const result = await obs.connect(input)
  if (result.ok && result.recordingDirectory) {
    await settings.setRecordingsDirectory(result.recordingDirectory)
    if (watcher.isWatching()) await watcher.start()
  }
  broadcast()
  return result
}

async function initializeRecordersAndWatcher(): Promise<void> {
  const current = settings.get()
  if (current.recorderType === 'obs') await connectObsAndSync({ host: current.obsHost, port: current.obsPort })
  if (current.recorderType === 'vmix' && current.vmixUseApi) vmix.start({ host: current.vmixHost, port: current.vmixPort })
  if ((current.recorderType === 'obs' && current.recordingsDirectory) || (current.recorderType === 'vmix' && current.reconciliationDirectory)) {
    if (!watcher.isWatching()) await watcher.start()
  }
}

function parseVersion(value: string): [number, number, number, string | null] | null {
  const match = value.trim().match(/^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/)
  return match ? [Number(match[1]), Number(match[2]), Number(match[3]), match[4] ?? null] : null
}

function isNewerVersion(candidate: string, current: string): boolean {
  const next = parseVersion(candidate); const installed = parseVersion(current)
  if (!next || !installed) return false
  const nextNumbers = next.slice(0, 3) as number[]; const installedNumbers = installed.slice(0, 3) as number[]
  for (let index = 0; index < nextNumbers.length; index += 1) {
    if (nextNumbers[index] !== installedNumbers[index]) return nextNumbers[index] > installedNumbers[index]
  }
  return installed[3] !== null && next[3] === null
}

async function checkForUpdates(): Promise<UpdateState> {
  updateState = { ...updateState, status: 'checking', message: null }; broadcast()
  try {
    const response = await net.fetch('https://api.github.com/repos/TJkrusinski/obs-uploader/releases/latest', {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': `OBS-Upload/${app.getVersion()}` },
      signal: AbortSignal.timeout(10_000)
    })
    if (!response.ok) throw new Error(`GitHub returned ${response.status}.`)
    const release = await response.json() as { tag_name?: unknown; html_url?: unknown }
    if (typeof release.tag_name !== 'string' || !parseVersion(release.tag_name)) throw new Error('The latest release does not have a valid version tag.')
    const releaseUrl = typeof release.html_url === 'string' && release.html_url.startsWith(`${releasesUrl}/tag/`) ? release.html_url : releasesUrl
    const available = isNewerVersion(release.tag_name, app.getVersion())
    updateState = {
      status: available ? 'available' : 'current', currentVersion: app.getVersion(), latestVersion: release.tag_name.replace(/^v/, ''),
      releaseUrl: available ? releaseUrl : null, checkedAt: new Date().toISOString(), message: null
    }
  } catch (error) {
    updateState = { ...updateState, status: 'error', checkedAt: new Date().toISOString(), message: error instanceof Error ? error.message : String(error) }
  }
  broadcast(); return updateState
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1360, height: 900, minWidth: 1050, minHeight: 720,
    backgroundColor: '#0a1020',
    webPreferences: { preload: join(import.meta.dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false }
  })
  window.on('closed', () => { window = null })
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadFile(join(import.meta.dirname, '../../dist/index.html'))
}

app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath('userData')); await settings.load()
  hasDescriptToken = await settings.hasDescriptToken()
  ledger = new LedgerDatabase(join(app.getPath('userData'), 'recordings.sqlite'))
  descript = new DescriptService(settings, ledger)
  watcher = new RecordingWatcher(settings, ledger, () => broadcast(), async (session) => {
    broadcast()
    try {
      if (session.recorderType === 'vmix') await descript.reconcile()
      else await descript.upload(session)
    } catch (error) {
      if (session.recorderType === 'vmix') ledger.addActivity('error', error instanceof Error ? error.message : String(error))
      throw error
    } finally { broadcast() }
  })
  obs = new ObsService(settings, () => broadcast(), (path) => watcher.recordingStopped(path), (available) => watcher.setObsStopEventsAvailable(available))
  vmix = new VmixService(() => broadcast(), (recording, multiCorder) => watcher.vmixStateChanged(recording, multiCorder), () => watcher.vmixConnectionLost())
  registerIpc(); await createWindow()
  setTimeout(() => void checkForUpdates(), 3_000)
  setInterval(() => void checkForUpdates(), 6 * 60 * 60_000)
  void initializeRecordersAndWatcher()
    .then(() => descript.reconcile())
    .then(broadcast)
    .catch(() => { if (!watcher.isWatching()) void watcher.start().catch(() => undefined) })
  setInterval(() => void descript.reconcile().then(broadcast).catch((error) => {
    ledger.addActivity('error', error instanceof Error ? error.message : String(error))
    broadcast()
  }), 60_000)
})

function registerIpc(): void {
  ipcMain.handle('app:getSnapshot', () => snapshot())
  ipcMain.handle('settings:chooseReconciliationDirectory', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('settings:chooseRecordingDirectory', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('settings:save', async (_event, input: SettingsInput) => {
    await validateRecorderSettings(input)
    const uploadsWereEnabled = settings.get().uploadsEnabled
    watcher.stop(); vmix.stop()
    const result = await settings.save(input)
    hasDescriptToken = await settings.hasDescriptToken()
    void initializeRecordersAndWatcher().catch((error) => {
      ledger.addActivity('error', error instanceof Error ? error.message : String(error)); broadcast()
    })
    broadcast()
    if (!uploadsWereEnabled && result.uploadsEnabled) {
      void descript.reconcile().then(broadcast).catch((error) => {
        ledger.addActivity('error', error instanceof Error ? error.message : String(error)); broadcast()
      })
    }
    return result
  })
  ipcMain.handle('descript:test', async (_event, token?: string) => {
    descriptState = 'checking'; broadcast()
    const tokenToSave = token?.trim()
    let result = await descript.test(token)
    if (result.ok && tokenToSave) {
      await settings.setDescriptToken(tokenToSave)
      hasDescriptToken = true
      result = { ...result, message: 'Token verified and saved securely.' }
    }
    descriptState = result.ok ? 'connected' : hasDescriptToken ? 'rejected' : 'disconnected'; broadcast()
    return result
  })
  ipcMain.handle('obs:connect', async (_event, input: { host: string; port: number; password?: string }) => {
    return connectObsAndSync(input)
  })
  ipcMain.handle('vmix:connect', async (_event, input: { host: string; port: number }) => vmix.connect(input))
  ipcMain.handle('watcher:start', async () => { await watcher.start(); broadcast() })
  ipcMain.handle('watcher:stop', () => watcher.stop())
  ipcMain.handle('recordings:reconcile', async () => { await watcher.scanReconciliationDirectory(); await descript.reconcile(); broadcast() })
  ipcMain.handle('recordings:resetToday', async () => {
    const { recordingTimezone } = settings.get()
    const now = new Date()
    const sessions = ledger.getSessions().filter((session) => isSameRecordingDay(new Date(session.sessionStart), now, recordingTimezone))
    await descript.stopLocalWork(sessions)
    const deleted = ledger.deleteSessions(sessions.map((session) => session.id))
    ledger.addActivity('warning', `Reset today by removing ${deleted} local queue session${deleted === 1 ? '' : 's'}. Recording files and Descript projects were not changed.`)
    broadcast()
    return deleted
  })
  ipcMain.handle('recordings:hideBeforeToday', () => {
    const { recordingTimezone } = settings.get()
    const now = new Date()
    const sessions = ledger.getSessions().filter((session) => !session.hidden && isBeforeRecordingDay(new Date(session.sessionStart), now, recordingTimezone))
    const hidden = ledger.setHiddenMany(sessions.map((session) => session.id), true)
    ledger.addActivity('info', `Hid ${hidden} queue session${hidden === 1 ? '' : 's'} from before today.`)
    broadcast()
    return hidden
  })
  ipcMain.handle('sessions:reset', async (_event, id: string) => {
    let session = ledger.getSession(id); if (!session) throw new Error('Session not found.')
    if (session.status === 'completed') throw new Error('Completed sessions cannot be reset.')
    if (['ready', 'uploading', 'processing'].includes(session.status)) await descript.cancel(session)
    session = ledger.getSession(id)!
    if (session.descriptJobId && !['canceled', 'failed'].includes(session.status)) {
      throw new Error(`This session still owns active Descript job ${session.descriptJobId}. Cancel it before creating a replacement import.`)
    }
    const retryName = session.descriptJobId ? ledger.retryProjectName(session) : session.descriptProjectName
    ledger.updateSession(id, {
      status: session.recorderType === 'vmix' && session.syncMode === 'unknown' ? 'needs_review' : 'ready',
      errorMessage: null,
      descriptProjectName: retryName,
      descriptJobId: null,
      descriptProjectId: null,
      descriptProjectUrl: null,
      importAttemptId: null,
      importPayloadHash: null
    })
    session.files.filter((file) => file.uploadStatus !== 'excluded').forEach((file) => ledger.updateFile(file.id, {
      uploadStatus: file.stabilityStatus === 'stable' ? 'pending' : 'missing', errorMessage: null
    }))
    ledger.addActivity('info', `Reset ${session.descriptProjectName} for retry${retryName === session.descriptProjectName ? '' : ` as ${retryName}`}.`)
    await descript.reconcile(); broadcast()
  })
  ipcMain.handle('sessions:cancel', async (_event, id: string) => {
    const session = ledger.getSession(id); if (!session) throw new Error('Session not found.')
    try { await descript.cancel(session) } finally { broadcast() }
  })
  ipcMain.handle('sessions:delete', async (_event, id: string) => {
    const session = ledger.getSession(id); if (!session) throw new Error('Session not found.')
    if (['ready', 'uploading', 'processing'].includes(session.status)) await descript.cancel(session)
    ledger.deleteFromQueue(id)
    ledger.addActivity('warning', `Removed ${session.descriptProjectName} from the queue. Local files were kept.`)
    broadcast()
  })
  ipcMain.handle('sessions:setHidden', (_event, id: string, hidden: boolean) => {
    if (!ledger.getSession(id)) throw new Error('Session not found.')
    ledger.setHidden(id, Boolean(hidden)); broadcast()
  })
  ipcMain.handle('sessions:setUploadExcluded', async (_event, id: string, excluded: boolean) => {
    const session = ledger.getSession(id); if (!session) throw new Error('Session not found.')
    if (['uploading', 'processing', 'completed'].includes(session.status)) throw new Error('Upload preference cannot change after upload begins.')
    ledger.setUploadExcluded(id, Boolean(excluded))
    ledger.addActivity('info', `${excluded ? 'Marked' : 'Unmarked'} ${session.descriptProjectName} ${excluded ? 'to stay local' : 'for upload'}.`)
    broadcast()
    if (!excluded && settings.get().uploadsEnabled) {
      const updated = ledger.getSession(id)
      if (updated?.status === 'ready') {
        try { await descript.upload(updated) } finally { broadcast() }
      }
    }
  })
  ipcMain.handle('sessions:finalize', async (_event, id: string) => {
    if (ledger.getSession(id)?.descriptJobId) throw new Error('This session already has a Descript import job and cannot be finalized into a replacement upload.')
    if (vmix.getRecorderState().recording || vmix.getRecorderState().multiCorder) throw new Error('vMix is still recording. Stop both the recorder and MultiCorder first.')
    await watcher.finalizeSessionManually(id)
    ledger.addActivity('warning', `Manual finalization requested for ${ledger.getSession(id)?.descriptProjectName ?? id}.`)
    broadcast()
  })
  ipcMain.handle('sessions:assumeVmixZero', async (_event, id: string) => {
    if (vmix.getRecorderState().recording || vmix.getRecorderState().multiCorder) throw new Error('vMix is still recording. Stop both the recorder and MultiCorder first.')
    await watcher.assumeVmixStartsAtZero(id)
    broadcast()
  })
  ipcMain.handle('sessions:recheck', async (_event, id: string) => {
    await watcher.recheckSession(id); broadcast()
  })
  ipcMain.handle('sessions:setFileExcluded', async (_event, sessionId: string, fileId: string, excluded: boolean) => {
    const session = ledger.getSession(sessionId); if (!session) throw new Error('Session not found.')
    if (['uploading', 'processing', 'completed'].includes(session.status)) throw new Error('Files cannot be changed after upload begins.')
    const file = session.files.find((candidate) => candidate.id === fileId); if (!file) throw new Error('Session file not found.')
    ledger.updateFile(file.id, { uploadStatus: excluded ? 'excluded' : 'pending', errorMessage: null })
    ledger.addActivity('info', `${excluded ? 'Excluded' : 'Included'} ${file.sourceLabel} — ${file.originalFilename}.`)
    const updated = ledger.getSession(sessionId)!
    if (updated.recorderType === 'vmix') {
      const included = updated.files.filter((item) => item.uploadStatus !== 'excluded')
      const errorMessage = !included.some((item) => item.sourceRole === 'primary')
        ? 'Select a primary source before uploading.'
        : included.length > 14
          ? `This session has ${included.length} physical clips, exceeding Descript's 14-track sequence limit.`
          : updated.syncMode === 'unknown'
            ? 'This session has no trustworthy synchronization information.'
            : included.some((item) => item.stabilityStatus !== 'stable')
              ? 'Every included file must be stable before upload.'
              : null
      ledger.updateSession(sessionId, { status: errorMessage ? 'needs_review' : 'ready', errorMessage })
      if (!errorMessage && settings.get().uploadsEnabled && !updated.uploadExcluded) await descript.reconcile()
    }
    broadcast()
  })
  ipcMain.handle('sessions:setPrimarySource', async (_event, sessionId: string, sourceLabel: string) => {
    const session = ledger.getSession(sessionId); if (!session) throw new Error('Session not found.')
    if (['uploading', 'processing', 'completed'].includes(session.status)) throw new Error('The primary source cannot change after upload begins.')
    ledger.setPrimarySource(sessionId, sourceLabel)
    ledger.addActivity('info', `Selected ${sourceLabel} as the primary source for ${session.descriptProjectName}.`)
    const updated = ledger.getSession(sessionId)!
    const included = updated.files.filter((file) => file.uploadStatus !== 'excluded')
    if (updated.recorderType === 'vmix' && updated.status === 'needs_review' && updated.syncMode !== 'unknown' &&
      included.length <= 14 && included.every((file) => file.stabilityStatus === 'stable')) {
      ledger.updateSession(sessionId, { status: 'ready', errorMessage: null })
      if (settings.get().uploadsEnabled && !updated.uploadExcluded) await descript.reconcile()
    }
    broadcast()
  })
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:open', async () => {
    await shell.openExternal(updateState.releaseUrl ?? releasesUrl)
  })
  ipcMain.handle('descript:openProject', async (_event, url: string) => {
    if (!/^https:\/\/web\.descript\.com\/[A-Za-z0-9-]+(?:[/?#].*)?$/.test(url)) throw new Error('Invalid Descript project URL.')
    await shell.openExternal(url)
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { vmix?.stop(); watcher?.stop(); ledger?.close() })

async function validateRecorderSettings(input: SettingsInput): Promise<void> {
  if (input.recorderType !== 'obs' && input.recorderType !== 'vmix') throw new Error('Choose OBS or vMix.')
  if (input.recorderType === 'vmix') {
    if (!input.reconciliationDirectory) throw new Error('Choose the reconciliation folder where vMix writes MultiCorder XML manifests.')
    const stats = await fs.stat(input.reconciliationDirectory)
    if (!stats.isDirectory()) throw new Error(`${input.reconciliationDirectory} is not a directory.`)
    await fs.readdir(input.reconciliationDirectory)
    for (const root of input.vmixRecordingRoots) {
      const rootStats = await fs.stat(root)
      if (!rootStats.isDirectory()) throw new Error(`${root} is not a directory.`)
      await fs.readdir(root)
    }
  }
}
