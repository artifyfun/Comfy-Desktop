/**
 * approvalRegistry 单测:门控 registry 的三边界(无身份直通 / 白名单拦截-批准 /
 * 白名单拦截-拒绝合成文本)+ ALS 身份上下文 + gate 单例共享。
 * createApprovalGatedRegistry(inner, gate) —— inner 在前。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import {
  createApprovalGatedRegistry,
  getApprovalGate,
  resetApprovalGateForTest,
  mcpIdentityStorage
} from './approvalRegistry'
import { APPROVAL_WHITELIST_DEFAULT, ApprovalArgsError } from './approvalGate'
import type { ToolRegistry } from '../mcp/tools'

/** 最小 ToolRegistry 桩:记录 handle 调用,返回可识别结果 */
function makeInner(impl?: (name: string, args: Record<string, unknown>) => Promise<unknown>) {
  const calls: Array<{ name: string; args: Record<string, unknown>; identity?: string }> = []
  const inner: ToolRegistry = {
    list: () => [
      { name: 'wb_execute_template', description: 'x', inputSchema: { type: 'object' } }
    ],
    handle: async (name, args, identity) => {
      calls.push({ name, args, identity })
      return impl ? impl(name, args) : { content: [{ type: 'text', text: 'ok' }] }
    },
    sync: vi.fn()
  }
  return { inner, calls }
}

function identity(id: string | undefined): string | undefined {
  return id
}

describe('approvalRegistry — createApprovalGatedRegistry', () => {
  beforeEach(() => {
    resetApprovalGateForTest()
  })

  it('无身份(外部 MCP 客户端)完全直通,白名单工具也不拦截', async () => {
    const { inner, calls } = makeInner()
    const gated = createApprovalGatedRegistry(inner, getApprovalGate())
    const out = await mcpIdentityStorage.run(undefined, () =>
      gated.handle('wb_execute_template', { templateId: 't1' })
    )
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual({ name: 'wb_execute_template', args: { templateId: 't1' } })
    expect((out as { isError?: boolean }).isError).toBeUndefined()
  })

  it('ALS store 外(未 run)同样视为无身份直通', async () => {
    const { inner, calls } = makeInner()
    const gated = createApprovalGatedRegistry(inner, getApprovalGate())
    await gated.handle('wb_execute_template', {})
    expect(calls).toHaveLength(1) // 直接落内层,无拦截
  })

  it('带身份 + 白名单工具:先挂起(intercept 未决时 handle 不落内层),批准后以原 args 执行', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-1'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      let settled: unknown
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_execute_template', { templateId: 't2' })
      )
      p.then((v) => (settled = v))
      // 轮 microtask 等待 intercept 挂起
      await Promise.resolve()
      expect(calls).toHaveLength(0) // 挂起中,内层未执行
      const value = notify.mock.calls[0]![0] as { requestId: string }
      expect(value.requestId).toBeTruthy()
      expect(gate.resolve(threadId, value.requestId, 'approve')).toBe(true)
      const out = (await p) as { content: Array<{ text: string }>; isError?: boolean }
      expect(out.isError).toBeUndefined()
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toEqual({ templateId: 't2' })
      void settled
    } finally {
      gate.unregister(threadId)
    }
  })

  it('带身份 + 白名单工具:拒绝 → isError 合成拒绝文本,内层不执行', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-2'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_publish_workflow', { id: 'w1' })
      )
      await Promise.resolve()
      const value = notify.mock.calls[0]![0] as { requestId: string }
      gate.resolve(threadId, value.requestId, 'reject')
      const out = (await p) as { content: Array<{ text: string }>; isError?: boolean }
      expect(out.isError).toBe(true)
      expect(out.content[0]!.text).toContain('用户拒绝执行工具 wb_publish_workflow')
      expect(calls).toHaveLength(0)
    } finally {
      gate.unregister(threadId)
    }
  })

  it('批准路径:edit 提供的替换 args 优先于原 args', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-3'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_run_workflow', { workflowId: 'wf1', wait: true })
      )
      await Promise.resolve()
      const value = notify.mock.calls[0]![0] as { requestId: string }
      gate.resolve(threadId, value.requestId, 'edit', { workflowId: 'wf1', wait: false })
      await p
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toEqual({ workflowId: 'wf1', wait: false })
    } finally {
      gate.unregister(threadId)
    }
  })

  it('白名单外工具:即使带身份也直通(notify 零调用)', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-4'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      await mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_search_templates', {})
      )
      expect(notify).not.toHaveBeenCalled()
      expect(calls).toHaveLength(1)
    } finally {
      gate.unregister(threadId)
    }
  })

  it('edit args 非普通对象抛 ApprovalArgsError(pending 未消费,可重试)', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-5'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      let caught: unknown = null
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_execute_template', {})
      )
      p.catch((e) => (caught = e))
      await Promise.resolve()
      const value = notify.mock.calls[0]![0] as { requestId: string }
      expect(() =>
        gate.resolve(threadId, value.requestId, 'edit', [1, 2] as unknown as Record<
          string,
          unknown
        >)
      ).toThrow(ApprovalArgsError)
      // pending 未消费:合法重试仍可批准
      expect(gate.resolve(threadId, value.requestId, 'approve')).toBe(true)
      await p
      expect(calls).toHaveLength(1)
      void caught
    } finally {
      gate.unregister(threadId)
    }
  })

  it('list/sync 委托内层', async () => {
    const { inner } = makeInner()
    const gated = createApprovalGatedRegistry(inner, getApprovalGate())
    expect(gated.list()).toHaveLength(1)
    gated.sync()
    expect(vi.mocked(inner.sync)).toHaveBeenCalled()
  })
})

