// views/workbench/aguiBridge.js — AG-UI 桥(唯一聊天管线,migration 文档 C11 起)
//
// send/stop/history 三条路径全部走 AG-UI 管线
// (POST /api/workbench/agent/run → SSE → handlers.js emit → 现有页面消息模型);
// legacy /api/workbench/chat 路径已删除,本桥无条件创建。
//
// 设计要点：
// - 直接复用 C8 共享管线（parser/streamReader/handlers），emit 回调把结构化事件
//   映射进页面消息模型（pushMsg/turnId/_key 体系），而不是 aguiSession store 的
//   扁平模型——页面渲染依赖 codex 形状的 toolItem（toolItemSummary/Detail 原样
//   复用），store 形状与之不同，故此处自成 emit→页面模型映射层。
// - tool:name 反向映射 codexMapper.ts 的 toolCallName 归一（shell/file_change/
//   web_search/其余按 mcp_tool_call），合成 codex 形状 toolItem 原位 upsert。
// - CUSTOM：wb_plan → 现有计划卡路径；todos → todo_list 条目；wb_error → 错误气泡；
//   wb_artifact/wb_sync/wb_canvas_exec/wb_invalid → 页面注入的
//   applyExecutionSideEffect(执行副作用统一分派);
//   其余前向兼容忽略。
// - /agent/run 支持 {threadId, runId, input, attachments}:附件经后端 decide 落
//   用户消息与会话素材表(与原 /chat 同语义),用户气泡本地渲染不变。
import { createHandlerContext, dispatch } from '@/utils/agui/handlers'
import { readAguiStream } from '@/utils/agui/streamReader'
import { replayToMessages } from '@/utils/agui/historyReassembler'

// ── codex 形状合成：把 AG-UI tool 事件还原成页面 toolItemSummary/Detail 认得的条目 ──

/** codexMapper.ts toolCallName 归一的反向映射 */
function toolTypeFromName(name) {
  if (name === 'shell') return 'command_execution'
  if (name === 'file_change') return 'file_change'
  if (name === 'web_search') return 'web_search'
  return 'mcp_tool_call'
}

/**
 * 合成 codex 形状 toolItem（页面现有渲染器零改动）：
 * - command_execution：args.command → item.command，result → aggregated_output，
 *   完成时补 exit_code=0（页面 in-flight 判定依赖 exit_code 出现）
 * - file_change / web_search：args.changes / args.query 原位
 * - mcp_tool_call（wb_* 等工作台工具）：server 固定 'workbench'，arguments/result
 *   尽量 JSON.parse（失败降级 {raw}）
 */
export function synthToolItem(id, name, argsJson, result, done) {
  const type = toolTypeFromName(name)
  let args = {}
  try {
    args = argsJson ? JSON.parse(argsJson) : {}
  } catch {
    args = {}
  }
  if (args === null || typeof args !== 'object') args = {}
  const item = { id, type, status: done ? 'completed' : 'in_progress' }
  if (type === 'command_execution') {
    item.command = args.command || ''
    if (done) {
      item.aggregated_output = result ?? ''
      item.exit_code = 0
    }
  } else if (type === 'file_change') {
    item.changes = Array.isArray(args.changes) ? args.changes : []
  } else if (type === 'web_search') {
    item.query = args.query || ''
  } else {
    item.server = 'workbench'
    item.tool = name || 'tool'
    item.arguments = args
    if (done && result != null && result !== '') {
      try {
        item.result = JSON.parse(result)
      } catch {
        item.result = { raw: result }
      }
    }
  }
  return item
}

// ── emit → 页面消息模型映射 ──

