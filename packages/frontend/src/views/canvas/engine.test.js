import { describe, it, expect } from 'vitest'
import {
  makeViewport,
  clampScale,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  hitTest,
  hitTestRect,
  snapDelta,
  snapGuides,
  bboxOf,
  serializeDoc,
  parseDoc,
  linkEndpoints,
  bezierLinkPath,
  distToSegment,
  cropRectFor,
  splitRects,
  rotatedSize,
  videoFrameTime,
  upscaleSize,
  createHistory,
  pushHistory,
  undo,
  redo,
  canUndo,
  canRedo,
  objectInFrame,
  objectsInFrame,
  gridLayout,
  childrenOf,
  subtreeOf,
  clampBrushSize,
  maskHasPaint,
  maskPaintBounds,
  buildInpaintMask,
  maskCanvasPoint,
  stripMentionMarks,
  freeResizeRect,
  alignObjects,
  distributeObjects,
  zShiftObjects,
  gridArrangeImages,
  visibleIds,
  ratioResizeRect,
} from './engine'

describe('canvas engine: viewport', () => {
  it('screen<->world 往返一致', () => {
    const vp = makeViewport(1.5, 40, -20)
    const w = screenToWorld(vp, 100, 200)
    const s = worldToScreen(vp, w.x, w.y)
    expect(s.x).toBeCloseTo(100)
    expect(s.y).toBeCloseTo(200)
  })

  it('clampScale 限制范围', () => {
    expect(clampScale(0.01)).toBe(0.1)
    expect(clampScale(99)).toBe(4)
    expect(clampScale(1.5)).toBe(1.5)
  })

  it('zoomAtPoint 锚点世界坐标不动', () => {
    let vp = makeViewport(1, 0, 0)
    // 屏幕点 (300,200) 放大 2 倍
    const anchorWorld = screenToWorld(vp, 300, 200)
    vp = zoomAtPoint(vp, 2, 300, 200)
    const after = screenToWorld(vp, 300, 200)
    expect(after.x).toBeCloseTo(anchorWorld.x)
    expect(after.y).toBeCloseTo(anchorWorld.y)
    expect(vp.scale).toBe(2)
  })

  it('zoomAtPoint 触顶后 scale 封顶', () => {
    const vp = zoomAtPoint(makeViewport(3.9, 10, 10), 10, 0, 0)
    expect(vp.scale).toBe(4)
  })
})

describe('canvas engine: hit test', () => {
  const objs = [
    { id: 'a', x: 0, y: 0, width: 100, height: 80 },
    { id: 'b', x: 200, y: 100, width: 50, height: 50 },
  ]

  it('命中返回最上层', () => {
    expect(hitTest(objs, 10, 10)).toBe(0)
    expect(hitTest(objs, 210, 110)).toBe(1)
  })

  it('无命中返回 -1', () => {
    expect(hitTest(objs, 150, 50)).toBe(-1)
    expect(hitTest(objs, -1, -1)).toBe(-1)
  })

  it('旋转物件按反旋坐标命中', () => {
    // 90°(Konva 顺时针)旋转的 100x20 物件:局部 +x 轴指向世界 +y
    // 世界点 (-5,50) 反旋后落在局部 (50,5) 矩形内
    const rot = [{ id: 'r', x: 0, y: 0, width: 100, height: 20, rotation: 90 }]
    expect(hitTest(rot, -5, 50)).toBe(0)
    expect(hitTest(rot, 50, 5)).toBe(-1)
  })
})

describe('canvas engine: rect select', () => {
  const objs = [
    { id: 'a', x: 0, y: 0, width: 100, height: 80 },
    { id: 'b', x: 200, y: 100, width: 50, height: 50 },
    { id: 'c', x: -50, y: -50, width: 30, height: 30 },
  ]

  it('框选相交即命中', () => {
    // c 在 (-50,-50,30,30),框 (-10,-10,500,500) 与其不相交(只擦到 c 的右下角外)
    expect(hitTestRect(objs, -10, -10, 500, 500)).toEqual([0, 1])
    // (90,70,20,40) 只搭到 a 的右下角,够不到 b(200,100)
    expect(hitTestRect(objs, 90, 70, 20, 40)).toEqual([0])
  })

  it('反向拖拽框选同样有效', () => {
    expect(hitTestRect(objs, 210, 130, -30, -40)).toEqual([1])
    // (260,160,-70,-70) → 正向矩形 (190,90)-(260,160),完整罩住 b
    expect(hitTestRect(objs, 260, 160, -70, -70)).toEqual([1])
  })

  it('空区域无命中', () => {
    expect(hitTestRect(objs, 400, 400, 50, 50)).toEqual([])
  })
})

