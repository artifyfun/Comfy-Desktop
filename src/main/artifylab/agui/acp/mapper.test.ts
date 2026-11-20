/**
 * ACP mapper 单测:session/update → AG-UI 事件映射的纯状态机测试。
 *
 * 覆盖(对齐 codexMapper.test.ts 的幂等/自愈/降级测试风格):
 * - agent_message_chunk / agent_thought_chunk:START 首见一次 + CONTENT 增量
 * - tool_call:START+ARGS+END 三帧一次;重放去重
 * - tool_call_update:completed/failed → RESULT 一次;乱序自愈补 START 三帧;
 *   非终态 → CUSTOM acp_tool_update
 * - plan:全量快照 → CUSTOM todos;无变化不发(防刷屏)
 * - 降级:未知 sessionUpdate 种类、非 text content 块、空 delta 全部忽略不失败
 */
import { describe, expect, it } from 'vitest'
import { createAcpMapper } from './mapper'
import type { SessionNotification } from '@zed-industries/agent-client-protocol/dist/schema'

/** 构造 session/update 通知的最小工厂(只带测试关注的字段) */
function notify(update: Record<string, unknown>): SessionNotification {
  return { sessionId: 'sess-1', update } as unknown as SessionNotification
}

function textBlock(text: string): unknown {
  return { type: 'text', text }
}

describe('createAcpMapper', () => {
  it('agent_message_chunk 首见发 START+CONTENT,后续只发 CONTENT', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    const first = m.feed(
      notify({ sessionUpdate: 'agent_message_chunk', content: textBlock('你好') })
    )
    expect(first.map((e) => e.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT'])
    expect(first[1]).toMatchObject({ messageId: 'acp-msg-t1', delta: '你好' })
    const second = m.feed(notify({ sessionUpdate: 'agent_message_chunk', content: textBlock('!') }))
    expect(second.map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT'])
    expect(second[0]).toMatchObject({ delta: '!' })
  })

  it('agent_thought_chunk 映射 REASONING 帧,messageId 独立于正文', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    const events = m.feed(
      notify({ sessionUpdate: 'agent_thought_chunk', content: textBlock('思考中') })
    )
    expect(events.map((e) => e.type)).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT'
    ])
    expect(events[0]).toMatchObject({ messageId: 'acp-thought-t1' })
  })

  it('tool_call 首见发 START+ARGS+END 三帧,重放幂等', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    const tc = {
      sessionUpdate: 'tool_call',
      toolCallId: 'call-1',
      title: '读文件',
      kind: 'read',
      rawInput: { path: '/a.txt' }
    }
    const first = m.feed(notify(tc))
    expect(first.map((e) => e.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])
    expect(first[0]).toMatchObject({ toolCallId: 'call-1', toolCallName: 'read' })
    expect(JSON.parse((first[1] as { delta: string }).delta)).toEqual({ path: '/a.txt' })
    expect(m.feed(notify(tc))).toEqual([])
  })

  it('tool_call_update completed 发 RESULT 一次;failed 留痕', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    m.feed(
      notify({
        sessionUpdate: 'tool_call',
        toolCallId: 'call-1',
        title: '读文件',
        rawInput: {}
      })
    )
    const done = m.feed(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'completed',
        content: [textBlock('文件内容')]
      })
    )
    expect(done.map((e) => e.type)).toEqual(['TOOL_CALL_RESULT'])
    expect(done[0]).toMatchObject({ toolCallId: 'call-1', content: '文件内容' })
    // 重放:RESULT 只发一次
    expect(
      m.feed(
        notify({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-1',
          status: 'completed'
        })
      )
    ).toEqual([])
    // failed
    const failed = m.feed(
      notify({ sessionUpdate: 'tool_call_update', toolCallId: 'call-2', status: 'failed' })
    )
    // 乱序自愈:未见 tool_call → 补 START 三帧 + RESULT
    expect(failed.map((e) => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT'
    ])
    expect((failed[3] as { content: string }).content).toContain('失败')
  })

  it('tool_call_update 非终态发 CUSTOM acp_tool_update', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    const events = m.feed(
      notify({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-1',
        status: 'in_progress',
        title: '执行中'
      })
    )
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'CUSTOM',
      name: 'acp_tool_update',
      value: { toolCallId: 'call-1', status: 'in_progress' }
    })
  })

  it('plan 全量快照映射 CUSTOM todos;内容不变不发(防刷屏)', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    const plan = {
      sessionUpdate: 'plan',
      entries: [
        { content: '扫描画布', status: 'completed', priority: 'high' },
        { content: '改参数', status: 'in_progress', priority: 'medium' }
      ]
    }
    const first = m.feed(notify(plan))
    expect(first).toHaveLength(1)
    expect(first[0]).toMatchObject({
      type: 'CUSTOM',
      name: 'todos',
      value: {
        runId: 'r1',
        items: [
          { text: '扫描画布', completed: true },
          { text: '改参数', completed: false }
        ]
      }
    })
    expect(m.feed(notify(plan))).toEqual([])
    // 内容变化才再发
    const changed = m.feed(
      notify({
        sessionUpdate: 'plan',
        entries: [{ content: '扫描画布', status: 'completed', priority: 'high' }]
      })
    )
    expect(changed).toHaveLength(1)
  })

  it('降级:未知种类/非 text 块/空 delta 全部忽略不失败', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    expect(
      m.feed(notify({ sessionUpdate: 'user_message_chunk', content: textBlock('x') }))
    ).toEqual([])
    expect(m.feed(notify({ sessionUpdate: 'available_commands_update' }))).toEqual([])
    expect(m.feed(notify({ sessionUpdate: 'current_mode_update' }))).toEqual([])
    expect(m.feed(notify({ sessionUpdate: 'brand_new_future_kind' }))).toEqual([])
    expect(
      m.feed(notify({ sessionUpdate: 'agent_message_chunk', content: [{ type: 'image' }] }))
    ).toEqual([])
    expect(
      m.feed(notify({ sessionUpdate: 'agent_message_chunk', content: textBlock('') }))
    ).toEqual([])
  })

  it('content 为字符串形式时降级解析(部分 agent 实现差异)', () => {
    const m = createAcpMapper({ threadId: 't2', runId: 'r1' })
    const events = m.feed(
      notify({ sessionUpdate: 'agent_message_chunk', content: textBlock('直连文本') })
    )
    expect(events[events.length - 1]).toMatchObject({ delta: '直连文本' })
  })

  it('drainDeltas 恒空(chunk 直接映射事件,无独立增量通道)', () => {
    const m = createAcpMapper({ threadId: 't1', runId: 'r1' })
    m.feed(notify({ sessionUpdate: 'agent_message_chunk', content: textBlock('x') }))
    expect(m.drainDeltas()).toEqual([])
  })
})
