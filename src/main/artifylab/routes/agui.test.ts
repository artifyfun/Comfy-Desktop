// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

/**
 * POST /api/workbench/agent/run + /cancel 单测(C4 流式端点)。
 *
 * - 正常轮帧序列:RUN_STARTED → TOOL_CALL 四帧 → TEXT 三帧 → STATE_DELTA →
 *   CUSTOM wb_plan → wb_artifact(提交回执) → TEXT 三帧(最终回复) → RUN_FINISHED
 * - 分派全分支:media 执行/批量/校验失败/编排去重/workflow/canvas-run/记忆/回复
 * - 参数缺失 400;同 thread 二连发 409;cancel 200/404 语义;
 *   client abort 后路由收敛(锁释放,可再跑下一轮)
 * - 全部依赖 mock(workbenchService 全方法注入脚本化 thread_event 序列),
 *   HTTP 走本地临时端口 + 全局 fetch,Promise 门确定性等待,无固定 sleep——
 *   符合 AGENTS.md「zero tolerance policy for flaky tests」。
 * - plan.ts/templateCore.ts 为纯函数真实跑(无 electron 依赖),校验语义与生产一致。
 */

vi.mock('../workbench/service', () => ({
  workbenchService: {
    decide: vi.fn(),
    getSession: vi.fn(() => null),
    listTemplates: vi.fn(() => []),
    appendMessage: vi.fn(),
    rememberMemory: vi.fn(),
    forgetMemory: vi.fn(() => false),
    consumeOrchestratedFlag: vi.fn(() => false),
    appendTurnUsage: vi.fn(),
    appendBatchExecution: vi.fn(),
    patchDebugExecution: vi.fn(),
    setCanvasSyncHandler: vi.fn(),
    validateRemote: vi.fn(async () => []),
    execute: vi.fn(),
    executeBatch: vi.fn()
  }
}))

vi.mock('../mcp/executor', () => ({
  stopExecution: vi.fn(async () => undefined)
}))

vi.mock('../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188' }))
  }
}))

import { workbenchService } from '../workbench/service'
import { stopExecution } from '../mcp/executor'
import type {
  WorkbenchSession,
  WorkbenchExecution,
  WorkbenchMessageKind
} from '../workbench/service'
import { createAguiRouter } from './agui'
import type { ThreadEvent } from '../vendor/codex-sdk'

const mockDecide = workbenchService.decide as ReturnType<typeof vi.fn>
const mockGetSession = workbenchService.getSession as ReturnType<typeof vi.fn>
const mockListTemplates = workbenchService.listTemplates as ReturnType<typeof vi.fn>
const mockAppendMessage = workbenchService.appendMessage as ReturnType<typeof vi.fn>
const mockRememberMemory = workbenchService.rememberMemory as ReturnType<typeof vi.fn>
const mockForgetMemory = workbenchService.forgetMemory as ReturnType<typeof vi.fn>
const mockConsumeOrchestrated = workbenchService.consumeOrchestratedFlag as ReturnType<typeof vi.fn>
const mockSetCanvasSyncHandler = workbenchService.setCanvasSyncHandler as ReturnType<typeof vi.fn>
const mockValidateRemote = workbenchService.validateRemote as ReturnType<typeof vi.fn>
const mockExecute = workbenchService.execute as ReturnType<typeof vi.fn>
const mockExecuteBatch = workbenchService.executeBatch as ReturnType<typeof vi.fn>
const mockPatchDebug = workbenchService.patchDebugExecution as ReturnType<typeof vi.fn>
const mockAppendBatchExecution = workbenchService.appendBatchExecution as ReturnType<typeof vi.fn>

let server: http.Server
let baseUrl = ''

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use(createAguiRouter())
  return app
}

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

/** 解析 SSE 响应体为帧数组(data: 行内的 JSON) */
function parseSseFrames(raw: string): Array<Record<string, unknown>> {
  return raw
    .split('\n\n')
    .filter((chunk) => chunk.startsWith('data: '))
    .map((chunk) => JSON.parse(chunk.slice('data: '.length)) as Record<string, unknown>)
}

