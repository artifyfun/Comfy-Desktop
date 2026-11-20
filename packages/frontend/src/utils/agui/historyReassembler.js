// utils/agui/historyReassembler.js — 历史事件行重组为结构化消息时间线（C8）
//
// 数据源：B 线 `POST /api/workbench/agent/threads/messages` 返回的事件级行 records
// （每行 { runId, seq, eventType, content }，content = AG-UI 事件 JSON 原文）。
//
// 与 waa historyReassembler 的差异（设计对齐 C3「实时流与历史回放同构」）：
// - 本仓库 eventStore 落库的是**完整 AG-UI 事件**（含 START/END 边界），content JSON.parse
//   即事件原文 → 直接喂同一套 handlers 重放即可，无需 waa 那套「合成边界事件」的干跑逻辑
//   （waa 的 MessageVO 不落边界事件，须手动补 RUN_STARTED/TEXT_MESSAGE_START 等）。
// - waa 重组产出带 orchestration 的单条 assistant message（step/round 嵌套）；
//   本包消费端是扁平消息数组（C9 store messages），故 replayToMessages 产出
//   [{kind:'text'|'reasoning'|'tool'|'custom', ...}] 的**扁平时间线**，与实时流
//   emit 序列同构 —— 同一 handlers 管线，零分叉。
//
// records 顺序假设：API 已按 (thread_id, run_id, seq) ASC 返回（C3 索引序），此处不重排。

import { createHandlerContext, dispatch } from './handlers.js'

// 解析 content JSON（防御：非 JSON / 空 → null）
function parseEvent(content) {
  if (!content || typeof content !== 'string') return null
  try {
    const ev = JSON.parse(content)
    return ev && typeof ev === 'object' ? ev : null
  } catch {
    return null
  }
}

/**
 * reassemble — 遍历喂 handler：records 逐行 parse → dispatch 到同一套 handlers，
 * 事件以 emit(name, payload) 回调产出。实时流（bindStream）与历史回放共用此管线。
 *
 * @param {Array<{runId?:string, seq?:number, eventType?:string, content:string}>} records
 * @param {(name: string, payload: any) => void} emit 结构化回调（接口同 handlers.js 注释）
 * @returns {{totalEvents: number, malformedRecords: number}} 诊断：
 *   totalEvents = 成功重放的事件数；malformedRecords = content 解析失败被跳过的行数
 */
export function reassemble(records, emit) {
  const ctx = createHandlerContext(emit)
  let totalEvents = 0
  let malformedRecords = 0
  if (!Array.isArray(records)) return { totalEvents, malformedRecords }

  for (const rec of records) {
    if (!rec) continue
    const ev = parseEvent(rec.content)
    if (!ev || !ev.type) {
      // 畸形行：跳过不阻断重组（fail-soft，诊断计数暴露给调用方）
      malformedRecords += 1
      continue
    }
    dispatch(ctx, ev)
    totalEvents += 1
  }
  return { totalEvents, malformedRecords }
}

/**
 * replayToMessages — 便捷封装：重放 records 并把 emit 序列折叠成结构化消息数组
 * （与实时流同构的扁平时间线）。
 *
 * 产出形状（每条带 __runId = 来源 run；ts = 聚合首帧的落库时间戳 createdAt，
 * 供回放侧与 legacy 用户消息做时间序归并——详见 aguiBridge.loadHistoryIntoPage）：
 *   { kind:'text',      id, role, text }                          text:start/delta/end 聚合
 *   { kind:'reasoning', id, role, text }                          reasoning:* 聚合
 *   { kind:'tool',      toolCallId, name, args, result, status }  tool:start/args/result 聚合
 *   { kind:'custom',    name, value }                             CUSTOM（keepalive 已被 handler 过滤）
 *   { kind:'error',     text }                                    RUN_ERROR（run 终态错误，页面对应 error 气泡）
 *
 * 防御：历史行缺边界事件（delta/end 先于 start 到达）时按 messageId/toolCallId 懒创建，
 * 与 waa「重组器必须容忍边界缺失」的教训一致。
 *
 * @param {Array} records 事件级行（content = AG-UI 事件 JSON 原文）
 * @returns {Array<object>} 结构化消息时间线
 */
