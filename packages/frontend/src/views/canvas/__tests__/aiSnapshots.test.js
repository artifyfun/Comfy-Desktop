import { describe, expect, it, beforeEach } from 'vitest'
import {
  loadAllSnapshots,
  saveAiSnapshot,
  listAiSnapshots,
  getAiSnapshot,
  deleteAiSnapshot,
} from '../aiSnapshots'

/** localStorage 形状的内存储（每个测试实例独立） */
function makeStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

let storage
beforeEach(() => {
  storage = makeStorage()
})

describe('aiSnapshots — 保存与读取', () => {
  it('保存后可列出并按 id 取回 doc', () => {
    saveAiSnapshot(storage, 'p1', 'AI 铺工作流前', '{"objects":[]}', 1000)
    saveAiSnapshot(storage, 'p1', 'AI 改参数前', '{"objects":[1]}', 2000)
    const list = listAiSnapshots(storage, 'p1')
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ label: 'AI 铺工作流前' })
    expect(list[0].bytes).toBeGreaterThan(0)
    expect(getAiSnapshot(storage, 'p1', list[1].id)).toBe('{"objects":[1]}')
  })

  it('项目隔离：p2 看不到 p1 的快照', () => {
    saveAiSnapshot(storage, 'p1', 'a', '{}', 1000)
    expect(listAiSnapshots(storage, 'p2')).toEqual([])
    expect(getAiSnapshot(storage, 'p2', listAiSnapshots(storage, 'p1')[0].id)).toBeNull()
  })

  it('label 为空回退默认名；超长截断 80', () => {
    saveAiSnapshot(storage, 'p1', '', '{}', 1000)
    saveAiSnapshot(storage, 'p1', 'x'.repeat(200), '{}', 1001)
    const list = listAiSnapshots(storage, 'p1')
    expect(list[0].label).toBe('AI 修改前')
    expect(list[1].label).toHaveLength(80)
  })
})

describe('aiSnapshots — FIFO 淘汰', () => {
  it('单项目上限 10：第 11 个挤掉最旧', () => {
    for (let i = 0; i < 11; i++) saveAiSnapshot(storage, 'p1', `s${i}`, `{"i":${i}}`, 1000 + i)
    const list = listAiSnapshots(storage, 'p1')
    expect(list).toHaveLength(10)
    expect(list[0].label).toBe('s1') // s0 被淘汰
    expect(getAiSnapshot(storage, 'p1', list[0].id)).toBe('{"i":1}')
  })

  it('全局上限 40：第 41 个保存触发最旧项目整段淘汰', () => {
    // 4 项目 × 10 = 40 恰好在上限内（不淘汰）；第 41 个保存（新项目 p5）越过
    // 上限 → 最旧的 p1 被整段淘汰
    for (let i = 0; i < 10; i++) saveAiSnapshot(storage, 'p1', `a${i}`, '{}', 1000 + i)
    for (let i = 0; i < 10; i++) saveAiSnapshot(storage, 'p2', `b${i}`, '{}', 2000 + i)
    for (let i = 0; i < 10; i++) saveAiSnapshot(storage, 'p3', `c${i}`, '{}', 3000 + i)
    for (let i = 0; i < 10; i++) saveAiSnapshot(storage, 'p4', `d${i}`, '{}', 4000 + i)
    expect(listAiSnapshots(storage, 'p1')).toHaveLength(10) // 满而不超：保留
    saveAiSnapshot(storage, 'p5', 'e0', '{}', 5000) // 第 41 个 → 淘汰最旧的 p1
    expect(listAiSnapshots(storage, 'p1')).toHaveLength(0)
    expect(listAiSnapshots(storage, 'p5')).toHaveLength(1) // 最新项目保留
    const all = ['p2', 'p3', 'p4', 'p5'].reduce((n, p) => n + listAiSnapshots(storage, p).length, 0)
    expect(all).toBeLessThanOrEqual(40)
  })
})

describe('aiSnapshots — 健壮性', () => {
  it('坏 JSON 存量静默归零，保存照常工作', () => {
    storage.setItem('artify.canvas.aiSnapshots.v1', '{broken json')
    expect(loadAllSnapshots(storage).projects).toEqual({})
    saveAiSnapshot(storage, 'p1', 'ok', '{}', 1000)
    expect(listAiSnapshots(storage, 'p1')).toHaveLength(1)
  })

  it('容量满时 setItem 抛错不外抛（静默降级）', () => {
    const full = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError')
      },
    }
    expect(() => saveAiSnapshot(full, 'p1', 'x', '{}', 1000)).not.toThrow()
  })

  it('删除单个快照；不存在返回 false', () => {
    const id1 = saveAiSnapshot(storage, 'p1', 'a', '{}', 1000)
    saveAiSnapshot(storage, 'p1', 'b', '{}', 1001)
    expect(deleteAiSnapshot(storage, 'p1', id1)).toBe(true)
    expect(listAiSnapshots(storage, 'p1')).toHaveLength(1)
    expect(deleteAiSnapshot(storage, 'p1', 'nope')).toBe(false)
  })
})
