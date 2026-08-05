import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types.js'

const desktopApi: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseReconciliationDirectory: () => ipcRenderer.invoke('settings:chooseReconciliationDirectory'),
  chooseRecordingDirectory: () => ipcRenderer.invoke('settings:chooseRecordingDirectory'),
  testDescript: (token) => ipcRenderer.invoke('descript:test', token),
  connectObs: (input) => ipcRenderer.invoke('obs:connect', input),
  startMonitoring: () => ipcRenderer.invoke('watcher:start'),
  stopMonitoring: () => ipcRenderer.invoke('watcher:stop'),
  reconcile: () => ipcRenderer.invoke('recordings:reconcile'),
  resetToday: () => ipcRenderer.invoke('recordings:resetToday'),
  hideBeforeToday: () => ipcRenderer.invoke('recordings:hideBeforeToday'),
  resetSession: (id) => ipcRenderer.invoke('sessions:reset', id),
  cancelSession: (id) => ipcRenderer.invoke('sessions:cancel', id),
  deleteSession: (id) => ipcRenderer.invoke('sessions:delete', id),
  setSessionHidden: (id, hidden) => ipcRenderer.invoke('sessions:setHidden', id, hidden),
  setSessionUploadExcluded: (id, excluded) => ipcRenderer.invoke('sessions:setUploadExcluded', id, excluded),
  recheckSession: (id) => ipcRenderer.invoke('sessions:recheck', id),
  setSessionFileExcluded: (sessionId, fileId, excluded) => ipcRenderer.invoke('sessions:setFileExcluded', sessionId, fileId, excluded),
  setPrimarySource: (sessionId, sourceLabel) => ipcRenderer.invoke('sessions:setPrimarySource', sessionId, sourceLabel),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open'),
  openDescriptProject: (url) => ipcRenderer.invoke('descript:openProject', url),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
    ipcRenderer.on('app:stateChanged', listener)
    return () => ipcRenderer.removeListener('app:stateChanged', listener)
  }
}

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
