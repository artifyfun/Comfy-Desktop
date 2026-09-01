// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  ThreadEvent,
  TodoListItem,
  WebSearchItem
} from '../vendor/codex-sdk'
import { createCodexMapper } from './codexMapper'
import { encodeSseFrame } from './types'
import type { AGUIEvent } from './types'
import type { ThreadItem } from '../vendor/codex-sdk'

// ---------- fixture 构造助手 ----------

const reasoning = (id: string, text: string): ReasoningItem => ({ id, type: 'reasoning', text })

const agentMessage = (id: string, text: string): AgentMessageItem => ({
  id,
  type: 'agent_message',
  text
})

const command = (
  id: string,
  overrides: Partial<CommandExecutionItem> = {}
): CommandExecutionItem => ({
  id,
  type: 'command_execution',
  command: 'ls -la',
  aggregated_output: 'total 0',
  status: 'in_progress',
  ...overrides
})

const mcpCall = (id: string, overrides: Partial<McpToolCallItem> = {}): McpToolCallItem => ({
  id,
  type: 'mcp_tool_call',
  server: 'workbench',
  tool: 'wb_execute_template',
  arguments: { templateId: 't1', params: { prompt: 'a cat' } },
  status: 'in_progress',
  ...overrides
})

const fileChange = (id: string, overrides: Partial<FileChangeItem> = {}): FileChangeItem => ({
  id,
  type: 'file_change',
  changes: [{ path: 'a.ts', kind: 'add' }],
  status: 'completed',
  ...overrides
})

const webSearch = (id: string, overrides: Partial<WebSearchItem> = {}): WebSearchItem => ({
  id,
  type: 'web_search',
  query: 'ag-ui protocol',
  ...overrides
})

const todoList = (id: string, items: TodoListItem['items']): TodoListItem => ({
  id,
  type: 'todo_list',
  items
})

const errorItem = (id: string, message: string): ErrorItem => ({
  id,
  type: 'error',
  message
})

const itemStarted = (item: ThreadItem): ThreadEvent => ({ type: 'item.started', item })
const itemUpdated = (item: ThreadItem): ThreadEvent => ({ type: 'item.updated', item })
const itemCompleted = (item: ThreadItem): ThreadEvent => ({ type: 'item.completed', item })

/** 提取事件类型序列,便于断言顺序 */
const typesOf = (events: AGUIEvent[]): string[] => events.map((e) => e.type)

const turnCompleted = (inputTokens: number, outputTokens: number): ThreadEvent => ({
  type: 'turn.completed',
  usage: {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    cached_input_tokens: 0,
    cache_write_input_tokens: 0,
    reasoning_output_tokens: 0
  }
})

