import { getQueryParam } from './api_workflow.js'
// comfy_inject 共享环境旗标与会话状态（IIFE 时代的闭包变量显式化）。
// 各模块按需 import；写点仍在原函数内（readonly 会话清理等）。
export const artify_inject = getQueryParam('artify_inject')
export const isElectron = !!window.electronAPI
export const isIframe = (function () {
  try {
    return window.self !== window.top
  } catch (e) {
    return true
  }
})()
export const artify_playground = getQueryParam('artify_playground') === 'true'
export let isArtifyLoading = false

// Prevent ComfyUI from restoring previous session tabs or graphs in playground/readonly mode
if (artify_inject === 'readonly' || window.self !== window.top || artify_playground) {
  try {
    // 1. Attempt to clear IndexedDB as modern ComfyUI and extensions use it for session persistence
    if (window.indexedDB) {
      window.indexedDB.deleteDatabase('comfyui')
    }

    // 2. Deep clear all ComfyUI related storage keys from localStorage and sessionStorage
    const clearRelatedStorage = (storage) => {
      try {
        const keys = Object.keys(storage)
        keys.forEach((key) => {
          const k = key.toLowerCase()
          if (
            k.includes('comfy') ||
            k.includes('workflow') ||
            k.includes('graph') ||
            k.includes('workspace') ||
            k.includes('litegraph')
          ) {
            storage.removeItem(key)
          }
        })
      } catch (e) {
        /* ignore */
      }
    }

    clearRelatedStorage(localStorage)
    clearRelatedStorage(sessionStorage)

    // 3. Sabotage localStorage.getItem to prevent any late-loading extensions from restoring previous sessions
    const originalGetItem = window.localStorage.getItem
    window.localStorage.getItem = function (key) {
      if (key && typeof key === 'string') {
        const k = key.toLowerCase()
        if (
          k.includes('workflowmanager') ||
          k.includes('comfy.app.graph') ||
          k.includes('comfy.lastworkflow') ||
          k.includes('comfy_workflow_states') ||
          k.includes('workspace') ||
          k.includes('workspace_manager') ||
          k.includes('litegraph')
        ) {
          return null
        }
      }
      return originalGetItem.apply(this, arguments)
    }

    console.log('[ArtifyInject] Deep cleaned ComfyUI session storage and IndexedDB')
  } catch (e) {
    // Ignore storage errors
  }
}