/** 单轮运行的映射内部状态（key 索引 + 进度气泡等） */
export function freshRunState() {
  return {
    textById: new Map(), // messageId → { key, text }
    reasoningById: new Map(), // messageId → { key, text }
    toolById: new Map(), // toolCallId → 消息 _key
    toolNames: new Map(), // toolCallId → name
    toolArgs: new Map(), // toolCallId → args JSON（tool:result 重合成时复用，防 result 丢字段）
    customSeq: 0,
    progressKey: null,
    dismissed: false,
    sawRunError: false,
    sawRunFinish: false, // 审查修复 M1:SSE 干净截断(无终帧)收尾判定
    // P1-B3:todo 卡 per-run 稳定寻址(runId → 消息 _key)。回放时一个 state 跨多个
    // run 共享,靠 runId 区分目标卡;实时轮单 run 同态(updated 多帧收敛为一卡)。
    todoByRunId: new Map(),
  }
}

function dismissProgress(pageApi, state) {
  if (!state.progressKey || state.dismissed) return
  state.dismissed = true
  const idx = pageApi.messages.value.findIndex((m) => m._key === state.progressKey)
  if (idx !== -1) pageApi.messages.value.splice(idx, 1)
}

/** text:start/delta → 页面 chat 消息（首个 delta 才占行，原位累积文本） */
function upsertChatText(pageApi, state, messageId, delta) {
  let rec = state.textById.get(messageId)
  if (!rec) {
    dismissProgress(pageApi, state)
    const msg = pageApi.pushMsg({
      role: 'agent',
      kind: 'chat',
      text: delta || '',
      _streaming: true, // M5:WbMarkdown 流式窗口标记(text:end/run 结束清)
      createdAt: Date.now(),
    })
    state.textById.set(messageId, { key: msg._key, text: delta || '' })
    pageApi.scrollToBottom()
    return
  }
  rec.text += delta || ''
  const idx = pageApi.messages.value.findIndex((m) => m._key === rec.key)
  if (idx !== -1) pageApi.messages.value[idx] = { ...pageApi.messages.value[idx], text: rec.text }
}

/** text:end(审查修复 M5):清流式标记,该条消息下一帧起走终态全量渲染 */
function endChatText(pageApi, state, messageId) {
  const rec = state.textById.get(messageId)
  if (!rec) return
  const idx = pageApi.messages.value.findIndex((m) => m._key === rec.key)
  if (idx !== -1 && pageApi.messages.value[idx]._streaming) {
    pageApi.messages.value[idx] = { ...pageApi.messages.value[idx], _streaming: false }
  }
}

/**
 * reasoning:* → codex reasoning 条目（reasoning 最小可行渲染：复用现有
 * tool_item 行——brain 图标 + 前 80 字摘要，展开看全文，零模板改动）。
 */
function upsertReasoning(pageApi, state, messageId, delta, done) {
  const item = (text) => ({
    id: messageId,
    type: 'reasoning',
    text,
    status: done ? 'completed' : 'in_progress',
  })
  let rec = state.reasoningById.get(messageId)
  if (!rec) {
    dismissProgress(pageApi, state)
    const msg = pageApi.pushMsg({
      role: 'agent',
      kind: 'tool_item',
      text: '',
      toolItem: item(delta || ''),
      createdAt: Date.now(),
    })
    state.reasoningById.set(messageId, { key: msg._key, text: delta || '' })
    pageApi.scrollToBottom()
    return
  }
  rec.text += delta || ''
  const idx = pageApi.messages.value.findIndex((m) => m._key === rec.key)
  if (idx !== -1)
    pageApi.messages.value[idx] = { ...pageApi.messages.value[idx], toolItem: item(rec.text) }
}

/** tool:start/args/result → codex 形状 toolItem 占行 + 原位 upsert。
 *  args 一次全量下发后缓存：tool:result 的重合成必须复用，否则 command/query 等字段丢失 */
