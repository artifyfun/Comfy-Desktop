// @vitest-environment node
/**
 * POST /api/workbench/publish 的画布执行回退测试（对标建议 #8 用户侧收口）。
 *
 * 背景：前端「发布」按钮按 promptId 固化，服务端 `publishToApp` 却依赖模板库
 * （`templateLibrary.get(execution.templateId)`）——画布上手动搭出来的 workflow
 * 没有模板条目，于是对画布产物点发布会 404/500。现在改为回退到执行时暂存的
 * workflow 快照固化；模板执行路径必须保持原样。
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest'
import http from 'node:http'
import express from 'express'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  templates: new Map<string, unknown>(),
  executions: [] as Array<{ promptId: string; templateId: string }>,
  publishedWorkflow: [] as Array<{ name: string; workflow: unknown }>,
  publishToAppCalls: [] as string[],
  buildAppCodeCalls: 0
}))

vi.mock('electron', () => ({
  app: { getPath: () => tmpdir(), getAppPath: () => '', on: vi.fn(), once: vi.fn() }
}))
vi.mock('../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
vi.mock('../../../settings', () => ({ get: vi.fn(() => undefined) }))
vi.mock('../../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188', api_key: 'k', base_url: '' })),
    on: vi.fn()
  }
}))
vi.mock('../../workbench/templates', () => ({
  templateLibrary: { get: vi.fn((id: string) => h.templates.get(id)) }
}))
vi.mock('../../workbench/service', () => ({
  workbenchService: {
    getSession: vi.fn(() => ({ executions: h.executions })),
    publishToApp: vi.fn(() => {
      h.publishToAppCalls.push('called')
      return 'app-from-template'
    }),
    publishWorkflow: vi.fn((name: string, workflow: unknown) => {
      h.publishedWorkflow.push({ name, workflow })
      return { id: 'app-from-canvas', name, template: { paramsNodes: [] } }
    })
  }
}))
vi.mock('../../agentDriver', () => ({
  buildAppCode: vi.fn(async () => {
    h.buildAppCodeCalls++
    return '<html></html>'
  })
}))

import { registerExecuteRoutes } from './execute'
import { canvasWorkflowStore } from '../../workbench/canvasWorkflowStore'
import type { ComfyPrompt } from '../../appStore'

let server: http.Server
let baseUrl = ''

const canvasWorkflow = {
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } },
  '9': { class_type: 'SaveImage', inputs: { images: ['6', 0] } }
} as unknown as ComfyPrompt

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

beforeAll(async () => {
  const app = express()
  app.use(express.json())
  const router = express.Router()
  registerExecuteRoutes(router)
  app.use(router)
  server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

beforeEach(() => {
  h.templates.clear()
  h.executions = []
  h.publishedWorkflow.length = 0
  h.publishToAppCalls.length = 0
  h.buildAppCodeCalls = 0
  canvasWorkflowStore.clear()
})

describe('画布执行 → 固化（templateId 不在模板库）', () => {
  it('有快照 → 用暂存的 workflow 固化，返回 source=canvas', async () => {
    h.executions = [{ promptId: 'p-canvas', templateId: 'canvas:current' }]
    canvasWorkflowStore.remember('p-canvas', canvasWorkflow)

    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'p-canvas',
      name: '我的画布流程'
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.appId).toBe('app-from-canvas')
    expect(body.data.source).toBe('canvas')
    expect(h.publishedWorkflow[0]!.workflow).toBe(canvasWorkflow)
    // 不走模板路径
    expect(h.publishToAppCalls).toHaveLength(0)
  })

  it('请求带 buildUi 时不生成 UI 壳，并如实标注 uiSkipped', async () => {
    h.executions = [{ promptId: 'p-canvas2', templateId: 'canvas:other' }]
    canvasWorkflowStore.remember('p-canvas2', canvasWorkflow)

    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'p-canvas2',
      name: 'w',
      buildUi: true
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: Record<string, unknown> }
    expect(body.data.uiSkipped).toBe(true)
    expect(h.buildAppCodeCalls).toBe(0)
  })

  it('无快照（过期/已重启）→ 404 且提示可重跑', async () => {
    h.executions = [{ promptId: 'p-gone', templateId: 'canvas:gone' }]

    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'p-gone',
      name: 'w'
    })

    expect(res.status).toBe(404)
    const body = (await res.json()) as { message?: string; error?: string }
    const text = JSON.stringify(body)
    expect(text).toContain('画布工作流快照')
  })
})

describe('模板执行 → 固化（回归，行为不变）', () => {
  it('模板命中 → 走 publishToApp，不误入 canvas 分支', async () => {
    h.templates.set('app:t1', {
      id: 'app:t1',
      name: 'T',
      description: '模板',
      prompt: canvasWorkflow,
      paramsNodes: []
    })
    h.executions = [{ promptId: 'p-tpl', templateId: 'app:t1' }]
    // 即便存在同名快照，模板路径也不该被抢走
    canvasWorkflowStore.remember('p-tpl', canvasWorkflow)

    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'p-tpl',
      name: 'w'
    })

    expect(res.status).toBe(201)
    const body = (await res.json()) as { data: { appId: string; source?: string } }
    expect(body.data.appId).toBe('app-from-template')
    expect(body.data.source).toBeUndefined()
    expect(h.publishToAppCalls).toHaveLength(1)
    expect(h.publishedWorkflow).toHaveLength(0)
  })

  it('buildUi=true 时模板路径仍生成 UI 壳', async () => {
    h.templates.set('app:t2', {
      id: 'app:t2',
      name: 'T2',
      description: '模板2',
      prompt: canvasWorkflow,
      paramsNodes: [{ id: 1, name: 'prompt', category: 'input' }]
    })
    h.executions = [{ promptId: 'p-tpl2', templateId: 'app:t2' }]

    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'p-tpl2',
      name: 'w',
      buildUi: true
    })

    expect(res.status).toBe(201)
    expect(h.buildAppCodeCalls).toBe(1)
  })
})

describe('参数与前置校验', () => {
  it('缺 sessionId/promptId/name → 400', async () => {
    const res = await post('/api/workbench/publish', { sessionId: 's1' })
    expect(res.status).toBe(400)
  })

  it('执行记录不存在 → 404', async () => {
    h.executions = []
    const res = await post('/api/workbench/publish', {
      sessionId: 's1',
      promptId: 'nope',
      name: 'w'
    })
    expect(res.status).toBe(404)
  })
})
