// 启动装配：readonly 隐藏样式、ComfyUI 就绪轮询、standalone 默认工作流、
// __artifyReloadWorkflow 重放入口（A→C 切换时主进程重放）。逻辑 = 原单体
// 文件 82-238 行，零改动。
import { artify_inject, artify_playground, isIframe } from './context.js'
import { loadCssCode, handleComfyuiContext } from './canvas_patches.js'
import { loadWorkflow } from './api_workflow.js'
import { startArtifySidebarTab } from './sidebar_tab.js'

export function installBootstrap() {
  window.addEventListener('load', function () {
    let timer = null

    if (artify_inject === 'readonly') {
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

    let counter = 0
    // 扩展注册完成度检测：节点类型数量连续稳定（不再增长）即视为就绪。
    // 不用固定阈值——核心节点本身就有上百个，但将来精简到不足 50 个
    // 也不影响，只要数量非零且稳定即可。
    let lastNodeTypesCount = -1
    let stableNodeTypesCount = 0

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
            loadWorkflow()
            // A→C 切换时主进程会重放这个函数：ComfyUI 页面可能早已加载
            // （实例先启动），面板切换不会重载页面，只有重跑 loadWorkflow
            // 才能把最新 activeAppId 的工作流放进画布。
            window.__artifyReloadWorkflow = () => {
              console.log('[ArtifyInject] Reload workflow requested by desktop')
              loadWorkflow()
            }
          })
        }
        return
      }

      timer = setTimeout(checkComfyUIReady, 100)
    }

    checkComfyUIReady()
  })

  // 兜底：本脚本由桌面端动态注入（async script），可能在 window load 事件
  // 之后才执行，上面的 load 监听器会错过——load 已触发则手动派发一次，
  // 启动 ready 轮询（checkComfyUIReady 自带 20s 轮询窗口）。
  startArtifySidebarTab()
}
