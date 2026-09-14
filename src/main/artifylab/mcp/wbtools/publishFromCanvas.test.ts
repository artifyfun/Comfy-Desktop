// @vitest-environment node
/**
 * wb_publish_workflow 的「按 prompt_id 沉淀画布执行」测试（对标建议 #8 补完）。
 *
 * 链路：画布执行 → /api/canvas/execute 暂存 workflow 快照 → 工具按 prompt_id 取回
 * → publishWorkflow（自动参数化）→ 回传可填参数名。canvasWorkflowStore 用真实实现，
 * 验证「暂存 → 取回」这一环确实接得上。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  published: [] as Array<{ name: string; workflow: unknown; opts?: Record<string, unknown> }>,
  /** 工具结果里的 mode/version 由 mock 决定，便于断言透传 */
  resultMode: 'created' as 'created' | 'versioned',
  resultVersion: 1,
  /** 设为 true 模拟「目标 App 不存在」的失败返回 */
  failPublish: false
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => '' } }))
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('../../workbench/service', () => ({
  workbenchService: {
    getSession: vi.fn((id: string) => (id ? { id } : null)),
    publishWorkflow: vi.fn(
      (name: string, workflow: unknown, _paramsNodes?: unknown, opts?: Record<string, unknown>) => {
        h.published.push({ name, workflow, opts })
        if (h.failPublish) return null
        return {
          app: {
            id: 'app-published',
            name,
            template: {
              paramsNodes: [
                { name: 'prompt', category: 'input' },
                { name: 'seed', category: 'input' },
                { name: 'result', category: 'output' }
              ]
            }
          },
          appId: 'app-published',
          mode: h.resultMode,
          version: h.resultVersion
        }
      }
    )
  }
}))
vi.mock('../../appStore', () => ({ default: { getConfig: () => ({}) } }))
vi.mock('../../services/batchRunner', () => ({
  listBatchQueue: () => [],
  type: {}
}))

import { lifecycleTools } from './lifecycleTools'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from './shared'
import { canvasWorkflowStore } from '../../workbench/canvasWorkflowStore'
import type { ComfyPrompt } from '../../appStore'

const publishTool = lifecycleTools.find((t) => t.tool.name === 'wb_publish_workflow')!

/** 模拟画布上手动搭出来并跑通的一条工作流 */
const canvasWorkflow = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
  '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
  '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
} as unknown as ComfyPrompt

function payload(res: unknown): Record<string, unknown> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Record<
    string,
    unknown
  >
}

beforeEach(() => {
  h.published.length = 0
  h.resultMode = 'created'
  h.resultVersion = 1
  h.failPublish = false
  canvasWorkflowStore.clear()
  endWorkbenchToolContext('s1')
  beginWorkbenchToolContext('s1')
})

describe('prompt_id 模式：沉淀画布执行', () => {
  it('命中快照 → 用该 workflow 固化，并回传可填参数名', async () => {
    canvasWorkflowStore.remember('p-canvas-1', canvasWorkflow)

    const out = payload(
      await publishTool.fn({ name: '我的画布流程', prompt_id: 'p-canvas-1' }, 's1')
    )

    expect(out.ok).toBe(true)
    expect(out.source).toBe('canvas')
    expect(out.app_id).toBe('app-published')
    // 关键：传给 publishWorkflow 的正是画布那份快照（不是空对象/别的）
    expect(h.published[0]!.workflow).toBe(canvasWorkflow)
    // 只回传 input 类参数（output 节点不混进来）
    expect(out.input_params).toEqual(['prompt', 'seed'])
  })

  it('promptId 驼峰别名可用', async () => {
    canvasWorkflowStore.remember('p-camel', canvasWorkflow)
    const out = payload(await publishTool.fn({ name: 'w', promptId: 'p-camel' }, 's1'))
    expect(out.ok).toBe(true)
    expect(out.source).toBe('canvas')
  })

  it('快照未命中 → 不固化，返回可读原因 + 兜底指引', async () => {
    const out = payload(await publishTool.fn({ name: 'w', prompt_id: 'p-missing' }, 's1'))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('未找到 prompt_id=p-missing 的画布工作流快照')
    expect(String(out.hint)).toContain('重新在画布上执行')
    expect(h.published).toHaveLength(0)
  })

  it('两者都不给 → 明确报错（不再把 workflow 当必填）', async () => {
    const out = payload(await publishTool.fn({ name: 'w' }, 's1'))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('至少提供一个')
    expect(h.published).toHaveLength(0)
  })

  it('缺 name → 报错且不固化', async () => {
    canvasWorkflowStore.remember('p1', canvasWorkflow)
    const out = payload(await publishTool.fn({ name: '  ', prompt_id: 'p1' }, 's1'))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('name required')
    expect(h.published).toHaveLength(0)
  })
})

