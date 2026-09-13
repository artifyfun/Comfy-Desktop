// @vitest-environment node
/**
 * 画布工作流 → 模板参数推断测试（对标建议 #8）。
 *
 * 关注点：文本槽命名（prompt/negative_prompt/prompt_2）、媒体槽识别与类型、
 * 数值白名单与优先级、链接输入跳过、参数上限与去重，以及与
 * plan.validatePlanLocal 的**兼容性**（推断出的参数必须真的能通过校验——
 * 否则固化出的模板一执行就被打回）。
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import { inferInputParamNodes } from './paramInfer'
import { validatePlanLocal } from './plan'
import type { ComfyPrompt, ParamNode } from '../appStore'

type Node = ComfyPrompt[string]

function node(class_type: string, inputs: Record<string, unknown>, title?: string): Node {
  return { class_type, inputs, ...(title ? { _meta: { title } } : {}) } as unknown as Node
}

describe('文本参数推断', () => {
  it('单个文本编码节点 → prompt（textarea + STRING 语义）', () => {
    const p = { '6': node('CLIPTextEncode', { text: 'a cat', clip: ['4', 1] }) }
    const params = inferInputParamNodes(p)
    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({
      id: 6,
      name: 'prompt',
      category: 'input',
      renderComponent: 'textarea',
      selectedWidget: { id: '6', name: 'text', type: 'string' }
    })
  })

  it('title 含 negative 的节点 → negative_prompt，且排在 positive 之后', () => {
    const p = {
      '7': node('CLIPTextEncode', { text: 'blurry', clip: ['4', 1] }, 'Negative'),
      '6': node('CLIPTextEncode', { text: 'a cat', clip: ['4', 1] }, 'Positive')
    }
    const params = inferInputParamNodes(p)
    expect(params.map((n) => n.name)).toEqual(['prompt', 'negative_prompt'])
    // selectedWidget.id 承载原节点 id（ParamNode 声明里未列出，故此处显式断言）
    expect((params[1]!.selectedWidget as { id?: string }).id).toBe('7')
  })

  it('中文「负」标题同样识别', () => {
    const p = {
      '1': node('CLIPTextEncode', { text: 'x', clip: ['9', 0] }, '正向提示词'),
      '2': node('CLIPTextEncode', { text: 'y', clip: ['9', 0] }, '负向提示词')
    }
    expect(inferInputParamNodes(p).map((n) => n.name)).toEqual(['prompt', 'negative_prompt'])
  })

  it('多个无标题文本节点 → prompt / prompt_2 / prompt_3', () => {
    const p = {
      a: node('CLIPTextEncode', { text: '1', clip: ['0', 0] }),
      b: node('CLIPTextEncode', { text: '2', clip: ['0', 0] }),
      c: node('CLIPTextEncode', { text: '3', clip: ['0', 0] })
    }
    const names = inferInputParamNodes(p).map((n) => n.name)
    expect(names).toEqual(['prompt', 'prompt_2', 'prompt_3'])
  })

  it('text 为链接（上游输出）时跳过——不可作为可填参数', () => {
    const p = { '1': node('CLIPTextEncode', { text: ['99', 0], clip: ['4', 1] }) }
    expect(inferInputParamNodes(p)).toEqual([])
  })

  it('T5 / PromptExpander 等变体节点一并识别', () => {
    const p = {
      '1': node('T5TextEncode', { text: 'x' }),
      '2': node('PromptExpander', { prompt: 'y' })
    }
    expect(inferInputParamNodes(p).map((n) => n.name)).toEqual(['prompt', 'prompt_2'])
  })
})

describe('媒体槽推断', () => {
  it('LoadImage → image 槽（image-uploader）', () => {
    const p = { '10': node('LoadImage', { image: 'face.png', upload: 'image' }) }
    const params = inferInputParamNodes(p)
    expect(params).toHaveLength(1)
    expect(params[0]).toMatchObject({
      id: 10,
      name: 'image',
      renderComponent: 'image-uploader',
      selectedWidget: { id: '10', name: 'image', type: 'string' }
    })
  })

  it('第二个媒体槽去重为 image_2（不串槽）', () => {
    const p = {
      '10': node('LoadImage', { image: 'a.png' }),
      '11': node('LoadImage', { image: 'b.png' })
    }
    expect(inferInputParamNodes(p).map((n) => n.name)).toEqual(['image', 'image_2'])
  })

  it('视频/音频加载器按类名判类型', () => {
    const p = {
      '20': node('VHS_LoadVideo', { video: 'clip.mp4' }),
      '21': node('LoadAudio', { audio: 'song.wav' })
    }
    const params = inferInputParamNodes(p)
    expect(params.map((n) => n.renderComponent)).toEqual(['video-uploader', 'audio-uploader'])
    expect(params.map((n) => n.name)).toEqual(['video', 'audio'])
  })

  it('LoadImage 的输入已是链接 → 不作为槽暴露', () => {
    const p = { '10': node('LoadImage', { image: ['5', 0] }) }
    expect(inferInputParamNodes(p)).toEqual([])
  })
})

describe('数值参数推断', () => {
  it('seed/steps/cfg 按优先级排序，且类型为小写 int/float（对齐校验器）', () => {
    const p = {
      '3': node('KSampler', { seed: 123, steps: 20, cfg: 7.5, denoise: 1, model: ['4', 0] })
    }
    const params = inferInputParamNodes(p)
    expect(params.map((n) => n.name)).toEqual(['seed', 'steps', 'cfg', 'denoise'])
    expect(params.find((n) => n.name === 'seed')!.selectedWidget?.type).toBe('int')
    expect(params.find((n) => n.name === 'cfg')!.selectedWidget?.type).toBe('float')
    // 关键：必须是小写，plan.validateParams 用严格相等判数值分支
    for (const n of params) {
      expect(['int', 'float']).toContain(n.selectedWidget?.type)
    }
  })

  it('尺寸与 batch_size 一并暴露，shift 收录', () => {
    const p = {
      '5': node('EmptyLatentImage', { width: 1024, height: 1024, batch_size: 1 }),
      '3': node('KSampler', { shift: 1.15 })
    }
    expect(
      inferInputParamNodes(p)
        .map((n) => n.name)
        .sort()
    ).toEqual(['batch_size', 'height', 'shift', 'width'])
  })

  it('白名单外的数值键不暴露（避免参数噪音）', () => {
    const p = {
      '3': node('KSampler', { strength: 0.8, temperature: 1.2, noise_offset: 0.1 })
    }
    expect(inferInputParamNodes(p)).toEqual([])
  })

  it('数值为链接或非数字字符串 → 跳过', () => {
    const p = {
      '3': node('KSampler', { seed: ['8', 0], steps: 'abc', cfg: 7 })
    }
    expect(inferInputParamNodes(p).map((n) => n.name)).toEqual(['cfg'])
  })

  it('数字字符串照收（部分工作流以字符串存数值）', () => {
    const p = { '3': node('KSampler', { steps: '30' }) }
    expect(inferInputParamNodes(p).map((n) => n.name)).toEqual(['steps'])
  })
})

describe('上限与排序', () => {
  it('超过 max 截断，且优先保留文本与媒体', () => {
    const p: Record<string, Node> = {
      '6': node('CLIPTextEncode', { text: 'x' }),
      '10': node('LoadImage', { image: 'a.png' }),
      '3': node('KSampler', { seed: 1, steps: 2, cfg: 3, denoise: 4 }),
      '5': node('EmptyLatentImage', { width: 8, height: 9, batch_size: 1, shift: 1 })
    }
    const params = inferInputParamNodes(p, 4)
    expect(params).toHaveLength(4)
    expect(params.map((n) => n.name)).toEqual(['prompt', 'image', 'seed', 'steps'])
  })

  it('max=0 → 空数组（显式关闭推断）', () => {
    const p = { '6': node('CLIPTextEncode', { text: 'x' }) }
    expect(inferInputParamNodes(p, 0)).toEqual([])
  })

  it('空 / 畸形 prompt → 空数组（不抛错）', () => {
    expect(inferInputParamNodes({} as ComfyPrompt)).toEqual([])
    expect(
      inferInputParamNodes({ '1': { class_type: '', inputs: {} } as unknown as Node })
    ).toEqual([])
  })
})

describe('与 validatePlanLocal 的兼容性（固化后可立即执行）', () => {
  const prompt: ComfyPrompt = {
    '4': node('CheckpointLoaderSimple', { ckpt_name: 'model.safetensors' }),
    '6': node('CLIPTextEncode', { text: 'a cat', clip: ['4', 1] }, 'Positive'),
    '7': node('CLIPTextEncode', { text: 'blurry', clip: ['4', 1] }, 'Negative'),
    '10': node('LoadImage', { image: 'ref.png' }),
    '5': node('EmptyLatentImage', { width: 1024, height: 1024, batch_size: 1 }),
    '3': node('KSampler', { seed: 42, steps: 20, cfg: 7.5, model: ['4', 0] }),
    '9': node('SaveImage', { images: ['3', 0] })
  } as unknown as ComfyPrompt

  const template = {
    id: 'app:published',
    name: '沉淀的工作流',
    description: '',
    mediaType: 'image' as const,
    prompt,
    paramsNodes: [
      ...inferInputParamNodes(prompt),
      // 输出节点（publishWorkflow 会合并 inferOutputParamNodes，这里等价构造）
      {
        id: 9,
        category: 'output' as const,
        type: 'output',
        name: 'result',
        renderComponent: 'image-uploader',
        selectedWidget: { id: '9', name: 'images' }
      }
    ] as ParamNode[],
    source: 'app' as const,
    appId: 'published'
  }

  it('推断出的参数名都能在模板里被识别（无「未知参数」）', () => {
    const names = inferInputParamNodes(prompt).map((n) => n.name)
    expect(names).toEqual([
      'prompt',
      'negative_prompt',
      'image',
      'seed',
      'steps',
      'cfg',
      'width',
      'height',
      'batch_size'
    ])

    const result = validatePlanLocal(
      {
        intent: 'image',
        templateId: 'app:published',
        params: {
          prompt: 'a dog',
          negative_prompt: 'blurry',
          image: 'ref.png',
          seed: 7,
          steps: 30,
          cfg: 6
        }
      },
      [template]
    )
    expect(result.issues.filter((i) => i.field.startsWith('params.'))).toEqual([])
  })

  it('数值参数被当数字校验（传字符串会报错，说明类型判定生效）', () => {
    const result = validatePlanLocal(
      { intent: 'image', templateId: 'app:published', params: { seed: 'not-a-number' } },
      [template]
    )
    expect(result.issues.some((i) => i.field === 'params.seed')).toBe(true)
  })

  it('媒体槽被当素材校验（传中文提示词会被拦，不会写进 LoadImage）', () => {
    const result = validatePlanLocal(
      { intent: 'image', templateId: 'app:published', params: { image: '一只猫的正面照' } },
      [template]
    )
    expect(result.issues.some((i) => i.field === 'params.image')).toBe(true)
  })
})
