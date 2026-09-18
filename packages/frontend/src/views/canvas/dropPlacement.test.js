// @vitest-environment happy-dom
/**
 * 图片/媒体「落点 = 节点中心」语义（2026-09-18 修）
 *
 * 背景：图片入画布的三条路（文件拖入 / 粘贴 / 素材库拖出）此前落点语义不一致——
 * 素材库路径靠调用方硬编码 `x-130, y-90` 近似居中（非 260x180 的素材会偏），
 * 文件路径直接把落点当左上角。现统一为「落点 = 节点中心」，且居中在 probe 拿到
 * 真实尺寸后计算，不再依赖调用方猜尺寸。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { ref } from 'vue'
import { useCanvasAssets } from './useCanvasAssets'
import { useMediaNodes } from './useMediaNodes'

/** 桩 Image：赋值 src 时按设定的原始尺寸立即触发 onload */
function stubImage(naturalWidth, naturalHeight) {
  class FakeImage {
    set src(_v) {
      this.naturalWidth = naturalWidth
      this.naturalHeight = naturalHeight
      this.onload?.()
    }
    get src() {
      return 'stub-image'
    }
  }
  vi.stubGlobal('Image', FakeImage)
}

function assetsCtx() {
  const objects = ref([])
  return {
    ctx: {
      objects,
      selection: ref([]),
      viewport: ref({ scale: 1, x: 0, y: 0 }),
      size: { w: 1000, h: 600 },
      screenToWorld: (vp, x, y) => ({ x: x / vp.scale, y: y / vp.scale }),
      beforeChange: vi.fn(),
      saveSoon: vi.fn(),
      applyViewport: vi.fn(),
    },
    objects,
  }
}

function mediaCtx() {
  const objects = ref([])
  return {
    ctx: {
      objects,
      viewport: ref({ scale: 1, x: 0, y: 0 }),
      size: { w: 1000, h: 600 },
      worldToScreen: vi.fn(() => ({ x: 0, y: 0 })),
      saveSoon: vi.fn(),
      beforeChange: vi.fn(),
      message: { success: vi.fn(), info: vi.fn(), warning: vi.fn() },
      t: (k) => k,
      persistImage: vi.fn(),
      withCull: (fn) => (arr) => arr.filter(fn),
    },
    objects,
  }
}

const centerOf = (o) => [o.x + o.width / 2, o.y + o.height / 2]

beforeEach(() => {
  localStorage.clear()
  URL.createObjectURL = vi.fn(() => 'blob:stub')
})
afterEach(() => vi.unstubAllGlobals())

describe('insertAsset — 落点即中心（素材库 / 插入画布按钮）', () => {
  it('方形素材 260x260：中心落在落点上（旧的硬编码 -130/-90 会偏 40px）', () => {
    stubImage(260, 260)
    const { ctx, objects } = assetsCtx()
    useCanvasAssets(ctx).insertAsset({ persist: 'x' }, 500, 400)
    const o = objects.value[0]
    expect([o.width, o.height]).toEqual([260, 260])
    expect([o.x, o.y]).toEqual([370, 270])
    expect(centerOf(o)).toEqual([500, 400])
  })

  it('等比缩到 ≤260 宽的横图：中心仍落在落点', () => {
    stubImage(520, 340)
    const { ctx, objects } = assetsCtx()
    useCanvasAssets(ctx).insertAsset({ persist: 'x' }, 500, 400)
    const o = objects.value[0]
    expect([o.width, o.height]).toEqual([260, 170])
    expect(centerOf(o)).toEqual([500, 400])
  })

  it('入画布后自动选中该节点', () => {
    stubImage(100, 100)
    const { ctx } = assetsCtx()
    useCanvasAssets(ctx).insertAsset({ persist: 'x' }, 0, 0)
    expect(ctx.selection.value).toHaveLength(1)
  })
})

describe('addMediaFromFile — 落点即中心', () => {
  const file = (type, size = 10 * 1024 * 1024) => ({
    type,
    name: 'a.' + type.split('/')[1],
    size,
  })

  it('音频固定 280x96，以落点为中心', () => {
    const { ctx, objects } = mediaCtx()
    useMediaNodes(ctx).addMediaFromFile(file('audio/mpeg'), 500, 400)
    const o = objects.value[0]
    expect(o.type).toBe('audio')
    expect([o.x, o.y]).toEqual([360, 352])
    expect(centerOf(o)).toEqual([500, 400])
  })

  it('视频按元信息定尺寸后，仍以原落点为中心', () => {
    const { ctx, objects } = mediaCtx()
    class FakeVideo {
      set src(_v) {
        this.videoWidth = 1000
        this.videoHeight = 500
        this.onloadedmetadata?.()
      }
    }
    const orig = document.createElement.bind(document)
    const spy = vi
      .spyOn(document, 'createElement')
      .mockImplementation((tag) => (tag === 'video' ? new FakeVideo() : orig(tag)))
    useMediaNodes(ctx).addMediaFromFile(file('video/mp4'), 500, 400)
    const o = objects.value[0]
    // 宽度夹到 320，比例 1:2 → 160 高；中心必须还在 (500,400)
    expect([o.width, o.height]).toEqual([320, 160])
    expect(centerOf(o)).toEqual([500, 400])
    spy.mockRestore()
  })
})
