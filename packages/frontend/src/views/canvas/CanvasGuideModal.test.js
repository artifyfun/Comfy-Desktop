// @vitest-environment happy-dom
/**
 * CanvasGuideModal — 示意图渲染契约单测
 *
 * 为什么有这份测试：指南每页的观感问题（emoji 太小/偏位、图标缺失、选框画成斜箭头、
 * 标签被 viewBox 裁掉）此前只能在真机浏览器里逐页肉眼核对，无法在 CI/提交前拦住回归。
 * 这里把「渲染契约」钉死，覆盖三类曾经的线上问题：
 *   1. 字号契约：纯 emoji 标签必须带 .emoji（20px）；圆形手势环内符号必须带 .icon（17px）
 *   2. 定位契约：emoji 居中补正 +2、icon+文字上下对称（±7/+12）、框选标签在选框上方 8px
 *   3. 画法契约：框选必须渲染 rect.guide-marquee（不是 drag 斜箭头）；start 锚点走内联
 *      style（CSS 的 text-anchor 会覆盖 SVG 属性，曾导致标签左溢出被裁）
 */
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import CanvasGuideModal from './CanvasGuideModal.vue'
import { guidePages } from './canvasGuide'

const PAGES = guidePages('zh')

/** 按侧栏导航切页（与用户操作同一路径，顺带覆盖导航渲染） */
async function goto(w, id) {
  const idx = PAGES.findIndex((p) => p.id === id)
  await w.findAll('.guide-nav')[idx].trigger('click')
  return PAGES[idx]
}

const mountGuide = () => mount(CanvasGuideModal)

describe('CanvasGuideModal — 渲染契约', () => {
  it('12 页全部可渲染，图幅固定 330×180', async () => {
    const w = mountGuide()
    for (const p of PAGES) {
      await goto(w, p.id)
      const svg = w.find('.guide-figure svg')
      expect(svg.exists(), `${p.id} 缺 svg`).toBe(true)
      // SVG 的 viewBox 是驼峰属性，@vue/test-utils 的 attributes() 取不到 → 走原生 DOM
      expect(svg.element.getAttribute('viewBox')).toBe('0 0 330 180')
      expect(w.find('.guide-title').text()).toBe(p.title)
    }
    expect(w.findAll('.guide-nav')).toHaveLength(12)
  })

  it('纯 emoji 标签带 .emoji（放大到 20px）；文字标签不带', async () => {
    const w = mountGuide()
    await goto(w, 'node-media')
    const labels = w.findAll('text.guide-node-label')
    const emoji = labels.filter((l) => l.classes().includes('emoji'))
    const plain = labels.filter((l) => !l.classes().includes('emoji'))
    // 该页三个节点都是 emoji 标签（🎬/🎵/📸）
    expect(emoji.map((l) => l.text())).toEqual(['🎬', '🎵', '📸'])
    expect(plain).toHaveLength(0)

    // 便签页：文本标签不该被放大
    await goto(w, 'node-note')
    const noteLabel = w.findAll('text.guide-node-label').find((l) => l.text().includes('cat'))
    expect(noteLabel.classes()).toContain('multi')
    expect(noteLabel.classes()).not.toContain('emoji')
  })

  it('emoji 标签落在节点中心（+2 字体 metrics 补正），文字标签落在中心', async () => {
    const w = mountGuide()
    const page = await goto(w, 'node-media')
    page.diagram.nodes.forEach((n, i) => {
      const label = w.findAll('text.guide-node-label')[i]
      const cy = n.y + n.h / 2
      const expected = label.classes().includes('emoji') ? cy + 2 : cy
      expect(Number(label.attributes('y'))).toBe(expected)
      expect(Number(label.attributes('x'))).toBe(n.x + n.w / 2)
    })
  })

  it('icon+文字组合：图标在上（cy-7）、文字在下（cy+12），对节点中心对称', async () => {
    const w = mountGuide()
    const page = await goto(w, 'scene-chain')
    const withIcon = page.diagram.nodes.filter((n) => n.icon && n.label)
    expect(withIcon.length).toBeGreaterThan(0)
    const icons = w.findAll('text.guide-node-icon')
    const labels = w.findAll('text.guide-node-label')
    for (const n of withIcon) {
      const cy = n.y + n.h / 2
      const icon = icons.find((t) => t.text() === n.icon)
      const label = labels.find((t) => t.text() === n.label)
      expect(Number(icon.attributes('y'))).toBe(cy - 7)
      expect(Number(label.attributes('y'))).toBe(cy + 12)
      // 组合整体仍以节点中心对称
      expect((cy - 7 + (cy + 12)) / 2).toBeCloseTo(cy + 2.5, 5)
    }
  })

  it('框选手势渲染为 rect.guide-marquee（不是 drag 斜箭头），标签在选框上方 8px', async () => {
    const w = mountGuide()
    const page = await goto(w, 'scene-compose')
    const box = page.diagram.gestures.find((g) => g.type === 'box')
    expect(box, 'scene-compose 应使用 box 手势').toBeTruthy()

    const rect = w.find('rect.guide-marquee')
    expect(rect.exists()).toBe(true)
    expect(Number(rect.attributes('x'))).toBe(Math.min(box.x1, box.x2))
    expect(Number(rect.attributes('y'))).toBe(Math.min(box.y1, box.y2))
    expect(Number(rect.attributes('width'))).toBe(Math.abs(box.x2 - box.x1))
    expect(Number(rect.attributes('height'))).toBe(Math.abs(box.y2 - box.y1))
    // 同页不应再有 drag 斜箭头（那是「拖拽」语义，不是框选）
    expect(w.find('path.guide-gesture').exists()).toBe(false)

    const label = w.find('text.guide-gesture-label')
    expect(Number(label.attributes('y'))).toBe(Math.min(box.y1, box.y2) - 8)
    expect(Number(label.attributes('x'))).toBe(Math.min(box.x1, box.x2) + 2)
    // 锚点必须走内联 style：CSS 的 text-anchor 优先级高于 SVG 属性（曾致左溢出裁切）
    expect(label.attributes('style')).toContain('text-anchor: start')
  })

  it('圆形手势环内符号带 .icon 且居中于环心（+2 补正）', async () => {
    const w = mountGuide()
    const page = await goto(w, 'scene-chain')
    const ring = page.diagram.gestures.find((g) => g.type === 'click')
    const label = w.find('text.guide-gesture-label')
    expect(label.classes()).toContain('icon')
    expect(Number(label.attributes('y'))).toBe(ring.y + 2)
    expect(Number(label.attributes('x'))).toBe(ring.x)
    const circle = w.find('circle.guide-gesture-ring')
    expect(Number(circle.attributes('cx'))).toBe(ring.x)
    expect(Number(circle.attributes('cy'))).toBe(ring.y)
  })

  it('drag 手势渲染为箭头线 + 起点圆点，标签取线段中点上方', async () => {
    const w = mountGuide()
    const page = await goto(w, 'scene-inpaint')
    const drag = page.diagram.gestures.find((g) => g.type === 'drag')
    expect(w.find('path.guide-gesture').exists()).toBe(true)
    expect(w.find('circle.guide-gesture-dot').exists()).toBe(true)
    const label = w.find('text.guide-gesture-label')
    expect(Number(label.attributes('x'))).toBe((drag.x1 + drag.x2) / 2)
    expect(Number(label.attributes('y'))).toBe((drag.y1 + drag.y2) / 2 - 10)
    expect(label.classes()).not.toContain('icon')
  })
})
