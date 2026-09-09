/**
 * ACP host 适配器 —— 事件映射器:ACP session/update → AG-UI 事件 + 流式 delta。
 *
 * 职责(对齐 OpenDesign agent-protocol 分层,见 docs/research-external-agent-integration.md):
 * 消费 ClientSideConnection 的 sessionUpdate 通知流,产出与 codex 通道同构的两路输出:
 *   1. events: AG-UI 事件(与 routes/agui.ts emit 管线同型);
 *   2. deltas: token 级增量(text/reasoning),由调用方经 mapper 帧管线补 START 帧。
 *
 * 映射表(ACP → AG-UI):
 *   agent_message_chunk → TEXT_MESSAGE_START(首见)+CONTENT(delta)
 *   agent_thought_chunk → REASONING_MESSAGE_START(首见)+REASONING_MESSAGE_CONTENT
 *   tool_call           → TOOL_CALL_START+ARGS(rawInput JSON,一次给全)+END
 *   tool_call_update    → status completed/failed → TOOL_CALL_RESULT;title/status
 *                         变化 → CUSTOM acp_tool_update(工具卡进度留痕)
 *   plan                → CUSTOM todos {runId, items}(对齐 codexMapper todo_list
 *                         的 {runId, items} 契约,前端 per-run 原位 upsert 同一张卡)
 *   user_message_chunk / available_commands_update / current_mode_update → 忽略
 *
 * 降级原则(对齐 OpenDesign codex normalize.ts「未知即忽略,降级渲染不失败」):
 * 未知 sessionUpdate 种类、未知 content 块类型一律忽略——agent 升级新增通知时
 * 退化为「少渲染一样」,绝不 fail run。
 *
 * 幂等语义(对齐 codexMapper):同一 toolCallId 只发一次 START 三帧;同一
 * messageChunk/thoughtChunk 的 messageId 只发一次 START;result 只发一次。
 *
 * 纯函数状态机:构造一次、单轮使用;零 electron/express/网络依赖,可直接单测。
 */
import type { SessionNotification } from '@zed-industries/agent-client-protocol/dist/schema'
import {
  custom,
  reasoningMessageContent,
  reasoningMessageStart,
  textMessageContent,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart
} from '../types'
import type { AGUIEvent } from '../types'

/** 流式增量(与 appServerTranslator.StreamDelta 同构) */
export interface StreamDelta {
  kind: 'text' | 'reasoning'
  itemId: string
  delta: string
}

/** 映射上下文:AG-UI threadId(= workbench sessionId)/ runId(每 decide 一组) */
export interface AcpiMapperOptions {
  threadId: string
  runId: string
}

export interface AcpMapper {
  /** 喂入一条 ACP session/update 通知,返回映射出的 AG-UI 事件数组(0..n) */
  feed(notification: SessionNotification): AGUIEvent[]
  /** token 级增量缓存(供 transport 层在 chunk 与事件同批到达时拆帧;当前恒空) */
  drainDeltas(): StreamDelta[]
}

/** ACP ToolCallUpdate 状态 → 是否已到终态(可发 RESULT) */
function isTerminalToolStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'failed'
}

/** ACP content 块 → 展示文本(仅 text 块;其余类型降级忽略) */
function contentBlockText(content: unknown): string {
  if (typeof content !== 'object' || content === null) return ''
  const blocks = Array.isArray(content) ? content : [content]
  const texts: string[] = []
  for (const b of blocks) {
    if (typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text') {
      const t = (b as { text?: unknown }).text
      if (typeof t === 'string') texts.push(t)
    }
  }
  return texts.join('')
}

/** 工具结果 content:content 块文本优先,其次 rawOutput JSON(失败也留痕) */
function toolResultText(update: {
  content?: unknown
  rawOutput?: unknown
  status?: string
}): string {
  const text = contentBlockText(update.content)
  if (text) return text
  if (update.rawOutput !== undefined) {
    try {
      return JSON.stringify(update.rawOutput)
    } catch {
      /* 循环引用等,降级 */
    }
  }
  return update.status === 'failed' ? '工具调用失败' : ''
}

/** plan 条目 → codex todo 形态(text/completed 契约字段,前端进度卡直读) */
function planEntriesToTodos(
  entries: Array<{
    content: string
    status: string
  }>
): Array<{ text: string; completed: boolean }> {
  return entries.map((e) => ({
    text: e.content,
    completed: e.status === 'completed'
  }))
}

