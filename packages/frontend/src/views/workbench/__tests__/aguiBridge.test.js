// views/workbench/__tests__/aguiBridge.test.js — AG-UI 桥测试（C11 消费侧验收）
// 覆盖：emit 序列 → 页面消息模型（codex 形状 toolItem 合成）/ CUSTOM 分派 /
// 停止与错误收尾 / 历史回放与实时 emit 序列同构（同一 emit 映射层，逐条对比）。
// legacy 灰度开关(?ng=/sessionStorage)已随 legacy 管线一并删除。
// @vitest-environment happy-dom
import { describe, expect, it, beforeEach, vi } from 'vitest'
import { synthToolItem, freshRunState, createPageEmit } from '../aguiBridge'
import { createHandlerContext, dispatch } from '@/utils/agui/handlers'

// ── 页面适配器桩：收口 pushMsg/_key/turnId，行为对齐 index.vue 真实实现 ──
function makePageApi() {
  let keySeq = 0
  let turnSeq = 0
  const api = {
    origin: { value: 'http://test' },
    t: (k) => `i18n:${k}`,
    messages: { value: [] },
    busy: { value: false },
    stopping: { value: false },
    threadId: 'th-1',
    pushMsg(m) {
      const msg = { ...m, _key: `k${++keySeq}` }
      if (msg.role === 'agent' && msg.turnId === undefined) msg.turnId = turnSeq
      api.messages.value.push(msg)
      return msg
    },
    nextTurn: () => ++turnSeq,
    scrollToBottom: vi.fn(),
    isStopCancelled: (e) =>
      api.stopping.value &&
      (e?.name === 'AbortError' || /cancel|abort/i.test(String(e?.message || e))),
    getThreadId: () => api.threadId,
  }
  return api
}

/** 按 handlers.js emit 契约驱动一轮（与 store.bindStream 同一 dispatch 层） */
function feed(events, pageApi, state) {
  const ctx = createHandlerContext(createPageEmit(pageApi, state))
  for (const ev of events) dispatch(ctx, ev)
}

describe('aguiBridge — synthToolItem（codex 形状反向合成）', () => {
  it('shell → command_execution：command/aggregated_output/exit_code', () => {
    const running = synthToolItem('t1', 'shell', '{"command":"ls -la"}', null, false)
    expect(running).toMatchObject({
      id: 't1',
      type: 'command_execution',
      command: 'ls -la',
      status: 'in_progress',
    })
    expect(running.exit_code).toBeUndefined()
    const done = synthToolItem('t1', 'shell', '{"command":"ls -la"}', 'file-a\nfile-b', true)
    expect(done).toMatchObject({
      status: 'completed',
      command: 'ls -la',
      aggregated_output: 'file-a\nfile-b',
      exit_code: 0,
    })
  })
  it('file_change → changes 数组原位', () => {
    const item = synthToolItem('t2', 'file_change', '{"changes":[{"path":"a.js"}]}', null, true)
    expect(item).toMatchObject({
      type: 'file_change',
      changes: [{ path: 'a.js' }],
      status: 'completed',
    })
  })
  it('web_search → query 原位', () => {
    const item = synthToolItem('t3', 'web_search', '{"query":"ag-ui 协议"}', null, false)
    expect(item).toMatchObject({ type: 'web_search', query: 'ag-ui 协议', status: 'in_progress' })
  })
  it('wb_* / mcp 名 → mcp_tool_call：server/tool/arguments/result', () => {
    const done = synthToolItem(
      't4',
      'wb_gen_image',
      '{"params":{"prompt":"cat"}}',
      '{"ok":true}',
      true,
    )
    expect(done).toMatchObject({
      type: 'mcp_tool_call',
      server: 'workbench',
      tool: 'wb_gen_image',
      arguments: { params: { prompt: 'cat' } },
      result: { ok: true },
    })
  })
  it('result 非 JSON 时降级 {raw}', () => {
    const item = synthToolItem('t5', 'wb_thing', '{}', 'plain text', true)
    expect(item.result).toEqual({ raw: 'plain text' })
  })
})

