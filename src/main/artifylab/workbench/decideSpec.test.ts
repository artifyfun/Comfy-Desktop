/**
 * decideInput / specText 单测（候选 ⑤ test surface）：
 * 输入解析纯函数（斜杠/预设/占位）与 spec 拼装（规则段条件注入）。
 */
import { describe, it, expect } from 'vitest'
import { resolveDecideInput } from './decideInput'
import {
  renderDecisionSpec,
  CANVAS_RUN_RULES,
  CANVAS_OPS_RULES,
  BATCH_RULE,
  TITLE_RULE,
  ORCHESTRATION_RULE,
  MEMORY_RULE,
  OUTPUT_CONTRACT
} from './specText'

const mkDeps = (presets: Record<string, { id: string; name: string }> = {}) => ({
  getPreset: (id: string) => (presets[id] ? ({ ...presets[id] } as never) : null),
  templates: [{ id: 't1', name: '模板一' }]
})

describe('resolveDecideInput', () => {
  it('无斜杠无预设：原文透传，占位仅空输入时生效', () => {
    const r = resolveDecideInput('画一只猫', mkDeps())
    expect(r.input).toBe('画一只猫')
    expect(r.templateShortcut).toBeUndefined()
    expect(r.preset).toBeUndefined()
  })

  it('空输入 → 附件占位提示', () => {
    const r = resolveDecideInput('   ', mkDeps())
    expect(r.input).toBe('按我上传的素材生成')
  })

  it('斜杠模板 token：剥离 + templateShortcut', () => {
    const r = resolveDecideInput('/t1 一只猫 其余话', mkDeps())
    if (r.templateShortcut === undefined) throw new Error('shortcut missing')
    expect(r.templateShortcut).toBe('t1')
    expect(r.input).toContain('一只猫')
    expect(r.input).not.toContain('/t1')
  })

  it('会话预设 id 有效时解析（无效 id → undefined）', () => {
    const deps = mkDeps({ p1: { id: 'p1', name: '预设一' } })
    const r = resolveDecideInput('hi', deps, { sessionPresetId: 'p1' })
    expect(r.preset?.id).toBe('p1')
    expect(r.presetId).toBe('p1')
    const r2 = resolveDecideInput('hi', deps, { sessionPresetId: 'nope' })
    expect(r2.preset).toBeUndefined()
  })
})

describe('renderDecisionSpec', () => {
  const base = {
    selfKnowledge: 'SELF.',
    entrySection: '',
    envSection: '',
    canvasSection: '',
    canvasRunRules: CANVAS_RUN_RULES,
    canvasOpsRules: '',
    chainHint: '',
    constraint: '',
    attachmentHint: '',
    docHint: '',
    batchRule: BATCH_RULE,
    shortcutHint: '',
    titleRule: TITLE_RULE,
    memoryRule: MEMORY_RULE,
    orchestrationRule: ORCHESTRATION_RULE,
    catalog: '- t1（模板一，image）',
    recent: '',
    memorySection: '',
    userInput: '画一只猫'
  }

  it('无画布段：画布规则整段省略（省 ~350 tok 语义不变）', () => {
    const spec = renderDecisionSpec(base)
    expect(spec).not.toContain('3.1 **把工作流加载到画布**')
    expect(spec).toContain(OUTPUT_CONTRACT)
    expect(spec).toContain('## 用户需求\n画一只猫')
    expect(spec).toContain('## 模板库')
  })

  it('有画布段：3.1-3.3 注入', () => {
    const spec = renderDecisionSpec({ ...base, canvasSection: '## 画布当前状态\n...' })
    expect(spec).toContain('3.1 **把工作流加载到画布**')
    expect(spec).toContain('3.3 **画布批量执行**')
  })

  it('有画布段 + a-canvas ops：3.4 注入', () => {
    const spec = renderDecisionSpec({
      ...base,
      canvasSection: '## 画布当前状态\n...',
      canvasOpsRules: CANVAS_OPS_RULES
    })
    expect(spec).toContain('3.4 **A 画布 App 节点操作**')
  })

  it('orchestration 段由调用方条件注入（空=省略）', () => {
    const spec = renderDecisionSpec({ ...base, orchestrationRule: '' })
    expect(spec).not.toContain('## 多步编排')
    const spec2 = renderDecisionSpec(base)
    expect(spec2).toContain('## 多步编排')
  })
})