export function createAcpMapper(opts: AcpiMapperOptions): AcpMapper {
  const { threadId, runId } = opts
  /** 已发 START 的流式 messageId(text/reasoning 共用防重放) */
  const startedMessageIds = new Set<string>()
  /** 已发 START 三帧的 toolCallId(重放去重) */
  const startedToolIds = new Set<string>()
  /** 已发 RESULT 的 toolCallId(重放去重) */
  const resultToolIds = new Set<string>()
  /** 已见过的 plan 快照(逐条相等比较,无变化不发,防重放刷屏) */
  let lastPlanKey = ''
  /** 实例内流转的增量缓存(当前 chunk 直接映射事件,恒空;保留接口对齐 translator) */
  const deltaBuffer: StreamDelta[] = []

  const feed = (notification: SessionNotification): AGUIEvent[] => {
    const update = (notification as { update?: { sessionUpdate?: string } }).update
    if (!update || typeof update.sessionUpdate !== 'string') return []
    const kind = update.sessionUpdate

    if (kind === 'agent_message_chunk') {
      const text = contentBlockText((update as { content?: unknown }).content)
      if (!text) return []
      const messageId = `acp-msg-${threadId}`
      const out: AGUIEvent[] = []
      if (!startedMessageIds.has(messageId)) {
        startedMessageIds.add(messageId)
        out.push(textMessageStart(messageId))
      }
      out.push(textMessageContent(messageId, text))
      return out
    }

    if (kind === 'agent_thought_chunk') {
      const text = contentBlockText((update as { content?: unknown }).content)
      if (!text) return []
      const messageId = `acp-thought-${threadId}`
      const out: AGUIEvent[] = []
      if (!startedMessageIds.has(messageId)) {
        startedMessageIds.add(messageId)
        out.push(reasoningMessageStart(messageId))
      }
      out.push(reasoningMessageContent(messageId, text))
      return out
    }

    if (kind === 'tool_call') {
      const u = update as {
        toolCallId?: string
        title?: string
        rawInput?: unknown
        kind?: string
      }
      if (!u.toolCallId || startedToolIds.has(u.toolCallId)) return []
      startedToolIds.add(u.toolCallId)
      return [
        toolCallStart(u.toolCallId, u.kind ?? u.title ?? 'tool'),
        toolCallArgs(u.toolCallId, JSON.stringify(u.rawInput ?? {})),
        toolCallEnd(u.toolCallId)
      ]
    }

    if (kind === 'tool_call_update') {
      const u = update as {
        toolCallId?: string
        status?: string
        title?: string
        content?: unknown
        rawOutput?: unknown
      }
      if (!u.toolCallId) return []
      if (isTerminalToolStatus(u.status)) {
        if (resultToolIds.has(u.toolCallId)) return []
        resultToolIds.add(u.toolCallId)
        // 自愈:未见 tool_call(乱序/丢事件)先补 START 三帧,保证帧配对完整
        const out: AGUIEvent[] = []
        if (!startedToolIds.has(u.toolCallId)) {
          startedToolIds.add(u.toolCallId)
          out.push(
            toolCallStart(u.toolCallId, u.title ?? 'tool'),
            toolCallArgs(u.toolCallId, '{}'),
            toolCallEnd(u.toolCallId)
          )
        }
        out.push(toolCallResult(u.toolCallId, toolResultText(u)))
        return out
      }
      // 非终态更新(title/status 变化)以 CUSTOM 留痕,前端工具卡可原位刷新
      return [custom('acp_tool_update', { toolCallId: u.toolCallId, ...u })]
    }

    if (kind === 'plan') {
      const entries = ((update as { entries?: unknown }).entries ?? []) as Array<{
        content: string
        status: string
      }>
      const key = JSON.stringify(entries)
      if (key === lastPlanKey) return [] // 重放/无变化防刷屏
      lastPlanKey = key
      return [custom('todos', { runId, items: planEntriesToTodos(entries) })]
    }

    // user_message_chunk / available_commands_update / current_mode_update /
    // 未知种类:全部静默忽略(降级不失败)
    return []
  }

  return {
    feed,
    drainDeltas: () => deltaBuffer.splice(0)
  }
}
