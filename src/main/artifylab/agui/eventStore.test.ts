// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import { EventStore, eventFamily, DEFAULT_LIST_LIMIT, MAX_LIST_LIMIT } from './eventStore'
import {
  runStarted,
  runFinished,
  runError,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  stateDelta,
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
  custom,
  type AGUIEvent
} from './types'

/** 全部用 :memory:,零临时文件清理负担(迁移文档 C3 验收约定)。 */
function makeStore(): EventStore {
  return new EventStore(':memory:')
}

describe('appendEvent + listEvents 往返(事件 JSON 保真)', () => {
  it('content 列是 JSON.stringify(event) 原文,parse 回来与原事件深度相等', () => {
    const store = makeStore()
    const events: AGUIEvent[] = [
      runStarted('t1', 'r1'),
      textMessageStart('m1'),
      textMessageContent('m1', '你好,世界'),
      textMessageEnd('m1'),
      toolCallStart('tc1', 'wb_list_templates'),
      toolCallArgs('tc1', '{"limit":5}'),
      toolCallEnd('tc1'),
      toolCallResult('tc1', '[]'),
      stateDelta([{ op: 'replace', path: '/tokenUsage/inputTokens', value: 12 }]),
      custom('wb_plan', { steps: [{ shortcut: 'wb_x' }] }),
      runFinished('t1', 'r1')
    ]
    for (const e of events) store.appendEvent('t1', 'r1', e)

    const listed = store.listEvents('t1')
    expect(listed).toHaveLength(events.length)
    for (let i = 0; i < events.length; i++) {
      expect(JSON.parse(listed[i]!.content)).toEqual(events[i])
      // 保真到字节级:content == JSON.stringify(原事件)
      expect(listed[i]!.content).toBe(JSON.stringify(events[i]))
    }
  })

  it('构造器 omit undefined 的语义在往返后保持(custom 无 value 时无 value 键)', () => {
    const store = makeStore()
    store.appendEvent('t1', 'r1', custom('marker')) // 无 value
    const back = JSON.parse(store.listEvents('t1')[0]!.content) as Record<string, unknown>
    expect(back).toEqual({ type: 'CUSTOM', timestamp: expect.any(Number), name: 'marker' })
    expect('value' in back).toBe(false)
  })
})

