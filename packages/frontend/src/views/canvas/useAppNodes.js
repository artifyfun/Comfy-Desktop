/**
 * App 节点域（composable）——canvas/index.vue 深拆（第五批）。
 *
 * P1/P2 画布上的 A 应用实例：实例卡（Konva 配置组）、运行链路（提交→
 * 轮询→产物落布 placeNodeArtifacts）、参数面板（appPanel）、App 选择器。
 * P3 AI 侧边栏节点指令（wb_canvas_ops → pendingAgentOps 人审确认卡 →
 * applyOneAgentOp/confirmAgentOps 执行）。外部依赖 16 个经 deps 注入。
 */
import { reactive, ref, computed, watch, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import {
  makeAppNode,
  collectUpstream,
  buildNodeOverrides,
  paramFieldsFromTemplate,
  artifactLayout,
  imageObjectRef,
  submitCanvasExecute,
  pollCanvasExecuteStatus,
} from './appNode'
import { lodTextVisible, serializeDoc, parseDoc } from './engine'
import { saveAiSnapshot, listAiSnapshots, deleteAiSnapshot, getAiSnapshot } from './aiSnapshots'

export function useAppNodes(deps) {
  const {
    objects,
    selection,
    viewport,
    links,
    groups,
    size,
    saveSoon,
    beforeChange,
    message,
    ctxMenu,
    t,
    worldToScreen,
    clamp,
    appStore,
    emitPrompt,
    onOps,
    viewportCenterWorld,
    closeCtxMenu,
    setTool,
    refOf,
    withCull,
    isHighlightedOf,
    stopKonvaEvent,
    linkFromConnect,
    maybeRunGenFromNote,
  } = deps
  const router = useRouter()

  // —— App 节点（P1/P2：画布上的 A 应用实例，可随时运行） ——
  const appNodeObjects = computed(() => withCull((o) => o.type === 'app'))

  // app 详情缓存：appId → 完整 app（含 template；picker 拾取/详情接口回填）
  // cacheVer 是响应式触发器：Map.set 不触发 computed，靠版本号驱动面板刷新
  const appCache = new Map()
  const appCacheVer = ref(0)
  async function ensureAppDetail(appId) {
    if (appCache.has(appId)) return appCache.get(appId)
    try {
      const app = await appStore.getAppById(appId)
      if (app) {
        appCache.set(appId, app)
        appCacheVer.value++
      }
      return app || null
    } catch {
      return null
    }
  }

  const appPicker = reactive({ open: false, wx: 0, wy: 0 })
  function openAppPicker(wx, wy) {
    appPicker.wx = wx
    appPicker.wy = wy
    appPicker.open = true
  }
  function onAppPicked(app) {
    appPicker.open = false
    if (!app?.id) return
    const pendingLink = connectCreate.pickLink || null
    connectCreate.pickLink = null
    // picker 的 app 已带完整 template —— 立即入缓存（面板字段即时渲染）
    appCache.set(app.id, app)
    appCacheVer.value++
    beforeChange()
    const node = makeAppNode(app.id, app.name, appPicker.wx, appPicker.wy)
    objects.value.push(node)
    if (pendingLink) linkFromConnect(node.id, pendingLink.from, pendingLink.to)
    selection.value = [node.id]
    saveSoon()
    // 拾取即展开参数面板
    nextTick(() => openAppNodePanel(node.id))
    // S5a 编排流：note 生图 → 连线 + 自动运行（不展开面板避免遮挡）
    if (genFromNote.value) {
      appPanel.id = null
      maybeRunGenFromNote(node)
    }
  }

  /** 右键菜单位置开拾取器（点选后关闭菜单） */
  function openAppPickerAtCtx() {
    openAppPicker(ctxMenu.value?.wx ?? 0, ctxMenu.value?.wy ?? 0)
    closeCtxMenu()
  }

  // 展开面板状态：{ id } —— node/pos/fed 全部由 computed 派生（视口/节点变化自动跟随）
  const appPanel = reactive({ id: null })
  const appPanelNode = computed(() => objects.value.find((o) => o.id === appPanel.id) || null)
  // 兼容旧引用：模板里直接用 appPanel.node（computed 语义）
  Object.defineProperty(appPanel, 'node', {
    get: () => appPanelNode.value,
    enumerable: true,
  })
  const appPanelApp = computed(() => {
    appCacheVer.value // 依赖缓存版本（Map.set 本身不触发）
    return appPanelNode.value ? appCache.get(appPanelNode.value.appId) || null : null
  })
  const appPanelPos = computed(() => {
    const n = appPanelNode.value
    if (!n) return { x: 0, y: 0 }
    const tl = worldToScreen(viewport.value, n.x + n.width, n.y)
    return {
      x: clamp(tl.x + 12, 8, Math.max(8, size.w - 336)),
      y: clamp(tl.y, 8, Math.max(8, size.h - 120)),
    }
  })
  const appPanelFed = ref([])
  function openAppNodePanel(id) {
    const node = objects.value.find((o) => o.id === id)
    if (!node || node.type !== 'app') return
    appPanel.id = id
    // 异步补 app 详情 + 刷新喂养提示
    void ensureAppDetail(node.appId).then(refreshFed)
  }
  /** Konva 卡上 ⚙ 按钮（Konva 事件对象不兼容 Vue .prevent/.stop 修饰符，代理进 handler） */
  function openAppNodePanelFromKonva(id, kev) {
    stopKonvaEvent(kev)
    openAppNodePanel(id)
  }
  /** Konva 卡上 ▶ 按钮 */
  function runAppNodeFromKonva(id, kev) {
    stopKonvaEvent(kev)
    runAppNode(id)
  }
  function refreshFed() {
    const node = appPanelNode.value
    const app = appPanelApp.value
    if (!node || !app) {
      appPanelFed.value = []
      return
    }
    const up = collectUpstream(node.id, objects.value, links.value)
    const { fedFields } = buildNodeOverrides(node, paramFieldsFromTemplate(app), up)
    appPanelFed.value = fedFields
  }

  // 参数面板打开时：文档/视口/连线/app 缓存变化刷新喂养提示
  // （appCacheVer：Map.set 不触发响应，靠版本号驱动 detail 到达后的重算）
  watch(
    () => [
      appPanel.id,
      links.value.length,
      objects.value.length,
      Math.round(viewport.value.scale * 4),
      appCacheVer.value,
    ],
    () => {
      if (appPanel.id) refreshFed()
    },
  )

  /** 参数面板写回（AppNodeCard update-param 事件：子组件不改 prop，由宿主落） */
  function onPanelParamUpdate({ nodeId, key, value }) {
    const node = appPanelNode.value
    if (!node) return
    if (!node.params) node.params = {}
    if (!node.params[nodeId]) node.params[nodeId] = {}
    node.params[nodeId][key] = value
    saveSoon()
  }

  /** 画布拾取一张图喂给参数槽（pick-canvas 事件：选图片物件或直接手填） */
  function pickCanvasImageFor(field) {
    const imgs = objects.value.filter((o) => o.type === 'image')
    if (!imgs.length) {
      message.info(t('canvasAppNodeNoImages'))
      return
    }
    // 无 UI 树的轻量选择：按离节点最近的一张
    const node = appPanelNode.value
    let best = imgs[0]
    if (node) {
      let bestD = Infinity
      for (const img of imgs) {
        const d = (img.x - node.x) ** 2 + (img.y - node.y) ** 2
        if (d < bestD) {
          bestD = d
          best = img
        }
      }
    }
    const ref = imageObjectRef(best)
    if (!ref?.filename) {
      message.info(t('canvasAppNodeNoViewRef'))
      return
    }
    if (!appPanelNode.value.params) appPanelNode.value.params = {}
    if (!appPanelNode.value.params[field.nodeId]) appPanelNode.value.params[field.nodeId] = {}
    appPanelNode.value.params[field.nodeId][field.key] = ref.filename
    message.success(t('canvasAppNodeFed').replace('{f}', field.label).replace('{n}', ref.filename))
  }

  /** 弹窗打开完整应用（genHtml iframe 预览，复杂交互兜底） */
  async function openFullApp(node) {
    const app = await ensureAppDetail(node.appId)
    if (!app) {
      message.warning(t('canvasAppNodeAppMissing'))
      return
    }
    await appStore.updateConfig({ activeAppId: node.appId })
    router.push({ path: '/web' })
  }

  // —— P2 运行链路 ——
  const POLL_INTERVAL = 2500
  const nodePolls = new Map() // nodeId → interval id
  const serverOrigin = computed(() => appStore.config?.serverHost || window.location.origin)

  /** 运行一个 app 节点：参数聚合 → POST /api/canvas/execute → 状态机轮询 → 产物落布 */
  async function runAppNode(id) {
    const node = objects.value.find((o) => o.id === id)
    if (!node || node.type !== 'app' || node.status === 'running') return
    const app = await ensureAppDetail(node.appId)
    if (!app?.template?.prompt || !Object.keys(app.template.prompt).length) {
      node.status = 'error'
      node.statusText = t('canvasAppNodeAppMissing')
      saveSoon()
      return
    }
    const fields = paramFieldsFromTemplate(app)
    const up = collectUpstream(node.id, objects.value, links.value)
    const { overrides } = buildNodeOverrides(node, fields, up)
    // nodeOverrides 形状：{ [nodeId]: { widgetOverrides: {...} } }
    const nodeOverrides = {}
    for (const [nid, widgets] of Object.entries(overrides)) {
      nodeOverrides[nid] = { widgetOverrides: widgets }
    }
    node.status = 'running'
    node.statusText = t('canvasAppNodeQueued')
    node.lastRunSourceIds = up.srcIds
    // B1 产物溯源：记录本次运行的 resolved 文本 + app 名（产物落布时写入图元数据）
    const promptTexts = []
    for (const w of Object.values(overrides)) {
      for (const v of Object.values(w)) {
        if (typeof v === 'string' && v.trim()) promptTexts.push(v.trim())
      }
    }
    node.lastRun = {
      promptId: null,
      at: Date.now(),
      appLabel: app.name || node.name || node.appId,
      promptText: promptTexts.join('\n').slice(0, 2000) || null,
    }
    saveSoon()
    try {
      // HTTP 交换在 appNode.js（submitCanvasExecute），此处只留状态编排
      const { promptId } = await submitCanvasExecute(
        {
          prompt: app.template.prompt,
          nodeOverrides: Object.keys(nodeOverrides).length ? nodeOverrides : undefined,
          name: node.name || node.appId,
        },
        { origin: serverOrigin.value },
      )
      node.lastRun = { ...node.lastRun, promptId, at: Date.now() }
      node.statusText = t('canvasAppNodeRunningStatus')
      startNodePoll(node.id, promptId)
    } catch (e) {
      node.status = 'error'
      node.statusText = String(e?.message || e).slice(0, 120)
      saveSoon()
    }
  }

  /** 批量运行：选中多个 app 节点依次触发（服务端排队天然并行） */
  function runAppNodes(ids) {
    const targets = ids.filter((id) => {
      const o = objects.value.find((x) => x.id === id)
      return o?.type === 'app' && o.status !== 'running'
    })
    for (const id of targets) void runAppNode(id)
    if (targets.length)
      message.info(t('canvasAppNodeBatchQueued').replace('{n}', String(targets.length)))
  }

  function startNodePoll(nodeId, promptId) {
    stopNodePoll(nodeId)
    const tick = async () => {
      const node = objects.value.find((o) => o.id === nodeId)
      if (!node) return stopNodePoll(nodeId)
      try {
        const r = await pollCanvasExecuteStatus(promptId, { origin: serverOrigin.value })
        if (!r) return
        stopNodePoll(nodeId)
        if (r.status === 'success') {
          node.status = 'success'
          node.statusText = t('canvasAppNodeDone')
          placeNodeArtifacts(node, extractStatusFiles(r))
        } else {
          node.status = 'error'
          node.statusText = String(r.error || 'error').slice(0, 120)
        }
        saveSoon()
      } catch {
        /* 下轮重试 */
      }
    }
    nodePolls.set(nodeId, setInterval(tick, POLL_INTERVAL))
    void tick()
  }
  function stopNodePoll(nodeId) {
    const t = nodePolls.get(nodeId)
    if (t) clearInterval(t)
    nodePolls.delete(nodeId)
  }

  /** 轮询结果 outputs → 文件列表（服务端已全扫为 outputs.files） */
  function extractStatusFiles(r) {
    const files = Array.isArray(r?.outputs?.files) ? r.outputs.files : []
    return files
      .filter((f) => f && f.filename)
      .map((f) => ({
        filename: f.filename,
        subfolder: f.subfolder || '',
        type: f.type || 'output',
      }))
  }

  /** 产物落布：节点右侧一列 + 溯源连线（app 节点 → 产物） */
  function placeNodeArtifacts(node, files) {
    if (!files?.length) return
    const origin = appStore.config?.comfyHost || 'http://127.0.0.1:8188'
    // 预取尺寸定布局（artifactLayout 纯函数给列坐标；加载失败不落布）
    const urls = files.map(
      (f) =>
        `${origin}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`,
    )
    Promise.all(
      urls.map(
        (u) =>
          new Promise((resolve) => {
            const probe = new Image()
            probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
            probe.onerror = () => resolve(null)
            probe.src = u
          }),
      ),
    ).then((dims) => {
      const ok = urls.filter((_, i) => dims[i] && dims[i].w > 0)
      const sizes = dims.filter((d) => d && d.w > 0)
      if (!sizes.length) return
      const scaleOf = (d) => Math.min(1, 260 / d.w)
      const widths = sizes.map((d) => Math.round(d.w * scaleOf(d)))
      const heights = sizes.map((d) => Math.round(d.h * scaleOf(d)))
      const spots = artifactLayout(node, sizes.length, heights)
      beforeChange()
      const genMeta = node.lastRun
        ? {
            app: node.lastRun.appLabel || null,
            prompt: node.lastRun.promptText || null,
            at: node.lastRun.at || Date.now(),
          }
        : null
      spots.forEach((spot, i) => {
        const id = 'n' + Date.now() + i + Math.random().toString(36).slice(2, 5)
        objects.value.push({
          id,
          type: 'image',
          x: spot.x,
          y: spot.y,
          width: widths[i],
          height: heights[i],
          src: ok[i],
          meta: genMeta ? { ...genMeta } : undefined,
        })
        links.value.push({ id: 'l' + Date.now() + i, from: node.id, to: id })
      })
      saveSoon()
    })
  }

  // —— App 节点卡视觉（参考 infinite-canvas canvas-theme dark：stone 色系 + rounded-3xl + 选中近白描边）——
  const APP_CARD = {
    fill: '#262729', // node.fill  (--wb-surface)
    stroke: '#313235', // node.stroke  (--wb-stroke)
    activeStroke: '#ffffff', // node.activeStroke 选中=白描边 (--wb-selected)
    text: '#ffffff', // node.text  (--wb-text)
    muted: '#a0a0a0', // node.muted  (--wb-text-2)
    faint: '#8a8a8a', // node.faint  (--wb-text-3)
  }
  function appNodeRectConfig(o) {
    const sel = selection.value.includes(o.id)
    return {
      width: o.width,
      height: o.height,
      fill: APP_CARD.fill,
      stroke: sel || isHighlightedOf(o) ? APP_CARD.activeStroke : APP_CARD.stroke,
      strokeWidth: sel ? 2 : 1,
      cornerRadius: 10, // --wb-r-card（原 rounded-3xl 24px 越阶收敛）
      shadowColor: 'rgba(0,0,0,0.25)',
      shadowBlur: 8, // 选中态不再放大投影：1px 白描边承担选中语义（发光语义退役）
      shadowOffset: { x: 0, y: 2 },
      shadowOpacity: 0.4,
    }
  }
  function appNodeTitleConfig(o) {
    if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
    return {
      text: o.name || o.appId,
      x: 16,
      y: 14,
      width: o.width - 76,
      height: 24,
      fontSize: 14,
      fontStyle: 'bold',
      fill: APP_CARD.text,
      wrap: 'none',
      ellipsis: true,
      listening: false,
    }
  }
  function appNodeSubConfig(o) {
    if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
    const sub =
      o.status === 'running' ? o.statusText || '…' : o.statusText || t('canvasAppNodeSubDefault')
    return {
      text: sub,
      x: 16,
      y: o.height - 30,
      width: o.width - 32,
      height: 20,
      fontSize: 11,
      fill:
        o.status === 'error' ? '#f56c6c' : o.status === 'success' ? APP_CARD.muted : APP_CARD.faint,
      wrap: 'none',
      ellipsis: true,
      listening: false,
    }
  }
  function appNodeStatusConfig(o) {
    const running = o.status === 'running'
    return {
      x: o.width - 26,
      y: 24,
      radius: running ? 6 : 5,
      fill:
        o.status === 'success'
          ? APP_CARD.muted
          : o.status === 'running'
            ? APP_CARD.activeStroke
            : o.status === 'error'
              ? '#f56c6c'
              : APP_CARD.faint,
      stroke: running ? 'rgba(11,140,233,0.25)' : null,
      strokeWidth: running ? 8 : 0,
      listening: false,
    }
  }
  function appNodeRunBtnConfig(o) {
    return {
      text: o.status === 'running' ? '◉' : '▶',
      x: o.width - 58,
      y: o.height - 36,
      fontSize: 16,
      fill: o.status === 'running' ? APP_CARD.activeStroke : APP_CARD.muted,
      listening: true,
    }
  }
  function appNodeExpandBtnConfig(o) {
    return {
      text: '⚙',
      x: o.width - 32,
      y: o.height - 36,
      fontSize: 15,
      fill: appPanel.id === o.id ? APP_CARD.activeStroke : APP_CARD.faint,
      listening: true,
    }
  }

  // —— P3 AI 侧边栏节点指令（wb_canvas_ops → 人审确认卡 → 执行） ——
  const pendingAgentOps = ref(null) // Array<op> | null

  // —— C-H3 AI 快照（AI 批量改画布前的持久检查点 + 一键恢复） ——
  const aiSnapshotStorage = {
    getItem: (k) => localStorage.getItem(k),
    setItem: (k, v) => localStorage.setItem(k, v),
  }
  const aiSnapshotVersion = ref(0) // 面板响应式刷新键
  const aiSnapshots = computed(() => {
    void aiSnapshotVersion.value
    try {
      return listAiSnapshots(
        aiSnapshotStorage.value,
        appStore.config.activeAppId || 'default',
      ).reverse()
    } catch {
      return []
    }
  })
  function takeAiSnapshot(label) {
    try {
      const doc = serializeDoc(objects.value, viewport.value, 'canvas', links.value, groups.value)
      const pid = appStore.config?.activeAppId || 'default'
      saveAiSnapshot(aiSnapshotStorage.value, pid, label, doc)
      aiSnapshotVersion.value++
    } catch (e) {
      // 快照是安全网，失败不阻塞 AI 操作；但留 warn 便于诊断（静默吞错曾让
      // 「快照从未落盘」排查了很久——真机 harness 验收教训）
      console.warn('[aiSnapshot] 快照失败:', e?.message || e)
    }
  }
  function restoreAiSnapshot(snapshotId) {
    const pid = appStore.config.activeAppId || 'default'
    const doc = getAiSnapshot(aiSnapshotStorage.value, pid, snapshotId)
    if (!doc) return false
    try {
      beforeChange()
      const d = parseDoc(doc)
      objects.value = d.objects
      links.value = d.links
      if (d.groups) groups.value = d.groups
      if (d.viewport) viewport.value = d.viewport
      saveSoon()
      aiSnapshotVersion.value++
      return true
    } catch {
      return false
    }
  }
  function removeAiSnapshot(snapshotId) {
    const pid = appStore.config.activeAppId || 'default'
    const ok = deleteAiSnapshot(aiSnapshotStorage.value, pid, snapshotId)
    if (ok) aiSnapshotVersion.value++
    return ok
  }

  const agentOpsDiffLines = computed(() =>
    (pendingAgentOps.value || []).map((op) => {
      switch (op.type) {
        case 'run_node': {
          const n = objects.value.find((o) => o.id === op.nodeId)
          return t('canvasAgentOpsRun').replace('{n}', n?.name || op.nodeId)
        }
        case 'add_app_node':
          return t('canvasAgentOpsAdd').replace('{app}', op.name || op.appId)
        case 'update_node':
          return t('canvasAgentOpsUpdate').replace('{id}', op.id)
        case 'connect_nodes':
          return t('canvasAgentOpsConnect').replace('{f}', op.from).replace('{to}', op.to)
        case 'select_nodes':
          return t('canvasAgentOpsSelect').replace('{n}', String((op.ids || []).length))
        default:
          return String(op.type)
      }
    }),
  )

  function applyCanvasAgentOps(ops) {
    if (!Array.isArray(ops)) return
    beforeChange()
    for (const op of ops) {
      try {
        applyOneAgentOp(op)
      } catch (e) {
        console.warn('[canvas] agent op failed:', op, e)
      }
    }
    saveSoon()
  }

  function applyOneAgentOp(op) {
    if (op.type === 'run_node') {
      const node = objects.value.find((o) => o.id === op.nodeId)
      if (!node || node.type !== 'app') return
      // params 覆写：{nodeId:{widget:value}} 直写 node.params
      if (op.params && typeof op.params === 'object') {
        node.params = { ...node.params, ...op.params }
      }
      void runAppNode(node.id)
      return
    }
    if (op.type === 'add_app_node') {
      const wx = typeof op.x === 'number' ? op.x : viewportCenterWorld().x
      const wy = typeof op.y === 'number' ? op.y : viewportCenterWorld().y
      const node = makeAppNode(op.appId, op.name || op.appId, wx, wy)
      if (op.params && typeof op.params === 'object') node.params = { ...op.params }
      objects.value.push(node)
      void ensureAppDetail(op.appId)
      return
    }
    if (op.type === 'update_node') {
      const node = objects.value.find((o) => o.id === op.id)
      if (!node) return
      const patch = op.patch || {}
      if (patch.params && typeof patch.params === 'object')
        node.params = { ...node.params, ...patch.params }
      if (typeof patch.x === 'number') node.x = patch.x
      if (typeof patch.y === 'number') node.y = patch.y
      if (typeof patch.name === 'string') node.name = patch.name
      return
    }
    if (op.type === 'connect_nodes') {
      const a = objects.value.find((o) => o.id === op.from)
      const b = objects.value.find((o) => o.id === op.to)
      if (!a || !b) return
      const exists = links.value.some(
        (l) => (l.from === op.from && l.to === op.to) || (l.from === op.to && l.to === op.from),
      )
      if (!exists)
        links.value.push({
          id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
          from: op.from,
          to: op.to,
        })
      return
    }
    if (op.type === 'select_nodes') {
      const ids = (op.ids || []).filter((id) => objects.value.some((o) => o.id === id))
      if (ids.length) selection.value = ids
      return
    }
  }

  function confirmAgentOps() {
    const ops = pendingAgentOps.value
    if (!ops?.length) return
    // C-H3 AI 快照：批量改画布前自动打持久命名快照（恢复入口见 AI 快照面板）
    takeAiSnapshot(`AI 操作前（${ops.length} 条指令）`)
    applyCanvasAgentOps(ops)
    pendingAgentOps.value = null
    message.success(t('canvasAgentOpsApplied'))
  }

  // 侧栏工作台 AI ops → 人审卡（不直接执行）
  const offOps = onOps((ops) => {
    if (!Array.isArray(ops) || !ops.length) return
    pendingAgentOps.value = ops
  })

  return {
    appNodeObjects,
    appPanel,
    appPanelApp,
    appPanelFed,
    appPanelNode,
    appPanelPos,
    appPicker,
    appNodeRectConfig,
    appNodeTitleConfig,
    appNodeSubConfig,
    appNodeStatusConfig,
    appNodeRunBtnConfig,
    appNodeExpandBtnConfig,
    openAppNodePanel,
    openAppNodePanelFromKonva,
    openAppPicker,
    openAppPickerAtCtx,
    onAppPicked,
    onPanelParamUpdate,
    openFullApp,
    runAppNode,
    runAppNodeFromKonva,
    runAppNodes,
    pickCanvasImageFor,
    pendingAgentOps,
    agentOpsDiffLines,
    applyOneAgentOp,
    confirmAgentOps,
    aiSnapshots,
    takeAiSnapshot,
    restoreAiSnapshot,
    removeAiSnapshot,
    refreshFed,
    startNodePoll,
    stopNodePoll,
    nodePolls,
    offOps,
    placeNodeArtifacts,
    extractStatusFiles,
    ensureAppDetail,
    appCache,
    appCacheVer,
    serverOrigin,
  }
}
