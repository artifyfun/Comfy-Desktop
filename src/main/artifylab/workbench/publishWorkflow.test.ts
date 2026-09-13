// @vitest-environment node
/**
 * publishWorkflow 固化契约测试（对标建议 #8）。
 *
 * 验证胶水真的接上了：缺省推断必须同时包含**输入参数**（提示词/seed/尺寸/素材槽）
 * 与**输出节点**——否则固化出的模板改不了任何东西，「沉淀即复用」不成立。
 * 显式传 params_nodes 时仍以调用方为准（不覆盖用户/模型的精确控制）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ created: [] as Array<Record<string, unknown>> }))

vi.mock('electron', () => ({
  app: { getAppPath: () => '', getPath: () => tmpdir(), on: vi.fn(), once: vi.fn() }
}))
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188' })),
    on: vi.fn(),
    createApp: vi.fn((input: Record<string, unknown>) => {
      h.created.push(input)
      return { id: 'app-published', ...input }
    })
  }
}))
vi.mock('../server', () => ({
  default: {},
  startServer: vi.fn(async () => null),
  getServer: vi.fn(() => null),
  getServerPort: vi.fn(() => null)
}))
vi.mock('./skillDeploy', () => ({ deployWorkbenchSkills: vi.fn() }))
vi.mock('../mcp/workbenchTools', () => ({
  decideSessions: new Set<string>(),
  beginWorkbenchToolContext: vi.fn(),
  endWorkbenchToolContext: vi.fn()
}))
vi.mock('../services/batchRunner', () => ({
  listBatchQueue: () => [],
  startBatchJob: vi.fn()
}))

import { workbenchService } from './service'
import type { ComfyPrompt } from '../appStore'

/** 一条"用户/AI 在画布上搭出来"的典型工作流：文生图 + 参考图 */
const workflow = {
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '10': { class_type: 'LoadImage', inputs: { image: 'ref.png' } },
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 20, model: ['4', 0] } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
} as unknown as ComfyPrompt

beforeEach(() => {
  h.created.length = 0
})

describe('publishWorkflow 缺省推断', () => {
  it('固化出的模板同时带输入参数与输出节点（沉淀即可填参复用）', () => {
    const app = workbenchService.publishWorkflow('我的画布工作流', workflow)
    expect(app).toBeTruthy()

    const template = h.created[0]!.template as {
      prompt: ComfyPrompt
      paramsNodes: Array<{ name: string; category: string; renderComponent?: string }>
    }
    const inputs = template.paramsNodes.filter((n) => n.category === 'input').map((n) => n.name)
    const outputs = template.paramsNodes.filter((n) => n.category === 'output')

    // 输入参数：文本 + 素材槽 + seed/steps（#8 的关键，此前只有输出节点）
    expect(inputs).toEqual(['prompt', 'image', 'seed', 'steps'])
    // 输出节点仍在（产物提取白名单）
    expect(outputs).toHaveLength(1)
    expect(template.prompt).toBe(workflow)
  })

  it('素材槽在固化结果里是 uploader 语义（执行时会被当素材校验）', () => {
    workbenchService.publishWorkflow('w', workflow)
    const paramsNodes = (h.created[0]!.template as { paramsNodes: Array<Record<string, unknown>> })
      .paramsNodes
    const imageSlot = paramsNodes.find((n) => n.name === 'image')!
    expect(imageSlot.renderComponent).toBe('image-uploader')
    expect(imageSlot.category).toBe('input')
  })

  it('显式 params_nodes 优先（不叠加推断，尊重精确控制）', () => {
    const explicit = [
      { id: 6, name: 'my_prompt', category: 'input', type: 'string', renderComponent: 'textarea' }
    ] as never
    workbenchService.publishWorkflow('w', workflow, explicit)
    const paramsNodes = (h.created[0]!.template as { paramsNodes: unknown[] }).paramsNodes
    expect(paramsNodes).toEqual(explicit)
  })

  it('app 名称与 prompt 被原样落库', () => {
    workbenchService.publishWorkflow('赛博朋克人像', workflow)
    expect(h.created[0]!.name).toBe('赛博朋克人像')
    expect((h.created[0]!.template as { prompt: ComfyPrompt }).prompt).toBe(workflow)
  })
})
