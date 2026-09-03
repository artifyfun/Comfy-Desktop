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
    for (const k of ['l', 'c', 'r']) for (const k2 of ['l', 'c', 'r']) tryPair(mv[k], ov[k2], 'x')
    const mh = { t: moving.y, c: moving.y + moving.height / 2, b: moving.y + moving.height }
    const oh = { t: o.y, c: o.y + o.height / 2, b: o.y + o.height }
    for (const k of ['t', 'c', 'b']) for (const k2 of ['t', 'c', 'b']) tryPair(mh[k], oh[k2], 'y')
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
    for (const a of mvx) for (const b of ovx) if (Math.abs(a - b) <= threshold) v.push(b)
    const mvy = [moving.y, moving.y + moving.height / 2, moving.y + moving.height]
    const ovy = [o.y, o.y + o.height / 2, o.y + o.height]
    for (const a of mvy) for (const b of ovy) if (Math.abs(a - b) <= threshold) h.push(b)
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

/**
 * 连线端点（参考 infinite-canvas ConnectionPath）：from 右边缘中点 → to 左边缘中点。
 * links: {id, from, to, kind?}; objects 按 id 索引；返回贝塞尔曲线端点。
 * 悬空连线（端点物件不存在）返回 null（渲染层跳过）。
 */
export function linkEndpoints(links, objects) {
  const byId = new Map(objects.map((o) => [o.id, o]))
  return links.map((l) => {
    const a = byId.get(l.from)
    const b = byId.get(l.to)
    if (!a || !b) return null
    return {
      ...l,
      x1: a.x + a.width,
      y1: a.y + a.height / 2,
      x2: b.x,
      y2: b.y + b.height / 2,
    }
  })
}

/**
 * 贝塞尔连线几何（参考 infinite-canvas ConnectionPath/ActiveConnectionPath）：
 * 水平曲率 curvature = max(|dx| * 0.5, 50)，控制点沿水平方向伸出。
 * 返回 Konva.Path 的 SVG d（可见层与命中层同形）。
 */
export function bezierLinkPath(x1, y1, x2, y2) {
  const dx = Math.abs(x2 - x1)
  const curvature = Math.max(dx * 0.5, 50)
  return `M ${x1} ${y1} C ${x1 + curvature} ${y1}, ${x2 - curvature} ${y2}, ${x2} ${y2}`
}

/**
 * 命中点 (px,py) 到线段 (x1,y1)-(x2,y2) 的距离（世界坐标）。
 * 连线点击删除/选中用，阈值由调用方按缩放换算。
 */
export function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  let t = lenSq === 0 ? 0 : ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const cx = x1 + t * dx
  const cy = y1 + t * dy
  return Math.hypot(px - cx, py - cy)
}

/**
 * 圈选裁剪：把世界坐标矩形换算为图片物件的源图像素区域。
 * img: 画布 image 物件（x/y/width/height/src）；rect 世界坐标矩形。
 * 相交为空返回 null；结果为 Konva 层裁剪 drawImage 参数。
 */
export function cropRectFor(img, rx, ry, rw, rh) {
  const left = Math.min(rx, rx + rw)
  const top = Math.min(ry, ry + rh)
  const right = Math.max(rx, rx + rw)
  const bottom = Math.max(ry, ry + rh)
  const ix2 = img.x + img.width
  const iy2 = img.y + img.height
  // 求交
  const cx1 = Math.max(img.x, left)
  const cy1 = Math.max(img.y, top)
  const cx2 = Math.min(ix2, right)
  const cy2 = Math.min(iy2, bottom)
  if (cx1 >= cx2 || cy1 >= cy2) return null
  const sx = ((cx1 - img.x) / img.width) * (img.naturalWidth || img.width)
  const sy = ((cy1 - img.y) / img.height) * (img.naturalHeight || img.height)
  const sw = ((cx2 - cx1) / img.width) * (img.naturalWidth || img.width)
  const sh = ((cy2 - cy1) / img.height) * (img.naturalHeight || img.height)
  return {
    sx,
    sy,
    sw,
    sh,
    // 画布上呈现的矩形（世界坐标）
    x: cx1,
    y: cy1,
    width: cx2 - cx1,
    height: cy2 - cy1,
  }
}

