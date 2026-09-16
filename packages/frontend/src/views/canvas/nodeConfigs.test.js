import { describe, expect, it } from 'vitest'
import {
  makeViewCtx,
  highlightStroke,
  handleConfig,
  linkAnchorConfig,
  resizeAnchorConfig,
  mediaRectConfig,
  noteRectConfig,
  noteTextConfig,
  frameConfig,
  frameLabelConfig,
  shotRectConfig,
  shotSeqConfig,
  shotTextConfig,
  noteTextColor,
  NOTE_COLORS,
  NOTE_DEFAULT_COLOR,
} from './nodeConfigs'

const none = makeViewCtx({ isSelected: () => false, isHighlighted: () => false, scale: 1 })
const mk = (over = {}) =>
  makeViewCtx({
    isSelected: (id) => id === 'sel',
    isHighlighted: (id) => id === 'hi',
    isHovered: (id) => id === 'hov',
    accent: '#0b8ce9',
    scale: 1,
    ...over,
  })
const obj = { id: 'x', x: 0, y: 0, width: 180, height: 120 }

describe('highlightStroke', () => {
  it('选中/高亮 → accent 2px；默认 → defStroke 1px', () => {
    const ctx = mk()
    expect(highlightStroke(ctx, { id: 'sel' })).toEqual({ stroke: '#0b8ce9', strokeWidth: 2 })
    expect(highlightStroke(ctx, { id: 'hi' })).toEqual({ stroke: '#0b8ce9', strokeWidth: 2 })
    expect(highlightStroke(ctx, obj)).toEqual({ stroke: 'rgba(160,160,160,0.45)', strokeWidth: 1 })
    expect(highlightStroke(ctx, obj, '')).toEqual({ stroke: '', strokeWidth: 1 })
  })
})

describe('handleConfig', () => {
  it('target 在左缘/source 在右缘；hover 放大；缩放反比半径', () => {
    const ctx = mk()
    const t = handleConfig(ctx, obj, 'target', false)
    const sc = handleConfig(ctx, obj, 'source', true)
    expect(t.x).toBe(0)
    expect(sc.x).toBe(180)
    // 非 hover 半径 6；hover（'hov'）半径 7.5
    expect(handleConfig(ctx, { ...obj, id: 'hov' }, 'source', true).radius).toBeCloseTo(7.5)
    expect(sc.opacity).toBe(1)
    expect(t.opacity).toBe(0)
    // 缩放 2x → 半径减半（屏幕恒定）
    const zoomed = makeViewCtx({ isSelected: () => false, isHighlighted: () => false, scale: 2 })
    expect(handleConfig(zoomed, obj, 'source', false).radius).toBeCloseTo(3)
  })
})

describe('linkAnchorConfig', () => {
  it('from 在 (x1,y1) 蓝、to 在 (x2,y2) 灰；active 控制 opacity', () => {
    const ctx = mk()
    const seg = { x1: 10, y1: 20, x2: 100, y2: 40 }
    const f = linkAnchorConfig(ctx, seg, 'from', true)
    const t = linkAnchorConfig(ctx, seg, 'to', false)
    expect(f).toMatchObject({ x: 10, y: 20, fill: '#31b9f4', opacity: 1, cursor: 'grab' })
    expect(t).toMatchObject({ x: 100, y: 40, fill: '#a0a0a0', opacity: 0 })
  })
})

describe('resizeAnchorConfig', () => {
  it('四角外偏 10px 屏距；nw/se 光标 nwse-resize；visible 控制 opacity', () => {
    const ctx = mk()
    const se = resizeAnchorConfig(ctx, obj, 'se', true)
    const nw = resizeAnchorConfig(ctx, obj, 'nw', false)
    expect(se).toMatchObject({ x: 190, y: 130, cursor: 'nwse-resize', opacity: 1 })
    expect(nw).toMatchObject({ x: -10, y: -10, cursor: 'nwse-resize', opacity: 0 })
    expect(resizeAnchorConfig(ctx, obj, 'ne', true)).toMatchObject({ cursor: 'nesw-resize' })
  })
})

