/**
 * AG-UI 协议事件类型(C1)。
 *
 * schema 权威来源:waa snc-platform-ai-agent `agui/AGUIEvent.java`
 * (基于 docs.ag-ui.com/concepts/events 标准 + Reasoning 扩展,21 种事件)。
 *
 * 设计要点:
 * - 纯类型 + 纯序列化函数,零 electron/express 依赖,可直接单测。
 * - 帧格式:AG-UI 标准「无 event: 行,类型在 JSON type 字段内」
 *   (`data: {"type":"RUN_STARTED",...}\n\n`);与旧版 workbench 的具名事件帧
 *   (`event: reply\ndata: {...}`)并存但互不混用。
 * - 序列化对齐 waa 后端语义:omit 空值(等价 Jackson @JsonInclude(NON_NULL)),
 *   timestamp 统一毫秒;构造器统一注入 timestamp。
 */

// ==================== 事件类型枚举(21 种,与 waa EventType 一一对应) ====================

export const AGUI_EVENT_TYPES = [
  // Lifecycle
  'RUN_STARTED',
  'RUN_FINISHED',
  'RUN_ERROR',
  'STEP_STARTED',
  'STEP_FINISHED',
  // Text Message
  'TEXT_MESSAGE_START',
  'TEXT_MESSAGE_CONTENT',
  'TEXT_MESSAGE_END',
  // Tool Call
  'TOOL_CALL_START',
  'TOOL_CALL_ARGS',
  'TOOL_CALL_END',
  'TOOL_CALL_RESULT',
  // State
  'STATE_SNAPSHOT',
  'STATE_DELTA',
  'MESSAGES_SNAPSHOT',
  // Reasoning(waa 扩展,AG-UI 标准外)
  'REASONING_START',
  'REASONING_END',
  'REASONING_MESSAGE_START',
  'REASONING_MESSAGE_CONTENT',
  'REASONING_MESSAGE_END',
  // Special
  'CUSTOM'
] as const

export type AguiEventType = (typeof AGUI_EVENT_TYPES)[number]

// ==================== 角色常量(waa AGUIEvent 同名) ====================

export const ASSISTANT_ROLE = 'assistant'
export const REASONING_ROLE = 'reasoning'
export const TOOL_ROLE = 'tool'
export const USER_ROLE = 'user'

// ==================== 事件载荷形状 ====================

interface EventBase {
  type: AguiEventType
  timestamp: number
}

// Lifecycle
export interface RunStartedEvent extends EventBase {
  type: 'RUN_STARTED'
  threadId: string
  runId: string
}
export interface RunFinishedEvent extends EventBase {
  type: 'RUN_FINISHED'
  threadId: string
  runId: string
}
export interface RunErrorEvent extends EventBase {
  type: 'RUN_ERROR'
  message: string
  code?: string
}
export interface StepStartedEvent extends EventBase {
  type: 'STEP_STARTED'
  stepName: string
  stepDescription?: string
}
export interface StepFinishedEvent extends EventBase {
  type: 'STEP_FINISHED'
  stepName: string
}

// Text Message
export interface TextMessageStartEvent extends EventBase {
  type: 'TEXT_MESSAGE_START'
  messageId: string
  role: string
}
export interface TextMessageContentEvent extends EventBase {
  type: 'TEXT_MESSAGE_CONTENT'
  messageId: string
  delta: string
}
export interface TextMessageEndEvent extends EventBase {
  type: 'TEXT_MESSAGE_END'
  messageId: string
}

// Tool Call
export interface ToolCallStartEvent extends EventBase {
  type: 'TOOL_CALL_START'
  toolCallId: string
  toolCallName: string
  parentMessageId?: string
}
export interface ToolCallArgsEvent extends EventBase {
  type: 'TOOL_CALL_ARGS'
  toolCallId: string
  delta: string
}
export interface ToolCallEndEvent extends EventBase {
  type: 'TOOL_CALL_END'
  toolCallId: string
}
export interface ToolCallResultEvent extends EventBase {
  type: 'TOOL_CALL_RESULT'
  messageId?: string
  toolCallId: string
  content: string
  role: string
}

// State(delta 为 JSON-Patch 数组,如 [{op:'replace', path:'/tokenUsage/inputTokens', value:1}])
export interface StateSnapshotEvent extends EventBase {
  type: 'STATE_SNAPSHOT'
  snapshot: Record<string, unknown>
}
export interface StateDeltaEvent extends EventBase {
  type: 'STATE_DELTA'
  delta: Array<{ op: string; path: string; value?: unknown }>
}
export interface MessagesSnapshotEvent extends EventBase {
  type: 'MESSAGES_SNAPSHOT'
  messages: unknown[]
}

// Reasoning(waa 扩展)
export interface ReasoningStartEvent extends EventBase {
  type: 'REASONING_START'
  messageId: string
}
export interface ReasoningEndEvent extends EventBase {
  type: 'REASONING_END'
  messageId: string
}
export interface ReasoningMessageStartEvent extends EventBase {
  type: 'REASONING_MESSAGE_START'
  messageId: string
  role: string
}
export interface ReasoningMessageContentEvent extends EventBase {
  type: 'REASONING_MESSAGE_CONTENT'
  messageId: string
  delta: string
}
export interface ReasoningMessageEndEvent extends EventBase {
  type: 'REASONING_MESSAGE_END'
  messageId: string
}

