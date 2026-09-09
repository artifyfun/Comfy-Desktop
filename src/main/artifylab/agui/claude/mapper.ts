/**
 * Claude Code 通道 —— stream-json → AG-UI 事件映射器。
 *
 * 输入:`claude -p --output-format stream-json --verbose` 的 JSONL 流(实测
 * 采集,claude_code_version 2.1.260)。行形态(与 OpenDesign claude-stream.ts
 * 归并结论一致,精简为 7 种 UI 事件):
 *   {type:'system',  subtype:'init', session_id, tools[], mcp_servers[]…}
 *   {type:'system',  subtype:'hook_started'/'hook_response'/'thinking_tokens', …}
 *   {type:'assistant', message:{content:[{type:'thinking',thinking}|
 *                                       {type:'text',text}|
 *                                       {type:'tool_use',id,name,input}]}, …}
 *   {type:'user',      message:{content:[{type:'tool_result',tool_use_id,
 *                                          content,is_error?}]}, …}
 *   {type:'result',    stop_reason/usage/total_cost_usd/result…}
 *
 * 映射(AG-UI):
 *   thinking 块        → REASONING_MESSAGE_START(首见)+CONTENT(整块,去重)
 *   text 块            → TEXT_MESSAGE_START(首见)+CONTENT(整块,去重)
 *   tool_use 块        → TOOL_CALL_START+ARGS(input JSON 一次给全)+END
 *   tool_result        → TOOL_CALL_RESULT(content 文本化;is_error 留痕)
 *   result             → STATE_DELTA(tokenUsage+cost)+RUN_FINISHED 由 transport 补
 *   system/hook 行     → 忽略(hook_started/hook_response/thinking_tokens 是噪音)
 *   未知 type          → 忽略(降级不失败,对齐 OpenDesign 原则)
 *
 * 幂等:text/thinking 块在 stream-json 里按块逐步吐出(每行一个完整 assistant
 * wrapper),同一 (messageId,块序) 只发一次 CONTENT;tool_use 以块 id 防重放。
 *
 * 纯函数状态机,零依赖,可直接单测(夹具取自真实 CLI 采集)。
 */
import {
  stateDelta,
  textMessageContent,
  textMessageStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  toolCallStart,
  reasoningMessageContent,
  reasoningMessageStart
} from '../types'
import type { AGUIEvent } from '../types'

/** JSONL 行的最小形态(mapper 只认这些字段;其余字段透传忽略) */
export interface ClaudeStreamLine {
  type?: string
  subtype?: string
  session_id?: string
  is_error?: boolean
  message?: {
    id?: string
    role?: string
    [k: string]: unknown
  }
  usage?: Record<string, unknown>
  total_cost_usd?: number
  [k: string]: unknown
}

export interface ClaudeMapperOptions {
  threadId: string
  runId: string
}

export interface ClaudeMapper {
  /** 喂入一行 JSONL(已 JSON.parse;解析失败由 transport 侧跳过),返回 AG-UI 事件 */
  feed(line: ClaudeStreamLine): AGUIEvent[]
}

/** text/thinking 块的防重放键:messageId + 块内容哈希(同块重放/整段重发不二次发) */
const blockKey = (messageId: string, text: string): string =>
  `${messageId}:${text.length}:${text.slice(0, 64)}`

export function createClaudeMapper(_opts: ClaudeMapperOptions): ClaudeMapper {
  const startedMessages = new Set<string>()
  const seenBlocks = new Set<string>()
  const startedTools = new Set<string>()
  const resultTools = new Set<string>()

  const feed = (line: ClaudeStreamLine): AGUIEvent[] => {
    const out: AGUIEvent[] = []
    const content = (line.message?.content ?? null) as Array<{
      type?: string
      text?: string
      thinking?: string
      id?: string
      name?: string
      input?: unknown
      tool_use_id?: string
      content?: unknown
      is_error?: boolean
    }> | null
    if (line.type === 'assistant' && Array.isArray(content)) {
      const messageId = line.message?.id ?? 'claude-msg'
      for (const block of content) {
        if (block.type === 'text' && typeof block.text === 'string' && block.text) {
          const key = blockKey(messageId, block.text)
          if (seenBlocks.has(key)) continue
          seenBlocks.add(key)
          if (!startedMessages.has(messageId)) {
            startedMessages.add(messageId)
            out.push(textMessageStart(messageId))
          }
          out.push(textMessageContent(messageId, block.text))
        } else if (
          block.type === 'thinking' &&
          typeof block.thinking === 'string' &&
          block.thinking
        ) {
          const key = blockKey(`think-${messageId}`, block.thinking)
          if (seenBlocks.has(key)) continue
          seenBlocks.add(key)
          const thinkId = `claude-think-${messageId}`
          if (!startedMessages.has(thinkId)) {
            startedMessages.add(thinkId)
            out.push(reasoningMessageStart(thinkId))
          }
          out.push(reasoningMessageContent(thinkId, block.thinking))
        } else if (block.type === 'tool_use' && typeof block.id === 'string' && block.id) {
          if (startedTools.has(block.id)) continue
          startedTools.add(block.id)
          out.push(
            toolCallStart(block.id, block.name ?? 'tool'),
            toolCallArgs(block.id, JSON.stringify(block.input ?? {})),
            toolCallEnd(block.id)
          )
        }
      }
      return out
    }

    if (line.type === 'user' && Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'tool_result' && typeof block.tool_use_id === 'string') {
          if (resultTools.has(block.tool_use_id)) continue
          resultTools.add(block.tool_use_id)
          const content =
            typeof block.content === 'string' ? block.content : JSON.stringify(block.content ?? '')
          const text = block.is_error ? `工具执行失败: ${content}` : content
          // 自愈:未见 tool_use(乱序)先补 START 三帧
          if (!startedTools.has(block.tool_use_id)) {
            startedTools.add(block.tool_use_id)
            out.push(
              toolCallStart(block.tool_use_id, 'tool'),
              toolCallArgs(block.tool_use_id, '{}'),
              toolCallEnd(block.tool_use_id)
            )
          }
          out.push(toolCallResult(block.tool_use_id, text))
        }
      }
      return out
    }

    if (line.type === 'result') {
      // usage → STATE_DELTA(路径对齐 codexMapper 的 /tokenUsage/* 前端契约)
      const usage = line.usage ?? {}
      const inputTokens = Number(usage.input_tokens ?? 0)
      const outputTokens = Number(usage.output_tokens ?? 0)
      const events: AGUIEvent[] = []
      if (inputTokens || outputTokens) {
        events.push(
          stateDelta([
            { op: 'replace', path: '/tokenUsage/inputTokens', value: inputTokens },
            { op: 'replace', path: '/tokenUsage/outputTokens', value: outputTokens }
          ])
        )
      }
      return events
    }

    // system/hook_started/hook_response/thinking_tokens/未知:忽略
    return out
  }

  return { feed }
}
