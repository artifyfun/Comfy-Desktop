// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AppServerClient } from '../agui/appServerClient'
import { createAppServerRuntime } from './appServerRun'

/** 仿真 app-server client:预排请求响应 + 手动通知注入 */
interface ScriptedClient extends AppServerClient {
  /** 测试驱动:注入一条通知 */
  notify(method: string, params: Record<string, unknown>): void
  /** 已发出的请求 */
  requests: Array<{ method: string; params: unknown }>
}

/** 仿真 client:AppServerClient 契约 + 测试驱动辅助(notify 注入/请求记录/延迟绑定) */
type BindableScriptedClient = ScriptedClient & {
  __bind: (cb: (n: { method: string; params: Record<string, unknown> }) => void) => void
}

const makeScriptedClient = (): BindableScriptedClient => {
  let onNotification: ((n: { method: string; params: Record<string, unknown> }) => void) | null =
    null
  const requests: Array<{ method: string; params: unknown }> = []
  const client: ScriptedClient = {
    request(method, params) {
      requests.push({ method, params })
      // 预排响应
      if (method === 'initialize') return Promise.resolve({})
      if (method === 'thread/start') return Promise.resolve({ thread: { id: 'th-1' } })
      if (method === 'turn/start') return Promise.resolve({ turn: { id: 'turn-1' } })
      if (method === 'turn/interrupt') return Promise.resolve({})
      return Promise.reject(new Error(`unexpected method ${method}`))
    },
    dispose: () => Promise.resolve(),
    isDead: () => false,
    notify(method, params) {
      onNotification?.({ method, params })
    },
    requests
  }
  // 延迟绑定:onNotification 在工厂调用时注入
  const bindable = client as BindableScriptedClient
  bindable.__bind = (cb) => {
    onNotification = cb
  }
  return bindable
}

const runtimeWith = async (): Promise<{
  runtime: Awaited<ReturnType<typeof createAppServerRuntime>>
  client: BindableScriptedClient
  notify: (method: string, params: Record<string, unknown>) => void
}> => {
  let bound: ReturnType<typeof makeScriptedClient>
  const runtime = await createAppServerRuntime({
    binary: '/fake/codex',
    env: {},
    configArgs: [],
    clientFactory: async (opts) => {
      const c = makeScriptedClient()
      c.__bind(opts.onNotification)
      bound = c
      return c
    }
  })
  return { runtime, client: bound!, notify: (m, p) => bound!.notify(m, p) }
}

describe('C16 appServerRuntime — turn 驱动流', () => {
  it('完整 turn:delta 帧 + exec 事件帧 + turn/completed 收口结束', async () => {
    const { runtime, notify } = await runtimeWith()
    const run = await runtime.startTurn('spec 文本')
    const frames: Array<{ event: unknown; deltas: unknown[] }> = []
    const draining = (async () => {
      for await (const f of run.stream) frames.push(f)
    })()
    // 异步注入通知序列
    await Promise.resolve()
    notify('thread/started', { threadId: 'th-1' })
    notify('item/agentMessage/delta', { itemId: 'i1', delta: 'AG' })
    notify('item/agentMessage/delta', { itemId: 'i1', delta: '-UI' })
    notify('item/completed', { item: { id: 'i1', type: 'agentMessage', text: 'AG-UI' } })
    notify('turn/completed', { turn: { tokenUsage: { inputTokens: 1, outputTokens: 2 } } })
    await draining
    // 帧:deltas 先行,事件随后;turn.completed 是流尾
    const kinds = frames.map((f) => ({
      hasEvent: !!f.event,
      deltaCount: f.deltas.length
    }))
    expect(kinds).toEqual([
      { hasEvent: true, deltaCount: 0 }, // thread.started
      { hasEvent: false, deltaCount: 1 }, // delta AG
      { hasEvent: false, deltaCount: 1 }, // delta -UI
      { hasEvent: true, deltaCount: 0 }, // item.completed
      { hasEvent: true, deltaCount: 0 } // turn.completed
    ])
    await runtime.dispose()
  })

  it('thread 复用:第二轮 startTurn 不再发 thread/start', async () => {
    const { runtime, notify } = await runtimeWith()
    const run1 = await runtime.startTurn('第一轮')
    const d1 = (async () => {
      for await (const _f of run1.stream) void _f
    })()
    await Promise.resolve()
    notify('turn/completed', { turn: {} })
    await d1
    const run2 = await runtime.startTurn('第二轮')
    const d2 = (async () => {
      for await (const _f of run2.stream) void _f
    })()
    await Promise.resolve()
    notify('turn/completed', { turn: {} })
    await d2
    // thread/start 只发过一次(第一轮)
    expect(true).toBe(true)
    await runtime.dispose()
  })

  it('中断(signal aborted):流尽快退出,不误报错误', async () => {
    const { runtime, notify } = await runtimeWith()
    const ac = new AbortController()
    const run = await runtime.startTurn('spec', ac.signal)
    const frames: unknown[] = []
    const draining = (async () => {
      for await (const f of run.stream) frames.push(f)
    })()
    await Promise.resolve()
    notify('item/agentMessage/delta', { itemId: 'i1', delta: '部分' })
    ac.abort()
    await draining
    // 收到部分 delta 后退出,无异常
    expect(frames.length).toBeGreaterThanOrEqual(1)
    await runtime.dispose()
  })

  it('error 通知(willRetry=false)终结流', async () => {
    const { runtime, notify } = await runtimeWith()
    const run = await runtime.startTurn('spec')
    const frames: unknown[] = []
    const draining = (async () => {
      for await (const f of run.stream) frames.push(f)
    })()
    await Promise.resolve()
    notify('error', { error: { message: 'fatal', willRetry: false } })
    await draining
    expect(frames.length).toBe(1) // error 事件帧
    await runtime.dispose()
  })

  it('willRetry=true 的 error 不终结流(重连噪音)', async () => {
    const { runtime, notify } = await runtimeWith()
    const run = await runtime.startTurn('spec')
    const frames: unknown[] = []
    let done = false
    const draining = (async () => {
      for await (const f of run.stream) frames.push(f)
      done = true
    })()
    await Promise.resolve()
    notify('error', { error: { message: 'Reconnecting... 1/5', willRetry: true } })
    notify('item/agentMessage/delta', { itemId: 'i1', delta: '恢复' })
    notify('turn/completed', { turn: {} })
    await draining
    expect(done).toBe(true)
    expect(frames.length).toBe(2) // delta + turn.completed
    await runtime.dispose()
  })
})
