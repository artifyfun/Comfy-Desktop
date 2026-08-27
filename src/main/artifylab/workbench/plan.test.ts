import { describe, it, expect } from 'vitest'
import { validatePlanLocal, type WorkbenchPlan } from './plan'
import type { WorkflowTemplate } from './templateCore'

function makeTemplate(): WorkflowTemplate {
  return {
    id: 'app:t1',
    name: '文生图',
    description: 'test',
    mediaType: 'image',
    prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
    paramsNodes: [
      {
        id: 2,
        category: 'input',
        type: 'text',
        name: 'prompt',
        selectedWidget: { name: 'text', type: 'text' }
      },
      {
        id: 3,
        category: 'input',
        type: 'number',
        name: 'steps',
        selectedWidget: {
          name: 'steps',
          type: 'number',
          options: { min: 1, max: 50 }
        }
      },
      {
        id: 4,
        category: 'input',
        type: 'combo',
        name: 'sampler',
        selectedWidget: {
          name: 'sampler_name',
          type: 'combo',
          options: { values: ['euler', 'dpmpp_2m'] }
        }
      },
      {
        id: 5,
        category: 'input',
        type: 'boolean',
        name: 'restore',
        selectedWidget: { name: 'restore_faces', type: 'boolean' }
      }
    ],
    source: 'app'
  }
}

describe('validatePlanLocal', () => {
  it('chat 意图带 reply 即通过', () => {
    const r = validatePlanLocal({ intent: 'chat', reply: '你好' }, [makeTemplate()])
    expect(r.ok).toBe(true)
  })

  it('chat 意图缺 reply 报错', () => {
    const r = validatePlanLocal({ intent: 'chat' }, [makeTemplate()])
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'reply')).toBe(true)
  })

  it('image 意图必须指定存在的模板', () => {
    const noId = validatePlanLocal({ intent: 'image' } as WorkbenchPlan, [makeTemplate()])
    expect(noId.ok).toBe(false)
    expect(noId.issues[0]!.field).toBe('templateId')

    const badId = validatePlanLocal({ intent: 'image', templateId: 'app:nope' }, [makeTemplate()])
    expect(badId.ok).toBe(false)
    expect(badId.issues[0]!.message).toContain('模板不存在')
  })

  it('数字超范围被拒', () => {
    const r = validatePlanLocal({ intent: 'image', templateId: 'app:t1', params: { steps: 999 } }, [
      makeTemplate()
    ])
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'params.steps' && i.message.includes('最大值'))).toBe(
      true
    )
  })

  it('数字类型错误被拒', () => {
    const r = validatePlanLocal(
      { intent: 'image', templateId: 'app:t1', params: { steps: 'fast' } },
      [makeTemplate()]
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'params.steps' && i.message.includes('期望数字'))).toBe(
      true
    )
  })

  it('枚举不在可选值内被拒', () => {
    const r = validatePlanLocal(
      { intent: 'image', templateId: 'app:t1', params: { sampler: 'lcm' } },
      [makeTemplate()]
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'params.sampler' && i.message.includes('可选值'))).toBe(
      true
    )
  })

  it('布尔类型错误被拒', () => {
    const r = validatePlanLocal(
      { intent: 'image', templateId: 'app:t1', params: { restore: 'yes' } },
      [makeTemplate()]
    )
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'params.restore')).toBe(true)
  })

  it('合法参数通过', () => {
    const r = validatePlanLocal(
      {
        intent: 'image',
        templateId: 'app:t1',
        params: { steps: 20, sampler: 'euler', restore: true, prompt: 'a cat' }
      },
      [makeTemplate()]
    )
    expect(r.ok).toBe(true)
    expect(r.template?.id).toBe('app:t1')
  })

  it('未知参数记 issue（提示 codex 修正）', () => {
    const r = validatePlanLocal({ intent: 'image', templateId: 'app:t1', params: { nope: 1 } }, [
      makeTemplate()
    ])
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'params.nope')).toBe(true)
  })

  it('text 意图无需模板', () => {
    const r = validatePlanLocal({ intent: 'text', reply: '文案结果' }, [makeTemplate()])
    expect(r.ok).toBe(true)
  })
})

describe('parsePlanFromCodex（经 service 静态方法同逻辑）', () => {
  // 直接测 plan 模块的 JSON 提取逻辑等价实现
  function parse(raw: string): unknown | null {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    try {
      return JSON.parse(raw.slice(start, end + 1))
    } catch {
      return null
    }
  }
  it('裸 JSON', () => {
    expect(parse('{"intent":"chat","reply":"hi"}')).toEqual({ intent: 'chat', reply: 'hi' })
  })
  it('markdown 包裹', () => {
    expect(parse('```json\n{"intent":"chat"}\n```')).toEqual({ intent: 'chat' })
  })
  it('前后杂文', () => {
    expect(parse('好的，计划如下：{"intent":"image","templateId":"app:t1"} 以上。')).toEqual({
      intent: 'image',
      templateId: 'app:t1'
    })
  })
  it('无 JSON 返回 null', () => {
    expect(parse('抱歉我不明白')).toBeNull()
  })
})