describe('aguiBridge — emit 序列 → 页面消息模型', () => {
  let pageApi, state
  beforeEach(() => {
    pageApi = makePageApi()
    state = freshRunState()
  })

  it('用户气泡 + 进度气泡被首个 delta 收掉，文本按 messageId 单行累积', () => {
    const tid = pageApi.nextTurn()
    pageApi.pushMsg({ role: 'user', kind: 'chat', text: '画只猫', turnId: tid, createdAt: 1 })
    const prog = pageApi.pushMsg({
      role: 'agent',
      kind: 'progress',
      text: 'deciding',
      createdAt: 2,
    })
    state.progressKey = prog._key
    feed(
      [
        { type: 'RUN_STARTED' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '好的' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '，开始' },
        { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
        { type: 'RUN_FINISHED' },
      ],
      pageApi,
      state,
    )
    expect(pageApi.messages.value).toHaveLength(2) // 进度气泡已消失
    const reply = pageApi.messages.value[1]
    expect(reply).toMatchObject({ role: 'agent', kind: 'chat', text: '好的，开始' })
    expect(reply.turnId).toBe(tid)
  })

  it('两个 messageId 各占一行，互不串行', () => {
    feed(
      [
        { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'A1' },
        { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'B1' },
        { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'A2' },
      ],
      pageApi,
      state,
    )
    const texts = pageApi.messages.value.map((m) => m.text)
    expect(texts).toEqual(['A1A2', 'B1'])
  })

  it('reasoning → tool_item(reasoning) 行，前缀 delta 累积、end 置 completed', () => {
    feed(
      [
        { type: 'REASONING_MESSAGE_START', messageId: 'r1' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '先想想' },
        { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '再动手' },
        { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
      ],
      pageApi,
      state,
    )
    expect(pageApi.messages.value).toHaveLength(1)
    const m = pageApi.messages.value[0]
    expect(m.kind).toBe('tool_item')
    expect(m.toolItem).toMatchObject({
      id: 'r1',
      type: 'reasoning',
      text: '先想想再动手',
      status: 'completed',
    })
  })

  it('tool:start→args→result：原位 upsert 为 codex 形状，缺 args 的 start 先占行', () => {
    feed(
      [
        { type: 'TOOL_CALL_START', toolCallId: 't9', toolCallName: 'shell' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't9', delta: '{"command":' },
        { type: 'TOOL_CALL_ARGS', toolCallId: 't9', delta: '"npm test"}' },
        { type: 'TOOL_CALL_END', toolCallId: 't9' },
        { type: 'TOOL_CALL_RESULT', toolCallId: 't9', content: 'all green' },
      ],
      pageApi,
      state,
    )
    expect(pageApi.messages.value).toHaveLength(1) // 三次事件都是同一行原位更新
    const m = pageApi.messages.value[0]
    expect(m.kind).toBe('tool_item')
    expect(m.toolItem).toMatchObject({
      id: 't9',
      type: 'command_execution',
      command: 'npm test',
      aggregated_output: 'all green',
      exit_code: 0,
      status: 'completed',
    })
  })

  it('wb_plan CUSTOM → 现有计划卡路径（kind:card + plan），并收掉进度气泡', () => {
    const prog = pageApi.pushMsg({
      role: 'agent',
      kind: 'progress',
      text: 'deciding',
      createdAt: 1,
    })
    state.progressKey = prog._key
    feed(
      [
        {
          type: 'CUSTOM',
          name: 'wb_plan',
          value: { plan: { intent: 'image', batch: [], params: { prompt: 'cat' } } },
        },
      ],
      pageApi,
      state,
    )
    expect(pageApi.messages.value).toHaveLength(1)
    const m = pageApi.messages.value[0]
    expect(m.kind).toBe('card')
    expect(m.plan).toEqual({ intent: 'image', batch: [], params: { prompt: 'cat' } })
  })

  it('wb_plan 裸 plan 值也接受（无 {plan} 包裹）', () => {
    feed([{ type: 'CUSTOM', name: 'wb_plan', value: { intent: 'chat' } }], pageApi, state)
    expect(pageApi.messages.value[0].plan).toEqual({ intent: 'chat' })
  })

  it('todos CUSTOM → todo_list 条目；wb_error CUSTOM → 错误气泡；未知 CUSTOM 忽略', () => {
    feed(
      [
        { type: 'CUSTOM', name: 'todos', value: { items: [{ text: 'a', done: false }] } },
        { type: 'CUSTOM', name: 'wb_error', value: { itemId: 'x', message: '生成失败' } },
        { type: 'CUSTOM', name: 'keepalive', value: {} },
        { type: 'CUSTOM', name: 'wb_artifact', value: { promptId: 'p1' } }, // 后端暂未下发，前向兼容
      ],
      pageApi,
      state,
    )
    const kinds = pageApi.messages.value.map((m) => m.kind)
    expect(kinds).toEqual(['tool_item', 'error'])
    expect(pageApi.messages.value[0].toolItem).toMatchObject({ type: 'todo_list' })
    expect(pageApi.messages.value[1].text).toBe('生成失败')
  })

  it('RUN_ERROR → 错误气泡并收掉进度气泡', () => {
    const prog = pageApi.pushMsg({
      role: 'agent',
      kind: 'progress',
      text: 'deciding',
      createdAt: 1,
    })
    state.progressKey = prog._key
    feed([{ type: 'RUN_ERROR', message: '上游超时', code: 'timeout' }], pageApi, state)
    expect(pageApi.messages.value).toHaveLength(1)
    expect(pageApi.messages.value[0]).toMatchObject({ kind: 'error', text: '上游超时' })
  })
})

describe('aguiBridge — todos runId 原位 upsert（P1-B3）', () => {
  it('同 runId updated/completed 多帧 → 单条 todo_list 卡原位翻新，不重复占行', () => {
    const pageApi = makePageApi()
    feed(
      [
        {
          type: 'CUSTOM',
          name: 'todos',
          value: {
            runId: 'r-1',
            items: [
              { text: '选模板', completed: true },
              { text: '执行', completed: false },
            ],
          },
        },
        {
          type: 'CUSTOM',
          name: 'todos',
          value: {
            runId: 'r-1',
            items: [
              { text: '选模板', completed: true },
              { text: '执行', completed: true },
            ],
          },
        },
      ],
      pageApi,
      freshRunState(),
    )
    expect(pageApi.messages.value).toHaveLength(1) // 两帧收敛为一卡
    const m = pageApi.messages.value[0]
    expect(m.toolItem.type).toBe('todo_list')
    expect(m.toolItem.id).toBe('todos:r-1') // per-run 稳定 id
    expect(m.toolItem.items).toEqual([
      { text: '选模板', completed: true },
      { text: '执行', completed: true },
    ])
    expect(m.toolItem.status).toBe('completed') // 全勾 → 终态
  })

  it('回放态多 run 各成一张卡；部分勾选时 status=in_progress', () => {
    const pageApi = makePageApi()
    feed(
      [
        {
          type: 'CUSTOM',
          name: 'todos',
          value: { runId: 'r-1', items: [{ text: 'A', completed: false }] },
        },
        {
          type: 'CUSTOM',
          name: 'todos',
          value: { runId: 'r-2', items: [{ text: 'B', completed: false }] },
        },
        {
          type: 'CUSTOM',
          name: 'todos',
          value: { runId: 'r-1', items: [{ text: 'A', completed: true }] },
        },
      ],
      pageApi,
      freshRunState(),
    )
    expect(pageApi.messages.value).toHaveLength(2)
    const [r1, r2] = pageApi.messages.value
    expect(r1.toolItem.items).toEqual([{ text: 'A', completed: true }])
    expect(r1.toolItem.status).toBe('completed')
    expect(r2.toolItem.items).toEqual([{ text: 'B', completed: false }])
    expect(r2.toolItem.status).toBe('in_progress')
  })

  it('无 runId 旧载荷每次推新卡（既有行为不变，兼容降级）', () => {
    const pageApi = makePageApi()
    feed(
      [
        { type: 'CUSTOM', name: 'todos', value: { items: [{ text: 'a', done: false }] } },
        { type: 'CUSTOM', name: 'todos', value: { items: [{ text: 'b', done: false }] } },
      ],
      pageApi,
      freshRunState(),
    )
    expect(pageApi.messages.value).toHaveLength(2)
    expect(pageApi.messages.value.map((m) => m.toolItem.id)).toEqual(['todos:1', 'todos:2'])
  })

  it('空 items 快照不误标 completed（status 保持 in_progress）', () => {
    const pageApi = makePageApi()
    feed(
      [
        {
          type: 'CUSTOM',
          name: 'todos',
          value: { runId: 'r-3', items: [{ text: '起步', completed: true }] },
        },
        { type: 'CUSTOM', name: 'todos', value: { runId: 'r-3', items: [] } },
      ],
      pageApi,
      freshRunState(),
    )
    expect(pageApi.messages.value).toHaveLength(1)
    expect(pageApi.messages.value[0].toolItem.status).toBe('in_progress')
    expect(pageApi.messages.value[0].toolItem.items).toEqual([])
  })
})

describe('aguiBridge — 停止与错误收尾', () => {
  let abortNow = () => {}
  beforeEach(() => {
    // fetch 挂起，拒绝时机由测试显式控制（等价真实流被 abort 掐断的终态）
    let rejectFetch = () => {}
    abortNow = () => rejectFetch(new DOMException('The user aborted a request.', 'AbortError'))
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise((_, reject) => {
            rejectFetch = reject
          }),
      ),
    )
  })
  it('停止导致的中断不推错误气泡，停止气泡与进度收尾由 stopAgentRun 负责', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    const bridge = createAguiBridge(pageApi)
    const p = bridge.runAgentTurn('hi', [], { userBubble: 'hi' })
    await new Promise((r) => setTimeout(r, 0)) // 让 fetch 挂起、busy 置位
    expect(pageApi.busy.value).toBe(true)
    abortNow() // 模拟 stopAgentRun 的 ctl.abort 把流掐断成 AbortError
    await bridge.stopAgentRun() // 置 stopping（isStopCancelled 依赖）+ /agent/cancel + 收尾气泡
    await p
    // 用户气泡(chat) + 「已停止」chat 行；进度气泡已被收掉；无 error 气泡
    const kinds = pageApi.messages.value.map((m) => m.kind)
    expect(kinds).toEqual(['chat', 'chat'])
    expect(pageApi.messages.value[1].text).toBe('i18n:workbenchStopped')
    expect(pageApi.busy.value).toBe(false)
    vi.unstubAllGlobals()
  })
})

