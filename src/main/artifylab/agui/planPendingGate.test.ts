/**
 * AIAE Plan 语义（借鉴 ai-art-engine）：计划待拍板期间 write/execute 被
 * 服务端硬约束拦下，拍板/清理后恢复。直接打 gate 单例（与 planTools 同一
 * 写入面），ListTools 过滤逻辑由 mcp/index.ts 消费同一 isPlanPending。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { createApprovalGate, APPROVAL_MODE_DEFAULT } from './approvalGate'

function gate() {
  return createApprovalGate({
    tiers: {
      wb_list_templates: 'read',
      wb_remember: 'write',
      wb_execute_template: 'execute'
    },
    defaultMode: APPROVAL_MODE_DEFAULT
  })
}

describe('ApprovalGate planPending（计划待拍板只读压紧）', () => {
  let g: ReturnType<typeof gate>
  beforeEach(() => {
    g = gate()
  })

  it('pending 期间：read 放行，write/execute 被 checkCall 拒', () => {
    g.setPlanPending('t-plan', true)
    expect(g.isPlanPending('t-plan')).toBe(true)
    expect(g.checkCall('t-plan', 'wb_list_templates')).toEqual({ allowed: true })
    const wr = g.checkCall('t-plan', 'wb_remember')
    expect(wr.allowed).toBe(false)
    expect(wr.reason).toContain('拍板')
    expect(g.checkCall('t-plan', 'wb_execute_template').allowed).toBe(false)
  })

  it('拍板后（pending=false）：write 恢复可用（standard 下走 intercept 自动放行）', () => {
    g.setPlanPending('t-plan', true)
    g.setPlanPending('t-plan', false)
    expect(g.isPlanPending('t-plan')).toBe(false)
    expect(g.checkCall('t-plan', 'wb_remember')).toEqual({ allowed: true })
  })

  it('unregister 一并清理（run 收口兜底，防状态泄漏到同 id 下一会话）', () => {
    g.setPlanPending('t-leak', true)
    g.unregister('t-leak')
    expect(g.isPlanPending('t-leak')).toBe(false)
    expect(g.checkCall('t-leak', 'wb_remember')).toEqual({ allowed: true })
  })

  it('ask 模式优先于 planPending（两者都拒，但 reason 是 ask 的）', () => {
    g.setMode('t-ask', 'ask')
    g.setPlanPending('t-ask', true)
    const r = g.checkCall('t-ask', 'wb_list_templates')
    expect(r.allowed).toBe(false)
    expect(r.reason).toContain('只读对话模式')
  })
})
