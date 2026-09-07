/**
 * sessionStore 单测（候选 ① 收尾 test surface）：
 * CRUD + 防抖落盘 + MAX_SESSIONS 淘汰 + 导入去重语义（真实临时文件）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionStoreRepo } from './sessionStore'

let dir: string
let storePath: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-store-test-'))
  storePath = join(dir, 'sessions.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

const mkRepo = (extra: Partial<ConstructorParameters<typeof SessionStoreRepo>[0]> = {}) =>
  new SessionStoreRepo({
    storePath: () => storePath,
    presetExists: () => true,
    ...extra
  })

describe('SessionStoreRepo', () => {
  it('createSession：初始形状（titleLocked/时间戳/空集合）+ unshift 落库', () => {
    const repo = mkRepo()
    const s = repo.createSession({ title: '我的会话' })
    expect(s.title).toBe('我的会话')
    expect(s.titleLocked).toBe(true)
    expect(s.messages).toEqual([])
    expect(s.executions).toEqual([])
    const anon = repo.createSession()
    expect(anon.title).toBe('新会话')
    expect(anon.titleLocked).toBe(false)
    expect(repo.listSessions()).toHaveLength(2)
  })

  it('防抖落盘：flush 后 500ms 文件出现；重启 load 恢复', async () => {
    vi.useFakeTimers()
    try {
      const repo = mkRepo()
      repo.createSession({ title: 'A' })
      expect(existsSync(storePath)).toBe(false)
      vi.advanceTimersByTime(600)
      expect(existsSync(storePath)).toBe(true)
      // 重启
      const repo2 = mkRepo()
      expect(repo2.listSessions().map((s) => s.title)).toEqual(['A'])
    } finally {
      vi.useRealTimers()
    }
  })

  it('updateSession：标题/归档/presetId（不存在的预设被拒绝）', () => {
    const deleted: string[] = []
    const repo = mkRepo({
      presetExists: (id) => id === 'p1',
      onDelete: (id) => deleted.push(id)
    })
    const s = repo.createSession()
    expect(repo.updateSession(s.id, { title: '改名' })?.title).toBe('改名')
    expect(repo.getSession(s.id)?.titleLocked).toBe(true)
    expect(repo.updateSession(s.id, { archived: true })?.archived).toBe(true)
    repo.updateSession(s.id, { presetId: 'p1' })
    expect(repo.getSession(s.id)?.presetId).toBe('p1')
    repo.updateSession(s.id, { presetId: 'nope' })
    expect(repo.getSession(s.id)?.presetId).toBe('p1') // 未变
    // 空串 = 清除预设
    repo.updateSession(s.id, { presetId: '' })
    expect(repo.getSession(s.id)?.presetId).toBeUndefined()
    expect(deleted).toEqual([])
  })

  it('deleteSession：删除触发 onDelete 级联；不存在 → false', () => {
    const deleted: string[] = []
    const repo = mkRepo({ onDelete: (id) => deleted.push(id) })
    const s = repo.createSession()
    expect(repo.deleteSession(s.id)).toBe(true)
    expect(deleted).toEqual([s.id])
    expect(repo.deleteSession(s.id)).toBe(false)
  })

  it('MAX_SESSIONS 淘汰：flush 时按 updatedAt 保留最新 50', async () => {
    vi.useFakeTimers()
    try {
      const repo = mkRepo()
      for (let i = 0; i < 55; i++) {
        const s = repo.createSession({ title: `s${i}` })
        s.updatedAt = 1000 + i
      }
      vi.advanceTimersByTime(600)
      const parsed = JSON.parse(readFileSync(storePath, 'utf8')) as {
        sessions: Array<{ title: string }>
      }
      expect(parsed.sessions).toHaveLength(50)
      // 最旧的 s0..s4 被淘汰
      const titles = parsed.sessions.map((x) => x.title)
      expect(titles).not.toContain('s0')
      expect(titles).toContain('s54')
    } finally {
      vi.useRealTimers()
    }
  })

  it('importSession：非法载荷 → ok:false；重复导入由 sessionTransfer 校验', () => {
    const repo = mkRepo()
    const r = repo.importSession({ garbage: true })
    expect(r.ok).toBe(false)
    expect(r.session).toBeUndefined()
  })
})
