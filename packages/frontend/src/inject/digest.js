import { CANVAS_BRIDGE } from './card_bridge.js'
import { getComfyUIApp } from './canvas_patches.js'
// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export function getWorkflowName() {
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
export async function buildCanvasDigest() {
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
  // 节点清单（供服务端 PLAN 注入 agent 决策上下文：nodeOverrides/batch 变体的 id 来源）
  // 注意 nodeCount 取全量，nodes 截断前 40（防 digest 体积膨胀）
  const allNodes = nodes
  const nodesBrief = allNodes.slice(0, 40).map((n) => ({
    id: n.id,
    type: String(n.type || ''),
    title: typeof n.title === 'string' && n.title ? n.title : undefined,
  }))
  return {
    seq: ++CANVAS_BRIDGE.digestSeq,
    workflowName: getWorkflowName(),
    nodeCount: allNodes.length,
    models,
    keyParams,
    queue,
    nodes: nodesBrief,
    ts: Date.now(),
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
export function getChangeTracker() {
  try {
    const wf = window.app?.extensionManager?.workflow
    const ct = wf?.activeWorkflow?.changeTracker
    return ct && typeof ct.captureCanvasState === 'function' ? ct : null
  } catch (_e) {
    return null
  }
}

/** 按 id 找节点（数字/字符串 id 都容忍） */
export function findNodeById(g, id) {
  const num = Number(id)
  if (g._nodes_by_id && g._nodes_by_id[num] != null) return g._nodes_by_id[num]
  if (g._nodes) return g._nodes.find((n) => String(n.id) === String(id)) || null
  return null
}

/** 单条 op 执行；返回 {ok, error?}。所有访问都防御新前端形状漂移 */
export async function applyOneOp(g, op) {
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
      created.pos = Array.isArray(op.pos)
        ? op.pos
        : [100 + Math.random() * 200, 100 + Math.random() * 200]
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
      if (!wf || typeof wf !== 'object' || !wf.nodes)
        return { ok: false, error: 'workflow.nodes required' }
      // newTab=true：执行工作流前的画布 tab 保证——目标工作流已在当前 tab 则复用
      // （不新建），否则开新 tab 加载（官方 createTemporary + openWorkflow 链路）；
      // 无 tab API（老版/漂移）时回退整图替换当前 tab。
      if (op.newTab) return await loadWorkflowToTab(wf, op.name)
      await window.app.loadGraphData(wf)
      return { ok: true, mode: 'replace' }
    }
    case 'align': {
      // 画布节点对齐（参考 ComfyUI-AlignLayout 的 Align Panel 语义）：
      // 按目标节点的包围盒基准线对齐；hdist/vdist 为均匀分布。
      const target = resolveCanvasTargets(g, op.nodes)
      if (!target.length) return { ok: false, error: 'no target nodes' }
      const mode = String(op.mode || 'left')
      const boxes = target.map((n) => ({
        n,
        x: n.pos[0],
        y: n.pos[1],
        w: n.size[0],
        h: n.size[1],
        right: n.pos[0] + n.size[0],
        bottom: n.pos[1] + n.size[1],
      }))
      const ref = {
        left: Math.min(...boxes.map((b) => b.x)),
        right: Math.max(...boxes.map((b) => b.right)),
        top: Math.min(...boxes.map((b) => b.y)),
        bottom: Math.max(...boxes.map((b) => b.bottom)),
        cx: boxes.reduce((s, b) => s + b.x + b.w / 2, 0) / boxes.length,
        cy: boxes.reduce((s, b) => s + b.y + b.h / 2, 0) / boxes.length,
      }
      if (mode === 'hdist' || mode === 'vdist') {
        const sorted = [...boxes].sort((a, b) => (mode === 'hdist' ? a.x - b.x : a.y - b.y))
        const total = mode === 'hdist' ? ref.right - ref.left : ref.bottom - ref.top
        const used = sorted.reduce((s, b) => s + (mode === 'hdist' ? b.w : b.h), 0)
        const gap = sorted.length > 1 ? (total - used) / (sorted.length - 1) : 0
        let cursor = mode === 'hdist' ? ref.left : ref.top
        for (const b of sorted) {
          b.n.pos = mode === 'hdist' ? [cursor, b.y] : [b.x, cursor]
          cursor += (mode === 'hdist' ? b.w : b.h) + gap
        }
      } else {
        for (const b of boxes) {
          let x = b.x
          let y = b.y
          switch (mode) {
            case 'left':
              x = ref.left
              break
            case 'right':
              x = ref.right - b.w
              break
            case 'hcenter':
              x = ref.cx - b.w / 2
              break
            case 'top':
              y = ref.top
              break
            case 'bottom':
              y = ref.bottom - b.h
              break
            case 'vcenter':
              y = ref.cy - b.h / 2
              break
            default:
              return { ok: false, error: `unknown align mode ${mode}` }
          }
          b.n.pos = [x, y]
        }
      }
      g.change?.()
      g.setDirtyCanvas?.(true, true)
      return { ok: true, count: target.length, mode }
    }
    case 'autoLayout': {
      // 画布自动布局（参考 ComfyUI-AlignLayout Auto Layout 的简化版）：
      // 拓扑分层排布（source-aligned），每列内按原 y 排序，网格间距防重叠。
      const target = resolveCanvasTargets(g, op.nodes)
      if (!target.length) return { ok: false, error: 'no target nodes' }
      const reverse = op.direction === 'reverse'
      // 拓扑深度：ASAP（正向）从源头推进；reverse 时整体镜像方向
      const depthMap = new Map(target.map((n) => [n.id, 0]))
      for (let iter = 0; iter < target.length + 2; iter++) {
        let changed = false
        for (const n of target) {
          for (const inp of n.inputs || []) {
            if (inp.link == null) continue
            const link = g.links?.[inp.link]
            const src = link ? findNodeById(g, link.origin_id) : null
            if (src && target.includes(src) && depthMap.get(n.id) <= depthMap.get(src.id)) {
              depthMap.set(n.id, depthMap.get(src.id) + 1)
              changed = true
            }
          }
        }
        if (!changed) break
      }
      const cols = new Map()
      for (const n of target) {
        const d = depthMap.get(n.id) ?? 0
        if (!cols.has(d)) cols.set(d, [])
        cols.get(d).push(n)
      }
      const sortedDeps = [...cols.keys()].sort((a, b) => (reverse ? b - a : a - b))
      const gapX = 80
      const gapY = 60
      let x = 0
      for (const d of sortedDeps) {
        const col = cols.get(d).sort((a, b) => a.pos[1] - b.pos[1])
        let y = 0
        let maxW = 0
        for (const n of col) {
          n.pos = [x, y]
          y += n.size[1] + gapY
          maxW = Math.max(maxW, n.size[0])
        }
        x += maxW + gapX
      }
      g.change?.()
      g.setDirtyCanvas?.(true, true)
      return { ok: true, count: target.length, direction: reverse ? 'reverse' : 'forward' }
    }
    default:
      return { ok: false, error: `unknown op type ${op.type}` }
  }
}

