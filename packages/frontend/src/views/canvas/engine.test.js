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