function upsertTool(pageApi, state, toolCallId, argsJson, result, done) {
  const name = state.toolNames.get(toolCallId) || ''
  if (argsJson) state.toolArgs.set(toolCallId, argsJson)
  const item = synthToolItem(
    toolCallId,
    name,
    argsJson || state.toolArgs.get(toolCallId),
    result,
    done,
  )
  const key = state.toolById.get(toolCallId)
  if (key === undefined) {
    dismissProgress(pageApi, state)
    const msg = pageApi.pushMsg({
      role: 'agent',
      kind: 'tool_item',
      text: '',
      toolItem: item,
      createdAt: Date.now(),
    })
    state.toolById.set(toolCallId, msg._key)
    pageApi.scrollToBottom()
    return
  }
  const idx = pageApi.messages.value.findIndex((m) => m._key === key)
  if (idx !== -1) pageApi.messages.value[idx] = { ...pageApi.messages.value[idx], toolItem: item }
}

/**
 * todos CUSTOM → todo_list 进度卡（P1-B3，runId 作用域原位 upsert）：
 * - 同 runId 的 updated/completed 多帧快照收敛为**一张**卡：首帧占行，
 *   后续帧按 todoByRunId 找到目标消息原位替换 items/status，不重复刷屏；
 * - 回放态（一个 state 跨多 run 共享）与实时态同构——runId 是 per-run 寻址键，
 *   replay 的 N 帧 CUSTOM 快照落同一卡；不同 run 各成一张卡；
 * - 无 runId（旧载荷/后端降级）保持既有行为：每次推新卡，不参与去重。
 * status 语义：items 全 completed → completed（终态渲染），否则 in_progress。
 */
function upsertTodos(pageApi, state, value) {
  const items = value && Array.isArray(value.items) ? value.items : []
  const runId = value && value.runId != null ? String(value.runId) : null
  dismissProgress(pageApi, state)
  const key = runId !== null ? state.todoByRunId.get(runId) : undefined
  const idx = key !== undefined ? pageApi.messages.value.findIndex((m) => m._key === key) : -1
  const allDone = items.length > 0 && items.every((t) => t && t.completed === true)
  const status = allDone ? 'completed' : 'in_progress'
  if (idx === -1) {
    // 首帧：占行 + 登记 runId → _key（唯一一次 push，后续全走原位替换）
    state.customSeq += 1
    const msg = pageApi.pushMsg({
      role: 'agent',
      kind: 'tool_item',
      text: '',
      toolItem: {
        id: `todos:${runId !== null ? runId : state.customSeq}`,
        type: 'todo_list',
        items,
        status,
      },
      createdAt: Date.now(),
    })
    if (runId !== null) state.todoByRunId.set(runId, msg._key)
    pageApi.scrollToBottom()
    return
  }
  // 原位 upsert：替换整个 toolItem（保消息 _key/turnId 稳定，渲染层不重建）
  const prev = pageApi.messages.value[idx]
  pageApi.messages.value[idx] = { ...prev, toolItem: { ...prev.toolItem, items, status } }
}

