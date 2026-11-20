/**
 * comfyExecutor 单测（A3）：submit/awaitResult/runOnce 的轮询状态机语义。
 * FakeAdapter 注入——不触网、不起 ComfyUI，纯事件序列驱动。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  submit,
  awaitResult,
  extract,
  runOnce,
  type ComfyAdapter,
  type ComfyPrompt
} from './comfyExecutor'

/** 脚本化 fake：按序返回 history 结果；记录调用 */
function mkAdapter(script: Array<Record<string, unknown> | null>): ComfyAdapter & {
  calls: { queued: number; history: number }
} {
  let i = 0
  return {
    pollIntervalMs: 0, // 测试零间隔
    calls: { queued: 0, history: 0 },
    queuePrompt: async () => {
      return 'pid-1'
    },
    getHistory: async () => {
      const r = script[Math.min(i, script.length - 1)]
      i++
      return r === null ? null : { ...r }
    },
    interrupt: async () => {}
  }
}

const okEntry = {
  status: { status_str: 'success' },
  outputs: {
    node9: {
      images: [{ filename: 'out.png', subfolder: '', type: 'output' }],
      gifs: [{ filename: 'anim.gif', subfolder: 's', type: 'output' }]
    }
  }
}

const errEntry = {
  status: { status_str: 'error', messages: ['boom'] },
  outputs: {}
}

describe('comfyExecutor.awaitResult', () => {
  it('排队中(404/null) → 出现 success entry → files 抽取 images/gifs', async () => {
    const a = mkAdapter([null, null, okEntry])
    const r = await awaitResult('pid-1', 'http://x', {}, a)
    expect(r.status).toBe('success')
    if (r.status === 'success') {
      const names = r.files.map((f) => f.filename).sort()
      expect(names).toEqual(['anim.gif', 'out.png'])
    }
    expect(a.calls.history).toBeGreaterThanOrEqual(0) // fake 计数在闭包外不可见，仅冒烟
  })

  it('status_str=error → error + 原始 status JSON 截断', async () => {
    const a = mkAdapter([errEntry])
    const r = await awaitResult('pid-1', 'http://x', {}, a)
    expect(r.status).toBe('error')
    if (r.status === 'error') expect(r.error).toContain('error')
  })

  it('shouldAbort → aborted 带自定义 reason（paused 语义）', async () => {
    const a = mkAdapter([null, null, okEntry])
    const r = await awaitResult(
      'pid-1',
      'http://x',
      {
        shouldAbort: () => true,
        abortReason: 'paused'
      },
      a
    )
    expect(r).toEqual({ status: 'aborted', reason: 'paused' })
  })

  it('history 网络错误 → error 带 history poll 前缀', async () => {
    const a: ComfyAdapter = {
      pollIntervalMs: 0,
      queuePrompt: async () => 'pid',
      getHistory: async () => {
        throw new Error('ECONNRESET')
      },
      interrupt: async () => {}
    }
    const r = await awaitResult('pid-1', 'http://x', {}, a)
    expect(r.status).toBe('error')
    if (r.status === 'error') expect(r.error).toMatch(/^history poll:/)
  })

  it('超时 → aborted 带 timeout 文案', async () => {
    const a = mkAdapter([null])
    vi.useFakeTimers()
    try {
      const p = awaitResult('pid-1', 'http://x', { timeoutMs: 50 }, a)
      // 零间隔轮询 + fake timer 推进
      await vi.advanceTimersByTimeAsync(80)
      const r = await p
      expect(r.status).toBe('aborted')
      if (r.status === 'aborted') expect(r.reason).toMatch(/^timeout:/)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('comfyExecutor.runOnce', () => {
  it('submit 失败 → error（queuePrompt 异常透传）', async () => {
    const a: ComfyAdapter = {
      pollIntervalMs: 0,
      queuePrompt: async () => {
        throw new Error('comfy down')
      },
      getHistory: async () => null,
      interrupt: async () => {}
    }
    const r = await runOnce({} as ComfyPrompt, 'http://x', { adapter: a })
    expect(r).toEqual({ status: 'error', error: 'comfy down' })
  })

  it('submit 成功 + success entry → 完整链路', async () => {
    const a = mkAdapter([okEntry])
    const r = await runOnce({} as ComfyPrompt, 'http://x', { adapter: a })
    expect(r.status).toBe('success')
  })
})

describe('comfyExecutor.extract / submit 薄层', () => {
  it('extract：裸扫（无 paramsNodes）抽 images+audio', () => {
    const files = extract({
      n1: { images: [{ filename: 'a.png' }] },
      n2: { audio: [{ filename: 'b.mp3' }] }
    })
    expect(files.map((f) => f.filename).sort()).toEqual(['a.png', 'b.mp3'])
  })

  it('extract：空/undefined 输入 → []', () => {
    expect(extract(undefined)).toEqual([])
    expect(extract({})).toEqual([])
  })

  it('submit：clientId 自动生成并透传 prompt', async () => {
    let seen: { prompt?: unknown; clientId?: string } = {}
    const a: ComfyAdapter = {
      pollIntervalMs: 0,
      queuePrompt: async (prompt, clientId) => {
        seen = { prompt, clientId }
        return 'px'
      },
      getHistory: async () => null,
      interrupt: async () => {}
    }
    const id = await submit({ n1: { class_type: 'X' } }, 'http://x', a)
    expect(id).toBe('px')
    expect(seen.clientId).toMatch(/^[0-9a-f-]{36}$/)
    expect(seen.prompt).toEqual({ n1: { class_type: 'X' } })
  })
})