describe('canvas engine: snap', () => {
  it('x 向磁吸取最小差值边对', () => {
    const moving = { x: 108, y: 0, width: 50, height: 50 }
    const other = { x: 100, y: 200, width: 60, height: 60 }
    const { dx, dy } = snapDelta(moving, [other], 8)
    // 候选: ll=-8, cc=-3, rr=+2 → 最小绝对差 rr 胜出
    expect(dx).toBe(2)
    expect(dy).toBe(0)
  })

  it('中心对齐吸附', () => {
    const moving = { x: 146, y: 0, width: 50, height: 50 } // 中心 171
    const other = { x: 100, y: 200, width: 140, height: 60 } // 中心 170
    const { dx } = snapDelta(moving, [other], 8)
    expect(dx).toBe(-1)
  })

  it('超出阈值不吸附', () => {
    const moving = { x: 130, y: 0, width: 50, height: 50 }
    const other = { x: 100, y: 200, width: 60, height: 60 }
    const r = snapDelta(moving, [other], 8)
    expect(r.dx).toBe(0)
    expect(r.dy).toBe(0)
  })

  it('吸附产生参考线', () => {
    const moving = { x: 108, y: 0, width: 50, height: 50 }
    const other = { x: 100, y: 200, width: 60, height: 60 }
    const g = snapGuides(moving, [other], 8)
    expect(g.v).toContain(100)
  })
})

describe('canvas engine: bbox & doc', () => {
  it('bbox 覆盖所有物件', () => {
    const b = bboxOf([
      { x: 10, y: 20, width: 30, height: 40 },
      { x: -5, y: 0, width: 100, height: 10 },
    ])
    expect(b).toEqual({ x: -5, y: 0, width: 100, height: 60 })
  })

  it('空集合 bbox 为零矩形', () => {
    expect(bboxOf([])).toEqual({ x: 0, y: 0, width: 0, height: 0 })
  })

  it('serialize/parse 往返保留物件与视口', () => {
    const objs = [{ id: 'a', type: 'image', x: 1, y: 2, width: 3, height: 4, src: 'x.png' }]
    const doc = parseDoc(serializeDoc(objs, makeViewport(1.25, 9, -9), 'test'))
    expect(doc.name).toBe('test')
    expect(doc.viewport).toEqual({ scale: 1.25, x: 9, y: -9 })
    expect(doc.objects[0].src).toBe('x.png')
  })

  it('坏档降级为空文档不抛错', () => {
    expect(parseDoc('not-json').objects).toEqual([])
    expect(parseDoc('{"name":"x"}').objects).toEqual([])
    expect(parseDoc(null).objects).toEqual([])
    // 非法物件被过滤
    const doc = parseDoc('{"objects":[{"x":1,"y":2,"width":3,"height":4},{"bad":true}]}')
    expect(doc.objects).toHaveLength(1)
  })
})