/** CUSTOM 分派（实时 emit 与历史回放共用）：wb_plan / todos / wb_error / 审批，其余忽略 */
function applyCustom(pageApi, state, name, value) {
  if (name === 'tool_approval_required') {
    // C15:HITL 审批卡(value = C14 toolApprovalRequiredValue 形状)。
    // 卡片自身零 fetch,应答经 bridge.respondApproval → interaction-response
    dismissProgress(pageApi, state)
    pageApi.pushMsg({
      role: 'agent',
      kind: 'approval',
      text: '',
      approval: value,
      approvalStatus: 'pending',
      createdAt: Date.now(),
    })
    return
  }
  if (name === 'tool_approval_resolved') {
    // 审查修复 M4:终态回执(另一窗口/超时兜底已解决)→ 原位翻终态,
    // 多窗口与后端超时场景不再留可点的死卡
    if (value && value.requestId) {
      const target = pageApi.messages.value.find(
        (m) =>
          m.kind === 'approval' &&
          m.approvalStatus === 'pending' &&
          m.approval &&
          m.approval.requestId === value.requestId,
      )
      if (target) target.approvalStatus = value.approved ? 'approved' : 'rejected'
    }
    return
  }
  if (name === 'wb_plan') {
    // 落现有计划卡路径（kind:'card' + plan）
    dismissProgress(pageApi, state)
    const plan = value && typeof value === 'object' && value.plan ? value.plan : value
    pageApi.pushMsg({ role: 'agent', kind: 'card', text: '', plan, createdAt: Date.now() })
    return
  }
  if (name === 'todos') {
    // P1-B3:runId 作用域原位 upsert(updated/completed 多帧收敛为一卡)
    upsertTodos(pageApi, state, value)
    return
  }
  if (name === 'wb_error') {
    dismissProgress(pageApi, state)
    pageApi.pushMsg({
      role: 'agent',
      kind: 'error',
      text: (value && value.message) || 'error',
      createdAt: Date.now(),
    })
    return
  }
  // ---- 执行类副作用(审查修复 C1):与 legacy handleSse 共用页面注入的同一分派,
  // ---- 默认管线产物卡/画布同步/执行轮询/修复 UX 功能对等。
  const sideEffect = pageApi.applyExecutionSideEffect
  if (name === 'wb_artifact') {
    // value:{promptId,name,outputs,outputFiles}(flushArtifacts/单次回执同构)
    if (sideEffect) sideEffect('artifact', value)
    return
  }
  if (name === 'wb_sync') {
    // value:画布同步载荷(graph/ensureTab...),与 legacy 'sync' 事件 data 同构
    if (sideEffect) sideEffect('sync', value)
    return
  }
  if (name === 'wb_canvas_exec') {
    // value:画布执行指令,与 legacy 'canvas-exec' 事件 data 同构
    if (sideEffect) sideEffect('canvas-exec', value)
    return
  }
  if (name === 'wb_canvas_ops') {
    // value:{ops:[...]}(P3 A 画布 app 节点指令集;canvas-embedded 模式经
    // canvasMode 总线到宿主画布页,人审确认卡后执行)
    if (sideEffect) sideEffect('canvas-ops', value)
    return
  }
  if (name === 'wb_invalid') {
    // value:{issues:[...]}(route businessInvalid 载荷);错误终帧由 RUN_ERROR 分支
    // 独立处理,这里只驱动 pendingIssues 修复 UX
    if (sideEffect) sideEffect('invalid', value)
  }
  // 其余 CUSTOM:前向兼容忽略
}

/**
 * 构造 emit 回调（handlers.js 结构化事件 → 页面消息模型）。
 * @param {object} pageApi 页面适配器（见 createAguiBridge 注释）
 * @param {object} state freshRunState() 产物
 */
export function createPageEmit(pageApi, state) {
  return (name, payload) => {
    switch (name) {
      case 'run:start':
        break
      case 'run:finish':
        state.sawRunFinish = true
        dismissProgress(pageApi, state)
        break
      case 'run:error':
        state.sawRunError = true
        dismissProgress(pageApi, state)
        pageApi.pushMsg({
          role: 'agent',
          kind: 'error',
          text: payload.message || 'unknown error',
          createdAt: Date.now(),
        })
        break
      case 'text:start':
        break // 行由首个 delta 创建
      case 'text:end':
        // M5:清流式标记 → WbMarkdown streaming 翻 false 触发终态全量重渲染
        endChatText(pageApi, state, payload.messageId)
        break
      case 'text:delta':
        upsertChatText(pageApi, state, payload.messageId, payload.delta)
        break
      case 'reasoning:start':
        upsertReasoning(pageApi, state, payload.messageId, '', false)
        break
      case 'reasoning:delta':
        upsertReasoning(pageApi, state, payload.messageId, payload.delta, false)
        break
      case 'reasoning:end':
        upsertReasoning(pageApi, state, payload.messageId, '', true)
        break
      case 'tool:start':
        state.toolNames.set(payload.toolCallId, payload.name || '')
        upsertTool(pageApi, state, payload.toolCallId, '', null, false)
        break
      case 'tool:args':
        upsertTool(pageApi, state, payload.toolCallId, payload.args || '', null, false)
        break
      case 'tool:result':
        upsertTool(pageApi, state, payload.toolCallId, '', payload.content, true)
        break
      case 'custom':
        applyCustom(pageApi, state, payload.name, payload.value)
        break
      case 'state:delta':
        // /tokenUsage JSON-Patch(JSON-Patch replace 数组)→ 会话 turnUsages 同步。
        // 页面用量角标读 curSession.turnUsages(末位),这里把 AG-UI 轮的
        // turn.completed 用量与 legacy 轮对齐(服务端 appendTurnUsage 已落,
        // 此处兜底实时性——直接读 curSession,无则忽略)。
        applyTokenUsage(pageApi, payload.delta)
        break
      default:
        break // 其余未知通道前向兼容忽略
    }
  }
}

