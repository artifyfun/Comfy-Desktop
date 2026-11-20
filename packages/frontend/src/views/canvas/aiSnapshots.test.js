/**
 * AI 画布快照存储层单测（C-H12 上半场）
 *
 * 这层是纯函数 + 显式 storage 注入，容量/FIFO/坏数据这些**边界语义**用单测钉死最划算；
 * 浏览器侧只验 UI 路径（面板渲染 / 恢复 / 删除 / 可撤销）。
 * 语义来源：`aiSnapshots.js` 头注释——按项目分组、单项目上限 10（FIFO）、全局上限 40、
 * 坏数据静默降级（快照是安全网，不能阻塞画布）。
 */
import { describe, it, expect } from 'vitest'
import {
  loadAllSnapshots,
  saveAiSnapshot,
  listAiSnapshots,
  getAiSnapshot,
  deleteAiSnapshot,
} from './aiSnapshots'

const KEY = 'artify.canvas.aiSnapshots.v1'
const mkStorage = (init) => {
  const m = new Map(init ? [[KEY, init]] : [])
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, v),
    raw: m
  }
}

describe('loadAllSnapshots — 坏数据静默降级', () => {
  it('空存储 → 空结构', () => {
    expect(loadAllSnapshots(mkStorage()).projects).toEqual({})
  })
  it('非法 JSON → 归零而不抛', () => {
    expect(loadAllSnapshots(mkStorage('{不是 json')).projects).toEqual({})
  })
  it('缺 projects 字段 → 归零', () => {
    expect(loadAllSnapshots(mkStorage(JSON.stringify({ version: 1 }))).projects).toEqual({})
  })
})

describe('saveAiSnapshot + listAiSnapshots', () => {
  it('落盘含 label/at/doc；列表不带 doc 但给 bytes', () => {
    const s = mkStorage()
    saveAiSnapshot(s, 'p1', 'AI 操作前（3 条指令）', 'DOC-A', 1000)
    const list = listAiSnapshots(s, 'p1')
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ label: 'AI 操作前（3 条指令）', at: 1000, bytes: 5 })
    expect(list[0].doc).toBeUndefined()
    expect(getAiSnapshot(s, 'p1', list[0].id)).toBe('DOC-A')
  })

  it('label 空/超长：兜底为「AI 修改前」并截断 80 字', () => {
    const s = mkStorage()
    const id1 = saveAiSnapshot(s, 'p1', '', 'd', 1)
    const id2 = saveAiSnapshot(s, 'p1', 'x'.repeat(200), 'd', 2)
    const list = listAiSnapshots(s, 'p1')
    expect(list.find((x) => x.id === id1).label).toBe('AI 修改前')
    expect(list.find((x) => x.id === id2).label).toHaveLength(80)
  })

  it('单项目 FIFO 上限 10：存 12 条只剩最新 10 条', () => {
    const s = mkStorage()
    for (let i = 1; i <= 12; i++) saveAiSnapshot(s, 'p1', `第${i}次`, `doc-${i}`, i)
    const list = listAiSnapshots(s, 'p1')
    expect(list).toHaveLength(10)
    expect(list[0].label).toBe('第3次') // 最旧的两次（第1/第2次）被淘汰
    expect(list[9].label).toBe('第12次')
    expect(getAiSnapshot(s, 'p1', list[8].id)).toBe('doc-11')
  })

  it('项目之间互不干扰', () => {
    const s = mkStorage()
    saveAiSnapshot(s, 'p1', 'a', 'd1', 1)
    saveAiSnapshot(s, 'p2', 'b', 'd2', 2)
    expect(listAiSnapshots(s, 'p1')).toHaveLength(1)
    expect(listAiSnapshots(s, 'p2')).toHaveLength(1)
    expect(listAiSnapshots(s, 'p1')[0].label).toBe('a')
  })

  it('全局上限 40：超过时整段淘汰最旧项目（保持每项目完整）', () => {
    const s = mkStorage()
    // 5 个项目 × 10 条 = 50 > 40 → 至少淘汰最旧的整段
    for (let p = 1; p <= 5; p++) {
      for (let i = 1; i <= 10; i++) saveAiSnapshot(s, `proj${p}`, `p${p}-${i}`, `d`, p * 100 + i)
    }
    const all = loadAllSnapshots(s).projects
    const total = Object.values(all).reduce((n, l) => n + l.length, 0)
    expect(total).toBeLessThanOrEqual(40)
    expect(all.proj1).toBeUndefined() // 最旧项目整段被淘汰
    expect(all.proj5).toHaveLength(10) // 最新项目完整
  })
})

describe('deleteAiSnapshot', () => {
  it('命中删除返回 true，未命中返回 false', () => {
    const s = mkStorage()
    const id = saveAiSnapshot(s, 'p1', 'a', 'd', 1)
    expect(deleteAiSnapshot(s, 'p1', '不存在')).toBe(false)
    expect(deleteAiSnapshot(s, 'p1', id)).toBe(true)
    expect(listAiSnapshots(s, 'p1')).toHaveLength(0)
  })
})
