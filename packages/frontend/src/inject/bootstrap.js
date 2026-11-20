// 启动装配：readonly 隐藏样式、ComfyUI 就绪轮询、standalone 默认工作流、
// __artifyReloadWorkflow 重放入口（A→C 切换时主进程重放）。
//
// ⚠️ 时序铁律：本脚本由桌面端在 **dom-ready 之后**动态注入（attach.ts →
// executeJavaScript；要读 82KB 文件再跨 IPC 传），因此**可能晚于 window load**。
// 所以 ready 轮询的启动绝不能只挂在 'load' 监听器上：晚注入时该监听器永不
// 触发（load 早已过去），于是轮询不启动 → onReady 不回调 → loadWorkflow 不跑、
// window.__artifyReloadWorkflow 永不定义；而主进程的重放写法是
// `window.__artifyReloadWorkflow && window.__artifyReloadWorkflow()`，未定义时
// **静默 no-op**。再叠加 index.js 的 __artifyInjectLoaded 幂等守卫（本页不再
// 重注入），该页面整个生命周期内永久失效，只能重载页面。
// 这是「A 界面点开工作流、切到 C 界面不加载」的历史根因。
import { artify_inject, artify_playground, isIframe } from './context.js'
import { loadCssCode, handleComfyuiContext } from './canvas_patches.js'
import { loadWorkflow } from './api_workflow.js'
import { startArtifySidebarTab } from './sidebar_tab.js'