describe('createCodexMapper — 完整正常轮', () => {
  it('started → reasoning → tool 四帧 → text 三帧 → todos → turn.completed', () => {
    const mapper = createCodexMapper({ threadId: 't-1', runId: 'r-1' })
    const out = mapper.feed({ type: 'thread.started', thread_id: 'codex-thread-x' }).concat(
      mapper.feed(itemStarted(reasoning('rs1', ''))),
      mapper.feed(itemUpdated(reasoning('rs1', '思考:用户想要生成图'))),
      mapper.feed(itemUpdated(reasoning('rs1', '思考:用户想要生成图,先列模板'))),
      mapper.feed(itemCompleted(reasoning('rs1', '思考:用户想要生成图,先列模板'))),
      mapper.feed(itemStarted(mcpCall('tc1'))),
      mapper.feed(
        itemCompleted(
          mcpCall('tc1', {
            status: 'completed',
            result: { content: [], structured_content: { ok: true } }
          })
        )
      ),
      mapper.feed(itemCompleted(agentMessage('am1', '{"intent":"image",...}'))),
      mapper.feed(
        itemCompleted(
          todoList('td1', [
            { text: '选模板', completed: true },
            { text: '执行', completed: true }
          ])
        )
      ),
      mapper.feed(turnCompleted(100, 50))
    )

    expect(typesOf(out)).toEqual([
      'RUN_STARTED',
      // reasoning: start → content(增量) → content(增量) → end
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END',
      // tool call: start/args/end → result
      'TOOL_CALL_START',
      'TOOL_CALL_ARGS',
      'TOOL_CALL_END',
      'TOOL_CALL_RESULT',
      // text 三帧(整段)
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END',
      // todos
      'CUSTOM',
      // token 用量
      'STATE_DELTA'
    ])

    // RUN_STARTED 载荷:threadId/runId 取构造参数而非事件内 thread_id
    const started = out[0]
    expect(started).toMatchObject({ type: 'RUN_STARTED', threadId: 't-1', runId: 'r-1' })

    // reasoning 增量 diff:CONTENT 拼接 = 最终 text,且不重不漏
    const contents = out.filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
    const joined = contents.map((e) => (e as { delta: string }).delta).join('')
    expect(joined).toBe('思考:用户想要生成图,先列模板')

    // tool call 四帧:名字用 item 原始 name,ARGS 一次给全,completed 补 RESULT
    const tcStart = out.find((e) => e.type === 'TOOL_CALL_START') as { toolCallName: string }
    expect(tcStart.toolCallName).toBe('wb_execute_template')
    const tcArgs = out.find((e) => e.type === 'TOOL_CALL_ARGS') as { delta: string }
    expect(JSON.parse(tcArgs.delta)).toEqual({
      templateId: 't1',
      params: { prompt: 'a cat' }
    })
    const tcResult = out.find((e) => e.type === 'TOOL_CALL_RESULT') as { content: string }
    expect(JSON.parse(tcResult.content)).toEqual({ content: [], structured_content: { ok: true } })

    // text 三帧:整段大 delta 是已知且接受的形态
    const textDelta = out.find((e) => e.type === 'TEXT_MESSAGE_CONTENT') as { delta: string }
    expect(textDelta.delta).toBe('{"intent":"image",...}')

    // todos CUSTOM
    const todos = out.find((e) => e.type === 'CUSTOM') as { name: string; value: unknown }
    expect(todos.name).toBe('todos')
    expect(todos.value).toEqual({
      items: [
        { text: '选模板', completed: true },
        { text: '执行', completed: true }
      ]
    })

    // STATE_DELTA JSON-Patch
    const delta = out.find((e) => e.type === 'STATE_DELTA') as {
      delta: Array<{ op: string; path: string; value: number }>
    }
    expect(delta.delta).toEqual([
      { op: 'replace', path: '/tokenUsage/inputTokens', value: 100 },
      { op: 'replace', path: '/tokenUsage/outputTokens', value: 50 }
    ])
  })

  it('toolCallName 归一:command_execution→shell,file_change→file_change,web_search→web_search,mcp 用原始 name', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper
      .feed(itemStarted(command('c1')))
      .concat(
        mapper.feed(itemStarted(fileChange('f1'))),
        mapper.feed(itemStarted(webSearch('w1'))),
        mapper.feed(itemStarted(mcpCall('m1', { tool: 'wb_list_templates' })))
      )
    const names = out
      .filter((e) => e.type === 'TOOL_CALL_START')
      .map((e) => (e as { toolCallName: string }).toolCallName)
    expect(names).toEqual(['shell', 'file_change', 'web_search', 'wb_list_templates'])

    // command args/result 形状
    const shellArgs = out.filter((e) => e.type === 'TOOL_CALL_ARGS')[0] as { delta: string }
    expect(JSON.parse(shellArgs.delta)).toEqual({ command: 'ls -la' })
    const shellResult = mapper.feed(
      itemCompleted(command('c1', { status: 'completed', exit_code: 0 }))
    )
    const shellResultContent = (shellResult[0] as { content: string }).content
    expect(shellResultContent).toBe('total 0')
  })

  it('失败工具条目:RESULT content 带错误文本', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    mapper.feed(itemStarted(mcpCall('m-err')))
    const out = mapper.feed(
      itemCompleted(mcpCall('m-err', { status: 'failed', error: { message: 'tool exploded' } }))
    )
    expect(typesOf(out)).toEqual(['TOOL_CALL_RESULT'])
    const result = out[0] as { content: string }
    expect(result.content).toContain('tool exploded')
  })
})

