import { colorizeLinks, colorizeCanvas } from './uuid_color.js'
import { getComfyUIApp } from './canvas_patches.js'
// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export function getQueryParam(key) {
  const params = new URLSearchParams(window.location.search)
  return params.get(key)
}

export async function getElectronConfig() {
  let config
  try {
    config = await window.electronAPI.ArtifyLab.getConfig()
  } catch (_e) {
    // Ignore errors
  }
  return config
}

export async function apiRequest(endpoint, options = {}) {
  let baseUrl
  if (isElectron) {
    const electronConfig = await getElectronConfig()
    baseUrl = electronConfig.server_origin
  } else if (getQueryParam('server_origin')) {
    baseUrl = getQueryParam('server_origin')
  } else {
    baseUrl = 'http://localhost:3000'
  }

  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
    },
  }

  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...defaultOptions,
    ...options,
  })

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Request failed' }))
    throw new Error(errorData.message || `HTTP ${response.status}`)
  }

  return response.json()
}

async function getAppById(appId) {
  const response = await apiRequest(`/api/apps/detail`, {
    method: 'post',
    body: JSON.stringify({
      id: appId,
    }),
  })
  if (response.ok) {
    return response.data
  }
}

export async function getConfig() {
  const response = await apiRequest(`/api/config`, {
    method: 'post',
  })
  if (response.ok) {
    return response.data
  }
}

export async function loadWorkflow() {
  if (artify_inject === 'readonly' || isIframe || artify_playground) {
    console.log('[ArtifyInject] loadWorkflow aborted: in playground/readonly mode')
    return
  }
  // 主进程 A→C 切换会重放 __artifyReloadWorkflow，页面自身也可能在
  // 首屏加载时执行过——同一时间只允许一个加载流程，避免并发重入。
  if (isArtifyLoading) {
    console.log('[ArtifyInject] loadWorkflow skipped: already loading')
    return
  }
  const { app } = getComfyUIApp()

  if (!app || !app.loadGraphData) {
    // Wait a bit more for app to be ready
    setTimeout(() => loadWorkflow(), 500)
    return
  }

  const config = await getConfig()
  if (!config || !config.activeAppId) {
    console.warn('[ArtifyInject] No active app found in config')
    return
  }
  const currentApp = await getAppById(config.activeAppId)
  if (!currentApp) {
    console.warn('[ArtifyInject] Could not fetch current app')
    return
  }

  const workflowName = currentApp.name || 'ArtifyLab Workflow'
  const { workflow } = currentApp.template
  console.log(`[ArtifyInject] Standalone mode: Loading workflow "${workflowName}"`)

  isArtifyLoading = true
  try {
    // Inject name into graph data
    if (workflow && typeof workflow === 'object') {
      workflow.name = workflowName
      workflow.extra_data = workflow.extra_data || {}
      workflow.extra_data.workflow_name = workflowName
      workflow.extra = workflow.extra || {}
      workflow.extra.workflow_name = workflowName
    }

    // 与 iframe 路径一致：clean=true 清掉上一应用的残留节点，避免切换 App 后画布新旧节点混合。
    await app.loadGraphData(workflow, true, true)
    colorizeLinks()
    colorizeCanvas()

    // Apply name to runtime properties immediately
    if (app.graph) {
      app.graph.name = workflowName
      if (!app.graph.extra) app.graph.extra = {}
      app.graph.extra.workflow_name = workflowName
    }
    app.last_loaded_file = workflowName

    if (app.ui && app.ui.workflowManager && app.ui.workflowManager.activeWorkflow) {
      const active = app.ui.workflowManager.activeWorkflow
      active.name = workflowName
      if (active.displayName !== undefined) active.displayName = workflowName
      if (typeof active.rename === 'function') active.rename(workflowName)
      if (typeof app.ui.workflowManager.refresh === 'function') app.ui.workflowManager.refresh()
    }

    // Force name multiple times over the next few seconds to override late-loading resets
    let standaloneNamingAttempts = 0
    const standaloneNamingInterval = setInterval(() => {
      standaloneNamingAttempts++
      const active = app.ui && app.ui.workflowManager ? app.ui.workflowManager.activeWorkflow : null
      if (active) {
        active.name = workflowName
        if (active.displayName !== undefined) active.displayName = workflowName
        if (active.metadata) active.metadata.name = workflowName
        if (typeof active.rename === 'function') active.rename(workflowName)
        if (typeof app.ui.workflowManager.refresh === 'function') app.ui.workflowManager.refresh()

        // Enforce single workflow and correct identity
        const manager = app.ui && app.ui.workflowManager ? app.ui.workflowManager : null
        if (manager && manager.workflows) {
          const target =
            manager.workflows.find(
              (w) => w.name === workflowName || w.displayName === workflowName,
            ) || manager.workflows[0]
          if (target) {
            target.name = workflowName
            if (target.displayName !== undefined) target.displayName = workflowName
            if (target.metadata) target.metadata.name = workflowName
            if (typeof target.rename === 'function') target.rename(workflowName)

            if (manager.activeWorkflow && manager.activeWorkflow.id !== target.id) {
              try {
                manager.switchToWorkflow(target.id)
              } catch (e) {
                /* ignore */
              }
            }

            manager.workflows.forEach((w) => {
              if (w.id !== target.id) {
                try {
                  manager.closeWorkflow(w.id)
                } catch (e) {
                  /* ignore */
                }
              }
            })
          }
          if (typeof manager.refresh === 'function') manager.refresh()
        }
      }
      if (app.graph) {
        app.graph.name = workflowName
        if (!app.graph.extra) app.graph.extra = {}
        app.graph.extra.workflow_name = workflowName
      }
      app.last_loaded_file = workflowName
      if (standaloneNamingAttempts >= 20) clearInterval(standaloneNamingInterval)
    }, 500)
  } catch (e) {
    // getConfig/getAppById/apiRequest/loadGraphData 任一失败原本会变成 unhandled rejection。
    console.error('[ArtifyInject] loadWorkflow failed:', e)
  } finally {
    isArtifyLoading = false
  }
}

// ==========================================================================
// 画布陈列卡片（Artify Display Cards）
//
// 形态：自定义 LiteGraph 节点（isVirtualNode + mode=NEVER）——纯展示，
// 不序列化进 prompt、永不执行；图片用 litegraph 原生 canvas 绘制管线
// （node.imgs + drawImage，官方 PreviewImage 同款），视口裁剪/LOD 免费。
//
// 上墙：A UI 工作台（sidebar tab iframe）执行完成 → postMessage
// { type:'artify:display-card', files:[{filename,subfolder,type}] } →
// 本脚本把每张产物铺成卡片（positionNodes 式瀑布排布 + fitToBounds）。
//
// 回填：卡片右键/双击 → postMessage 给 iframe → 工作台把它作为参考图
// 附件（/view URL）发起下一轮。双向都只传文件引用，不传像素。
// ==========================================================================