describe('显式 workflow 模式（回归）', () => {
  it('传 workflow → source=workflow，且优先于 prompt_id', async () => {
    canvasWorkflowStore.remember('p-other', canvasWorkflow)
    const explicit = { '1': { class_type: 'SaveImage', inputs: {} } } as unknown as ComfyPrompt

    const out = payload(
      await publishTool.fn({ name: 'w', workflow: explicit, prompt_id: 'p-other' }, 's1')
    )

    expect(out.ok).toBe(true)
    expect(out.source).toBe('workflow')
    expect(h.published[0]!.workflow).toBe(explicit)
  })

  it('workflow 为数组等非法值 → 回退到 prompt_id 分支', async () => {
    canvasWorkflowStore.remember('p-fallback', canvasWorkflow)
    const out = payload(
      await publishTool.fn({ name: 'w', workflow: [1, 2, 3], prompt_id: 'p-fallback' }, 's1')
    )
    expect(out.ok).toBe(true)
    expect(out.source).toBe('canvas')
  })
})

describe('未在 decide 会话内调用', () => {
  it('外部无身份调用被拒（会话门）', async () => {
    endWorkbenchToolContext('s1')
    await expect(publishTool.fn({ name: 'w', prompt_id: 'p1' })).rejects.toThrow(
      /outside decide session/
    )
  })
})

/**
 * 迭代语义（2026-09-14）：工具要把「新建 or 迭代」与生效版本号如实回传，
 * 并把 app_id / force_new 透传到 service——否则模型无法知道刚才发生了什么，
 * 也无法定向迭代某个模板。
 */
describe('迭代语义透传（mode / version / app_id / force_new）', () => {
  it('回传 mode 与 version（迭代时为 versioned + 递增版本号）', async () => {
    h.resultMode = 'versioned'
    h.resultVersion = 4
    canvasWorkflowStore.remember('p1', canvasWorkflow)

    const out = payload(await publishTool.fn({ name: 'w', prompt_id: 'p1' }, 's1'))

    expect(out.ok).toBe(true)
    expect(out.mode).toBe('versioned')
    expect(out.version).toBe(4)
  })

  it('app_id 透传到 publishWorkflow（定向迭代）', async () => {
    canvasWorkflowStore.remember('p1', canvasWorkflow)

    await publishTool.fn({ name: 'w', prompt_id: 'p1', app_id: 'app-target' }, 's1')

    expect(h.published[0]!.opts).toEqual({ appId: 'app-target', forceNew: false })
  })

  it('app_id 驼峰别名同样可用', async () => {
    canvasWorkflowStore.remember('p1', canvasWorkflow)

    await publishTool.fn({ name: 'w', prompt_id: 'p1', appId: 'app-camel' }, 's1')

    expect(h.published[0]!.opts).toEqual({ appId: 'app-camel', forceNew: false })
  })

  it('force_new 透传（强制新建变体）', async () => {
    canvasWorkflowStore.remember('p1', canvasWorkflow)

    await publishTool.fn({ name: 'w', prompt_id: 'p1', force_new: true }, 's1')

    expect(h.published[0]!.opts).toEqual({ appId: undefined, forceNew: true })
  })

  it('service 返回 null（app_id 无效等）→ ok=false 且给出可读原因，不假装成功', async () => {
    h.failPublish = true
    canvasWorkflowStore.remember('p1', canvasWorkflow)

    const out = payload(await publishTool.fn({ name: 'w', prompt_id: 'p1', app_id: 'nope' }, 's1'))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('app_id')
    expect(out.app_id).toBeUndefined()
  })
})