describe('createCodexMapper — 幂等(同一 item.id 只发一次 START)', () => {
  it('toolCallId 重放:completed 二连发只产生一次 RESULT,重放的 started 不重复 START', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const first = mapper.feed(itemStarted(command('dup1')))
    expect(typesOf(first)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])

    // 同一 item 重放多次 START 事件(waa AgUiEventProcessor 踩过的坑)
    expect(typesOf(mapper.feed(itemStarted(command('dup1'))))).toEqual([])
    expect(typesOf(mapper.feed(itemStarted(command('dup1'))))).toEqual([])

    const result1 = mapper.feed(itemCompleted(command('dup1', { status: 'completed' })))
    expect(typesOf(result1)).toEqual(['TOOL_CALL_RESULT'])
    // 重放的 completed:不再二次发 RESULT
    expect(typesOf(mapper.feed(itemCompleted(command('dup1', { status: 'completed' }))))).toEqual(
      []
    )
  })

  it('reasoning 重放:START 一次、updated 无增量不发 CONTENT、completed 一次 END', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    expect(typesOf(mapper.feed(itemStarted(reasoning('r1', ''))))).toEqual([
      'REASONING_MESSAGE_START'
    ])
    // 内容与已下发快照相同 → 无增量,不发
    expect(typesOf(mapper.feed(itemUpdated(reasoning('r1', 'a'))))).toEqual([
      'REASONING_MESSAGE_CONTENT'
    ])
    expect(typesOf(mapper.feed(itemUpdated(reasoning('r1', 'a'))))).toEqual([])
    expect(typesOf(mapper.feed(itemUpdated(reasoning('r1', 'ab'))))).toEqual([
      'REASONING_MESSAGE_CONTENT'
    ])
    expect(typesOf(mapper.feed(itemUpdated(reasoning('r1', 'ab'))))).toEqual([])
    expect(typesOf(mapper.feed(itemCompleted(reasoning('r1', 'ab'))))).toEqual([
      'REASONING_MESSAGE_END'
    ])
    // 重放 completed → 空
    expect(typesOf(mapper.feed(itemCompleted(reasoning('r1', 'ab'))))).toEqual([])
  })

  it('agent_message / todo_list 重放 completed 只发一次', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const first = mapper.feed(itemCompleted(agentMessage('a1', 'hello')))
    expect(typesOf(first)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END'
    ])
    expect(typesOf(mapper.feed(itemCompleted(agentMessage('a1', 'hello'))))).toEqual([])

    expect(typesOf(mapper.feed(itemCompleted(todoList('td1', []))))).toEqual(['CUSTOM'])
    expect(typesOf(mapper.feed(itemCompleted(todoList('td1', []))))).toEqual([])
  })
})

