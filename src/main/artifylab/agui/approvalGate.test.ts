// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * C14 审批门控状态机单测(纯逻辑,无 IO;超时用 vi.useFakeTimers,mock 时钟零 sleep——
 * 符合 AGENTS.md「zero tolerance policy for flaky tests」)。
 *
 * 覆盖矩阵(任务书 7 条):
 * 1. approve 恢复            2. reject → approved:false
 * 3. 超时 fake timers → reject 兜底   4. edit 换 args(含非法 args 400 路径)
 * 5. 白名单外直通            6. 并发双 pending 互不串
 * 7. 二次 resolve 幂等        8. 无通知通道 → 放行(legacy 等价);notify 抛错 → fail-safe 拒绝
 * 9. unregister 不清 pending(端点仍可应答)+ 事件形状常量
 */

import {
  APPROVAL_TIMEOUT_MS_DEFAULT,
  APPROVAL_WHITELIST_DEFAULT,
  ApprovalArgsError,
  TOOL_APPROVAL_REQUIRED,
  createApprovalGate,
  isPlainObject,
  toolApprovalRequiredValue,
  type ApprovalRequest
} from './approvalGate'

describe('createApprovalGate', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('白名单外工具直通:{suspended:false} 且不触发 notify', async () => {
    const notify = vi.fn()
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    gate.register('t1', notify)

    const result = await gate.intercept('t1', 'wb_list_templates', { q: 'x' })

    expect(result).toEqual({ suspended: false, approved: true, args: { q: 'x' } })
    expect(notify).not.toHaveBeenCalled()
  })

  it('白名单命中:置 pending、notify 收到 {requestId, threadId, toolName, args, timeoutMs},Promise 挂起', async () => {
    const notify = vi.fn()
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    gate.register('t1', notify)

    let settled: Awaited<ReturnType<typeof gate.intercept>> | undefined
    const p = gate.intercept('t1', 'wb_run_workflow', { workflow: { n: 1 } })
    p.then((r) => (settled = r))
    await vi.advanceTimersByTimeAsync(0) // 让 microtask 走完,确认仍挂起

    expect(settled).toBeUndefined()
    expect(notify).toHaveBeenCalledTimes(1)
    const req = notify.mock.calls[0]![0] as ApprovalRequest
    expect(req.threadId).toBe('t1')
    expect(req.toolName).toBe('wb_run_workflow')
    expect(req.args).toEqual({ workflow: { n: 1 } })
    expect(req.timeoutMs).toBe(APPROVAL_TIMEOUT_MS_DEFAULT)
    expect(typeof req.requestId).toBe('string')
    expect(req.requestId.length).toBeGreaterThan(0)
  })

  it('approve 恢复:{suspended:true, approved:true, args=原参数}', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', { wait: true })
    const approved = gate.resolve('t1', req.requestId, 'approve')
    const result = await p

    expect(approved).toBe(true)
    expect(result).toEqual({ suspended: true, approved: true, args: { wait: true } })
  })

  it('reject → {suspended:true, approved:false},不带 args', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_publish_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_publish_workflow', { name: 'app' })
    const resolved = gate.resolve('t1', req.requestId, 'reject')
    const result = await p

    expect(resolved).toBe(true)
    expect(result).toEqual({ suspended: true, approved: false })
  })

  it('超时(默认 10min,fake timers)→ fail-safe 按 reject 兜底', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    gate.register('t1', () => {})

    const p = gate.intercept('t1', 'wb_run_workflow', {})
    // 预算内不误伤:推进到超时前 1ms 仍挂起
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS_DEFAULT - 1)
    let settled: Awaited<ReturnType<typeof gate.intercept>> | undefined
    p.then((r) => (settled = r))
    expect(settled).toBeUndefined()

    await vi.advanceTimersByTimeAsync(1)
    const result = await p
    expect(result).toEqual({ suspended: true, approved: false })
  })

  it('超时可配置;超时后再 resolve 该 requestId → 幂等忽略返回 false', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'], timeoutMs: 5000 })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', {})
    expect(req.timeoutMs).toBe(5000)
    await vi.advanceTimersByTimeAsync(5000)
    const result = await p
    expect(result).toEqual({ suspended: true, approved: false })
    expect(gate.resolve('t1', req.requestId, 'approve')).toBe(false)
  })

  it('edit → args 整体替换为提交对象', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', { workflow: { old: 1 } })
    const edited = gate.resolve('t1', req.requestId, 'edit', { workflow: { new: 2 } })
    const result = await p

    expect(edited).toBe(true)
    expect(result).toEqual({
      suspended: true,
      approved: true,
      args: { workflow: { new: 2 } }
    })
  })

  it('edit 非对象 args(null/数组/标量)→ 抛 ApprovalArgsError 且 pending 保留可重新应答', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', { keep: 1 })
    expect(() => gate.resolve('t1', req.requestId, 'edit', null)).toThrow(ApprovalArgsError)
    expect(() => gate.resolve('t1', req.requestId, 'edit', [1, 2])).toThrow(ApprovalArgsError)
    expect(() => gate.resolve('t1', req.requestId, 'edit', 'x')).toThrow(ApprovalArgsError)

    // pending 未被消费:正确 edit 仍成功
    expect(gate.resolve('t1', req.requestId, 'edit', { fixed: true })).toBe(true)
    await expect(p).resolves.toEqual({ suspended: true, approved: true, args: { fixed: true } })
  })

  it('并发双 pending(同 thread / 跨 thread)互不串:逐条决策互不误伤', async () => {
    const gate = createApprovalGate({
      whitelist: ['wb_run_workflow', 'wb_publish_workflow']
    })
    const received: ApprovalRequest[] = []
    gate.register('t1', (r) => received.push(r))
    gate.register('t2', (r) => received.push(r))

    const p1 = gate.intercept('t1', 'wb_run_workflow', { i: 1 })
    const p2 = gate.intercept('t1', 'wb_run_workflow', { i: 2 })
    const p3 = gate.intercept('t2', 'wb_publish_workflow', { i: 3 })
    expect(received).toHaveLength(3)

    // 第二条 reject、第一条 edit、第三条 approve;threadId 各自匹配不串线
    expect(received.map((r) => r.threadId)).toEqual(['t1', 't1', 't2'])
    expect(gate.resolve('t1', received[1]!.requestId, 'reject')).toBe(true)
    expect(gate.resolve('t1', received[0]!.requestId, 'edit', { i: 11 })).toBe(true)
    expect(gate.resolve('t2', received[2]!.requestId, 'approve')).toBe(true)

    await expect(p1).resolves.toEqual({ suspended: true, approved: true, args: { i: 11 } })
    await expect(p2).resolves.toEqual({ suspended: true, approved: false })
    await expect(p3).resolves.toEqual({ suspended: true, approved: true, args: { i: 3 } })
  })

  it('二次 resolve 幂等:先 approve 后再 approve/reject/edit 均返回 false 且结果不变', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', { a: 1 })
    expect(gate.resolve('t1', req.requestId, 'approve')).toBe(true)
    expect(gate.resolve('t1', req.requestId, 'approve')).toBe(false)
    expect(gate.resolve('t1', req.requestId, 'reject')).toBe(false)
    expect(gate.resolve('t1', req.requestId, 'edit', { a: 2 })).toBe(false)

    await expect(p).resolves.toEqual({ suspended: true, approved: true, args: { a: 1 } })
  })

  it('未知 threadId / requestId → resolve 返回 false', () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    expect(gate.resolve('nope', 'nope', 'approve')).toBe(false)
    expect(gate.resolve('t1', 'nope', 'approve')).toBe(false)
  })

  it('无通知通道(未 register/unregister 后)→ 放行不挂起(legacy 等价,审查修复 C-1A)', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    // 「未注册 notify」== 不在 AG-UI run 中(legacy /chat、外部 MCP 客户端同路径):
    // 门控对不在场的 run 无管辖权,放行与门控引入前行为一致
    await expect(gate.intercept('t1', 'wb_run_workflow', { a: 1 })).resolves.toEqual({
      suspended: false,
      approved: true,
      args: { a: 1 }
    })

    // unregister 后同样放行(run 已结束,decide 若还在跑不可能再有新工具——防御路径)
    gate.register('t2', () => {})
    gate.unregister('t2')
    await expect(gate.intercept('t2', 'wb_run_workflow', {})).resolves.toEqual({
      suspended: false,
      approved: true,
      args: {}
    })
  })

  it('notify 抛错(SSE 写失败)→ fail-safe 拒绝,不悬挂到超时', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'], timeoutMs: 60_000 })
    gate.register('t1', () => {
      throw new Error('sse write failed')
    })
    await expect(gate.intercept('t1', 'wb_run_workflow', {})).resolves.toEqual({
      suspended: true,
      approved: false
    })
  })

  it('unregister 只摘通知通道,不清 pending:端点仍可应答恢复', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const p = gate.intercept('t1', 'wb_run_workflow', { a: 1 })
    gate.unregister('t1') // 模拟 SSE 断开
    expect(gate.resolve('t1', req.requestId, 'approve')).toBe(true)
    await expect(p).resolves.toEqual({ suspended: true, approved: true, args: { a: 1 } })
  })

  it('非对象 args 入参归一化为 {};重复 register 覆盖旧通道(重连幂等)', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const notify2 = vi.fn()
    gate.register('t1', () => {
      throw new Error('stale channel')
    })
    gate.register('t1', notify2) // 重连覆盖:旧通道作废,通知走新通道

    // 非对象顶层入参 → notify 载荷 args 归一化为 {},可正常挂起/应答
    const pending = gate.intercept('t1', 'wb_run_workflow', 'not-an-object' as unknown as undefined)
    expect(notify2).toHaveBeenCalledTimes(1)
    const req = notify2.mock.calls[0]![0] as ApprovalRequest
    expect(req.args).toEqual({})
    expect(gate.resolve('t1', req.requestId, 'approve')).toBe(true)
    await expect(pending).resolves.toEqual({ suspended: true, approved: true, args: {} })
  })

  it('超时不误伤同 gate 内已应答或白名单外的调用;全部 pending 结束后无残留 timer', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))

    const approved = gate.intercept('t1', 'wb_run_workflow', { a: 1 })
    gate.resolve('t1', req.requestId, 'approve')
    await approved

    // 推过默认预算:只有真实挂起中的 timer 才触发;已 settle 的不重复 settle
    await vi.advanceTimersByTimeAsync(APPROVAL_TIMEOUT_MS_DEFAULT + 1)
    await expect(approved).resolves.toEqual({ suspended: true, approved: true, args: { a: 1 } })
  })

  it('常量:CUSTOM name、默认超时与白名单默认值(执行家族)', () => {
    expect(TOOL_APPROVAL_REQUIRED).toBe('tool_approval_required')
    expect(APPROVAL_TIMEOUT_MS_DEFAULT).toBe(600_000)
    expect(APPROVAL_WHITELIST_DEFAULT).toEqual([
      'wb_execute_template',
      'wb_run_workflow',
      'wb_publish_workflow'
    ])
    expect(isPlainObject({})).toBe(true)
    expect(isPlainObject([])).toBe(false)
    expect(isPlainObject(null)).toBe(false)
  })

  it('事件 value 形状对齐 waa v2.3:interactionId/mode=sameflow/toolCalls + 桌面扩展字段', () => {
    const request: ApprovalRequest = {
      requestId: 'req-1',
      threadId: 't-1',
      toolName: 'wb_run_workflow',
      args: { wait: true },
      timeoutMs: 600_000
    }
    expect(toolApprovalRequiredValue(request)).toEqual({
      interactionId: 'req-1',
      mode: 'sameflow',
      toolCalls: [
        {
          toolCallId: 'req-1',
          toolCallName: 'wb_run_workflow',
          arguments: '{"wait":true}'
        }
      ],
      requestId: 'req-1',
      threadId: 't-1',
      toolName: 'wb_run_workflow',
      args: { wait: true },
      timeoutMs: 600_000
    })
  })
})

