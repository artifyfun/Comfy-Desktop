import { describe, it, expect } from 'vitest'
import {
  templateFromApp,
  toPseudoApp,
  promptToWorkflowGraph,
  inferParamRoles,
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
  it('prompt 节点 → graph nodes（id/type/widgets/输入输出槽）+ links（引用边）+ 拓扑分层布局', () => {
    const prompt: ComfyPrompt = {
      '1': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-dev.safetensors' } },
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 1] } },
      '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['4', 0] } }
    }
    const g = promptToWorkflowGraph(prompt)
    expect(g.nodes).toHaveLength(3)
    const nodes = g.nodes as Array<{
      id: number
      type: string
      widgets_values: unknown[]
      inputs: Array<{ name: string; type: string }>
      outputs: Array<{ name: string; type: string }>
      pos: [number, number]
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
    // 槽定义：node1 被 node2 以 slot 1 引用 → 2 个输出槽（手工 connect 用）
    expect(n1.outputs).toEqual([
      { name: 'out0', type: 'default' },
      { name: 'out1', type: 'default' }
    ])
    // 输入槽只带 name/type（手工 connect 按名反查，不依赖 link 字段）
    expect(n2.inputs).toEqual([{ name: 'clip', type: 'default' }])
    // 连线：LiteGraph 数组元组 [link_id, origin_id, origin_slot, target_id,
    // target_slot, type, toKey]——toKey=目标输入键名（手工 connect 定位槽）
    expect(g.links).toEqual([
      [1, 1, 1, 2, 0, 'default', 'clip'],
      [2, 4, 0, 3, 0, 'default', 'images']
    ])
    // 拓扑分层：node3 引用了 node4（不存在→孤立 0 层）；node2 引用 node1 → node2 层 1
    const layer2 = nodes.find((n) => n.id === 2)!
    expect(layer2.pos[0]).toBeGreaterThan(n1.pos[0]) // node2 在 node1 右侧（更深层）
    // 层内不重叠：同层节点 y 错开
    expect(n3.pos[1]).not.toBe(n1.pos[1])
  })

  it('多节点链式 prompt 生成完整 links（destSlot 按键序编号）', () => {
    const prompt: ComfyPrompt = {
      '1': {
        class_type: 'UNETLoader',
        inputs: { unet_name: 'anima.safetensors', weight_dtype: 'default' }
      },
      '2': { class_type: 'CLIPLoader', inputs: { clip_name: 'qwen.safetensors', type: 'lumina2' } },
      '3': {
        class_type: 'KSampler',
        inputs: {
          seed: 42,
          steps: 28,
          cfg: 7,
          model: ['1', 0],
          positive: ['2', 0],
          latent_image: ['5', 0]
        }
      }
    }
    const g = promptToWorkflowGraph(prompt)
    // KSampler 3 个链接输入 → 3 条 link，destSlot 0/1/2 按键序
    expect(g.links).toHaveLength(3)
    const links = g.links as Array<[number, number, number, number, number, string, string]>
    expect(links.map((l) => l[4])).toEqual([0, 1, 2]) // target_slot
    expect(links.map((l) => [l[1], l[2]])).toEqual([
      [1, 0],
      [2, 0],
      [5, 0]
    ]) // origin
    expect(links.map((l) => l[6])).toEqual(['model', 'positive', 'latent_image']) // toKey
    // 被引用节点输出槽 = 最大被引 slot + 1
    const nodes = g.nodes as Array<{ id: number; outputs: Array<{ name: string }> }>
    expect(nodes.find((n) => n.id === 1)!.outputs).toEqual([{ name: 'out0', type: 'default' }])
    expect(nodes.find((n) => n.id === 2)!.outputs).toEqual([{ name: 'out0', type: 'default' }])
    // KSampler 输入槽按键序（手工 connect 按名反查）
    const ks = g.nodes as Array<{ id: number; inputs: Array<{ name: string }> }>
    expect(ks.find((n) => n.id === 3)!.inputs.map((i) => i.name)).toEqual([
      'model',
      'positive',
      'latent_image'
    ])
  })
})

describe('inferParamRoles（参数角色推断：防提示词误填路径槽）', () => {
  it('参数 → JS 透传 → LoadImageFromPath：重写为 image-uploader 并标注路径', () => {
    const prompt: ComfyPrompt = {
      '165': { class_type: 'CR Prompt Text', inputs: { prompt: '"D:\\a.jpg"' } },
      '126': {
        class_type: 'JavascriptExecutor',
        inputs: {
          enable: 'On',
          javascript_code: "return input1.replace(/\"/g, '');",
          input1: ['165', 0]
        }
      },
      '123': { class_type: 'LoadImageFromPath', inputs: { image: ['126', 0] } },
      '192': { class_type: 'PreviewImage', inputs: { images: ['123', 0] } }
    }
    const paramsNodes = [
      {
        id: 165,
        category: 'input' as const,
        type: 'CR Prompt Text',
        name: 'prompt',
        selectedWidget: { name: 'prompt', type: 'customtext' },
        description: '图片路径',
        renderComponent: 'textarea'
      }
    ]
    const out = inferParamRoles(prompt, paramsNodes)
    expect(out[0]!.renderComponent).toBe('image-uploader')
    expect(out[0]!.description).toContain('路径')
  })

  it('下游只有文本/输出节点：保持原 rc 不变', () => {
    const prompt: ComfyPrompt = {
      '2': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['1', 0] } },
      '3': { class_type: 'SaveImage', inputs: { filename_prefix: 'out', images: ['4', 0] } }
    }
    const paramsNodes = [
      {
        id: 2,
        category: 'input' as const,
        type: 'text',
        name: 'prompt',
        selectedWidget: { name: 'text', type: 'text' },
        renderComponent: 'textarea'
      }
    ]
    const out = inferParamRoles(prompt, paramsNodes)
    expect(out[0]!.renderComponent).toBe('textarea')
  })

  it('已标注 uploader 的素材槽不重复改写', () => {
    const prompt: ComfyPrompt = {
      '9': { class_type: 'LoadImage', inputs: { image: 'x.png' } }
    }
    const paramsNodes = [
      {
        id: 9,
        category: 'input' as const,
        type: 'image',
        name: '参考图',
        renderComponent: 'image-uploader'
      }
    ]
    const out = inferParamRoles(prompt, paramsNodes)
    expect(out[0]!.renderComponent).toBe('image-uploader')
    expect(out[0]!.description).toBeUndefined()
  })
})