describe('canvas engine: links', () => {
  const objs = [
    { id: 'a', type: 'image', x: 0, y: 0, width: 100, height: 80 },
    { id: 'b', type: 'image', x: 300, y: 200, width: 60, height: 60 },
  ]
  it('linkEndpoints 取左右边缘中点为端点（参考 infinite-canvas）', () => {
    const segs = linkEndpoints([{ id: 'L1', from: 'a', to: 'b' }], objs)
    expect(segs).toHaveLength(1)
    expect(segs[0].x1).toBe(100) // 0+100 from 右边缘
    expect(segs[0].y1).toBe(40) // 0+80/2
    expect(segs[0].x2).toBe(300) // to 左边缘
    expect(segs[0].y2).toBe(230) // 200+60/2
  })
  it('悬空连线返回 null（渲染层跳过）', () => {
    const segs = linkEndpoints([{ id: 'L', from: 'a', to: 'ghost' }], objs)
    expect(segs[0]).toBeNull()
  })
  it('bezierLinkPath 水平曲率 min(dx*0.5,50 兜底)', () => {
    // dx=200 → curvature=100
    expect(bezierLinkPath(100, 40, 300, 230)).toBe('M 100 40 C 200 40, 200 230, 300 230')
    // dx=20 → curvature 兜底 50
    expect(bezierLinkPath(0, 0, 20, 0)).toBe('M 0 0 C 50 0, -30 0, 20 0')
    // 反向（to 在 from 左侧）控制点仍向外伸
    expect(bezierLinkPath(300, 0, 100, 0)).toBe('M 300 0 C 400 0, 0 0, 100 0')
  })
  it('distToSegment 点到直线的垂直距离', () => {
    // 点 (1,2) 到线 (0,0)-(3,4)：|1*4-2*3|/5 = 2/5 = 0.4
    expect(distToSegment(1, 2, 0, 0, 3, 4)).toBeCloseTo(0.4)
  })
  it('distToSegment 垂足在线段外取端点距离', () => {
    expect(distToSegment(-5, 0, 0, 0, 10, 0)).toBe(5)
  })
  it('distToSegment 斜线几何正确', () => {
    // 线 (0,0)-(3,4)，点 (3,0)：|3*4-0*3|/5 = 2.4（垂足 t=0.6 在段内）
    expect(distToSegment(3, 0, 0, 0, 3, 4)).toBeCloseTo(2.4)
  })
})

describe('canvas engine: cropRectFor', () => {
  const img = {
    id: 'i',
    x: 0,
    y: 0,
    width: 200,
    height: 100,
    naturalWidth: 400,
    naturalHeight: 200,
  }
  it('世界矩形换算为源像素区域（2x 素材）', () => {
    const c = cropRectFor(img, 50, 25, 100, 50)
    expect(c.sx).toBe(100)
    expect(c.sy).toBe(50)
    expect(c.sw).toBe(200)
    expect(c.sh).toBe(100)
    expect(c.x).toBe(50)
    expect(c.y).toBe(25)
    expect(c.width).toBe(100)
  })
  it('不相交返回 null', () => {
    expect(cropRectFor(img, 500, 500, 10, 10)).toBeNull()
  })
  it('裁剪矩形超出图片边界时取交集', () => {
    const c = cropRectFor(img, -50, -50, 100, 100)
    expect(c.x).toBe(0)
    expect(c.y).toBe(0)
    expect(c.width).toBe(50)
    expect(c.height).toBe(50)
    expect(c.sw).toBe(100) // 50/200*400
  })
})

// —— P0/P2 新增：撤销栈 / Frame / 版本树 / 网格排布 ——

describe('createHistory / pushHistory / undo / redo', () => {
  it('undo 恢复上一个快照并把当前压入 future', () => {
    let h = createHistory(3)
    h = pushHistory(h, 'A')
    h = pushHistory(h, 'B')
    const r1 = undo(h, 'C')
    expect(r1.snapshot).toBe('B')
    expect(canRedo(r1.history)).toBe(true)
    // redo 回到 C
    const r2 = redo(r1.history, r1.snapshot)
    expect(r2.snapshot).toBe('C')
  })

  it('新变更清空 future（redo 失效）', () => {
    let h = createHistory(3)
    h = pushHistory(h, 'A')
    const r = undo(h, 'B')
    expect(r.snapshot).toBe('A')
    h = pushHistory(r.history, 'X')
    expect(canRedo(h)).toBe(false)
  })

  it('容量超限丢最老快照', () => {
    let h = createHistory(2)
    h = pushHistory(h, 'A')
    h = pushHistory(h, 'B')
    h = pushHistory(h, 'C')
    expect(h.past).toEqual(['B', 'C'])
    const r = undo(h, 'D')
    expect(r.snapshot).toBe('C')
  })

  it('空栈 undo/redo 返回 null snapshot', () => {
    const h = createHistory(3)
    expect(undo(h, 'X').snapshot).toBeNull()
    expect(redo(h, 'X').snapshot).toBeNull()
  })
})

