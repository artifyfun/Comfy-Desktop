// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createCanvasRouter } from './canvas'

// execute/batch 接口依赖外部提交链：全部 mock（测试只验证路由契约）
vi.mock('../mcp/executor', () => ({
  executePrompt: vi.fn(),
  getHistory: vi.fn(),
  extractExecutionError: vi.fn(() => null)
}))
vi.mock('../services/batchRunner', () => ({ startBatch: vi.fn() }))
vi.mock('../workbench/service', () => ({
  workbenchService: {
    recordCanvasExecution: vi.fn(),
    getSession: vi.fn(() => null),
    appendMessage: vi.fn()
  }
}))
vi.mock('../appStore', () => ({
  default: { getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188' })) }
}))

import { executePrompt, getHistory } from '../mcp/executor'
import { startBatch } from '../services/batchRunner'

const mockExecute = executePrompt as unknown as ReturnType<typeof vi.fn>
const mockStartBatch = startBatch as unknown as ReturnType<typeof vi.fn>
const mockGetHistory = getHistory as unknown as ReturnType<typeof vi.fn>

/**
 * /api/canvas/snapshot & /api/canvas/state 单测。
 *
 * - snapshot 合法 body 缓存并回显 seq
 * - snapshot 缺 body → 400
 * - state 无缓存 → {state:null}
 * - state 有缓存 → 返回最近快照
 *
 * 全部走本地临时端口 + 全局 fetch，确定性无竞态（zero tolerance for flaky）。
 */
describe('canvas routes', () => {
  let server: http.Server
  let baseUrl = ''

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter({ latest: null }))
    return app
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  beforeAll(async () => {
    server = http.createServer(makeApp())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('accepts and caches a valid snapshot', async () => {
    const app = makeApp()
    const s2 = http.createServer(app)
    await new Promise<void>((resolve) => s2.listen(0, '127.0.0.1', resolve))
    const base2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    try {
      const res = await fetch(`${base2}/api/canvas/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seq: 1,
          workflowName: 'wf',
          nodeCount: 3,
          models: ['a.safetensors'],
          keyParams: {},
          queue: { running: 0, pending: 0 },
          ts: 1
        })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; data: { seq: number } }
      expect(body.ok).toBe(true)
      expect(body.data.seq).toBe(1)
      const st = await fetch(`${base2}/api/canvas/state`)
      const stBody = (await st.json()) as {
        ok: boolean
        data: { state: { workflowName: string } | null }
      }
      expect(stBody.data.state).toMatchObject({ workflowName: 'wf' })
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()))
    }
  })

  it('rejects missing body with 400', async () => {
    const res = await post('/api/canvas/snapshot', {})
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('returns null state when never posted', async () => {
    const res = await fetch(`${baseUrl}/api/canvas/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { state: unknown } }
    expect(body.ok).toBe(true)
    expect(body.data.state).toBeNull()
  })
})

describe('canvas execute & batch（M5 画布执行链路）', () => {
  let server: http.Server
  let baseUrl = ''

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter({ latest: null }))
    return app
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  beforeAll(async () => {
    vi.clearAllMocks()
    server = http.createServer(makeApp())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('execute：提交画布 prompt → promptId，带 sessionId 时记录会话', async () => {
    mockExecute.mockResolvedValue({ prompt_id: 'p-canvas-1', status: 'queued' })
    const res = await post('/api/canvas/execute', {
      prompt: { '1': { class_type: 'SaveImage', inputs: {} } },
      nodeOverrides: { '3': { widgetOverrides: { steps: 40 } } },
      sessionId: 's1'
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { promptId: string } }
    expect(body.ok).toBe(true)
    expect(body.data.promptId).toBe('p-canvas-1')
    expect(mockExecute).toHaveBeenCalled()
  })

  it('execute：缺 prompt → 400', async () => {
    const res = await post('/api/canvas/execute', { nodeOverrides: {} })
    expect(res.status).toBe(400)
  })

  it('batch：入队返回 jobId（≥2 行）', async () => {
    mockStartBatch.mockResolvedValue({ job: { id: 'job-1' }, queue: [] })
    const res = await post('/api/canvas/batch', {
      prompt: { '1': { class_type: 'KSampler', inputs: {} } },
      inputsMapping: [{ id: '1', key: 'steps', valueMap: { key: '1.steps' } }],
      items: [{ '1.steps': 20 }, { '1.steps': 40 }]
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { jobId: string } }
    expect(body.ok).toBe(true)
    expect(body.data.jobId).toBe('job-1')
    expect(mockStartBatch).toHaveBeenCalled()
  })

  it('batch：items 不足 2 行 → 400', async () => {
    const res = await post('/api/canvas/batch', {
      prompt: {},
      inputsMapping: [],
      items: [{}]
    })
    expect(res.status).toBe(400)
  })
})

describe('canvas execute-status（app 节点无会话轮询）', () => {
  let server: http.Server
  let baseUrl = ''

  beforeAll(async () => {
    vi.clearAllMocks()
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter({ latest: null }))
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('缺 promptId → 400', async () => {
    const res = await fetch(`${baseUrl}/api/canvas/execute-status`)
    expect(res.status).toBe(400)
  })

  it('history 未出现 → running', async () => {
    mockGetHistory.mockResolvedValue(null)
    const res = await fetch(`${baseUrl}/api/canvas/execute-status?promptId=px`)
    const body = (await res.json()) as { ok: boolean; data: { status: string } }
    expect(body.ok).toBe(true)
    expect(body.data.status).toBe('running')
  })

  it('success：outputs 全扫 images/gifs → files', async () => {
    mockGetHistory.mockResolvedValue({
      status: { status_str: 'success' },
      outputs: {
        '9': { images: [{ filename: 'a.png', subfolder: '', type: 'output' }] },
        '10': { gifs: [{ filename: 'b.gif', subfolder: 's', type: 'output' }] },
        '11': { nope: [] }
      }
    })
    const res = await fetch(`${baseUrl}/api/canvas/execute-status?promptId=py`)
    const body = (await res.json()) as {
      ok: boolean
      data: { status: string; outputs: { files: Array<{ filename: string }> } }
    }
    expect(body.data.status).toBe('success')
    expect(body.data.outputs.files.map((f) => f.filename)).toEqual(['a.png', 'b.gif'])
  })

  it('error：status_str=error → error + 消息', async () => {
    mockGetHistory.mockResolvedValue({
      status: {
        status_str: 'error',
        messages: [['execution_error', { exception_message: 'boom' }]]
      },
      outputs: {}
    })
    const res = await fetch(`${baseUrl}/api/canvas/execute-status?promptId=pz`)
    const body = (await res.json()) as { ok: boolean; data: { status: string; error?: string } }
    expect(body.data.status).toBe('error')
    expect(body.data.error).toBeTruthy()
  })
})
