// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { createAppServerTranslator } from './appServerTranslator'
import type { AppServerEvent } from './appServerTranslator'

const notif = (method: string, params: Record<string, unknown>): AppServerEvent => ({
  method,
  params
})

describe('C16 appServerTranslator — 生命周期通知 → exec 形态事件', () => {
  it('thread/started → thread.started(带 thread_id)', () => {
    const t = createAppServerTranslator()
    const { events, deltas } = t.feed(notif('thread/started', { threadId: 'th-1' }))
    expect(events).toHaveLength(1)
    expect(events[0]).toEqual({ type: 'thread.started', thread_id: 'th-1' })
    expect(deltas).toHaveLength(0)
  })

  it('turn/completed → turn.completed(usage 字段驼峰→蛇形 + Number 强转)', () => {
    const t = createAppServerTranslator()
    const { events } = t.feed(
      notif('turn/completed', {
        turn: {
          tokenUsage: {
            inputTokens: 100,
            cachedInputTokens: 40,
            cacheWriteInputTokens: 0,
            outputTokens: 50,
            reasoningOutputTokens: 10
          }
        }
      })
    )
    expect(events).toHaveLength(1)
    const ev = events[0] as unknown as { type: string; usage: Record<string, number> }
    expect(ev.type).toBe('turn.completed')
    expect(ev.usage).toEqual({
      input_tokens: 100,
      cached_input_tokens: 40,
      cache_write_input_tokens: 0,
      output_tokens: 50,
      reasoning_output_tokens: 10
    })
  })

  it('turn/completed usage 缺失字段全部 0 强转(不产出 undefined)', () => {
    const t = createAppServerTranslator()
    const { events } = t.feed(notif('turn/completed', { turn: {} }))
    const ev = events[0] as unknown as { usage: Record<string, number> }
    expect(ev.usage.input_tokens).toBe(0)
    expect(ev.usage.output_tokens).toBe(0)
  })
})

describe('C16 appServerTranslator — item 通知与类型映射', () => {
  it('item/started + item/completed(agentMessage)→ item.started/completed + 类型蛇形化', () => {
    const t = createAppServerTranslator()
    const r1 = t.feed(notif('item/started', { item: { id: 'i1', type: 'agentMessage', text: '' } }))
    expect(r1.events[0]).toMatchObject({ type: 'item.started', item: { type: 'agent_message' } })
    const r2 = t.feed(
      notif('item/completed', { item: { id: 'i1', type: 'agentMessage', text: '你好' } })
    )
    expect(r2.events[0]).toMatchObject({
      type: 'item.completed',
      item: { type: 'agent_message', text: '你好' }
    })
  })

  it('未知 item type 静默丢弃(userMessage 等非管线条目)', () => {
    const t = createAppServerTranslator()
    const r = t.feed(notif('item/completed', { item: { id: 'u1', type: 'userMessage' } }))
    expect(r.events).toHaveLength(0)
    expect(r.deltas).toHaveLength(0)
  })

  it('已知工具类型映射:commandExecution→command_execution', () => {
    const t = createAppServerTranslator()
    const r = t.feed(
      notif('item/started', {
        item: { id: 'c1', type: 'commandExecution', command: 'ls', aggregatedOutput: '' }
      })
    )
    expect(r.events[0]).toMatchObject({
      type: 'item.started',
      item: { type: 'command_execution', command: 'ls' }
    })
  })
})

describe('C16 appServerTranslator — delta 通道(核心)', () => {
  it('item/agentMessage/delta → text 增量,itemId 登记', () => {
    const t = createAppServerTranslator()
    const r = t.feed(notif('item/agentMessage/delta', { itemId: 'i1', delta: 'AG' }))
    expect(r.events).toHaveLength(0)
    expect(r.deltas).toEqual([{ kind: 'text', itemId: 'i1', delta: 'AG' }])
    expect(t.streamedItemIds().has('i1')).toBe(true)
  })

  it('reasoning 双通道 delta:textDelta 与 summaryTextDelta 都映射', () => {
    const t = createAppServerTranslator()
    const r1 = t.feed(notif('item/reasoning/textDelta', { itemId: 'r1', delta: '思考' }))
    const r2 = t.feed(notif('item/reasoning/summaryTextDelta', { itemId: 'r1', delta: '中' }))
    expect(r1.deltas).toEqual([{ kind: 'reasoning', itemId: 'r1', delta: '思考' }])
    expect(r2.deltas).toEqual([{ kind: 'reasoning', itemId: 'r1', delta: '中' }])
  })

  it('空 delta / 空 itemId 不产帧(脏通知防御)', () => {
    const t = createAppServerTranslator()
    expect(
      t.feed(notif('item/agentMessage/delta', { itemId: 'i1', delta: '' })).deltas
    ).toHaveLength(0)
    expect(
      t.feed(notif('item/agentMessage/delta', { itemId: '', delta: 'x' })).deltas
    ).toHaveLength(0)
  })

  it('流式后的 agentMessage completed 事件带 __streamed 标记(mapper 免整段重发)', () => {
    const t = createAppServerTranslator()
    t.feed(notif('item/agentMessage/delta', { itemId: 'i1', delta: 'AG' }))
    const r = t.feed(
      notif('item/completed', { item: { id: 'i1', type: 'agentMessage', text: 'AG-UI 全文' } })
    )
    const item = (r.events[0] as unknown as { item: Record<string, unknown> }).item
    expect(item.__streamed).toBe(true)
    expect(item.text).toBe('AG-UI 全文') // 整段保留(断流自愈兜底数据源)
  })
})

describe('C16 appServerTranslator — error 通知', () => {
  it('willRetry=true 忽略(重连噪音)', () => {
    const t = createAppServerTranslator()
    const r = t.feed(notif('error', { error: { message: 'Reconnecting... 1/5', willRetry: true } }))
    expect(r.events).toHaveLength(0)
  })

  it('willRetry 缺失/false → error 事件(message 透传)', () => {
    const t = createAppServerTranslator()
    const r = t.feed(notif('error', { error: { message: 'boom' } }))
    expect(r.events).toEqual([{ type: 'error', message: 'boom' }])
  })
})

describe('C16 appServerTranslator — 无关通知静默丢弃', () => {
  it('thread/status、mcpServer、account 等通知零输出', () => {
    const t = createAppServerTranslator()
    for (const m of [
      'thread/status/changed',
      'mcpServer/startupStatus/updated',
      'account/updated',
      'remoteControl/status/changed'
    ]) {
      const r = t.feed(notif(m, { threadId: 't' }))
      expect(r.events).toHaveLength(0)
      expect(r.deltas).toHaveLength(0)
    }
  })
})
