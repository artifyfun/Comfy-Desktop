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

const h = vi.hoisted(() => ({
  created: [] as Array<Record<string, unknown>>,
  updated: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  /** findAppsByName 的返回（模拟模板库里已有的同名模板） */
  sameName: [] as Array<{ id: string; name: string }>,
  /** getAppById 的可控返回值（按 id） */
  byId: new Map<string, { id: string; name: string }>(),
  /** currentAppVersion 的返回值 */
  version: 1
}))

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
    }),
    updateApp: vi.fn((id: string, patch: Record<string, unknown>) => {
      h.updated.push({ id, patch })
      return { id, name: '迭代中的模板', ...patch }
    }),
    getAppById: vi.fn((id: string) => h.byId.get(id)),
    findAppsByName: vi.fn(() => h.sameName)
  }
}))
// 版本号来自 gallery.db，测试里直接给定，避免碰真实用户数据
vi.mock('../appAssets', () => ({
  currentAppVersion: vi.fn(() => h.version)
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
  h.updated.length = 0
  h.sameName = []
  h.byId.clear()
  h.version = 1
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

/**
 * 迭代语义（2026-09-14 修）：此前固定 createApp → 「同一模板改一版再沉淀」只会不断
 * 产生同名重复 App，app_versions 永不累积，版本历史对 AI 沉淀的模板等于不可用。
 */
describe('publishWorkflow 迭代语义（同名 / 显式 app_id / force_new）', () => {
  it('同名唯一 → 迭代既有模板（走 updateApp，不新建）', () => {
    h.sameName = [{ id: 'app-existing', name: '我的画布工作流' }]
    h.version = 3

    const result = workbenchService.publishWorkflow('我的画布工作流', workflow)

    expect(result?.mode).toBe('versioned')
    expect(result?.appId).toBe('app-existing')
    expect(result?.version).toBe(3)
    expect(h.created).toHaveLength(0)
    expect(h.updated).toHaveLength(1)
    expect(h.updated[0]!.id).toBe('app-existing')
    // 新 template 真的被写入，且带上了推断出的输入参数
    const patch = h.updated[0]!.patch.template as { paramsNodes: Array<{ category: string }> }
    expect(patch.paramsNodes.some((n) => n.category === 'input')).toBe(true)
  })

  it('同名多个 → 不猜，改为新建（历史遗留重复交给调用方用 app_id 指定）', () => {
    h.sameName = [
      { id: 'app-a', name: 'w' },
      { id: 'app-b', name: 'w' }
    ]

    const result = workbenchService.publishWorkflow('w', workflow)

    expect(result?.mode).toBe('created')
    expect(h.updated).toHaveLength(0)
    expect(h.created).toHaveLength(1)
  })

  it('force_new → 即使同名唯一也新建（做变体而非迭代）', () => {
    h.sameName = [{ id: 'app-existing', name: 'w' }]

    const result = workbenchService.publishWorkflow('w', workflow, undefined, { forceNew: true })

    expect(result?.mode).toBe('created')
    expect(h.updated).toHaveLength(0)
    expect(h.created).toHaveLength(1)
  })

  it('显式 app_id → 迭代指定模板（同名的那一个不受影响）', () => {
    h.sameName = [{ id: 'app-by-name', name: 'w' }]
    h.byId.set('app-explicit', { id: 'app-explicit', name: '别的名字' })

    const result = workbenchService.publishWorkflow('w', workflow, undefined, {
      appId: 'app-explicit'
    })

    expect(result?.mode).toBe('versioned')
    expect(result?.appId).toBe('app-explicit')
    expect(h.updated[0]!.id).toBe('app-explicit')
  })

  it('app_id 不存在 → 返回 null，绝不静默新建', () => {
    const result = workbenchService.publishWorkflow('w', workflow, undefined, { appId: 'nope' })

    expect(result).toBeNull()
    expect(h.created).toHaveLength(0)
    expect(h.updated).toHaveLength(0)
  })

  it('无同名 → 新建，mode=created 且版本为 1', () => {
    const result = workbenchService.publishWorkflow('全新模板', workflow)

    expect(result?.mode).toBe('created')
    expect(result?.version).toBe(1)
  })

  it('显式 params_nodes 在迭代路径下同样生效', () => {
    h.sameName = [{ id: 'app-existing', name: 'w' }]
    const explicit = [
      { id: 6, name: 'my_prompt', category: 'input', type: 'string', renderComponent: 'textarea' }
    ] as never

    workbenchService.publishWorkflow('w', workflow, explicit)

    const patch = h.updated[0]!.patch.template as { paramsNodes: unknown[] }
    expect(patch.paramsNodes).toEqual(explicit)
  })
})
