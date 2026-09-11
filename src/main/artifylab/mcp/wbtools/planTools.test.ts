/**
 * wb_propose_plan 单测：纯展示分支 / 拍板挂起分支 / 超时 fail-safe / 参数规整。
 * gate 用注入 mock（与 transport.test 同款），SSE 桥用 spy。
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getAppPath: () => process.cwd(), getPath: () => process.env.TMPDIR || '/tmp' }
}))
vi.mock('../../workbench/service', () => ({
  workbenchService: { getSession: vi.fn((id: string) => (id ? { id } : null)) }
}))
vi.mock('../../appStore', () => ({
  default: { getConfig: () => ({ comfyHost: 'http://127.0.0.1:8188' }) }
}))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

import { planTools, clearPlanEmitsForTest, registerPlanEmit, unregisterPlanEmit } from './planTools'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from './shared'

const tool = planTools.find((t) => t.tool.name === 'wb_propose_plan')!

describe('wb_propose_plan — 纯展示分支（无 options）', () => {
  beforeEach(() => {
    clearPlanEmitsForTest()
    endWorkbenchToolContext('sess-p')
    beginWorkbenchToolContext('sess-p')
  })

  it('下发 CUSTOM plan_proposed，返回 acknowledged；emit 收到 title+steps', async () => {
    const spy = vi.fn()
    registerPlanEmit('sess-p', spy)
    const res = (await tool.fn(
      {
        title: '三步搭工作流',
        steps: [{ title: '选模板' }, { title: '生成', detail: 'wait=true' }]
      },
      'sess-p'
    )) as { content: Array<{ text?: string }> }
    const payload = JSON.parse(res.content[0]?.text ?? '{}')
    expect(payload.ok).toBe(true)
    expect(payload.acknowledged).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    const ev = spy.mock.calls[0]![0] as {
      type: string
      name: string
      value: { title: string; steps: unknown[] }
    }
    expect(ev.type).toBe('CUSTOM')
    expect(ev.name).toBe('plan_proposed')
    expect(ev.value.title).toBe('三步搭工作流')
    expect(ev.value.steps).toHaveLength(2)
  })
})

describe('wb_propose_plan — 拍板分支（有 options，自管 pending）', () => {
  beforeEach(() => {
    clearPlanEmitsForTest()
    endWorkbenchToolContext('sess-p')
    beginWorkbenchToolContext('sess-p')
  })

  it('计划卡先下发（带 options），resolvePlanChoice 点选后工具返回 selectedOptionId', async () => {
    const spy = vi.fn()
    registerPlanEmit('sess-p', spy)
    const { resolvePlanChoiceBySession } = await import('./planTools')
    const pending = tool.fn(
      {
        title: '方向确认',
        steps: [{ title: 'a' }, { title: 'b' }],
        options: [
          { optionId: 'plan-a', label: '写实风' },
          { optionId: 'plan-b', label: '动漫风' }
        ]
      },
      'sess-p'
    )
    // 等挂起建立(第一帧 plan_proposed 同步下发)
    await vi.waitFor(() => {
      if (spy.mock.calls.length === 0) throw new Error('plan 未下发')
    })
    const ev = spy.mock.calls[0]![0] as {
      name: string
      value: { options?: unknown[]; requestId?: string }
    }
    expect(ev.name).toBe('plan_proposed')
    expect(ev.value.options).toHaveLength(2)
    // pendingId 直接在 plan_proposed 帧里(单帧带全,前端原样回传)
    const pid = ev.value.requestId ?? ''
    expect(pid).toBeTruthy()
    expect(resolvePlanChoiceBySession('sess-p', 'plan-b')).toBe(true)
    const res = await pending
    const payload = JSON.parse(
      (res as { content: Array<{ text?: string }> }).content[0]?.text ?? '{}'
    )
    expect(payload.ok).toBe(true)
    expect(payload.selectedOptionId).toBe('plan-b')
    expect(payload.selected).toMatchObject({ label: '动漫风' })
  })

  it('超时 fail-safe：无点选 → ok:false + cancelled（用 fake timers 压缩 10min）', async () => {
    const spy = vi.fn()
    registerPlanEmit('sess-p', spy)
    vi.useFakeTimers()
    const pending = tool.fn(
      {
        title: 'T',
        steps: [{ title: 'a' }, { title: 'b' }],
        options: [
          { optionId: 'a', label: 'A' },
          { optionId: 'b', label: 'B' }
        ]
      },
      'sess-p'
    )
    // 等 plan_proposed/plan_pending 帧同步下发(挂起建立)
    await vi.advanceTimersByTimeAsync(0)
    await vi.waitFor(() => {
      if (!spy.mock.calls.length) throw new Error('plan 未下发')
    })
    // 快进过 10min 超时
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)
    const res = await pending
    const payload = JSON.parse(
      (res as { content: Array<{ text?: string }> }).content[0]?.text ?? '{}'
    )
    expect(payload.ok).toBe(false)
    expect(payload.cancelled).toBe(true)
    vi.useRealTimers()
  })
})

describe('参数规整与 SSE 桥', () => {
  beforeEach(() => clearPlanEmitsForTest())

  it('steps 超 8 截断；无 options 走纯展示分支', async () => {
    endWorkbenchToolContext('sess-q')
    beginWorkbenchToolContext('sess-q')
    const spy = vi.fn()
    registerPlanEmit('sess-q', spy)
    const steps = Array.from({ length: 12 }, (_, i) => ({ title: `s${i}` }))
    const res = (await tool.fn({ title: 'T', steps }, 'sess-q')) as {
      content: Array<{ text?: string }>
    }
    const payload = JSON.parse(res.content[0]?.text ?? '{}')
    expect(payload.ok).toBe(true)
    expect(payload.acknowledged).toBe(true)
    // plan_proposed 帧: steps 被 8 截断
    const ev = spy.mock.calls[0]![0] as { value: { steps: unknown[] } }
    expect(ev.value.steps).toHaveLength(8)
  })

  it('unregister 后不再投递（fire-and-forget 分支静默跳过）', async () => {
    endWorkbenchToolContext('sess-r')
    beginWorkbenchToolContext('sess-r')
    const spy = vi.fn()
    registerPlanEmit('sess-r', spy)
    unregisterPlanEmit('sess-r')
    const res = (await tool.fn(
      { title: 'T', steps: [{ title: 'a' }, { title: 'b' }] },
      'sess-r'
    )) as { content: Array<{ text?: string }> }
    const payload = JSON.parse(res.content[0]?.text ?? '{}')
    expect(payload.ok).toBe(true)
    expect(payload.acknowledged).toBe(true)
    expect(spy).not.toHaveBeenCalled()
  })
})