/** 让出事件循环等条件成立(setImmediate 让 I/O 事件得以处理;无固定 sleep) */
async function waitFor(cond: () => boolean, what: string): Promise<void> {
  for (let i = 0; i < 1000; i++) {
    if (cond()) return
    await new Promise<void>((r) => setImmediate(r))
  }
  throw new Error(`timeout waiting for: ${what}`)
}

/** 脚本化 decide:依次回调 onProgress({type:'thread_event'}),resolve 返回 plan */
function scriptDecide(events: ThreadEvent[], plan: unknown, signal: AbortSignal | null = null) {
  return (
    _sid: unknown,
    _input: unknown,
    onProgress: (p: { type: string; event?: unknown }) => void
  ) => {
    for (const event of events) onProgress({ type: 'thread_event', event })
    if (signal?.aborted) return Promise.reject(new Error('decide aborted'))
    return Promise.resolve({ plan, issues: [], raw: '{}', resolved: { input: _input } })
  }
}

const fullTurnEvents: ThreadEvent[] = [
  { type: 'thread.started', thread_id: 'codex-x' },
  {
    type: 'item.started',
    item: {
      id: 'tc1',
      type: 'mcp_tool_call',
      server: 'wb',
      tool: 'wb_execute_template',
      arguments: { templateId: 't1' },
      status: 'in_progress'
    }
  },
  {
    type: 'item.completed',
    item: {
      id: 'tc1',
      type: 'mcp_tool_call',
      server: 'wb',
      tool: 'wb_execute_template',
      arguments: { templateId: 't1' },
      status: 'completed',
      result: { content: [], structured_content: { ok: true } }
    }
  },
  {
    type: 'item.completed',
    item: { id: 'am1', type: 'agent_message', text: '已选模板 t1' }
  },
  {
    type: 'turn.completed',
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      reasoning_output_tokens: 0
    }
  }
]

const VALID_BODY = { threadId: 's1', runId: 'r1', input: '生成一张猫图' }

/** 媒体模板夹具:paramsNodes 含 input「prompt」(字符串 widget)供批量行交集校验 */
const TEMPLATE_T1 = {
  id: 't1',
  name: '文生图 t1',
  description: 'fixture',
  mediaType: 'image',
  prompt: { '9': { class_type: 'KSampler', inputs: { seed: 1 } } },
  paramsNodes: [
    {
      id: 1,
      category: 'input',
      type: 'STRING',
      name: 'prompt',
      selectedWidget: { name: 'prompt', type: 'STRING' }
    }
  ],
  source: 'builtin'
} as const

/** 最小 WorkbenchSession 夹具:getSession mock 用 */
function makeSession(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: 's1',
    title: 's',
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    executions: [],
    ...overrides
  }
}

/** 单次执行的 WorkbenchExecution 夹具 */
function makeExecution(overrides: Partial<WorkbenchExecution> = {}): WorkbenchExecution {
  return {
    promptId: 'p-exe-1',
    templateId: 't1',
    params: {},
    outputs: [],
    status: 'queued',
    startedAt: Date.now(),
    ...overrides
  }
}

async function startServer(): Promise<void> {
  server = http.createServer(makeApp())
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve())
  })
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
}

