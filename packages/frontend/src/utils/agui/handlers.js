// utils/agui/handlers.js — AG-UI 事件处理注册表（C8，蓝本：waa services/agui/handlers/*）
//
// 与 waa 的结构差异（有意为之）：
// - waa 按 lifecycle/textMessage/reasoning/toolCall/custom/state 拆多文件，handler 直接写
//   Vue2 state/conv；本包前端是纯 JS + Pinia，管线层不 import 任何 Vue/Pinia，
//   全部 handler 合并到本文件，产出结构化回调（emit）而非直接写 store。
// - ctx 只由调用方构造 `{ emit }`（waa 的 ctx = { state, conv, runContext }）。
// - toolCall 的 args 累积 / START 幂等属于 handler 内部状态，与 waa 一致按 toolCallId 维护。
//
// emit 接口（调用方按需监听）：
//   run:start        {}                          RUN_STARTED
//   run:finish       {}                          RUN_FINISHED
//   run:error        { message, code }           RUN_ERROR
//   text:start       { messageId, role }         TEXT_MESSAGE_START
//   text:delta       { messageId, delta }        TEXT_MESSAGE_CONTENT
//   text:end         { messageId }               TEXT_MESSAGE_END
//   reasoning:start  { messageId, role }         REASONING_MESSAGE_START
//   reasoning:delta  { messageId, delta }        REASONING_MESSAGE_CONTENT
//   reasoning:end    { messageId }               REASONING_MESSAGE_END
//   tool:start       { toolCallId, name }        TOOL_CALL_START
//   tool:args        { toolCallId, args }        TOOL_CALL_END（args 累积完成后一次性派发）
//   tool:result      { toolCallId, content }     TOOL_CALL_RESULT
//   state:delta      { delta }                   STATE_DELTA
//   custom           { name, value }             CUSTOM（keepalive 忽略；未知 name 前向兼容仍派发）

// snake_case key → camelCase 归一化（防御性 no-op，照搬 waa handlers/index.js：
// 后端固定发 camelCase，当前对所有真实 payload 不产生变换；保留是为前后兼容——
// 一旦后端改回 snake_case，在 dispatch 入口统一归一化即可，无需改各 handler）
function snakeToCamel(s) {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase())
}

function normalizeEventKeys(ev) {
  if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return ev
  const out = {}
  for (const k in ev) {
    out[snakeToCamel(k)] = ev[k]
  }
  return out
}

// ── lifecycle ──

function onRunStarted(ctx) {
  ctx.emit('run:start', {})
}

function onRunFinished(ctx) {
  ctx.emit('run:finish', {})
}

function onRunError(ctx, event) {
  ctx.emit('run:error', { message: event.message || '', code: event.code })
}

// ── text message ──

function onTextStart(ctx, event) {
  ctx.emit('text:start', { messageId: event.messageId, role: event.role })
}

function onTextContent(ctx, event) {
  ctx.emit('text:delta', { messageId: event.messageId, delta: event.delta || '' })
}

function onTextEnd(ctx, event) {
  ctx.emit('text:end', { messageId: event.messageId })
}

// ── reasoning message（waa 扩展事件，结构同 TEXT，role='reasoning'）──

function onReasoningStart(ctx, event) {
  ctx.emit('reasoning:start', { messageId: event.messageId, role: event.role || 'reasoning' })
}

function onReasoningContent(ctx, event) {
  ctx.emit('reasoning:delta', { messageId: event.messageId, delta: event.delta || '' })
}

function onReasoningEnd(ctx, event) {
  ctx.emit('reasoning:end', { messageId: event.messageId })
}

// ── tool call ──
// args 累积与 START 幂等是 handler 注册表的内部状态（ctx 私有，见 createHandlerContext）。
// waa 幂等设计（C2 决策引用的 AgUiEventProcessor 重放坑）：同一 toolCallId 二次 START 忽略，
// 避免重放/乱序下重复建节点；ARGS 在 END 时一次性 emit('tool:args')。

function onToolStart(ctx, event) {
  const { toolCallId, toolCallName } = event
  if (!toolCallId || !toolCallName) return
  if (ctx._toolCalls.has(toolCallId)) return // 幂等：同 toolCallId 二次 START 忽略
  ctx._toolCalls.set(toolCallId, { name: toolCallName, args: '', ended: false })
  ctx.emit('tool:start', { toolCallId, name: toolCallName })
}

function onToolArgs(ctx, event) {
  const { toolCallId, delta } = event
  if (!toolCallId || !delta) return
  const tc = ctx._toolCalls.get(toolCallId)
  if (tc && !tc.ended) {
    tc.args += delta
  }
}

function onToolEnd(ctx, event) {
  const { toolCallId } = event
  if (!toolCallId) return
  const tc = ctx._toolCalls.get(toolCallId)
  if (tc && !tc.ended) {
    tc.ended = true
    ctx.emit('tool:args', { toolCallId, args: tc.args })
  }
}

function onToolResult(ctx, event) {
  const { toolCallId, content } = event
  if (!toolCallId) return
  ctx.emit('tool:result', { toolCallId, content })
}

// ── state delta ──

function onStateDelta(ctx, event) {
  if (!Array.isArray(event.delta) || event.delta.length === 0) return
  ctx.emit('state:delta', { delta: event.delta })
}

// ── custom ──

const NAME_KEEPALIVE = 'keepalive'

function onCustom(ctx, event) {
  const name = event.name
  if (name === NAME_KEEPALIVE) return // 心跳：忽略（防代理断连用，不渲染、不落历史）
  ctx.emit('custom', { name, value: event.value })
}

// ── 注册表（按 event.type 分发）──

const registry = new Map([
  // Run 生命周期
  ['RUN_STARTED', onRunStarted],
  ['RUN_FINISHED', onRunFinished],
  ['RUN_ERROR', onRunError],
  // Text message
  ['TEXT_MESSAGE_START', onTextStart],
  ['TEXT_MESSAGE_CONTENT', onTextContent],
  ['TEXT_MESSAGE_END', onTextEnd],
  // Reasoning message（waa 扩展）
  ['REASONING_MESSAGE_START', onReasoningStart],
  ['REASONING_MESSAGE_CONTENT', onReasoningContent],
  ['REASONING_MESSAGE_END', onReasoningEnd],
  // Tool call
  ['TOOL_CALL_START', onToolStart],
  ['TOOL_CALL_ARGS', onToolArgs],
  ['TOOL_CALL_END', onToolEnd],
  ['TOOL_CALL_RESULT', onToolResult],
  // State delta
  ['STATE_DELTA', onStateDelta],
  // Custom（按 event.name 二次分派）
  ['CUSTOM', onCustom],
])

/**
 * 构造 handler 上下文。ctx = { emit, _toolCalls }：
 * - emit(name, payload) 调用方注入的回调（store 侧写 state）
 * - _toolCalls 工具调用内部状态（args 累积 / START 幂等 / END 去重），对调用方私有
 * @param {(name: string, payload: any) => void} emit
 */
export function createHandlerContext(emit) {
  return { emit, _toolCalls: new Map() }
}

/**
 * dispatch — 归一化 key 后按 event.type 路由到 handler；未知/空 type 静默忽略
 * @param {object} ctx createHandlerContext 返回值
 * @param {{type: string, [k: string]: any}} event AG-UI 事件（JSON.parse 产物）
 */
export function dispatch(ctx, event) {
  if (!event || !event.type) return
  const ev = normalizeEventKeys(event)
  const handler = registry.get(ev.type)
  if (handler) handler(ctx, ev)
}

export { registry }
export default dispatch
