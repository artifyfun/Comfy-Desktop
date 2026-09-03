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
