import { describe, expect, it } from 'vitest'

import { canApplyFix, diagnosisCategoryKey, diagnosisI18nKey, diagnosisText } from './diagnosis'

/**
 * M4 诊断卡纯函数层：分类 key 映射 / fixOps 按钮可见性 / 建议文案兜底。
 */
describe('diagnosis helpers', () => {
  it('已知分类原样映射', () => {
    expect(diagnosisCategoryKey('bad_param')).toBe('bad_param')
    expect(diagnosisCategoryKey('missing_model')).toBe('missing_model')
  })

  it('未知分类归一为 unknown（防服务端新增枚举时前端炸 key）', () => {
    expect(diagnosisCategoryKey('future_category')).toBe('unknown')
    expect(diagnosisCategoryKey(undefined)).toBe('unknown')
    expect(diagnosisI18nKey('future_category')).toBe('workbenchDiagCat_unknown')
  })

  it('canApplyFix：embed + 有 fixOps 才显示按钮', () => {
    const d = { suggestion: { fixOps: [{ type: 'setWidget', nodeId: '1', widget: 's', value: 'euler' }] } }
    expect(canApplyFix(d, true)).toBe(true)
    expect(canApplyFix(d, false)).toBe(false)
    expect(canApplyFix({ suggestion: {} }, true)).toBe(false)
    expect(canApplyFix(null, true)).toBe(false)
  })

  it('diagnosisText：服务端 text 优先，缺失按 kind 兜底', () => {
    expect(diagnosisText({ suggestion: { text: '服务端文案' } })).toBe('服务端文案')
    const fb = { manual: '人工处理', param_fix: '改参数' }
    expect(diagnosisText({ suggestion: { kind: 'param_fix' } }, fb)).toBe('改参数')
    expect(diagnosisText({ suggestion: { kind: 'auth' } }, fb)).toBe('人工处理')
    expect(diagnosisText(null, fb)).toBe('人工处理')
  })
})
