/**
 * C3 — AG-UI 事件溯源存储(node:sqlite 零外部依赖,照 gallery/db.ts 的 DatabaseSync 模式)。
 *
 * - 表 agui_event 一行 = 一个 AG-UI 事件,content 存 `JSON.stringify(event)` 原文(非 SSE 帧),
 *   实时流(C4)与历史回放(C5 messages)同构,回放 = 按 (thread_id, run_id, seq) 重放。
 * - seq 按 (thread_id, run_id) 自增(max+1):run 内保序,断线重放/排序用;
 *   跨 run / 跨 thread 互不干扰。
 * - event_type 存家族前缀(TEXT_MESSAGE / REASONING / TOOL_CALL / CUSTOM / RUN_ERROR…),
 *   对齐 waa `ai_agent_message` 的事件溯源设计。
 *
 * electron 隔离:本模块零 electron 静态依赖——构造函数接收 db 文件路径(或 ':memory:')
 * 以便纯 Node 单测;生产 DB 文件(userData/workbench-agui-events.db)由 createEventStore()
 * 工厂在 Electron main 进程内 lazy import('electron') 取 app.getPath 创建。
 *
 * 容错契约:append/appendMany 失败一律 throw,由调用方决定旁路——C4 SSE 发送管线应
 * catch 后 logger.warn,不阻断实时流(迁移文档 C3「写入失败不阻断 SSE」)。
 */

import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import type { AGUIEvent } from './types'

/** 生产环境 DB 文件名(位于 app.getPath('userData') 下) */
export const AGUI_EVENTS_DB_FILENAME = 'workbench-agui-events.db'

/** listEvents 默认页大小(大 run 截断保护) */
export const DEFAULT_LIST_LIMIT = 500
/** listEvents 单页上限(前端显式传大 limit 时的护栏) */
export const MAX_LIST_LIMIT = 1000

/**
 * 事件类型 → 存储家族前缀:
 * TEXT_MESSAGE_* → 'TEXT_MESSAGE';REASONING* → 'REASONING';TOOL_CALL_* → 'TOOL_CALL';
 * 其余(CUSTOM / RUN_ERROR / RUN_STARTED / STATE_DELTA / STEP_* / MESSAGES_SNAPSHOT)
 * 本身就是终态家族,原样保留。
 */
export function eventFamily(type: AGUIEvent['type']): string {
  if (type.startsWith('TEXT_MESSAGE_')) return 'TEXT_MESSAGE'
  if (type.startsWith('REASONING')) return 'REASONING'
  if (type.startsWith('TOOL_CALL_')) return 'TOOL_CALL'
  return type
}

export interface StoredEvent {
  seq: number
  runId: string
  eventType: string
  /** AG-UI 事件 JSON 原文(JSON.stringify(event)),前端 parse 后直接喂管线 */
  content: string
  /** 落库时间戳(ms;审查修复 M2:回放侧 run 边界回合重建与用户消息归并锚点) */
  createdAt?: number
}

export interface RunSummary {
  runId: string
  count: number
  firstAt: number
  lastAt: number
}

export interface ListEventsOpts {
  runId?: string
  offset?: number
  limit?: number
}

export class EventStore {
  private readonly db: DatabaseSync

