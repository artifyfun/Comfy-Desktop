// @vitest-environment happy-dom
// __tests__/interactionApprovalCard.test.js — C15 HITL 审批卡单测
// 覆盖:pending 三按钮 emit 正确载荷 / edit 流(展开→合法 JSON emit edit+args→
// 非法 JSON 不 emit 且显示错误)/ 倒计时 fake timers 推进到 0 展示 expired /
// 终态渲染无按钮 / 卸载后定时器清理。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import InteractionApprovalCard from '../InteractionApprovalCard.vue'

/** C14 toolApprovalRequiredValue 的代表性 value 形状 */
const approval = (over = {}) => ({
  interactionId: 'req-1',
  mode: 'sameflow',
  toolCalls: [
    {
      toolCallId: 'req-1',
      toolCallName: 'wb_execute_template',
      arguments: JSON.stringify({ templateId: 'tpl-9' }),
    },
  ],
  requestId: 'req-1',
  threadId: 'thread-1',
  toolName: 'wb_execute_template',
  args: { templateId: 'tpl-9' },
  timeoutMs: 10 * 60 * 1000,
  ...over,
})

const mountCard = (props, extra = {}) =>
  mount(InteractionApprovalCard, { props: { approval: approval(), ...props }, ...extra })

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('InteractionApprovalCard — pending 渲染', () => {
  it('pending:amber 警示条 + 工具名友好化 + 倒计时展示 mm:ss', () => {
    const w = mountCard({ status: 'pending' })
    expect(w.find('[data-testid="approval-card"]').classes()).toContain('border-amber-500/40')
    expect(w.find('[data-testid="approval-tool-name"]').text()).toBe('执行模板')
    // 原始名保留在 title(对齐 ToolCallCard 约定)
    expect(w.find('[data-testid="approval-tool-name"]').attributes('title')).toBe(
      'wb_execute_template',
    )
    // 10min 预算起算
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('10:00')
    // 三按钮齐备
    expect(w.find('[data-testid="approval-approve"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-reject"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-edit"]').exists()).toBe(true)
  })

  it('args 默认折叠,展开后 JSON 美化;再次点击收起', async () => {
    const w = mountCard({})
    expect(w.find('[data-testid="approval-args"]').exists()).toBe(false)
    await w.find('[data-testid="approval-args-toggle"]').trigger('click')
    const argsText = w.find('[data-testid="approval-args"]').text()
    expect(argsText).toContain('"templateId": "tpl-9"')
    expect(argsText).toContain('\n')
    await w.find('[data-testid="approval-args-toggle"]').trigger('click')
    expect(w.find('[data-testid="approval-args"]').exists()).toBe(false)
  })

  it('未知工具名原样展示(wb_* 未入友好表),原始名同 title', () => {
    const w = mountCard({ approval: approval({ toolName: 'wb_future_tool' }) })
    expect(w.find('[data-testid="approval-tool-name"]').text()).toBe('wb_future_tool')
    expect(w.find('[data-testid="approval-tool-name"]').attributes('title')).toBe('wb_future_tool')
  })

  it('status 缺省按 pending 处理', () => {
    const w = mountCard()
    expect(w.find('[data-testid="approval-approve"]').exists()).toBe(true)
  })
})

describe('InteractionApprovalCard — 三按钮 emit 载荷', () => {
  it('批准:emit respond({ action: "approve" }),不带 args', async () => {
    const w = mountCard({})
    await w.find('[data-testid="approval-approve"]').trigger('click')
    expect(w.emitted('respond')).toEqual([[{ action: 'approve' }]])
  })

  it('拒绝:emit respond({ action: "reject" }),不带 args', async () => {
    const w = mountCard({})
    await w.find('[data-testid="approval-reject"]').trigger('click')
    expect(w.emitted('respond')).toEqual([[{ action: 'reject' }]])
  })
})

