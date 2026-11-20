/**
 * nodeConfigs —— Konva 节点渲染配置派生（A2 config 层抽取）。
 *
 * 原 index.vue 内 11 个 *Config 函数（~250 行核心派生 + 注释）的纯函数化：
 * 状态依赖（selection/highlight/scale）全部参数化为一个 viewCtx 对象，
 * 派生逻辑零 Vue 响应式——可在纯 Node 单测锁定（此前 0 覆盖）。
 *
 * viewCtx 形状：
 *   { isSelected(id), isHighlighted(id), accent, scale }
 * accent 缺省 '#0b8ce9'（与 index.vue accentColor() 回退一致）。
 */
import { lodTextVisible, lodNoteRectStyle, stripMentionMarks } from './engine'

export function makeViewCtx({
  isSelected,
  isHighlighted,
  isHovered,
  accent = '#0b8ce9',
  scale = 1,
}) {
  return { isSelected, isHighlighted, isHovered: isHovered ?? isHighlighted, accent, scale }
}

/** 通用高亮描边（选中 > 高亮 > 默认） */
export function highlightStroke(viewCtx, o, defStroke = 'rgba(160,160,160,0.45)') {
  if (viewCtx.isSelected(o.id) || viewCtx.isHighlighted(o.id)) {
    return { stroke: viewCtx.accent, strokeWidth: 2 }
  }
  return { stroke: defStroke, strokeWidth: 1 }
}

