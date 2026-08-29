import { describe, expect, it } from 'vitest'
import { layoutDisplayCards, CARD_WIDTH, CARD_HEIGHT, CARD_GAP } from './canvasCards'

/**
 * 画布陈列卡片排布几何：注入脚本（comfy_inject.js spawnDisplayCards）
 * 与此模块共享同一算法约定，这里锁定关键几何性质。
 */
describe('layoutDisplayCards', () => {
  const area = [0, 0, 2000, 1600]

  it('单卡落在视口右缘内侧（新卡片出现在当前视野内）', () => {
    const [c] = layoutDisplayCards({ count: 1, visibleArea: area })
    expect(c.w).toBe(CARD_WIDTH)
    expect(c.h).toBe(CARD_HEIGHT)
    // 右缘 2000 - 1*(256+24) - 48 = 1672
    expect(c.x).toBe(2000 - (CARD_WIDTH + CARD_GAP) - CARD_GAP * 2)
    expect(c.y).toBe(CARD_GAP)
  })

  it('多卡列内向下堆叠，间距为 CARD_GAP', () => {
    const cards = layoutDisplayCards({ count: 3, visibleArea: area })
    expect(cards).toHaveLength(3)
    for (let i = 1; i < 3; i++) {
      expect(cards[i].x).toBe(cards[0].x)
      expect(cards[i].y - cards[i - 1].y).toBe(CARD_HEIGHT + CARD_GAP)
    }
  })

  it('超出视口高度换列（x 递增、y 回顶）', () => {
    // 视口高 1600：可容纳 floor((1600-24)/(340+24)) = 4 张 → 第 5 张换列
    const cards = layoutDisplayCards({ count: 5, visibleArea: area })
    expect(cards[4].x).toBeGreaterThan(cards[0].x)
    expect(cards[4].y).toBe(CARD_GAP)
    expect(cards[3].y).toBeGreaterThan(cards[0].y)
  })

  it('dpr 缩放：visible_area 物理像素换回逻辑像素（dpr=2 时右缘减半生效）', () => {
    const [c1] = layoutDisplayCards({ count: 1, visibleArea: [0, 0, 4000, 1600], dpr: 2 })
    // 右缘 4000/2=2000 逻辑像素
    expect(c1.x).toBe(2000 - (CARD_WIDTH + CARD_GAP) - CARD_GAP * 2)
  })

  it('小视口：bottomLimit 小于 top 时不死循环、仍返回全部卡片', () => {
    const cards = layoutDisplayCards({ count: 3, visibleArea: [0, 0, 500, 200] })
    expect(cards).toHaveLength(3)
    // 高度不足：全部落第一列后立即换列
    expect(cards[1].x).toBeGreaterThan(cards[0].x)
  })
})
