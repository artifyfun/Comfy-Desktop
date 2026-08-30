import { ARTIFY_CARD_TYPE, getCardApp } from './card_node.js'
import { pushCanvasDigest, applyCanvasOps, saveExpressCheckpoint } from './digest.js'
// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
// 陈列卡片 ↔ 工作台 iframe 的消息面。artifyEmbedWindow 是共享可变状态
// （iframe 就绪后由 sidebar_tab 写入），经 getEmbedWindow/setEmbedWindow
// 暴露给其他模块。
let artifyEmbedWindow = null
/** 侧栏 tab iframe 就绪后由 sidebar_tab 写入；digest/回填路径读取。 */
export function getEmbedWindow() {
  return artifyEmbedWindow
}
export function setEmbedWindow(w) {
  artifyEmbedWindow = w
}
export function sendCardsToEmbed(nodes) {
  if (!artifyEmbedWindow) {
    console.warn('[ArtifyInject] no embed window; card attach skipped')
    return
  }
  const files = []
  for (const n of nodes) {
    for (const f of n.properties?.files || []) files.push(f)
  }
  if (!files.length) return
  artifyEmbedWindow.postMessage(JSON.stringify({ type: 'artify:card-attach', files }), '*')
}

/**
 * 产物上墙：把 files 铺成卡片（瀑布排布在当前视口右侧空白），完成后 fit。
 * nodesPerCol 对齐官方 positionNodes 的列式堆叠算法（nodeHeight≈256+64）。
 */
export function spawnDisplayCards(files) {
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
export async function handleArtifyMessage(data) {
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
      const hasStructural =
        Array.isArray(data.ops) && data.ops.some((o) => o && o.type !== 'setWidget')
      let checkpointId = null
      if (hasStructural) checkpointId = await saveExpressCheckpoint(String(data.reason || ''))
      const r = await applyCanvasOps(data.ops)
      postToEmbed({ type: ackType, requestId: data.requestId, checkpointId, ...r })
    } catch (e) {
      postToEmbed({
        type: ackType,
        requestId: data.requestId,
        ok: false,
        error: String(e).slice(0, 120),
      })
    }
  }
  if (data.type === 'artify:canvas-execute') {
    // M5 执行画布当前工作流：graphToPrompt（当前激活 tab）→ 服务端提交 →
    // ack promptId（单次）或 jobId（批量）。回执走同一 iframe postMessage。
    const ackType = 'artify:canvas-execute-result'
    try {
      const app = window.app
      if (!app || typeof app.graphToPrompt !== 'function')
        throw new Error('graphToPrompt unavailable（画布未就绪）')
      const p = await app.graphToPrompt()
      const prompt = p && p.output ? p.output : p
      const api = window.__ARTIFY_LAB_API__ || window.location.origin
      if (data.batch) {
        // 批量：行键「节点id.widget名」→ inputsMapping + items（sharedParams 合并进每行）
        const rowKeys = new Set()
        for (const it of data.batch.items || []) {
          if (!it || typeof it !== 'object') continue
          for (const k of Object.keys(it)) rowKeys.add(k)
        }
        for (const k of Object.keys(data.batch.sharedParams || {})) rowKeys.add(k)
        const inputsMapping = [...rowKeys]
          .map((k) => {
            const m = /^(\d+)[./](.+)$/.exec(k)
            return m ? { id: m[1], key: m[2], valueMap: { key: k } } : null
          })
          .filter(Boolean)
        const items = (data.batch.items || []).map((it) => ({
          ...(data.batch.sharedParams || {}),
          ...it,
        }))
        if (inputsMapping.length === 0 || items.length < 2)
          throw new Error('batch 行键需为「节点id.widget名」格式且至少 2 行')
        const r = await fetch(`${api}/api/canvas/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            inputsMapping,
            items,
            name: data.name,
            sessionId: data.sessionId,
          }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j || !j.success) throw new Error((j && j.message) || `HTTP ${r.status}`)
        postToEmbed({ type: ackType, requestId: data.requestId, ok: true, jobId: j.data.jobId, batch: true })
      } else {
        const r = await fetch(`${api}/api/canvas/execute`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            nodeOverrides: data.nodeOverrides,
            name: data.name,
            sessionId: data.sessionId,
          }),
        })
        const j = await r.json().catch(() => null)
        if (!r.ok || !j || !j.success) throw new Error((j && j.message) || `HTTP ${r.status}`)
        postToEmbed({ type: ackType, requestId: data.requestId, ok: true, promptId: j.data.promptId })
      }
    } catch (e) {
      postToEmbed({
        type: ackType,
        requestId: data.requestId,
        ok: false,
        error: String(e).slice(0, 200),
      })
    }
  }
}

/** 向工作台 iframe 回传（iframe 未打开时静默丢弃——写通道只在 embed 打开时可用） */
export function postToEmbed(msg) {
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

export const CANVAS_BRIDGE = {
  digestSeq: 0, // 递增序号：工作台/express 据此判断「变了」
  lastDigestJson: '', // 去重：摘要无变化不重发
  pollTimer: null,
  pollDelay: 2000,
  lastQueueRemaining: 0, // status 广播的 queue_remaining
  lastDigestQueueActive: false, // 最近一次摘要里队列是否有活
  apiBound: false,
}

/** 当前工作流名（官方 frontend 顶栏标题；取不到回退 'Unsaved Workflow'） */
