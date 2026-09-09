/**
 * Claude transport 单测:注入 mock 进程工厂,零真实子进程,零 flaky。
 *
 * 覆盖:
 * - argv 形态(-p/stream-json/verbose/permission-mode;--resume 二轮注入)
 * - stdin 投喂 user 消息(end 收口)
 * - stdout JSONL → AG-UI 事件流出;RUN_FINISHED 收口
 * - result 行 session_id 回填 + is_error → RUN_ERROR
 * - abort → SIGTERM;dispose 幂等;dispose 后 startTurn 拒绝
 */
import { describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { createClaudeRuntime } from './transport'
import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import type { AGUIEvent } from '../types'

/** 可编程 mock 子进程:stdout 可推行,事件可手动 emit */
function makeMockChild() {
  const writes: string[] = []
  const child = new EventEmitter() as unknown as ChildProcessWithoutNullStreams
  /** readline 需要 1:1 复用同一实例(setEncoding/pause/resume 在其内部调用) */
  const makeStream = (): NodeJS.ReadableStream & { setEncoding(e: string): void } => {
    const s = new EventEmitter() as unknown as NodeJS.ReadableStream & {
      setEncoding(e: string): void
      resume(): void
      pause(): void
    }
    ;(s as unknown as { setEncoding: (e: string) => void }).setEncoding = () => s
    ;(s as unknown as { resume: () => void }).resume = () => s
    ;(s as unknown as { pause: () => void }).pause = () => s
    return s
  }
  const stdout = makeStream()
  const stderr = makeStream()
  const stdin = {
    write: vi.fn((s: string) => {
      writes.push(s)
      return true
    }),
    end: vi.fn(),
    destroyed: false
  }
  Object.assign(child, {
    stdout,
    stderr,
    stdin,
    killed: false,
    kill: vi.fn((sig: string) => {
      ;(child as unknown as { killed: boolean }).killed = true
      child.emit('exit', sig === 'SIGTERM' ? null : 1, sig)
      return true
    })
  })
  let lastArgs: string[] = []
  return {
    child,
    writes,
    /** 记录 spawn args(经工厂闭包捕获) */
    setArgs(a: string[]) {
      lastArgs = a
    },
    getArgs: () => lastArgs,
    /** 模拟 CLI 输出一行 JSONL */
    line(obj: unknown) {
      stdout.emit('data', JSON.stringify(obj) + '\n')
    },
    /** 模拟进程正常退出 */
    exit(code = 0) {
      child.emit('exit', code, null)
    }
  }
}

function setupHarness() {
  const mock = makeMockChild()
  const spawnProcess = vi.fn((opts: { args: string[] }) => {
    mock.setArgs(opts.args)
    return mock.child
  })
  return { mock, spawnProcess }
}

const baseOpts = {
  binary: '/fake/claude',
  env: {},
  threadId: 'thread-1',
  runId: 'run-1'
}

async function collect(stream: AsyncGenerator<{ event: AGUIEvent | null }, void, unknown>) {
  const events: AGUIEvent[] = []
  for await (const frame of stream) {
    if (frame.event) events.push(frame.event)
  }
  return events
}

describe('createClaudeRuntime', () => {
  it('argv 形态正确;二轮 --resume 注入首轮 session_id', async () => {
    const { mock, spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    const run1 = await runtime.startTurn('第一轮')
    const done1 = collect(run1.stream)
    mock.line({ type: 'result', subtype: 'success', session_id: 'sess-abc', usage: {} })
    mock.exit(0)
    await done1
    expect(mock.getArgs()).not.toContain('--resume')

    const run2 = await runtime.startTurn('第二轮')
    const done2 = collect(run2.stream)
    mock.line({ type: 'result', subtype: 'success', session_id: 'sess-abc', usage: {} })
    mock.exit(0)
    await done2
    const args = mock.getArgs()
    expect(args).toContain('--resume')
    expect(args[args.indexOf('--resume') + 1]).toBe('sess-abc')
    void spawnProcess
    runtime.dispose()
  })

  it('prompt 走 stdin(user 消息 JSON);json 后 end 收口', async () => {
    const { mock, spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    const run = await runtime.startTurn('你好')
    const done = collect(run.stream)
    mock.line({ type: 'result', subtype: 'success', session_id: 's1', usage: {} })
    mock.exit(0)
    await done
    expect(mock.writes).toHaveLength(1)
    const sent = JSON.parse(mock.writes[0] ?? '{}') as {
      type: string
      message: { role: string; content: Array<{ type: string; text: string }> }
    }
    expect(sent.type).toBe('user')
    expect(sent.message.content[0]?.text).toBe('你好')
    expect(mock.child.stdin.end).toHaveBeenCalled()
    runtime.dispose()
  })

  it('assistant 行 → AG-UI 事件流出,RUN_FINISHED 收口', async () => {
    const { mock, spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    const run = await runtime.startTurn('hi')
    const done = collect(run.stream)
    mock.line({
      type: 'assistant',
      message: { id: 'm1', content: [{ type: 'text', text: '回答' }] }
    })
    mock.line({ type: 'result', subtype: 'success', session_id: 's1', usage: {} })
    mock.exit(0)
    const events = await done
    const types = events.map((e) => e.type)
    expect(types[0]).toBe('RUN_STARTED')
    expect(types).toContain('TEXT_MESSAGE_CONTENT')
    expect(types[types.length - 1]).toBe('RUN_FINISHED')
    runtime.dispose()
  })

  it('result is_error / 非 success subtype → RUN_ERROR 终帧', async () => {
    const { mock, spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    const run = await runtime.startTurn('hi')
    const done = collect(run.stream)
    mock.line({ type: 'result', subtype: 'error_during_execution', is_error: true, usage: {} })
    mock.exit(1)
    const events = await done
    const types = events.map((e) => e.type)
    expect(types).toContain('RUN_ERROR')
    expect(types[types.length - 1]).toBe('RUN_ERROR')
    runtime.dispose()
  })

  it('abort → SIGTERM 杀进程', async () => {
    const { mock, spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    const ac = new AbortController()
    const run = await runtime.startTurn('hi', ac.signal)
    const done = collect(run.stream)
    ac.abort()
    await done
    expect(mock.child.kill).toHaveBeenCalledWith('SIGTERM')
    runtime.dispose()
  })

  it('dispose 后 startTurn 拒绝', async () => {
    const { spawnProcess } = setupHarness()
    const runtime = await createClaudeRuntime({ ...baseOpts, spawnProcess })
    await runtime.dispose()
    await runtime.dispose()
    await expect(runtime.startTurn('hi')).rejects.toThrow('已销毁')
  })
})