describe('createCodexMapper — reasoning 多次 updated 增量 diff', () => {
  it('多次 updated 的 delta 拼接 = 最终文本;非 append-only 时全量重发兜底', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper
      .feed(itemStarted(reasoning('rz', '')))
      .concat(
        mapper.feed(itemUpdated(reasoning('rz', '片段一。'))),
        mapper.feed(itemUpdated(reasoning('rz', '片段一。片段二。'))),
        mapper.feed(itemUpdated(reasoning('rz', '片段一。片段二。片段三。'))),
        mapper.feed(itemCompleted(reasoning('rz', '片段一。片段二。片段三。')))
      )
    const deltas = out
      .filter((e) => e.type === 'REASONING_MESSAGE_CONTENT')
      .map((e) => (e as { delta: string }).delta)
    expect(deltas).toEqual(['片段一。', '片段二。', '片段三。'])
    expect(typesOf(out)).toEqual([
      'REASONING_MESSAGE_START',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_CONTENT',
      'REASONING_MESSAGE_END'
    ])

    // 非 append-only 重写(防御路径):全量重发,保证内容可达
    const m2 = createCodexMapper({ threadId: 't', runId: 'r' })
    m2.feed(itemStarted(reasoning('r2', '')))
    m2.feed(itemUpdated(reasoning('r2', 'AAA')))
    const rewrite = m2.feed(itemUpdated(reasoning('r2', 'BBB')))
    const rewriteDelta = (rewrite[0] as { delta: string }).delta
    expect(rewriteDelta).toBe('BBB')
  })

  it('started 自带 text 时:started 只发 START,正文经 updated 通道相对已下发快照 diff 下发(防首段丢失)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    expect(typesOf(mapper.feed(itemStarted(reasoning('r3', '首段摘要'))))).toEqual([
      'REASONING_MESSAGE_START'
    ])
    const out = mapper.feed(itemUpdated(reasoning('r3', '首段摘要 + 补充')))
    expect(typesOf(out)).toEqual(['REASONING_MESSAGE_CONTENT'])
    expect((out[0] as { delta: string }).delta).toBe('首段摘要 + 补充')
    // 快照已更新:同内容重放不再发
    expect(mapper.feed(itemUpdated(reasoning('r3', '首段摘要 + 补充')))).toEqual([])
  })

  it('缺 started 直接收到 updated:自愈补 START 再发增量', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper.feed(itemUpdated(reasoning('rx', '直接增量')))
    expect(typesOf(out)).toEqual(['REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT'])
  })
})

describe('createCodexMapper — turn 失败与轮级事件', () => {
  it('turn.failed → RUN_ERROR(message 取 error.message)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper.feed({ type: 'turn.failed', error: { message: 'model exploded' } })
    expect(typesOf(out)).toEqual(['RUN_ERROR'])
    expect(out[0]).toMatchObject({ type: 'RUN_ERROR', message: 'model exploded' })
  })

  it('流级 error → RUN_ERROR', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper.feed({ type: 'error', message: 'stream broke' })
    expect(typesOf(out)).toEqual(['RUN_ERROR'])
    expect(out[0]).toMatchObject({ type: 'RUN_ERROR', message: 'stream broke' })
  })

  it('条目级 error(非致命)→ CUSTOM wb_error,不终止 run', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const out = mapper.feed(itemCompleted(errorItem('e1', 'tool errored')))
    expect(typesOf(out)).toEqual(['CUSTOM'])
    expect(out[0]).toMatchObject({
      type: 'CUSTOM',
      name: 'wb_error',
      value: { itemId: 'e1', message: 'tool errored' }
    })
    // 重放去重
    expect(mapper.feed(itemCompleted(errorItem('e1', 'tool errored')))).toEqual([])
  })

  it('turn.started 无输出;usage 缺失的 turn.completed 无输出', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    expect(mapper.feed({ type: 'turn.started' })).toEqual([])
    const noUsage = mapper.feed({ type: 'turn.completed' } as ThreadEvent)
    expect(noUsage).toEqual([])
  })
})

describe('createCodexMapper — 字符串行与多 mapper 隔离', () => {
  it('字符串行(原始 JSONL)跳过,由调用方处理', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    expect(mapper.feed('{"type":"turn.completed","usage":{}}')).toEqual([])
    expect(mapper.feed('not even json')).toEqual([])
  })

  it('构造两次互相隔离:同一 id 各自独立防重放(waa 独立 run 语义)', () => {
    const a = createCodexMapper({ threadId: 't', runId: 'r1' })
    const b = createCodexMapper({ threadId: 't', runId: 'r2' })
    const fa = mapper_feed(a, 'c1')
    expect(typesOf(fa)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])
    // b 是新实例,重放同一 id 仍发完整三帧
    const fb = mapper_feed(b, 'c1')
    expect(typesOf(fb)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END'])
  })

  /** helper:用同一 mapper 喂同一 item 两次 started,观察第二次的幂等行为 */
  function mapper_feed(m: ReturnType<typeof createCodexMapper>, id: string): AGUIEvent[] {
    const first = m.feed(itemStarted(command(id)))
    if (first.length > 0) return first
    return m.feed(itemStarted(command(id)))
  }
})