describe('objectInFrame / objectsInFrame / gridLayout', () => {
  const frame = { x: 0, y: 0, width: 400, height: 300 }
  it('中心点判定归属', () => {
    expect(objectInFrame({ x: 180, y: 130, width: 40, height: 40 }, frame)).toBe(true)
    expect(objectInFrame({ x: 390, y: 130, width: 40, height: 40 }, frame)).toBe(false)
    expect(objectInFrame(null, frame)).toBe(false)
  })
  it('objectsInFrame 返回成员 id 列表', () => {
    const objs = [
      { id: 'a', x: 10, y: 10, width: 20, height: 20 },
      { id: 'b', x: 500, y: 10, width: 20, height: 20 },
      { id: 'c', x: 30, y: 30, width: 20, height: 20 },
    ]
    expect(objectsInFrame(objs, frame)).toEqual(['a', 'c'])
  })
  it('gridLayout 按列排布', () => {
    const out = gridLayout(['p1', 'p2', 'p3'], 100, 100, 80, 60, 20, 20, 2)
    expect(out[0]).toEqual({ id: 'p1', x: 100, y: 100 })
    expect(out[1]).toEqual({ id: 'p2', x: 200, y: 100 })
    expect(out[2]).toEqual({ id: 'p3', x: 100, y: 180 })
  })
})

describe('childrenOf / subtreeOf 版本树', () => {
  const links = [
    { id: 'l1', from: 'src', to: 'v1' },
    { id: 'l2', from: 'src', to: 'v2' },
    { id: 'l3', from: 'v1', to: 'v1a' },
  ]
  it('childrenOf 返回直接子代', () => {
    expect(childrenOf(links, 'src')).toEqual(['v1', 'v2'])
  })
  it('subtreeOf BFS 全树去重', () => {
    expect(subtreeOf(links, 'src').sort()).toEqual(['src', 'v1', 'v1a', 'v2'])
  })
})

describe('splitRects / rotatedSize（S6a 节点级图像编辑）', () => {
  it('横切 3 等分', () => {
    const r = splitRects(300, 100, 3, 'h')
    expect(r).toHaveLength(3)
    expect(r[0]).toEqual({ x: 0, y: 0, w: 100, h: 100 })
    expect(r[2].x).toBeCloseTo(200)
  })
  it('竖切 2 等分', () => {
    const r = splitRects(100, 200, 2, 'v')
    expect(r).toHaveLength(2)
    expect(r[1]).toEqual({ x: 0, y: 100, w: 100, h: 100 })
  })
  it('n<=0 保护', () => {
    expect(splitRects(10, 10, 0, 'h')).toHaveLength(1)
  })
  it('旋转尺寸交换', () => {
    expect(rotatedSize(640, 480, 90)).toEqual({ w: 480, h: 640 })
    expect(rotatedSize(640, 480, -90)).toEqual({ w: 480, h: 640 })
    expect(rotatedSize(640, 480, 180)).toEqual({ w: 640, h: 480 })
    expect(rotatedSize(640, 480, 450)).toEqual({ w: 480, h: 640 })
  })
})

describe('videoFrameTime / upscaleSize（二期 A 组媒体编辑）', () => {
  it('截帧时间点：first/last/current', () => {
    expect(videoFrameTime('first', 10, 3.5)).toBe(0)
    expect(videoFrameTime('last', 10, 3.5)).toBeCloseTo(9.999)
    expect(videoFrameTime('current', 10, 3.5)).toBe(3.5)
    expect(videoFrameTime('current', 10, 99)).toBeCloseTo(9.999) // clamp 到末尾
    expect(videoFrameTime('current', 0, 5)).toBe(0) // 无时长安全
  })
  it('放大尺寸：长边对齐 + 短边等比 + clamp', () => {
    expect(upscaleSize(256, 128, 1024)).toEqual({ width: 1024, height: 512 })
    expect(upscaleSize(128, 256, 1024)).toEqual({ width: 512, height: 1024 })
    expect(upscaleSize(2000, 1000, 1024)).toEqual({ width: 1024, height: 512 }) // 缩小也算
    expect(upscaleSize(10, 10, 99999)).toEqual({ width: 8192, height: 8192 }) // maxEdge clamp
  })
})

// —— 三期 D1a：蒙版编辑 ——

describe('clampBrushSize（D1a）', () => {
  it('夹取到 8..160 且步进 2', () => {
    expect(clampBrushSize(0)).toBe(8)
    expect(clampBrushSize(100)).toBe(100)
    expect(clampBrushSize(999)).toBe(160)
    expect(clampBrushSize(7)).toBe(8)
    expect(clampBrushSize(101)).toBe(102)
  })
})

