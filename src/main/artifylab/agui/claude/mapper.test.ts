/**
 * Claude mapper 单测 —— 夹具取自本机真实 claude CLI(2.1.260)stream-json 采集。
 *
 * 覆盖:text/thinking 整块内容、tool_use/tool_result 配对、result usage →
 * STATE_DELTA、hook/system 噪音过滤、重放去重、乱序自愈。
 */
import { describe, expect, it } from 'vitest'
import { createClaudeMapper } from './mapper'
import type { ClaudeStreamLine } from './mapper'

/** 真实采集形态:assistant 行(content 块逐步吐出,每行一个 wrapper) */
const assistantText = (text: string): ClaudeStreamLine => ({
  type: 'assistant',
  message: {
    id: 'msg_test1',
    role: 'assistant',
    content: [{ type: 'text', text }]
  },
  session_id: '4d4286e0-test'
})

const assistantThinking = (thinking: string): ClaudeStreamLine => ({
  type: 'assistant',
  message: {
    id: 'msg_test1',
    content: [{ type: 'thinking', thinking, signature: 'sig123' }]
  }
})

const assistantToolUse = (): ClaudeStreamLine => ({
  type: 'assistant',
  message: {
    id: 'msg_test1',
    content: [
      {
        type: 'tool_use',
        id: 'toolu_01ABC',
        name: 'Bash',
        input: { command: 'ls -la', description: '列目录' }
      }
    ]
  }
})

const userToolResult = (content: string, isError = false): ClaudeStreamLine => ({
  type: 'user',
  message: {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: 'toolu_01ABC', content, is_error: isError }]
  }
})

const resultLine = (): ClaudeStreamLine => ({
  type: 'result',
  subtype: 'success',
  usage: { input_tokens: 55762, output_tokens: 16 },
  total_cost_usd: 0.279,
  session_id: '4d4286e0-test',
  result: '你好'
})

/** 真实采集形态:hook 噪音行 */
const hookLine = (): ClaudeStreamLine => ({
  type: 'system',
  subtype: 'hook_response',
  hook_id: 'x',
  output: 'noise'
})

describe('createClaudeMapper', () => {
  it('text 块 → START+CONTENT;同块重放不发;新块只发 CONTENT', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const first = m.feed(assistantText('你好'))
    expect(first.map((e) => e.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT'])
    expect(first[0]).toMatchObject({ messageId: 'msg_test1' })
    expect(first[1]).toMatchObject({ delta: '你好' })
    // 同一块重放(整段重发)去重
    expect(m.feed(assistantText('你好'))).toEqual([])
  })

  it('thinking 块 → REASONING 帧,messageId 独立', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const events = m.feed(assistantThinking('内部推理'))
    expect(events.map((e) => e.type)).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT'
    ])
    expect(events[0]).toMatchObject({ messageId: 'claude-think-msg_test1' })
  })

  it('tool_use → 三帧一次;tool_result → RESULT;重放去重', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const tu = m.feed(assistantToolUse())
    expect(tu.map((e) => e.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])
    expect(tu[0]).toMatchObject({ toolCallId: 'toolu_01ABC', toolCallName: 'Bash' })
    expect(JSON.parse((tu[1] as { delta: string }).delta)).toEqual({
      command: 'ls -la',
      description: '列目录'
    })
    const tr = m.feed(userToolResult('file1\nfile2'))
    expect(tr.map((e) => e.type)).toEqual(['TOOL_CALL_RESULT'])
    expect(tr[0]).toMatchObject({ toolCallId: 'toolu_01ABC', content: 'file1\nfile2' })
    // 重放
    expect(m.feed(userToolResult('file1\nfile2'))).toEqual([])
  })

  it('tool_result is_error 留痕;乱序(未见 tool_use)自愈补三帧', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const tr = m.feed(userToolResult('权限不足', true))
    expect(tr.map((e) => e.type)).toEqual([
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT'
    ])
    expect((tr[3] as { content: string }).content).toContain('工具执行失败')
    expect((tr[3] as { content: string }).content).toContain('权限不足')
  })

  it('result 行 → STATE_DELTA tokenUsage;空 usage 不发', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const events = m.feed(resultLine())
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('STATE_DELTA')
    const delta = (events[0] as { delta?: Array<{ path: string; value: number }> }).delta ?? []
    expect(delta).toEqual([
      { op: 'replace', path: '/tokenUsage/inputTokens', value: 55762 },
      { op: 'replace', path: '/tokenUsage/outputTokens', value: 16 }
    ])
    expect(m.feed({ type: 'result', subtype: 'success' })).toEqual([])
  })

  it('system/hook 行与未知 type 全部忽略', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    expect(m.feed(hookLine())).toEqual([])
    expect(m.feed({ type: 'system', subtype: 'init', session_id: 'x' })).toEqual([])
    expect(m.feed({ type: 'system', subtype: 'thinking_tokens', estimated_tokens: 3 })).toEqual([])
    expect(m.feed({ type: 'brand_new_type' })).toEqual([])
    expect(m.feed({})).toEqual([])
  })

  it('综合序列:思考→正文→工具→结果→result,事件序完整', () => {
    const m = createClaudeMapper({ threadId: 't1', runId: 'r1' })
    const events = [
      m.feed(hookLine()),
      m.feed(assistantThinking('想一下')),
      m.feed(assistantText('答案')),
      m.feed(assistantToolUse()),
      m.feed(userToolResult('ok')),
      m.feed(resultLine())
    ].flat()
    const types = events.map((e) => e.type)
    expect(types).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      'STATE_DELTA'
    ])
  })
})