/**
 * STATE_DELTA /tokenUsage → curSession.turnUsages 兜底同步。
 * delta 形如 [{op:'replace', path:'/tokenUsage/inputTokens', value:123}, ...];
 * 只认 inputTokens/outputTokens/cachedInputTokens/reasoningOutputTokens 四键,
 * 缺键沿用旧值;curSession 为空(embed 冷启动等)静默忽略。
 */
function applyTokenUsage(pageApi, delta) {
  if (!Array.isArray(delta) || delta.length === 0) return
  const cur = pageApi.curSession && pageApi.curSession.value
  if (!cur) return
  if (!Array.isArray(cur.turnUsages)) cur.turnUsages = []
  const last = cur.turnUsages.length
    ? cur.turnUsages[cur.turnUsages.length - 1]
    : {
        inputTokens: 0,
        cachedInputTokens: 0,
        outputTokens: 0,
        reasoningOutputTokens: 0,
        at: 0,
      }
  let touched = false
  for (const op of delta) {
    if (!op || op.op !== 'replace' || typeof op.path !== 'string') continue
    const m = /^\/tokenUsage\/(\w+)$/.exec(op.path)
    if (!m || !(m[1] in last) || m[1] === 'at') continue
    last[m[1]] = Number(op.value) || 0
    touched = true
  }
  if (touched) last.at = Date.now()
}

/**
 * 创建灰度桥实例（页面单例）。
 *
 * @param {object} pageApi 页面适配器：
 *   - origin            ref<string>   服务端 origin（computed）
 *   - t                 (key) => string
 *   - messages          ref<Array>    页面消息模型
 *   - pushMsg           (m) => msg    统一推消息入口（注入 _key / turnId）
 *   - nextTurn          () => number  开新回合
 *   - scrollToBottom    () => void
 *   - busy / stopping   ref<boolean>  页面在途状态（停止按钮语义）
 *   - isStopCancelled   (e) => boolean  停止导致的流中断不算错误
 *   - getThreadId       () => string  当前 sessionId 即 AG-UI threadId
 *   - getApprovalMode   () => string  当前会话审批模式(B1:'standard'|'conservative',
 *                         每轮随 run 请求透传;缺省 undefined 后端走默认 standard)
 *   - getReasoningEffort () => string  当前推理强度(E1:'auto'|'low'|'medium'|'high'|'xhigh',
 *                         每轮随 run 请求透传;缺省 undefined 后端保持会话现状)
 */
