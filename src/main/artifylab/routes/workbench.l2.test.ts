// @vitest-environment node
import { afterAll, describe, expect, it, beforeEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

/**
 * L2 用户侧路由单测：
 * - POST /api/workbench/run-workflow（粘贴 workflow JSON 直接执行）
 * - POST /api/workbench/clone-template（模板派生会话级变体）
 *
 * 全部依赖 mock（service/executor/appStore），HTTP 走本地临时端口 + 全局
 * fetch，无固定 sleep——符合 AGENTS.md「zero tolerance policy for flaky tests」。
 */

vi.mock('../workbench/service', () => ({
  workbenchService: {
    getSession: vi.fn(() => null),
    listTemplates: vi.fn(() => []),
    resolveTemplate: vi.fn(() => null),
    appendMessage: vi.fn(),
    consumeOrchestratedFlag: vi.fn(() => false),
    executeWorkflow: vi.fn(),
    cloneTemplate: vi.fn(),
    execute: vi.fn()
  }
}))

vi.mock('../mcp/executor', () => ({
  stopExecution: vi.fn()
}))

vi.mock('../workbench/plan', () => ({
  validatePlanLocal: vi.fn(),
  validateNodeOverridesLocal: vi.fn(() => [])
}))

vi.mock('../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188' }))
  }
}))

vi.mock('../../settings', () => ({
  get: vi.fn(() => undefined)
}))

vi.mock('../agentDriver', () => ({
  buildAppCode: vi.fn()
}))

vi.mock('../workbench/templates', () => ({
  templateLibrary: { list: vi.fn(() => []), get: vi.fn(() => null) }
}))

import { workbenchService } from '../workbench/service'
import { validateNodeOverridesLocal } from '../workbench/plan'
import { createWorkbenchRouter } from './workbench'

const mockExecuteWorkflow = workbenchService.executeWorkflow as ReturnType<typeof vi.fn>
const mockCloneTemplate = workbenchService.cloneTemplate as ReturnType<typeof vi.fn>
const mockAppend = workbenchService.appendMessage as ReturnType<typeof vi.fn>
const mockResolveTemplate = workbenchService.resolveTemplate as ReturnType<typeof vi.fn>
const mockExecute = workbenchService.execute as ReturnType<typeof vi.fn>
const mockValidateLocal = validateNodeOverridesLocal as ReturnType<typeof vi.fn>

let server: http.Server
let baseUrl = ''

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createWorkbenchRouter())
  return app
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

async function listen(): Promise<void> {
  server = http.createServer(makeApp())
  baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterAll(() => {
  server?.closeAllConnections?.()
  server?.close()
})

describe('POST /api/workbench/run-workflow', () => {
  it('合法 workflow → 提交执行并落会话消息，返回 promptId', async () => {
    await listen()
    mockExecuteWorkflow.mockResolvedValue({
      promptId: 'p-1',
      templateId: '导入工作流',
      status: 'queued',
      outputs: [],
      startedAt: Date.now()
    })
    const res = await post('/api/workbench/run-workflow', {
      sessionId: 's1',
      workflow: { '1': { class_type: 'SaveImage', inputs: {} } },
      name: '我的工作流'
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { promptId: 'p-1', status: 'queued' } })
    expect(mockExecuteWorkflow).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ '1': expect.anything() }),
      { name: '我的工作流', seed: undefined }
    )
    const appended = mockAppend.mock.calls.map((c) => c[1] as { kind?: string; text?: string })
    expect(appended.some((m) => m.kind === 'chat' && m.text?.includes('我的工作流'))).toBe(true)
  })

  it('缺 sessionId / workflow → 400', async () => {
    await listen()
    const res = await post('/api/workbench/run-workflow', { sessionId: 's1' })
    expect(res.status).toBe(400)
    // workflow 是数组也不是合法的 API prompt 对象
    const res2 = await post('/api/workbench/run-workflow', { sessionId: 's1', workflow: [] })
    expect(res2.status).toBe(400)
  })

  it('执行失败 → 500 带错误信息', async () => {
    await listen()
    mockExecuteWorkflow.mockRejectedValue(new Error('ComfyUI unreachable'))
    const res = await post('/api/workbench/run-workflow', {
      sessionId: 's1',
      workflow: { '1': { class_type: 'SaveImage', inputs: {} } }
    })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ message: 'ComfyUI unreachable' })
  })
})