/** 目标节点解析：op.nodes 指定 > 画布选中 > 全图（与 AlignLayout 语义一致） */
function resolveCanvasTargets(g, ids) {
  if (Array.isArray(ids) && ids.length)
    return ids.map((id) => findNodeById(g, id)).filter(Boolean)
  const sel = window.app?.canvas?.selected_nodes
  if (sel && Object.keys(sel).length) return Object.values(sel)
  return (g._nodes || []).slice()
}

// ==========================================================================
// 执行前画布 tab 保证（ensure-tab）：模板执行前把目标工作流加载到画布——
// 当前 tab 已是该工作流（同名 + 节点 type 签名一致）则复用，否则开新 tab。
//
// 官方多 tab 链路（ComfyUI 0.3x，pinia workflow store）：
//   store.createTemporary(filename, graphData) → 临时 Workflow 实例（不落盘）
//   store.openWorkflow(instance)               → 加入 tab 列表 + 加载 + 激活
// store 挂在 window.app.extensionManager.workflow 上（activeWorkflow 同源）；
// 防御探测多路径，找不到时回退 app.loadGraphData 整图替换当前 tab。
// ==========================================================================

/** 防御探测 workflow store（多路径；形状随版本漂移，逐层兜底） */
export function getWorkflowTabStore() {
  const app = window.app
  if (!app) return null
  const cands = [
    app.extensionManager?.workflow,
    app.extensionManager?.workflowStore,
    app.ui?.workflow,
    app.workflowStore,
  ]
  for (const c of cands) {
    if (
      c &&
      typeof c.openWorkflow === 'function' &&
      typeof c.createTemporary === 'function'
    )
      return c
  }
  return null
}

/** 节点 type 签名：type 排序拼接（忽略 id/坐标/widgets——同一布局改参数仍是同一工作流） */
function nodeTypeSignature(graph) {
  const nodes = graph && Array.isArray(graph.nodes) ? graph.nodes : []
  return nodes
    .map((n) => String(n && n.type || ''))
    .filter(Boolean)
    .sort()
    .join('|')
}