/** 序列化：画布文档 → 可持久化 JSON（v2：含连线/组合/降采样存档） */
export function serializeDoc(objects, viewport, name = 'Untitled', links = [], groups = []) {
  return JSON.stringify({
    version: 2,
    name,
    viewport: { scale: viewport.scale, x: viewport.x, y: viewport.y },
    objects: objects.map((o) => ({ ...o })),
    links: links.map((l) => ({ ...l })),
    groups: groups.map((g) => ({ ...g })),
  })
}

// —— 撤销/重做：有界快照栈（纯函数，UI 层负责调用时机） ——

/** 新建历史栈 */
export function createHistory(limit = 50) {
  return { past: [], future: [], limit }
}

/**
 * 记录一次变更：snapshot 为变更【后】的完整文档状态。
 * 返回新历史对象（不可变风格，方便测试）；容量超限丢最老。
 */
export function pushHistory(history, snapshot) {
  const past = [...history.past, snapshot]
  while (past.length > history.limit) past.shift()
  return { past, future: [], limit: history.limit }
}

/** 可撤销？ */
export function canUndo(history) {
  return history.past.length > 0
}

/** 可重做？ */
export function canRedo(history) {
  return history.future.length > 0
}

/**
 * 撤销：返回 { history, snapshot }；snapshot 为回退到的状态（栈顶前一个）。
 * 不可撤销时 snapshot 为 null。
 */
export function undo(history, current) {
  if (!history.past.length) return { history, snapshot: null }
  const past = [...history.past]
  const snapshot = past.pop()
  return {
    history: {
      past,
      future: [current, ...history.future].slice(0, history.limit),
      limit: history.limit,
    },
    snapshot,
  }
}

/** 重做：返回 { history, snapshot }；不可重做时 snapshot 为 null */
export function redo(history, current) {
  if (!history.future.length) return { history, snapshot: null }
  const future = [...history.future]
  const snapshot = future.shift()
  return {
    history: {
      past: [...history.past, current].slice(-history.limit),
      future,
      limit: history.limit,
    },
    snapshot,
  }
}

/** 反序列化：容忍残缺文档，坏档返回空文档（v1 档无 links/groups 字段 → 空数组） */
export function parseDoc(json) {
  const empty = () => ({
    version: 2,
    name: 'Untitled',
    viewport: makeViewport(),
    objects: [],
    links: [],
    groups: [],
  })
  try {
    const d = JSON.parse(json)
    if (!d || !Array.isArray(d.objects)) return empty()
    return {
      version: d.version ?? 1,
      name: d.name ?? 'Untitled',
      viewport: makeViewport(d.viewport?.scale ?? 1, d.viewport?.x ?? 0, d.viewport?.y ?? 0),
      objects: d.objects.filter((o) => o && typeof o.x === 'number' && typeof o.y === 'number'),
      links: Array.isArray(d.links)
        ? d.links.filter(
            (l) =>
              l &&
              typeof l.id === 'string' &&
              typeof l.from === 'string' &&
              typeof l.to === 'string',
          )
        : [],
      groups: Array.isArray(d.groups)
        ? d.groups
            .filter((g) => g && typeof g.id === 'string' && Array.isArray(g.members))
            .map((g) => ({ ...g, members: g.members.filter((m) => typeof m === 'string') }))
            .filter((g) => g.members.length > 1)
        : [],
    }
  } catch {
    return empty()
  }
}

// —— Frame 分区：几何与成员归属（纯函数） ——

/**
 * 判定物件中心是否落在 frame 矩形内（frame 为 {x,y,width,height} 世界坐标）。
 */
export function objectInFrame(obj, frame) {
  if (!obj || !frame) return false
  const cx = obj.x + (obj.width || 0) / 2
  const cy = obj.y + (obj.height || 0) / 2
  return (
    cx >= frame.x && cx <= frame.x + frame.width && cy >= frame.y && cy <= frame.y + frame.height
  )
}

/**
 * 列出 frame 内的所有物件 id（按 objects 数组顺序）。
 */
export function objectsInFrame(objects, frame) {
  return objects.filter((o) => objectInFrame(o, frame)).map((o) => o.id)
}

/**
 * 把一组物件按列网格排布：cols 列、cellW/cellH 单元、gapX/gapY 间距。
 * 返回 [{id, x, y}]（不含原物件其余字段）。
 */
