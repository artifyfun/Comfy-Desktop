import { describe, it, expect } from 'vitest'
import { validatePlanLocal } from './plan'
import type { WorkflowTemplate } from './templateCore'

const template: WorkflowTemplate = {
  id: 't1',
  name: 'T1',
  description: '',
  source: 'builtin',
  mediaType: 'image',
  prompt: { '1': { class_type: 'X', inputs: {} } },
  paramsNodes: [
    { id: 1, category: 'input', type: 'STRING', name: 'prompt' },
    { id: 2, category: 'input', type: 'INT', name: 'steps' },
    { id: 3, category: 'output', type: 'OUT', name: 'out' }
  ]
}

describe('validatePlanLocal batch', () => {
  it('合法 batch(2行,参数键有效)通过', () => {
    const r = validatePlanLocal(
      {
        intent: 'image',
        templateId: 't1',
        params: { prompt: 'base' },
        batch: { items: [{ prompt: 'A' }, { prompt: 'B', steps: 20 }] }
      },
      [template]
    )
    expect(r.ok).toBe(true)
    expect(r.template?.id).toBe('t1')
  })

  it('batch 少于 2 行被拒', () => {
    const r = validatePlanLocal(
      { intent: 'image', templateId: 't1', batch: { items: [{ prompt: 'A' }] } },
      [template]
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'batch')).toBe(true)
  })

  it('batch 超过 200 行被拒', () => {
    const rows = Array.from({ length: 201 }, (_, i) => ({ prompt: `p${i}` }))
    const r = validatePlanLocal({ intent: 'image', templateId: 't1', batch: { items: rows } }, [
      template
    ])
    expect(r.issues.some((i) => i.field === 'batch')).toBe(true)
  })

  it('sharedParams 非法参数名带 batch. 前缀报错', () => {
    const r = validatePlanLocal(
      {
        intent: 'image',
        templateId: 't1',
        batch: { items: [{ prompt: 'A' }, { prompt: 'B' }], sharedParams: { nope: 1 } }
      },
      [template]
    )
    expect(r.issues.some((i) => i.field.startsWith('batch.'))).toBe(true)
  })
})