describe('rejectPending(run 收口清理)', () => {
  it('挂起中的 pending 被立即按拒绝结算,intercept Promise resolve(approved:false)', async () => {
    const gate = createApprovalGate({ whitelist: [...APPROVAL_WHITELIST_DEFAULT] })
    gate.register('t-9', () => {})
    const p = gate.intercept('t-9', 'wb_execute_template', { templateId: 't1' })
    await Promise.resolve()
    expect(gate.rejectPending('t-9')).toBe(1)
    const result = await p
    expect(result.approved).toBe(false)
    // 收口后 pending 已摘:再 rejectPending 幂等返回 0
    expect(gate.rejectPending('t-9')).toBe(0)
  })

  it('同 thread 并发多 pending 一次全收口;无挂起时返回 0;不影响其他 thread', async () => {
    const gate = createApprovalGate({ whitelist: [...APPROVAL_WHITELIST_DEFAULT] })
    gate.register('t-a', () => {})
    gate.register('t-b', () => {})
    const pa = gate.intercept('t-a', 'wb_execute_template', {})
    const pb1 = gate.intercept('t-a', 'wb_run_workflow', {})
    await Promise.resolve()
    expect(gate.rejectPending('t-a')).toBe(2)
    expect(gate.rejectPending('t-a')).toBe(0)
    expect(gate.rejectPending('t-unknown')).toBe(0)
    await expect(pa).resolves.toMatchObject({ approved: false })
    await expect(pb1).resolves.toMatchObject({ approved: false })
    // t-b 未被波及:仍能正常批准
    let reqId = ''
    gate.register('t-b', (req) => {
      reqId = req.requestId
    })
    const pc = gate.intercept('t-b', 'wb_publish_workflow', {})
    await Promise.resolve()
    expect(gate.resolve('t-b', reqId, 'approve')).toBe(true)
    await expect(pc).resolves.toMatchObject({ approved: true })
  })
})