async function bridge_load(api, tid) {
  const { createAguiBridge } = await import('../aguiBridge')
  const b = createAguiBridge(api)
  return b.loadHistoryIntoPage(tid)
}

describe('aguiBridge — 历史回放与实时序列同构', () => {
  it('records → replayToMessages → 同一映射层，输出与实时 emit 序列逐条一致', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const { replayToMessages } = await import('@/utils/agui/historyReassembler')
    const AGUI_EVENTS = [
      { type: 'RUN_STARTED' },
      { type: 'REASONING_MESSAGE_START', messageId: 'r1' },
      { type: 'REASONING_MESSAGE_CONTENT', messageId: 'r1', delta: '思' },
      { type: 'REASONING_MESSAGE_END', messageId: 'r1' },
      { type: 'TOOL_CALL_START', toolCallId: 't1', toolCallName: 'shell' },
      { type: 'TOOL_CALL_ARGS', toolCallId: 't1', delta: '{"command":"pwd"}' },
      { type: 'TOOL_CALL_END', toolCallId: 't1' },
      { type: 'TOOL_CALL_RESULT', toolCallId: 't1', content: '/home' },
      { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '完成' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
      { type: 'RUN_FINISHED' },
    ]
    // 实时侧：同一 emit 映射层
    const liveApi = makePageApi()
    const liveState = freshRunState()
    feed(AGUI_EVENTS, liveApi, liveState)
    // 历史侧：B 线 threads/messages records 形状 → replayToMessages → 同一形状映射
    const records = AGUI_EVENTS.map((ev, i) => ({
      runId: 'r-1',
      seq: i + 1,
      eventType: ev.type,
      content: JSON.stringify(ev),
    }))
    const replayed = replayToMessages(records)
    expect(replayed.map((m) => m.kind)).toEqual(['reasoning', 'tool', 'text'])
    const histApi = makePageApi()
    const bridge = createAguiBridge(histApi)
    const spy = vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ data: { records } }),
        }),
      ),
    )
    await bridge.loadHistoryIntoPage('th-1')
    // 逐条同构：reasoning/tool_item/chat 形状与实时侧一致（toolItem codex 形状一致）
    const live = liveApi.messages.value.map((m) => ({
      kind: m.kind,
      text: m.text || '',
      tool: m.toolItem
        ? {
            id: m.toolItem.id,
            type: m.toolItem.type,
            text: m.toolItem.text,
            status: m.toolItem.status,
          }
        : null,
    }))
    const hist = histApi.messages.value.map((m) => ({
      kind: m.kind,
      text: m.text || '',
      tool: m.toolItem
        ? {
            id: m.toolItem.id,
            type: m.toolItem.type,
            text: m.toolItem.text,
            status: m.toolItem.status,
          }
        : null,
    }))
    expect(hist).toEqual(live)
    vi.unstubAllGlobals()
    void spy
  })

  it('竞态守卫：分页拉取期间切换会话（getThreadId 变了）→ 旧会话回放整体弃，messages 不被覆盖', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const api = makePageApi()
    // 页面已有新会话的消息（模拟先完成的那次切换）
    api.pushMsg({ role: 'user', kind: 'chat', text: 'new session msg', createdAt: 1 })
    let currentThread = 'th-old'
    api.getThreadId = () => currentThread
    const records = [
      { runId: 'r-1', seq: 1, eventType: 'TEXT_MESSAGE_START', content: JSON.stringify({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) },
      { runId: 'r-1', seq: 2, eventType: 'TEXT_MESSAGE_CONTENT', content: JSON.stringify({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: '旧会话内容' }) },
      { runId: 'r-1', seq: 3, eventType: 'TEXT_MESSAGE_END', content: JSON.stringify({ type: 'TEXT_MESSAGE_END', messageId: 'm1' }) },
      { runId: 'r-1', seq: 4, eventType: 'RUN_FINISHED', content: JSON.stringify({ type: 'RUN_FINISHED' }) },
    ]
    let calls = 0
    const spy = vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        calls++
        // 首页返回途中用户切走：getThreadId 变成 th-new
        currentThread = 'th-new'
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { records } }) })
      }),
    )
    await bridge_load(api, 'th-old')
    // 守卫生效：旧回放整体弃，页面仍只有新会话消息
    expect(api.messages.value.map((m) => m.text)).toEqual(['new session msg'])
    expect(calls).toBe(1)
    vi.unstubAllGlobals()
    void spy
  })

  it('竞态守卫：fetch 全部返回后才切走（终检路径）→ 同样弃', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const api = makePageApi()
    api.pushMsg({ role: 'user', kind: 'chat', text: 'kept', createdAt: 1 })
    let currentThread = 'th-old'
    api.getThreadId = () => currentThread
    const records = [
      { runId: 'r-1', seq: 1, eventType: 'RUN_STARTED', content: JSON.stringify({ type: 'RUN_STARTED' }) },
    ]
    const spy = vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { records } }) })),
    )
    // 在 json() resolve 后、messages 清空前切走——通过微任务注入
    const p = bridge_load(api, 'th-old')
    queueMicrotask(() => { currentThread = 'th-new' })
    await p
    expect(api.messages.value.map((m) => m.text)).toEqual(['kept'])
    vi.unstubAllGlobals()
    void spy
  })

  it('records 为空时静默保留 legacy session.messages（降级不覆盖）', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    pageApi.messages.value = [{ _key: 's0', role: 'agent', kind: 'chat', text: 'legacy 历史消息' }]
    const bridge = createAguiBridge(pageApi)
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({ ok: true, json: () => Promise.resolve({ data: { records: [] } }) }),
      ),
    )
    await bridge.loadHistoryIntoPage('th-1')
    expect(pageApi.messages.value).toHaveLength(1)
    expect(pageApi.messages.value[0].text).toBe('legacy 历史消息')
    vi.unstubAllGlobals()
  })
})

