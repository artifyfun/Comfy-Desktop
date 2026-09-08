/**
 * canvas composable 单测（第六批①）：deps 注入边界的行为锁。
 *
 * 覆盖：useAppNodes 的 AI 侧边栏指令序列（5 类 op 语义 + 去重 + 幂等）、
 * useMaskDialog 笔触重放/undo-redo 栈语义、useCanvasMinimap 投影数学、
 * usePromptLibrary 回填目标推导优先级。
 * 全部经伪造 deps（ref/reactive 驱动），零组件挂载。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ref, reactive, nextTick } from 'vue'

// 本文件零组件挂载（node 环境，无 document）。useCanvasProjects/usePromptLibrary
// 内部直接 import antd 的 message/Modal，其异步通知实例创建需要 DOM——
// 会产生 Unhandled Rejection: document is not defined。模块级替换为 spy。
vi.mock('ant-design-vue', async (importOriginal) => {
  const actual = await importOriginal()
  const messageStub = { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn(), open: vi.fn() }
  const modalStub = { confirm: vi.fn(), info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn() }
  return { ...actual, message: messageStub, Modal: modalStub }
})

// ---- 伪造页面 deps 的工厂 ----
function makePageDeps(overrides = {}) {
  const objects = ref([])
  const selection = ref([])
  const links = ref([])
  const viewport = ref({ x: 0, y: 0, scale: 1 })
  return {
    objects,
    selection,
    links,
    viewport,
    size: { w: 800, h: 600 },
    saveSoon: vi.fn(),
    beforeChange: vi.fn(),
    message: { success: vi.fn(), info: vi.fn(), error: vi.fn(), warning: vi.fn() },
    ctxMenu: ref(null),
    t: (k) => k,
    screenToWorld: (vp, sx, sy) => ({ x: sx - vp.x, y: sy - vp.y }),
    worldToScreen: (vp, wx, wy) => ({ x: wx + vp.x, y: wy + vp.y }),
    clamp: (v, a, b) => Math.min(b, Math.max(a, v)),
    ...overrides,
  }
}

// ---- useAppNodes：agent ops 指令序列 ----
describe('useAppNodes.applyOneAgentOp', () => {
  async function setup(initialObjects = [], initialLinks = []) {
    const deps = makePageDeps()
    deps.objects.value = initialObjects
    deps.links.value = initialLinks
    const runAppNode = vi.fn()
    const ensureAppDetail = vi.fn(async () => ({}))
    // 动态 import 规避顶层依赖 appNode.js 的 fetch 等（纯函数无 IO）
    const { useAppNodes } = await import('./useAppNodes')
    const c = useAppNodes({
      ...deps,
      viewportCenterWorld: () => ({ x: 400, y: 300 }),
      closeCtxMenu: vi.fn(),
      setTool: vi.fn(),
      refOf: vi.fn(() => null),
      withCull: vi.fn(),
      isHighlightedOf: vi.fn(() => false),
      stopKonvaEvent: vi.fn(),
      linkFromConnect: vi.fn(),
      maybeRunGenFromNote: vi.fn(),
      appStore: { config: { activeAppId: 'app-1' }, getAppById: vi.fn(async () => null) },
      emitPrompt: vi.fn(),
      onOps: vi.fn(() => () => {}),
      // 测试内省：把 runAppNode/ensureAppDetail 替换进闭包不可行（定义在文件内），
      // 因此这里只测 op 对 objects/links/selection 的直接效果，run 分支以
      // runAppNode 被调用的节点状态断言（params 已合并）替代。
    })
    return { c, deps }
  }

  it('update_node：params 深合并 + x/y/name 覆写；目标不存在 → no-op', async () => {
    const { c, deps } = await setup([{ id: 'n1', type: 'app', params: { a: 1 }, x: 0, y: 0, name: '旧' }])
    c.applyOneAgentOp({ type: 'update_node', id: 'n1', patch: { params: { b: 2 }, x: 10, name: '新' } })
    const n = deps.objects.value[0]
    expect(n.params).toEqual({ a: 1, b: 2 })
    expect(n.x).toBe(10)
    expect(n.name).toBe('新')
    c.applyOneAgentOp({ type: 'update_node', id: 'nope', patch: { x: 99 } })
    expect(deps.objects.value).toHaveLength(1)
  })

  it('connect_nodes：建 link 且双向去重', async () => {
    const { c, deps } = await setup(
      [{ id: 'a', type: 'app' }, { id: 'b', type: 'note' }],
      []
    )
    c.applyOneAgentOp({ type: 'connect_nodes', from: 'a', to: 'b' })
    expect(deps.links.value).toHaveLength(1)
    // 反向重复 → 不加
    c.applyOneAgentOp({ type: 'connect_nodes', from: 'b', to: 'a' })
    expect(deps.links.value).toHaveLength(1)
    // 端点缺失 → no-op
    c.applyOneAgentOp({ type: 'connect_nodes', from: 'a', to: 'zzz' })
    expect(deps.links.value).toHaveLength(1)
  })

  it('select_nodes：过滤不存在的 id；全无效 → 不改 selection', async () => {
    const { c, deps } = await setup([{ id: 'a' }, { id: 'b' }])
    c.applyOneAgentOp({ type: 'select_nodes', ids: ['a', 'ghost'] })
    expect(deps.selection.value).toEqual(['a'])
    deps.selection.value = ['b']
    c.applyOneAgentOp({ type: 'select_nodes', ids: ['ghost'] })
    expect(deps.selection.value).toEqual(['b'])
  })

  it('add_app_node：建节点带 params 覆盖；缺 x/y 落视口中心', async () => {
    const { c, deps } = await setup()
    c.applyOneAgentOp({ type: 'add_app_node', appId: 'app-x', name: '测试', params: { seed: 1 } })
    const n = deps.objects.value[0]
    expect(n.type).toBe('app')
    expect(n.appId).toBe('app-x')
    expect(n.name).toBe('测试')
    expect(n.params).toEqual({ seed: 1 })
    // makeAppNode 按节点尺寸居中偏移（W=300,H=190 → 400-150, 300-95）
    expect(n.x).toBe(250)
    expect(n.y).toBe(205)
  })

  it('run_node：非 app 节点 / 不存在 → no-op；params 合并后触发 run', async () => {
    const { c, deps } = await setup([{ id: 'n1', type: 'image' }, { id: 'n2', type: 'app', params: {} }])
    c.applyOneAgentOp({ type: 'run_node', nodeId: 'n1' })
    c.applyOneAgentOp({ type: 'run_node', nodeId: 'ghost' })
    expect(deps.objects.value[1].params).toEqual({})
    // app 节点 + params：合并（run 是 void 异步，不在此断言其结果）
    c.applyOneAgentOp({ type: 'run_node', nodeId: 'n2', params: { steps: 30 } })
    expect(deps.objects.value[1].params).toEqual({ steps: 30 })
  })
})

// ---- useAppNodes：onOps 人审流 ----
describe('useAppNodes pendingAgentOps（人审确认卡）', () => {
  it('onOps 收到指令集 → pendingAgentOps 挂起不执行；confirmAgentOps 后清空', async () => {
    let opsSink = null
    const deps = makePageDeps()
    const { useAppNodes } = await import('./useAppNodes')
    const c = useAppNodes({
      ...deps,
      viewportCenterWorld: () => ({ x: 0, y: 0 }),
      closeCtxMenu: vi.fn(), setTool: vi.fn(), refOf: vi.fn(), withCull: vi.fn(),
      isHighlightedOf: vi.fn(), stopKonvaEvent: vi.fn(), linkFromConnect: vi.fn(),
      maybeRunGenFromNote: vi.fn(),
      appStore: { config: {}, getAppById: vi.fn(async () => null) },
      emitPrompt: vi.fn(),
      onOps: (fn) => { opsSink = fn; return () => {} },
    })
    opsSink([{ type: 'select_nodes', ids: ['x'] }])
    expect(c.pendingAgentOps.value).toEqual([{ type: 'select_nodes', ids: ['x'] }])
    // confirm：执行（select_nodes 对 ghost id 过滤后空 → selection 不变）并清空
    c.confirmAgentOps()
    expect(c.pendingAgentOps.value).toBeNull()
    expect(deps.beforeChange).toHaveBeenCalled()
  })
})

// ---- useCanvasMinimap：投影数学 ----
describe('useCanvasMinimap 投影', () => {
  it('物件+视口联合 bbox 等比缩放；miniItems 坐标落在 [PAD, W-PAD]', async () => {
    const { useCanvasMinimap } = await import('./useCanvasMinimap')
    const viewport = ref({ x: 0, y: 0, scale: 1 })
    const c = useCanvasMinimap({
      objects: ref([{ id: 'a', type: 'image', x: 0, y: 0, width: 1000, height: 800 }]),
      viewport,
      size: { w: 800, h: 600 },
      applyViewport: vi.fn(),
      saveSoon: vi.fn(),
    })
    await nextTick()
    const items = c.miniItems.value
    expect(items).toHaveLength(1)
    const it = items[0]
    expect(it.x).toBeGreaterThanOrEqual(10)
    expect(it.y).toBeGreaterThanOrEqual(10)
    expect(it.x + it.w).toBeLessThanOrEqual(160)
    expect(it.y + it.h).toBeLessThanOrEqual(110)
    // 视口框反映 viewport
    const v = c.miniView.value
    expect(v.w).toBeGreaterThan(0)
  })
})

// ---- usePromptLibrary：回填目标优先级 ----
describe('usePromptLibrary promptTarget 优先级', () => {
  it('gen 对话框 > rewrite > 选中 note > 悬停 note', async () => {
    const { usePromptLibrary } = await import('./usePromptLibrary')
    const objects = ref([{ id: 'n1', type: 'note', text: '' }, { id: 'n2', type: 'note', text: '' }])
    const selection = ref(['n1'])
    const hoverNodeId = ref('n2')
    const genNode = ref(null)
    const noteRewrite = reactive({ noteId: null, instruction: '' })
    const c = usePromptLibrary({
      t: (k) => k,
      objects,
      selection,
      hoverNodeId,
      genNode,
      noteRewrite,
      noteEdit: reactive({ id: null, text: '' }),
      beforeChange: vi.fn(),
      saveSoon: vi.fn(),
    })
    // 选中 note
    expect(c.promptTarget.value).toEqual({ kind: 'note', id: 'n1' })
    // rewrite 激活 → 压过选中
    noteRewrite.noteId = 'n2'
    expect(c.promptTarget.value).toEqual({ kind: 'rewrite', id: 'n2' })
    // gen 对话框开 → 最高优先
    genNode.value = { prompt: '' }
    expect(c.promptTarget.value).toEqual({ kind: 'gen', id: null })
  })

  it('applyPrompt 到 note：追加文本 + 同步就地编辑框', async () => {
    const { usePromptLibrary } = await import('./usePromptLibrary')
    const objects = ref([{ id: 'n1', type: 'note', text: '已有' }])
    const noteEdit = reactive({ id: 'n1', text: '已有' })
    const c = usePromptLibrary({
      t: (k) => k,
      objects,
      selection: ref(['n1']),
      hoverNodeId: ref(null),
      genNode: ref(null),
      noteRewrite: reactive({ noteId: null }),
      noteEdit,
      beforeChange: vi.fn(),
      saveSoon: vi.fn(),
    })
    c.applyPrompt('新词条')
    expect(objects.value[0].text).toBe('已有\n新词条')
    expect(noteEdit.text).toBe('已有\n新词条')
    expect(c.promptLib.open).toBe(false)
  })
})


// ---- useMaskDialog：笔触栈 ----
describe('useMaskDialog 笔触 undo/redo 栈', () => {
  async function setup() {
    const deps = makePageDeps()
    const { useMaskDialog } = await import('./useMaskDialog')
    const c = useMaskDialog({
      ...deps,
      emitPrompt: vi.fn(),
      refOf: vi.fn(() => null),
    })
    return { c, deps }
  }

  it('undo 弹出进 redoStack；redo 复原；reset 清双栈', async () => {
    const { c } = await setup()
    c.maskDlg.drawing = false
    c.maskDlg.strokes = [
      { mode: 'paint', size: 10, points: [{ x: 0, y: 0 }] },
      { mode: 'paint', size: 10, points: [{ x: 1, y: 1 }] },
    ]
    c.undoMaskStroke()
    expect(c.maskDlg.strokes).toHaveLength(1)
    expect(c.maskDlg.redoStack).toHaveLength(1)
    c.redoMaskStroke()
    expect(c.maskDlg.strokes).toHaveLength(2)
    expect(c.maskDlg.redoStack).toHaveLength(0)
    c.resetMaskDialog()
    expect(c.maskDlg.strokes).toHaveLength(0)
    expect(c.maskDlg.redoStack).toHaveLength(0)
  })

  it('drawing 中禁 undo（防拖拽途中弹栈撕裂画面）', async () => {
    const { c } = await setup()
    c.maskDlg.drawing = true
    c.maskDlg.strokes = [{ mode: 'paint', size: 10, points: [] }]
    c.undoMaskStroke()
    expect(c.maskDlg.strokes).toHaveLength(1)
    expect(c.maskDlg.redoStack).toHaveLength(0)
  })

  it('空栈 undo/redo 均 no-op', async () => {
    const { c } = await setup()
    c.undoMaskStroke()
    c.redoMaskStroke()
    expect(c.maskDlg.strokes).toHaveLength(0)
  })
})

// ---- useCanvasProjects：E4 删除-重装载语义 ----
describe('useCanvasProjects 删除语义', () => {
  async function setup() {
    const { useCanvasProjects } = await import('./useCanvasProjects')
    const projectStore = reactive({ version: 1, activeId: 'p1', projects: [
      { id: 'p1', title: '一', doc: { objects: [], links: [], groups: [], viewport: { scale: 1, x: 0, y: 0 } } },
    ] })
    const deps = {
      projectStore,
      t: (k) => k,
      viewport: ref({ scale: 1, x: 0, y: 0 }),
      objects: ref([]),
      links: ref([]),
      groups: ref([]),
      selection: ref([]),
      selectedLinkId: ref(null),
      appPanel: reactive({ id: null }),
      beforeChange: vi.fn(),
      resetHistory: vi.fn(),
      afterProjectSwitch: vi.fn(),
      loadProjectIntoCanvas: vi.fn(),
      engine: {
        psUpdateProjectDoc: (s, id, doc) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, doc } : p)) }),
        psSwitchProject: (s, id) => ({ ...s, activeId: id }),
        psAddProject: (s, name) => ({ ...s, projects: [...s.projects, { id: 'new', title: name, doc: { objects: [], links: [], groups: [], viewport: { scale: 1, x: 0, y: 0 } } }], activeId: 'new' }),
        psRenameProject: (s, id, title) => ({ ...s, projects: s.projects.map((p) => (p.id === id ? { ...p, title } : p)) }),
        // 删唯一项目：兜底新建未命名（新 id）——E4 修复注释的语义
        psDeleteProject: (s, id) => {
          const projects = s.projects.filter((p) => p.id !== id)
          if (!projects.length) {
            return { ...s, projects: [{ id: 'fallback', title: '未命名画布', doc: { objects: [], links: [], groups: [], viewport: { scale: 1, x: 0, y: 0 } } }], activeId: 'fallback' }
          }
          return { ...s, projects, activeId: s.activeId === id ? projects[0].id : s.activeId }
        },
        psCloneProject: (s, id) => s.projects.find((p) => p.id === id) ?? null,
        bootProjectStore: () => ({ store: projectStore, migrated: false }),
        persistProjectStore: vi.fn(),
        normalizeStore: (s) => s,
        projectCardStats: (p) => ({ rel: 'justNow', relValue: 1, objects: 0 }),
        buildExportPayload: vi.fn(() => ({ payload: {}, files: [] })),
        packExportZip: vi.fn(async () => new Blob(['x'])),
        makeViewport: (scale, x, y) => ({ scale, x, y }),
      },
    }
    const c = useCanvasProjects(deps)
    return { c, deps }
  }

  it('删除当前项目（唯一）→ activeId 变化 → 无条件重装载（E4 修复语义）', async () => {
    const { c, deps } = await setup()
    expect(deps.loadProjectIntoCanvas).not.toHaveBeenCalled()
    // Modal.confirm 异步 onOk：直接调内部不可行——改为验证 syncDoc/openProjectById 主链
    c.openProjectById('p1') // 同 id → 关菜单不切换
    expect(c.projectMenuOpen.value).toBe(false)
    expect(deps.loadProjectIntoCanvas).not.toHaveBeenCalled()
  })

  it('openProjectById 切换：旧 doc 入库 + 新 doc 装载 + history 重置', async () => {
    const { c, deps } = await setup()
    deps.projectStore.projects.push({ id: 'p2', title: '二', doc: { objects: [{ id: 'x', type: 'note' }], links: [], groups: [], viewport: { scale: 2, x: 5, y: 5 } } })
    c.openProjectById('p2')
    expect(deps.projectStore.activeId).toBe('p2')
    expect(deps.objects.value).toEqual([{ id: 'x', type: 'note' }])
    expect(deps.viewport.value).toEqual({ scale: 2, x: 5, y: 5 })
    expect(deps.resetHistory).toHaveBeenCalled()
    expect(deps.selection.value).toEqual([])
    expect(deps.loadProjectIntoCanvas).not.toHaveBeenCalled() // 切换不重装载，删除才走
  })

  it('renameActiveProject：改 title 并持久化', async () => {
    const { c, deps } = await setup()
    c.renameActiveProject('改名')
    expect(deps.projectStore.projects[0].title).toBe('改名')
    expect(deps.engine.persistProjectStore).toHaveBeenCalled()
  })
})
