// stores/__tests__/aguiSession.test.js — C9 Pinia 会话 store 测试
// 覆盖：事件序列驱动（ReadableStream mock Response，全部走 bindStream 真实路径）→
// messages 形状（text 聚合 delta / tool 三帧聚合 / reasoning 折叠）、双线程隔离
// （generating 按 threadId）、16ms 节流 flush 后数据完整、loadHistory 重放。
//
// 测试策略：createTestingPinia 会 stub 掉 setup-store 返回的 actions（对 setup 语法
// store 语义不符），故用真实 createPinia + setActivePinia（纯 JS 包惯例，等价
// setup 形式直测）。@pinia/testing 在本包可解析（探针实测），但此处不需要 stub 能力。
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAguiSessionStore } from '../aguiSession'

const encoder = new TextEncoder()
const frame = (event) => `data: ${JSON.stringify({ timestamp: 1, ...event })}\n\n`

/** 整段 SSE 流一次吐完的 mock Response（ReadableStream） */
function sseResponse(frames) {
  const stream = new ReadableStream({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(f))
      controller.close()
    },
  })
  return { body: stream }
}

/**
 * 手工逐段推送的 mock Response：push() 投喂文本块，close() 结束流。
 * 用于节流/隔离用例 —— 精确控制 chunk 交付时点（配合 fake timers）。
 */
function manualStream() {
  const queued = []
  let settleRead = null
  const deliver = (payload) => {
    if (settleRead) {
      const s = settleRead
      settleRead = null
      s(payload)
    } else {
      queued.push(payload)
    }
  }
  return {
    push(text) {
      deliver({ done: false, value: encoder.encode(text) })
    },
    close() {
      deliver({ done: true, value: undefined })
    },
    body: {
      getReader: () => ({
        read() {
          if (queued.length > 0) return Promise.resolve(queued.shift())
          return new Promise((resolve) => {
            settleRead = resolve
          })
        },
      }),
    },
  }
}

/**
 * 排空微任务队列：readAguiStream 每 chunk 消耗若干微任务 tick（await reader.read()），
 * 手工流同步投喂的 chunk 需要足够的 tick 才能被循环消化完（不推进 fake timers）。
 */
async function drainMicrotasks(rounds = 1024) {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve()
  }
}

/** 一轮完整 run 的标准帧序列（15 事件） */
function runFrames(threadId) {
  return [
    frame({ type: 'RUN_STARTED', threadId, runId: 'r-1' }),
    frame({ type: 'REASONING_MESSAGE_START', messageId: 'rs1', role: 'reasoning' }),
    frame({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'rs1', delta: '思考中' }),
    frame({ type: 'REASONING_MESSAGE_END', messageId: 'rs1' }),
    frame({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'wb_get_workflows' }),
    frame({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"q"' }),
    frame({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: ':1}' }),
    frame({ type: 'TOOL_CALL_END', toolCallId: 'tc1' }),
    frame({ type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', content: 'ok-result', role: 'tool' }),
    frame({ type: 'TEXT_MESSAGE_START', messageId: 'tm1', role: 'assistant' }),
    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'tm1', delta: 'Hel' }),
    frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'tm1', delta: 'lo' }),
    frame({ type: 'TEXT_MESSAGE_END', messageId: 'tm1' }),
    frame({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/tokenUsage/inputTokens', value: 12 }, { op: 'replace', path: '/tokenUsage/outputTokens', value: 34 }] }),
    frame({ type: 'RUN_FINISHED', threadId, runId: 'r-1' }),
  ]
}

beforeEach(() => {
  vi.useFakeTimers()
  setActivePinia(createPinia())
})
afterEach(() => {
  vi.useRealTimers()
})

describe('aguiSession store — bindStream（ReadableStream 真实路径）', () => {
  it('整轮 run 流：messages 形状正确（text 聚合 / tool 聚合 / reasoning 折叠）', async () => {
    const store = useAguiSessionStore()
    const result = await store.bindStream('t-1', sseResponse(runFrames('t-1')))

    expect(result.totalEvents).toBe(15)
    expect(result.malformedCount).toBe(0)

    const msgs = store.activeMessages('t-1')
    expect(msgs.map((m) => m.kind)).toEqual(['reasoning', 'tool', 'text'])
    expect(msgs[0]).toMatchObject({ id: 'rs1', kind: 'reasoning', role: 'reasoning', text: '思考中', threadId: 't-1' })
    expect(msgs[1]).toMatchObject({
      id: 'tc1', kind: 'tool', toolCallId: 'tc1', name: 'wb_get_workflows',
      args: '{"q":1}', result: 'ok-result', status: 'done',
    })
    expect(msgs[2]).toMatchObject({ id: 'tm1', kind: 'text', role: 'assistant', text: 'Hello', threadId: 't-1' })
    // 扁平数组与切片共享同一组对象
    expect(store.messages).toHaveLength(3)
    // STATE_DELTA /tokenUsage/* → tokenUsage
    expect(store.tokenUsage).toEqual({ inputTokens: 12, outputTokens: 34 })
    // run 结束复位生成态，无错误
    expect(store.generating['t-1']).toBe(false)
    expect(store.error['t-1']).toBeNull()
  })

  it('RUN_ERROR：error 兜底记录、generating 复位，错误不产生消息', async () => {
    const store = useAguiSessionStore()
    await store.bindStream(
      't-9',
      sseResponse([
        frame({ type: 'RUN_STARTED', threadId: 't-9', runId: 'r-9' }),
        frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }),
        frame({ type: 'RUN_ERROR', message: '模型超时', code: 'TIMEOUT' }),
      ]),
    )
    expect(store.error['t-9']).toBe('模型超时')
    expect(store.generating['t-9']).toBe(false)
    expect(store.activeMessages('t-9').map((m) => m.kind)).toEqual(['text'])
  })

  it('流读取抛错 → error 记录并 rethrow', async () => {
    const store = useAguiSessionStore()
    const badStream = { getReader: () => ({ read: vi.fn().mockRejectedValue(new Error('network reset')) }) }
    await expect(store.bindStream('t-err', { body: badStream })).rejects.toThrow('network reset')
    expect(store.error['t-err']).toBe('network reset')
    expect(store.generating['t-err']).toBe(false)
  })

  it('bindStream 入口同步置 generating=true（发出请求即生成中）', async () => {
    const store = useAguiSessionStore()
    const stream = manualStream()
    const p = store.bindStream('t-0', stream)
    expect(store.generating['t-0']).toBe(true)
    stream.close()
    await p
    expect(store.generating['t-0']).toBe(false)
  })
})

