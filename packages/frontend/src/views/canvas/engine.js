/**
 * A 界面无限画布——引擎基座（纯函数，无 Konva 依赖）
 *
 * viewport 变换、命中检测、几何吸附、序列化。
 * 全部可单测；Konva 层只负责渲染与事件转发，逻辑都在这里。
 */

/** 视口状态：screen = world * scale + {x,y} */
export function makeViewport(scale = 1, x = 0, y = 0) {
  return { scale, x, y }
}

/** 限制缩放范围 */
export function clampScale(scale, min = 0.1, max = 4) {
  return Math.min(max, Math.max(min, scale))
}

/** 屏幕坐标 → 世界坐标 */
export function screenToWorld(vp, sx, sy) {
  return { x: (sx - vp.x) / vp.scale, y: (sy - vp.y) / vp.scale }
}

/** 世界坐标 → 屏幕坐标 */
export function worldToScreen(vp, wx, wy) {
  return { x: wx * vp.scale + vp.x, y: wy * vp.scale + vp.y }
}

/** 以屏幕点 (cx,cy) 为锚缩放：锚点世界坐标缩放前后不动 */
export function zoomAtPoint(vp, factor, cx, cy, min = 0.1, max = 4) {
  const scale = clampScale(vp.scale * factor, min, max)
  const applied = scale / vp.scale
  return {
    scale,
    x: cx - (cx - vp.x) * applied,
    y: cy - (cy - vp.y) * applied,
  }
}

/**
 * 命中检测：返回命中的最上层物件 index（后绘制在上，数组序即层级），
 * 无命中返回 -1。objects: {id,type,x,y,width,height,rotation?}
 */
export function hitTest(objects, wx, wy) {
  for (let i = objects.length - 1; i >= 0; i--) {
    const o = objects[i]
    const w = o.width ?? 0
    const h = o.height ?? 0
    let lx = wx - o.x
    let ly = wy - o.y
    if (o.rotation) {
      const rad = (-o.rotation * Math.PI) / 180
      const cos = Math.cos(rad)
      const sin = Math.sin(rad)
      const rx = lx * cos - ly * sin
      ly = lx * sin + ly * cos
      lx = rx
    }
    if (lx >= 0 && lx <= w && ly >= 0 && ly <= h) return i
  }
  return -1
}

/** 矩形（世界坐标）命中的物件集合（框选用） */
export function hitTestRect(objects, rx, ry, rw, rh) {
  const left = Math.min(rx, rx + rw)
  const right = Math.max(rx, rx + rw)
  const top = Math.min(ry, ry + rh)
  const bottom = Math.max(ry, ry + rh)
  const hits = []
  objects.forEach((o, i) => {
    const w = o.width ?? 0
    const h = o.height ?? 0
    if (o.x < right && o.x + w > left && o.y < bottom && o.y + h > top) hits.push(i)
  })
  return hits
}

/**
 * 吸附：拖动物件时对其它物件边缘/画布原点做磁吸。
 * 返回 {dx,dy} 附加位移；threshold 为世界坐标阈值（不随缩放变）。
 */
export function snapDelta(moving, others, threshold = 8) {
  const eps = 0.01
  let best = null
  const tryPair = (a, b, axis) => {
    const d = b - a
    if (Math.abs(d) <= threshold && (!best || Math.abs(d) < Math.abs(best.d))) {
      best = { axis, d }
    }
  }
  let dx = 0
  let dy = 0
  // x 轴：moving 左/中/右 vs other 左/中/右
  for (const o of others) {
    const mv = { l: moving.x, c: moving.x + moving.width / 2, r: moving.x + moving.width }
    const ov = { l: o.x, c: o.x + o.width / 2, r: o.x + o.width }
    for (const k of ['l', 'c', 'r'])
      for (const k2 of ['l', 'c', 'r']) tryPair(mv[k], ov[k2], 'x')
    const mh = { t: moving.y, c: moving.y + moving.height / 2, b: moving.y + moving.height }
    const oh = { t: o.y, c: o.y + o.height / 2, b: o.y + o.height }
    for (const k of ['t', 'c', 'b'])
      for (const k2 of ['t', 'c', 'b']) tryPair(mh[k], oh[k2], 'y')
  }
  if (best) {
    if (best.axis === 'x') dx = best.d
    else dy = best.d
  }
  if (Math.abs(dx) < eps) dx = 0
  if (Math.abs(dy) < eps) dy = 0
  return { dx, dy }
}

/** 对齐参考线：吸附时需要绘制的线（世界坐标，竖线 x 或横线 y） */
export function snapGuides(moving, others, threshold = 8) {
  const v = []
  const h = []
  for (const o of others) {
    const mvx = [moving.x, moving.x + moving.width / 2, moving.x + moving.width]
    const ovx = [o.x, o.x + o.width / 2, o.x + o.width]
    for (const a of mvx)
      for (const b of ovx)
        if (Math.abs(a - b) <= threshold) v.push(b)
    const mvy = [moving.y, moving.y + moving.height / 2, moving.y + moving.height]
    const ovy = [o.y, o.y + o.height / 2, o.y + o.height]
    for (const a of mvy)
      for (const b of ovy)
        if (Math.abs(a - b) <= threshold) h.push(b)
  }
  return { v: [...new Set(v)], h: [...new Set(h)] }
}

/** 物件集合的世界包围盒 */
export function bboxOf(objects) {
  if (!objects.length) return { x: 0, y: 0, width: 0, height: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const o of objects) {
    minX = Math.min(minX, o.x)
    minY = Math.min(minY, o.y)
    maxX = Math.max(maxX, o.x + (o.width ?? 0))
    maxY = Math.max(maxY, o.y + (o.height ?? 0))
  }
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY }
}

/** 序列化：画布文档 → 可持久化 JSON（版本号前置，向后兼容迁移用） */
export function serializeDoc(objects, viewport, name = 'Untitled') {
  return JSON.stringify({
    version: 1,
    name,
    viewport: { scale: viewport.scale, x: viewport.x, y: viewport.y },
    objects: objects.map((o) => ({ ...o })),
  })
}

/** 反序列化：容忍残缺文档，坏档返回空文档 */
export function parseDoc(json) {
  try {
    const d = JSON.parse(json)
    if (!d || !Array.isArray(d.objects)) return { version: 1, name: 'Untitled', viewport: makeViewport(), objects: [] }
    return {
      version: d.version ?? 1,
      name: d.name ?? 'Untitled',
      viewport: makeViewport(d.viewport?.scale ?? 1, d.viewport?.x ?? 0, d.viewport?.y ?? 0),
      objects: d.objects.filter((o) => o && typeof o.x === 'number' && typeof o.y === 'number'),
    }
  } catch {
    return { version: 1, name: 'Untitled', viewport: makeViewport(), objects: [] }
  }
}
