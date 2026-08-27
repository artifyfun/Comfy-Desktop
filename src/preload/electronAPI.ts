import { ipcRenderer } from 'electron'

/**
 * Legacy `window.electronAPI` bridge for the artifylab frontend
 * (artifylab-frontend repo). Exposed by the main preload (`index.ts`)
 * and by the ComfyUI-view preload (`comfyPreload.ts`) so the injected
 * `comfy_inject.min.js` floating switch button can call back into the
 * app from inside the ComfyUI page.
 *
 * Channels map 1:1 to `registerArtifyHandlers()` in
 * `src/main/artifylab/handlers.ts`.
 */
export const electronAPI = {
  ArtifyLab: {
    selectFile: (data: Record<string, unknown>) => ipcRenderer.invoke('artify-selectFile', data),
    saveArtifact: (payload: { sourcePath: string; suggestedName?: string; title?: string }) =>
      ipcRenderer.invoke('artify-saveArtifact', payload),
    referenceLocalFile: (payload: { filters?: { name: string; extensions: string[] }[] }) =>
      ipcRenderer.invoke('artify-referenceLocalFile', payload),
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