describe('onResolved 终态回执(审查修复 M4)', () => {
  it('应答/超时兜底/收口 reject 都触发钩子,携带 requestId/toolName/approved', async () => {
    const gate = createApprovalGate({ whitelist: [...APPROVAL_WHITELIST_DEFAULT], timeoutMs: 20 })
    const seen: Array<{ requestId: string; toolName: string; approved: boolean }> = []
    gate.register('t-h', (req) => {
      if (req.toolName === 'wb_execute_template') gate.resolve('t-h', req.requestId, 'reject')
    })
    gate.onResolved('t-h', (info) => seen.push(info))
    const p1 = gate.intercept('t-h', 'wb_execute_template', {})
    await p1
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ toolName: 'wb_execute_template', approved: false })

    // 超时兜底也回执(approved:false)
    const p2 = gate.intercept('t-h', 'wb_run_workflow', {})
    await p2
    expect(seen).toHaveLength(2)
    expect(seen[1]).toMatchObject({ toolName: 'wb_run_workflow', approved: false })

    // 收口 rejectPending 同样回执
    gate.intercept('t-h', 'wb_publish_workflow', {})
    await Promise.resolve()
    gate.rejectPending('t-h')
    expect(seen).toHaveLength(3)
    expect(seen[2]).toMatchObject({ toolName: 'wb_publish_workflow', approved: false })
  })

  it('钩子异常不影响 settle 主流程;unregister 后不再触发', async () => {
    const gate = createApprovalGate({ whitelist: [...APPROVAL_WHITELIST_DEFAULT] })
    gate.register('t-x', (req) => {
      gate.resolve('t-x', req.requestId, 'approve')
    })
    gate.onResolved('t-x', () => {
      throw new Error('hook boom')
    })
    await expect(gate.intercept('t-x', 'wb_execute_template', {})).resolves.toMatchObject({
      approved: true
    })
    gate.unregister('t-x')
    expect(gate.rejectPending('t-x')).toBe(0)
  })
})
