import { describe, it, expect } from 'vitest'
import { isSoftwareRenderer } from './softRender'

describe('softRender 检测', () => {
  it('SwiftShader / Software / llvmpipe 渲染器字符串判软渲', () => {
    expect(isSoftwareRenderer('ANGLE (Google, Vulkan SwiftShader)')).toBe(true)
    expect(isSoftwareRenderer('Software Rasterizer')).toBe(true)
    expect(isSoftwareRenderer('llvmpipe (LLVM 15.0)')).toBe(true)
  })
  it('真实 GPU 渲染器字符串不判软渲', () => {
    expect(isSoftwareRenderer('ANGLE (Apple, ANGLE Metal Renderer: Apple M1 Pro)')).toBe(false)
    expect(isSoftwareRenderer('ANGLE (NVIDIA, Direct3D11 vs_5_0, NVIDIA GeForce RTX 3060)')).toBe(
      false,
    )
    expect(isSoftwareRenderer('')).toBe(false)
  })
})