describe('aguiBridge — HITL 审批卡（C15 集成）', () => {
  const APPROVAL_VALUE = {
    interactionId: 'req-1',
    mode: 'sameflow',
    toolCalls: [
      { toolCallId: 'req-1', toolCallName: 'wb_execute_template', arguments: '{"wait":true}' },
    ],
    requestId: 'req-1',
    threadId: 'th-1',
    toolName: 'wb_execute_template',
    args: { wait: true },
    timeoutMs: 600000,
  }

  function feedApproval(pageApi) {
    feed(
      [{ type: 'CUSTOM', timestamp: 1, name: 'tool_approval_required', value: APPROVAL_VALUE }],
      pageApi,
      freshRunState(),
    )
    return pageApi.messages.value.find((m) => m.kind === 'approval')
  }

  it('tool_approval_required CUSTOM → kind:approval 消息(value 原样携带,pending 初态)', () => {
    const pageApi = makePageApi()
    const card = feedApproval(pageApi)
    expect(card).toBeTruthy()
    expect(card.approval.requestId).toBe('req-1')
    expect(card.approval.toolName).toBe('wb_execute_template')
    expect(card.approvalStatus).toBe('pending')
    expect(card.role).toBe('agent')
  })

  it('respondApproval:approve 成功后卡片翻 approved,POST 载荷正确', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    const bridge = createAguiBridge(pageApi)
    const card = feedApproval(pageApi)
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await bridge.respondApproval(card, { action: 'approve' })
    vi.unstubAllGlobals()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://test/api/workbench/agent/interaction-response')
    expect(JSON.parse(init.body)).toEqual({
      threadId: 'th-1',
      requestId: 'req-1',
      action: 'approve',
    })
    expect(card.approvalStatus).toBe('approved')
  })

  it('respondApproval:edit 带 args 成功翻 approved;失败保留 pending 并推错误气泡', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    const bridge = createAguiBridge(pageApi)
    const card = feedApproval(pageApi)
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 400,
        json: () => Promise.resolve({ message: 'bad args' }),
      })
      .mockResolvedValueOnce({ ok: true, json: () => Promise.resolve({ ok: true }) })
    vi.stubGlobal('fetch', fetchMock)
    await bridge.respondApproval(card, { action: 'edit', args: { wait: false } })
    expect(card.approvalStatus).toBe('pending') // 失败不翻转,可重试
    expect(pageApi.messages.value.at(-1).kind).toBe('error')
    await bridge.respondApproval(card, { action: 'edit', args: { wait: false } })
    const [, init2] = fetchMock.mock.calls[1]
    expect(JSON.parse(init2.body)).toEqual({
      threadId: 'th-1',
      requestId: 'req-1',
      action: 'edit',
      args: { wait: false },
    })
    expect(card.approvalStatus).toBe('approved') // edit = 按替换后参数放行
    vi.unstubAllGlobals()
  })

  it('respondApproval:reject 翻 rejected;无 requestId 的消息直接忽略', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    const bridge = createAguiBridge(pageApi)
    const card = feedApproval(pageApi)
    const fetchMock = vi.fn(() =>
      Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) }),
    )
    vi.stubGlobal('fetch', fetchMock)
    await bridge.respondApproval(card, { action: 'reject' })
    expect(card.approvalStatus).toBe('rejected')
    await bridge.respondApproval({ kind: 'approval', approval: {} }, { action: 'approve' })
    expect(fetchMock).toHaveBeenCalledTimes(1) // 缺 requestId 未发请求
    vi.unstubAllGlobals()
  })
})