describe('POST /api/workbench/clone-template', () => {
  const fakeTemplate = { id: 't1', name: 'T1', prompt: { a: {}, b: {} }, mediaType: 'image' }

  it('合法克隆 → 201 返回新模板 id', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(fakeTemplate)
    mockCloneTemplate.mockReturnValue({
      id: 'session:t1-v1',
      name: '变体',
      prompt: { a: {}, b: {} }
    })
    const res = await post('/api/workbench/clone-template', {
      sessionId: 's1',
      templateId: 't1',
      nodeOverrides: { '6': { widgetOverrides: { steps: 30 } } }
    })
    expect(res.status).toBe(201)
    expect(await res.json()).toMatchObject({
      data: { templateId: 'session:t1-v1', nodeCount: 2 }
    })
    expect(mockCloneTemplate).toHaveBeenCalledWith('s1', 't1', {
      '6': { widgetOverrides: { steps: 30 } }
    })
  })

  it('validateOnly=true 只校验不克隆，返回 issue 清单', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(fakeTemplate)
    mockValidateLocal.mockReturnValue([
      { field: 'nodeOverrides.6.steps', message: '节点 6 无输入 steps' }
    ])
    const res = await post('/api/workbench/clone-template', {
      sessionId: 's1',
      templateId: 't1',
      nodeOverrides: { '6': { widgetOverrides: { steps: 30 } } },
      validateOnly: true
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      data: { ok: false, issues: [{ field: 'nodeOverrides.6.steps' }] }
    })
    expect(mockCloneTemplate).not.toHaveBeenCalled()
  })

  it('validateOnly 通过 → ok:true 且不落模板', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(fakeTemplate)
    mockValidateLocal.mockReturnValue([])
    const res = await post('/api/workbench/clone-template', {
      sessionId: 's1',
      templateId: 't1',
      nodeOverrides: { '6': { widgetOverrides: { steps: 30 } } },
      validateOnly: true
    })
    expect(await res.json()).toMatchObject({ data: { ok: true, issues: [] } })
    expect(mockCloneTemplate).not.toHaveBeenCalled()
  })

  it('模板不存在 → 404', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(null)
    const res = await post('/api/workbench/clone-template', { sessionId: 's1', templateId: 'nope' })
    expect(res.status).toBe(404)
  })

  it('非法 nodeOverrides → 400 带可读错误', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(fakeTemplate)
    mockCloneTemplate.mockImplementation(() => {
      throw new Error('nodeOverrides.9.nonexistent: 节点 9 无输入 nonexistent')
    })
    const res = await post('/api/workbench/clone-template', {
      sessionId: 's1',
      templateId: 't1',
      nodeOverrides: { '9': { widgetOverrides: { nonexistent: 1 } } }
    })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ message: expect.stringContaining('nodeOverrides') })
  })
})

describe('POST /api/workbench/execute', () => {
  it('直接执行模板变体 → 200 返回 promptId', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue({
      id: 'session:t1-v1',
      name: '变体',
      prompt: {},
      paramsNodes: [],
      mediaType: 'image'
    })
    mockExecute.mockResolvedValue({
      promptId: 'p-9',
      status: 'queued',
      outputs: [],
      startedAt: Date.now()
    })
    const res = await post('/api/workbench/execute', {
      sessionId: 's1',
      templateId: 'session:t1-v1',
      params: {}
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { promptId: 'p-9' } })
  })

  it('模板不存在 → 404；缺参 → 400', async () => {
    await listen()
    mockResolveTemplate.mockReturnValue(null)
    expect(
      (await post('/api/workbench/execute', { sessionId: 's1', templateId: 'x' })).status
    ).toBe(404)
    expect((await post('/api/workbench/execute', { sessionId: 's1' })).status).toBe(400)
  })
})
