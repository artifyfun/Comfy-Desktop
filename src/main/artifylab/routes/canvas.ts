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
import { classifyExecutionError } from '../services/errorClassifier'
import { executePrompt } from '../mcp/executor'
import type { ComfyPrompt } from '../appStore'
import { startBatch, type BatchInputNode } from '../services/batchRunner'
import { workbenchService } from '../workbench/service'
import appStoreManager from '../appStore'
import { logger } from '../utils/logger'

/** 画布摘要投影（注入桥 buildCanvasDigest 的产物） */
export interface CanvasDigest {
  seq: number
  workflowName: string
  nodeCount: number
  models: string[]
  keyParams: Record<string, unknown>
  queue: { running: number; pending: number }
  ts: number
  /** 节点清单（id/type/标题，前 N 个；供服务端 PLAN 注入 agent 决策上下文） */
  nodes?: Array<{ id: number | string; type: string; title?: string }>
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
const defaultCheckpointStore: CheckpointStore = {
  items: [],
  nextId: 1,
  rollbackTo: null,
  audit: []
}

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
      ts: Number(body.ts) || Date.now(),
      nodes: Array.isArray(body.nodes)
        ? body.nodes
            .slice(0, 40)
            .filter(
              (n: unknown): n is { id: number | string; type: string; title?: string } =>
                !!n && typeof n === 'object' && 'type' in n
            )
            .map((n) => ({
              id: n.id as number | string,
              type: String(n.type),
              title: typeof n.title === 'string' ? n.title : undefined
            }))
        : undefined
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
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('ops must be a non-empty array of known types'))
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
      res
        .status(HTTP_STATUS.NOT_FOUND)
        .json(createErrorResponse(`checkpoint ${body?.checkpointId} not found`))
      return
    }
    checkpoints.rollbackTo = cp.id
    // 回滚意味着旧 ops 作废
    checkpoints.audit = []
    res.json(createSuccessResponse({ rollbackTo: cp.id, workflow: cp.workflow }))
  })

  // M4 canvas.debug：错误诊断（无副作用纯分类）。请求体任意组合：
  // { error } / { nodeErrors } / { error, nodeType, nodeId }——取自
  // extractExecutionError 摘要、/prompt 400 响应、execution_error 事件。
  // comfyOrigin 可选：bad_param 且枚举清单被 ComfyUI 截断（"list of length N"）
  // 时，反查 /object_info 补全合法值，给出可一键修复的 fixOps。
  router.post('/api/canvas/debug', async (req: Request, res: Response) => {
    const body = req.body as
      | {
          error?: unknown
          nodeErrors?: unknown
          nodeType?: unknown
          nodeId?: unknown
          comfyOrigin?: unknown
        }
      | undefined
    if (!body || (typeof body.error !== 'string' && typeof body.nodeErrors !== 'object')) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('error (string) or nodeErrors (object) required'))
      return
    }
    const classified = classifyExecutionError({
      error: typeof body.error === 'string' ? body.error : undefined,
      nodeErrors:
        (body.nodeErrors as Parameters<typeof classifyExecutionError>[0]['nodeErrors']) ??
        undefined,
      nodeType: typeof body.nodeType === 'string' ? body.nodeType : undefined,
      nodeId: typeof body.nodeId === 'string' ? body.nodeId : undefined
    })
    // 枚举截断增强：bad_param + 无 fixOps + 有节点/输入名 + 提供了 origin
    const origin = typeof body.comfyOrigin === 'string' ? body.comfyOrigin : undefined
    if (
      classified.category === 'bad_param' &&
      !classified.suggestion.fixOps &&
      classified.nodeType &&
      classified.inputName &&
      origin
    ) {
      try {
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 3000)
        const infoRes = await fetch(
          `${origin}/object_info/${encodeURIComponent(classified.nodeType)}`,
          {
            signal: controller.signal
          }
        )
        clearTimeout(timer)
        if (infoRes.ok) {
          const info = (await infoRes.json()) as Record<
            string,
            { input?: { required?: Record<string, unknown>; optional?: Record<string, unknown> } }
          >
          const node = info[classified.nodeType]
          const spec =
            (node?.input?.required ?? {})[classified.inputName] ??
            (node?.input?.optional ?? {})[classified.inputName]
          if (Array.isArray(spec) && Array.isArray(spec[0]) && (spec[0] as unknown[]).length > 0) {
            const options = (spec[0] as unknown[]).map((v) => String(v))
            const fix = options[0]
            if (fix !== undefined && classified.nodeId) {
              classified.suggestion = {
                kind: 'param_fix',
                text: `${classified.suggestion.text} 合法值（前 8）：${options.slice(0, 8).join('、')}。`,
                fixOps: [
                  {
                    type: 'setWidget',
                    nodeId: classified.nodeId,
                    widget: classified.inputName,
                    value: fix
                  }
                ]
              }
            }
          }
        }
      } catch {
        // object_info 反查失败：保留原建议（纯文本指引）
      }
    }
    res.json(createSuccessResponse(classified))
  })

  // ---- 画布当前工作流执行（M5：感知-执行闭环） --------------------------
  // 注入桥 graphToPrompt（画布当前激活 tab 的 API 格式 prompt）→ 这里提交队列。
  // 单次：POST /api/canvas/execute {prompt, nodeOverrides?, name?, sessionId?} → {promptId}
  // 批量：POST /api/canvas/batch {prompt, inputsMapping, items, name?} → {jobId}
  // sessionId 可选：存在时把 execution 记入 workbench 会话（重进会话可见产物）。

  router.post('/api/canvas/execute', async (req: Request, res: Response) => {
    const body = req.body as
      | {
          prompt?: unknown
          nodeOverrides?: unknown
          name?: unknown
          sessionId?: unknown
        }
      | undefined
    if (!body || !body.prompt || typeof body.prompt !== 'object' || Array.isArray(body.prompt)) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('prompt object required（画布 API 格式）'))
      return
    }
    try {
      const comfyOrigin = appStoreManager.getConfig().comfyHost
      const result = await executePrompt(comfyOrigin, body.prompt as ComfyPrompt, {
        nodeOverrides:
          body.nodeOverrides && typeof body.nodeOverrides === 'object'
            ? (body.nodeOverrides as Record<string, { widgetOverrides?: Record<string, unknown> }>)
            : undefined,
        workflowKey: typeof body.name === 'string' ? body.name : 'canvas:current'
      })
      // 会话记录（可选）：canvas-run 链路经前端带 sessionId，重进会话可见产物
      if (typeof body.sessionId === 'string') {
        try {
          workbenchService.recordCanvasExecution(
            body.sessionId,
            result.prompt_id,
            typeof body.name === 'string' ? body.name : undefined
          )
        } catch (e) {
          logger.warn('record canvas execution failed', e)
        }
      }
      res.json(createSuccessResponse({ promptId: result.prompt_id }))
    } catch (e) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse(String((e as Error).message ?? e).slice(0, 500)))
    }
  })

  router.post('/api/canvas/batch', async (req: Request, res: Response) => {
    const body = req.body as
      | {
          prompt?: unknown
          inputsMapping?: unknown
          items?: unknown
          name?: unknown
        }
      | undefined
    if (
      !body ||
      !body.prompt ||
      typeof body.prompt !== 'object' ||
      !Array.isArray(body.inputsMapping) ||
      !Array.isArray(body.items) ||
      body.items.length < 2
    ) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('prompt + inputsMapping + items(≥2) required'))
      return
    }
    try {
      const { job } = await startBatch({
        prompt: body.prompt as ComfyPrompt,
        inputsMapping: body.inputsMapping as BatchInputNode[],
        items: body.items as Array<Record<string, unknown>>,
        appName: typeof body.name === 'string' ? body.name : '画布批量'
      })
      res.json(createSuccessResponse({ jobId: job.id }))
    } catch (e) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse(String((e as Error).message ?? e).slice(0, 500)))
    }
  })

  return router
}
