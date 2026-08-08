import { contextBridge } from 'electron'
import { buildElectronApi } from './api'
import { electronAPI } from './electronAPI'

const api = buildElectronApi()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('api', api)
  contextBridge.exposeInMainWorld('electronAPI', electronAPI)
} else {
  ;(globalThis as Record<string, unknown>).api = api
  ;(globalThis as Record<string, unknown>).electronAPI = electronAPI
}
