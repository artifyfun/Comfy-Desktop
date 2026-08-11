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
            setButton()
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

  function setButton() {
    const style = document.createElement('style')
    style.innerHTML = `
      #floating-btn {
          position: fixed;
          bottom: 205px;
          right: 10px;
          width: 40px;
          height: 40px;
          border-radius: 50%;
          background: linear-gradient(135deg, #6a11cb 0%, #2575fc 100%);
          color: white;
          border: none;
          box-shadow: 0 6px 20px rgba(0,0,0,0.2);
          cursor: pointer;
          font-size: 18px;
          display: flex;
          align-items: center;
          justify-content: center;
          transition: all 0.3s ease;
          z-index: 10000;
      }

      #floating-btn:hover {
          transform: scale(1.1) rotate(15deg);
          box-shadow: 0 8px 25px rgba(0,0,0,0.3);
      }

      #floating-btn:active {
          transform: scale(0.95);
      }

      #floating-btn::after {
          content: "🎨";
          font-size: 18px;
      }
  `
    document.head.appendChild(style)
    const floatingBtn = document.createElement('button')
    floatingBtn.id = 'floating-btn'
    floatingBtn.title = 'ArtifyLab'
    floatingBtn.ariaLabel = 'ArtifyLab'
    document.body.appendChild(floatingBtn)

    floatingBtn.addEventListener('click', () => {
      window.electronAPI.ArtifyLab.loadArtifyLab()
    })
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
    } finally {
      isArtifyLoading = false
    }
  }
})()