beforeEach(() => {
  vi.clearAllMocks()
  // clearAllMocks 会重置 implementation;非 decide 的默认行为恢复
  mockGetSession.mockReturnValue(null)
  mockListTemplates.mockReturnValue([TEMPLATE_T1])
  mockForgetMemory.mockReturnValue(false)
  mockConsumeOrchestrated.mockReturnValue(false)
  mockValidateRemote.mockResolvedValue([])
  ;(stopExecution as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
})

afterAll(() => {
  server?.closeAllConnections?.()
  server?.close()
})

describe('POST /api/workbench/agent/run', () => {
  it('正常轮帧序列:RUN_STARTED → TOOL_CALL 四帧 → TEXT 三帧 → STATE_DELTA → CUSTOM wb_plan → wb_artifact → TEXT 回复 → RUN_FINISHED', async () => {
    await startServer()
    mockDecide.mockImplementation(
      scriptDecide(fullTurnEvents, { intent: 'image', templateId: 't1' })
    )
    mockExecute.mockResolvedValue(makeExecution())
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')
    const frames = parseSseFrames(await res.text())

    expect(frames.map((f) => f.type)).toEqual([
      'RUN_STARTED',
      // tool call:start/args/end → completed 补 result
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      // text 三帧(整段)
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      // token 用量
      'STATE_DELTA',
      // PLAN 业务事件(A 线边界)
      'CUSTOM',
      // 执行前画布 tab 保证(ensure-tab)
      'CUSTOM',
      // 执行提交回执(业务产物)
      'CUSTOM',
      // 最终回复三帧
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      // 收尾
      'RUN_FINISHED'
    ])

    expect(frames[0]).toMatchObject({ type: 'RUN_STARTED', threadId: 's1', runId: 'r1' })
    const tcStart = frames.find((f) => f.type === 'TOOL_CALL_START') as { toolCallName: string }
    expect(tcStart.toolCallName).toBe('wb_execute_template')
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs[0]!.name).toBe('wb_plan')
    expect(customs[0]!.value).toEqual({
      plan: { intent: 'image', templateId: 't1' },
      localIssues: []
    })
    expect(customs[1]!.name).toBe('wb_sync')
    expect(customs[1]!.value).toMatchObject({
      templateId: 't1',
      name: '文生图 t1',
      ensureTab: true
    })
    expect(customs[2]!.name).toBe('wb_artifact')
    expect(customs[2]!.value).toEqual({
      promptId: 'p-exe-1',
      name: 't1',
      outputs: [],
      outputFiles: []
    })
    const finished = frames[frames.length - 1]
    expect(finished).toMatchObject({ type: 'RUN_FINISHED', threadId: 's1', runId: 'r1' })

    // 执行与调试回填被正确调用;会话留痕「已提交到 ComfyUI 队列」
    expect(mockExecute).toHaveBeenCalledTimes(1)
    expect(mockExecute.mock.calls[0]!.slice(0, 3)).toEqual([
      's1',
      { intent: 'image', templateId: 't1' },
      TEMPLATE_T1
    ])
    expect(mockPatchDebug).toHaveBeenCalledWith('s1', 'p-exe-1', {
      promptId: 'p-exe-1',
      templateId: 't1',
      executionStatus: 'queued'
    })
    const kinds = mockAppendMessage.mock.calls.map(
      (c) => (c[1] as { kind: WorkbenchMessageKind }).kind
    )
    expect(kinds).toContain('chat')
    expect(kinds).not.toContain('error')

    // decide 被正确调用:sessionId=threadId、原样 input、带 AbortSignal
    expect(mockDecide).toHaveBeenCalledTimes(1)
    const [sid, input, , attachments, opts] = mockDecide.mock.calls[0] as unknown as [
      string,
      string,
      unknown,
      unknown[],
      { signal?: AbortSignal }
    ]
    expect(sid).toBe('s1')
    expect(input).toBe('生成一张猫图')
    expect(attachments).toEqual([])
    expect(opts.signal).toBeInstanceOf(AbortSignal)

    // sync handler 注册/注销两参形态(C7)
    expect(mockSetCanvasSyncHandler).toHaveBeenCalledTimes(2)
    expect(mockSetCanvasSyncHandler.mock.calls[0]![1]).toBe('s1')
    expect(mockSetCanvasSyncHandler.mock.calls[1]![0]).toBe(null)
  })

  it('plan 为 null:不发 wb_plan,RUN_ERROR 即终帧(终帧统一口径,无 RUN_FINISHED)', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], null))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(frames.map((f) => f.type)).toEqual(['RUN_STARTED', 'RUN_ERROR'])
    expect(frames[1]).toMatchObject({ type: 'RUN_ERROR' })
  })

  it('本地校验失败:image 无模板发 wb_invalid + RUN_ERROR(validate_error)即终帧,会话留痕', async () => {
    await startServer()
    mockListTemplates.mockReturnValue([])
    mockDecide.mockImplementation(scriptDecide([], { intent: 'image', templateId: 'missing' }))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(frames.map((f) => f.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM', 'RUN_ERROR'])
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs[0]!.name).toBe('wb_plan')
    expect(customs[1]!.name).toBe('wb_invalid')
    expect((customs[1]!.value as { issues: Array<{ field: string }> }).issues[0]!.field).toBe(
      'templateId'
    )
    expect(frames[3]).toMatchObject({ type: 'RUN_ERROR', code: 'validate_error' })
    expect(mockAppendMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ kind: 'error', role: 'agent' })
    )
  })

  it('远端校验失败:validateRemote 返回 issues → wb_invalid + RUN_ERROR,不执行', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], { intent: 'image', templateId: 't1' }))
    mockValidateRemote.mockResolvedValue([
      { field: 'models', message: '模型未安装: x.safetensors' }
    ])
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs.map((c) => c.name)).toEqual(['wb_plan', 'wb_invalid'])
    expect(frames.some((f) => f.type === 'RUN_ERROR')).toBe(true)
    expect(mockExecute).not.toHaveBeenCalled()
  })

  it('执行分派 batch 分支:executeBatch → wb_artifact(batch 回执) → 批量回复', async () => {
    await startServer()
    mockDecide.mockImplementation(
      scriptDecide([], {
        intent: 'image',
        templateId: 't1',
        params: { prompt: 'x' },
        batch: { items: [{ prompt: 'a' }, { prompt: 'b' }] }
      })
    )
    mockExecuteBatch.mockResolvedValue({ jobId: 'job-9', total: 2 })
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs.map((c) => c.name)).toEqual(['wb_plan', 'wb_sync', 'wb_artifact'])
    expect(customs[2]!.value).toMatchObject({
      promptId: 'job-9',
      batch: { jobId: 'job-9', total: 2 },
      templateId: 't1',
      name: '文生图 t1'
    })
    expect(mockExecuteBatch).toHaveBeenCalledTimes(1)
    expect(mockAppendBatchExecution).toHaveBeenCalledWith('s1', 't1', 'job-9', 2)
    expect(mockExecute).not.toHaveBeenCalled()
    // 最终回复 = 批量入队文案(TEXT_MESSAGE_CONTENT)
    const contents = frames.filter((f) => f.type === 'TEXT_MESSAGE_CONTENT')
    expect(
      contents.some((f) => String((f as { delta: string }).delta).includes('批量任务已入队'))
    ).toBe(true)
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('单次执行失败:execute 抛错 → RUN_ERROR(exec 透传 message),不 RUN_FINISHED', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], { intent: 'image', templateId: 't1' }))
    mockExecute.mockRejectedValue(new Error('ComfyUI 不可达'))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    // 执行前 wb_sync 已发(画布 tab 保证);执行抛错 → RUN_ERROR 收尾,不补 RUN_FINISHED
    expect(frames.map((f) => f.type)).toEqual(['RUN_STARTED', 'CUSTOM', 'CUSTOM', 'RUN_ERROR'])
    expect(frames[1]).toMatchObject({ name: 'wb_plan' })
    expect(frames[2]).toMatchObject({ name: 'wb_sync' })
    expect(frames[3]).toMatchObject({ type: 'RUN_ERROR', message: 'ComfyUI 不可达' })
  })

  it('chat 意图:wb_plan → TEXT 回复(plan.reply) → RUN_FINISHED,不执行', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], { intent: 'chat', reply: '你好呀' }))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(frames.map((f) => f.type)).toEqual([
      'RUN_STARTED',
      'CUSTOM',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED'
    ])
    const content = frames.find((f) => f.type === 'TEXT_MESSAGE_CONTENT') as { delta: string }
    expect(content.delta).toBe('你好呀')
    const starts = frames.filter((f) => f.type === 'TEXT_MESSAGE_START') as Array<{
      messageId: string
    }>
    expect(starts[0]!.messageId.startsWith('msg-')).toBe(true)
    expect(mockExecute).not.toHaveBeenCalled()
    expect(mockAppendMessage).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ kind: 'chat', text: '你好呀' })
    )
  })

  it('memory 意图:remember 落盘 → 确认文案 TEXT 三帧', async () => {
    await startServer()
    mockDecide.mockImplementation(
      scriptDecide([], {
        intent: 'memory',
        memory: { action: 'remember', key: 'style', value: '像素风' }
      })
    )
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(mockRememberMemory).toHaveBeenCalledWith('style', '像素风')
    const content = frames.find((f) => f.type === 'TEXT_MESSAGE_CONTENT') as { delta: string }
    expect(content.delta).toBe('已记住【style】：像素风')
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('memory forget 未命中:不删除任何内容,确认文案照发', async () => {
    await startServer()
    mockDecide.mockImplementation(
      scriptDecide([], { intent: 'memory', memory: { action: 'forget', key: 'nope' } })
    )
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(mockForgetMemory).toHaveBeenCalledWith('nope')
    const content = frames.find((f) => f.type === 'TEXT_MESSAGE_CONTENT') as { delta: string }
    expect(content.delta).toBe('没有找到记忆【nope】，未删除任何内容')
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('workflow 意图:wb_sync(整图布局) → 确认文案 → RUN_FINISHED', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], { intent: 'workflow', templateId: 't1' }))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs.map((c) => c.name)).toEqual(['wb_plan', 'wb_sync'])
    expect(customs[1]!.value).toMatchObject({
      templateId: 't1',
      name: '文生图 t1',
      ensureTab: true
    })
    const content = frames.find((f) => f.type === 'TEXT_MESSAGE_CONTENT') as { delta: string }
    expect(content.delta).toBe('已把「文生图 t1」加载到画布。')
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('canvas-run 意图:wb_canvas_exec 桥指令 → 进度文案,不执行模板', async () => {
    await startServer()
    mockDecide.mockImplementation(scriptDecide([], { intent: 'canvas-run' }))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs.map((c) => c.name)).toEqual(['wb_plan', 'wb_canvas_exec'])
    expect(customs[1]!.value).toMatchObject({ sessionId: 's1' })
    expect(
      String((customs[1]!.value as { requestId: string }).requestId).startsWith('canvas-')
    ).toBe(true)
    expect(mockExecute).not.toHaveBeenCalled()
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('编排去重:consumeOrchestratedFlag=true → wb_submitted + 总结回复 + 产物补发,跳过重复执行', async () => {
    await startServer()
    mockConsumeOrchestrated.mockReturnValue(true)
    mockDecide.mockImplementation(
      scriptDecide(fullTurnEvents, {
        intent: 'image',
        templateId: 't1',
        reply: '多步编排已完成，产物见上方过程流。'
      })
    )
    // 编排工具已真实执行成功并带产物:flush 应补发 wb_artifact。
    // startedAt 用远超当下的常量,确定性满足 flush 的 startedAt >= runStartTs 过滤
    mockGetSession.mockReturnValue(
      makeSession({
        executions: [
          makeExecution({
            promptId: 'p-orch-1',
            status: 'success',
            startedAt: Number.MAX_SAFE_INTEGER,
            outputs: [{ filename: 'out.png', subfolder: '', type: 'output' }]
          })
        ]
      })
    )
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(mockExecute).not.toHaveBeenCalled()
    const customs = frames.filter((f) => f.type === 'CUSTOM') as Array<{
      name: string
      value: unknown
    }>
    expect(customs.map((c) => c.name)).toEqual(['wb_plan', 'wb_submitted', 'wb_artifact'])
    expect(customs[1]!.value).toEqual({ orchestrated: true })
    expect(customs[2]!.value).toMatchObject({ promptId: 'p-orch-1', outputs: ['out.png'] })
    expect(frames[frames.length - 1]).toMatchObject({ type: 'RUN_FINISHED' })
  })

  it('参数缺失 400(threadId/runId/input 各自必填)', async () => {
    await startServer()
    expect((await post('/api/workbench/agent/run', { runId: 'r', input: 'x' })).status).toBe(400)
    expect((await post('/api/workbench/agent/run', { threadId: 's', input: 'x' })).status).toBe(400)
    expect((await post('/api/workbench/agent/run', { threadId: 's', runId: 'r' })).status).toBe(400)
    expect(mockDecide).not.toHaveBeenCalled()
  })

  it('附件-only(无 input)合法 200:decide 第 4 参收到 attachments', async () => {
    await startServer()
    mockDecide.mockResolvedValue({
      plan: { intent: 'chat', reply: '收到图片' },
      issues: [],
      raw: '',
      resolved: { input: '' }
    })
    const res = await post('/api/workbench/agent/run', {
      threadId: 's1',
      runId: 'r-att',
      attachments: [{ name: 'img.png', kind: 'image', filename: 'img.png', size: 10 }]
    })
    expect(res.status).toBe(200)
    await res.text() // 消费 SSE
    expect(mockDecide).toHaveBeenCalledTimes(1)
    const args = mockDecide.mock.calls[0] as unknown[]
    expect(args[1]).toBe('')
    expect(args[3]).toEqual([{ name: 'img.png', kind: 'image', filename: 'img.png', size: 10 }])
  })

  it('turn.completed 进度事件经 onProgress 落 turnUsages(appendTurnUsage 调用)', async () => {
    await startServer()
    mockDecide.mockImplementation((_sid: unknown, _input: unknown, cb: (p: unknown) => void) => {
      cb({
        type: 'thread_event',
        event: { type: 'thread.started', thread_id: 'codex-t1' }
      })
      cb({
        type: 'thread_event',
        event: {
          type: 'turn.completed',
          usage: {
            input_tokens: 100,
            cached_input_tokens: 20,
            output_tokens: 50,
            reasoning_output_tokens: 10
          }
        }
      })
      return Promise.resolve({
        plan: { intent: 'chat', reply: '好' },
        issues: [],
        raw: '',
        resolved: { input: '' }
      })
    })
    const res = await post('/api/workbench/agent/run', {
      threadId: 's1',
      runId: 'r-u',
      input: 'hi'
    })
    await res.text()
    expect(workbenchService.appendTurnUsage).toHaveBeenCalledWith('s1', {
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
      reasoningOutputTokens: 10,
      at: expect.any(Number)
    })
  })

  it('同 thread 二连发:第二个请求 409,互不干扰第一轮', async () => {
    await startServer()
    const releaseDecide: { release: (() => void) | null } = { release: null }
    mockDecide.mockImplementation(
      (_sid: unknown, _input: unknown, _cb: unknown) =>
        new Promise((resolve) => {
          releaseDecide.release = () =>
            resolve({ plan: { intent: 'chat' }, issues: [], raw: '', resolved: { input: '' } })
        })
    )
    const first = post('/api/workbench/agent/run', VALID_BODY)
    await waitFor(() => releaseDecide.release != null, 'decide to start')
    const second = await post('/api/workbench/agent/run', {
      threadId: 's1',
      runId: 'r2',
      input: 'second'
    })
    expect(second.status).toBe(409)
    releaseDecide.release?.()
    const firstRes = await first
    expect(firstRes.status).toBe(200)
  })

  it('client abort 后路由收敛:SSE close → abort → decide reject → RUN_ERROR 静默丢弃、锁释放', async () => {
    await startServer()
    let decideSignal: AbortSignal | null = null
    mockDecide.mockImplementation(
      (
        _sid: unknown,
        _input: unknown,
        _cb: unknown,
        _att: unknown,
        opts: { signal?: AbortSignal }
      ) =>
        new Promise((_resolve, reject) => {
          decideSignal = opts?.signal ?? null
          decideSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    // 手动 fetch + abort 模拟客户端断连;body 消费放后台(SSE 流要等结束才 resolve,
    // 先 await 会与 abort 形成循环等待)
    const ac = new AbortController()
    const res = await fetch(`${baseUrl}/api/workbench/agent/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(VALID_BODY),
      signal: ac.signal
    })
    expect(res.status).toBe(200)
    const bodyText = res.text()
    // 立即挂上 rejects 断言(否则流在下方 waitFor 期间拒绝会触发 unhandled rejection)
    const bodyAssertion = expect(bodyText).rejects.toThrow()
    await waitFor(() => decideSignal !== null, 'decide to receive signal')
    ac.abort() // 客户端断连 → 服务端 res close → 路由 abort decide
    await waitFor(() => decideSignal!.aborted, 'route to abort decide on close')
    // 消费端以流中断收场;RUN_ERROR 因 SSE 已销毁被 sendFrame 挡丢弃
    await bodyAssertion
    // 锁已释放(路由收敛):同 thread 可立刻再跑一轮(chat 带 reply,过本地校验)
    mockDecide.mockImplementation(scriptDecide([], { intent: 'chat', reply: '好' }))
    const next = await post('/api/workbench/agent/run', {
      threadId: 's1',
      runId: 'r2',
      input: 'again'
    })
    expect(next.status).toBe(200)
    expect(parseSseFrames(await next.text()).map((f) => f.type)).toEqual([
      'RUN_STARTED',
      'CUSTOM',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      'RUN_FINISHED'
    ])
  })

  it('decide 抛非 abort 错误:RUN_ERROR(message 透传)后 RUN_FINISHED 不补(异常路径不收 RUN_FINISHED)', async () => {
    await startServer()
    mockDecide.mockRejectedValue(new Error('codex binary not found'))
    const res = await post('/api/workbench/agent/run', VALID_BODY)
    const frames = parseSseFrames(await res.text())
    expect(frames.map((f) => f.type)).toEqual(['RUN_STARTED', 'RUN_ERROR'])
    expect(frames[1]).toMatchObject({ type: 'RUN_ERROR', message: 'codex binary not found' })
  })

  it('用户 cancel:静默收尾(不发 RUN_ERROR/RUN_FINISHED),锁释放', async () => {
    await startServer()
    let decideSignal: AbortSignal | null = null
    mockDecide.mockImplementation(
      (
        _sid: unknown,
        _input: unknown,
        _cb: unknown,
        _att: unknown,
        opts: { signal?: AbortSignal }
      ) =>
        new Promise((_resolve, reject) => {
          decideSignal = opts?.signal ?? null
          decideSignal?.addEventListener('abort', () => reject(new Error('aborted')))
        })
    )
    const runPromise = post('/api/workbench/agent/run', VALID_BODY)
    await waitFor(() => decideSignal != null, 'decide to receive signal')

    const cancelRes = await post('/api/workbench/agent/cancel', { threadId: 's1' })
    expect(cancelRes.status).toBe(200)
    expect(await cancelRes.json()).toMatchObject({ cancelled: true, interrupted: true })
    expect(stopExecution).toHaveBeenCalledWith('http://127.0.0.1:8188')
    expect(decideSignal!.aborted).toBe(true)

    const runRes = await runPromise
    expect(runRes.status).toBe(200)
    const frames = parseSseFrames(await runRes.text())
    // cancel 轮:RUN_STARTED 后被中断,无 wb_plan/RUN_FINISHED;不发超时误报
    expect(frames.map((f) => f.type)).toEqual(['RUN_STARTED'])
    expect(frames.some((f) => f.type === 'RUN_ERROR')).toBe(false)

    // 收尾后锁已释放
    mockDecide.mockImplementation(scriptDecide([], { intent: 'chat' }))
    const next = await post('/api/workbench/agent/run', { threadId: 's1', runId: 'r2', input: 'x' })
    expect(next.status).toBe(200)
  })

  it('无进行中 run:404', async () => {
    await startServer()
    const res = await post('/api/workbench/agent/cancel', { threadId: 'nope' })
    expect(res.status).toBe(404)
  })

  it('缺 threadId:400', async () => {
    await startServer()
    const res = await post('/api/workbench/agent/cancel', {})
    expect(res.status).toBe(400)
  })
})