describe('aguiBridge — 附件上行(C4 差异收敛)', () => {
  it('runAgentTurn POST body 携带 attachments(透传 decide);无附件时字段省略', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    const bridge = createAguiBridge(pageApi)
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('data: {"type":"RUN_FINISHED"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    const atts = [{ name: 'img.png', kind: 'image', filename: 'img.png', size: 10 }]
    await bridge.runAgentTurn('看图', atts, { userBubble: '看图' })
    const [url1, init1] = fetchMock.mock.calls[0]
    expect(url1).toBe('http://test/api/workbench/agent/run')
    expect(JSON.parse(init1.body)).toMatchObject({
      threadId: 'th-1',
      input: '看图',
      attachments: atts,
    })
    await bridge.runAgentTurn('无附件', [], {})
    const [, init2] = fetchMock.mock.calls[1]
    expect(JSON.parse(init2.body).attachments).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('runAgentTurn POST body 携带 approvalMode(B1 会话级审批模式);无 getter 时字段省略', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    pageApi.getApprovalMode = () => 'conservative'
    const bridge = createAguiBridge(pageApi)
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('data: {"type":"RUN_FINISHED"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await bridge.runAgentTurn('帮我生成', [], {})
    const [, init1] = fetchMock.mock.calls[0]
    expect(JSON.parse(init1.body).approvalMode).toBe('conservative')
    // 旧桩(无 getter)→ 字段被 JSON.stringify 省略,后端走默认 standard
    const legacy = createAguiBridge(makePageApi())
    await legacy.runAgentTurn('x', [], {})
    const [, init2] = fetchMock.mock.calls[1]
    expect(JSON.parse(init2.body).approvalMode).toBeUndefined()
    vi.unstubAllGlobals()
  })

  it('runAgentTurn POST body 携带 reasoningEffort(E1 推理强度);无 getter 时字段省略', async () => {
    const { createAguiBridge } = await import('../aguiBridge')
    const pageApi = makePageApi()
    pageApi.getReasoningEffort = () => 'high'
    const bridge = createAguiBridge(pageApi)
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        new Response('data: {"type":"RUN_FINISHED"}\n\n', {
          status: 200,
          headers: { 'Content-Type': 'text/event-stream' },
        }),
      ),
    )
    vi.stubGlobal('fetch', fetchMock)
    await bridge.runAgentTurn('优化这段流程', [], {})
    const [, init1] = fetchMock.mock.calls[0]
    expect(JSON.parse(init1.body).reasoningEffort).toBe('high')
    // 旧桩(无 getter)→ 字段被 JSON.stringify 省略,后端保持会话现状
    const legacy = createAguiBridge(makePageApi())
    await legacy.runAgentTurn('x', [], {})
    const [, init2] = fetchMock.mock.calls[1]
    expect(JSON.parse(init2.body).reasoningEffort).toBeUndefined()
    vi.unstubAllGlobals()
  })
})

