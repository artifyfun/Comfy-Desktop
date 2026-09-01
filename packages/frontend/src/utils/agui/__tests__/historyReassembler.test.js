// utils/agui/__tests__/historyReassembler.test.js — 历史记录重放测试（C8 验收）
// 用例思路对齐 waa historyReassembler.test.js：事件级行（content=事件 JSON 原文）→
// 结构化消息时间线；覆盖 records 形状解析 / text·reasoning·tool·custom 折叠 /
// 边界缺失防御 / 畸形行跳过 / 与实时流 emit 序列同构。
import { describe, expect, it } from 'vitest'
import { reassemble, replayToMessages } from '../historyReassembler'
import { createHandlerContext, dispatch } from '../handlers'

// ── fixture helpers：模拟 B 线 /api/workbench/agent/threads/messages 的 records 形状 ──
// record: { runId, seq, eventType, content }（content = AG-UI 事件 JSON 原文）
let seqCounter = 0
function record(overrides = {}) {
  seqCounter += 1
  return {
    runId: 'r-1',
    seq: seqCounter,
    eventType: 'TEXT_MESSAGE',
    content: '{}',
    ...overrides,
  }
}

const ev = (event) => JSON.stringify({ timestamp: 1, ...event })

describe('agui/historyReassembler — reassemble（遍历喂 handler）', () => {
  it('records 逐行 parse → emit 按事件序列回调', () => {
    const calls = []
    const result = reassemble(
      [
        record({ content: ev({ type: 'RUN_STARTED', threadId: 't-1', runId: 'r-1' }) }),
        record({ content: ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) }),
        record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '你好' }) }),
        record({ content: ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) }),
        record({ content: ev({ type: 'RUN_FINISHED', threadId: 't-1', runId: 'r-1' }) }),
      ],
      (name, payload) => calls.push([name, payload]),
    )
    expect(result.totalEvents).toBe(5)
    expect(result.malformedRecords).toBe(0)
    expect(calls.map((c) => c[0])).toEqual(['run:start', 'text:start', 'text:delta', 'text:end', 'run:finish'])
    expect(calls[2][1]).toEqual({ messageId: 'm1', delta: '你好' })
  })

  it('畸形 content 行跳过并计数，不阻断后续重放', () => {
    const calls = []
    const result = reassemble(
      [
        record({ content: 'not json{{' }),
        record({ content: ev({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }) }),
        record({ content: '' }),
      ],
      (name) => calls.push(name),
    )
    expect(result.malformedRecords).toBe(2)
    expect(result.totalEvents).toBe(1)
    expect(calls).toEqual(['run:start'])
  })

  it('与实时流（parser→dispatch）emit 序列同构', () => {
    // 同一事件序列分别走实时流路径与历史重放路径，emit 产出一致（C3 同构设计）
    const events = [
      { type: 'RUN_STARTED', threadId: 't', runId: 'r' },
      { type: 'REASONING_MESSAGE_START', messageId: 'x1', role: 'reasoning' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'x1', delta: '思考' },
      { type: 'REASONING_MESSAGE_END', messageId: 'x1' },
      { type: 'RUN_FINISHED', threadId: 't', runId: 'r' },
    ]
    const liveCalls = []
    const ctx = createHandlerContext((n, p) => liveCalls.push([n, p]))
    for (const e of events) dispatch(ctx, e)

    const replayCalls = []
    reassemble(events.map((e) => record({ content: JSON.stringify(e) })), (n, p) => replayCalls.push([n, p]))

    expect(replayCalls).toEqual(liveCalls)
  })

  it('空/非数组 records 安全返回 0', () => {
    expect(reassemble([], () => {})).toEqual({ totalEvents: 0, malformedRecords: 0 })
    expect(reassemble(null, () => {})).toEqual({ totalEvents: 0, malformedRecords: 0 })
  })
})