describe('aguiSession store — 16ms 节流 flush（fake timers）', () => {
  it('delta 先进缓冲：定时器未到时 state 不更新，16ms flush 后数据完整', async () => {
    const store = useAguiSessionStore()
    const stream = manualStream()
    const p = store.bindStream('t-2', stream)
    stream.push(frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }))
    for (let i = 0; i < 100; i += 1) {
      stream.push(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'a' }))
    }
    await drainMicrotasks()
    // 全部 delta 在缓冲里：state 仍是初始空串（节流生效）
    expect(store.activeMessages('t-2')[0].text).toBe('')

    vi.advanceTimersByTime(16)
    expect(store.activeMessages('t-2')[0].text).toBe('a'.repeat(100))

    stream.close()
    await p
    // 收尾 flush 不重复追加
    expect(store.activeMessages('t-2')[0].text).toBe('a'.repeat(100))
  })

  it('text:end 强制 flush，不等定时器', async () => {
    const store = useAguiSessionStore()
    const stream = manualStream()
    const p = store.bindStream('t-2', stream)
    stream.push(frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }))
    stream.push(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'done' }))
    stream.push(frame({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }))
    await drainMicrotasks()
    expect(store.activeMessages('t-2')[0].text).toBe('done')
    stream.close()
    await p
  })

  it('run:finish 强制 flush：末段 delta 晚于定时器推进也零丢失', async () => {
    const store = useAguiSessionStore()
    const stream = manualStream()
    const p = store.bindStream('t-2', stream)
    stream.push(frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }))
    stream.push(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'tail' }))
    stream.push(frame({ type: 'RUN_FINISHED', threadId: 't-2', runId: 'r' }))
    await drainMicrotasks()
    expect(store.activeMessages('t-2')[0].text).toBe('tail')
    stream.close()
    await p
  })
})

describe('aguiSession store — 双线程隔离', () => {
  it('两个 thread 并行：generating 按 threadId 独立，消息切片互不串', async () => {
    const store = useAguiSessionStore()
    const streamA = manualStream()
    const pA = store.bindStream('t-a', streamA)
    expect(store.generating['t-a']).toBe(true)

    // t-b 完整跑完一轮
    await store.bindStream('t-b', sseResponse(runFrames('t-b')))
    expect(store.generating['t-b']).toBe(false)
    expect(store.generating['t-a']).toBe(true) // t-a 仍在生成

    streamA.close()
    await pA
    expect(store.generating['t-a']).toBe(false)

    // 切片隔离：t-b 三条消息且全部归属 t-b；t-a 无消息
    expect(store.activeMessages('t-b')).toHaveLength(3)
    expect(store.activeMessages('t-a')).toHaveLength(0)
    expect(store.activeMessages('t-b').every((m) => m.threadId === 't-b')).toBe(true)
  })

  it('reset(threadId) 只清本会话：其余线程消息与生成态不受影响', async () => {
    const store = useAguiSessionStore()
    await store.bindStream('t-a', sseResponse(runFrames('t-a')))
    await store.bindStream('t-b', sseResponse(runFrames('t-b')))
    expect(store.messages).toHaveLength(6)

    store.reset('t-a')
    expect(store.activeMessages('t-a')).toHaveLength(0)
    expect(store.activeMessages('t-b')).toHaveLength(3)
    expect(store.messages.every((m) => m.threadId === 't-b')).toBe(true)
    expect(store.generating['t-b']).toBe(false)
    expect(store.generating['t-a']).toBeUndefined()
  })

  it('reset 清掉待 flush 缓冲：reset 后推进定时器不写入幽灵消息', async () => {
    const store = useAguiSessionStore()
    const stream = manualStream()
    const p = store.bindStream('t-g', stream)
    stream.push(frame({ type: 'TEXT_MESSAGE_START', messageId: 'mg', role: 'assistant' }))
    stream.push(frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'mg', delta: 'buffered' }))
    await drainMicrotasks()

    store.reset('t-g')
    vi.advanceTimersByTime(16)
    stream.close()
    await p
    expect(store.activeMessages('t-g')).toHaveLength(0)
  })
})