describe('aguiBridge — STATE_DELTA /tokenUsage 接线', () => {
  function makePageApiWithSession() {
    const api = makePageApi()
    api.curSession = {
      value: {
        turnUsages: [
          {
            inputTokens: 10,
            cachedInputTokens: 0,
            outputTokens: 5,
            reasoningOutputTokens: 0,
            at: 1,
          },
        ],
      },
    }
    return api
  }

  it('tokenUsage replace patch → curSession.turnUsages 末位原位更新', () => {
    const pageApi = makePageApiWithSession()
    feed(
      [
        {
          type: 'STATE_DELTA',
          timestamp: 1,
          delta: [
            { op: 'replace', path: '/tokenUsage/inputTokens', value: 100 },
            { op: 'replace', path: '/tokenUsage/outputTokens', value: 50 },
            { op: 'replace', path: '/tokenUsage/cachedInputTokens', value: 20 },
            { op: 'replace', path: '/tokenUsage/reasoningOutputTokens', value: 8 },
          ],
        },
      ],
      pageApi,
      freshRunState(),
    )
    const u = pageApi.curSession.value.turnUsages
    expect(u).toHaveLength(1) // 原位更新,不追加
    expect(u[0]).toMatchObject({
      inputTokens: 100,
      outputTokens: 50,
      cachedInputTokens: 20,
      reasoningOutputTokens: 8,
    })
    expect(u[0].at).toBeGreaterThan(1) // touched → 刷新时间戳
  })

  it('部分键 patch 只改命中键;非法 delta/未知路径/无 curSession 均安全忽略', () => {
    const pageApi = makePageApiWithSession()
    feed(
      [
        {
          type: 'STATE_DELTA',
          timestamp: 1,
          delta: [{ op: 'replace', path: '/tokenUsage/inputTokens', value: 77 }],
        },
        { type: 'STATE_DELTA', timestamp: 2, delta: null },
        {
          type: 'STATE_DELTA',
          timestamp: 3,
          delta: [{ op: 'replace', path: '/other/thing', value: 1 }],
        },
      ],
      pageApi,
      freshRunState(),
    )
    expect(pageApi.curSession.value.turnUsages[0].inputTokens).toBe(77)
    expect(pageApi.curSession.value.turnUsages[0].outputTokens).toBe(5) // 未命中保持
    // 无 curSession:不抛错
    const bare = makePageApi()
    expect(() =>
      feed(
        [
          {
            type: 'STATE_DELTA',
            timestamp: 4,
            delta: [{ op: 'replace', path: '/tokenUsage/inputTokens', value: 9 }],
          },
        ],
        bare,
        freshRunState(),
      ),
    ).not.toThrow()
  })
})
