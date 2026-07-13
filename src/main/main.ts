import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { join } from 'node:path'
import type { AppSnapshot, ConnectionState, SettingsInput } from '../shared/types.js'
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

function snapshot(): AppSnapshot {
  return {
    settings: settings.get(),
    hasDescriptToken,
    connections: { obs: obs.getState(), descript: descriptState, watcher: watcher.isWatching() ? 'watching' : 'stopped' },
    recordings: ledger.getRecordings(), activity: ledger.getActivity(), activeRecording: ledger.getPending()[0]?.originalFilename ?? null
  }
}
function broadcast(): void { window?.webContents.send('app:stateChanged', snapshot()) }

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
  if (settings.get().recordingsDirectory) await watcher.start().catch(() => undefined)
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
    const result = await obs.connect(input)
    if (result.ok && result.recordingDirectory) {
      await settings.setRecordingsDirectory(result.recordingDirectory)
      if (watcher.isWatching()) await watcher.start()
      broadcast()
    }
    return result
  })
  ipcMain.handle('watcher:start', async () => { await watcher.start(); broadcast() })
  ipcMain.handle('watcher:stop', () => watcher.stop())
  ipcMain.handle('recordings:reconcile', async () => { await watcher.scanReconciliationDirectory(); await descript.reconcile(); broadcast() })
  ipcMain.handle('recordings:retry', async (_event, id: string) => {
    const recording = ledger.getRecording(id); if (!recording) throw new Error('Recording not found.')
    ledger.update(id, { status: 'waiting', errorMessage: null, descriptJobId: null, descriptProjectId: null })
    await descript.reconcile(); broadcast()
  })
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('before-quit', () => { watcher?.stop(); ledger?.close() })