export function installBootstrap() {
  let timer = null
  let counter = 0
  // 扩展注册完成度检测：节点类型数量连续稳定（不再增长）即视为就绪。
  // 不用固定阈值——核心节点本身就有上百个，但将来精简到不足 50 个
  // 也不影响，只要数量非零且稳定即可。
  let lastNodeTypesCount = -1
  let stableNodeTypesCount = 0
  // ComfyUI 就绪后才允许 A→C 重放真正执行 loadWorkflow；就绪前到来的重放由
  // 首屏那次 loadWorkflow 兜住——它现读 activeAppId，拿到的必是最新值。
  let comfyReady = false

  /** readonly 隐藏样式。原先只在 'load' 回调里做，晚注入时同样会漏。 */
  function applyReadonlyStyles() {
    if (artify_inject !== 'readonly') {
      return
    }

    loadCssCode(
      `/* Hide main UI containers - use !important to override inline styles */
      body.litegraph .comfyui-body-top,
      body.litegraph .comfyui-body-left,
      body.litegraph .comfyui-body-right,
      body.litegraph .comfyui-body-bottom,
      body.litegraph .workflow-tabs-container,
      body.litegraph .workflow-tabs-container-desktop {
        display: none !important;
      }

      /* Hide side toolbars */
      body.litegraph .side-tool-bar-container,
      body.litegraph .floating-sidebar,
      body.litegraph .connected-sidebar {
        display: none !important;
      }

      /* Hide menu related elements */
      body.litegraph .comfy-menu-button-wrapper,
      body.litegraph .comfy-command-menu {
        display: none !important;
      }

      /* Hide selection toolbox */
      body.litegraph .selection-toolbox {
        display: none !important;
      }

      /* Hide rgthree and other extension elements */
      body.litegraph rgthree-progress-bar,
      body.litegraph .pysssss-image-feed {
        display: none !important;
      }
    `,
      window,
    )

    // Also use JavaScript to directly hide elements (in case CSS isn't enough)
    function hideReadonlyUI() {
      const selectors = [
        '.comfyui-body-top',
        '.comfyui-body-left',
        '.comfyui-body-right',
        '.comfyui-body-bottom',
        '.workflow-tabs-container',
        '.workflow-tabs-container-desktop',
        '.side-tool-bar-container',
        '.floating-sidebar',
        '.connected-sidebar',
        '.comfy-menu-button-wrapper',
        '.comfy-command-menu',
        '.selection-toolbox',
        'rgthree-progress-bar',
      ]

      selectors.forEach((selector) => {
        document.querySelectorAll(selector).forEach((el) => {
          el.style.display = 'none'
        })
      })
    }

    // Run hiding immediately and then retry a few times
    hideReadonlyUI()
    setTimeout(hideReadonlyUI, 100)
    setTimeout(hideReadonlyUI, 500)
    setTimeout(hideReadonlyUI, 1000)
  }

  function checkComfyUIReady() {
    counter++
    clearTimeout(timer)

    // 冷启动时几十个扩展的 JS 逐个动态加载，节点类型注册可能耗时数十秒
    // （曾因 20s 超时导致 onload 永不发出，画布停在默认工作流）
    if (counter > 600) {
      console.warn('[ArtifyInject] Timeout waiting for ComfyUI')
      return
    }

    // ComfyUI 0.19+ sets __COMFYUI_FRONTEND_VERSION__ when initialized
    // Also check for Vue app being mounted (has child nodes)
    const vueApp = document.querySelector('#vue-app')
    const hasVueApp = vueApp && vueApp.childNodes.length > 0
    const hasVersion = typeof window.__COMFYUI_FRONTEND_VERSION__ !== 'undefined'
    const hasLiteGraph = !!window.LiteGraph
    const nodeTypesCount = hasLiteGraph
      ? Object.keys(window.LiteGraph.registered_node_types || {}).length
      : 0
    // hasVersion 在 main bundle 执行时即置位，若用它短路，onload 会在扩展
    // 尚未注册（nodeTypes=0）时发出——父页面 loadGraphData 因缺少自定义
    // 节点类型而失败，画布停留在 ComfyUI 默认工作流。必须等到节点类型
    // 数量非零且连续 5 次轮询（500ms）不再增长，才认为扩展注册完成。
    if (nodeTypesCount > 0 && nodeTypesCount === lastNodeTypesCount) {
      stableNodeTypesCount++
    } else {
      stableNodeTypesCount = 0
      lastNodeTypesCount = nodeTypesCount
    }
    const isFullyReady = hasVersion && hasLiteGraph && stableNodeTypesCount >= 5

    if (isFullyReady && window.app && window.app.graph) {
      if (artify_inject === 'readonly' || isIframe || artify_playground) {
        // Playground mode (in iframe/playground): Wait for all extensions to finish registration
        console.log(
          `[ArtifyInject] Playground mode detected (Node types: ${nodeTypesCount}), waiting for stability...`,
        )
        setTimeout(() => {
          handleComfyuiContext(() => {
            const message = JSON.stringify({ eventType: 'onload' })
            window.parent.postMessage(message, '*')
          })
        }, 2500)
      } else {
        // Standalone mode: Load the active app workflow automatically
        handleComfyuiContext(() => {
          console.log('[ArtifyInject] Standalone mode detected, loading default workflow')
          comfyReady = true
          // A→C 切换时主进程会重放 window.__artifyReloadWorkflow（ComfyUI 页面
          // 可能早已加载，面板切换不重载页面，只有重跑 loadWorkflow 才能把最新
          // activeAppId 的工作流放进画布）。该函数在 installBootstrap 里**提前
          // 定义**，理由见那里的注释。
          loadWorkflow()
        })
      }
      return
    }

    timer = setTimeout(checkComfyUIReady, 100)
  }

  // 幂等启动入口：'load' 监听器与 readyState 兜底都可能走到这里（注入晚于
  // load 时两条路会先后成立），轮询只允许启动一次。
  let pollingStarted = false
  function startReadyPolling() {
    if (pollingStarted) {
      return
    }
    pollingStarted = true
    checkComfyUIReady()
  }

  // A→C 切换时主进程重放的入口。刻意**提前到就绪之前**定义：主进程调用点写成
  // `window.__artifyReloadWorkflow && window.__artifyReloadWorkflow()`，未定义时
  // 静默 no-op——「还没就绪」与「功能坏了」在日志上完全无法区分，正是这种静默
  // 让本 bug 长期没有信号。提前定义后，早到的重放至少留下一条日志。
  if (artify_inject !== 'readonly' && !isIframe && !artify_playground) {
    window.__artifyReloadWorkflow = () => {
      console.log('[ArtifyInject] Reload workflow requested by desktop')
      if (comfyReady) {
        loadWorkflow()
      } else {
        console.log(
          '[ArtifyInject] ComfyUI not ready yet; pending initial load will pick up the latest active app',
        )
      }
    }
  }

  window.addEventListener('load', () => {
    applyReadonlyStyles()
    startReadyPolling()
  })

  // 兜底：本脚本由桌面端动态注入（读文件 + IPC，异步），可能在 window load
  // 之后才执行，上面的 load 监听器会彻底错过（load 只触发一次）。此时
  // readyState 已是 'complete'，直接启动（readonly 样式同理要补一次）。
  // checkComfyUIReady 自带 60s 轮询窗口。
  if (document.readyState === 'complete') {
    applyReadonlyStyles()
    startReadyPolling()
  }

  startArtifySidebarTab()
}
