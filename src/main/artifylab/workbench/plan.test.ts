import { describe, it, expect } from 'vitest'
import { parsePlanFromCodexText, validatePlanLocal, type WorkbenchPlan } from './plan'
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

  it('workflow 意图必须指定存在的模板', () => {
    const ok = validatePlanLocal({ intent: 'workflow', templateId: 'app:t1' }, [makeTemplate()])
    expect(ok.ok).toBe(true)
    expect(ok.template?.id).toBe('app:t1')

    const noId = validatePlanLocal({ intent: 'workflow' } as WorkbenchPlan, [makeTemplate()])
    expect(noId.ok).toBe(false)
    expect(noId.issues[0]!.field).toBe('templateId')

    const badId = validatePlanLocal({ intent: 'workflow', templateId: 'app:nope' }, [
      makeTemplate()
    ])
    expect(badId.ok).toBe(false)
    expect(badId.issues[0]!.message).toContain('模板不存在')
  })

  it('canvas-run 不校验模板，nodeOverrides 宽松放行', () => {
    const ok = validatePlanLocal(
      { intent: 'canvas-run', nodeOverrides: { '16': { widgetOverrides: { steps: 40 } } } },
      []
    )
    expect(ok.ok).toBe(true)
  })

  it('canvas-run 批量：items ≥2 且为数组', () => {
    const ok = validatePlanLocal(
      { intent: 'canvas-run', batch: { items: [{ '16.steps': 20 }, { '16.steps': 40 }] } },
      []
    )
    expect(ok.ok).toBe(true)

    const tooFew = validatePlanLocal({ intent: 'canvas-run', batch: { items: [{}] } }, [])
    expect(tooFew.ok).toBe(false)
    expect(tooFew.issues[0]!.field).toBe('batch')
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

describe('parsePlanFromCodexText（真实 decide 输出形态回归）', () => {
  const planLine = (text: string) =>
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'item_3', type: 'agent_message', text }
    })

  it('ThreadEvent NDJSON：从 agent_message.text 提取 PLAN', () => {
    const raw = [
      JSON.stringify({ type: 'thread.started', thread_id: 'x' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i0', type: 'error', message: 'meta not found' }
      }),
      JSON.stringify({ type: 'turn.started' }),
      JSON.stringify({
        type: 'item.completed',
        item: { id: 'i2', type: 'reasoning', text: '用户要画猫…' }
      }),
      planLine('{"intent":"image","templateId":"app:t1","params":{},"reason":"画图","reply":""}'),
      JSON.stringify({ type: 'turn.completed', usage: { total_tokens: 100 } })
    ].join('\n')
    expect(parsePlanFromCodexText(raw)).toMatchObject({ intent: 'image', templateId: 'app:t1' })
  })

  it('NDJSON 多条 agent_message：取最后一条有效的', () => {
    const raw = [
      planLine('我理解你想画图'),
      planLine('{"intent":"chat","reason":"模板为空"}')
    ].join('\n')
    expect(parsePlanFromCodexText(raw)).toMatchObject({ intent: 'chat' })
  })

  it('纯文本形态（text-delta 流）：整体提取 {...}', () => {
    expect(parsePlanFromCodexText('好的：{"intent":"text"} 完成')).toMatchObject({ intent: 'text' })
  })

  it('markdown 围栏包裹仍可用', () => {
    expect(parsePlanFromCodexText('```json\n{"intent":"audio"}\n```')).toMatchObject({
      intent: 'audio'
    })
  })

  it('无 PLAN 返回 null', () => {
    expect(parsePlanFromCodexText(JSON.stringify({ type: 'turn.failed', error: 'x' }))).toBeNull()
  })
})

describe('memory intent 校验', () => {
  it('remember 合法通过', () => {
    const r = validatePlanLocal(
      {
        intent: 'memory',
        memory: { action: 'remember', key: 'preferred-style', value: '赛博朋克风' }
      },
      []
    )
    expect(r.ok).toBe(true)
  })
  it('remember 缺 value 拒绝', () => {
    const r = validatePlanLocal({ intent: 'memory', memory: { action: 'remember', key: 'x' } }, [])
    expect(r.ok).toBe(false)
    expect(r.issues.some((i) => i.field === 'memory.value')).toBe(true)
  })
  it('forget 缺 key 拒绝', () => {
    const r = validatePlanLocal({ intent: 'memory', memory: { action: 'forget', key: '' } }, [])
    expect(r.ok).toBe(false)
  })
  it('value 超 500 字拒绝', () => {
    const r = validatePlanLocal(
      { intent: 'memory', memory: { action: 'remember', key: 'x', value: '长'.repeat(501) } },
      []
    )
    expect(r.ok).toBe(false)
  })
})
