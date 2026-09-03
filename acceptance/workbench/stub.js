/**
 * Workbench 验收 stub（agent-browser 浏览器 E2E 用）
 *
 * 后端协议对齐 agui/types.ts AGUI_EVENT_TYPES（21 种 SCREAMING_SNAKE_CASE）：
 * - lifecycle:  RUN_STARTED / RUN_FINISHED / RUN_ERROR
 * - text:       TEXT_MESSAGE_START / _CONTENT / _END
 * - reasoning:  REASONING_MESSAGE_START / _CONTENT / _END
 * - custom:     CUSTOM {name, value?}（todos/tool_approval_required/tool_approval_resolved 等）
 *
 * 帧格式（types.ts:278 encodeSseFrame）: `data: {"type":"...","timestamp":...}\n\n`
 * 不发 `event:` 行（AG-UI 标准类型在 JSON type 字段内）。
 *
 * 覆盖验收场景：
 * - P1-B3 todo_list:input 含「规划/任务/验收/todo」→ CUSTOM todos 多帧,
 *   items shape={text, completed}（与 codexMapper.test.ts L365 / ProgressCard
 *   的 todoText/it.completed 双字段同构）；前端按 runId 原位 upsert 一张卡。
 * - B1 approval:input 含「审批/执行/approval」→ CUSTOM tool_approval_required,
 *   等 POST /agent/interaction-response 触发后,往同一 SSE 流推
 *   tool_approval_resolved;passthrough approvalMode(reasoningEffort/approvalMode
 *   每帧 console 打透传凭据)。
 * - E1 reasoning:input 含「思考/推理/reasoning」→ REASONING_MESSAGE_* 三帧。
 *
 * 设计：stream 复用 per-thread controller,interaction-response 可向同一 SSE
 * 推后续帧(对齐真实后端 approvalGate.onResolved → emit → sendFrame 同流回路)。
 */