describe('createCodexMapper — SSE 帧兼容', () => {
  it('映射输出经 encodeSseFrame 为合法 AG-UI 帧(类型在 JSON type 字段内)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const frames = mapper
      .feed({ type: 'thread.started', thread_id: 'codex-x' })
      .map((e) => encodeSseFrame(e))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toMatch(/^data: \{"type":"RUN_STARTED",.*\n\n$/)
    const payload = JSON.parse(frames[0]!.replace(/^data: /, '').trim())
    expect(payload.type).toBe('RUN_STARTED')
  })
})

// ---------- C16:token 级流式增量(feedStreamDelta) ----------

describe('createCodexMapper — feedStreamDelta 文本增量', () => {
  it('首见 itemId:TEXT_MESSAGE_START + CONTENT;后续只 CONTENT', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const f1 = mapper.feedStreamDelta({ kind: 'text', itemId: 'i1', delta: 'AG' })
    expect(f1.map((e) => e.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT'])
    expect((f1[1] as { delta: string }).delta).toBe('AG')
    const f2 = mapper.feedStreamDelta({ kind: 'text', itemId: 'i1', delta: '-UI' })
    expect(f2.map((e) => e.type)).toEqual(['TEXT_MESSAGE_CONTENT'])
    expect((f2[0] as { delta: string }).delta).toBe('-UI')
  })

  it('流式后 item.completed(agent_message)只发 END——整段不重发', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    mapper.feedStreamDelta({ kind: 'text', itemId: 'i1', delta: '正文' })
    const done = mapper.feed(itemCompleted(agentMessage('i1', '正文全文')))
    expect(done.map((e) => e.type)).toEqual(['TEXT_MESSAGE_END'])
  })

  it('未流式过的 agent_message completed 仍走整段三帧(exec 兼容)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const done = mapper.feed(itemCompleted(agentMessage('i2', '整段')))
    expect(done.map((e) => e.type)).toEqual([
      'TEXT_MESSAGE_START',
      'TEXT_MESSAGE_CONTENT',
      'TEXT_MESSAGE_END'
    ])
  })

  it('空 delta / 空 itemId 零帧(脏输入防御)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    expect(mapper.feedStreamDelta({ kind: 'text', itemId: 'i1', delta: '' })).toHaveLength(0)
    expect(mapper.feedStreamDelta({ kind: 'text', itemId: '', delta: 'x' })).toHaveLength(0)
  })
})

describe('createCodexMapper — feedStreamDelta 推理增量', () => {
  it('首见:REASONING_START + CONTENT;快照基线同步推进(completed 不重发)', () => {
    const mapper = createCodexMapper({ threadId: 't', runId: 'r' })
    const f1 = mapper.feedStreamDelta({ kind: 'reasoning', itemId: 'r1', delta: '思考' })
    expect(f1.map((e) => e.type)).toEqual(['REASONING_MESSAGE_START', 'REASONING_MESSAGE_CONTENT'])
    mapper.feedStreamDelta({ kind: 'reasoning', itemId: 'r1', delta: '继续' })
    // completed:常规 END 收口;若 completed 带整段 text 且与已流式一致 → 不重发
    const done = mapper.feed(itemCompleted(reasoning('r1', '思考继续')))
    expect(done.map((e) => e.type)).toEqual(['REASONING_MESSAGE_END'])
  })
})
