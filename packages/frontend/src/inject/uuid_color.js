// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export function uuidv4() {
  return ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, (a) =>
    (a ^ ((Math.random() * 16) >> (a / 4))).toString(16),
  )
}

export function getRandomColor() {
  return `#${`00000${((Math.random() * 0x1000000) << 0).toString(16)}`.substr(-6)}`
}

/**
 * v0.29 前端把 default_connection_color_byType 置空（{}），
 * determineLinkColor 全部落到默认单色 —— 所有输入/输出连接只有
 * 一种颜色。渲染逻辑优先读 link.color，这里按官方类型色表给每条
 * 链接上色，恢复按数据类型区分颜色的体验。
 */
export const LINK_TYPE_COLORS = {
  MODEL: '#b4a7d6',
  DIFFUSION_MODEL: '#b4a7d6',
  CLIP: '#ffd166',
  VAE: '#f79f9f',
  CONDITIONING: '#f4a261',
  LATENT: '#f9c7d4',
  IMAGE: '#64b5f6',
  MASK: '#81c784',
  MESH: '#6dd45c',
  NUMBER: '#9e9e9e',
  INT: '#9e9e9e',
  FLOAT: '#9e9e9e',
  STRING: '#d9a441',
  TEXT: '#d9a441',
  BOOLEAN: '#b06fb0',
  COMBO: '#b06fb0',
  AUDIO: '#7fb3d5',
  VIDEO: '#7fb3d5',
}
export function colorizeLinks() {
  try {
    const g = window.app && window.app.graph
    if (!g || !g.links) return
    for (const id of Object.keys(g.links)) {
      const link = g.links[id]
      if (!link) continue
      const color = LINK_TYPE_COLORS[link.type] || '#9e9e9e'
      if (link.color !== color) link.color = color
    }
    g.setDirtyCanvas && g.setDirtyCanvas(true, true)
  } catch (e) {
    console.warn('[ArtifyInject] colorizeLinks failed:', e)
  }
}

/**
 * v0.29 的槽（输入/输出小圆点）颜色走 default_connection_color_byType：
 * 官方只配了 IMAGE/MODEL/LATENT 等少数类型，STRING/FLOAT/INT/BOOLEAN
 * 和自定义类型全是空串 → getConnectedColor 落到 output_on（统一绿色），
 * 所以文本类工作流的输入/输出看起来只有一种颜色。把空项用类型色表
 * 填充，让槽颜色与链接颜色一致、按类型区分。
 */
export function colorizeCanvas() {
  try {
    const c = window.app && window.app.canvas
    if (!c) return
    if (!c.default_connection_color_byType) c.default_connection_color_byType = {}
    if (!c.default_connection_color_byTypeOff) c.default_connection_color_byTypeOff = {}
    const fallback = '#9e9e9e'
    const fill = (table) => {
      for (const key of Object.keys(table)) {
        if (!table[key]) table[key] = LINK_TYPE_COLORS[key] || fallback
      }
    }
    fill(c.default_connection_color_byType)
    fill(c.default_connection_color_byTypeOff)
    c.setDirtyCanvas && c.setDirtyCanvas(true, true)
  } catch (e) {
    console.warn('[ArtifyInject] colorizeCanvas failed:', e)
  }
}