describe('InteractionApprovalCard — edit 流', () => {
  it('修改参数展开 textarea 预填美化 JSON;合法 JSON emit edit + 解析后对象', async () => {
    const w = mountCard({})
    // 初始无 edit 面板、无错误
    expect(w.find('[data-testid="approval-edit-textarea"]').exists()).toBe(false)
    expect(w.find('[data-testid="approval-error"]').exists()).toBe(false)

    await w.find('[data-testid="approval-edit"]').trigger('click')
    const textarea = w.find('[data-testid="approval-edit-textarea"]')
    expect(textarea.exists()).toBe(true)
    // 预填 JSON.stringify(args, null, 2)
    expect(textarea.element.value).toBe('{\n  "templateId": "tpl-9"\n}')

    await textarea.setValue('{ "templateId": "tpl-9", "inputs": { "seed": 42 } }')
    await w.find('[data-testid="approval-edit-submit"]').trigger('click')
    expect(w.emitted('respond')).toEqual([
      [{ action: 'edit', args: { templateId: 'tpl-9', inputs: { seed: 42 } } }],
    ])
    // 提交后面板收起
    expect(w.find('[data-testid="approval-edit-textarea"]').exists()).toBe(false)
  })

  it('非法 JSON:不 emit,行内红字错误,面板保留可改后重试', async () => {
    const w = mountCard({})
    await w.find('[data-testid="approval-edit"]').trigger('click')
    await w.find('[data-testid="approval-edit-textarea"]').setValue('{ broken json !!')
    await w.find('[data-testid="approval-edit-submit"]').trigger('click')

    expect(w.emitted('respond')).toBeUndefined()
    const err = w.find('[data-testid="approval-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('JSON')
    expect(w.find('[data-testid="approval-edit-textarea"]').exists()).toBe(true)

    // 修正后重试成功
    await w.find('[data-testid="approval-edit-textarea"]').setValue('{ "ok": true }')
    await w.find('[data-testid="approval-edit-submit"]').trigger('click')
    expect(w.emitted('respond')).toEqual([[{ action: 'edit', args: { ok: true } }]])
    expect(w.find('[data-testid="approval-error"]').exists()).toBe(false)
  })

  it('合法 JSON 但顶层非对象(数组/标量/null):不 emit,错误提示', async () => {
    for (const bad of ['[1, 2]', '"str"', '42', 'null']) {
      const w = mountCard({})
      await w.find('[data-testid="approval-edit"]').trigger('click')
      await w.find('[data-testid="approval-edit-textarea"]').setValue(bad)
      await w.find('[data-testid="approval-edit-submit"]').trigger('click')
      expect(w.emitted('respond'), bad).toBeUndefined()
      expect(w.find('[data-testid="approval-error"]').exists()).toBe(true)
    }
  })

  it('取消编辑:面板收起且不 emit', async () => {
    const w = mountCard({})
    await w.find('[data-testid="approval-edit"]').trigger('click')
    await w.find('[data-testid="approval-edit-cancel"]').trigger('click')
    expect(w.find('[data-testid="approval-edit-textarea"]').exists()).toBe(false)
    expect(w.emitted('respond')).toBeUndefined()
  })
})

describe('InteractionApprovalCard — 倒计时(fake timers)', () => {
  it('每秒递减,60s 内转红色警示', async () => {
    const w = mountCard({ status: 'pending', approval: approval({ timeoutMs: 90 * 1000 }) })
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('01:30')
    await vi.advanceTimersByTimeAsync(30 * 1000)
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('01:00')
    expect(w.find('[data-testid="approval-countdown"]').classes()).toContain('text-red-300')
  })

  it('推进到 0:视觉转 expired 提示、按钮禁用,但不自动 emit reject', async () => {
    const w = mountCard({ status: 'pending', approval: approval({ timeoutMs: 3 * 1000 }) })
    await vi.advanceTimersByTimeAsync(3 * 1000)

    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('00:00')
    expect(w.find('[data-testid="approval-expired"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-approve"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="approval-reject"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="approval-edit"]').attributes('disabled')).toBeDefined()
    // 后端超时已兜底,前端不代发 reject
    expect(w.emitted('respond')).toBeUndefined()

    // 继续推进不再变化(定时器已停)
    await vi.advanceTimersByTimeAsync(10 * 1000)
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('00:00')
  })

  it('timeoutMs 缺失/非法:直接到 0 态但不挂定时器、不误报超时警示', () => {
    const w = mountCard({ approval: approval({ timeoutMs: undefined }) })
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('00:00')
    // timeoutMs 缺失时无后端预算信息,不渲染超时提示条
    expect(w.find('[data-testid="approval-expired"]').exists()).toBe(false)
  })
})

describe('InteractionApprovalCard — 终态', () => {
  it.each([
    ['approved', '已批准', 'border-emerald-500/50'],
    ['rejected', '已拒绝', 'border-red-500/50'],
    ['expired', '已超时', 'border-amber-500/50'],
  ])('%s:紧凑单行结果条,无按钮无倒计时', (status, label) => {
    const w = mountCard({ status })
    const card = w.find('[data-testid="approval-card"]')
    // 非 amber 警示条(切回中性描边)
    expect(card.classes()).not.toContain('border-amber-500/40')
    expect(w.find('[data-testid="approval-result"]').exists()).toBe(true)
    expect(w.find('[data-testid="approval-result"]').text()).toContain(label)
    expect(w.find('[data-testid="approval-tool-name"]').exists()).toBe(false)
    expect(w.find('[data-testid="approval-countdown"]').exists()).toBe(false)
    for (const id of ['approval-approve', 'approval-reject', 'approval-edit']) {
      expect(w.find(`[data-testid="${id}"]`).exists()).toBe(false)
    }
  })
})

describe('InteractionApprovalCard — 生命周期', () => {
  it('卸载后清理 setInterval(advanceTimersByTime 不再触发 tick)', async () => {
    const w = mountCard({ approval: approval({ timeoutMs: 60 * 1000 }) })
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('01:00')
    w.unmount()
    await vi.advanceTimersByTimeAsync(60 * 1000)
    // 无活动定时器即无事发生;若有泄漏 fake timers 会在无挂载组件上抛错
    expect(vi.getTimerCount()).toBe(0)
  })

  it('approval 变化(requestId 不同):倒计时重置为新请求预算', async () => {
    const w = mount(InteractionApprovalCard, {
      props: { status: 'pending', approval: approval({ requestId: 'req-1', timeoutMs: 30 * 1000 }) },
    })
    await vi.advanceTimersByTimeAsync(10 * 1000)
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('00:20')

    await w.setProps({ approval: approval({ requestId: 'req-2', timeoutMs: 5 * 60 * 1000 }) })
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('05:00')
    // 旧定时器已清,新预算照常走
    await vi.advanceTimersByTimeAsync(5 * 1000)
    expect(w.find('[data-testid="approval-countdown"]').text()).toBe('04:55')
  })
})
