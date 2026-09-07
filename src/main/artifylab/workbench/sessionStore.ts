/**
 * 会话持久层——候选 ① 收尾：CRUD + debounced flush 从 service.ts 抽出。
 *
 * 职责边界（单一）：workbench-sessions.json 的读写与会话生命周期。
 * - load()/flush()：防抖落盘（500ms）+ MAX_SESSIONS 上限淘汰最旧
 * - listSessions/getSession/createSession/updateSession/deleteSession
 * - importSession（重复导入检测）/exportSession/touchSession
 *
 * deleteSession 的 agent 运行时销毁经 onDelete 回调注入（service 组合根
 * 接 AgentRuntime.dispose）——本模块不感知 harness。
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { exportSession, importSession as importSessionCore } from './sessionTransfer'
import type { SessionStore, WorkbenchSession, SessionModelOverride } from './sessionTypes'
import { logger } from '../utils/logger'

const MAX_SESSIONS = 50
const FLUSH_DEBOUNCE_MS = 500

/** 装配期依赖（service 组合根注入） */
export interface SessionStoreDeps {
  /** 会话删除时的级联清理（agent 运行时销毁） */
  onDelete?(id: string): void
  /** 预设存在性校验（updateSession 的 presetId 切换仅接受已存在预设） */
  presetExists(id: string): boolean
  /** store 文件路径（测试可注入临时路径） */
  storePath(): string
}

export class SessionStoreRepo {
  store: SessionStore = { sessions: [] }
  private flushTimer: NodeJS.Timeout | null = null

  constructor(private readonly deps: SessionStoreDeps) {
    this.load()
  }

  load(): void {
    try {
      const p = this.deps.storePath()
      if (existsSync(p)) this.store = JSON.parse(readFileSync(p, 'utf8')) as SessionStore
    } catch (e) {
      logger.warn('workbench: load sessions failed', e)
    }
  }

  flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        // 上限淘汰最旧会话
        if (this.store.sessions.length > MAX_SESSIONS) {
          this.store.sessions = this.store.sessions
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_SESSIONS)
        }
        writeFileSync(this.deps.storePath(), JSON.stringify(this.store, null, 2))
      } catch (e) {
        logger.warn('workbench: flush sessions failed', e)
      }
    }, FLUSH_DEBOUNCE_MS)
  }

  listSessions(archived?: boolean): WorkbenchSession[] {
    return [...this.store.sessions]
      .filter((s) => (archived === undefined ? true : !!s.archived === archived))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): WorkbenchSession | null {
    return this.store.sessions.find((s) => s.id === id) ?? null
  }

  createSession(
    opts: { title?: string; presetId?: string; entry?: WorkbenchSession['entry'] } = {}
  ): WorkbenchSession {
    const session: WorkbenchSession = {
      id: randomUUID(),
      title: opts.title || '新会话',
      // 用户在建会话时显式填了标题 → 视同手动命名，防 PLAN 自动标题覆盖
      titleLocked: !!opts.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      executions: [],
      presetId: opts.presetId,
      entry: opts.entry
    }
    this.store.sessions.unshift(session)
    this.flush()
    return session
  }

  /** 会话元信息更新（标题/模型覆盖/归档；dsh 语义：模型可变，预设锁定） */
  updateSession(
    id: string,
    patch: {
      title?: string
      modelOverride?: SessionModelOverride
      archived?: boolean
      presetId?: string
    }
  ): WorkbenchSession | null {
    const session = this.getSession(id)
    if (!session) return null
    if (patch.title !== undefined) {
      session.title = patch.title
      session.titleLocked = true
    }
    if (patch.modelOverride !== undefined) session.modelOverride = patch.modelOverride
    if (patch.archived !== undefined) session.archived = patch.archived
    // 预设点击切换（dsh 模式）：仅接受已存在预设
    if (patch.presetId !== undefined) {
      if (patch.presetId === '' || this.deps.presetExists(patch.presetId)) {
        session.presetId = patch.presetId || undefined
      }
    }
    session.updatedAt = Date.now()
    this.flush()
    return session
  }

  deleteSession(id: string): boolean {
    const before = this.store.sessions.length
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id)
    const ok = this.store.sessions.length < before
    if (ok) {
      this.deps.onDelete?.(id)
      this.flush()
    }
    return ok
  }

  /** 导入件产物回填后触碰会话（updated 落盘） */
  touchSession(id: string): void {
    const s = this.getSession(id)
    if (s) {
      s.updatedAt = Date.now()
      this.flush()
    }
  }

  /** 导出会话（纯函数核心见 sessionTransfer.ts；剥 debugLogs/batchJobId） */
  exportSession(id: string) {
    const session = this.getSession(id)
    if (!session) return null
    return exportSession(session)
  }

  /**
   * 导入会话：校验 + 新 UUID 落库（防 id 冲突）。失败返回错误码。
   * duplicate 检测：同源（originId）已导入且未 force → error='duplicate' +
   * existing 摘要，前端确认后 force 重导。
   */
  importSession(
    raw: unknown,
    opts: { force?: boolean } = {}
  ): {
    ok: boolean
    session?: WorkbenchSession
    error?: string
    existing?: { id: string; title: string; updatedAt: number }
  } {
    const existing = new Set(this.store.sessions.map((s) => s.id))
    const imported = this.store.sessions
      .filter((s) => !!s.importedFrom)
      .map((s) => ({
        importedFrom: s.importedFrom!,
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt
      }))
    const r = importSessionCore(raw, existing, { force: opts.force, imported })
    if (!r.ok || !r.session) return { ok: false, error: r.error }
    this.store.sessions.unshift(r.session)
    this.flush()
    return { ok: true, session: r.session }
  }
}
