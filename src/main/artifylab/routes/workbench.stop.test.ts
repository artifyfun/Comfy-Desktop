// @vitest-environment node
import { afterAll, describe, expect, it, beforeEach, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

/**
 * POST /api/workbench/stop 单测：停止合同验证。
 *
 * - 无 chat 在跑：不 abort，但仍然 interrupt ComfyUI（可能有已提交的任务在跑）
 * - chat 在跑：置停止标记 + abort 决策流，chat 收尾落「已停止」而非错误
 * - ComfyUI interrupt 失败不阻断停止确认（ComfyUI 离线场景）
 *
 * 全部依赖 mock（service/executor/appStore），HTTP 走本地临时端口 +
 * 全局 fetch，确定性等待，无固定 sleep/竞态——符合 AGENTS.md
 * 「zero tolerance policy for flaky tests」。
 */

vi.mock('../workbench/service', () => ({
  workbenchService: {
    getSession: vi.fn(() => null),
    listTemplates: vi.fn(() => []),
    appendMessage: vi.fn(),
    consumeOrchestratedFlag: vi.fn(() => false),
    decide: vi.fn()
  }
}))

vi.mock('../mcp/executor', () => ({
  stopExecution: vi.fn()
}))

vi.mock('../workbench/plan', () => ({
  validatePlanLocal: vi.fn()
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

import { stopExecution } from '../mcp/executor'
import { workbenchService } from '../workbench/service'
import { createWorkbenchRouter } from './workbench'

const mockStop = stopExecution as ReturnType<typeof vi.fn>
const mockAppend = workbenchService.appendMessage as ReturnType<typeof vi.fn>
const mockDecide = workbenchService.decide as ReturnType<typeof vi.fn>

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

/** 让出事件循环等条件成立（setImmediate 让 I/O 事件得以处理；无固定 sleep） */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await new Promise<void>((r) => setImmediate(r))
  }
  throw new Error(`timeout waiting for: ${what}`)
}

beforeEach(() => {
  vi.clearAllMocks()
  mockStop.mockResolvedValue(undefined)
})

afterAll(() => {
  server?.closeAllConnections?.()
  server?.close()
})

describe('POST /api/workbench/stop', () => {
  it('无 chat 在跑时仍 interrupt ComfyUI，返回 { stopped: false, interrupted: true }', async () => {
    server = http.createServer(makeApp())
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    })
    const res = await post('/api/workbench/stop')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { stopped: false, interrupted: true } })
    expect(mockStop).toHaveBeenCalledWith('http://127.0.0.1:8188')
  })

  it('ComfyUI interrupt 失败不阻断停止确认', async () => {
    server = http.createServer(makeApp())
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    })
    mockStop.mockRejectedValue(new Error('ComfyUI offline'))
    const res = await post('/api/workbench/stop')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ data: { stopped: false, interrupted: false } })
  })

  it('chat 在跑时停止：decide 收到 abort，会话落「已停止」而非错误', async () => {
    server = http.createServer(makeApp())
    baseUrl = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () =>
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
      )
    })
    let chatSignal: AbortSignal | null = null
    // decide 挂起直到被 abort（模拟 codex runStreamed 的 abort 语义）
    mockDecide.mockImplementation(
      (
        _sid: unknown,
        _input: unknown,
        _cb: unknown,
        _att: unknown,
        opts: { signal?: AbortSignal }
      ) =>
        new Promise((_resolve, reject) => {
          chatSignal = opts?.signal ?? null
          chatSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const chatPromise = post('/api/workbench/chat', { sessionId: 's1', input: 'hi' })
    await waitFor(() => chatSignal != null, 'decide to receive signal')
    const stopRes = await post('/api/workbench/stop')
    expect(await stopRes.json()).toMatchObject({
      data: { stopped: true, interrupted: true }
    })
    const chatRes = await chatPromise
    // SSE 以 done 事件收尾（不是 error），HTTP 200
    expect(chatRes.status).toBe(200)
    expect(chatSignal!.aborted).toBe(true)
    const appended = mockAppend.mock.calls.map((c) => c[1] as { kind?: string; text?: string })
    expect(appended.some((m) => m.kind === 'chat' && m.text === '已停止')).toBe(true)
    expect(appended.some((m) => m.kind === 'error')).toBe(false)
  })
})