/** 从 activeWorkflow 取当前 graph（activeState 是 UI graph JSON；content 兜底） */
function activeWorkflowGraph(active) {
  if (!active) return null
  if (active.activeState && Array.isArray(active.activeState.nodes))
    return active.activeState
  if (typeof active.content === 'string') {
    try {
      const parsed = JSON.parse(active.content)
      if (parsed && Array.isArray(parsed.nodes)) return parsed
    } catch (_e) {
      /* 容忍 */
    }
  }
  return null
}

/** 当前激活 tab 是否已是目标工作流（同名 + 节点 type 签名一致） */
function isTabMatchingActive(store, targetGraph, targetName) {
  const active = store.activeWorkflow
  if (!active) return false
  const activeGraph = activeWorkflowGraph(active)
  if (!activeGraph) return false
  if (nodeTypeSignature(targetGraph) !== nodeTypeSignature(activeGraph)) return false
  if (!targetName) return true
  // 名字匹配（容忍 .json 后缀/displayName 差异）：改名后视为不同工作流
  const names = [
    active.name,
    active.displayName,
    active.filename,
    active.fullFilename,
  ]
    .filter(Boolean)
    .map((s) => String(s).replace(/\.json$/i, ''))
  const t = String(targetName).replace(/\.json$/i, '')
  return names.some((n) => n === t || n.endsWith('/' + t))
}

/**
 * 把工作流加载到画布 tab（ensure 语义）：
 * - 当前 tab 已是目标 → {mode:'already-active'}（复用，不新建）
 * - 有 store → 开新 tab → {mode:'new-tab'}
 * - 无 store（版本漂移）→ 整图替换当前 tab → {mode:'replace'}
 */
async function loadWorkflowToTab(wf, name) {
  const store = getWorkflowTabStore()
  if (store) {
    if (isTabMatchingActive(store, wf, name)) {
      return { ok: true, mode: 'already-active', tab: activeTabName(store) }
    }
    try {
      const temp = store.createTemporary(
        String(name || 'Unsaved Workflow') + '.json',
        wf
      )
      await store.openWorkflow(temp)
      return { ok: true, mode: 'new-tab', tab: String(name || 'Unsaved Workflow') }
    } catch (e) {
      // 官方链路失败（如 graph 数据形状不被接受）→ 回退整图替换
      console.warn('[ArtifyInject] createTemporary/openWorkflow failed, fallback replace:', e)
    }
  }
  await window.app.loadGraphData(wf)
  return { ok: true, mode: 'replace' }
}

/** 当前激活 tab 显示名（ack 回执用，失败返回 null） */
function activeTabName(store) {
  try {
    const a = store.activeWorkflow
    const n = a?.displayName || a?.name || a?.filename || ''
    return String(n).replace(/\.json$/i, '') || null
  } catch (_e) {
    return null
  }
}

/**
 * 应用 ops 序列：结构级 op 前自动 checkpoint（进官方 undo 栈）；
 * loadWorkflow 单独走（整图替换后其余 ops 无意义）。
 */
export async function applyCanvasOps(ops) {
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
export async function saveExpressCheckpoint(reason) {
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
        prompt: p.output ?? null,
      }),
    })
    const j = await res.json()
    return j && j.data ? j.data.checkpointId : null
  } catch (_e) {
    return null
  }
}

/** 摘要变化才推送（iframe postMessage + express 快照缓存双路） */
const digestPushing = { value: false }
export async function pushCanvasDigest(force) {
  // 并发跳过：进行中又来一次时直接放弃，等下一个 2s 周期兜底，不排队补发
  if (digestPushing.value) return
  digestPushing.value = true
  try {
    const digest = await buildCanvasDigest()
    const json = JSON.stringify(digest)
    CANVAS_BRIDGE.lastDigestQueueActive = digest.queue.running + digest.queue.pending > 0
    if (!force && json === CANVAS_BRIDGE.lastDigestJson) return
    CANVAS_BRIDGE.lastDigestJson = json
    // 1) 工作台 iframe（存在才发；embed 未打开时不白算）
    if (artifyEmbedWindow) {
      try {
        artifyEmbedWindow.postMessage(
          JSON.stringify({ type: 'artify:canvas-state', state: digest }),
          '*',
        )
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
          body: json,
        }).catch(() => {})
      } catch (_e) {
        /* fetch 不可用（老 webview） */
      }
    }
  } catch (e) {
    console.warn('[ArtifyInject] buildCanvasDigest failed:', e)
  } finally {
    digestPushing.value = false
  }
}

/** 官方 api 事件订阅（→ 摘要重算） */