;(function () {
  if (window.__workbenchStubInstalled) return
  window.__workbenchStubInstalled = true

  const ORIGIN = location.origin
  const INTERVAL_MS = 70 // 每帧推送间隔,够慢以便前端流式渲染可见

  // ============ Electron 桥 + server_origin（boot 不跳 /about）============
  window.server_origin = ORIGIN
  window.electronAPI = {
    ArtifyLab: {
      getConfig: async () => ({
        server_origin: ORIGIN,
        serverHost: ORIGIN,
        comfyHost: null,
        activeAppId: null,
        lang: 'zh',
        theme: 'dark',
        api_key: '',
        base_url: '',
        model: '',
        provider: '',
      }),
      getAppInfo: async () => ({ name: 'Artify Lab', version: 'verify' }),
      loadComfyUI: async () => ({ url: ORIGIN }),
    },
  }

  // ============ 内存 sessions store ============
  // W6 历史回放:session.messages 存用户消息(对齐真实后端 decide() 落 legacy
  // session.messages),reload 后由 localStorage 恢复,selectSession →
  // loadHistoryIntoPage 才能归并出用户气泡,而不是 agent 独白。
  const PERSIST_KEY = 'wb-stub-persist-v2'
  function loadPersisted() {
    try {
      const raw = localStorage.getItem(PERSIST_KEY)
      if (!raw) return null
      const st = JSON.parse(raw)
      if (!st || st.v !== 2) return null
      return st
    } catch { return null }
  }
  function persist() {
    try {
      localStorage.setItem(
        PERSIST_KEY,
        JSON.stringify({
          v: 2,
          sessions,
          nextId,
          history: [...eventsHistory.entries()],
        }),
      )
    } catch { /* storage 满/禁用时降级为纯内存,验收不影响 */ }
  }
  const restored = loadPersisted()
  let sessions = restored
    ? restored.sessions
    : [
        {
          id: 's-seed-1',
          title: '验收会话',
          archived: false,
          createdAt: Date.now() - 3600e3,
          updatedAt: Date.now() - 60e3,
          threadId: 't-seed-1',
          messages: [
            {
              role: 'user',
              kind: 'chat',
              text: '回放测试：规划任务并生成产物',
              createdAt: Date.now() - 30e3,
            },
          ],
        },
      ]
  let nextId = restored ? restored.nextId : 2

  // ============ Per-thread 流控制（持续可推帧的 SSE）============
  // threads: threadId → { controller, encoder, queue, flushing, closed, doneEnqueued, intervalMs,
  //                       runId, seq, truncateAfterFlush }
  const threads = new Map()
  // approvals: requestId → { threadId, toolName }
  const pendingApprovals = new Map()
  // eventsHistory: threadId → [{seq, runId, eventType, content}] 真实 AG-UI 事件回放源
  // （实时流推送时同步入库,historyReassembler.replayToMessages 用同一套 handlers 重放）
  const eventsHistory = new Map(restored ? restored.history : [])

  function recordEvent(threadId, seq, ev, runId) {
    let arr = eventsHistory.get(threadId)
    if (!arr) { arr = []; eventsHistory.set(threadId, arr) }
    arr.push({
      seq,
      runId: runId || '',
      eventType: ev.type,
      content: JSON.stringify(ev),
    })
    persist()
  }

  function encodeFrame(ev) {
    return 'data: ' + JSON.stringify(ev) + '\n\n'
  }

  function pushFrame(threadId, ev) {
    const t = threads.get(threadId)
    if (!t || t.closed) return
    if (ev.type === 'RUN_STARTED') t.runId = ev.runId
    const recRunId = ev.runId || t.runId || ''
    t.seq = (t.seq || 0) + 1
    t.queue.push(ev)
    recordEvent(threadId, t.seq, ev, recRunId)
    flushThread(threadId)
  }

  function flushThread(threadId) {
    const t = threads.get(threadId)
    if (!t || t.flushing || t.closed) return
if (t.queue.length === 0) {
        t.flushing = false
        // doneEnqueued(RUN_FINISHED 收到) 或 truncateAfterFlush(W7 断流场景) 才关
        if (t.doneEnqueued || t.truncateAfterFlush) {
          try { t.controller.close() } catch { /* ignore */ }
          t.closed = true
          threads.delete(threadId)
        }
        return
      }
    t.flushing = true
    const tick = () => {
      if (t.closed) { t.flushing = false; return }
      if (t.queue.length === 0) {
        t.flushing = false
        // W7:truncateAfterFlush(断流场景无 RUN_FINISHED)同样要在队列空后关流——
        // 否则前端 readAguiStream 永远等 EOF,workbenchStreamInterrupted 永不触发
        if (t.doneEnqueued || t.truncateAfterFlush) {
          try { t.controller.close() } catch { /* ignore */ }
          t.closed = true
          threads.delete(threadId)
        }
        return
      }
      const ev = t.queue.shift()
      try {
        t.controller.enqueue(t.encoder.encode(encodeFrame(ev)))
      } catch (e) {
        t.closed = true
        t.flushing = false
        threads.delete(threadId)
        return
      }
      console.log('[workbench-stub] emit', ev.type, ev.name || ev.messageId || ev.runId || '')
      if (ev.type === 'RUN_FINISHED') t.doneEnqueued = true
      setTimeout(tick, t.intervalMs)
    }
    tick()
  }

  function makeStream(threadId, intervalMs) {
    const enc = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        threads.set(threadId, {
          controller,
          encoder: enc,
          queue: [],
          flushing: false,
          closed: false,
          doneEnqueued: false,
          truncateAfterFlush: false,
          runId: null,
          seq: 0,
          intervalMs: intervalMs || INTERVAL_MS,
        })
        // 启动 flush 循环（无帧时 flush 立刻返回）
        flushThread(threadId)
      },
      cancel() {
        const t = threads.get(threadId)
        if (t) { t.closed = true; threads.delete(threadId) }
      },
    })
  }

  // ============ 场景帧构造 ============
  function nowMs() { return Date.now() }

  function frameRunStarted(threadId, runId) {
    return { type: 'RUN_STARTED', timestamp: nowMs(), threadId, runId }
  }
  function frameRunFinished(threadId, runId) {
    return { type: 'RUN_FINISHED', timestamp: nowMs(), threadId, runId }
  }
  function frameTextStart(messageId) {
    return { type: 'TEXT_MESSAGE_START', timestamp: nowMs(), messageId, role: 'assistant' }
  }
  function frameTextContent(messageId, delta) {
    return { type: 'TEXT_MESSAGE_CONTENT', timestamp: nowMs(), messageId, delta }
  }
  function frameTextEnd(messageId) {
    return { type: 'TEXT_MESSAGE_END', timestamp: nowMs(), messageId }
  }
  function frameReasoningStart(messageId) {
    return { type: 'REASONING_MESSAGE_START', timestamp: nowMs(), messageId, role: 'reasoning' }
  }
  function frameReasoningContent(messageId, delta) {
    return { type: 'REASONING_MESSAGE_CONTENT', timestamp: nowMs(), messageId, delta }
  }
  function frameReasoningEnd(messageId) {
    return { type: 'REASONING_MESSAGE_END', timestamp: nowMs(), messageId }
  }
  function frameCustom(name, value) {
    const ev = { type: 'CUSTOM', timestamp: nowMs(), name }
    if (value !== undefined) ev.value = value
    return ev
  }

  // ============ 场景脚本：根据 input 文本触发对应事件序列 ============
  function script(threadId, runId, input) {
    const s = String(input || '')
    const withTodos = /规划|任务|验收|todo/i.test(s)
    const withReasoning = /思考|推理|reasoning|thinking/i.test(s)
    const withApproval = /审批|执行|approval/i.test(s)
    // W4 产物卡（输入含产物/artifacts/生成图）
    const withArtifacts = /产物|artifacts|生成图/i.test(s)
    // W5 错误气泡（输入含错误/wb_error/fail）
    const withError = /错误|wb_error|fail|出错/i.test(s)
    // W7 截断回归（输入含断流/truncate）—— 故意不发 RUN_FINISHED,走 workbenchStreamInterrupted 路径
    const withTruncate = /断流|truncate/i.test(s)
    // W8 approval edit 参数（输入含修改参数/edit args）—— 携带可编辑参数,interaction-response action='edit' 时回写
    const withEditArgs = /修改参数|edit args/i.test(s)

    const mid = 'm-' + Math.random().toString(36).slice(2, 8)
    const rid = 'r-' + Math.random().toString(36).slice(2, 8)

    // 1) 始终先发 RUN_STARTED
    pushFrame(threadId, frameRunStarted(threadId, runId))

    // 2) 可选 reasoning（E1 场景）
    if (withReasoning) {
      pushFrame(threadId, frameReasoningStart(rid))
      pushFrame(threadId, frameReasoningContent(rid, '正在规划任务步骤……'))
      pushFrame(threadId, frameReasoningContent(rid, '逐项推进，标记完成进度。'))
      pushFrame(threadId, frameReasoningEnd(rid))
    }

    // 3) 文本正文（始终存在,便于流式渲染与肉眼观察）
    pushFrame(threadId, frameTextStart(mid))
    if (withApproval) {
      pushFrame(threadId, frameTextContent(mid, '即将执行模板，建议人工审批放行。'))
    } else if (withTodos) {
      pushFrame(threadId, frameTextContent(mid, '任务规划如下，请稍候完成进度。'))
    } else {
      pushFrame(threadId, frameTextContent(mid, '收到，正在处理。'))
    }
    pushFrame(threadId, frameTextEnd(mid))

    // 4) P1-B3 todos 多帧（updated → completed 两次快照,触发原位 upsert）
    if (withTodos) {
      const itemsInitial = [
        { text: '解析画布项目数据', completed: false },
        { text: '生成工作流参数', completed: false },
        { text: '提交执行并等待结果', completed: false },
        { text: '回填产物到画布', completed: false },
      ]
      const itemsDone = itemsInitial.map((it) => ({ ...it, completed: true }))
      pushFrame(threadId, frameCustom('todos', { runId, items: itemsInitial }))
      pushFrame(threadId, frameCustom('todos', { runId, items: itemsDone }))
    }

    // 5) B1 approval：发出 tool_approval_required;RUN_FINISHED 推迟到 interaction-response 之后
    if (withApproval || withEditArgs) {
      const requestId = 'req-' + Math.random().toString(36).slice(2, 8)
      const args = withEditArgs
        ? { templateId: 'portrait_lora', count: 4, seed: 42, customParam: '可编辑' }
        : { templateId: 'portrait_lora', count: 1 }
      pendingApprovals.set(requestId, {
        threadId,
        runId,
        toolName: 'wb_execute_template',
        args,
      })
      pushFrame(
        threadId,
        frameCustom('tool_approval_required', {
          requestId,
          threadId,
          toolName: 'wb_execute_template',
          toolTier: 'execution',
          risk: 'write+side-effect',
          args, // C15 契约:卡片读 value.args(后端 toolApprovalRequiredValue 同形)
        }),
      )
      // 不在此处推 RUN_FINISHED；interaction-response 触发 resolved 后再推收尾
      return
    }

    // 6a) W4 wb_artifact 产物卡:CUSTOM wb_artifact{outputFiles} → applyExecutionSideEffect 'artifact' 渲染缩略图
    if (withArtifacts) {
      const files = [
        { filename: 'w4-result-1.png', subfolder: 'w4', type: 'output' },
        { filename: 'w4-result-2.png', subfolder: 'w4', type: 'output' },
      ]
      pushFrame(
        threadId,
        frameCustom('wb_artifact', {
          promptId: 'p-' + Math.random().toString(36).slice(2, 8),
          name: 'portrait_lora',
          outputs: files.map((f) => f.filename),
          outputFiles: files,
        }),
      )
    }

    // 6b) W5 wb_error 错误气泡:CUSTOM wb_error → applyCustom 'wb_error' 推 kind:'error'
    if (withError) {
      pushFrame(
        threadId,
        frameCustom('wb_error', {
          itemId: 'e-' + Math.random().toString(36).slice(2, 8),
          message: '执行失败：模型推理超时（stub 演示）',
        }),
      )
    }

    // 7) W7 截断回归:不推 RUN_FINISHED,帧队列清空后 close → 前端 finally 推 workbenchStreamInterrupted
    if (withTruncate) {
      const t = threads.get(threadId)
      if (t) t.truncateAfterFlush = true
      return
    }

    // 8) 收尾 RUN_FINISHED
    pushFrame(threadId, frameRunFinished(threadId, runId))
  }

  // ============ HTTP 响应辅助 ============
  function jsonResp(body, status) {
    return new Response(JSON.stringify(body), {
      status: status || 200,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  // ============ fetch 拦截 ============
  const origFetch = window.fetch.bind(window)

  window.fetch = async function (input, init) {
    const url = typeof input === 'string' ? input : input.url
    const u = new URL(url, ORIGIN)
    const p = u.pathname
    const m = (init?.method || 'GET').toUpperCase()
    const route = m + ' ' + p.replace(/^\/workbench/, '')

    // 列表类端点统一包 {data:[...]}（index.vue:1363/1376/1384/3088/3344 均
    // 用 `json?.data ?? []` 反序列化,与后端 OkEnvelope 同构）。
    function listResp(arr) { return jsonResp({ data: arr }) }

    if (route === 'GET /api/workbench/sessions') {
      const archived = u.searchParams.get('archived') === 'true'
      return listResp(sessions.filter((s) => s.archived === archived))
    }
    if (route === 'POST /api/workbench/sessions/create') {
      const body = init?.body ? JSON.parse(init.body) : {}
      const s = {
        id: 's-' + (nextId++),
        title: body.title || '新会话',
        archived: false,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        threadId: body.threadId || ('t-' + Date.now()),
        messages: [],
      }
      sessions.unshift(s)
      persist()
      return jsonResp(s)
    }
    if (route === 'POST /api/workbench/sessions/update') {
      const body = init?.body ? JSON.parse(init.body) : {}
      const idx = sessions.findIndex((s) => s.id === body.id)
      if (idx >= 0) Object.assign(sessions[idx], body, { updatedAt: Date.now() })
      persist()
      return jsonResp({ ok: true })
    }
    if (route === 'POST /api/workbench/sessions/delete') {
      const body = init?.body ? JSON.parse(init.body) : {}
      sessions = sessions.filter((s) => s.id !== body.id)
      persist()
      return jsonResp({ ok: true })
    }
    if (m === 'GET' && p.startsWith('/api/workbench/session/')) {
      const id = p.replace('/api/workbench/session/', '')
      const s = sessions.find((x) => x.id === id)
      // OkEnvelope:selectSession 读 json.success + json.data(index.vue:1396-1402)
      return jsonResp(s ? { success: true, data: s } : { success: false })
    }
    if (route === 'GET /api/workbench/presets') return listResp([])
    if (route === 'GET /api/workbench/skills') return listResp([])
    if (route === 'GET /api/workbench/templates') return listResp([])

    if (route === 'POST /api/workbench/agent/run') {
      const body = init?.body ? JSON.parse(init.body) : {}
      const runId = body.runId || 'r-' + Date.now()
      const threadId = body.threadId || 't-stub'
      console.log('[workbench-stub] run request', {
        runId,
        threadId,
        approvalMode: body.approvalMode,
        reasoningEffort: body.reasoningEffort,
        inputPreview: String(body.input || '').slice(0, 60),
      })
      // W6:用户消息落 legacy session.messages(真实后端 decide() 同语义)——
      // loadHistoryIntoPage 靠它把用户气泡按 createdAt 归并回放
      const s = sessions.find((x) => x.id === threadId)
      if (s) {
        s.messages = s.messages || []
        s.messages.push({
          role: 'user',
          kind: 'chat',
          text: String(body.input || ''),
          createdAt: Date.now(),
        })
        persist()
      }
      const stream = makeStream(threadId, INTERVAL_MS)
      // 同步起脚本：先把事件塞入队列,再让 flush 循环消费
      script(threadId, runId, body.input)
      return new Response(stream, {
        headers: {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        },
      })
    }

    if (route === 'POST /api/workbench/agent/interaction-response') {
      const body = init?.body ? JSON.parse(init.body) : {}
      const pending = pendingApprovals.get(body.requestId)
      // W8 edit args：原始 args 与前端传入的 args 一起打日志,便于 agent-browser eval 对比透传
      console.log('[workbench-stub] interaction-response', {
        requestId: body.requestId,
        action: body.action,
        echoArgs: body.args || null,
        originalArgs: pending ? pending.args : null,
      })
      if (pending) {
        pendingApprovals.delete(body.requestId)
        // approve/edit 都是放行语义（aguiBridge.js L695）;只有 reject 才不算 approved
        const approved = body.action === 'approve' || body.action === 'edit'
        pushFrame(
          pending.threadId,
          frameCustom('tool_approval_resolved', {
            requestId: body.requestId,
            threadId: pending.threadId,
            toolName: pending.toolName,
            approved,
            finalAction: body.action,
            finalArgs: body.action === 'edit' ? body.args || null : null,
          }),
        )
        // 审批解决后追加一段简短结果文本 + RUN_FINISHED 收尾
        const mid = 'm-resp-' + Math.random().toString(36).slice(2, 8)
        pushFrame(pending.threadId, frameTextStart(mid))
        pushFrame(
          pending.threadId,
          frameTextContent(
            mid,
            approved
              ? body.action === 'edit'
                ? '参数已编辑，按新参数放行。'
                : '已审批通过,继续执行。'
              : '已拒绝,本轮终止。',
          ),
        )
        pushFrame(pending.threadId, frameTextEnd(mid))
        pushFrame(pending.threadId, frameRunFinished(pending.threadId, pending.runId))
      }
      return jsonResp({ ok: true })
    }

    if (route === 'POST /api/workbench/agent/cancel') return jsonResp({ ok: true })
    if (route === 'POST /api/workbench/agent/threads/messages') {
      // W6 历史回放:实时流推送时同步入 eventsHistory,直接返回该 threadId 的所有 records
      const body = init?.body ? JSON.parse(init.body) : {}
      const arr = eventsHistory.get(body.threadId) || []
      return jsonResp({ data: { records: arr } })
    }

    // /view?filename=...&subfolder=...&type=... —— W4 产物缩略图占位图（1x1 PNG）
    // 真实后端经 routes/proxy.ts 转发到 ComfyUI /view;stub 返一张最小 PNG 防 404 噪声
    if (route === 'GET /view') {
      const png = Uint8Array.from(atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='
      ), (c) => c.charCodeAt(0))
      return new Response(png, { headers: { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=300' } })
    }

    console.warn('[workbench-stub] unmocked', route)
    return origFetch(input, init)
  }

  window.__wbCtl = {
    reset() { location.reload() },
    get sessions() { return sessions },
    get pendingApprovals() { return pendingApprovals },
    get threads() { return threads },
    get eventsHistory() { return eventsHistory },
    // 验收用：捕获 stub 内 console.log + warn 文本,前端 eval 可读
    get logs() { return window.__stubLogs || (window.__stubLogs = []) },
    clearLogs() { if (window.__stubLogs) window.__stubLogs.splice(0) },
  }
  // 同步 console.log/warn 到 window.__stubLogs（验收回归与 agent-browser eval 抓取）
  ;(function patchLogs() {
    const buf = (window.__stubLogs = window.__stubLogs || [])
    const wrap = (orig) => function (...args) {
      try {
        buf.push(
          args
            .map((a) => (typeof a === 'object' && a !== null ? JSON.stringify(a) : String(a)))
            .join(' '),
        )
        if (buf.length > 200) buf.shift()
      } catch { /* ignore */ }
      return orig.apply(console, args)
    }
    console.log = wrap(console.log)
    console.warn = wrap(console.warn)
  })()
  console.log('[workbench-stub] installed; sessions seeded:', sessions.length)
})()