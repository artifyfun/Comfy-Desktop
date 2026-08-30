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
  return {
    seq: ++CANVAS_BRIDGE.digestSeq,
    workflowName: getWorkflowName(),
    nodeCount: nodes.length,
    models,
    keyParams,
    queue,
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
