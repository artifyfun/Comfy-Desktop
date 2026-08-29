/**
 * 画布感知 + 写通道 API（伴生工作台 M1/M2）。
 *
 * ComfyUI 页内注入桥（comfy_inject.js CANVAS_BRIDGE）把画布摘要投影
 * （digest：workflowName/nodeCount/models/keyParams/queue/ts）节流上报到这里；
 * 本路由做「最新快照缓存 + 读取 + 写通道审计」。
 *
 * 设计依据 docs/research/comfy-copilot-sidebar.md v2：
 *  - 感知：官方 api 事件 + 兜底轮询 → 注入桥 → POST /api/canvas/snapshot；
 *    工作台 iframe 走 postMessage 实时通道，HTTP 是服务端 PLAN / 兜底来源
 *  - 写通道（M2）：LLM 产 ops → 工作台 diff 确认 → 双路下发：
 *      (a) postMessage artify:canvas-ops 直接进桥（主路，实时）
 *      (b) POST /api/canvas/ops 落审计队列（服务端可观测/回滚上下文）
 *    结构级写前桥自动 POST /api/canvas/checkpoint（跨会话回滚锚点）
 *
 * POST /api/canvas/snapshot    上报快照（body 即 digest，缺关键字段 400）
 * GET  /api/canvas/state       读取最近快照（{data:{state|null}}）
 * POST /api/canvas/checkpoint  落 checkpoint（{reason, workflow} → checkpointId）
 * GET  /api/canvas/checkpoints 近期 checkpoint + 审计队列（新→旧，limit≤50）
 * POST /api/canvas/ops         ops 审计入队（{ops, reason} → {queued}）
 * POST /api/canvas/rollback    标记回滚到 checkpoint（返回其 workflow 快照）
 */
import express, { type Router, type Request, type Response } from 'express'
import { HTTP_STATUS } from '../config/constants'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'

/** 画布摘要投影（注入桥 buildCanvasDigest 的产物） */
export interface CanvasDigest {
  seq: number
  workflowName: string
  nodeCount: number
  models: string[]
  keyParams: Record<string, unknown>
  queue: { running: number; pending: number }
  ts: number
}

/** 进程内最新快照存储（单用户桌面应用，无需持久化；重启即失，桥会重报） */
export interface CanvasDigestStore {
  latest: CanvasDigest | null
}

/** 结构级写前的整图快照（graphToPrompt 的 workflow 格式） */
export interface CanvasCheckpoint {
  id: number
  reason: string
  workflow: unknown
  ts: number
}

/** 下发给桥的画布操作（审计粒度，与注入桥 applyOneOp 的 op 一一对应） */
export interface CanvasOp {
  type: 'setWidget' | 'addNode' | 'removeNode' | 'relink' | 'loadWorkflow'
  [k: string]: unknown
}

/**
 * M2 写通道存储：checkpoint 列表 + ops 审计队列 + 回滚标记。
 * 单用户桌面应用全部进程内，重启即失（桥重连后会重新上报现状）。
 */
export interface CheckpointStore {
  items: CanvasCheckpoint[]
  nextId: number
  /** 最近一次 rollback 目标（消费后清空） */
  rollbackTo: number | null
  /** 待桥拉取的 ops 审计队列（HTTP 下发路；postMessage 主路不经此） */
  audit: Array<{ ops: CanvasOp[]; reason: string; ts: number }>
}

const defaultDigestStore: CanvasDigestStore = { latest: null }
const defaultCheckpointStore: CheckpointStore = { items: [], nextId: 1, rollbackTo: null, audit: [] }

/** 供其他模块读取默认 store（不导出可变引用） */
export function getLatestCanvasDigest(): CanvasDigest | null {
  return defaultDigestStore.latest
}

/** ops 白名单：类型字段串行化，超出白名单的字段不进审计（防注入垃圾） */
const OP_TYPES = new Set(['setWidget', 'addNode', 'removeNode', 'relink', 'loadWorkflow'])

