// 整体包在 IIFE 内：顶层 return 在 eval/executeJavaScript（以及部分
// ComfyUI 宿主页面上下文）中非法，函数内 return 则所有路径都合法。
;(function () {
  // 幂等保护：本脚本可能被多次注入（comfyView 的 attach 注入、WorkflowModal
  // iframe 的子 frame 注入、iframe 重复导航），重复执行会导致双浮动按钮、
  // 双 eventBus 监听等副作用，直接跳过。
  if (window.__artifyInjectLoaded) {
    return
  }
  window.__artifyInjectLoaded = true

  const artify_inject = getQueryParam('artify_inject')
  const isElectron = !!window.electronAPI
  const isIframe = (function () {
    try {
      return window.self !== window.top
    } catch (e) {
      return true
    }
  })()
  const artify_playground = getQueryParam('artify_playground') === 'true'
  let isArtifyLoading = false

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
  if (document.readyState === 'complete') {
    window.dispatchEvent(new Event('load'))
  }
  // C→A 切换已由标题栏原生 A/C 开关承担（comfy-window:set-surface），
  // 页面内浮动按钮已移除。

  function uuidv4() {
    return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (a) =>
      (a ^ ((Math.random() * 16) >> (a / 4))).toString(16),
    )
  }

  function getRandomColor() {
    return `#${`00000${((Math.random() * 0x1000000) << 0).toString(16)}`.substr(-6)}`
  }

  /**
   * v0.29 前端把 default_connection_color_byType 置空（{}），
   * determineLinkColor 全部落到默认单色 —— 所有输入/输出连接只有
   * 一种颜色。渲染逻辑优先读 link.color，这里按官方类型色表给每条
   * 链接上色，恢复按数据类型区分颜色的体验。
   */
  const LINK_TYPE_COLORS = {
    MODEL: '#b4a7d6',
    DIFFUSION_MODEL: '#b4a7d6',
    CLIP: '#ffd166',
    VAE: '#f79f9f',
    CONDITIONING: '#f4a261',
    LATENT: '#f9c7d4',
    IMAGE: '#64b5f6',
    MASK: '#81c784',
    MESH: '#6dd45c',
    NUMBER: '#9e9e9e',
    INT: '#9e9e9e',
    FLOAT: '#9e9e9e',
    STRING: '#d9a441',
    TEXT: '#d9a441',
    BOOLEAN: '#b06fb0',
    COMBO: '#b06fb0',
    AUDIO: '#7fb3d5',
    VIDEO: '#7fb3d5',
  }
  function colorizeLinks() {
    try {
      const g = window.app && window.app.graph
      if (!g || !g.links) return
      for (const id of Object.keys(g.links)) {
        const link = g.links[id]
        if (!link) continue
        const color = LINK_TYPE_COLORS[link.type] || '#9e9e9e'
        if (link.color !== color) link.color = color
      }
      g.setDirtyCanvas && g.setDirtyCanvas(true, true)
    } catch (e) {
      console.warn('[ArtifyInject] colorizeLinks failed:', e)
    }
  }

  /**
   * v0.29 的槽（输入/输出小圆点）颜色走 default_connection_color_byType：
   * 官方只配了 IMAGE/MODEL/LATENT 等少数类型，STRING/FLOAT/INT/BOOLEAN
   * 和自定义类型全是空串 → getConnectedColor 落到 output_on（统一绿色），
   * 所以文本类工作流的输入/输出看起来只有一种颜色。把空项用类型色表
   * 填充，让槽颜色与链接颜色一致、按类型区分。
   */
  function colorizeCanvas() {
    try {
      const c = window.app && window.app.canvas
      if (!c) return
      if (!c.default_connection_color_byType) c.default_connection_color_byType = {}
      if (!c.default_connection_color_byTypeOff) c.default_connection_color_byTypeOff = {}
      const fallback = '#9e9e9e'
      const fill = (table) => {
        for (const key of Object.keys(table)) {
          if (!table[key]) table[key] = LINK_TYPE_COLORS[key] || fallback
        }
      }
      fill(c.default_connection_color_byType)
      fill(c.default_connection_color_byTypeOff)
      c.setDirtyCanvas && c.setDirtyCanvas(true, true)
    } catch (e) {
      console.warn('[ArtifyInject] colorizeCanvas failed:', e)
    }
  }

  function serializer(replacer, cycleReplacer) {
    var stack = [],
      keys = []

    if (cycleReplacer == null)
      cycleReplacer = function (key, value) {
        if (stack[0] === value) return '[Circular ~]'
        return '[Circular ~.' + keys.slice(0, stack.indexOf(value)).join('.') + ']'
      }

    return function (key, value) {
      if (stack.length > 0) {
        var thisPos = stack.indexOf(this)
        ~thisPos ? stack.splice(thisPos + 1) : stack.push(this)
        ~thisPos ? keys.splice(thisPos, Infinity, key) : keys.push(key)
        if (~stack.indexOf(value)) value = cycleReplacer.call(this, key, value)
      } else stack.push(value)

      return replacer == null ? value : replacer.call(this, key, value)
    }
  }

  function stringify(obj, replacer, spaces, cycleReplacer) {
    return JSON.stringify(obj, serializer(replacer, cycleReplacer), spaces)
  }

  function loadCssCode(code, win) {
    const { document } = win
    const style = document.createElement('style')
    style.type = 'text/css'
    style.rel = 'stylesheet'
    style.appendChild(document.createTextNode(code))
    const head = document.getElementsByTagName('head')[0]
    head.appendChild(style)
  }

  function getComfyUIApp() {
    // Try window.app first (set by ComfyUI after GraphView mounts)
    let app = window.app

    // Try Vue internal - __vue_app__ on the mounted element
    if (!app) {
      const vueAppEl = document.querySelector('#vue-app')
      if (vueAppEl && vueAppEl.__vue_app__) {
        // Vue 3 app instance - the actual app is usually the root component
        const vueApp = vueAppEl.__vue_app__
        // Try to get the app from the root component
        if (vueApp._instance) {
          app = vueApp._instance.proxy
        }
      }
    }

    // Try to get LiteGraph/LGraph from window (always set by ComfyUI)
    let LiteGraph = window.LiteGraph || window.LGraph
    if (!LiteGraph) {
      for (const key of Object.keys(window)) {
        if (key === 'LiteGraph' || key === 'LGraph') {
          LiteGraph = window[key]
          break
        }
      }
    }

    return { app, LiteGraph }
  }

  function handleComfyuiContext(onReady) {
    const { app, LiteGraph } = getComfyUIApp()

    if (!app || !LiteGraph) {
      // Retry after a short delay - window.app might not be set yet
      setTimeout(() => {
        const { app: retryApp, LiteGraph: retryLiteGraph } = getComfyUIApp()
        if (!retryApp || !retryLiteGraph) {
          console.warn('[ArtifyInject] Could not find ComfyUI app instance after retry')
          // 仍回调 onReady，避免父页面（如工作流编辑器 modal）因等不到 onload 而永久转圈；
          // app 缺失会在后续交互中自然暴露，warn 已记录原因。
          onReady()
          return
        }
        doHandleComfyuiContext(retryApp, retryLiteGraph, onReady)
      }, 1000)
      return
    }

    doHandleComfyuiContext(app, LiteGraph, onReady)
  }

  function doHandleComfyuiContext(app, LiteGraph, onReady) {
    const isArtifyMode = artify_inject === 'readonly' || isIframe || artify_playground

    if (isArtifyMode) {
      // Known ArtifyLab event types - only process these
      const ARTIFY_EVENT_TYPES = [
        'updateParamsNodes',
        'centerOnNode',
        'loadGraphData',
        'updatePrompt',
      ]

      // (loadGraphData protection removed as deep storage cleanup handles session isolation)

      const eventBus = {
        callbacks: [],
        send: (message) => {
          window.parent.postMessage(message, '*')
        },
        on: (cb) => {
          eventBus.callbacks.push(cb)
        },
      }

      window.addEventListener('message', (event) => {
        // Only process messages that are ArtifyLab messages
        let data = event.data

        // If data is already an object, use it directly
        // If it's a string, try to parse as JSON
        if (typeof data === 'string') {
          try {
            data = JSON.parse(data)
          } catch {
            // Not valid JSON, ignore
            return
          }
        }

        // Only process if it's our message format
        if (data && data.eventType && ARTIFY_EVENT_TYPES.includes(data.eventType)) {
          for (const i in eventBus.callbacks) {
            eventBus.callbacks[i](data)
          }
        }
      })

      if (artify_inject === 'readonly') {
        app.canvas.allow_dragnodes = false
        app.canvas.allow_reconnect_links = false
        app.canvas.allow_searchbox = false
        app.handleFile = () => {}
      }

      // Prevent multi-tab/workflow manager from switching tabs or restoring sessions in playground mode
      if (
        app.ui &&
        app.ui.workflowManager &&
        (artify_inject === 'readonly' || isIframe || artify_playground)
      ) {
        try {
          const manager = app.ui.workflowManager

          // Disable tab restoration settings if possible
          if (app.ui.settings) {
            try {
              app.ui.settings.setFieldValue('Comfy.WorkflowManager.TabRestoration', false)
              app.ui.settings.setFieldValue('Comfy.Workflows.TabRestoration', false)
            } catch (e) {
              /* ignore */
            }
          }

          // Disable the tab switching method
          // Allow switchToWorkflow but enforce single workflow elsewhere
          // (Blocking it entirely was causing users to get stuck on the initial blank tab)

          // Hack: Force only one workflow to exist and be active
          // We do this by intercepting the workflows array if possible, or just clearing it
          if (manager.workflows && manager.workflows.length > 1) {
            console.log('[ArtifyInject] Cleaning up extra workflows...')
            // Try to close others. manager.closeWorkflow often works.
            const workflowsToClose = [...manager.workflows].slice(1)
            workflowsToClose.forEach((w) => {
              try {
                manager.closeWorkflow(w.id)
              } catch (err) {
                /* ignore */
              }
            })
          }
        } catch (e) {
          console.warn('[ArtifyInject] Failed to patch workflowManager:', e)
        }
      }

      let paramsNodes = []
      const origin_drawNodeShape = app.canvas.drawNodeShape
      app.canvas.drawNodeShape = function (node, ctx, size, fgcolor, bgcolor, selected) {
        const isSelected = paramsNodes.some((item) => item.id === node.id)
        const outputNode = paramsNodes.find(
          (item) => item.id === node.id && item.category === 'output',
        )
        fgcolor = outputNode ? outputNode.color : fgcolor
        bgcolor = outputNode ? outputNode.color : bgcolor
        selected = isSelected
        const res = origin_drawNodeShape.call(this, node, ctx, size, fgcolor, bgcolor, selected)
        return res
      }

      app.canvas.drawNodeWidgets = function (node, posY, ctx, active_widget) {
        if (!node.widgets || !node.widgets.length) {
          return 0
        }
        const width = node.size[0]
        const widgets = node.widgets
        posY += 2
        const H = (LiteGraph || window.LiteGraph || window.LGraph).NODE_WIDGET_HEIGHT
        const show_text = this.ds.scale > 0.5
        ctx.save()
        ctx.globalAlpha = this.editor_alpha
        const outline_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_OUTLINE_COLOR
        let background_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_BGCOLOR
        const text_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_TEXT_COLOR
        const secondary_text_color = (LiteGraph || window.LiteGraph || window.LGraph)
          .WIDGET_SECONDARY_TEXT_COLOR
        const margin = 15

        for (let i = 0; i < widgets.length; ++i) {
          const w = widgets[i]
          // First check for input category node (applies to all widgets of this node)
          const inputNode = paramsNodes.find(
            (item) => item.id === node.id && item.category === 'input',
          )
          if (inputNode) {
            background_color = inputNode.color
          } else {
            // Then check for specific widget match
            const current = paramsNodes.find(
              (item) => item.id === node.id && item.selectedWidget.name === w.name,
            )
            if (current) {
              background_color = current.color
            } else {
              background_color = (LiteGraph || window.LiteGraph || window.LGraph).WIDGET_BGCOLOR
            }
          }
          let y = posY
          if (w.y) {
            y = w.y
          }
          w.last_y = y
          ctx.strokeStyle = outline_color
          ctx.fillStyle = '#222'
          ctx.textAlign = 'left'
          if (w.disabled) ctx.globalAlpha *= 0.5
          const widget_width = w.width || width

          switch (w.type) {
            case 'button':
              ctx.fillStyle = background_color
              if (w.clicked) {
                ctx.fillStyle = '#AAA'
                w.clicked = false
                this.dirty_canvas = true
              }
              ctx.fillRect(margin, y, widget_width - margin * 2, H)
              if (show_text && !w.disabled) ctx.strokeRect(margin, y, widget_width - margin * 2, H)
              if (show_text) {
                ctx.textAlign = 'center'
                ctx.fillStyle = text_color
                ctx.fillText(w.label || w.name, widget_width * 0.5, y + H * 0.7)
              }
              break
            case 'toggle':
              ctx.textAlign = 'left'
              ctx.strokeStyle = outline_color
              ctx.fillStyle = background_color
              ctx.beginPath()
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5])
              else ctx.rect(margin, y, widget_width - margin * 2, H)
              ctx.fill()
              if (show_text && !w.disabled) ctx.stroke()
              ctx.fillStyle = w.value ? '#89A' : '#333'
              ctx.beginPath()
              ctx.arc(widget_width - margin * 2, y + H * 0.5, H * 0.36, 0, Math.PI * 2)
              ctx.fill()
              if (show_text) {
                ctx.fillStyle = secondary_text_color
                const label = w.label || w.name
                if (label != null) {
                  ctx.fillText(label, margin * 2, y + H * 0.7)
                }
                ctx.fillStyle = w.value ? text_color : secondary_text_color
                ctx.textAlign = 'right'
                ctx.fillText(
                  w.value ? w.options.on || 'true' : w.options.off || 'false',
                  widget_width - 40,
                  y + H * 0.7,
                )
              }
              break
            case 'slider': {
              ctx.fillStyle = background_color
              ctx.fillRect(margin, y, widget_width - margin * 2, H)
              const range = w.options.max - w.options.min
              let nvalue = (w.value - w.options.min) / range
              if (nvalue < 0.0) nvalue = 0.0
              if (nvalue > 1.0) nvalue = 1.0
              ctx.fillStyle = Object.prototype.hasOwnProperty.call(w.options, 'slider_color')
                ? w.options.slider_color
                : active_widget === w
                  ? '#89A'
                  : '#678'
              ctx.fillRect(margin, y, nvalue * (widget_width - margin * 2), H)
              if (show_text && !w.disabled) ctx.strokeRect(margin, y, widget_width - margin * 2, H)
              if (w.marker) {
                let marker_nvalue = (w.marker - w.options.min) / range
                if (marker_nvalue < 0.0) marker_nvalue = 0.0
                if (marker_nvalue > 1.0) marker_nvalue = 1.0
                ctx.fillStyle = Object.prototype.hasOwnProperty.call(w.options, 'marker_color')
                  ? w.options.marker_color
                  : '#AA9'
                ctx.fillRect(margin + marker_nvalue * (widget_width - margin * 2), y, 2, H)
              }
              if (show_text) {
                ctx.textAlign = 'center'
                ctx.fillStyle = text_color
                ctx.fillText(
                  w.label ||
                    `${w.name}  ${Number(w.value).toFixed(
                      w.options.precision != null ? w.options.precision : 3,
                    )}`,
                  widget_width * 0.5,
                  y + H * 0.7,
                )
              }
              break
            }
            case 'number':
            case 'combo':
              ctx.textAlign = 'left'
              ctx.strokeStyle = outline_color
              ctx.fillStyle = background_color
              ctx.beginPath()
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5])
              else ctx.rect(margin, y, widget_width - margin * 2, H)
              ctx.fill()
              if (show_text) {
                if (!w.disabled) ctx.stroke()
                ctx.fillStyle = text_color
                if (!w.disabled) {
                  ctx.beginPath()
                  ctx.moveTo(margin + 16, y + 5)
                  ctx.lineTo(margin + 6, y + H * 0.5)
                  ctx.lineTo(margin + 16, y + H - 5)
                  ctx.fill()
                  ctx.beginPath()
                  ctx.moveTo(widget_width - margin - 16, y + 5)
                  ctx.lineTo(widget_width - margin - 6, y + H * 0.5)
                  ctx.lineTo(widget_width - margin - 16, y + H - 5)
                  ctx.fill()
                }
                ctx.fillStyle = secondary_text_color
                ctx.fillText(w.label || w.name, margin * 2 + 5, y + H * 0.7)
                ctx.fillStyle = text_color
                ctx.textAlign = 'right'
                if (w.type === 'number') {
                  ctx.fillText(
                    Number(w.value).toFixed(
                      w.options.precision !== undefined ? w.options.precision : 3,
                    ),
                    widget_width - margin * 2 - 20,
                    y + H * 0.7,
                  )
                } else {
                  let v = w.value
                  if (w.options.values) {
                    let values = w.options.values
                    if (values.constructor === Function) values = values()
                    if (values && values.constructor !== Array) v = values[w.value]
                  }
                  ctx.fillText(v, widget_width - margin * 2 - 20, y + H * 0.7)
                }
              }
              break
            case 'customtext':
              w.element.style.background = background_color
              if (w.draw) {
                w.draw(ctx, node, widget_width, y, H)
              }
              break
            case 'string':
            case 'text':
              ctx.textAlign = 'left'
              ctx.strokeStyle = outline_color
              ctx.fillStyle = background_color
              ctx.beginPath()
              if (show_text) ctx.roundRect(margin, y, widget_width - margin * 2, H, [H * 0.5])
              else ctx.rect(margin, y, widget_width - margin * 2, H)
              ctx.fill()
              if (show_text) {
                if (!w.disabled) ctx.stroke()
                ctx.save()
                ctx.beginPath()
                ctx.rect(margin, y, widget_width - margin * 2, H)
                ctx.clip()
                ctx.fillStyle = secondary_text_color
                const label = w.label || w.name
                if (label != null) {
                  ctx.fillText(label, margin * 2, y + H * 0.7)
                }
                ctx.fillStyle = text_color
                ctx.textAlign = 'right'
                ctx.fillText(String(w.value).substr(0, 30), widget_width - margin * 2, y + H * 0.7)
                ctx.restore()
              }
              break
            default:
              if (w.draw) {
                w.draw(ctx, node, widget_width, y, H)
              }
              break
          }
          posY += (w.computeSize ? w.computeSize(widget_width)[1] : H) + 4
          ctx.globalAlpha = this.editor_alpha
        }
        ctx.restore()
        ctx.textAlign = 'left'
      }

      const origin_getNodeMenuOptions = app.canvas.getNodeMenuOptions
      app.canvas.getNodeMenuOptions = function (...res) {
        const node = res[0]
        const options = origin_getNodeMenuOptions.call(this, ...res)
        options.splice(0, options.length)

        if (node.widgets) {
          const selectedWidgets = node.widgets.filter((widget) => {
            const isSelected = paramsNodes.some(
              (item) => item.id === node.id && item.selectedWidget.name === widget.name,
            )
            return isSelected
          })

          const input = {
            content: `提取输入「Pick as input」 [${selectedWidgets.length}/${node.widgets.length}]`,
            has_submenu: true,
            submenu: {
              options: node.widgets.map((widget) => {
                const isSelected = paramsNodes.some(
                  (item) => item.id === node.id && item.selectedWidget.name === widget.name,
                )
                return {
                  content: isSelected ? `${widget.name} ✓` : widget.name,
                  className: isSelected ? 'selected' : '',
                  callback: () => {
                    if (isSelected) {
                      paramsNodes = paramsNodes.filter(
                        (item) =>
                          item.id !== node.id ||
                          (item.id === node.id && item.selectedWidget.name !== widget.name),
                      )
                    } else {
                      const color = getRandomColor()
                      // Store essential data plus parent's enriched fields
                      paramsNodes.push({
                        id: node.id,
                        type: node.type, // needed for getRenderComponent
                        color,
                        category: 'input',
                        name: widget.name,
                        selectedWidget: { name: widget.name, type: widget.type },
                        // These will be filled by parent's handleMessage
                        description: '',
                        renderComponent: '',
                        key: '',
                      })
                    }
                    eventBus.send(
                      stringify({
                        eventType: 'updateParamsNodes',
                        data: paramsNodes,
                      }),
                    )
                  },
                }
              }),
            },
          }

          options.push(input)
        }

        const isSelected = paramsNodes.some(
          (item) => item.id === node.id && ['output'].includes(item.category),
        )
        const output = {
          content: isSelected
            ? '提取为输出节点「Pick as output」 ✓'
            : '提取为输出节点「Pick as output」',
          className: isSelected ? 'selected-output' : '',
          has_submenu: false,
          callback: () => {
            if (isSelected) {
              paramsNodes = paramsNodes.filter(
                (item) => item.id !== node.id || item.category !== 'output',
              )
            } else {
              const color = getRandomColor()
              // Store essential data plus parent's enriched fields
              paramsNodes.push({
                id: node.id,
                type: node.type, // needed for getRenderComponent
                color,
                category: 'output',
                name: node.title,
                selectedWidget: { id: node.id },
                // These will be filled by parent's handleMessage
                description: '',
                renderComponent: '',
                key: '',
              })
            }
            eventBus.send(
              stringify({
                eventType: 'updateParamsNodes',
                data: paramsNodes,
              }),
            )
          },
        }

        options.push(output)

        return options
      }

      app.canvas.getCanvasMenuOptions = () => []

      app.canvas.centerOnNode = function (node) {
        if (!node) return
        const parent = this.canvas.parentNode
        const width = parent.offsetWidth
        const height = parent.offsetHeight
        this.ds.offset[0] = -node.pos[0] - node.size[0] * 0.5 + (width * 0.5) / this.ds.scale
        this.ds.offset[1] = -node.pos[1] - node.size[1] * 0.5 + (height * 0.5) / this.ds.scale
        this.setDirty(true, true)
      }

      eventBus.on(async (message) => {
        // message is already parsed (either string was parsed in window.addEventListener, or it came as object)
        const msgData = typeof message === 'string' ? JSON.parse(message) : message
        const { eventType, data } = msgData
        if (eventType === 'updateParamsNodes') {
          paramsNodes = data
          eventBus.send(
            stringify({
              eventType: 'updateParamsNodes',
              data: paramsNodes,
            }),
          )
        }
        if (eventType === 'centerOnNode') {
          const node = app.graph.getNodeById(data.id)
          app.canvas.centerOnNode(node)
        }
        if (eventType === 'loadGraphData') {
          const workflowName = msgData.name || 'ArtifyLab Workflow'
          console.log('[ArtifyInject] Processing loadGraphData, target name:', workflowName)
          isArtifyLoading = true
          try {
            if (data && typeof data === 'object') {
              data.name = workflowName
              data.extra_data = data.extra_data || {}
              data.extra_data.workflow_name = workflowName
            }

            // 冷启动时扩展仍在注册：loadGraphData 遇到未注册的自定义节点
            // 可能抛错，也可能被 LiteGraph 静默丢弃（节点数不足）——画布
            // 停在默认工作流。两种情况都重试几次兜底，每次 clean 画布，
            // 保证重试不残留上次半加载的节点。
            let lastLoadError = null
            for (let attempt = 0; attempt < 4; attempt++) {
              try {
                await app.loadGraphData(data, true, true)
                // 静默丢弃检测：工作流本应有节点但画布为空 → 视为失败重试
                if (data?.nodes?.length && !app.graph?._nodes?.length) {
                  throw new Error('workflow loaded but no nodes on canvas')
                }
                lastLoadError = null
                break
              } catch (err) {
                lastLoadError = err
                console.warn(
                  `[ArtifyInject] loadGraphData attempt ${attempt + 1} failed:`,
                  err?.message ?? err,
                )
                await new Promise((r) => setTimeout(r, 3000))
              }
            }
            // 重试耗尽仍失败：不抛错，继续走回传，保证 A UI 的
            // loadGraphData Promise 不会永久挂起（模态框卡 loading）
            if (lastLoadError) {
              console.warn(
                '[ArtifyInject] loadGraphData failed after retries, canvas may be incomplete:',
                lastLoadError?.message ?? lastLoadError,
              )
            }
            colorizeLinks()
            colorizeCanvas()

            // Force various name properties
            if (app.graph) app.graph.name = workflowName
            app.last_loaded_file = workflowName
            if (
              app.ui &&
              app.ui.workflowManager &&
              app.ui.workflowManager.activeWorkflow &&
              (artify_playground || isIframe)
            ) {
              const active = app.ui.workflowManager.activeWorkflow
              active.name = workflowName
              if (typeof active.rename === 'function') active.rename(workflowName)
              if (typeof app.ui.workflowManager.refresh === 'function')
                app.ui.workflowManager.refresh()
            }
          } finally {
            isArtifyLoading = false
          }

          // Stronger persistence: try to set the name multiple times as UI components might overwrite it during init
          let namingAttempts = 0
          const namingInterval = setInterval(() => {
            namingAttempts++
            const active =
              app.ui && app.ui.workflowManager ? app.ui.workflowManager.activeWorkflow : null
            if (active) {
              active.name = workflowName
              if (typeof active.rename === 'function') active.rename(workflowName)
            }
            const manager = app.ui && app.ui.workflowManager ? app.ui.workflowManager : null
            if (manager && manager.workflows) {
              // Find our workflow by name or fallback to the first one
              const target =
                manager.workflows.find(
                  (w) => w.name === workflowName || w.displayName === workflowName,
                ) || manager.workflows[0]
              if (target) {
                // Force rename
                target.name = workflowName
                if (target.displayName !== undefined) target.displayName = workflowName
                if (typeof target.rename === 'function') target.rename(workflowName)

                // Force switch if not active
                if (manager.activeWorkflow && manager.activeWorkflow.id !== target.id) {
                  console.log('[ArtifyInject] Switching back to target workflow:', workflowName)
                  try {
                    manager.switchToWorkflow(target.id)
                  } catch (e) {
                    /* ignore */
                  }
                }

                // Close all others
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
            if (app.graph) app.graph.name = workflowName
            if (namingAttempts >= 10) clearInterval(namingInterval)
          }, 500)

          setTimeout(() => {
            const node =
              data.nodes && data.nodes[0] ? app.graph.getNodeById(data.nodes[0].id) : null
            if (node) {
              app.canvas.centerOnNode(node)
            }
            eventBus.send(
              stringify({
                eventType: 'loadGraphData',
              }),
            )
          })
        }
        if (eventType === 'updatePrompt') {
          // graphToPrompt 在 v0.29 对坏输入引用（悬空链接/flatten 后
          // slot 越界）会抛 SlotIndexError —— 不 catch 的话回传永远
          // 不发，A UI 的保存 Promise 永久挂起（"无法保存"）。先清理
          // 悬空链接重试一次，仍失败也回传空结果，保证保存链路不挂。
          let res
          try {
            res = await app.graphToPrompt()
          } catch (err) {
            console.warn('[ArtifyInject] graphToPrompt failed:', err?.message ?? err)
            try {
              const g = app.graph
              for (const id of Object.keys(g.links || {})) {
                const l = g.links[id]
                const t = l && g.getNodeById(l.target_id)
                if (!t || !t.inputs || l.target_slot >= t.inputs.length) {
                  console.warn('[ArtifyInject] removing dangling link', id)
                  g.removeLink(id)
                }
              }
              res = await app.graphToPrompt()
            } catch (err2) {
              console.warn('[ArtifyInject] graphToPrompt retry failed:', err2?.message ?? err2)
              res = { output: {}, workflow: {} }
            }
          }
          eventBus.send(
            stringify({
              eventType: 'updatePrompt',
              data: res,
            }),
          )
        }
      })
    }

    // Now notify parent that we're ready (eventBus.on is registered)
    if (onReady) {
      onReady()
    }
  }

  function getQueryParam(key) {
    const params = new URLSearchParams(window.location.search)
    return params.get(key)
  }

  async function getElectronConfig() {
    let config
    try {
      config = await window.electronAPI.ArtifyLab.getConfig()
    } catch (_e) {
      // Ignore errors
    }
    return config
  }

  async function apiRequest(endpoint, options = {}) {
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

  async function getConfig() {
    const response = await apiRequest(`/api/config`, {
      method: 'post',
    })
    if (response.ok) {
      return response.data
    }
  }

  async function loadWorkflow() {
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
        const active =
          app.ui && app.ui.workflowManager ? app.ui.workflowManager.activeWorkflow : null
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

  const ARTIFY_CARD_TYPE = 'ArtifyDisplayCard'
  /** 与工作台 A UI 的 iframe 通信（内容窗口引用在 sidebar tab 注册时捕获） */
  let artifyEmbedWindow = null
  /** 已加载的 Image 对象缓存（filename 键），避免重复解码 */
  const cardImageCache = new Map()

  /** /view URL：与后端 WorkbenchOutputFile{filename,subfolder,type} 约定一致。
   * ComfyUI 与本脚本同源（注入页即画布页），直接用相对路径拼 /view。
   * workbench 后端（server_origin）与 ComfyUI 是两个进程——产出文件在
   * ComfyUI 的 output 目录，由 ComfyUI 自己的 /view 直出，不走 A UI。 */
  function artifyViewUrl(f) {
    const p = new URLSearchParams({ filename: f.filename, type: f.type || 'output' })
    if (f.subfolder) p.set('subfolder', f.subfolder)
    return '/view?' + p.toString()
  }

  function getCardApp() {
    const app = window.app
    if (!app || !app.graph) return null
    return app
  }

  /**
   * 注册陈列卡片节点类型（幂等；等 LiteGraph 就绪后由 ensureArtifyCard 注册）。
   * 绘制逻辑对齐官方 IMAGE_PREVIEW widget：drawImage 平铺 + low_quality 简化。
   */
  function registerArtifyCardNode(LiteGraph) {
    if (!LiteGraph || LiteGraph.registered_node_types[ARTIFY_CARD_TYPE]) return
    // 新版 litegraph（fork 内嵌 ComfyUI_frontend）在 createNode 里调
    // node.computeSize() 等基类方法——节点类必须继承 LGraphNode，
    // 裸 function 构造器会直接 TypeError。
    const LGBase = window.LGraphNode || LiteGraph.LGraphNode
    if (!LGBase) {
      console.warn('[ArtifyInject] LGraphNode not found, skip card node registration')
      return
    }
    class ArtifyDisplayCard extends LGBase {
      constructor(title) {
        super(title)
        this.serialize_widgets = false
      }
    }
    ArtifyDisplayCard.title = 'Artify 卡片'
    ArtifyDisplayCard.desc = 'AI 工作台产物陈列（不参与执行）'
    ArtifyDisplayCard.title_color = '#7c5cff'
    ArtifyDisplayCard.prototype.onConfigure = function () {
      // 从 workflow JSON 恢复后重建 imgs（序列化只存引用不存 Image 对象）
      this.size = this.size || [256, 320]
    }

    LiteGraph.registerNodeType(ARTIFY_CARD_TYPE, ArtifyDisplayCard)
    const Proto = ArtifyDisplayCard.prototype
    Proto.isVirtualNode = true

    Proto.onAdded = function () {
      this.mode = 2 // LGraphEventMode.NEVER
      this.setDirtyCanvas(true, true)
    }

    /** files: [{filename,subfolder,type}]；逐张加载解码后进 imgs */
    Proto.setFiles = function (files) {
      this.properties = this.properties || {}
      this.properties.files = files
      this.imgs = []
      this.size = this.size || [256, 320]
      const app = getCardApp()
      for (const f of files) {
        const img = new Image()
        img.onload = () => {
          if (!this.imgs) this.imgs = []
          this.imgs.push(img)
          this.setDirtyCanvas(true, true)
          this.onResize && this.onResize(this.size)
        }
        img.onerror = () => {
          console.warn('[ArtifyInject] card image failed:', f.filename)
        }
        img.src = artifyViewUrl(f)
      }
      this.setDirtyCanvas(true, true)
    }

    // 首帧比例适配：第一张图到位后按图像宽高比调一次高度（宽度固定）
    Proto.onResize = function () {
      if (this.imgs && this.imgs[0] && this.imgs[0].naturalWidth) {
        const img = this.imgs[0]
        const ratio = img.naturalHeight / img.naturalWidth
        const h = Math.max(160, Math.min(560, 256 * ratio + 64))
        if (Math.abs(this.size[1] - h) > 8) {
          this.size[1] = h
          this.setDirtyCanvas(true, true)
        }
      }
    }

    Proto.onDrawBackground = function (ctx) {
      // 图片区域裁剪：标题栏以下（litegraph 在 onDrawBackground 时已平移到内容区）
      if (!this.imgs || !this.imgs.length) {
        ctx.fillStyle = 'rgba(255,255,255,0.06)'
        ctx.fillRect(0, 0, this.size[0], this.size[1])
        ctx.fillStyle = 'rgba(255,255,255,0.4)'
        ctx.font = '12px sans-serif'
        ctx.fillText('…', 8, 18)
        return
      }
      const cols = this.imgs.length > 1 ? 2 : 1
      const rows = Math.ceil(this.imgs.length / cols)
      const gap = 4
      const cw = (this.size[0] - gap * (cols + 1)) / cols
      const ch = (this.size[1] - gap * (rows + 1)) / rows
      for (let i = 0; i < this.imgs.length && i < 8; i++) {
        const img = this.imgs[i]
        const x = gap + (i % cols) * (cw + gap)
        const y = gap + Math.floor(i / cols) * (ch + gap)
        // cover 裁剪绘制（等比放大取中）
        const iw = img.naturalWidth || img.width
        const ih = img.naturalHeight || img.height
        if (!iw || !ih) continue
        const s = Math.max(cw / iw, ch / ih)
        const sw = cw / s
        const sh = ch / s
        ctx.drawImage(img, (iw - sw) / 2, (ih - sh) / 2, sw, sh, x, y, cw, ch)
      }
    }

    /** 双击 → 回填给工作台侧边栏 */
    Proto.onDblClick = function () {
      sendCardsToEmbed([this])
    }

    /** 右键菜单：回填 / 从画布移除（走官方 getNodeMenuOptions 注入） */
    const origGetNodeMenuOptions = window.LiteGraph && window.LiteGraph.LGraphCanvas
      ? window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions
      : null
    if (origGetNodeMenuOptions) {
      window.LiteGraph.LGraphCanvas.prototype.getNodeMenuOptions = function (node) {
        const options = origGetNodeMenuOptions.call(this, node)
        if (node && node.type === ARTIFY_CARD_TYPE) {
          const cardOptions = [
            {
              content: '回填到工作台',
              callback: () => sendCardsToEmbed([node]),
            },
            {
              content: '从画布移除',
              callback: () => {
                const graph = node.graph || (getCardApp() && getCardApp().graph)
                if (graph) graph.remove(node)
              },
            },
            null, // 分隔线
          ]
          // 官方菜单结构：[null, ...options, null]；把卡片项插在最前
          if (options && options.length) {
            options.splice(options.length - 1, 0, ...cardOptions)
          } else {
            return [null, ...cardOptions, null]
          }
        }
        return options
      }
    }
  }

  /** 把选中卡片的文件引用发给工作台 embed iframe（回填） */
  function sendCardsToEmbed(nodes) {
    if (!artifyEmbedWindow) {
      console.warn('[ArtifyInject] no embed window; card attach skipped')
      return
    }
    const files = []
    for (const n of nodes) {
      for (const f of n.properties?.files || []) files.push(f)
    }
    if (!files.length) return
    artifyEmbedWindow.postMessage(
      JSON.stringify({ type: 'artify:card-attach', files }),
      '*'
    )
  }

  /**
   * 产物上墙：把 files 铺成卡片（瀑布排布在当前视口右侧空白），完成后 fit。
   * nodesPerCol 对齐官方 positionNodes 的列式堆叠算法（nodeHeight≈256+64）。
   */
  function spawnDisplayCards(files) {
    const app = getCardApp()
    if (!app) {
      console.warn('[ArtifyInject] app not ready; cards dropped')
      return
    }
    const LiteGraph = window.LiteGraph
    if (!LiteGraph || !LiteGraph.registered_node_types[ARTIFY_CARD_TYPE]) {
      console.warn('[ArtifyInject] card node type not registered yet')
      return
    }
    // 每张产物一张卡片；单卡最多 8 图网格
    const created = []
    for (let i = 0; i < files.length; i += 8) {
      const chunk = files.slice(i, i + 8)
      const node = LiteGraph.createNode(ARTIFY_CARD_TYPE, 'Artify 卡片', {})
      if (!node) continue
      node.properties = { files: chunk }
      app.graph.add(node)
      node.setFiles(chunk)
      created.push(node)
    }
    if (!created.length) return

    // 排布：从当前视口右缘往左排（新卡片落在视野内），列内向下堆叠，
    // 超出视口高度换列——与 packages/frontend/src/utils/canvasCards.js
    // layoutDisplayCards() 同一算法（该文件有单测锁定几何）。
    const dpi = Math.max(window.devicePixelRatio || 1, 1)
    const area = app.canvas.ds.visible_area
    const stepX = 256 + 24
    const startX = area[0] + area[2] / dpi - created.length * stepX - 24 * 2
    const top = area[1] + 24
    const bottomLimit = area[1] + area[3] / dpi - 340
    let x = startX
    let y = top
    for (const node of created) {
      node.pos = [x, y]
      node.size = [256, 340]
      y += 340 + 24
      if (y > bottomLimit) {
        y = top
        x += stepX
      }
    }
    // 视口适配到新卡片——fork 内嵌 litegraph 的 fitToBounds 只吃平面
    // bounds [x,y,w,h]（嵌套数组会算出 NaN 把整个视口搞坏），多卡片手动并集
    {
      let bx = Infinity
      let by = Infinity
      let br = -Infinity
      let bb = -Infinity
      for (const n of created) {
        const x = +n.pos[0]
        const y = +n.pos[1]
        const w = +n.size[0]
        const h = +n.size[1]
        if ([x, y, w, h].some((v) => !Number.isFinite(v))) continue
        bx = Math.min(bx, x)
        by = Math.min(by, y)
        br = Math.max(br, x + w)
        bb = Math.max(bb, y + h)
      }
      if (Number.isFinite(bx)) {
        try {
          app.canvas.ds.fitToBounds([bx, by, br - bx, bb - by])
        } catch (_e) {
          /* fitToBounds 签名随版本漂移，失败则保持当前视口 */
        }
      }
    }
  }

  /** A UI → ComfyUI 消息：产物上墙 / 画布操作（唯一入口，iframe postMessage 进来） */
  async function handleArtifyMessage(data) {
    if (data.type === 'artify:display-card' && Array.isArray(data.files) && data.files.length) {
      spawnDisplayCards(data.files)
    }
    if (data.type === 'artify:get-canvas-state') {
      // 工作台 iframe 首次挂载/重连时主动拉一份当前画布摘要
      pushCanvasDigest()
    }
    if (data.type === 'artify:canvas-ops') {
      // 写通道：工作台 diff 确认后下发。回执走同一 iframe postMessage。
      const ackType = 'artify:canvas-ops-result'
      try {
        // 结构级写前落 express checkpoint（跨会话回滚）；参数级只动 widget 不落
        const hasStructural = Array.isArray(data.ops) && data.ops.some((o) => o && o.type !== 'setWidget')
        let checkpointId = null
        if (hasStructural) checkpointId = await saveExpressCheckpoint(String(data.reason || ''))
        const r = await applyCanvasOps(data.ops)
        postToEmbed({ type: ackType, requestId: data.requestId, checkpointId, ...r })
      } catch (e) {
        postToEmbed({ type: ackType, requestId: data.requestId, ok: false, error: String(e).slice(0, 120) })
      }
    }
  }

  /** 向工作台 iframe 回传（iframe 未打开时静默丢弃——写通道只在 embed 打开时可用） */
  function postToEmbed(msg) {
    if (!artifyEmbedWindow) return
    try {
      artifyEmbedWindow.postMessage(JSON.stringify(msg), '*')
    } catch (_e) {
      /* iframe 销毁 */
    }
  }

  // ==========================================================================
  // 画布感知桥（M1）：订阅官方 frontend 事件，把画布摘要实时推给工作台 iframe。
  //
  // 设计（docs/research/comfy-copilot-sidebar.md v2）：
  //  - 只订阅官方 api 事件（execution_error/execution_success/executing/progress）
  //    + graph 变更轮询兜底（graphChanged 事件在部分版本不触发）
  //  - 推送的是「摘要投影」（digest），不是全量 serialize——大图直喂浪费
  //  - 目标：工作台 iframe（artifyEmbedWindow），未就绪时跳过（express 缓存兜底）
  //  - 摘要同时 POST /api/canvas/snapshot 给 express 缓存，供服务端 PLAN 用
  // ==========================================================================

  const CANVAS_BRIDGE = {
    digestSeq: 0, // 递增序号：工作台/express 据此判断「变了」
    lastDigestJson: '', // 去重：摘要无变化不重发
    pollTimer: null,
    pollDelay: 2000,
    lastQueueRemaining: 0, // status 广播的 queue_remaining
    lastDigestQueueActive: false, // 最近一次摘要里队列是否有活
    apiBound: false
  }

  /** 当前工作流名（官方 frontend 顶栏标题；取不到回退 'Unsaved Workflow'） */
  function getWorkflowName() {
    try {
      const w = (window.app || {}).extensionManager?.workflow?.activeWorkflow
      if (w && w.name) return String(w.name)
    } catch (_e) {
      /* 形状随版本漂移，忽略 */
    }
    return 'Unsaved Workflow'
  }

  /**
   * 画布摘要投影：节点计数 + 模型/关键参数 + 队列 + 执行态。
   * 只取稳定字段（widgetsValues/object_info 惯例名），取不到就留空——
   * 投影永远「有就带上」，不做版本分叉。
   */
  async function buildCanvasDigest() {
    const app = getComfyUIApp().app || window.app
    const g = app && app.graph
    const nodes = g && g._nodes ? g._nodes : []
    const models = []
    const keyParams = {}
    for (const n of nodes) {
      const type = String(n.type || '')
      const wv = Array.isArray(n.widgets_values) ? n.widgets_values : []
      if (/CheckpointLoader|UNETLoader|Checkpoint.*Loader/i.test(type) && wv[0]) {
        models.push(String(wv[0]))
      }
      if (/LoraLoader/i.test(type) && wv[0]) {
        models.push('lora:' + String(wv[0]))
      }
      if (type === 'KSampler' || type === 'KSamplerAdvanced') {
        // widgets_values 顺序：seed/steps/cfg/sampler/...（官方惯例）
        if (Number.isFinite(wv[0])) keyParams.seed = wv[0]
        if (Number.isFinite(wv[1])) keyParams.steps = wv[1]
        if (Number.isFinite(wv[2])) keyParams.cfg = wv[2]
        if (typeof wv[3] === 'string') keyParams.sampler = wv[3]
      }
      if (type === 'CLIPTextEncode' && typeof wv[0] === 'string' && wv[0].trim()) {
        const arr = keyParams.prompts || (keyParams.prompts = [])
        if (arr.length < 4) arr.push(wv[0].slice(0, 80))
      }
    }
    const queue = { running: 0, pending: 0 }
    try {
      // 同源 REST 一手数据：extensionManager.queue 是 pinia store（无 .get）
      const qr = await fetch('/queue', { cache: 'no-store' })
      if (qr.ok) {
        const q = await qr.json()
        queue.running = (q.queue_running || []).length
        queue.pending = (q.queue_pending || []).length
      }
    } catch (_e) {
      /* 队列获取失败按 0 处理 */
    }
    return {
      seq: ++CANVAS_BRIDGE.digestSeq,
      workflowName: getWorkflowName(),
      nodeCount: nodes.length,
      models,
      keyParams,
      queue,
      ts: Date.now()
    }
  }

  // ==========================================================================
  // 画布写通道（M2）：工作台 diff 确认后下发 ops，桥在本页执行。
  //
  // 双轨制（docs/research/comfy-copilot-sidebar.md v2 §4）：
  //  - setWidget：widget.value= 原地改，不重载画布（保视口/选中态）
  //  - addNode/removeNode/relink/loadWorkflow：结构级，loadWorkflow 走
  //    app.loadGraphData 整图替换；写前 checkpoint（capture 进官方 undo 栈）
  // ==========================================================================

  /** 官方 changeTracker（deep 挂在 activeWorkflow 上，随版本漂移需逐层防御） */
  function getChangeTracker() {
    try {
      const wf = window.app?.extensionManager?.workflow
      const ct = wf?.activeWorkflow?.changeTracker
      return ct && typeof ct.captureCanvasState === 'function' ? ct : null
    } catch (_e) {
      return null
    }
  }

  /** 按 id 找节点（数字/字符串 id 都容忍） */
  function findNodeById(g, id) {
    const num = Number(id)
    if (g._nodes_by_id && g._nodes_by_id[num] != null) return g._nodes_by_id[num]
    if (g._nodes) return g._nodes.find((n) => String(n.id) === String(id)) || null
    return null
  }

  /** 单条 op 执行；返回 {ok, error?}。所有访问都防御新前端形状漂移 */
  async function applyOneOp(g, op) {
    if (!op || typeof op.type !== 'string') return { ok: false, error: 'op.type required' }
    switch (op.type) {
      case 'setWidget': {
        const node = findNodeById(g, op.nodeId)
        if (!node) return { ok: false, error: `node ${op.nodeId} not found` }
        const name = String(op.widget || '')
        const w = (node.widgets || []).find((x) => x && x.name === name)
        if (!w) {
          return { ok: false, error: `widget ${name} not found on node ${op.nodeId}` }
        }
        const before = w.value
        w.value = op.value
        // 触发官方回调（seed/随机控件等依赖 callback 同步内部状态）
        if (typeof w.callback === 'function') {
          try {
            w.callback(w.value)
          } catch (_e) {
            /* callback 签名漂移容忍 */
          }
        }
        if (typeof node.onWidgetChanged === 'function') {
          try {
            node.onWidgetChanged(w.value)
          } catch (_e) {
            /* 容忍 */
          }
        }
        return { ok: true, nodeId: node.id, widget: name, before, after: w.value }
      }
      case 'addNode': {
        const type = String(op.nodeType || '')
        const created = window.LiteGraph.createNode(type)
        if (!created) return { ok: false, error: `node type ${type} not registered` }
        if (Array.isArray(op.widgetsValues)) created.widgets_values = op.widgetsValues
        created.pos = Array.isArray(op.pos) ? op.pos : [100 + Math.random() * 200, 100 + Math.random() * 200]
        g.add(created)
        return { ok: true, nodeId: created.id, type }
      }
      case 'removeNode': {
        const node = findNodeById(g, op.nodeId)
        if (!node) return { ok: false, error: `node ${op.nodeId} not found` }
        g.remove(node)
        return { ok: true, nodeId: op.nodeId }
      }
      case 'relink': {
        const from = findNodeById(g, op.fromNodeId)
        const to = findNodeById(g, op.toNodeId)
        if (!from || !to) return { ok: false, error: 'relink endpoint node not found' }
        const outIdx = Number(op.fromSlot) || 0
        const inIdx = Number(op.toSlot) || 0
        if (!from.outputs || !from.outputs[outIdx]) return { ok: false, error: 'from slot missing' }
        if (!to.inputs || !to.inputs[inIdx]) return { ok: false, error: 'to slot missing' }
        const out = from.outputs[outIdx]
        from.connect(outIdx, to, inIdx)
        return { ok: true, from: from.id, to: to.id, slot: out.name }
      }
      case 'loadWorkflow': {
        const wf = op.workflow
        if (!wf || typeof wf !== 'object' || !wf.nodes) return { ok: false, error: 'workflow.nodes required' }
        await window.app.loadGraphData(wf)
        return { ok: true }
      }
      default:
        return { ok: false, error: `unknown op type ${op.type}` }
    }
  }

  /**
   * 应用 ops 序列：结构级 op 前自动 checkpoint（进官方 undo 栈）；
   * loadWorkflow 单独走（整图替换后其余 ops 无意义）。
   */
  async function applyCanvasOps(ops) {
    const app = getComfyUIApp().app || window.app
    const g = app && app.graph
    if (!g) return { ok: false, error: 'graph not ready' }
    if (!Array.isArray(ops) || !ops.length) return { ok: false, error: 'ops must be non-empty' }
    const results = []
    let applied = 0
    let needCheckpoint = false
    for (const op of ops) {
      if (op && op.type !== 'setWidget') needCheckpoint = true
    }
    if (needCheckpoint) {
      const ct = getChangeTracker()
      if (ct) {
        try {
          ct.captureCanvasState()
        } catch (_e) {
          /* 撤销栈不可用时继续（还有 express checkpoint 兜底） */
        }
      }
    }
    for (const op of ops) {
      // loadWorkflow 是终态替换：之后画布已整体变化，剩余 ops 终止
      if (applied > 0 && op.type === 'loadWorkflow') break
      let r
      try {
        r = await applyOneOp(g, op)
      } catch (e) {
        r = { ok: false, error: String(e).slice(0, 120) }
      }
      results.push(r)
      if (r.ok) applied++
    }
    // 变更生效后立即推新摘要（工作台 diff 确认回执）
    pushCanvasDigest(true)
    return { ok: applied > 0, applied, results }
  }

  /** express checkpoint：写前把当前双格式快照落到服务端（跨会话回滚用） */
  async function saveExpressCheckpoint(reason) {
    const app = getComfyUIApp().app || window.app
    const api = window.__ARTIFY_LAB_API__
    if (!app || !api || typeof app.graphToPrompt !== 'function') return null
    try {
      const p = await app.graphToPrompt()
      const res = await fetch(`${api}/api/canvas/checkpoint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          reason: String(reason || ''),
          workflow: p.workflow ?? p,
          prompt: p.output ?? null
        })
      })
      const j = await res.json()
      return j && j.data ? j.data.checkpointId : null
    } catch (_e) {
      return null
    }
  }

  /** 摘要变化才推送（iframe postMessage + express 快照缓存双路） */
  let digestPushing = false
  async function pushCanvasDigest(force) {
    // 并发跳过：进行中又来一次时直接放弃，等下一个 2s 周期兜底，不排队补发
    if (digestPushing) return
    digestPushing = true
    try {
      const digest = await buildCanvasDigest()
      const json = JSON.stringify(digest)
      CANVAS_BRIDGE.lastDigestQueueActive = digest.queue.running + digest.queue.pending > 0
      if (!force && json === CANVAS_BRIDGE.lastDigestJson) return
      CANVAS_BRIDGE.lastDigestJson = json
      // 1) 工作台 iframe（存在才发；embed 未打开时不白算）
      if (artifyEmbedWindow) {
        try {
          artifyEmbedWindow.postMessage(JSON.stringify({ type: 'artify:canvas-state', state: digest }), '*')
        } catch (_e) {
          /* iframe 未就绪/已销毁，忽略 */
        }
      }
      // 2) express 缓存（服务端 PLAN 的画布上下文来源；失败静默）
      const api = window.__ARTIFY_LAB_API__
      if (api) {
        try {
          void fetch(`${api}/api/canvas/snapshot`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: json
          }).catch(() => {})
        } catch (_e) {
          /* fetch 不可用（老 webview） */
        }
      }
    } catch (e) {
      console.warn('[ArtifyInject] buildCanvasDigest failed:', e)
    } finally {
      digestPushing = false
    }
  }

  /** 官方 api 事件订阅（→ 摘要重算） */
  function bindComfyApiEvents() {
    const api = (window.app || {}).api
    if (!api || typeof api.addEventListener !== 'function' || CANVAS_BRIDGE.apiBound) return
    CANVAS_BRIDGE.apiBound = true
    const onExecEvent = () => pushCanvasDigest()
    // 执行生命周期：running→idle 的流转都会改变 queue 摘要。
    // 注意：只对本页面提交的 prompt 有效（execution 事件按 clientId 定向）；
    // express 服务端提交的任务收不到这些事件——靠 status + 密集轮询兜底。
    for (const ev of ['execution_start', 'executing', 'execution_error', 'execution_success', 'execution_cached', 'progress']) {
      try {
        api.addEventListener(ev, onExecEvent)
      } catch (_e) {
        /* 个别事件名随版本漂移，跳过 */
      }
    }
    // status 事件是广播的（队列长度变化即触发），且 payload 自带
    // queue_remaining——这是外部提交（服务端编排）唯一的实时信号
    try {
      api.addEventListener('status', (ev) => {
        const detail = ev && ev.detail
        const remaining = detail && (detail.queue_remaining ?? detail.exec_info?.queue_remaining)
        if (typeof remaining === 'number') {
          CANVAS_BRIDGE.lastQueueRemaining = remaining
        }
        pushCanvasDigest()
      })
    } catch (_e) {
      /* status 事件不可用时纯靠轮询 */
    }
    // 300ms 节流：progress 事件高频，摘要重算走节流去重即可
    let pending = false
    api.addEventListener('progress', () => {
      if (pending) return
      pending = true
      setTimeout(() => {
        pending = false
        pushCanvasDigest()
      }, 300)
    })
  }

  /**
   * 画布变更兜底轮询 + 执行窗口密集采样。
   * 官方 execution 事件只回给提交 clientId 的页面（express 编排的任务
   * 收不到），status 广播 + 轮询是外部任务的唯一感知来源：
   *  - 空闲：2s 周期
   *  - 队列有活（lastQueueRemaining>0 或最近读到 running/pending>0）：
   *    400ms 密集采样，保证跑完 400ms 内感知到
   */
  function startCanvasPoll() {
    if (CANVAS_BRIDGE.pollTimer) return
    CANVAS_BRIDGE.pollTimer = setInterval(() => {
      const active =
        (CANVAS_BRIDGE.lastQueueRemaining || 0) > 0 ||
        CANVAS_BRIDGE.lastDigestQueueActive === true
      pushCanvasDigest()
      // 动态周期：active 时切到 400ms，空闲回 2s（重设 interval）
      const wantDelay = active ? 400 : 2000
      if (wantDelay !== CANVAS_BRIDGE.pollDelay) {
        clearInterval(CANVAS_BRIDGE.pollTimer)
        CANVAS_BRIDGE.pollDelay = wantDelay
        CANVAS_BRIDGE.pollTimer = null
        startCanvasPoll()
      }
    }, CANVAS_BRIDGE.pollDelay || 2000)
  }

  /**
   * 侧栏宽度治理（「拉到最大后收不回来」修复）：
   * 官方侧栏是 PrimeVue Splitter（.side-bar-panel / .p-splitter-gutter），
   * 拉满后 gutter 贴住窗口右缘（命中区只剩 ~4px 且紧邻窗口 resize 热区），
   * 真实鼠标极难抓住 → 表现为「收不回来」。治理三件事：
   *  1) 钳制最大宽度：flex-basis 上限 45%（保留画布可用区；官方默认 ~20%，正常拖拽不受影响）
   *  2) 加宽 gutter 命中区（4px → 视觉不变、热区 ~14px），贴边也好抓
   *  3) 双击 gutter 一键复位 20%（卡住时的逃生门）
   * 幂等： observers/监听只挂一次；样式注入用专用 class 标记。
   */
  function installSidebarWidthGovernor() {
    const MAX_PCT = 45
    const RESET_PCT = 20
    const GUTTER_HOT = 14
    try {
      if (document.getElementById('artify-sidebar-governor-style')) return
      const style = document.createElement('style')
      style.id = 'artify-sidebar-governor-style'
      style.textContent = `
        .p-splitter-horizontal > .p-splitter-gutter { position: relative; }
        .p-splitter-horizontal > .p-splitter-gutter::before {
          content: ''; position: absolute; top: 0; bottom: 0; left: -${Math.floor(GUTTER_HOT / 2)}px; right: -${Math.floor(GUTTER_HOT / 2)}px;
        }
        .p-splitter-horizontal > .p-splitter-gutter { cursor: col-resize; }
      `
      document.head.appendChild(style)
    } catch (_e) { /* 样式失败不影响主流程 */ }

    let patching = false
    const clampPanel = () => {
      if (patching) return
      const panel = document.querySelector('.p-splitterpanel.side-bar-panel')
      if (!panel) return
      const m = /calc\(([\d.]+)%/.exec(panel.style.flexBasis || '')
      if (m && parseFloat(m[1]) > MAX_PCT) {
        patching = true
        panel.style.flexBasis = `calc(${MAX_PCT}% - 4px)`
        // 同步把另一半面板补回剩余空间，避免出现空隙/塌陷
        const other = panel.parentElement
          ? Array.from(panel.parentElement.children).find(
              (el) => el !== panel && el.classList && el.classList.contains('p-splitterpanel'),
            )
          : null
        if (other) other.style.flexBasis = `calc(${100 - MAX_PCT}% - 4px)`
        patching = false
      }
    }

    // MutationObserver 盯 flex-basis 变化（拖拽中实时钳制）
    const panel = document.querySelector('.p-splitterpanel.side-bar-panel')
    if (panel && !window.__artifySidebarGovObserver) {
      window.__artifySidebarGovObserver = new MutationObserver(clampPanel)
      window.__artifySidebarGovObserver.observe(panel, { attributes: true, attributeFilter: ['style'] })
    }

    // 双击 gutter 复位（逃生门）；捕获层挂 document，幂等
    if (!window.__artifySidebarGovDbl) {
      window.__artifySidebarGovDbl = true
      document.addEventListener(
        'dblclick',
        (e) => {
          const g = e.target && e.target.closest && e.target.closest('.p-splitter-horizontal > .p-splitter-gutter')
          if (!g) return
          const p = document.querySelector('.p-splitterpanel.side-bar-panel')
          if (!p) return
          p.style.flexBasis = `calc(${RESET_PCT}% - 4px)`
          const other = p.parentElement
            ? Array.from(p.parentElement.children).find(
                (el) => el !== p && el.classList && el.classList.contains('p-splitterpanel'),
              )
            : null
          if (other) other.style.flexBasis = `calc(${100 - RESET_PCT}% - 4px)`
          e.preventDefault()
          e.stopPropagation()
        },
        true,
      )
    }
  }

  /**
   * 注册 A UI 工作台 sidebar tab（iframe 嵌工作台 /workbench?embed=1）。
   * 时序：registerSidebarTab 需 extensionManager 就绪（app.setup 后）；
   * 采用轮询重试直到注册成功（extensionManager 未就绪时抛错→退避重试）。
   */
  function ensureArtifySidebarTab() {
    const app = window.app
    if (!app || !app.extensionManager || typeof app.extensionManager.registerSidebarTab !== 'function') {
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
      const existing = app.extensionManager.getSidebarTabs().some((t) => t && t.id === 'artify-workbench')
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
        if (event.source) artifyEmbedWindow = event.source
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
          iframe.src = base
            ? `${base}/workbench?embed=1&server_origin=${encodeURIComponent(api)}`
            : `/workbench?embed=1`
          // 直接捕获回填目标：不依赖 iframe 先说话（工作台 embed 页不会
          // 主动 postMessage，双击/右键回填时 artifyEmbedWindow 必须已就绪）
          artifyEmbedWindow = iframe.contentWindow
          container.appendChild(iframe)
          // iframe 就绪后立即推一份当前画布摘要（首屏感知）
          iframe.addEventListener('load', () => {
            artifyEmbedWindow = iframe.contentWindow
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
  // sidebar tab 会嵌套出第二个工作台，必须跳过。
  if (!isIframe) {
    ensureArtifySidebarTab()
  }
})()