describe('seq 自增:同 run 连续,跨 run / 跨 thread 独立', () => {
  it('同 thread+run 内 seq 递增 1,2,3…', () => {
    const store = makeStore()
    store.appendEvent('t1', 'r1', runStarted('t1', 'r1'))
    store.appendEvent('t1', 'r1', textMessageContent('m1', 'a'))
    store.appendEvent('t1', 'r1', runFinished('t1', 'r1'))
    expect(store.listEvents('t1').map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('跨 run 独立自增(每个 run 各自从 1 起)', () => {
    const store = makeStore()
    store.appendEvent('t1', 'r1', runStarted('t1', 'r1'))
    store.appendEvent('t1', 'r1', runFinished('t1', 'r1'))
    store.appendEvent('t1', 'r2', runStarted('t1', 'r2'))
    store.appendEvent('t1', 'r2', textMessageContent('m2', 'x'))
    store.appendEvent('t1', 'r2', runFinished('t1', 'r2'))

    const t1 = store.listEvents('t1')
    expect(t1.filter((e) => e.runId === 'r1').map((e) => e.seq)).toEqual([1, 2])
    expect(t1.filter((e) => e.runId === 'r2').map((e) => e.seq)).toEqual([1, 2, 3])
  })

  it('跨 thread 独立(同 runId 名也不串号)', () => {
    const store = makeStore()
    store.appendEvent('tA', 'r1', runStarted('tA', 'r1'))
    store.appendEvent('tA', 'r1', runFinished('tA', 'r1'))
    store.appendEvent('tB', 'r1', runStarted('tB', 'r1'))
    expect(store.listEvents('tA').map((e) => e.seq)).toEqual([1, 2])
    expect(store.listEvents('tB').map((e) => e.seq)).toEqual([1])
  })

  it('listEvents 默认按落库时序升序,runId 过滤后仍 seq 升序', () => {
    const store = makeStore()
    store.appendMany('t1', 'r1', [
      runStarted('t1', 'r1'),
      textMessageContent('m1', 'a'),
      runFinished('t1', 'r1')
    ])
    store.appendMany('t1', 'r2', [
      runStarted('t1', 'r2'),
      custom('wb_plan', {}),
      runFinished('t1', 'r2')
    ])
    const all = store.listEvents('t1')
    // 跨 run:按落库时序(id)排列,先 r1 后 r2
    expect(all.map((e) => e.runId)).toEqual(['r1', 'r1', 'r1', 'r2', 'r2', 'r2'])
    const filtered = store.listEvents('t1', { runId: 'r2' })
    expect(filtered.map((e) => e.seq)).toEqual([1, 2, 3])
    expect(filtered.every((e) => e.runId === 'r2')).toBe(true)
  })
})

describe('listRuns 分组统计', () => {
  it('按 run 分组:count / firstAt / lastAt,按 run 首次出现排序', () => {
    const store = makeStore()
    const t0 = 1_000_000
    let tick = t0
    // 事件构造器与 appendEvent 各取一次 Date.now();用单调递增假钟,时序无歧义
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => ++tick)
    try {
      // r1: 2 条 → 之后补第 3 条;r2: 2 条
      store.appendEvent('t1', 'r1', runStarted('t1', 'r1'))
      store.appendEvent('t1', 'r1', textMessageContent('m1', 'a'))
      store.appendEvent('t1', 'r2', runStarted('t1', 'r2'))
      store.appendEvent('t1', 'r2', runFinished('t1', 'r2'))
      store.appendEvent('t1', 'r1', runFinished('t1', 'r1'))
    } finally {
      spy.mockRestore()
    }

    // r1 事件 created_at: t0+2..t0+4, t0+10(每 append 取 2 次:构造器 timestamp + created_at)
    // r2 事件 created_at: t0+6..t0+9;这里只断言分组/计数/相对时序,不耦合取钟次数
    const runs = store.listRuns('t1')
    expect(runs.map((r) => r.runId)).toEqual(['r1', 'r2'])
    expect(runs.map((r) => r.count)).toEqual([3, 2])
    expect(runs[0]!.firstAt).toBeLessThan(runs[1]!.firstAt)
    expect(runs[0]!.firstAt).toBeGreaterThan(t0)
    expect(runs[0]!.lastAt).toBeGreaterThan(runs[0]!.firstAt) // r1 首条早于尾条
    expect(runs[1]!.lastAt).toBeGreaterThanOrEqual(runs[1]!.firstAt)
  })

  it('只统计本 thread;无事件的 thread 返回空数组', () => {
    const store = makeStore()
    store.appendEvent('t1', 'r1', runStarted('t1', 'r1'))
    expect(store.listRuns('t2')).toEqual([])
    expect(store.listRuns('t1')).toHaveLength(1)
  })
})

describe('listEvents 分页 offset/limit 边界', () => {
  it('默认 limit 500:超过 500 条截断,offset 翻页取下一批', () => {
    const store = makeStore()
    const total = 1200
    store.appendMany(
      't1',
      'r1',
      Array.from({ length: total }, (_, i) => textMessageContent('m1', `d${i}`))
    )
    expect(store.countEvents('t1')).toBe(total)

    const page1 = store.listEvents('t1')
    expect(page1).toHaveLength(DEFAULT_LIST_LIMIT)
    expect(JSON.parse(page1[0]!.content)).toMatchObject({ delta: 'd0' })
    expect(JSON.parse(page1[DEFAULT_LIST_LIMIT - 1]!.content)).toMatchObject({ delta: 'd499' })

    const page2 = store.listEvents('t1', { offset: 500 })
    expect(page2).toHaveLength(500)
    expect(JSON.parse(page2[0]!.content)).toMatchObject({ delta: 'd500' })

    const tail = store.listEvents('t1', { offset: 1100 })
    expect(tail).toHaveLength(100)
    expect(JSON.parse(tail[0]!.content)).toMatchObject({ delta: 'd1100' })
  })

  it('offset 越界返回空数组;limit 大于剩余量时只返回剩余', () => {
    const store = makeStore()
    store.appendMany('t1', 'r1', [runStarted('t1', 'r1'), runFinished('t1', 'r1')])
    expect(store.listEvents('t1', { offset: 5 })).toEqual([])
    expect(store.listEvents('t1', { offset: 2 })).toEqual([])
    expect(store.listEvents('t1', { offset: 1, limit: 10 })).toHaveLength(1)
  })

  it('limit/offset 非常规输入被钳制(0/负数→1/0;超上限→MAX_LIST_LIMIT)', () => {
    const store = makeStore()
    store.appendMany(
      't1',
      'r1',
      Array.from({ length: 5 }, (_, i) => textMessageContent('m1', `d${i}`))
    )
    expect(store.listEvents('t1', { limit: 0 })).toHaveLength(1)
    expect(store.listEvents('t1', { limit: -5 })).toHaveLength(1)
    expect(store.listEvents('t1', { offset: -3 })).toHaveLength(5)
    const big = Array.from({ length: MAX_LIST_LIMIT + 50 }, (_, i) =>
      textMessageContent('m2', `b${i}`)
    )
    store.appendMany('t1', 'r2', big)
    expect(store.listEvents('t1', { runId: 'r2', limit: 999_999 })).toHaveLength(MAX_LIST_LIMIT)
  })

  it('offset+limit 组合翻页无缝无重叠', () => {
    const store = makeStore()
    store.appendMany(
      't1',
      'r1',
      Array.from({ length: 7 }, (_, i) => textMessageContent('m1', `d${i}`))
    )
    expect(store.listEvents('t1', { offset: 0, limit: 3 }).map((e) => e.seq)).toEqual([1, 2, 3])
    expect(store.listEvents('t1', { offset: 3, limit: 3 }).map((e) => e.seq)).toEqual([4, 5, 6])
    expect(store.listEvents('t1', { offset: 6, limit: 3 }).map((e) => e.seq)).toEqual([7])
  })
})

describe('appendMany 事务性(all-or-nothing)', () => {
  it('全部成功:一批落库,seq 连续', () => {
    const store = makeStore()
    store.appendMany('t1', 'r1', [
      runStarted('t1', 'r1'),
      toolCallStart('tc1', 'wb_list_templates'),
      toolCallArgs('tc1', '{}'),
      toolCallEnd('tc1'),
      toolCallResult('tc1', '[]'),
      runFinished('t1', 'r1')
    ])
    expect(store.countEvents('t1')).toBe(6)
    expect(store.listEvents('t1').map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('中途失败全回滚:整批不落库,既有数据不受影响', () => {
    const store = makeStore()
    store.appendEvent('t1', 'r1', runStarted('t1', 'r1')) // 既有数据 seq=1

    // 循环引用 → JSON.stringify 抛 TypeError,模拟第 3 条写入失败
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const bad = {
      type: 'CUSTOM',
      timestamp: Date.now(),
      name: 'bad',
      value: circular
    } as unknown as AGUIEvent

    expect(() =>
      store.appendMany('t1', 'r2', [
        runStarted('t1', 'r2'),
        textMessageContent('m', 'good'),
        bad, // 序列化失败 → 整批回滚
        runFinished('t1', 'r2')
      ])
    ).toThrow(TypeError)

    // r2 一条都没落;既有 r1 数据完好
    expect(store.listEvents('t1', { runId: 'r2' })).toEqual([])
    expect(store.countEvents('t1')).toBe(1)
    expect(store.listEvents('t1', { runId: 'r1' }).map((e) => e.seq)).toEqual([1])

    // 回滚后 seq 计数器未被半途推进:r2 重试仍从 1 开始
    store.appendMany('t1', 'r2', [runStarted('t1', 'r2'), runFinished('t1', 'r2')])
    expect(store.listEvents('t1', { runId: 'r2' }).map((e) => e.seq)).toEqual([1, 2])
  })

  it('appendMany([]) 是 no-op', () => {
    const store = makeStore()
    store.appendMany('t1', 'r1', [])
    expect(store.countEvents('t1')).toBe(0)
  })
})

describe('event_type 家族归一', () => {
  it('TEXT_MESSAGE_* → TEXT_MESSAGE', () => {
    expect(eventFamily('TEXT_MESSAGE_START')).toBe('TEXT_MESSAGE')
    expect(eventFamily('TEXT_MESSAGE_CONTENT')).toBe('TEXT_MESSAGE')
    expect(eventFamily('TEXT_MESSAGE_END')).toBe('TEXT_MESSAGE')
  })

  it('REASONING* → REASONING(含 START/END 与 MESSAGE_*)', () => {
    expect(eventFamily('REASONING_START')).toBe('REASONING')
    expect(eventFamily('REASONING_END')).toBe('REASONING')
    expect(eventFamily('REASONING_MESSAGE_START')).toBe('REASONING')
    expect(eventFamily('REASONING_MESSAGE_CONTENT')).toBe('REASONING')
    expect(eventFamily('REASONING_MESSAGE_END')).toBe('REASONING')
  })

  it('TOOL_CALL_* → TOOL_CALL', () => {
    expect(eventFamily('TOOL_CALL_START')).toBe('TOOL_CALL')
    expect(eventFamily('TOOL_CALL_ARGS')).toBe('TOOL_CALL')
    expect(eventFamily('TOOL_CALL_END')).toBe('TOOL_CALL')
    expect(eventFamily('TOOL_CALL_RESULT')).toBe('TOOL_CALL')
  })

  it('CUSTOM / RUN_ERROR 原样;其余类型本身即家族前缀', () => {
    expect(eventFamily('CUSTOM')).toBe('CUSTOM')
    expect(eventFamily('RUN_ERROR')).toBe('RUN_ERROR')
    expect(eventFamily('RUN_STARTED')).toBe('RUN_STARTED')
    expect(eventFamily('STATE_DELTA')).toBe('STATE_DELTA')
    expect(eventFamily('STEP_STARTED')).toBe('STEP_STARTED')
    expect(eventFamily('MESSAGES_SNAPSHOT')).toBe('MESSAGES_SNAPSHOT')
  })

  it('落库 event_type 列存家族前缀,content 仍是完整事件 JSON', () => {
    const store = makeStore()
    store.appendMany('t1', 'r1', [
      reasoningMessageStart('rm1'),
      reasoningMessageContent('rm1', '思考中'),
      reasoningMessageEnd('rm1'),
      toolCallStart('tc1', 'wb_x'),
      toolCallResult('tc1', 'ok'),
      runError('boom')
    ])
    expect(store.listEvents('t1').map((e) => e.eventType)).toEqual([
      'REASONING',
      'REASONING',
      'REASONING',
      'TOOL_CALL',
      'TOOL_CALL',
      'RUN_ERROR'
    ])
    // content 不受归一影响:仍是原始事件 JSON
    const raw = JSON.parse(store.listEvents('t1')[0]!.content) as { type: string }
    expect(raw.type).toBe('REASONING_MESSAGE_START')
  })
})

describe('countEvents', () => {
  it('跨 run 计数;未知 thread 为 0', () => {
    const store = makeStore()
    expect(store.countEvents('t1')).toBe(0)
    store.appendMany('t1', 'r1', [runStarted('t1', 'r1'), runFinished('t1', 'r1')])
    store.appendMany('t1', 'r2', [runStarted('t1', 'r2')])
    expect(store.countEvents('t1')).toBe(3)
    expect(store.countEvents('tX')).toBe(0)
  })
})