/** 连接句柄 circle 配置（常驻渲染 opacity 控制 + hitFunc 动态热区） */
export function handleConfig(viewCtx, o, side, showHandles) {
  const hovered = viewCtx.isHovered(o.id)
  return {
    x: side === 'target' ? 0 : o.width,
    y: o.height / 2,
    radius: (hovered ? 7.5 : 6) / viewCtx.scale,
    fill: '#171718',
    stroke: '#a0a0a0',
    strokeWidth: 2 / viewCtx.scale,
    opacity: showHandles ? 1 : 0,
    cursor: 'crosshair',
    hitFunc(ctx, shape) {
      if (!showHandles) return
      const r = 12 / viewCtx.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}

/** 连线重连锚点配置（选中连线且非重连拖拽中才显现） */
export function linkAnchorConfig(viewCtx, seg, side, active) {
  return {
    x: side === 'from' ? seg.x1 : seg.x2,
    y: side === 'from' ? seg.y1 : seg.y2,
    radius: 6.5 / viewCtx.scale,
    fill: side === 'from' ? '#31b9f4' : '#a0a0a0', // 源端=accent-hover 目标端=中性灰
    stroke: '#171718',
    strokeWidth: 1.5 / viewCtx.scale,
    opacity: active ? 1 : 0,
    cursor: 'grab',
    hitFunc(ctx, shape) {
      if (!active) return
      const r = 22 / viewCtx.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}

/** 角柄 circle 配置（圆心外偏 10px 屏距；hitFunc 动态热区） */
export function resizeAnchorConfig(viewCtx, o, corner, visible) {
  const off = 10 / viewCtx.scale
  return {
    x: corner.endsWith('e') ? o.width + off : -off,
    y: corner.startsWith('s') ? o.height + off : -off,
    radius: 6 / viewCtx.scale,
    fill: '#ffffff',
    stroke: '#171718',
    strokeWidth: 1.5 / viewCtx.scale,
    opacity: visible ? 1 : 0,
    cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
    hitFunc(ctx, shape) {
      if (!visible) return
      const r = 20 / viewCtx.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}

/** 媒体（视频/音频占位）矩形配置 */
export function mediaRectConfig(viewCtx, o) {
  const sel = viewCtx.isSelected(o.id)
  return {
    width: o.width,
    height: o.height,
    fill: o.type === 'video' ? 'rgba(11,140,233,0.10)' : 'rgba(11,140,233,0.07)',
    stroke: sel
      ? viewCtx.accent
      : viewCtx.isHighlighted(o.id)
        ? viewCtx.accent
        : o.type === 'video'
          ? 'rgba(11,140,233,0.55)'
          : 'rgba(11,140,233,0.35)',
    strokeWidth: sel || viewCtx.isHighlighted(o.id) ? 2 : 1.5,
    cornerRadius: 10,
  }
}

// —— note 调色板与文字色（便签新配色可读性） ——

export const NOTE_COLORS = [
  '#fef08a', // yellow
  '#f9a8d4', // pink
  '#86efac', // green
  '#7dd3fc', // sky
  '#fdba74', // orange
  '#c4b5fd', // violet
  '#fda4af', // rose
  '#475569', // slate（默认）
]
export const NOTE_DEFAULT_COLOR = '#475569'

/** 按背景亮度选文字色：亮底深字 / 深底浅字 */
export function noteTextColor(bg) {
  const hex = String(bg || NOTE_DEFAULT_COLOR).replace('#', '')
  if (hex.length !== 6) return '#e2e8f0'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.55 ? '#171718' : '#e2e8f0'
}

export function noteRectConfig(viewCtx, o) {
  // LOD 缩略级降级（opacity 1 / 去圆角 / 去默认描边）
  const lowLod = lodNoteRectStyle(viewCtx.scale)
  return {
    width: o.width,
    height: o.height,
    fill: o.color || NOTE_DEFAULT_COLOR,
    opacity: lowLod ? 1 : 0.9,
    cornerRadius: lowLod ? 0 : 8,
    ...(lowLod ? highlightStroke(viewCtx, o, '') : highlightStroke(viewCtx, o)),
  }
}

export function noteTextConfig(viewCtx, o) {
  if (!lodTextVisible(viewCtx.scale)) return { visible: false, listening: false }
  return {
    text: stripMentionMarks(o.text || ''),
    width: o.width,
    height: o.height,
    padding: 10,
    fontSize: o.fontSize || 13,
    lineHeight: 1.4,
    fill: noteTextColor(o.color),
    align: 'left',
  }
}

// —— Frame 分区 / Shot 分镜卡 ——

export function frameConfig(viewCtx, o) {
  const sel = viewCtx.isSelected(o.id)
  return {
    width: o.width,
    height: o.height,
    fill: 'rgba(11,140,233,0.04)',
    stroke: sel ? viewCtx.accent : 'rgba(73,74,80,0.9)',
    strokeWidth: sel ? 2 : 1.5,
    ...(sel ? {} : { dash: [8, 6] }),
    cornerRadius: 10,
  }
}

export function frameLabelConfig(viewCtx, o) {
  if (!lodTextVisible(viewCtx.scale)) return { visible: false, listening: false }
  return {
    text: o.name || 'Frame',
    x: 10,
    y: -22,
    width: Math.max(40, o.width - 20),
    fontSize: 13,
    fill: '#a0a0a0',
    align: 'left',
    listening: false,
  }
}

export function shotRectConfig(viewCtx, o) {
  return {
    width: o.width,
    height: o.height,
    fill: 'rgba(11,140,233,0.06)',
    ...highlightStroke(viewCtx, o, 'rgba(73,74,80,0.9)'),
    strokeWidth: viewCtx.isSelected(o.id) ? 2 : 1.5,
    cornerRadius: 8,
  }
}

export function shotSeqConfig(viewCtx, o) {
  if (!lodTextVisible(viewCtx.scale)) return { visible: false, listening: false }
  return {
    text: `#${o.seq || 1}`,
    x: 8,
    y: 6,
    fontSize: 12,
    fontStyle: 'bold',
    fill: '#a0a0a0',
    listening: false,
  }
}

export function shotTextConfig(viewCtx, o) {
  if (!lodTextVisible(viewCtx.scale)) return { visible: false, listening: false }
  return {
    text: o.text || '',
    x: 8,
    y: 24,
    width: o.width - 16,
    height: o.height - 32,
    fontSize: 11,
    fill: '#a0a0a0',
    listening: false,
  }
}
