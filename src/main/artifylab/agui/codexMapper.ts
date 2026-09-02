/**
 * C2 — codex ThreadEvent → AG-UI 事件映射器(workbench-agui-migration.md §C2)。
 *
 * 设计:
 * - 纯函数状态机:构造一次、单轮 decide 使用;状态仅限实例内(推理 diff 快照、
 *   幂等 Set),零 electron/express/网络依赖,可直接单测。
 * - 幂等:同一 item.id 只发一次 START 三帧(waa AgUiEventProcessor 踩过的重放坑,
 *   migration 文档 C2 节);重放的 completed 不再二次发 RESULT/END/CUSTOM。
 * - 映射表(严格对齐 migration 文档 C2):
 *     thread.started  → RUN_STARTED(threadId/runId 由调用方传入,不取事件内 thread_id)
 *     reasoning       start→REASONING_MESSAGE_START;updated→与上次已下发快照 diff 出
 *                     delta 发 REASONING_MESSAGE_CONTENT(无增量不发);completed→END
 *     agent_message   completed→TEXT_MESSAGE_START+CONTENT(整段)+END(已知接受的
 *                     item 粒度;token 级打字机是 C16 探索项,不阻塞本组件)
 *     mcp_tool_call / command_execution / file_change / web_search
 *                     首见→TOOL_CALL_START+ARGS(delta 一次给全)+END;completed→RESULT
 *     todo_list       completed→CUSTOM {name:'todos', value:{items}}
 *     turn.completed  → STATE_DELTA(JSON-Patch /tokenUsage/{inputTokens,outputTokens})
 *     turn.failed / error(流级)→ RUN_ERROR(message)
 *     字符串行(原始 JSONL)→ 跳过,由调用方(raw lines)处理
 * - 差异决策(实现里注明理由):
 *     · reasoning 快照基线 = 「上次已下发的内容」而非 started 时的 text——start 帧
 *       不带 content,codex 把首段摘要放在 started.text 时也能经第一次 updated 完整
 *       下发,内容恰好一次、不重不漏。
 *     · item 级 error(非致命)→ CUSTOM 'wb_error',不终止 run(区别于流级 error 事件)。
 *     · completed 先于 started 到达(丢事件/乱序)时自愈补全 START 三帧,保证下游
 *       帧配对完整。
 */
import type {
  AgentMessageItem,
  CommandExecutionItem,
  ErrorItem,
  FileChangeItem,
  McpToolCallItem,
  ReasoningItem,
  ThreadEvent,
  ThreadItem,
  TodoListItem,
  WebSearchItem
} from '../vendor/codex-sdk'
/** todo 条目类型：TodoItem 未导出(vendor d.ts 内部声明)，从 TodoListItem.items 派生 */
type TodoEntry = TodoListItem['items'][number]
import {
  custom,
  reasoningMessageContent,
  reasoningMessageEnd,
  reasoningMessageStart,
  runError,
  runStarted,
  stateDelta,
  textMessageContent,
  textMessageEnd,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart
} from './types'
import type { AGUIEvent } from './types'

export interface CodexMapperOptions {
  /** AG-UI threadId(= workbench sessionId),由调用方传入 */
  threadId: string
  /** AG-UI runId(每次 decide 一组),由调用方传入 */
  runId: string
}

export interface CodexMapper {
  /**
   * 喂入一个 codex 事件,返回该事件映射出的 AG-UI 事件数组(0..n 个)。
   * 字符串行(原始 JSONL)原样跳过——由调用方处理。
   */
  feed(event: ThreadEvent | string): AGUIEvent[]
  /**
   * C16:喂入 token 级流式增量(app-server 通道),首见 itemId 自动补
   * TEXT/REASONING_MESSAGE_START,后续直发 CONTENT 增量帧;空 delta 不发帧。
   */
  feedStreamDelta(d: { kind: 'text' | 'reasoning'; itemId: string; delta: string }): AGUIEvent[]
}

/** 条目事件相位 */
type ItemPhase = 'started' | 'updated' | 'completed'

/** 参与工具调用映射的条目(mcp_tool_call / command_execution / file_change / web_search) */
type ToolLikeItem = McpToolCallItem | CommandExecutionItem | FileChangeItem | WebSearchItem