export function gridLayout(ids, originX, originY, cellW, cellH, gapX, gapY, cols) {
  return ids.map((id, i) => ({
    id,
    x: originX + (i % cols) * (cellW + gapX),
    y: originY + Math.floor(i / cols) * (cellH + gapY),
  }))
}

// —— 版本树（同一源产物多次生成的变体链，纯函数） ——

/**
 * 从 links 中找出 rootId 的全部直接子产物 id。
 * links: [{id,from,to}]；方向 from=参考 → to=产物。
 */
export function childrenOf(links, rootId) {
  return links.filter((l) => l.from === rootId).map((l) => l.to)
}

/**
 * 以 root 为根的整棵产物树（BFS 多层），返回去重后的 id 数组（含根）。
 */
export function subtreeOf(links, rootId) {
  const seen = new Set([rootId])
  const queue = [rootId]
  while (queue.length) {
    const cur = queue.shift()
    for (const child of childrenOf(links, cur)) {
      if (!seen.has(child)) {
        seen.add(child)
        queue.push(child)
      }
    }
  }
  return [...seen]
}

// —— 节点级图像编辑（S6a）：纯几何计算 ——

/**
 * 切分布局：把 w×h 图按方向切成 n 份，返回每份源矩形（相对原点）。
 * direction: 'h' 横切（沿 x 均分）| 'v' 竖切（沿 y 均分）
 */
export function splitRects(w, h, n, direction = 'h') {
  const out = []
  const cnt = Math.max(1, Math.floor(n))
  if (direction === 'h') {
    const cw = w / cnt
    for (let i = 0; i < cnt; i++) out.push({ x: i * cw, y: 0, w: cw, h })
  } else {
    const ch = h / cnt
    for (let i = 0; i < cnt; i++) out.push({ x: 0, y: i * ch, w, h: ch })
  }
  return out
}

/** 旋转 90° 步进的输出尺寸（±90 交换宽高，180 不变） */
export function rotatedSize(w, h, deg) {
  const d = ((Math.round(deg / 90) % 4) + 4) % 4
  return d === 1 || d === 3 ? { w: h, h: w } : { w, h }
}

/** 四舍到像素且保正 */
export function px(v) {
  return Math.max(1, Math.round(v))
}

// —— 二期 A 组：媒体编辑纯几何 ——

/** 视频截帧时间点解析：first/last/current → 秒（last 留 1ms 余量防越界） */
export function videoFrameTime(position, duration, currentTime) {
  const dur = Math.max(0, Number(duration) || 0)
  if (position === 'first') return 0
  if (position === 'last') return Math.max(0, dur - 0.001)
  return Math.min(Math.max(0, Number(currentTime) || 0), Math.max(0, dur - 0.001))
}

/** 放大目标尺寸：长边对齐 target（clamp 1..maxEdge），短边按比例 */
export function upscaleSize(w, h, targetLongEdge, maxEdge = 8192) {
  const iw = Math.max(1, Math.round(w))
  const ih = Math.max(1, Math.round(h))
  const target = Math.min(maxEdge, Math.max(1, Math.round(targetLongEdge)))
  const scale = target / Math.max(iw, ih)
  return { width: Math.max(1, Math.round(iw * scale)), height: Math.max(1, Math.round(ih * scale)) }
}

// —— 三期 D1a：蒙版编辑纯几何/序列化 ——

/**
 * 笔刷笔触采样：pointer 事件流 → 归一化点列（canvas 像素坐标）。
 * 与参考实现 readCanvasPoint 一致：clientXY → rect 相对 → canvas 尺寸换算。
 */
export function maskCanvasPoint(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect()
  return {
    x: ((clientX - rect.left) / Math.max(1, rect.width)) * canvas.width,
    y: ((clientY - rect.top) / Math.max(1, rect.height)) * canvas.height,
  }
}

/** 笔刷大小夹取（8..160，步进 2 对齐参考 clampBrushSize） */
export function clampBrushSize(value) {
  return Math.min(160, Math.max(8, Math.round(value / 2) * 2))
}

/**
 * 重绘蒙版序列化（ComfyUI inpaint 兼容）：白底不透明 + 涂抹区 alpha 清零。
 * 语义：白=保留原图，透明=重绘区（喂 VAE Encode (for Inpainting) 的 mask）。
 */