  /**
   * @param dbPath SQLite 文件路径;':memory:' 用于单测(零临时文件清理负担)。
   *               文件路径时自动递归创建父目录并开 WAL(照 gallery/db.ts 模式)。
   */
  constructor(dbPath: string) {
    if (dbPath !== ':memory:') {
      fs.mkdirSync(path.dirname(dbPath), { recursive: true })
    }
    this.db = new DatabaseSync(dbPath)
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS agui_event (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_thread_run ON agui_event(thread_id, run_id, seq);
    `)
  }

  /**
   * 追加单条事件。seq = 同 (threadId, runId) 内 max(seq)+1。
   *
   * 失败(序列化/写入)一律 throw——由调用方决定旁路:C4 路由层应 catch 后
   * logger.warn,不阻断 SSE(见迁移文档 C3)。
   */
  appendEvent(threadId: string, runId: string, event: AGUIEvent): void {
    this.insertAll(threadId, runId, [event], Date.now())
  }

  /**
   * 单事务批量追加(一次 decide 的一组事件)。任一事件序列化/写入失败,
   * 整批 ROLLBACK 并 throw(all-or-nothing),既有数据不受影响。
   */
  appendMany(threadId: string, runId: string, events: AGUIEvent[]): void {
    if (events.length === 0) return
    this.insertAll(threadId, runId, events, Date.now())
  }

  private insertAll(threadId: string, runId: string, events: AGUIEvent[], now: number): void {
    this.db.exec('BEGIN')
    try {
      const insert = this.db.prepare(
        `INSERT INTO agui_event (thread_id, run_id, seq, event_type, content, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      const maxSeq = this.db
        .prepare(
          `SELECT COALESCE(MAX(seq), 0) AS maxSeq FROM agui_event WHERE thread_id = ? AND run_id = ?`
        )
        .get(threadId, runId) as { maxSeq: number | undefined }
      let seq = Number(maxSeq?.maxSeq ?? 0)
      for (const event of events) {
        seq += 1
        insert.run(threadId, runId, seq, eventFamily(event.type), JSON.stringify(event), now)
      }
      this.db.exec('COMMIT')
    } catch (e) {
      this.db.exec('ROLLBACK')
      throw e
    }
  }

  /** 按 run 分组统计(同 thread),按 run 首次出现(最早一条)排序。 */
  listRuns(threadId: string): RunSummary[] {
    const rows = this.db
      .prepare(
        `SELECT run_id AS runId,
                COUNT(*) AS count,
                MIN(created_at) AS firstAt,
                MAX(created_at) AS lastAt,
                MIN(id) AS firstId
         FROM agui_event
         WHERE thread_id = ?
         GROUP BY run_id
         ORDER BY firstId ASC`
      )
      .all(threadId) as Record<string, unknown>[]
    return rows.map((r) => ({
      runId: String(r.runId),
      count: Number(r.count),
      firstAt: Number(r.firstAt),
      lastAt: Number(r.lastAt)
    }))
  }

  /**
   * 列出事件。按落库顺序(id)升序 = 真实时序:单 run 内 id 序与 seq 序一致,
   * 跨 run 时为先到 run 先列(回放 = 顺序重放)。默认 limit 500
   * (可用 opts.limit 覆盖,上限 MAX_LIST_LIMIT)。
   */
  listEvents(threadId: string, opts: ListEventsOpts = {}): StoredEvent[] {
    const where = ['thread_id = ?']
    const params: Array<string | number> = [threadId]
    if (opts.runId !== undefined) {
      where.push('run_id = ?')
      params.push(opts.runId)
    }
    const limit = Math.min(
      Math.max(1, Math.floor(opts.limit ?? DEFAULT_LIST_LIMIT)),
      MAX_LIST_LIMIT
    )
    const offset = Math.max(0, Math.floor(opts.offset ?? 0))
    const rows = this.db
      .prepare(
        `SELECT seq, run_id AS runId, event_type AS eventType, content, created_at AS createdAt
         FROM agui_event
         WHERE ${where.join(' AND ')}
         ORDER BY id ASC
         LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset) as Record<string, unknown>[]
    return rows.map((r) => ({
      seq: Number(r.seq),
      runId: String(r.runId),
      eventType: String(r.eventType),
      content: String(r.content),
      ...(r.createdAt != null ? { createdAt: Number(r.createdAt) } : {})
    }))
  }

  /** 某 thread 的事件总数(跨 run)。 */
  countEvents(threadId: string): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS c FROM agui_event WHERE thread_id = ?`)
      .get(threadId) as { c: number | undefined }
    return Number(row?.c ?? 0)
  }

  /** 关闭连接(生产随进程退出;测试可显式释放)。 */
  close(): void {
    this.db.close()
  }
}

/**
 * 生产工厂:在 Electron main 进程内创建 EventStore,DB 文件位于
 * userData/workbench-agui-events.db。electron 仅在此处 lazy import,
 * 保证模块本身(与全部单测)零 electron 依赖。
 * 单测/注入场景直接 `new EventStore(':memory:')`,不要调用本工厂。
 */
export async function createEventStore(): Promise<EventStore> {
  const electron = (await import('electron')) as unknown as {
    app?: { getPath(name: string): string }
    default?: { app?: { getPath(name: string): string } }
  }
  const app = electron.app ?? electron.default?.app
  if (!app?.getPath) {
    throw new Error('createEventStore() 必须在 Electron main 进程内调用(需要 app.getPath)')
  }
  return new EventStore(path.join(app.getPath('userData'), AGUI_EVENTS_DB_FILENAME))
}