describe('stripMentionMarks（E3 便签提及显示净化）', () => {
  it('把 @[label]{id} 净化为 @label', () => {
    expect(stripMentionMarks('看下 @[图片 main]{img_main} 的风格')).toBe('看下 @图片 main 的风格')
  })
  it('多标记与普通 @ 共存', () => {
    expect(stripMentionMarks('@[a]{x} 和 @[b]{y}，普通 @ 用户')).toBe('@a 和 @b，普通 @ 用户')
  })
  it('未闭合的手输标记保持原样', () => {
    expect(stripMentionMarks('草稿 @[未闭合')).toBe('草稿 @[未闭合')
  })
  it('空值安全', () => {
    expect(stripMentionMarks(undefined)).toBe('')
    expect(stripMentionMarks(null)).toBe('')
  })
})

describe('resize 矩形纯函数（E5fix：南向角高度坍塌回归）', () => {
  const fixed = { x: 100, y: 50 } // 固定角（世界坐标）
  it('拖 se 角：宽高都跟随指针（南向 startsWith 修正）', () => {
    const r = freeResizeRect(fixed, { x: 400, y: 300 }, 'se', 24)
    expect(r).toEqual({ x: 100, y: 50, w: 300, h: 250 })
  })
  it('拖 sw 角：向左下扩展，右上角不动', () => {
    const r = freeResizeRect(fixed, { x: 0, y: 300 }, 'sw', 24)
    expect(r).toEqual({ x: 0, y: 50, w: 100, h: 250 })
  })
  it('拖 ne/nw 角：向上扩展，南向边不动', () => {
    expect(freeResizeRect(fixed, { x: 400, y: 0 }, 'ne', 24)).toEqual({
      x: 100,
      y: 0,
      w: 300,
      h: 50,
    })
    expect(freeResizeRect(fixed, { x: 0, y: 0 }, 'nw', 24)).toEqual({ x: 0, y: 0, w: 100, h: 50 })
  })
  it('南向不坍塌：拖 se 越远高度越大（旧 bug h 恒 24）', () => {
    for (const dy of [50, 150, 400]) {
      const r = freeResizeRect(fixed, { x: 400, y: 50 + dy }, 'se', 24)
      expect(r.h).toBe(dy)
    }
  })
  it('等比模式 se 角：16:9 宽度主导', () => {
    const r = ratioResizeRect(fixed, { x: 420, y: 50 + (320 * 9) / 16 }, 'se', 16 / 9, 24)
    expect(r.w).toBeCloseTo(320)
    expect(r.h).toBeCloseTo(180)
    expect(r.x).toBe(100)
    expect(r.y).toBe(50)
  })
  it('等比模式指针贴固定角：最小尺寸兜底', () => {
    const r = ratioResizeRect(fixed, { x: 100, y: 50 }, 'se', 2, 24)
    expect(r.w).toBeGreaterThanOrEqual(24)
    expect(r.h).toBeGreaterThanOrEqual(12)
  })
})

