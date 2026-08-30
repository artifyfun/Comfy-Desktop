import { describe, expect, it } from 'vitest'
import { visibleSurfaceOf } from './visibleSurface'

/**
 * 组合矩阵锁死：visibleSurface 是 A/C 高亮、set-surface backstop、devtools
 * 路由的唯一判定源。2026-08 的倒挂死锁（C 画布可见但 titlebar 亮 A 段）
 * 就是「可见表面」公式分裂的产物——这里把所有合法组合钉死。
 */
describe('visibleSurfaceOf', () => {
  it('shows the canvas whenever activePanel is comfy, even with a warm artify panel', () => {
    // A→C 切换后的驻留形态：panelSurface 保留 'artify'（暖面板），但画布可见。
    // 这是倒挂 bug 的确切场景——必须判 'comfy'。
    expect(visibleSurfaceOf({ panelSurface: 'artify', activePanel: 'comfy' })).toBe('comfy')
  })

  it('shows artify when the panel is visible and hosting the A UI', () => {
    expect(visibleSurfaceOf({ panelSurface: 'artify', activePanel: 'chooser' })).toBe('artify')
    // 非 comfy 的任意面板 key 都让 panelView 可见
    expect(visibleSurfaceOf({ panelSurface: 'artify', activePanel: 'feedback' })).toBe('artify')
    expect(visibleSurfaceOf({ panelSurface: 'artify', activePanel: 'track' })).toBe('artify')
  })

  it('shows the chooser when the panel hosts the install picker', () => {
    // install-less 窗口的初始形态
    expect(visibleSurfaceOf({ panelSurface: 'chooser', activePanel: 'chooser' })).toBe('chooser')
    expect(visibleSurfaceOf({ panelSurface: 'chooser', activePanel: 'new-install' })).toBe(
      'chooser'
    )
  })

  it('prefers the canvas for a chooser-panel window running comfy', () => {
    // chooser 面板 + C 画布运行中：activePanel='comfy' 压过面板装载内容
    expect(visibleSurfaceOf({ panelSurface: 'chooser', activePanel: 'comfy' })).toBe('comfy')
  })

  it('is a pure function of its input (no hidden state)', () => {
    const input = { panelSurface: 'artify' as const, activePanel: 'comfy' }
    expect(visibleSurfaceOf(input)).toBe(visibleSurfaceOf({ ...input }))
  })
})