export function createAguiBridge(pageApi) {
  let activeCtl = null // 当前轮 AbortController（单飞行轮，同 legacy chatReader）
  let lastState = null
  function pushError(state, text, extra = {}) {
    dismissProgress(pageApi, state)
    pageApi.pushMsg({ role: 'agent', kind: 'error', text, createdAt: Date.now(), ...extra })
  }

  /** 一轮对话:POST /agent/run(threadId/runId/input/attachments)→ SSE → emit 映射 */
  async function runAgentTurn(inputText, attachments, opts = {}) {
    const threadId = pageApi.getThreadId()
    const runId = `ng-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    pageApi.busy.value = true
    if (opts.userBubble != null) {
      const tid = pageApi.nextTurn()
      pageApi.pushMsg({
        role: 'user',
        kind: 'chat',
        text: opts.userBubble,
        attachments: attachments && attachments.length ? attachments : undefined,
        turnId: tid,
        createdAt: Date.now(),
      })
    }
    const state = freshRunState()
    lastState = state
    state.progressKey = pageApi.pushMsg({
      role: 'agent',
      kind: 'progress',
      text: opts.progressText ?? pageApi.t('workbenchDeciding'),
      createdAt: Date.now(),
    })._key
    pageApi.scrollToBottom()
    const ctl = new AbortController()
    activeCtl = ctl
    try {
      const res = await fetch(`${pageApi.origin.value}/api/workbench/agent/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId,
          runId,
          input: inputText,
          // B1 会话级审批模式(标准/保守):桥每轮自取当前 UI 偏好透传;
          // undefined(旧页面/测试桩未提供 getter)时后端 gate 走默认 standard。
          approvalMode:
            typeof pageApi.getApprovalMode === 'function' ? pageApi.getApprovalMode() : undefined,
          // E1 会话级推理强度(auto/low/medium/high/xhigh):桥每轮自取当前 UI
          // 偏好透传;undefined(旧页面/测试桩未提供 getter)时后端保持会话现状。
          reasoningEffort:
            typeof pageApi.getReasoningEffort === 'function'
              ? pageApi.getReasoningEffort()
              : undefined,
          // 附件透传(AttachmentMeta 形状,后端 decide 落用户消息+会话素材表)
          attachments: attachments && attachments.length ? attachments : undefined,
        }),
        signal: ctl.signal,
      })
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error((j && j.message) || `HTTP ${res.status}`)
      }
      const ctx = createHandlerContext(createPageEmit(pageApi, state))
      await readAguiStream(res, (ev) => dispatch(ctx, ev))
      // 审查修复 M1:干净截断(网关/代理关连接,reader 不抛错)时终帧缺失,
      // 进度气泡会永久残留。对齐 legacy finally 的「流读完没 done」防线。
      if (!state.sawRunFinish && !state.sawRunError && !pageApi.stopping.value) {
        dismissProgress(pageApi, state)
        // 断线重试（D 线）：中断气泡携带本轮原文，UI 提供「重试本轮」——后端断连
        // 即杀 run（ac.abort），自动重发有双跑风险（本轮可能已提交执行），须用户触发
        pushError(state, pageApi.t('workbenchStreamInterrupted'), { retryInput: inputText })
      }
    } catch (e) {
      // 停止导致的中断由 stopAgentRun 收尾；RUN_ERROR 已有错误气泡不重复推
      if (!pageApi.isStopCancelled(e) && !state.sawRunError) {
        pushError(state, (e && e.message) || String(e), { retryInput: inputText })
      }
    } finally {
      if (activeCtl === ctl) activeCtl = null
      // M5 兜底:异常截断(无 text:end)也清全部流式标记,消息全部翻终态渲染
      for (let i = 0; i < pageApi.messages.value.length; i++) {
        const m = pageApi.messages.value[i]
        if (m && m._streaming) {
          pageApi.messages.value[i] = { ...m, _streaming: false }
        }
      }
      pageApi.busy.value = false
      pageApi.scrollToBottom()
    }
  }

  /** 停止当前轮：POST /agent/cancel + abort 本地流，收尾同 legacy stopChat */
  async function stopAgentRun() {
    if (pageApi.stopping.value || !pageApi.busy.value) return
    pageApi.stopping.value = true
    try {
      fetch(`${pageApi.origin.value}/api/workbench/agent/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: pageApi.getThreadId() }),
      }).catch(() => {})
      const ctl = activeCtl
      activeCtl = null
      if (ctl) {
        try {
          ctl.abort()
        } catch {
          /* ignore */
        }
      }
      if (lastState) dismissProgress(pageApi, lastState)
      pageApi.pushMsg({
        role: 'agent',
        kind: 'chat',
        text: pageApi.t('workbenchStopped'),
        createdAt: Date.now(),
      })
    } finally {
      setTimeout(() => {
        pageApi.stopping.value = false
      }, 0)
    }
  }

  /**
   * 历史回放：threads/messages 事件行 → replayToMessages → 同一套页面形状映射。
   * 无 AG-UI 记录（records 空）或加载失败时静默保留 legacy session.messages。
   *
   * 审查修复 M2/M6:
   * - 按 runId 边界调 nextTurn() 重建回合,不再整段历史塌缩成一张巨型回合卡;
   * - 用户消息从 curSession.messages 按 createdAt 归并(eventStore 只有 agent 侧
   *   事件,用户消息由 decide() 写 legacy session.messages)——回放不再是
   *   agent 独白;
   * - 分页循环拉全量(records 可能 > 单页 500),头部轮次不再静默截断。
   */
  async function loadHistoryIntoPage(threadId) {
    let records = []
    try {
      const pageSize = 500
      for (let offset = 0; offset < 20; offset++) {
        // 竞态守卫：分页拉取期间用户再切会话（getThreadId 变了）即弃——
        // 旧会话回放覆盖新会话消息是真实竞态（20 页 await 窗口不短）
        if (typeof pageApi.getThreadId === 'function' && pageApi.getThreadId() !== threadId) return
        const res = await fetch(`${pageApi.origin.value}/api/workbench/agent/threads/messages`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ threadId, limit: pageSize, offset: offset * pageSize }),
        })
        const json = await res.json().catch(() => null)
        const pageRecords = (json && json.data && json.data.records) || []
        records = records.concat(pageRecords)
        if (pageRecords.length < pageSize) break
      }
    } catch {
      return
    }
    if (!Array.isArray(records) || records.length === 0) return
    // 终检：全部页返回后、清空 messages 前再校验（最后一页到清空间仍可能切走）
    if (typeof pageApi.getThreadId === 'function' && pageApi.getThreadId() !== threadId) return
    const state = freshRunState()
    // 审查修复 m5:回放态不写入 lastState(那是运行态,stopAgentRun 的
    // dismissProgress 消费对象)——回放期间在途 run 的收尾不受回放干扰
    pageApi.messages.value = []

    // M2:agent 消息按 run 边界重建回合;用户消息按 createdAt 归并到对应 run 前
    let currentRunId = null
    const legacyMsgs =
      (pageApi.curSession && pageApi.curSession.value && pageApi.curSession.value.messages) || []
    // legacy 用户消息(含 AG-UI 期 decide() 落的用户气泡)按时间归并
    const userMsgQueue = legacyMsgs
      .filter((m) => m.role === 'user')
      .slice()
      .sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0))

    const flushUsersBefore = (ts) => {
      while (userMsgQueue.length && (userMsgQueue[0].createdAt || 0) <= ts) {
        const u = userMsgQueue.shift()
        pageApi.pushMsg({
          role: 'user',
          kind: 'chat',
          text: u.text || '',
          attachments: u.attachments,
          createdAt: u.createdAt || Date.now(),
        })
      }
    }
    // 各 run 的首条落库时间(用户消息归并锚点:run 开始前的用户消息属于该轮输入)
    const runStartTsById = new Map()
    for (const rec of records) {
      if (rec.runId && rec.createdAt && !runStartTsById.has(rec.runId)) {
        runStartTsById.set(rec.runId, rec.createdAt)
      }
    }

    for (const m of replayToMessages(records)) {
      // 新 run 的第一条消息前:翻回合 + 归并该轮的用户输入
      if (m.__runId && m.__runId !== currentRunId) {
        currentRunId = m.__runId
        flushUsersBefore(runStartTsById.get(m.__runId) || Date.now())
        pageApi.nextTurn()
      }
      if (m.kind === 'text') {
        pageApi.pushMsg({ role: 'agent', kind: 'chat', text: m.text || '', createdAt: Date.now() })
      } else if (m.kind === 'reasoning') {
        pageApi.pushMsg({
          role: 'agent',
          kind: 'tool_item',
          text: '',
          toolItem: { id: m.id, type: 'reasoning', text: m.text || '', status: 'completed' },
          createdAt: Date.now(),
        })
      } else if (m.kind === 'tool') {
        pageApi.pushMsg({
          role: 'agent',
          kind: 'tool_item',
          text: '',
          toolItem: synthToolItem(m.toolCallId, m.name, m.args, m.result, m.status === 'done'),
          createdAt: Date.now(),
        })
      } else if (m.kind === 'custom') {
        applyCustom(pageApi, state, m.name, m.value)
      }
    }
    // 尾部剩余用户消息(最后一轮 run 之后发的)
    flushUsersBefore(Date.now() + 1)
    pageApi.scrollToBottom()
  }

  /**
   * 审批应答(C15):组件 emit respond({action,args?}) → POST interaction-response
   * → 成功后卡片消息翻 approved/rejected;失败(404 已终态/400 edit 参数非法/网络)
   * 保留 pending 供重试,错误走错误气泡。后端超时已按 reject 兜底,前端只管提交。
   * 审查修复 M3:非 pending(已终态/在途)直接忽略;404 视为「已在他处解决」
   * 静默置终态不弹错;请求期间 _approvalInFlight 供卡片禁用按钮。
   */
  async function respondApproval(msg, { action, args } = {}) {
    const value = msg && msg.approval
    if (!value || !value.requestId) return
    // 终态/在途防抖:双击第二下与后端已超时后的盲点都会打 404 误导用户
    if (msg.approvalStatus && msg.approvalStatus !== 'pending') return
    if (msg._approvalInFlight) return
    msg._approvalInFlight = true
    try {
      const res = await fetch(`${pageApi.origin.value}/api/workbench/agent/interaction-response`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          threadId: value.threadId || pageApi.getThreadId(),
          requestId: value.requestId,
          action,
          ...(action === 'edit' ? { args } : {}),
        }),
      })
      if (res.status === 404) {
        // 已在他处解决(超时兜底 reject/另开窗口应答过):静默置终态,不再重试
        setApprovalStatus(msg, action === 'reject' ? 'rejected' : 'approved')
        return
      }
      if (!res.ok) {
        const j = await res.json().catch(() => null)
        throw new Error((j && j.message) || `HTTP ${res.status}`)
      }
      // approve/edit 都是放行语义(edit = 按替换后参数放行);只有 reject 翻 rejected
      setApprovalStatus(msg, action === 'reject' ? 'rejected' : 'approved')
    } catch (e) {
      pageApi.pushMsg({
        role: 'agent',
        kind: 'error',
        text: `审批提交失败: ${(e && e.message) || String(e)}`,
        createdAt: Date.now(),
      })
    } finally {
      msg._approvalInFlight = false
    }
  }

  /** 按 _key 原位更新审批卡状态(pending → approved/rejected;原位赋值保引用稳定) */
  function setApprovalStatus(msg, status) {
    if (!msg || msg._key === undefined) return
    const idx = pageApi.messages.value.findIndex((m) => m._key === msg._key)
    if (idx !== -1) {
      pageApi.messages.value[idx].approvalStatus = status
    }
  }

  return { runAgentTurn, stopAgentRun, loadHistoryIntoPage, respondApproval }
}

export default createAguiBridge
