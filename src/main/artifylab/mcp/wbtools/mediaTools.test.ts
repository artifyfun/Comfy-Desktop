import { describe, it, expect, vi } from 'vitest'

// 斩断 shared → workbench/service → server 的真实依赖链（与 previewEmit.test 同口径）
vi.mock('../../workbench/service', () => ({ workbenchService: {} }))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

import { analyzeRgba } from './mediaTools'

/** 构造 RGBA 位图的小工具：fill(px, x, y) 设单像素 */
function makeBitmap(
  w: number,
  h: number
): { bits: Uint8Array; set: (x: number, y: number, a: number) => void } {
  const bits = new Uint8Array(w * h * 4)
  return {
    bits,
    set(x, y, a) {
      bits[(y * w + x) * 4 + 3] = a
    }
  }
}

describe('analyzeRgba（资产 QC 纯分析）', () => {
  it('不透明图：coverage=1、semi=0、贴边、hasAlpha=false', () => {
    const { bits, set } = makeBitmap(10, 10)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 10; x++) set(x, y, 255)
    const r = analyzeRgba(bits, 10, 10)
    expect(r.coverage).toBe(1)
    expect(r.semiRatio).toBe(0)
    expect(r.hasAlpha).toBe(false)
    expect(r.touchesEdge).toBe(true)
    expect(r.subjectRatio).toBe(1)
  })

  it('居中主体透明图：Qwen21 口径指标正确', () => {
    const w = 100
    const h = 100
    const { bits, set } = makeBitmap(w, h)
    // 40x40 主体（x 30~69, y 30~69），1px 半透明描边（周长约 156 px）
    for (let y = 30; y < 70; y++) {
      for (let x = 30; x < 70; x++) {
        const edge = x === 30 || x === 69 || y === 30 || y === 69
        set(x, y, edge ? 128 : 255)
      }
    }
    const r = analyzeRgba(bits, w, h)
    expect(r.hasAlpha).toBe(true)
    // 主体占比 1600/10000 = 0.16（<0.4 → 应触发口径建议）
    expect(r.subjectRatio).toBeCloseTo(0.16, 5)
    // 半透明 156/10000 = 0.0156 <0.03（不触发）
    expect(r.semiRatio).toBeCloseTo(0.0156, 5)
    expect(r.touchesEdge).toBe(false)
    // 四边距 30/100 = 0.3
    expect(r.margins.left).toBeCloseTo(0.3, 5)
    expect(r.margins.right).toBeCloseTo(0.3, 5)
  })

  it('贴边主体：touchesEdge=true 且对应边 margin=0', () => {
    const { bits, set } = makeBitmap(10, 10)
    for (let y = 0; y < 10; y++) for (let x = 0; x < 5; x++) set(x, y, 255)
    const r = analyzeRgba(bits, 10, 10)
    expect(r.touchesEdge).toBe(true)
    expect(r.margins.left).toBe(0)
  })

  it('全透明空图：无主体，margins 兜底为 1', () => {
    const { bits } = makeBitmap(8, 8)
    const r = analyzeRgba(bits, 8, 8)
    expect(r.coverage).toBe(0)
    expect(r.subjectRatio).toBe(0)
    expect(r.touchesEdge).toBe(false)
    expect(r.margins.left).toBe(1)
  })
})
