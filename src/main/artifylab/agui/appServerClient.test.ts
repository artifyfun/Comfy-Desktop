// @vitest-environment node
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// mock child_process:spawn 返回仿真子进程(PassThrough 流 + EventEmitter)
vi.mock('node:child_process', () => {
  const spawnImpl = (): unknown => {
    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough
      stdout: PassThrough
      stderr: PassThrough
      killed: boolean
      kill: (sig?: string) => boolean
    }
    child.stdin = new PassThrough()
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.killed = false
    child.kill = () => {
      child.killed = true
      child.emit('exit', null, 'SIGKILL')
      return true
    }
    return child
  }
  return { spawn: vi.fn(spawnImpl) }
})

import { spawn as mockedSpawnRaw } from 'node:child_process'
import { startAppServerClient } from './appServerClient'

const mockedSpawn = vi.mocked(mockedSpawnRaw)

/** 仿真子进程形态(PassThrough 流版) */
interface FakeChild {
  stdin: { write: (s: string) => boolean }
  stdout: { write: (s: string) => boolean }
  stderr: unknown
  killed: boolean
  kill: (sig?: string) => boolean
  on: EventEmitter['on']
  emit: EventEmitter['emit']
}

/** 拿到 spawn 出来的仿真子进程 */
const lastChild = (): FakeChild => {
  return mockedSpawn.mock.results[mockedSpawn.mock.results.length - 1]!.value as FakeChild
}

/** 向客户端喂一行 stdout JSON */
const feedLine = (child: FakeChild, obj: unknown): void => {
  child.stdout.write(JSON.stringify(obj) + '\n')
}

afterEach(() => {
  vi.clearAllMocks()
})

describe('C16 appServerClient — JSON-RPC 基础', () => {
  it('request 发送带 id 的 JSON-RPC 帧,响应 resolve', async () => {
    const notifications: Array<{ method: string }> = []
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: (n) => notifications.push(n)
    })
    const child = lastChild()
    const wrote: string[] = []
    child.stdin.write = (s: string) => {
      wrote.push(s)
      // 模拟服务端回响应
      const req = JSON.parse(s) as { id: number; method: string }
      queueMicrotask(() => feedLine(child, { jsonrpc: '2.0', id: req.id, result: { ok: 1 } }))
      return true
    }
    const res = (await client.request('initialize', { clientInfo: {} })) as { ok: number }
    expect(res).toEqual({ ok: 1 })
    const sent = JSON.parse(wrote[0]!) as { jsonrpc: string; id: number; method: string }
    expect(sent.jsonrpc).toBe('2.0')
    expect(sent.method).toBe('initialize')
    await client.dispose()
  })

  it('错误响应 reject(code+message)', async () => {
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: () => {}
    })
    const child = lastChild()
    child.stdin.write = (s: string) => {
      const req = JSON.parse(s) as { id: number }
      queueMicrotask(() =>
        feedLine(child, { jsonrpc: '2.0', id: req.id, error: { code: -32600, message: 'bad' } })
      )
      return true
    }
    await expect(client.request('turn/start', {})).rejects.toThrow('-32600')
    await expect(client.request('turn/start', {})).rejects.toThrow('bad')
    await client.dispose()
  })

  it('通知(method 无 id)上抛 onNotification,不进请求表', async () => {
    const got: Array<{ method: string; params: Record<string, unknown> }> = []
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: (n) => got.push(n)
    })
    const child = lastChild()
    feedLine(child, {
      jsonrpc: '2.0',
      method: 'item/agentMessage/delta',
      params: { itemId: 'i1', delta: 'AG' }
    })
    feedLine(child, { jsonrpc: '2.0', method: 'turn/completed', params: { turn: {} } })
    expect(got).toHaveLength(2)
    expect(got[0]!.params.delta).toBe('AG')
    await client.dispose()
  })

  it('非 JSON 行跳过不炸(脏 stdout 防御)', async () => {
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: () => {}
    })
    const child = lastChild() as FakeChild & { stdout: PassThrough }
    expect(() => child.stdout.emit('data', 'not-json\n')).not.toThrow()
    expect(() => child.stdout.emit('data', '\n')).not.toThrow()
    await client.dispose()
  })

  it('onNotification 抛异常不杀会话(后续通知继续)', async () => {
    let calls = 0
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: () => {
        calls++
        if (calls === 1) throw new Error('handler boom')
      }
    })
    const child = lastChild()
    feedLine(child, { method: 'a', params: {} })
    feedLine(child, { method: 'b', params: {} })
    expect(calls).toBe(2)
    await client.dispose()
  })

  it('进程退出:isDead=true,pending 全 reject', async () => {
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: () => {}
    })
    const child = lastChild()
    const pending = client.request('turn/start', {})
    const swallow = pending.catch(() => {})
    child.emit('exit', 1, null)
    await expect(pending).rejects.toThrow('退出')
    await swallow
    expect(client.isDead()).toBe(true)
    await expect(client.request('x', {})).rejects.toThrow()
  })

  it('请求超时 reject(定时器清理)', async () => {
    vi.useFakeTimers()
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      requestTimeoutMs: 50,
      onNotification: () => {}
    })
    const p = client.request('turn/start', {})
    const swallow = p.catch(() => {})
    vi.advanceTimersByTime(60)
    await expect(p).rejects.toThrow('超时')
    await swallow
    vi.useRealTimers()
    await client.dispose()
  })

  it('dispose 幂等,kill 子进程', async () => {
    const client = startAppServerClient({
      binary: '/fake/codex',
      env: {},
      onNotification: () => {}
    })
    const child = lastChild()
    await client.dispose()
    await client.dispose()
    expect(child.killed).toBe(true)
  })

  it('configArgs 展开为 -c key value 对', () => {
    startAppServerClient({
      binary: '/fake/codex',
      env: {},
      configArgs: ['model="g"', 'model_provider="p"'],
      onNotification: () => {}
    })
    const call = (mockedSpawn as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!
    expect(call[0]).toBe('/fake/codex')
    expect(call[1]).toEqual(['app-server', '-c', 'model="g"', '-c', 'model_provider="p"'])
  })
})
