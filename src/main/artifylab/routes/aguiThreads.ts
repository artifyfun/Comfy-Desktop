/**
 * C5 — thread/历史 REST API(独立 router,与 A 线 routes/agui.ts 并行开发,互不触碰)。
 *
 * - POST /api/workbench/agent/threads/page    — 会话分页(数据源:workbenchService.listSessions 读侧包装)
 * - POST /api/workbench/agent/threads/messages— 按 run 分页返回 AG-UI 事件(数据源:C3 eventStore)
 *
 * 响应形状对齐 waa 列表接口:`{ rowCount, records: [...] }`,外层再包本仓库统一
 * createSuccessResponse(ok/success/code/data)。messages.content 是事件 JSON 原文
 * (JSON.stringify(event)),前端直接 parse 后喂同一管线(实时流与历史回放同构)。
 *
 * 依赖注入:路由工厂接收 { store, sessions },便于单测用 :memory: store 与
 * mock 会话列表注入;生产在 server.ts 注册处用 createEventStore() 工厂 +
 * workbenchService.listSessions 组装(captain 统一注册,本文件不改 server.ts)。
 */

import { Router, type Request, type Response } from 'express'
import { createSuccessResponse, createErrorResponse } from '../utils/errorHandler'
import { HTTP_STATUS } from '../config/constants'
import {
  DEFAULT_LIST_LIMIT,
  MAX_LIST_LIMIT,
  type EventStore,
  type StoredEvent
} from '../agui/eventStore'
import type { WorkbenchSession } from '../workbench/service'

/** 分页默认与上限(对齐 waa 常见 20/页) */
export const THREADS_PAGE_SIZE_DEFAULT = 20
export const THREADS_PAGE_SIZE_MAX = 100

export interface AguiThreadsDeps {
  /** C3 事件存储(生产 = createEventStore() 工厂产物;测试 = new EventStore(':memory:')) */
  store: EventStore
  /** 会话列表取数函数(生产 = () => workbenchService.listSessions();测试注入 mock) */
  sessions: () => WorkbenchSession[]
}

interface PaginationBody {
  params?: {
    pagination?: {
      pagenum?: number
      pagesize?: number
    }
  }
}

interface MessagesBody {
  threadId?: string
  runId?: string
  offset?: number
  limit?: number
}

interface SessionRecord {
  threadId: string
  title: string
  updatedAt: number
  archived: boolean
}

interface MessageRecord {
  runId: string
  seq: number
  eventType: string
  /** 事件 JSON 原文,前端 parse 后直接喂 AG-UI 管线 */
  content: string
  /** 落库时间戳(ms;审查修复 M2) */
  createdAt?: number
}

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback
  return Math.min(Math.max(n, min), max)
}

export function createAguiThreadsRouter(deps: AguiThreadsDeps): Router {
  const router = Router()

  // 会话分页:body {params:{pagination:{pagenum=1, pagesize=20}}}
  router.post('/api/workbench/agent/threads/page', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as PaginationBody
      const pagenum = clampInt(body.params?.pagination?.pagenum, 1, 1, Number.MAX_SAFE_INTEGER)
      const pagesize = clampInt(
        body.params?.pagination?.pagesize,
        THREADS_PAGE_SIZE_DEFAULT,
        1,
        THREADS_PAGE_SIZE_MAX
      )
      // 全量取数后内存分页(会话存储本身已是 updatedAt 降序的读侧列表,量级为桌面单用户,可接受)
      const all = deps.sessions()
      const start = (pagenum - 1) * pagesize
      const page = all.slice(start, start + pagesize)
      const records: SessionRecord[] = page.map((s) => ({
        threadId: s.id,
        title: s.title,
        updatedAt: s.updatedAt,
        archived: !!s.archived
      }))
      res.json(
        createSuccessResponse({
          rowCount: all.length,
          records
        })
      )
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  // 历史事件分页:body {threadId, runId?, offset?, limit?}
  router.post('/api/workbench/agent/threads/messages', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as MessagesBody
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
      if (!threadId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('threadId is required'))
        return
      }
      const limit = clampInt(body.limit, DEFAULT_LIST_LIMIT, 1, MAX_LIST_LIMIT)
      const offset = clampInt(body.offset, 0, 0, Number.MAX_SAFE_INTEGER)
      const events: StoredEvent[] = deps.store.listEvents(threadId, {
        ...(body.runId !== undefined ? { runId: body.runId } : {}),
        offset,
        limit
      })
      const records: MessageRecord[] = events.map((e) => ({
        runId: e.runId,
        seq: e.seq,
        eventType: e.eventType,
        content: e.content,
        // 审查修复 M2:回放侧按 run 边界重建回合 + 用户消息归并需要时间锚点
        createdAt: e.createdAt
      }))
      res.json(
        createSuccessResponse({
          rowCount: records.length,
          records
        })
      )
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  return router
}