// Special
export interface CustomEvent extends EventBase {
  type: 'CUSTOM'
  name: string
  value?: unknown
}

export type AGUIEvent =
  | RunStartedEvent
  | RunFinishedEvent
  | RunErrorEvent
  | StepStartedEvent
  | StepFinishedEvent
  | TextMessageStartEvent
  | TextMessageContentEvent
  | TextMessageEndEvent
  | ToolCallStartEvent
  | ToolCallArgsEvent
  | ToolCallEndEvent
  | ToolCallResultEvent
  | StateSnapshotEvent
  | StateDeltaEvent
  | MessagesSnapshotEvent
  | ReasoningStartEvent
  | ReasoningEndEvent
  | ReasoningMessageStartEvent
  | ReasoningMessageContentEvent
  | ReasoningMessageEndEvent
  | CustomEvent

// ==================== 构造器(统一注入 timestamp;对应 waa 各 record 的便捷构造) ====================

export function runStarted(threadId: string, runId: string): RunStartedEvent {
  return { type: 'RUN_STARTED', timestamp: Date.now(), threadId, runId }
}
export function runFinished(threadId: string, runId: string): RunFinishedEvent {
  return { type: 'RUN_FINISHED', timestamp: Date.now(), threadId, runId }
}
export function runError(message: string, code?: string): RunErrorEvent {
  return { type: 'RUN_ERROR', timestamp: Date.now(), message, ...(code ? { code } : {}) }
}
export function textMessageStart(messageId: string, role = ASSISTANT_ROLE): TextMessageStartEvent {
  return { type: 'TEXT_MESSAGE_START', timestamp: Date.now(), messageId, role }
}
export function textMessageContent(messageId: string, delta: string): TextMessageContentEvent {
  return { type: 'TEXT_MESSAGE_CONTENT', timestamp: Date.now(), messageId, delta }
}
export function textMessageEnd(messageId: string): TextMessageEndEvent {
  return { type: 'TEXT_MESSAGE_END', timestamp: Date.now(), messageId }
}
export function toolCallStart(
  toolCallId: string,
  toolCallName: string,
  parentMessageId?: string
): ToolCallStartEvent {
  return {
    type: 'TOOL_CALL_START',
    timestamp: Date.now(),
    toolCallId,
    toolCallName,
    ...(parentMessageId ? { parentMessageId } : {})
  }
}
export function toolCallArgs(toolCallId: string, delta: string): ToolCallArgsEvent {
  return { type: 'TOOL_CALL_ARGS', timestamp: Date.now(), toolCallId, delta }
}
export function toolCallEnd(toolCallId: string): ToolCallEndEvent {
  return { type: 'TOOL_CALL_END', timestamp: Date.now(), toolCallId }
}
export function toolCallResult(
  toolCallId: string,
  content: string,
  messageId?: string
): ToolCallResultEvent {
  return {
    type: 'TOOL_CALL_RESULT',
    timestamp: Date.now(),
    ...(messageId ? { messageId } : {}),
    toolCallId,
    content,
    role: TOOL_ROLE
  }
}
export function stateDelta(delta: StateDeltaEvent['delta']): StateDeltaEvent {
  return { type: 'STATE_DELTA', timestamp: Date.now(), delta }
}
export function reasoningMessageStart(messageId: string): ReasoningMessageStartEvent {
  return { type: 'REASONING_MESSAGE_START', timestamp: Date.now(), messageId, role: REASONING_ROLE }
}
export function reasoningMessageContent(
  messageId: string,
  delta: string
): ReasoningMessageContentEvent {
  return { type: 'REASONING_MESSAGE_CONTENT', timestamp: Date.now(), messageId, delta }
}
export function reasoningMessageEnd(messageId: string): ReasoningMessageEndEvent {
  return { type: 'REASONING_MESSAGE_END', timestamp: Date.now(), messageId }
}
export function custom(name: string, value?: unknown): CustomEvent {
  return { type: 'CUSTOM', timestamp: Date.now(), name, ...(value !== undefined ? { value } : {}) }
}

// ==================== SSE 帧序列化 ====================

/**
 * 序列化为 AG-UI 标准 SSE 帧。
 * - omit undefined 字段(JSON.stringify 天然行为,等价 NON_NULL;显式 null 保留)。
 * - 帧尾双换行(`\n\n`),与 waa 后端 Flux<ServerSentEvent> 产出、前端 parser 消费一致。
 * - data 单行 JSON:JSON.stringify 不产出换行,无帧边界风险。
 */
export function encodeSseFrame(event: AGUIEvent): string {
  return `data: ${JSON.stringify(event)}\n\n`
}

/** 解析一帧 AG-UI data(JSON → 事件),供测试/回放校验;非法 JSON 返回 null。 */
export function decodeSseData(data: string): AGUIEvent | null {
  try {
    const obj = JSON.parse(data) as { type?: string }
    if (!obj || typeof obj.type !== 'string') return null
    if (!(AGUI_EVENT_TYPES as readonly string[]).includes(obj.type)) return null
    return obj as AGUIEvent
  } catch {
    return null
  }
}
