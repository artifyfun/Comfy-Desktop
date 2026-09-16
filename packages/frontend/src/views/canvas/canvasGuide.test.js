import { describe, expect, it } from 'vitest'
import { guidePages, guideGroups } from './canvasGuide'

describe('canvasGuide — 指南数据层', () => {
  it('返回 12 篇指南：6 节点类型 + 6 场景玩法', () => {
    const pages = guidePages('zh')
    expect(pages).toHaveLength(12)
    const groups = guideGroups('zh')
    expect(groups).toHaveLength(2)
    expect(groups[0].pages).toHaveLength(6)
    expect(groups[1].pages).toHaveLength(6)
  })

  it('每篇都有 id/icon/title/tip/steps/diagram，且 diagram 引用合法', () => {
    for (const p of guidePages('zh')) {
      expect(p.id).toBeTruthy()
      expect(p.icon).toMatch(/^fas /)
      expect(p.title).toBeTruthy()
      expect(p.tip).toBeTruthy()
      expect(p.steps.length).toBeGreaterThanOrEqual(3)
      const n = p.diagram.nodes.length
      expect(n).toBeGreaterThan(0)
      for (const l of p.diagram.links) {
        expect(l.from).toBeGreaterThanOrEqual(0)
        expect(l.from).toBeLessThan(n)
        expect(l.to).toBeGreaterThanOrEqual(0)
        expect(l.to).toBeLessThan(n)
      }
    }
  })

  it('en 语言生效；未知语言回退 zh', () => {
    const en = guidePages('en').find((p) => p.id === 'node-note')
    expect(en.title).toBe('Note')
    const fallback = guidePages('fr').find((p) => p.id === 'node-note')
    expect(fallback.title).toBe('便签')
  })

  it('节点卡片不越界（330×180 画布内）', () => {
    for (const p of guidePages('zh')) {
      for (const n of p.diagram.nodes) {
        expect(n.x).toBeGreaterThanOrEqual(0)
        expect(n.y).toBeGreaterThanOrEqual(0)
        expect(n.x + n.w).toBeLessThanOrEqual(330)
        expect(n.y + n.h).toBeLessThanOrEqual(180)
      }
    }
  })

  it('分组页与全量页一致（顺序）', () => {
    const groups = guideGroups('en')
    const flat = groups.flatMap((g) => g.pages)
    expect(flat.map((p) => p.id)).toEqual(guidePages('en').map((p) => p.id))
  })
})
