/**
 * ACP transport 单测:注入 connect 工厂(mock 连接),零真实子进程,零 flaky。
 *
 * 覆盖:
 * - 首轮 startTurn 触发 initialize → session/new 幂等握手;二轮复用不再握手
 * - session/update 通知 → AG-UI 事件按帧流出;RUN_FINISHED 收口后流结束
 * - prompt stopReason 非 end → RUN_ERROR 终帧
 * - abort 信号 → cancel 通知发出,流收口
 * - requestPermission 桥:gate.approve → allow_once 应答;gate.reject → reject_once
 * - 无 gate 时放行 allow 选项;无 allow 选项时 cancelled
 * - dispose 幂等
 */
import { describe, expect, it, vi } from 'vitest'
import { createAcpRuntime, type AcpAgentConnection } from './transport'
import type { SessionNotification } from '@zed-industries/agent-client-protocol/dist/schema'
import type { AGUIEvent } from '../types'

/** 可编程 mock 连接:记录调用,允许测试逐条注入通知 */
function makeMockAgent() {
  const calls: Array<{ method: string; params?: unknown }> = []
  let notifyHandler: ((n: SessionNotification) => Promise<void>) | null = null
  let permissionHandler:
    | ((p: {
        options: Array<{ optionId: string; kind: string; name: string }>
        toolCall?: { title?: string; toolCallId?: string }
      }) => Promise<unknown>)
    | null = null

  const agent = {
    initialize: vi.fn(async (params: unknown) => {
      calls.push({ method: 'initialize', params })
      return { protocolVersion: 1, authMethods: [] }
    }),
    newSession: vi.fn(async (params: unknown) => {
      calls.push({ method: 'newSession', params })
      return { sessionId: 'sess-1' }
    }),
    prompt: vi.fn(async (params: unknown): Promise<{ stopReason: string }> => {
      calls.push({ method: 'prompt', params })
      return { stopReason: 'end_turn' }
    }),
    cancel: vi.fn(async (params: unknown) => {
      calls.push({ method: 'cancel', params })
    })
  } as unknown as AcpAgentConnection & {
    initialize: ReturnType<typeof vi.fn>
    newSession: ReturnType<typeof vi.fn>
    prompt: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }

  return {
    agent,
    calls,
    /** 连接工厂挂上 handler(transport 构造时调用) */
    attach(handlers: {
      sessionUpdate(n: SessionNotification): Promise<void>
      requestPermission(p: never): Promise<unknown>
    }) {
      notifyHandler = handlers.sessionUpdate
      permissionHandler = handlers.requestPermission as typeof permissionHandler
    },
    async notify(update: Record<string, unknown>): Promise<void> {
      await notifyHandler?.({ sessionId: 'sess-1', update } as unknown as SessionNotification)
    },
    async requestPermission(p: {
      options: Array<{ optionId: string; kind: string; name: string }>
      toolCall?: { title?: string; toolCallId?: string }
    }): Promise<unknown> {
      return permissionHandler?.(p)
    }
  }
}

function collect(stream: AsyncGenerator<{ event: AGUIEvent | null }, void, unknown>) {
  const events: AGUIEvent[] = []
  return (async () => {
    for await (const frame of stream) {
      if (frame.event) events.push(frame.event)
    }
    return events
  })()
}

const baseOpts = {
  binary: '/fake/acp-agent',
  args: ['acp'],
  env: {},
  threadId: 'thread-1',
  runId: 'run-1'
}