export function createCodexMapper(opts: CodexMapperOptions): CodexMapper {
  const { threadId, runId } = opts
  /** 已发过 START 三帧的 item.id(工具/文本/推理统一防重放) */
  const startedIds = new Set<string>()
  /** 已发过 END/RESULT/一次性 CUSTOM 收尾帧的 item.id(重放的 completed 不再二次发) */
  const finishedIds = new Set<string>()
  /** reasoning item.id → 上次已下发的文本快照(增量 diff 基线) */
  const reasoningSnapshots = new Map<string, string>()
  /** todo_list item.id → 上次已下发 items 快照(updated 相位 diff 防重复刷屏) */
  const todoSnapshots = new Map<string, TodoEntry[]>()
  /** C16:已按 token delta 发过 CONTENT 的 agent_message item.id(completed 只收口) */
  const streamedTextIds = new Set<string>()

  /** todo items 逐项相等比较(顺序敏感;completed/text 任一变化即视为状态变化) */
  const todoItemsEqual = (a: TodoEntry[], b: TodoEntry[]): boolean =>
    a.length === b.length &&
    a.every((x, k) => x.completed === b[k]?.completed && x.text === b[k]?.text)

  /**
   * 推理增量 diff:返回相对上次已下发快照的 delta;无增量返回 null(不发帧)。
   * - append-only(codex 正常形态):只发新增尾部。
   * - 非 append-only 重写(codex 正常流不出现,防御):全量重发,保证最终内容
   *   可达(消费端拼接可能出现重复尾段,优于静默丢内容)。
   */
  const diffReasoning = (id: string, next: string): string | null => {
    const prev = reasoningSnapshots.get(id) ?? ''
    reasoningSnapshots.set(id, next)
    if (next === prev) return null
    if (prev.length > 0 && !next.startsWith(prev)) return next
    return next.slice(prev.length)
  }

  /** JSON 安全序列化(MCP arguments/result 是 unknown,循环引用时降级空对象) */
  const safeJson = (value: unknown): string => {
    try {
      return JSON.stringify(value ?? {})
    } catch {
      return '{}'
    }
  }

  /**
   * toolCallName 归一约定(migration 文档 C11 消费侧按 name 选图标):
   * - mcp_tool_call 用 item 原始 tool name(wb_* 工具保持原名,前端据此识别工作台工具)
   * - command_execution → 'shell';file_change → 'file_change';web_search → 'web_search'
   */
  const toolCallName = (item: ToolLikeItem): string => {
    switch (item.type) {
      case 'mcp_tool_call':
        return item.tool || 'mcp_tool_call'
      case 'command_execution':
        return 'shell'
      case 'file_change':
        return 'file_change'
      case 'web_search':
        return 'web_search'
      default:
        return 'unknown'
    }
  }

  /** 工具入参,args delta 一次给全(JSON 字符串) */
  const toolCallArgsJson = (item: ToolLikeItem): string => {
    switch (item.type) {
      case 'mcp_tool_call':
        return safeJson(item.arguments)
      case 'command_execution':
        return JSON.stringify({ command: item.command })
      case 'file_change':
        return JSON.stringify({ changes: item.changes })
      case 'web_search':
        return JSON.stringify({ query: item.query })
      default:
        return '{}'
    }
  }

  /**
   * 工具结果 content:取 result / aggregated_output / 字符串化输出;
   * 失败条目 content 里带错误文本(migration 文档 C2 映射表要求)。
   */
  const toolResultContent = (item: ToolLikeItem): string => {
    switch (item.type) {
      case 'mcp_tool_call':
        if (item.error) return `MCP 调用失败: ${item.error.message}`
        return safeJson(item.result)
      case 'command_execution': {
        const output = item.aggregated_output
        if (item.status === 'failed') {
          const exit = item.exit_code !== undefined ? `(exit code ${item.exit_code})` : ''
          return `${output ? `${output}\n` : ''}命令执行失败${exit}`
        }
        return output
      }
      case 'file_change': {
        const changes = JSON.stringify({ changes: item.changes })
        return item.status === 'failed' ? `patch 应用失败: ${changes}` : changes
      }
      case 'web_search':
        return JSON.stringify({ query: item.query })
      default:
        return ''
    }
  }

  const feedReasoning = (item: ReasoningItem, phase: ItemPhase): AGUIEvent[] => {
    if (phase === 'started') {
      if (startedIds.has(item.id)) return [] // 重放:同一 id 只发一次 START
      startedIds.add(item.id)
      return [reasoningMessageStart(item.id)]
    }
    if (phase === 'updated') {
      const out: AGUIEvent[] = []
      if (!startedIds.has(item.id)) {
        // 自愈:未见 started(丢事件)先补 START,保证帧配对
        startedIds.add(item.id)
        out.push(reasoningMessageStart(item.id))
      }
      const delta = diffReasoning(item.id, item.text)
      if (delta) out.push(reasoningMessageContent(item.id, delta))
      return out
    }
    // completed
    if (finishedIds.has(item.id)) return [] // 重放去重
    finishedIds.add(item.id)
    const out: AGUIEvent[] = []
    if (!startedIds.has(item.id)) {
      // 自愈:直接收到 completed → 补 START 配对(started/updated 缺失,内容按规格不下发)
      startedIds.add(item.id)
      out.push(reasoningMessageStart(item.id))
    }
    out.push(reasoningMessageEnd(item.id))
    return out
  }

  const feedAgentMessage = (item: AgentMessageItem, phase: ItemPhase): AGUIEvent[] => {
    // 已知接受的 item 粒度:整段到达才发(started/updated 的中间抖动不映射;
    // token 级打字机是 C16 探索项)
    if (phase !== 'completed') return []
    if (finishedIds.has(item.id)) return [] // 重放去重
    finishedIds.add(item.id)
    // C16 流式收口:app-server 通道已按 delta 逐段发过 CONTENT(START 也在
    // feedStreamDelta 首见时发过)→ completed 只补 END,整段 text 不重发
    // (断流兜底:text 缺失或从未流式过时仍走整段三帧)
    if (streamedTextIds.has(item.id)) {
      return [textMessageEnd(item.id)]
    }
    return [
      textMessageStart(item.id),
      textMessageContent(item.id, item.text),
      textMessageEnd(item.id)
    ]
  }

  const feedToolCall = (item: ToolLikeItem, phase: ItemPhase): AGUIEvent[] => {
    const first = !startedIds.has(item.id)
    if (phase !== 'completed') {
      // started / updated:首见发 START+ARGS+END;重放/重复 updated 幂等不发
      if (!first) return []
      startedIds.add(item.id)
      return [
        toolCallStart(item.id, toolCallName(item)),
        toolCallArgs(item.id, toolCallArgsJson(item)),
        toolCallEnd(item.id)
      ]
    }
    // completed
    if (!first) {
      // 常规路径:START 已发,只补 RESULT(重放的 completed 不再二次发)
      if (finishedIds.has(item.id)) return []
      finishedIds.add(item.id)
      return [toolCallResult(item.id, toolResultContent(item))]
    }
    // 自愈:completed 先于 started 到达(丢事件/乱序)→ 补全四帧
    startedIds.add(item.id)
    finishedIds.add(item.id)
    return [
      toolCallStart(item.id, toolCallName(item)),
      toolCallArgs(item.id, toolCallArgsJson(item)),
      toolCallEnd(item.id),
      toolCallResult(item.id, toolResultContent(item))
    ]
  }

  /**
   * todo_list(P1-B3 任务进度数据源):
   * - updated:模型执行中多次改待办清单 → 与上次已下发快照 diff,状态变化才发
   *   CUSTOM {runId, items}(前端按 runId 原位 upsert 同一张进度卡,实时勾选);
   *   无变化不发(防重放/防刷屏)。
   * - completed:终态照发一次(runId 同构;重放去重走 finishedIds)。
   * runId 进 value 是前端 per-run 稳定寻址的前提(replay 时多帧快照收敛为一卡)。
   */
  const feedTodoList = (item: TodoListItem, phase: ItemPhase): AGUIEvent[] => {
    if (finishedIds.has(item.id)) return [] // 重放去重
    if (phase === 'updated') {
      const prev = todoSnapshots.get(item.id)
      if (prev && todoItemsEqual(prev, item.items)) return []
      todoSnapshots.set(item.id, item.items)
      return [custom('todos', { runId, items: item.items })]
    }
    if (phase !== 'completed') return []
    finishedIds.add(item.id)
    return [custom('todos', { runId, items: item.items })]
  }

  /** 条目级 error(非致命):CUSTOM 上抛留痕,不终止 run;重放去重 */
  const feedErrorItem = (item: ErrorItem): AGUIEvent[] => {
    if (finishedIds.has(item.id)) return []
    finishedIds.add(item.id)
    return [custom('wb_error', { itemId: item.id, message: item.message })]
  }

  const feedItem = (item: ThreadItem, phase: ItemPhase): AGUIEvent[] => {
    switch (item.type) {
      case 'reasoning':
        return feedReasoning(item, phase)
      case 'agent_message':
        return feedAgentMessage(item, phase)
      case 'command_execution':
      case 'file_change':
      case 'mcp_tool_call':
      case 'web_search':
        return feedToolCall(item, phase)
      case 'todo_list':
        return feedTodoList(item, phase)
      case 'error':
        return feedErrorItem(item)
      default:
        return []
    }
  }

  /**
   * C16:token 级流式增量(app-server 通道专用)。
   * - text:首见 itemId 发 TEXT_MESSAGE_START,后续每次发 CONTENT(delta);
   * - reasoning:首见发 REASONING_MESSAGE_START + CONTENT;同时记录快照基线
   *   (completed 走 feedReasoning 的常规 END 收口,diff 基线已同步推进,
   *   不会二次下发已流式内容)。
   */
  const feedStreamDelta = (d: {
    kind: 'text' | 'reasoning'
    itemId: string
    delta: string
  }): AGUIEvent[] => {
    if (!d.itemId || !d.delta) return []
    if (d.kind === 'text') {
      const out: AGUIEvent[] = []
      if (!startedIds.has(d.itemId)) {
        startedIds.add(d.itemId)
        streamedTextIds.add(d.itemId)
        out.push(textMessageStart(d.itemId))
      }
      streamedTextIds.add(d.itemId)
      out.push(textMessageContent(d.itemId, d.delta))
      return out
    }
    // reasoning
    const out: AGUIEvent[] = []
    if (!startedIds.has(d.itemId)) {
      startedIds.add(d.itemId)
      out.push(reasoningMessageStart(d.itemId))
    }
    // 快照基线同步推进:completed 的 END 收口不依赖 text 字段,但防重放 diff
    // 需要知道已发到哪(否则 app-server completed 若带整段 summary 会重发)
    const prev = reasoningSnapshots.get(d.itemId) ?? ''
    reasoningSnapshots.set(d.itemId, prev + d.delta)
    out.push(reasoningMessageContent(d.itemId, d.delta))
    return out
  }

  const feed = (event: ThreadEvent | string): AGUIEvent[] => {
    // 字符串行 = codex exec 的原始 JSONL(调用方 parsePlanFromCodex 用),映射器跳过
    if (typeof event === 'string') return []
    switch (event.type) {
      case 'thread.started':
        // threadId/runId 由调用方传入(会话层语义),不取事件内 thread_id
        return [runStarted(threadId, runId)]
      case 'turn.started':
        return []
      case 'turn.completed': {
        const usage = event.usage
        if (!usage) return []
        return [
          stateDelta([
            // Number 强转:字段缺失时 null/undefined 会被 JSON.stringify 丢掉 value
            // 键,产出非法 replace op(路由层 appendTurnUsage 同款防御)
            {
              op: 'replace',
              path: '/tokenUsage/inputTokens',
              value: Number(usage.input_tokens ?? 0)
            },
            {
              op: 'replace',
              path: '/tokenUsage/outputTokens',
              value: Number(usage.output_tokens ?? 0)
            }
          ])
        ]
      }
      case 'turn.failed':
        return [runError(event.error?.message ?? 'unknown turn failure')]
      case 'error':
        return [runError(event.message)]
      case 'item.started':
        return feedItem(event.item, 'started')
      case 'item.updated':
        return feedItem(event.item, 'updated')
      case 'item.completed':
        return feedItem(event.item, 'completed')
      default:
        return []
    }
  }

  return { feed, feedStreamDelta }
}
