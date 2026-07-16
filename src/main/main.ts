import { app, BrowserWindow, dialog, ipcMain, net, shell } from 'electron'
import { join } from 'node:path'
import type { AppSnapshot, ConnectionState, SettingsInput, UpdateState } from '../shared/types.js'
import { LedgerDatabase } from './database.js'
import { DescriptService, ObsService, RecordingWatcher } from './services.js'
import { SettingsStore } from './settings.js'

let window: BrowserWindow | null = null
let settings: SettingsStore
let ledger: LedgerDatabase
let descript: DescriptService
let obs: ObsService
let watcher: RecordingWatcher
let descriptState: ConnectionState['descript'] = 'disconnected'
let hasDescriptToken = false
const releasesUrl = 'https://github.com/TJkrusinski/obs-uploader/releases'
let updateState: UpdateState = { status: 'idle', currentVersion: app.getVersion(), latestVersion: null, releaseUrl: null, checkedAt: null, message: null }

function snapshot(): AppSnapshot {
  return {
    settings: settings.get(),
    hasDescriptToken,
    connections: { obs: obs.getState(), descript: descriptState, watcher: watcher.isWatching() ? 'watching' : 'stopped' },
    recordings: ledger.getRecordings(), activity: ledger.getActivity(), activeRecording: ledger.getPending()[0]?.originalFilename ?? null,
    update: updateState
  }
}
function broadcast(): void { window?.webContents.send('app:stateChanged', snapshot()) }

async function connectObsAndSync(input: { host: string; port: number; password?: string }): Promise<{ ok: boolean; message: string; recordingDirectory?: string }> {
  const result = await obs.connect(input)
  if (result.ok && result.recordingDirectory) {
    await settings.setRecordingsDirectory(result.recordingDirectory)
    if (watcher.isWatching()) await watcher.start()
  }
  broadcast()
  return result
}

async function initializeObsAndWatcher(): Promise<void> {
  const { obsHost, obsPort } = settings.get()
  await connectObsAndSync({ host: obsHost, port: obsPort })
  if (settings.get().recordingsDirectory && !watcher.isWatching()) await watcher.start()
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
  const devUrl = process.env.VITE_DEV_SERVER_URL
  if (devUrl) await window.loadURL(devUrl)
  else await window.loadFile(join(import.meta.dirname, '../../dist/index.html'))
}

app.whenReady().then(async () => {
  settings = new SettingsStore(app.getPath('userData')); await settings.load()
  hasDescriptToken = await settings.hasDescriptToken()
  ledger = new LedgerDatabase(join(app.getPath('userData'), 'recordings.sqlite'))
  descript = new DescriptService(settings, ledger)
  watcher = new RecordingWatcher(settings, ledger, () => broadcast(), async (recording) => {
    broadcast()
    try { await descript.upload(recording) } finally { broadcast() }
  })
  obs = new ObsService(settings, () => broadcast(), (path) => watcher.recordingStopped(path), (available) => watcher.setObsStopEventsAvailable(available))
  registerIpc(); await createWindow()
  setTimeout(() => void checkForUpdates(), 3_000)
  setInterval(() => void checkForUpdates(), 6 * 60 * 60_000)
  void initializeObsAndWatcher().catch(() => {
    if (settings.get().recordingsDirectory && !watcher.isWatching()) void watcher.start().catch(() => undefined)
  })
  setInterval(() => void descript.reconcile().then(broadcast).catch(() => undefined), 60_000)
})

function registerIpc(): void {
  ipcMain.handle('app:getSnapshot', () => snapshot())
  ipcMain.handle('settings:chooseReconciliationDirectory', async () => {
    const result = await dialog.showOpenDialog(window!, { properties: ['openDirectory', 'createDirectory'] })
    return result.canceled ? null : result.filePaths[0]
  })
  ipcMain.handle('settings:save', async (_event, input: SettingsInput) => {
    const result = await settings.save(input)
    hasDescriptToken = await settings.hasDescriptToken()
    broadcast()
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
  ipcMain.handle('watcher:start', async () => { await watcher.start(); broadcast() })
  ipcMain.handle('watcher:stop', () => watcher.stop())
  ipcMain.handle('recordings:reconcile', async () => { await watcher.scanReconciliationDirectory(); await descript.reconcile(); broadcast() })
  ipcMain.handle('recordings:retry', async (_event, id: string) => {
    const recording = ledger.getRecording(id); if (!recording) throw new Error('Recording not found.')
    if (recording.status !== 'failed') throw new Error('Only failed recordings can be retried.')
    ledger.update(id, { status: 'waiting', errorMessage: null, descriptJobId: null, descriptProjectId: null })
    await descript.reconcile(); broadcast()
  })
  ipcMain.handle('recordings:cancel', async (_event, id: string) => {
    const recording = ledger.getRecording(id); if (!recording) throw new Error('Recording not found.')
    try { await descript.cancel(recording) } finally { broadcast() }
  })
  ipcMain.handle('recordings:setHidden', (_event, id: string, hidden: boolean) => {
    if (!ledger.getRecording(id)) throw new Error('Recording not found.')
    ledger.setHidden(id, Boolean(hidden)); broadcast()
  })
  ipcMain.handle('updates:check', () => checkForUpdates())
  ipcMain.handle('updates:open', async () => {
    await shell.openExternal(updateState.releaseUrl ?? releasesUrl)
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { watcher?.stop(); ledger?.close() })