describe('createAcpRuntime', () => {
  it('首轮 startTurn 执行 initialize→newSession,二轮复用不再握手', async () => {
    const mock = makeMockAgent()
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const run1 = await runtime.startTurn('第一轮')
    await collect(run1.stream)
    const run2 = await runtime.startTurn('第二轮')
    await collect(run2.stream)
    expect(mock.agent.initialize).toHaveBeenCalledTimes(1)
    expect(mock.agent.newSession).toHaveBeenCalledTimes(1)
    expect(mock.agent.prompt).toHaveBeenCalledTimes(2)
    runtime.dispose()
  })

  it('session/update 映射为 AG-UI 事件流出,RUN_FINISHED 收口', async () => {
    const mock = makeMockAgent()
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const run = await runtime.startTurn('hi')
    const done = collect(run.stream)
    await mock.notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '回' }
    })
    await mock.notify({
      sessionUpdate: 'agent_message_chunk',
      content: { type: 'text', text: '答' }
    })
    // prompt 在通知后收口(mock 顺序可控)
    await vi.waitFor(() => {
      if (mock.agent.prompt.mock.results.length === 0) throw new Error('prompt 未返回')
    })
    const events = await done
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types).toContain('TEXT_MESSAGE_START')
    expect(types).toContain('TEXT_MESSAGE_CONTENT')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    runtime.dispose()
  })

  it('stopReason 非 end → RUN_ERROR 终帧,流提前结束', async () => {
    const mock = makeMockAgent()
    mock.agent.prompt.mockImplementation(
      async (): Promise<{
        stopReason: 'cancelled'
      }> => {
        await new Promise((r) => setTimeout(r, 0))
        return { stopReason: 'cancelled' }
      }
    )
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const run = await runtime.startTurn('hi')
    const events = await collect(run.stream)
    const types = events.map((e) => e.type)
    expect(types).toContain('RUN_ERROR')
    expect(types[types.length - 1]).toBe('RUN_ERROR')
    expect(events[types.indexOf('RUN_ERROR')]).toMatchObject({
      message: expect.stringContaining('cancelled')
    })
    runtime.dispose()
  })

  it('prompt 抛错 → RUN_ERROR 终帧(不 reject 出去)', async () => {
    const mock = makeMockAgent()
    mock.agent.prompt.mockImplementation(async () => {
      throw new Error('agent boom')
    })
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const run = await runtime.startTurn('hi')
    const events = await collect(run.stream)
    const last = events[events.length - 1]
    expect(last).toMatchObject({ type: 'RUN_ERROR' })
    expect((last as { message: string }).message).toContain('agent boom')
    runtime.dispose()
  })

  it('abort → cancel 通知发出', async () => {
    const mock = makeMockAgent()
    let resolvePrompt: (v: { stopReason: 'cancelled' }) => void = () => {}
    mock.agent.prompt.mockImplementation(
      () =>
        new Promise<{ stopReason: 'cancelled' }>((r) => {
          resolvePrompt = r
        })
    )
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const ac = new AbortController()
    const run = await runtime.startTurn('hi', ac.signal)
    const done = collect(run.stream)
    ac.abort()
    await vi.waitFor(() => {
      if (mock.agent.cancel.mock.calls.length === 0) throw new Error('cancel 未发出')
    })
    resolvePrompt({ stopReason: 'cancelled' })
    await done
    runtime.dispose()
  })

  it('requestPermission:gate approve → allow_once 应答', async () => {
    const mock = makeMockAgent()
    const gate = {
      intercept: vi.fn(async () => ({ suspended: true, approved: true, args: {} }))
    }
    const runtime = await createAcpRuntime({
      ...baseOpts,
      approvalGate: gate as never,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const res = await mock.requestPermission({
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' }
      ],
      toolCall: { title: '执行危险操作', toolCallId: 'tc-1' }
    })
    expect(gate.intercept).toHaveBeenCalledWith(
      'thread-1',
      '执行危险操作',
      expect.objectContaining({ toolCallId: 'tc-1' })
    )
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } })
    runtime.dispose()
  })

  it('requestPermission:gate reject → reject_once 应答', async () => {
    const mock = makeMockAgent()
    const gate = {
      intercept: vi.fn(async () => ({ suspended: true, approved: false }))
    }
    const runtime = await createAcpRuntime({
      ...baseOpts,
      approvalGate: gate as never,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const res = await mock.requestPermission({
      options: [
        { optionId: 'allow-1', kind: 'allow_once', name: 'Allow' },
        { optionId: 'reject-1', kind: 'reject_once', name: 'Reject' }
      ]
    })
    expect(res).toEqual({ outcome: { outcome: 'selected', optionId: 'reject-1' } })
    runtime.dispose()
  })

  it('无 gate:放行 allow;无 allow 选项 → cancelled', async () => {
    const mock = makeMockAgent()
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    const allow = await mock.requestPermission({
      options: [{ optionId: 'allow-1', kind: 'allow_once', name: 'Allow' }]
    })
    expect(allow).toEqual({ outcome: { outcome: 'selected', optionId: 'allow-1' } })
    const noAllow = await mock.requestPermission({
      options: [{ optionId: 'reject-1', kind: 'reject_once', name: 'Reject' }]
    })
    expect(noAllow).toEqual({ outcome: { outcome: 'cancelled' } })
    runtime.dispose()
  })

  it('dispose 幂等;dispose 后 startTurn 拒绝', async () => {
    const mock = makeMockAgent()
    const runtime = await createAcpRuntime({
      ...baseOpts,
      connect: (o) => {
        mock.attach(o.handlers as never)
        return mock.agent
      }
    })
    await runtime.dispose()
    await runtime.dispose()
    await expect(runtime.startTurn('hi')).rejects.toThrow('已销毁')
  })
})
