import { contextBridge, ipcRenderer } from 'electron'
import type { DesktopApi } from '../shared/types.js'

const desktopApi: DesktopApi = {
  getSnapshot: () => ipcRenderer.invoke('app:getSnapshot'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  chooseReconciliationDirectory: () => ipcRenderer.invoke('settings:chooseReconciliationDirectory'),
  testDescript: (token) => ipcRenderer.invoke('descript:test', token),
  connectObs: (input) => ipcRenderer.invoke('obs:connect', input),
  startMonitoring: () => ipcRenderer.invoke('watcher:start'),
  stopMonitoring: () => ipcRenderer.invoke('watcher:stop'),
  reconcile: () => ipcRenderer.invoke('recordings:reconcile'),
  retryRecording: (id) => ipcRenderer.invoke('recordings:retry', id),
  cancelRecording: (id) => ipcRenderer.invoke('recordings:cancel', id),
  setRecordingHidden: (id, hidden) => ipcRenderer.invoke('recordings:setHidden', id, hidden),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  openUpdatePage: () => ipcRenderer.invoke('updates:open'),
  onStateChanged: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state)
    ipcRenderer.on('app:stateChanged', listener)
    return () => ipcRenderer.removeListener('app:stateChanged', listener)
  }
}

contextBridge.exposeInMainWorld('desktopApi', desktopApi)