function sanitizeOps(raw: unknown): CanvasOp[] | null {
  if (!Array.isArray(raw) || raw.length === 0) return null
  const out: CanvasOp[] = []
  for (const op of raw) {
    if (!op || typeof op !== 'object') return null
    const rec = op as Record<string, unknown>
    if (typeof rec.type !== 'string' || !OP_TYPES.has(rec.type)) return null
    out.push({ ...rec, type: rec.type as CanvasOp['type'] })
  }
  return out
}

export function createCanvasRouter(
  store: CanvasDigestStore = defaultDigestStore,
  checkpoints: CheckpointStore = defaultCheckpointStore
): Router {
  const router = express.Router()

  router.post('/api/canvas/snapshot', (req: Request, res: Response) => {
    const body = req.body as Partial<CanvasDigest> | undefined
    if (
      !body ||
      typeof body.seq !== 'number' ||
      typeof body.nodeCount !== 'number' ||
      typeof body.workflowName !== 'string'
    ) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid canvas digest'))
      return
    }
    store.latest = {
      seq: body.seq,
      workflowName: body.workflowName,
      nodeCount: body.nodeCount,
      models: Array.isArray(body.models) ? body.models.map(String) : [],
      keyParams: body.keyParams && typeof body.keyParams === 'object' ? body.keyParams : {},
      queue: {
        running: Number(body.queue?.running) || 0,
        pending: Number(body.queue?.pending) || 0
      },
      ts: Number(body.ts) || Date.now()
    }
    res.json(createSuccessResponse({ seq: store.latest.seq }))
  })

  router.get('/api/canvas/state', (_req: Request, res: Response) => {
    res.json(createSuccessResponse({ state: store.latest }))
  })

  // ---- M2 写通道 ----------------------------------------------------------

  router.post('/api/canvas/checkpoint', (req: Request, res: Response) => {
    const body = req.body as { reason?: unknown; workflow?: unknown } | undefined
    if (!body || !body.workflow || typeof body.workflow !== 'object') {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('workflow object required'))
      return
    }
    const cp: CanvasCheckpoint = {
      id: checkpoints.nextId++,
      reason: typeof body.reason === 'string' ? body.reason.slice(0, 200) : '',
      workflow: body.workflow,
      ts: Date.now()
    }
    checkpoints.items.push(cp)
    // 上限 50：内存护栏，只留最近的
    if (checkpoints.items.length > 50) checkpoints.items.splice(0, checkpoints.items.length - 50)
    res.json(createSuccessResponse({ checkpointId: cp.id }))
  })

  router.get('/api/canvas/checkpoints', (req: Request, res: Response) => {
    const limit = Math.min(Number(req.query.limit) || 10, 50)
    res.json(
      createSuccessResponse({
        items: checkpoints.items.slice(-limit).reverse(),
        audit: checkpoints.audit.slice(-20).reverse()
      })
    )
  })

  router.post('/api/canvas/ops', (req: Request, res: Response) => {
    const body = req.body as { ops?: unknown; reason?: unknown } | undefined
    const ops = sanitizeOps(body?.ops)
    if (!ops) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('ops must be a non-empty array of known types'))
      return
    }
    checkpoints.audit.push({
      ops,
      reason: typeof body?.reason === 'string' ? body.reason.slice(0, 200) : '',
      ts: Date.now()
    })
    if (checkpoints.audit.length > 20) checkpoints.audit.splice(0, checkpoints.audit.length - 20)
    res.json(createSuccessResponse({ queued: ops.length }))
  })

  router.post('/api/canvas/rollback', (req: Request, res: Response) => {
    const body = req.body as { checkpointId?: unknown } | undefined
    const id = Number(body?.checkpointId)
    const cp = checkpoints.items.find((c) => c.id === id)
    if (!cp) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse(`checkpoint ${body?.checkpointId} not found`))
      return
    }
    checkpoints.rollbackTo = cp.id
    // 回滚意味着旧 ops 作废
    checkpoints.audit = []
    res.json(createSuccessResponse({ rollbackTo: cp.id, workflow: cp.workflow }))
  })

  return router
}
