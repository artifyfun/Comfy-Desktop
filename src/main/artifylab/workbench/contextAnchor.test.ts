import { describe, expect, it } from 'vitest'
import {
  contextWatermark,
  contextAnchorText,
  contextAnchorFor,
  DEFAULT_THRESHOLDS
} from './contextAnchor'

describe('contextWatermark — 水位判定', () => {
  it('低水位：轮次与 token 都低于阈值 → normal', () => {
    expect(contextWatermark(0, 0)).toBe('normal')
    expect(contextWatermark(5, 100_000)).toBe('normal')
  })

  it('轮次达 elevated → elevated；token 达 elevated 亦然', () => {
    expect(contextWatermark(8, 0)).toBe('elevated')
    expect(contextWatermark(0, 150_000)).toBe('elevated')
  })

  it('high 优先（轮次与 token 任一达 high 阈值）', () => {
    expect(contextWatermark(16, 0)).toBe('high')
    expect(contextWatermark(0, 500_000)).toBe('high')
    expect(contextWatermark(20, 600_000)).toBe('high')
  })

  it('自定义阈值生效', () => {
    const t = { elevatedTurns: 2, elevatedTokens: 10, highTurns: 4, highTokens: 20 }
    expect(contextWatermark(1, 5, t)).toBe('normal')
    expect(contextWatermark(2, 10, t)).toBe('elevated')
    expect(contextWatermark(4, 20, t)).toBe('high')
  })
})

describe('contextAnchorText — 锚定文案', () => {
  it('normal → 空串（不注入）', () => {
    expect(contextAnchorText('normal')).toBe('')
  })

  it('elevated → 含工具纪律锚定', () => {
    const t = contextAnchorText('elevated')
    expect(t).toContain('上下文纪律')
    expect(t).toContain('wb_list_templates')
    expect(t).not.toContain('保守方案')
  })

  it('high → 锚定 + 保守收敛提示', () => {
    const t = contextAnchorText('high')
    expect(t).toContain('上下文纪律')
    expect(t).toContain('优先复用本会话已验证过的模板')
  })
})

describe('contextAnchorFor — 便捷入口', () => {
  it('默认阈值下: 新会话空串, 8 轮起注入', () => {
    expect(contextAnchorFor(0, 0)).toBe('')
    expect(contextAnchorFor(8, 0)).toContain('wb_list_templates')
  })

  it('阈值常量与文档一致（8/150k/16/500k）', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      elevatedTurns: 8,
      elevatedTokens: 150_000,
      highTurns: 16,
      highTokens: 500_000
    })
  })
})