describe('aguiSession store — loadHistory（historyReassembler 管线复用）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    setActivePinia(createPinia())
  })

  const rec = (event, seq) => ({ runId: 'r-1', seq, eventType: event.type, content: JSON.stringify({ timestamp: 1, ...event }) })

  it('历史 records 重放 → 与实时流同构的 messages', () => {
    const store = useAguiSessionStore()
    const result = store.loadHistory('t-h', [
      rec({ type: 'RUN_STARTED', threadId: 't-h', runId: 'r-1' }, 1),
      rec({ type: 'REASONING_MESSAGE_START', messageId: 'h-r', role: 'reasoning' }, 2),
      rec({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'h-r', delta: '历史思考' }, 3),
      rec({ type: 'REASONING_MESSAGE_END', messageId: 'h-r' }, 4),
      rec({ type: 'TOOL_CALL_START', toolCallId: 'h-t', toolCallName: 'wb_x' }, 5),
      rec({ type: 'TOOL_CALL_ARGS', toolCallId: 'h-t', delta: '{"a":1}' }, 6),
      rec({ type: 'TOOL_CALL_END', toolCallId: 'h-t' }, 7),
      rec({ type: 'TOOL_CALL_RESULT', toolCallId: 'h-t', content: '历史结果', role: 'tool' }, 8),
      rec({ type: 'TEXT_MESSAGE_START', messageId: 'h-m', role: 'assistant' }, 9),
      rec({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'h-m', delta: '历史回' }, 10),
      rec({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'h-m', delta: '答' }, 11),
      rec({ type: 'TEXT_MESSAGE_END', messageId: 'h-m' }, 12),
      rec({ type: 'RUN_FINISHED', threadId: 't-h', runId: 'r-1' }, 13),
    ])
    expect(result.totalEvents).toBe(13)
    expect(result.malformedRecords).toBe(0)

    const msgs = store.activeMessages('t-h')
    expect(msgs.map((m) => m.kind)).toEqual(['reasoning', 'tool', 'text'])
    expect(msgs[0].text).toBe('历史思考')
    expect(msgs[1]).toMatchObject({ args: '{"a":1}', result: '历史结果', status: 'done' })
    expect(msgs[2].text).toBe('历史回答')
    // 同步收尾 flush：generating 落定（历史行缺 RUN_FINISHED 也不悬挂）
    expect(store.generating['t-h']).toBe(false)
  })

  it('loadHistory 替换该 thread 现有消息（先 reset 再重放）', () => {
    const store = useAguiSessionStore()
    store.loadHistory('t-h', [rec({ type: 'TEXT_MESSAGE_START', messageId: 'old', role: 'assistant' }, 1), rec({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'old', delta: 'v1' }, 2)])
    expect(store.activeMessages('t-h')).toHaveLength(1)

    store.loadHistory('t-h', [rec({ type: 'TEXT_MESSAGE_START', messageId: 'new', role: 'assistant' }, 1), rec({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'new', delta: 'v2' }, 2)])
    const msgs = store.activeMessages('t-h')
    expect(msgs).toHaveLength(1)
    expect(msgs[0].id).toBe('new')
    expect(msgs[0].text).toBe('v2')
  })

  it('custom 事件（非 keepalive）落时间线；tokenUsage patch 应用', () => {
    const store = useAguiSessionStore()
    store.loadHistory('t-h', [
      rec({ type: 'CUSTOM', name: 'wb_plan', value: { steps: [1, 2] } }, 1),
      rec({ type: 'CUSTOM', name: 'keepalive' }, 2),
      rec({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/tokenUsage/total', value: 7 }] }, 3),
    ])
    const msgs = store.activeMessages('t-h')
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({ kind: 'custom', name: 'wb_plan', value: { steps: [1, 2] } })
    expect(store.tokenUsage).toEqual({ total: 7 })
  })
})
