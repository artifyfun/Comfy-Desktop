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

  // ---------------- repo seam 收编后的显式方法（A1刀1） ----------------

  it('memories：upsert 幂等覆盖 / remove 不存在返回 false', () => {
    const repo = mkRepo()
    repo.upsertMemory('k1', 'v1')
    repo.upsertMemory('k1', 'v2')
    expect(repo.listMemories()['k1']?.value).toBe('v2')
    expect(repo.removeMemory('nope')).toBe(false)
    expect(repo.removeMemory('k1')).toBe(true)
    expect(repo.listMemories()['k1']).toBeUndefined()
  })

  it('favorites：add / findFavorite 同文件去重键 / remove', () => {
    const repo = mkRepo()
    const fav = {
      id: 'f1',
      sessionId: 's1',
      promptId: 'p1',
      templateId: 't1',
      file: { filename: 'a.png', subfolder: 'x' },
      createdAt: 1
    }
    repo.addFavorite(fav)
    expect(repo.findFavorite('s1', { filename: 'a.png', subfolder: 'x' })?.id).toBe('f1')
    // subfolder 不同 = 不同收藏
    expect(repo.findFavorite('s1', { filename: 'a.png', subfolder: 'y' })).toBeUndefined()
    expect(repo.removeFavorite('f1')).toBe(true)
    expect(repo.removeFavorite('f1')).toBe(false)
  })

  it('userPresets：add / update / map（返回变化数）/ delete / default', () => {
    const mkName = (n: string) => ({ zh: n, en: n })
    const repo = mkRepo()
    repo.addUserPreset({
      id: 'u1',
      name: mkName('P1'),
      description: mkName(''),
      builtin: false,
      templateIds: []
    })
    const updated = repo.updateUserPreset('u1', { name: mkName('P1b') })
    expect(updated?.name.zh).toBe('P1b')
    expect(repo.updateUserPreset('nope', { name: mkName('x') })).toBeNull()

    let mapped = repo.mapUserPresets((p) =>
      p.skillIds?.includes('old') ? { ...p, skillIds: ['new'] } : p
    )
    expect(mapped).toBe(0)
    repo.addUserPreset({
      id: 'u2',
      name: mkName('P2'),
      description: mkName(''),
      builtin: false,
      templateIds: [],
      skillIds: ['old']
    })
    mapped = repo.mapUserPresets((p) =>
      p.skillIds?.includes('old') ? { ...p, skillIds: ['new'] } : p
    )
    expect(mapped).toBe(1)
    expect(repo.listUserPresets().find((p) => p.id === 'u2')?.skillIds).toEqual(['new'])

    repo.setDefaultPreset('u2')
    expect(repo.getDefaultPresetId('fallback')).toBe('u2')
    // 删除默认预设 → default 清空回退 fallback
    expect(repo.deleteUserPreset('u2')).toBe(true)
    expect(repo.getDefaultPresetId('fallback')).toBe('fallback')
    expect(repo.deleteUserPreset('nope')).toBe(false)
  })
})
