/**
 * C16 — codex app-server 通知 → exec 形态 ThreadEvent + 流式 delta 翻译器
 * (workbench-agui-migration.md §C16)。
 *
 * 职责:消费 appServerClient 的通知流,产出两路输出:
 *   1. events: exec 形态 ThreadEvent(item.started/completed、turn.completed …)
 *      ——与生产 exec 通道同构,decide 事件循环/mapper/parsePlanFromCodex 零改动;
 *   2. deltas: token 级增量(item/agentMessage/delta、item/reasoning/textDelta …)
 *      ——C16 新通道,由 mapper.feedStreamDelta 映射 AG-UI TEXT/REASONING CONTENT 帧。
 *
 * 关键语义:
 *   - agentMessage 的 item.started/completed 照翻(整段 text 兜底,断流自愈);
 *     completed 翻译时带上「本 item 已流式发送过」的标记(mapper 据此跳过
 *     整段重发,只发 END 收口);
 *   - delta 通知里的 threadId/turnId 不校验(单 turn 驱动,调用方保证时序);
 *   - error 通知:willRetry=true 忽略(重连噪音);false → exec 形态 error 事件。
 *
 * 纯函数状态机,零依赖,可直接单测。
 */
import type { ThreadEvent } from '../vendor/codex-sdk'

/** 流式增量(已带 item 粒度归属,映射层直接用) */
export interface StreamDelta {
  kind: 'text' | 'reasoning'
  itemId: string
  delta: string
}

/** app-server 通知的最小结构(翻译器只认这些字段) */
export interface AppServerEvent {
  method: string
  params: Record<string, unknown>
}

/** item/* 通知里 item 对象的最小形态 */
interface ItemLike {
  id?: string
  type?: string
  text?: string
  [k: string]: unknown
}

/** exec ThreadItem 形态(agent_message/reasoning 之外按需扩) */
interface ExecItem {
  id: string
  type: string
  [k: string]: unknown
}

export interface AppServerTranslator {
  /** 喂入 app-server 通知,返回 [exec 形态事件, 流式 delta] */
  feed(event: AppServerEvent): { events: ThreadEvent[]; deltas: StreamDelta[] }
  /** 已流式发送过正文的 agentMessage item id 集合(completed 兜底去重用) */
  streamedItemIds(): Set<string>
}

/** app-server item type → exec item type(驼峰 → 蛇形) */
const ITEM_TYPE_MAP: Record<string, string> = {
  agentMessage: 'agent_message',
  reasoning: 'reasoning',
  commandExecution: 'command_execution',
  fileChange: 'file_change',
  mcpToolCall: 'mcp_tool_call',
  webSearch: 'web_search',
  todoList: 'todo_list',
  error: 'error',
  plan: 'plan'
}

export function createAppServerTranslator(): AppServerTranslator {
  /** 已流式发送过 delta 的 agentMessage item id(completed 时只收口不重发) */
  const streamedTextIds = new Set<string>()

  /** app-server item → exec ThreadItem 形态(字段名映射 + text 提取) */
  const toExecItem = (raw: ItemLike): ExecItem | null => {
    const execType = ITEM_TYPE_MAP[raw.type ?? '']
    if (!execType) return null
    const out: ExecItem = { id: raw.id ?? '', type: execType }
    // agentMessage/reasoning 的正文都在 text;其余工具条目字段名不同但 mapper
    // 读 arguments/command/changes/query/result 等原始字段——app-server 与 exec
    // 的字段名在这些条目上基本同名(驼峰差异在 type 上,其余保持原样透传)
    for (const [k, v] of Object.entries(raw)) {
      if (k === 'type' || k === 'id') continue
      out[k] = v
    }
    if (typeof raw.text === 'string') out.text = raw.text
    return out
  }

  const feed = (event: AppServerEvent): { events: ThreadEvent[]; deltas: StreamDelta[] } => {
    const events: ThreadEvent[] = []
    const deltas: StreamDelta[] = []
    const { method, params } = event

    if (method === 'thread/started') {
      events.push({ type: 'thread.started', thread_id: String(params.threadId ?? '') })
      return { events, deltas }
    }
    if (method === 'turn/started') {
      events.push({ type: 'turn.started' })
      return { events, deltas }
    }
    if (method === 'turn/completed') {
      // usage 从 turn.tokenUsage(app-server Turn 形态)提取
      const turn = (params.turn ?? {}) as Record<string, unknown>
      const usageRaw = (turn.tokenUsage ?? {}) as Record<string, unknown>
      events.push({
        type: 'turn.completed',
        usage: {
          input_tokens: Number(usageRaw.inputTokens ?? usageRaw.input_tokens ?? 0),
          cached_input_tokens: Number(
            usageRaw.cachedInputTokens ?? usageRaw.cached_input_tokens ?? 0
          ),
          cache_write_input_tokens: Number(
            usageRaw.cacheWriteInputTokens ?? usageRaw.cache_write_input_tokens ?? 0
          ),
          output_tokens: Number(usageRaw.outputTokens ?? usageRaw.output_tokens ?? 0),
          reasoning_output_tokens: Number(
            usageRaw.reasoningOutputTokens ?? usageRaw.reasoning_output_tokens ?? 0
          )
        }
      })
      return { events, deltas }
    }
    if (method === 'item/started' || method === 'item/completed') {
      const raw = (params.item ?? {}) as ItemLike
      const item = toExecItem(raw)
      if (!item) return { events, deltas }
      if (method === 'item/started') {
        events.push({ type: 'item.started', item: item as never })
        return { events, deltas }
      }
      // completed:agentMessage 已流式过 → 带标记,mapper 只发 END
      if (item.type === 'agent_message' && streamedTextIds.has(item.id)) {
        events.push({
          type: 'item.completed',
          item: { ...item, __streamed: true } as never
        })
        return { events, deltas }
      }
      events.push({ type: 'item.completed', item: item as never })
      return { events, deltas }
    }
    if (method === 'item/agentMessage/delta') {
      const itemId = String(params.itemId ?? '')
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (!itemId || !delta) return { events, deltas }
      streamedTextIds.add(itemId)
      deltas.push({ kind: 'text', itemId, delta })
      return { events, deltas }
    }
    if (method === 'item/reasoning/textDelta' || method === 'item/reasoning/summaryTextDelta') {
      const itemId = String(params.itemId ?? '')
      const delta = typeof params.delta === 'string' ? params.delta : ''
      if (!itemId || !delta) return { events, deltas }
      deltas.push({ kind: 'reasoning', itemId, delta })
      return { events, deltas }
    }
    if (method === 'error') {
      const err = (params.error ?? {}) as { message?: string; willRetry?: boolean }
      if (err.willRetry) return { events, deltas } // 重连噪音
      events.push({ type: 'error', message: err.message ?? 'app-server turn error' })
      return { events, deltas }
    }
    // 其余通知(thread/status、mcpServer/…、account/…)与本管线无关,静默丢弃
    return { events, deltas }
  }

  return { feed, streamedItemIds: () => streamedTextIds }
}