describe('approvalRegistry — 身份链末跳透传(C7 回归)', () => {
  beforeEach(() => resetApprovalGateForTest())

  it('批准放行后 identity 第三参必须传到内层——丢参=并发会话串号(生产链经门控必经跳)', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-B'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_execute_template', { templateId: 'tB' })
      )
      await Promise.resolve()
      const value = notify.mock.calls[0]![0] as { requestId: string }
      expect(gate.resolve(threadId, value.requestId, 'approve')).toBe(true)
      await p
      expect(calls).toHaveLength(1)
      expect(calls[0]!.args).toEqual({ templateId: 'tB' })
      // ★ 核心断言:身份沿链透传,wb 工具的 requireSession 据此路由回 th-B
      expect(calls[0]!.identity).toBe('th-B')
    } finally {
      gate.unregister(threadId)
    }
  })

  it('edit 放行后同样透传身份,且 args 为编辑后的新值', async () => {
    const { inner, calls } = makeInner()
    const gate = getApprovalGate()
    const gated = createApprovalGatedRegistry(inner, gate)
    const threadId = 'th-C'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      const p = mcpIdentityStorage.run(identity(threadId), () =>
        gated.handle('wb_execute_template', { templateId: 'old', wait: true })
      )
      await Promise.resolve()
      const value = notify.mock.calls[0]![0] as { requestId: string }
      expect(
        gate.resolve(threadId, value.requestId, 'edit', { templateId: 'new', wait: false })
      ).toBe(true)
      await p
      expect(calls[0]!.args).toEqual({ templateId: 'new', wait: false })
      expect(calls[0]!.identity).toBe('th-C')
    } finally {
      gate.unregister(threadId)
    }
  })

  it('无身份直通路径不传 identity(undefined),保持外部客户端旧语义', async () => {
    const { inner, calls } = makeInner()
    const gated = createApprovalGatedRegistry(inner, getApprovalGate())
    await mcpIdentityStorage.run(undefined, () => gated.handle('wb_execute_template', { a: 1 }))
    expect(calls).toHaveLength(1)
    expect(calls[0]!.identity).toBeUndefined()
  })
})

describe('approvalRegistry — gate 单例', () => {
  beforeEach(() => resetApprovalGateForTest())

  it('getApprovalGate 多次调用返回同一实例', () => {
    expect(getApprovalGate()).toBe(getApprovalGate())
  })

  it('默认白名单为三个写操作工具', () => {
    expect(APPROVAL_WHITELIST_DEFAULT).toEqual([
      'wb_execute_template',
      'wb_run_workflow',
      'wb_publish_workflow'
    ])
  })

  it('B1 单例 tiers 接线:read 任意模式自动放行;conservative 下 write 弹卡待批', async () => {
    const gate = getApprovalGate()
    const threadId = 'th-b1'
    const notify = vi.fn()
    gate.register(threadId, notify)
    try {
      // read(wb_list_templates)→ 默认 standard 自动,notify 零调用
      await expect(gate.intercept(threadId, 'wb_list_templates', {})).resolves.toEqual({
        suspended: false,
        approved: true,
        args: {}
      })
      expect(notify).not.toHaveBeenCalled()
      // write(wb_clone_template)→ conservative 弹卡,approve 恢复
      gate.setMode(threadId, 'conservative')
      let req!: { requestId: string }
      notify.mockImplementation((r) => (req = r))
      const p = gate.intercept(threadId, 'wb_clone_template', { template_id: 'x' })
      await Promise.resolve()
      expect(req.requestId).toBeTruthy()
      expect(gate.resolve(threadId, req.requestId, 'approve')).toBe(true)
      await expect(p).resolves.toMatchObject({ suspended: true, approved: true })
    } finally {
      gate.unregister(threadId)
    }
  })
})
