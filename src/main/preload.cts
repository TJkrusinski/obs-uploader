import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types.js'

const desktopApi: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseReconciliationDirectory: () => ipcRenderer.invoke('settings:chooseReconciliationDirectory'),
  chooseRecordingDirectory: () => ipcRenderer.invoke('settings:chooseRecordingDirectory'),
  testDescript: (token) => ipcRenderer.invoke('descript:test', token),
  connectObs: (input) => ipcRenderer.invoke('obs:connect', input),
  connectVmix: (input) => ipcRenderer.invoke('vmix:connect', input),
  startMonitoring: () => ipcRenderer.invoke('watcher:start'),
  stopMonitoring: () => ipcRenderer.invoke('watcher:stop'),
  reconcile: () => ipcRenderer.invoke('recordings:reconcile'),
  resetSession: (id) => ipcRenderer.invoke('sessions:reset', id),
  cancelSession: (id) => ipcRenderer.invoke('sessions:cancel', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  setSessionHidden: (id, hidden) => ipcRenderer.invoke('sessions:setHidden', id, hidden),
  finalizeSession: (id) => ipcRenderer.invoke('sessions:finalize', id),
  recheckSession: (id) => ipcRenderer.invoke('sessions:recheck', id),
  setSessionFileExcluded: (sessionId, fileId, excluded) => ipcRenderer.invoke('sessions:setFileExcluded', sessionId, fileId, excluded),
  setPrimarySource: (sessionId, sourceLabel) => ipcRenderer.invoke('sessions:setPrimarySource', sessionId, sourceLabel),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open'),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
    ipcRenderer.on('app:stateChanged', listener)
    return () => ipcRenderer.removeListener('app:stateChanged', listener)
  }
}

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