// —— 多选对齐/分布/z 层级（P1）——
describe('多选对齐/分布/z 层级纯函数（P1）', () => {
  const A = { id: 'a', x: 0, y: 0, width: 100, height: 50 }
  const B = { id: 'b', x: 200, y: 80, width: 80, height: 60 }
  const C = { id: 'c', x: 400, y: 30, width: 60, height: 40 }
  const objs = [A, B, C]

  it('左对齐：全部 x 对齐最小 x', () => {
    const m = alignObjects(objs, ['a', 'b', 'c'], 'left')
    expect(m.get('a').x).toBe(0)
    expect(m.get('b').x).toBe(0)
    expect(m.get('c').x).toBe(0)
    expect(m.get('b').y).toBe(80) // y 不动
  })
  it('右对齐：右边缘对齐最大右缘', () => {
    const m = alignObjects(objs, ['a', 'b', 'c'], 'right')
    const maxR = 460
    expect(m.get('a').x).toBe(maxR - 100)
    expect(m.get('b').x).toBe(maxR - 80)
    expect(m.get('c').x).toBe(maxR - 60)
  })
  it('水平居中：中心对齐包围盒中心 230', () => {
    const m = alignObjects(objs, ['a', 'b', 'c'], 'hcenter')
    expect(m.get('a').x).toBe(230 - 50)
    expect(m.get('b').x).toBe(230 - 40)
    expect(m.get('c').x).toBe(230 - 30)
  })
  it('顶/底对齐', () => {
    const t = alignObjects(objs, ['a', 'b', 'c'], 'top')
    expect(t.get('b').y).toBe(0)
    const bt = alignObjects(objs, ['a', 'b', 'c'], 'bottom')
    expect(bt.get('a').y).toBe(140 - 50) // maxY=140
    expect(bt.get('b').y).toBe(140 - 60)
  })
  it('垂直居中', () => {
    const m = alignObjects(objs, ['a', 'b', 'c'], 'vcenter')
    const cy = (0 + 140) / 2
    expect(m.get('a').y).toBe(cy - 25)
    expect(m.get('c').y).toBe(cy - 20)
  })
  it('少于 2 个返回空映射', () => {
    expect(alignObjects(objs, ['a'], 'left').size).toBe(0)
  })
  it('水平等距分布：首尾不动，中间等距', () => {
    // a: [0,100] c: [400,460]，b 宽 80 → gap = (460-0-100-80-60)/2
    const objs2 = [
      { id: 'a', x: 0, y: 0, width: 100, height: 50 },
      { id: 'b', x: 120, y: 0, width: 80, height: 50 },
      { id: 'c', x: 400, y: 0, width: 60, height: 50 },
    ]
    const m = distributeObjects(objs2, ['a', 'b', 'c'], 'x')
    expect(m.get('a').x).toBe(0)
    expect(m.get('c').x).toBe(400)
    // span=460, totalSize=240, gap=(460-240)/2=110 → b.x = 100+110 = 210
    expect(m.get('b').x).toBe(210)
  })
  it('分布少于 3 个返回空', () => {
    expect(distributeObjects(objs, ['a', 'b'], 'x').size).toBe(0)
  })
  it('zShift front/back：选中块整体到顶/底', () => {
    const r1 = zShiftObjects(objs, ['a'], 'front')
    expect(r1.map((o) => o.id)).toEqual(['b', 'c', 'a'])
    const r2 = zShiftObjects(objs, ['c'], 'back')
    expect(r2.map((o) => o.id)).toEqual(['c', 'a', 'b'])
  })
  it('zShift forward/backward：与相邻层交换', () => {
    // [a,b,c] 选 b → forward: [a,c,b]
    const r1 = zShiftObjects(objs, ['b'], 'forward')
    expect(r1.map((o) => o.id)).toEqual(['a', 'c', 'b'])
    // backward: [b,a,c]
    const r2 = zShiftObjects(objs, ['b'], 'backward')
    expect(r2.map((o) => o.id)).toEqual(['b', 'a', 'c'])
  })
  it('zShift forward 连续块整体上移', () => {
    const objs3 = [
      { id: 'a', x: 0, y: 0, width: 1, height: 1 },
      { id: 'b', x: 0, y: 0, width: 1, height: 1 },
      { id: 'c', x: 0, y: 0, width: 1, height: 1 },
      { id: 'd', x: 0, y: 0, width: 1, height: 1 },
    ]
    // [a, b, c, d] 选 a,b（连续块）→ forward: a,b 与 c 交换 → [c, a, b, d]
    const r = zShiftObjects(objs3, ['a', 'b'], 'forward')
    expect(r.map((o) => o.id)).toEqual(['c', 'a', 'b', 'd'])
  })
  it('zShift forward 顶层不动', () => {
    const r = zShiftObjects(objs, ['c'], 'forward')
    expect(r.map((o) => o.id)).toEqual(['a', 'b', 'c'])
  })
})

