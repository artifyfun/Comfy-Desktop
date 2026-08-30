import { describe, it, expect } from 'vitest'
import {
  templateFromApp,
  toPseudoApp,
  promptToWorkflowGraph,
  type WorkflowTemplate
} from './templateCore'
import type { App, ComfyPrompt } from '../appStore'

function makeApp(overrides: Partial<App> = {}): App {
  return {
    id: 'app1',
    name: '文生图',
    description: '基础文生图',
    createdAt: 0,
    updatedAt: 0,
    template: {
      prompt: {
        '1': {
          class_type: 'CheckpointLoaderSimple',
          inputs: { ckpt_name: 'flux1-dev.safetensors' }
        },
        '2': {
          class_type: 'CLIPTextEncode',
          inputs: { text: 'a cat', clip: ['1', 1] }
        },
        '3': {
          class_type: 'SaveImage',
          inputs: { filename_prefix: 'out', images: ['4', 0] }
        }
      },
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
          category: 'output',
          type: 'image',
          name: 'result',
          renderComponent: 'image-uploader'
        }
      ]
    },
    ...overrides
  }
}

describe('templateFromApp', () => {
  it('从 app 提取可执行模板', () => {
    const t = templateFromApp(makeApp())
    expect(t).not.toBeNull()
    expect(t!.id).toBe('app:app1')
    expect(t!.source).toBe('app')
    expect(t!.appId).toBe('app1')
    expect(t!.mediaType).toBe('image')
    expect(t!.requiredModels).toEqual(['flux1-dev.safetensors'])
    expect(t!.paramsNodes).toHaveLength(2)
  })

  it('无 template.prompt 的 app 返回 null', () => {
    const app = makeApp({ template: { paramsNodes: [] } })
    expect(templateFromApp(app)).toBeNull()
  })

  it('空 prompt 也返回 null', () => {
    const app = makeApp({ template: { prompt: {} as ComfyPrompt } })
    expect(templateFromApp(app)).toBeNull()
  })

  it('video-uploader 输出推断为 video 类型', () => {
    const app = makeApp()
    app.template!.paramsNodes = [
      { id: 3, category: 'output', type: 'video', name: 'v', renderComponent: 'video-uploader' }
    ]
    expect(templateFromApp(app)!.mediaType).toBe('video')
  })

  it('class_type 含 VHS_VideoCombine 推断为 video（无显式输出声明时）', () => {
    const app = makeApp()
    app.template!.paramsNodes = []
    app.template!.prompt = {
      '1': { class_type: 'VHS_VideoCombine', inputs: {} }
    }
    expect(templateFromApp(app)!.mediaType).toBe('video')
  })

  it('带媒体输入的模板标记 chainable', () => {
    const app = makeApp()
    app.template!.paramsNodes!.unshift({
      id: 9,
      category: 'input',
      type: 'image',
      name: '参考图',
      renderComponent: 'image-uploader'
    })
    const t = templateFromApp(app)
    expect(t?.chainable).toBe(true)
  })

  it('loader 节点提取模型依赖且去重', () => {
    const app = makeApp()
    app.template!.prompt = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } },
      '2': { class_type: 'LoraLoader', inputs: { lora_name: 'b.safetensors', model: ['1', 0] } },
      '3': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'a.safetensors' } }
    }
    expect(templateFromApp(app)!.requiredModels).toEqual(['a.safetensors', 'b.safetensors'])
  })
})

describe('toPseudoApp', () => {
  it('包装为 executor 可执行的 App 形状', () => {
    const t = templateFromApp(makeApp())!
    const pseudo = toPseudoApp(t)
    expect(pseudo.id).toBe('app:app1')
    expect(pseudo.template?.prompt).toBe(t.prompt)
    expect(pseudo.template?.paramsNodes).toBe(t.paramsNodes)
  })
})

describe('WorkflowTemplate 类型契约', () => {
  it('内置模板字段齐备（结构自检）', () => {
    const t: WorkflowTemplate = {
      id: 'builtin:demo',
      name: 'demo',
      description: 'demo template',
      mediaType: 'image',
      prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
      paramsNodes: [],
      source: 'builtin'
    }
    expect(t.id.startsWith('builtin:')).toBe(true)
  })
})

describe('promptToWorkflowGraph（画布布局兜底转换）', () => {
  it('prompt 节点 → graph nodes（id/type 保留，widgets 取标量，链接跳过）', () => {
    const prompt: ComfyPrompt = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
      '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['4', 0] } }
    }
    const g = promptToWorkflowGraph(prompt)
    expect(g.nodes).toHaveLength(3)
    expect(g.links).toEqual([])
    const nodes = g.nodes as Array<{
      id: number
      type: string
      widgets_values: unknown[]
    }>
    const n1 = nodes[0]!
    const n2 = nodes[1]!
    const n3 = nodes[2]!
    expect(n1.id).toBe(1)
    expect(n1.type).toBe('CheckpointLoaderSimple')
    expect(n1.widgets_values).toEqual(['flux1-dev.safetensors'])
    // 链接引用（数组）不落入 widgets_values
    expect(n2.widgets_values).toEqual(['a cat'])
    expect(n3.widgets_values).toEqual(['out'])
  })
})
