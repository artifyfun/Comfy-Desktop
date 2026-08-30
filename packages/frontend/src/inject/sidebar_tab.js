import { isIframe } from './context.js'
import { installSidebarWidthGovernor } from './governor.js'
import { registerArtifyCardNode } from './card_node.js'
import { handleArtifyMessage, setEmbedWindow } from './card_bridge.js'
import { bindComfyApiEvents, startCanvasPoll } from './bridge_events.js'
import { pushCanvasDigest } from './digest.js'
import { getComfyUIApp } from './canvas_patches.js'
import { getQueryParam } from './api_workflow.js'
// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export function ensureArtifySidebarTab() {
  const app = window.app
  if (
    !app ||
    !app.extensionManager ||
    typeof app.extensionManager.registerSidebarTab !== 'function'
  ) {
    setTimeout(ensureArtifySidebarTab, 1500)
    return
  }
  installSidebarWidthGovernor()
  // 卡片节点类型注册（extensionManager 就绪 ⇒ app.setup 完成 ⇒ LiteGraph 已加载）。
  // 放在 tab 去重 early-return 之前：幂等（registerArtifyCardNode 自查重），
  // 且老版本 tab 已存在时升级也能补上节点类型。
  try {
    const { LiteGraph: lg } = getComfyUIApp()
    if (lg) registerArtifyCardNode(lg)
  } catch (e) {
    console.warn('[ArtifyInject] register ArtifyDisplayCard failed:', e)
  }
  // 感知桥启动（幂等）：必须放在 tab 去重 early-return 之前——tab 注册过
  // 但桥可能尚未启动（老版本升级 / 上次注册后 early-return 跳过了启动行）
  bindComfyApiEvents()
  startCanvasPoll()
  pushCanvasDigest(true)
  if (typeof app.extensionManager.getSidebarTabs === 'function') {
    const existing = app.extensionManager
      .getSidebarTabs()
      .some((t) => t && t.id === 'artify-workbench')
    if (existing) return
  }

  // 提前挂全局消息监听（iframe postMessage 进来的上墙请求）。
  // 注意不与 readonly 模式既有 ARTIFY_EVENT_TYPES 监听冲突：那个只认 eventType。
  window.addEventListener('message', (event) => {
    let data = event.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch (_e) {
        return
      }
    }
    if (data && typeof data.type === 'string' && data.type.startsWith('artify:')) {
      if (event.source) setEmbedWindow(event.source)
      handleArtifyMessage(data)
    }
  })

  try {
    app.extensionManager.registerSidebarTab({
      id: 'artify-workbench',
      title: 'AI 工作台',
      tooltip: 'AI 工作台',
      icon: 'pi pi-sparkles',
      type: 'custom',
      render: (container) => {
        // iframe 嵌 A UI 工作台 embed 模式；src 取主进程注入的引导变量
        // （__ARTIFY_LAB_URL__），兜底相对路径（同源部署形态）。
        container.style.height = '100%'
        // 宿主（ComfyUI sidebar tab）可能在 toggle 面板等操作时重建容器并
        // 再次调用 render——复用已有 iframe（DOM move 不触发重载），否则
        // 会话被重新加载、用户看到的输入中内容直接清空。
        const prev = document.getElementById('artify-workbench-embed')
        if (prev && prev.contentWindow && !prev.contentWindow.closed) {
          container.innerHTML = ''
          container.appendChild(prev)
          setEmbedWindow(prev.contentWindow)
          pushCanvasDigest(true)
          return
        }
        container.innerHTML = ''
        const iframe = document.createElement('iframe')
        iframe.id = 'artify-workbench-embed'
        iframe.style.cssText =
          'width:100%;height:100%;border:0;background:transparent;display:block'
        iframe.setAttribute('allow', 'clipboard-write')
        const base = window.__ARTIFY_LAB_URL__ || getQueryParam('artify_lab_url') || ''
        // server_origin 传 API server 真实 origin（__ARTIFY_LAB_API__）：
        // dev 下前端(vite:5000)与 API(express:3008) 分离，iframe 里没有
        // electronAPI 桥，workbench 的 API 请求全靠这个参数直连 express
        const api = window.__ARTIFY_LAB_API__ || base
        // comfy_origin 传宿主（ComfyUI 页面）自身 origin：workbench 的
        // comfyHost 据此直出 /view（上传图 input / 产物图 output）。
        // 不传则 iframe 内拿不到 ComfyUI 地址 → viewUrl 拼错 → 图片加载失败。
        const comfy = window.location.origin || getQueryParam('server_origin') || ''
        iframe.src = base
          ? `${base}/workbench?embed=1&server_origin=${encodeURIComponent(api)}&comfy_origin=${encodeURIComponent(comfy)}`
          : `/workbench?embed=1&comfy_origin=${encodeURIComponent(comfy)}`
        // 直接捕获回填目标：不依赖 iframe 先说话（工作台 embed 页不会
        // 主动 postMessage，双击/右键回填时 artifyEmbedWindow 必须已就绪）
        setEmbedWindow(iframe.contentWindow)
        container.appendChild(iframe)
        // iframe 就绪后立即推一份当前画布摘要（首屏感知）
        iframe.addEventListener('load', () => {
          setEmbedWindow(iframe.contentWindow)
          pushCanvasDigest(true)
        })
      },
    })
    console.log('[ArtifyInject] artify workbench sidebar tab registered')
  } catch (e) {
    console.warn('[ArtifyInject] registerSidebarTab failed:', e)
  }
}

// 启动：等 extensionManager 就绪后注册。仅顶层窗口（comfyView attach 注入）
// ——iframe 内嵌形态（WorkflowModal 的 artify_playground 子 frame）再注册
// sidebar tab 会嵌套出第二个工作台，必须跳过。（原单体文件在 IIFE 尾部执行；
// 模块化后由 bootstrap.js 的 installBootstrap 末尾调用 startArtifySidebarTab）
export function startArtifySidebarTab() {
  if (!isIframe) ensureArtifySidebarTab()
}
