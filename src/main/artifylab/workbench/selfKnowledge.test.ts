import { describe, it, expect } from 'vitest'
import { renderEnvSnapshot, SELF_KNOWLEDGE_TEXT } from './selfKnowledge'

describe('renderEnvSnapshot', () => {
  it('空环境给占位说明', () => {
    const out = renderEnvSnapshot({ appNames: [], modelsByType: {}, customNodes: [] })
    expect(out).toContain('空环境')
  })

  it('已固化技能与本地模型分段列出', () => {
    const out = renderEnvSnapshot({
      appNames: ['人像修复', '老照片上色'],
      modelsByType: { checkpoints: ['a.safetensors', 'b.gguf'], loras: ['x.safetensors'] },
      customNodes: ['VHS_VideoCombine'],
      vramGb: 16
    })
    expect(out).toContain('人像修复、老照片上色')
    expect(out).toContain('checkpoints]：a.safetensors、b.gguf')
    expect(out).toContain('loras]')
    expect(out).toContain('VHS_VideoCombine')
    expect(out).toContain('16GB')
  })

  it('模型超限截断并标注总数（防 prompt 膨胀）', () => {
    const names = Array.from({ length: 30 }, (_, i) => `m${i}.safetensors`)
    const out = renderEnvSnapshot(
      { appNames: [], modelsByType: { checkpoints: names }, customNodes: [] },
      12
    )
    expect(out).toContain('m0.safetensors')
    expect(out).toContain('等 30 个')
    expect(out).not.toContain('m29.safetensors、')
  })

  it('自定义节点超过 20 个只展示前 20 并计数', () => {
    const nodes = Array.from({ length: 25 }, (_, i) => `Node${i}`)
    const out = renderEnvSnapshot({ appNames: [], modelsByType: {}, customNodes: nodes })
    expect(out).toContain('Node19')
    expect(out).toContain('等 25 个')
    expect(out).not.toContain('Node24')
  })

  it('vramGb=0 视为无显卡省略该段', () => {
    const out = renderEnvSnapshot({ appNames: [], modelsByType: {}, customNodes: [], vramGb: 0 })
    expect(out).not.toContain('显存')
  })
})

describe('SELF_KNOWLEDGE_TEXT', () => {
  it('常驻能力说明覆盖联网检索与环境适配授权，且不再内嵌 JSON 格式（权威定义在 spec 规则段）', () => {
    expect(SELF_KNOWLEDGE_TEXT).toContain('联网搜索')
    expect(SELF_KNOWLEDGE_TEXT).toContain('环境快照')
    // JSON 契约只允许出现在 buildDecisionSpec 规则段（单一事实源，防两处漂移）
    expect(SELF_KNOWLEDGE_TEXT).not.toContain('"intent"')
  })
})