export function buildInpaintMask(selectionCanvas) {
  const out = document.createElement('canvas')
  out.width = selectionCanvas.width
  out.height = selectionCanvas.height
  const ctx = out.getContext('2d', { willReadFrequently: true })
  const selCtx = selectionCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx || !selCtx) return out.toDataURL('image/png')
  ctx.fillStyle = '#fff'
  ctx.fillRect(0, 0, out.width, out.height)
  const sel = selCtx.getImageData(0, 0, out.width, out.height)
  const mask = ctx.getImageData(0, 0, out.width, out.height)
  for (let i = 3; i < mask.data.length; i += 4) {
    if (sel.data[i] > 0) mask.data[i] = 0
  }
  ctx.putImageData(mask, 0, 0)
  return out.toDataURL('image/png')
}

/** 蒙版是否有有效涂抹（任意像素 alpha>0）；全空返回 false 阻止提交 */
export function maskHasPaint(selectionCanvas) {
  const ctx = selectionCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return false
  const d = ctx.getImageData(0, 0, selectionCanvas.width, selectionCanvas.height).data
  for (let i = 3; i < d.length; i += 4) {
    if (d[i] > 0) return true
  }
  return false
}

/**
 * 蒙版涂抹区外接盒（返回 canvas 像素坐标盒或 null）。
 * 用途：把「原图裁到涂抹区 + mask」一起发工作台时收紧附件尺寸。
 */
export function maskPaintBounds(selectionCanvas, step = 4) {
  const ctx = selectionCanvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null
  const w = selectionCanvas.width
  const h = selectionCanvas.height
  const d = ctx.getImageData(0, 0, w, h).data
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (d[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x
        if (y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
      }
    }
  }
  if (minX === Infinity) return null
  return { x: minX, y: minY, width: maxX - minX + step, height: maxY - minY + step }
}

/**
 * 便签显示态净化：把 D1d 的 @ 提及标记 `@[label]{id}` 渲染为 `@label`
 *（编辑态仍存完整标记，collectUpstream 按标记取 id 喂上游）。
 * 非标记文本原样保留；未闭合的部分标记（手输一半）不动。
 */
export function stripMentionMarks(text) {
  return String(text ?? '').replace(/@\[([^\]]*)\]\{([^}]+)\}/g, '@$1')
}

/**
 * E5fix：resize 矩形纯函数（从 index.vue 抽出，修复南向角判定）。
 * 角名 nw/ne/sw/se：南北看首字母（startsWith 's'），东西看尾字母
 *（endsWith 'e'/'w'）—— 原实现南向误用 endsWith('s')，'se'/'sw' 均为
 * false，拖南向角时高度恒坍塌为 RESIZE_MIN。
 */
export function freeResizeRect(fixed, ptr, corner, minSize) {
  const right = corner.endsWith('e') ? Math.max(ptr.x, fixed.x + minSize) : fixed.x
  const bottom = corner.startsWith('s') ? Math.max(ptr.y, fixed.y + minSize) : fixed.y
  const left = corner.endsWith('e') ? fixed.x : Math.min(ptr.x, right - minSize)
  const top = corner.startsWith('s') ? fixed.y : Math.min(ptr.y, bottom - minSize)
  return { x: left, y: top, w: right - left, h: bottom - top }
}
/** 等比矩形：以固定角为锚，取指针主导轴定宽，h = w / ratio */
export function ratioResizeRect(fixed, ptr, corner, ratio, minSize) {
  const dirX = corner.endsWith('e') ? 1 : -1
  const dirY = corner.startsWith('s') ? 1 : -1
  const dx = Math.max(0, (ptr.x - fixed.x) * dirX)
  const dy = Math.max(0, (ptr.y - fixed.y) * dirY)
  if (dx === 0 && dy === 0) {
    const w = Math.max(minSize, minSize * ratio)
    return rectFromFixedCorner(fixed, corner, w, w / ratio)
  }
  const errByX = Math.abs(dy - dx / ratio)
  const errByY = Math.abs(dx - dy * ratio)
  const w =
    errByX <= errByY
      ? Math.max(dx, minSize * ratio, minSize)
      : Math.max(dy * ratio, minSize * ratio, minSize)
  return rectFromFixedCorner(fixed, corner, w, w / ratio)
}
export function rectFromFixedCorner(fixed, corner, w, h) {
  const x = corner.endsWith('e') ? fixed.x : fixed.x - w
  const y = corner.startsWith('s') ? fixed.y : fixed.y - h
  return { x, y, w, h }
}