describe('mediaRectConfig', () => {
  it('视频/audio 填充与描边区分；选中/高亮 → accent 2px', () => {
    const ctx = mk()
    const v = mediaRectConfig(ctx, { ...obj, type: 'video' })
    const a = mediaRectConfig(ctx, { ...obj, type: 'audio' })
    expect(v.fill).toBe('rgba(11,140,233,0.10)')
    expect(a.fill).toBe('rgba(11,140,233,0.07)')
    expect(v.stroke).toBe('rgba(11,140,233,0.55)')
    const selV = mediaRectConfig(ctx, { ...obj, id: 'sel', type: 'video' })
    expect(selV).toMatchObject({ stroke: '#0b8ce9', strokeWidth: 2 })
  })
})

describe('note 配置 + 调色板', () => {
  it('noteTextColor：亮底深字/深底浅字；非法色回退浅字', () => {
    expect(noteTextColor('#fef08a')).toBe('#171718') // yellow 亮
    expect(noteTextColor('#475569')).toBe('#e2e8f0') // slate 深
    expect(noteTextColor('')).toBe('#e2e8f0')
    expect(noteTextColor('xyz')).toBe('#e2e8f0')
  })

  it('noteRectConfig：默认 slate 0.9/圆角 8；LOD 缩略级（scale<0.3）降级', () => {
    const ctx = mk()
    const r = noteRectConfig(ctx, obj)
    expect(r).toMatchObject({ fill: NOTE_DEFAULT_COLOR, opacity: 0.9, cornerRadius: 8 })
    const low = noteRectConfig(mk({ scale: 0.2 }), obj)
    expect(low).toMatchObject({ opacity: 1, cornerRadius: 0 })
    // LOD 低描边为空串
    expect(low.stroke).toBe('')
  })

  it('noteTextConfig：@提及净化 + 亮色底深字；LOD 隐藏', () => {
    const r = noteTextConfig(mk(), { ...obj, text: '@[张三]{n1} 你好', color: '#fef08a' })
    expect(r.text).toBe('@张三 你好')
    expect(r.fill).toBe('#171718')
    expect(noteTextConfig(mk({ scale: 0.2 }), obj)).toEqual({ visible: false, listening: false })
  })

  it('NOTE_COLORS 8 色含默认 slate', () => {
    expect(NOTE_COLORS).toHaveLength(8)
    expect(NOTE_COLORS[7]).toBe(NOTE_DEFAULT_COLOR)
  })
})

describe('frame / shot 配置', () => {
  it('frame：选中实线 accent；未选中虚线 dash', () => {
    const ctx = mk()
    const sel = frameConfig(ctx, { ...obj, id: 'sel' })
    const idle = frameConfig(ctx, obj)
    expect(sel).toMatchObject({ stroke: '#0b8ce9', strokeWidth: 2 })
    expect(sel.dash).toBeUndefined()
    expect(idle).toMatchObject({ stroke: 'rgba(73,74,80,0.9)', dash: [8, 6] })
    // 标签：名字回退 Frame；LOD 隐藏
    expect(frameLabelConfig(ctx, obj).text).toBe('Frame')
    expect(frameLabelConfig(ctx, { ...obj, name: '场景B' }).text).toBe('场景B')
    expect(frameLabelConfig(mk({ scale: 0.2 }), obj)).toEqual({ visible: false, listening: false })
  })

  it('shot：序号 #n 回退 1；LOD 隐藏 seq/text', () => {
    const ctx = mk()
    expect(shotSeqConfig(ctx, obj).text).toBe('#1')
    expect(shotSeqConfig(ctx, { ...obj, seq: 7 }).text).toBe('#7')
    expect(shotTextConfig(ctx, { ...obj, text: '描述' }).text).toBe('描述')
    const low = mk({ scale: 0.2 })
    expect(shotSeqConfig(low, obj)).toEqual({ visible: false, listening: false })
    expect(shotTextConfig(low, obj)).toEqual({ visible: false, listening: false })
    // 选中态 accent
    expect(shotRectConfig(ctx, { ...obj, id: 'sel' })).toMatchObject({
      stroke: '#0b8ce9',
      strokeWidth: 2,
    })
  })
})