// —— 批量图片分组（P2 gridArrangeImages）——
describe('gridArrangeImages（P2）', () => {
  const mk = (id, x, y, w, h) => ({ id, type: 'image', x, y, width: w, height: h })
  const objs = [
    mk('a', 100, 50, 200, 100),
    mk('b', 0, 300, 200, 200),
    mk('c', 500, 10, 200, 100),
    mk('d', 60, 90, 200, 300),
    mk('e', 700, 400, 200, 100),
  ]
  it('少于 2 个返回空', () => {
    expect(gridArrangeImages(objs, ['a'], {}).size).toBe(0)
  })
  it('默认 3 列网格 + 统一格宽等比', () => {
    const m = gridArrangeImages(objs, ['a', 'b', 'c', 'd', 'e'])
    expect(m.size).toBe(5)
    const a = m.get('a')
    const b = m.get('b')
    const c = m.get('c')
    const d = m.get('d')
    // 排序按 x: c(500)>… 实际排序 a(100) d(60)?… x 升序: b(0) d(60) a(100) c(500) e(700)
    // 行1: b d a；行2: c e
    expect([b.x, d.x, a.x]).toEqual([0, 284, 568])
    expect(b.y).toBe(0)
    expect(c.y).toBeGreaterThan(0)
    // 等比：b 原 1:1 → 260x260；d 原 200x300 → 260x390
    expect(b.height).toBe(260)
    expect(d.height).toBe(390)
    // 同行 y 一致
    expect(a.y).toBe(b.y)
  })
  it('cellW=0 只重排位置不改尺寸', () => {
    const m = gridArrangeImages(objs, ['a', 'b', 'c'], { cellW: 0 })
    const a = m.get('a')
    expect(a.width).toBeUndefined()
    expect(a.x).toBeGreaterThanOrEqual(0)
  })
  it('cols=2 两列排布', () => {
    const m = gridArrangeImages(objs, ['a', 'b', 'c', 'd'], { cols: 2 })
    // x 序: b(0) d(60) a(100) c(500) → 2 列：行1=b,d 行2=a,c
    expect(m.get('a').y).toBeGreaterThan(m.get('b').y)
    expect(m.get('c').y).toBe(m.get('a').y)
  })
})

// —— 视口裁剪（P2 visibleIds）——
describe('visibleIds（P2 视口裁剪）', () => {
  const objs = [
    { id: 'in1', x: 0, y: 0, width: 100, height: 100 },
    { id: 'in2', x: 500, y: 300, width: 50, height: 50 },
    { id: 'out', x: 5000, y: 5000, width: 100, height: 100 },
    { id: 'edge', x: 780, y: 0, width: 100, height: 100 }, // 视口右缘相交
  ]
  it('默认视口 scale=1 只含可见+缓冲', () => {
    const vp = { x: 0, y: 0, scale: 1 }
    const ids = visibleIds(objs, vp, { w: 800, h: 600 })
    expect(ids.has('in1')).toBe(true)
    expect(ids.has('in2')).toBe(true)
    expect(ids.has('out')).toBe(false)
    expect(ids.has('edge')).toBe(true) // 780 < 800+200
  })
  it('缩放视口（scale=0.5 可见范围翻倍）', () => {
    const vp = { x: 0, y: 0, scale: 0.5 }
    const ids = visibleIds(objs, vp, { w: 800, h: 600 }, 0)
    // 世界可见 1600x1200：out(5000) 仍不可见
    expect(ids.has('out')).toBe(false)
    expect(ids.has('in2')).toBe(true)
  })
  it('负偏移视口（向右平移看负区）', () => {
    // vp.x=-400：世界 x=400 位于屏幕左缘 → 可见区 [400,1200]
    const vp = { x: -400, y: 0, scale: 1 }
    const ids = visibleIds(
      [
        { id: 'inneg', x: -350, y: 0, width: 50, height: 50 }, // 世界负区，屏幕外
        { id: 'inpos', x: 500, y: 0, width: 50, height: 50 }, // 可见
      ],
      vp,
      { w: 800, h: 600 },
      0,
    )
    expect(ids.has('inneg')).toBe(false)
    expect(ids.has('inpos')).toBe(true)
  })
  it('空视口/零尺寸降级全量', () => {
    expect(visibleIds(objs, null, { w: 800, h: 600 }).size).toBe(4)
    expect(visibleIds(objs, { x: 0, y: 0, scale: 1 }, { w: 0, h: 0 }).size).toBe(4)
  })
  it('margin 扩大可见范围', () => {
    const vp = { x: 0, y: 0, scale: 1 }
    const ids = visibleIds(
      [{ id: 'far', x: 950, y: 0, width: 50, height: 50 }],
      vp,
      { w: 800, h: 600 },
      300,
    )
    expect(ids.has('far')).toBe(true) // 950 < 800+300
  })
})