describe('agui/historyReassembler — replayToMessages（消息时间线折叠）', () => {
  it('text 三帧聚合：start/多段 delta/end → 单条 text 消息', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Hel' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'lo' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) }),
      record({ content: ev({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }) }),
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({ kind: 'text', id: 'm1', role: 'assistant', text: 'Hello', __runId: 'r-1' })
  })

  it('reasoning 折叠 + text 分条：多 messageId 各自成条，时序保持', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'REASONING_MESSAGE_START', messageId: 'rs1', role: 'reasoning' }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'rs1', delta: '先想' }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'rs1', delta: '一下' }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_END', messageId: 'rs1' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_START', messageId: 'tm1', role: 'assistant' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'tm1', delta: '答案' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_END', messageId: 'tm1' }) }),
    ])
    expect(msgs).toEqual([
      { kind: 'reasoning', id: 'rs1', role: 'reasoning', text: '先想一下', __runId: 'r-1' },
      { kind: 'text', id: 'tm1', role: 'assistant', text: '答案', __runId: 'r-1' },
    ])
  })

  it('tool 四帧聚合：START/ARGS 分片/END/RESULT → 单条 tool 消息', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'TOOL_CALL_START', toolCallId: 'c1', toolCallName: 'wb_get_workflows' }) }),
      record({ content: ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"query"' }) }),
      record({ content: ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: ':"cat"}' }) }),
      record({ content: ev({ type: 'TOOL_CALL_END', toolCallId: 'c1' }) }),
      record({ content: ev({ type: 'TOOL_CALL_RESULT', toolCallId: 'c1', content: '[{"text":"3 hits"}]', role: 'tool' }) }),
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({
      kind: 'tool',
      toolCallId: 'c1',
      name: 'wb_get_workflows',
      args: '{"query":"cat"}',
      result: '[{"text":"3 hits"}]',
      status: 'done',
      __runId: 'r-1',
    })
  })

  it('tool 无 RESULT → status 保持 running（历史快照：结果未持久化的兜底）', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'TOOL_CALL_START', toolCallId: 'c2', toolCallName: 'wb_run' }) }),
      record({ content: ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'c2', delta: '{}' }) }),
      record({ content: ev({ type: 'TOOL_CALL_END', toolCallId: 'c2' }) }),
    ])
    expect(msgs[0].status).toBe('running')
    expect(msgs[0].result).toBeNull()
  })

  it('custom 事件落时间线；keepalive 被过滤', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'CUSTOM', name: 'wb_plan', value: { steps: 2 } }) }),
      record({ content: ev({ type: 'CUSTOM', name: 'keepalive' }) }),
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toEqual({ kind: 'custom', name: 'wb_plan', value: { steps: 2 }, __runId: 'r-1' })
  })

  it('STATE_DELTA / RUN_* 不进时间线（store 侧消费）', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/tokenUsage/total', value: 42 }] }) }),
      record({ content: ev({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }) }),
      record({ content: ev({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }) }),
    ])
    expect(msgs).toHaveLength(0)
  })

  it('边界缺失防御：CONTENT 无前置 START 懒创建（waa「重组器须容忍边界缺失」教训）', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'orphan', delta: '孤' }) }),
      record({ content: ev({ type: 'TOOL_CALL_RESULT', toolCallId: 'orphan-tool', content: 'x' }) }),
    ])
    expect(msgs).toHaveLength(2)
    expect(msgs[0]).toEqual({ kind: 'text', id: 'orphan', role: 'assistant', text: '孤', __runId: 'r-1' })
    expect(msgs[1]).toEqual({ kind: 'tool', toolCallId: 'orphan-tool', name: '', args: '', result: 'x', status: 'done', __runId: 'r-1' })
  })

  it('snake_case 历史 content 兼容（normalize 兜底）', () => {
    const msgs = replayToMessages([
      record({ content: JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', timestamp: 1, message_id: 'm9', delta: '旧' }) }),
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].text).toBe('旧')
  })

  it('完整一轮 run 的历史重放：时间线形状端到端', () => {
    const msgs = replayToMessages([
      record({ content: ev({ type: 'RUN_STARTED', threadId: 't-7', runId: 'r-7' }) }),
      record({ content: ev({ type: 'STATE_DELTA', delta: [{ op: 'replace', path: '/intentLabel', value: '画图' }] }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_START', messageId: 'r1', role: 'reasoning' }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '用户想要一只猫' }) }),
      record({ content: ev({ type: 'REASONING_MESSAGE_END', messageId: 'r1' }) }),
      record({ content: ev({ type: 'TOOL_CALL_START', toolCallId: 'tc1', toolCallName: 'wb_execute_template' }) }),
      record({ content: ev({ type: 'TOOL_CALL_ARGS', toolCallId: 'tc1', delta: '{"templateId":"flux"}' }) }),
      record({ content: ev({ type: 'TOOL_CALL_END', toolCallId: 'tc1' }) }),
      record({ content: ev({ type: 'TOOL_CALL_RESULT', toolCallId: 'tc1', content: '{"ok":true}', role: 'tool' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_START', messageId: 'a1', role: 'assistant' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'a1', delta: '已生成' }) }),
      record({ content: ev({ type: 'TEXT_MESSAGE_END', messageId: 'a1' }) }),
      record({ content: ev({ type: 'RUN_FINISHED', threadId: 't-7', runId: 'r-7' }) }),
    ])
    // state/run 不进时间线，其余 4 条按时序
    expect(msgs.map((m) => m.kind)).toEqual(['reasoning', 'tool', 'text'])
    expect(msgs[0].text).toBe('用户想要一只猫')
    expect(msgs[1]).toMatchObject({ name: 'wb_execute_template', args: '{"templateId":"flux"}', status: 'done' })
    expect(msgs[2].text).toBe('已生成')
  })

  it('空 records → 空数组', () => {
    expect(replayToMessages([])).toEqual([])
    expect(replayToMessages(null)).toEqual([])
    expect(replayToMessages(undefined)).toEqual([])
  })
})
