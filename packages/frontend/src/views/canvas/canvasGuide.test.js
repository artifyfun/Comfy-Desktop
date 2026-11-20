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

/**
 * 示意图几何审计 —— 把「逐页肉眼核对」固化为可回归的约束。
 * 起因：多页曾出现标签溢出卡片、连线箭头挤压、操作环飘在节点外、选框没圈住内容，
 * 这些在真机上才发现。约束越具体，改数据时越早被拦下。
 */
describe('canvasGuide — 示意图几何审计', () => {
  const W = 330
  const H = 180
  const pages = guidePages('zh')

  /** 文本宽度估算：CJK/emoji 按 1em、ASCII 按 0.55em（够用于「是否溢出卡片」判断） */
  const estWidth = (s, fontSize) => {
    let em = 0
    for (const ch of String(s)) em += /[\u0020-\u007e]/.test(ch) ? 0.55 : 1
    return em * fontSize
  }

  it('节点互不重叠（frame 与其子节点除外——包含是设计）', () => {
    for (const p of pages) {
      const nodes = p.diagram.nodes
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i]
          const b = nodes[j]
          if (a.kind === 'frame' || b.kind === 'frame') continue
          const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x)
          const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y)
          expect(
            ox > 2 && oy > 2,
            `${p.id}: 节点${i}(${a.kind}) 与 节点${j}(${b.kind}) 重叠 ${ox}×${oy}`,
          ).toBe(false)
        }
      }
    }
  })

  it('右向连线水平间距 ≥14px（否则贝塞尔控制点挤压、箭头堆叠）', () => {
    for (const p of pages) {
      for (const [li, l] of p.diagram.links.entries()) {
        const a = p.diagram.nodes[l.from]
        const b = p.diagram.nodes[l.to]
        const gap = b.x - (a.x + a.w)
        if (gap <= 0) continue // 反向/垂直流不适用本约束
        expect(gap, `${p.id}: 连线${li}(${l.from}→${l.to}) 间距仅 ${gap}px`).toBeGreaterThanOrEqual(
          14,
        )
      }
    }
  })

  it('节点文字标签不溢出卡片（按字号估算宽度，含 icon 占位后的行宽）', () => {
    for (const p of pages) {
      for (const [i, n] of p.diagram.nodes.entries()) {
        if (!n.label || n.kind === 'frame') continue
        const emojiOnly = n.label.length <= 4 && !/[a-zA-Z0-9#]/.test(n.label)
        const fontSize = emojiOnly ? 20 : n.label.length > 8 ? 10 : 11
        // >8 字符会折成两行，取较长一行估算
        const lines =
          n.label.length > 8
            ? [
                n.label.slice(0, Math.ceil(n.label.length / 2)),
                n.label.slice(Math.ceil(n.label.length / 2)),
              ]
            : [n.label]
        const widest = Math.max(...lines.map((t) => estWidth(t, fontSize)))
        expect(
          widest,
          `${p.id}: 节点${i} 标签「${n.label}」估算宽 ${widest.toFixed(0)}px > 卡片 ${n.w}px`,
        ).toBeLessThanOrEqual(n.w + 1)
      }
    }
  })

  it('圆形操作环（click）必须归属唯一节点——完全落在节点内，或贴边跨在节点角上', () => {
    const R = 12
    const rectOf = (g) => ({ x1: g.x - R, y1: g.y - R, x2: g.x + R, y2: g.y + R })
    for (const p of pages) {
      for (const [gi, g] of p.diagram.gestures.entries()) {
        if (g.type === 'drag' || g.type === 'box') continue
        const r = rectOf(g)
        const hosts = p.diagram.nodes.filter(
          (n) =>
            Math.min(r.x2, n.x + n.w) - Math.max(r.x1, n.x) > 2 &&
            Math.min(r.y2, n.y + n.h) - Math.max(r.y1, n.y) > 2,
        )
        // 恰好一个宿主：既不能飘在空中（0 个），也不能骑在两个节点上（歧义）
        expect(
          hosts.length,
          `${p.id}: 手势${gi} 的环(${g.x},${g.y}) 命中 ${hosts.length} 个节点（应为 1）`,
        ).toBe(1)
      }
    }
  })

  it('框选手势矩形完整圈住同页所有图片节点（框选语义要看得出来）', () => {
    for (const p of pages) {
      for (const g of p.diagram.gestures) {
        if (g.type !== 'box') continue
        const x1 = Math.min(g.x1, g.x2)
        const y1 = Math.min(g.y1, g.y2)
        const x2 = Math.max(g.x1, g.x2)
        const y2 = Math.max(g.y1, g.y2)
        const imgs = p.diagram.nodes.filter((n) => n.kind === 'image')
        expect(imgs.length, `${p.id}: box 手势页没有图片节点可框`).toBeGreaterThan(0)
        for (const n of imgs) {
          expect(
            n.x >= x1 && n.y >= y1 && n.x + n.w <= x2 && n.y + n.h <= y2,
            `${p.id}: 选框未圈住图片节点(${n.x},${n.y} ${n.w}×${n.h})`,
          ).toBe(true)
        }
      }
    }
  })

  it('手势/连线标签不越出图幅（曾被 viewBox 左缘裁掉）', () => {
    for (const p of pages) {
      for (const g of p.diagram.gestures) {
        if (!g.label || typeof g.label === 'object') continue
        if (g.type === 'box') {
          expect(Math.min(g.x1, g.x2) + 2, `${p.id}: 框选标签 x 越界`).toBeGreaterThanOrEqual(0)
          expect(Math.min(g.y1, g.y2) - 8 - 7, `${p.id}: 框选标签 y 越界`).toBeGreaterThanOrEqual(0)
        } else if (g.type === 'drag') {
          const y = (g.y1 + g.y2) / 2 - 10
          expect(y, `${p.id}: drag 标签 y 越界`).toBeGreaterThan(0)
        } else {
          expect(g.x - 12, `${p.id}: 环标签 x 越界`).toBeGreaterThanOrEqual(0)
          expect(g.y - 12, `${p.id}: 环标签 y 越界`).toBeGreaterThanOrEqual(0)
          expect(g.y + 12, `${p.id}: 环标签 y 越界`).toBeLessThanOrEqual(H)
        }
      }
    }
  })
})
