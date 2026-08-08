import { contextBridge, ipcRenderer } from 'electron'
import { buildElectronApi } from './api'

const api = buildElectronApi()

/**
 * Legacy bridge for the artifylab frontend (artifylab-frontend repo):
 * the UI is served from the artifylab express server and calls
 * `window.electronAPI.ArtifyLab.*`. The new renderer surfaces use
 * `window.api` (built above); this namespace keeps the existing
 * frontend working without changes.
 */
const electronAPI = {
  ArtifyLab: {
    selectFile: (data: Record<string, unknown>) => ipcRenderer.invoke('artify-selectFile', data),
    getConfig: (data: Record<string, unknown>) => ipcRenderer.invoke('artify-getConfig', data),
    loadComfyUI: (data: Record<string, unknown>) => ipcRenderer.invoke('artify-loadComfyUI', data),
    loadArtifyLab: (data: Record<string, unknown>) =>
      ipcRenderer.invoke('artify-loadArtifyLab', data),
    getAppInfo: () => ipcRenderer.invoke('artify-getAppInfo'),
    scanFolder: (folderPath: string) => ipcRenderer.invoke('artify-scanFolder', folderPath),
    openOutputFolder: () => ipcRenderer.invoke('artify-openOutputFolder'),
    getOutputPath: () => ipcRenderer.invoke('artify-getOutputPath'),
    openRootFolder: (folderName: string) => ipcRenderer.invoke('artify-openRootFolder', folderName),
    openCMD: (type: string) => ipcRenderer.invoke('artify-openCMD', type),
    stopExecution: () => ipcRenderer.invoke('artify-stopExecution')
  }
}

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('electronAPI', electronAPI)
} else {
  ;(globalThis as Record<string, unknown>).api = api
  ;(globalThis as Record<string, unknown>).electronAPI = electronAPI
}