export function replayToMessages(records) {
  /** @type {Array<object>} */
  const messages = []
  const textById = new Map() // messageId → text/reasoning message
  const toolById = new Map() // toolCallId → tool message
  const runErrByRun = new Map() // runId → 该 run 的 RUN_ERROR 聚合（同 run 只留最后一条）
  // 审查修复 M2:消息携带来源 runId,回放侧按 run 边界重建回合;
  // currentTs = 最近一条记录的行级 createdAt(聚合消息建行时取首帧时间做归并锚)
  let currentRunId = null
  let currentTs = undefined

  function ensureText(kind, messageId, role) {
    let m = textById.get(messageId)
    if (!m) {
      m = { kind, id: messageId, role: role || (kind === 'reasoning' ? 'reasoning' : 'assistant'), text: '', __runId: currentRunId, ts: currentTs }
      textById.set(messageId, m)
      messages.push(m)
    }
    return m
  }

  function ensureTool(toolCallId, name) {
    let m = toolById.get(toolCallId)
    if (!m) {
      m = { kind: 'tool', toolCallId, name: name || '', args: '', result: null, status: 'running', __runId: currentRunId, ts: currentTs }
      toolById.set(toolCallId, m)
      messages.push(m)
    }
    return m
  }

  const emit = (name, payload) => {
    switch (name) {
      case 'text:start':
        ensureText('text', payload.messageId, payload.role)
        break
      case 'text:delta':
        ensureText('text', payload.messageId).text += payload.delta || ''
        break
      case 'text:end':
        ensureText('text', payload.messageId)
        break
      case 'reasoning:start':
        ensureText('reasoning', payload.messageId, payload.role)
        break
      case 'reasoning:delta':
        ensureText('reasoning', payload.messageId).text += payload.delta || ''
        break
      case 'reasoning:end':
        ensureText('reasoning', payload.messageId)
        break
      case 'tool:start':
        ensureTool(payload.toolCallId, payload.name)
        break
      case 'tool:args':
        ensureTool(payload.toolCallId).args = payload.args || ''
        break
      case 'tool:result': {
        const m = ensureTool(payload.toolCallId)
        m.result = payload.content
        m.status = 'done'
        break
      }
      case 'custom':
        messages.push({ kind: 'custom', name: payload.name, value: payload.value, __runId: currentRunId, ts: currentTs })
        break
      case 'run:error': {
        // RUN_ERROR 终帧(业务失败/上游断连收尾):历史侧也要可见——
        // 缺它时错误轮回放只剩用户消息,报错气泡在 records 非空场景会静默丢失。
        // 同一 run 可落多条 RUN_ERROR(如断线重连 5/5 的重连失败帧),原位去重
        // 只留最后一条终态错误(重连提示帧无历史价值,刷屏反而干扰阅读)。
        const text = payload.message || 'unknown error'
        const key = currentRunId ?? ''
        let em = runErrByRun.get(key)
        if (!em) {
          em = { kind: 'error', text, __runId: currentRunId, ts: currentTs }
          runErrByRun.set(key, em)
          messages.push(em)
        } else {
          em.text = text
          em.ts = currentTs
        }
        break
      }
      // run:start/run:finish / state:delta / event：时间线不消费（store 侧各自处理）
      default:
        break
    }
  }

  // 手写重放循环(不经 reassemble:需在逐事件前更新 currentRunId 边界,
  // reassemble 的 emit 回调拿不到 record 粒度的 runId)。null/undefined 防御
  // 与 reassemble 同款(空输入 → 空时间线)。
  if (!Array.isArray(records)) return messages
  const ctx = createHandlerContext(emit)
  for (const rec of records) {
    if (rec && rec.runId) currentRunId = rec.runId
    if (rec && rec.createdAt !== undefined && rec.createdAt !== null) currentTs = rec.createdAt
    const ev = rec && parseEvent(rec.content)
    if (!ev || !ev.type) continue
    dispatch(ctx, ev)
  }
  return messages
}
export default replayToMessages
