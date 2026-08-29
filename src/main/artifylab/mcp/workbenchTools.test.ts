import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * wb_* 工作台编排工具单测。
 *
 * 重点不在 mock service 行为本身（那是 service 测试的事），而在工具层的
 * 合同：上下文保护（decide 轮外拒绝）、参数→PLAN 映射、校验失败不执行、
 * 执行成功打编排去重标记。
 */
vi.mock('../workbench/service', () => {
  const calls = {
    executed: [] as Array<{ sessionId: string; templateId?: string }>,
    marked: [] as string[],
    remembered: [] as Array<{ key: string; value: string }>,
    forgotten: [] as string[],
    batchPlan: undefined as unknown
  }
  const mockTemplate = {
    id: 'app:t2i',
    name: '文生图',
    description: 'd',
    mediaType: 'image',
    chainable: false,
    prompt: {
      '12': { class_type: 'KSampler', inputs: { steps: 20, cfg: 7 } }
    },
    paramsNodes: [
      {
        id: 1,
        name: 'prompt',
        category: 'input',
        type: 'string',
        renderComponent: 'text',
        selectedWidget: { name: 'prompt', type: 'string' }
      }
    ],
    source: 'app',
    appId: 't2i'
  }
  return {
    workbenchService: {
      getSession: vi.fn((id: string) => (id === 's1' ? { id } : null)),
      listTemplates: vi.fn(() => [mockTemplate]),
      resolveTemplate: vi.fn((_sid: string, id: string) =>
        id === 'app:t2i' ? mockTemplate : null
      ),
      cloneTemplate: vi.fn(() => ({ ...mockTemplate, id: 'session:s1:1' })),
      execute: vi.fn(async (sessionId: string, plan: { templateId?: string }) => {
        calls.executed.push({ sessionId, templateId: plan.templateId })
        return {
          promptId: 'p1',
          templateId: plan.templateId,
          params: {},
          outputs: [],
          status: 'success',
          startedAt: 0
        }
      }),
      executeWorkflow: vi.fn(async (sessionId: string) => ({
        promptId: 'pw1',
        templateId: 'session:workflow',
        params: {},
        outputs: [],
        status: 'success',
        startedAt: 0,
        sessionId
      })),
      publishWorkflow: vi.fn(() => ({ id: 'app:new1', name: '新应用' })),
      pollExecution: vi.fn(async () => ({
        status: 'success',
        outputs: [{ filename: 'a.png' }],
        outputsText: '[]',
        prompt_id: 'p1'
      })),
      markOrchestrated: vi.fn((id: string) => calls.marked.push(id)),
      rememberMemory: vi.fn((key: string, value: string) => calls.remembered.push({ key, value })),
      forgetMemory: vi.fn((key: string) => {
        calls.forgotten.push(key)
        return key === 'known'
      }),
      executeBatch: vi.fn(async (_sid: string, plan: { batch?: { items?: unknown[] } }) => {
        calls.batchPlan = plan
        return { jobId: 'job-1', total: plan.batch?.items?.length ?? 0 }
      })
    },
    __calls: calls
  }
})

vi.mock('../appStore', () => ({
  default: {
    getConfig: () => ({ comfyHost: 'http://127.0.0.1:8188' })
  }
}))

// batchRunner 拖 electron 依赖（持久化/通知），工具层只读 listBatchQueue——mock 成空队列
vi.mock('../services/batchRunner', () => ({
  listBatchQueue: () => [
    {
      id: 'job-1',
      status: 'completed',
      total: 2,
      processed: 2,
      success: 2,
      failed: 0,
      percent: 100,
      currentIndex: 2,
      currentPreview: '',
      createdAt: '',
      updatedAt: '',
      logs: [],
      results: [{ index: 0, success: true, durationMs: 1, files: [{ filename: 'b.png' }] }]
    }
  ]
}))

vi.mock('../workbench/templates', () => ({
  templateLibrary: {
    list: () => [
      {
        id: 'app:t2i',
        name: '文生图',
        description: 'd',
        mediaType: 'image',
        chainable: false,
        paramsNodes: [
          {
            name: 'prompt',
            category: 'input',
            type: 'string',
            renderComponent: 'text',
            required: true
          }
        ]
      }
    ]
  }
}))

import { workbenchService } from '../workbench/service'
import {
  beginWorkbenchToolContext,
  endWorkbenchToolContext,
  createWorkbenchAugmentedRegistry
} from './workbenchTools'

const mocked = workbenchService as unknown as {
  getSession: ReturnType<typeof vi.fn>
  execute: ReturnType<typeof vi.fn>
  markOrchestrated: ReturnType<typeof vi.fn>
  rememberMemory: ReturnType<typeof vi.fn>
  forgetMemory: ReturnType<typeof vi.fn>
}

function registry() {
  return createWorkbenchAugmentedRegistry({
    list: () => [],
    handle: async () => ({}),
    sync: () => {}
  })
}

describe('workbench wb_* MCP tools', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    endWorkbenchToolContext('s1')
    endWorkbenchToolContext('s2')
  })

  it('tools/list 含 wb_* 五个工具', () => {
    const names = registry()
      .list()
      .map((t) => t.name)
    expect(names).toEqual(
      expect.arrayContaining([
        'wb_list_templates',
        'wb_execute_template',
        'wb_poll_execution',
        'wb_remember',
        'wb_forget'
      ])
    )
  })

  it('decide 轮外调用 wb_remember 报明确错误（不落错会话）', async () => {
    const r = registry()
    await expect(r.handle('wb_remember', { key: 'k', value: 'v' })).rejects.toThrow(
      /outside decide session/
    )
    expect(mocked.rememberMemory).not.toHaveBeenCalled()
  })

  it('未知会话在 begin 时即拒绝', () => {
    expect(() => beginWorkbenchToolContext('nope')).toThrow(/session not found/)
  })

  it('wb_execute_template 校验失败不执行（缺模板）', async () => {
    beginWorkbenchToolContext('s1')
    const r = registry()
    const out = await r.handle('wb_execute_template', {
      template_id: 'app:不存在',
      params: {}
    })
    const parsed = JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text)
    expect(parsed.ok).toBe(false)
    expect(parsed.stage).toBe('validation')
    expect(mocked.execute).not.toHaveBeenCalled()
    expect(mocked.markOrchestrated).not.toHaveBeenCalled()
  })

  it('wb_execute_template 成功：执行+打编排标记+轮询产物', async () => {
    beginWorkbenchToolContext('s1')
    const r = registry()
    const out = await r.handle('wb_execute_template', {
      template_id: 'app:t2i',
      intent: 'image',
      params: { prompt: 'a cat' }
    })
    const parsed = JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.stage).toBe('completed')
    expect(mocked.execute).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ templateId: 'app:t2i' }),
      expect.anything(),
      []
    )
    expect(mocked.markOrchestrated).toHaveBeenCalledWith('s1')
  })

  it('wb_forget 返回 ok=false 当 key 不存在', async () => {
    beginWorkbenchToolContext('s1')
    const r = registry()
    const out = await r.handle('wb_forget', { key: 'ghost' })
    const content = (out as { content: Array<{ text: string }> }).content
    const parsed = JSON.parse(content[0]!.text)
    expect(parsed.ok).toBe(false)
  })

  it('非 wb 工具落到基础 registry', async () => {
    const base = { list: () => [], handle: vi.fn(async () => ({ from: 'base' })), sync: () => {} }
    const r = createWorkbenchAugmentedRegistry(base)
    await expect(r.handle('list_apps', {})).resolves.toEqual({ from: 'base' })
  })

  it('wb_execute_template batch_items：走 executeBatch 队列并回汇总', async () => {
    beginWorkbenchToolContext('s1')
    const r = registry()
    const out = await r.handle('wb_execute_template', {
      template_id: 'app:t2i',
      intent: 'image',
      batch_items: [{ prompt: 'A' }, { prompt: 'B', steps: 28 }],
      batch_shared_params: { prompt: 'shared prompt' }
    })
    const parsed = JSON.parse((out as { content: Array<{ text: string }> }).content[0]!.text)
    expect(parsed.ok).toBe(true)
    expect(parsed.stage).toBe('batch')
    expect(parsed.job_id).toBe('job-1')
    expect(parsed.total).toBe(2)
    expect(parsed.success).toBe(2)
    expect(parsed.outputs).toEqual([{ filename: 'b.png' }])
    // 不应走单次 execute
    expect(mocked.execute).not.toHaveBeenCalled()
    // plan.batch 映射正确（items 透传、sharedParams 进 plan）
    const svc = workbenchService as unknown as {
      executeBatch: ReturnType<typeof vi.fn>
    }
    const planArg = svc.executeBatch.mock.calls[0]?.[1] as {
      batch?: { items?: unknown[]; sharedParams?: Record<string, unknown> }
    }
    expect(planArg.batch?.items).toEqual([{ prompt: 'A' }, { prompt: 'B', steps: 28 }])
    expect(planArg.batch?.sharedParams).toEqual({ prompt: 'shared prompt' })
  })
})
