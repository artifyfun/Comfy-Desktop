// views/workbench/__tests__/bridgeCall.test.js — 桥请求/ack 通道单测
// 覆盖：ack 关联回传 / 超时兜底 / 未知类型 / postMessage 抛错的发送失败路径。
// @vitest-environment happy-dom
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { callBridge } from '../bridgeCall'
import { ARTIFY_MSG } from '@/inject/protocol'

function lastPosted() {
  const calls = window.parent.postMessage.mock.calls
  return calls.length ? JSON.parse(calls[calls.length - 1][0]) : null
}

describe('callBridge', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    window.parent = { postMessage: vi.fn() }
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('ack 数据原样回传（requestId 自动关联）', async () => {
    const p = callBridge(ARTIFY_MSG.CANVAS_OPS, { ops: [], reason: 'test' })
    const sent = lastPosted()
    expect(sent.type).toBe('artify:canvas-ops')
    expect(typeof sent.requestId).toBe('string')
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'artify:canvas-ops-result', requestId: sent.requestId, ok: true, applied: 3 }),
      }),
    )
    await expect(p).resolves.toMatchObject({ ok: true, applied: 3 })
  })

  it('别的 requestId 的 ack 不误领', async () => {
    const p = callBridge(ARTIFY_MSG.CANVAS_OPS, {})
    const sent = lastPosted()
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'artify:canvas-ops-result', requestId: 'other', ok: true }),
      }),
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'artify:canvas-ops-result', requestId: sent.requestId, ok: false, error: 'x' }),
      }),
    )
    await expect(p).resolves.toMatchObject({ ok: false, error: 'x' })
  })

  it('超时返回 bridge timeout（默认 8s；listener 已清理）', async () => {
    const spy = vi.spyOn(window, 'removeEventListener')
    const p = callBridge(ARTIFY_MSG.CANVAS_OPS, {})
    await vi.advanceTimersByTimeAsync(8000)
    await expect(p).resolves.toMatchObject({ ok: false, error: 'bridge timeout' })
    expect(spy).toHaveBeenCalled()
  })

  it('execute 走 CANVAS_EXECUTE_RESULT ack 且可自定义超时', async () => {
    const p = callBridge(ARTIFY_MSG.CANVAS_EXECUTE, { name: 'n' }, { timeout: 10000 })
    const sent = lastPosted()
    expect(sent.type).toBe('artify:canvas-execute')
    await vi.advanceTimersByTimeAsync(8000)
    window.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ type: 'artify:canvas-execute-result', requestId: sent.requestId, ok: true, promptId: 'p1' }),
      }),
    )
    await expect(p).resolves.toMatchObject({ ok: true, promptId: 'p1' })
  })

  it('未知类型直接拒绝（ok:false，不发消息）', async () => {
    const p = callBridge('artify:not-a-request')
    await expect(p).resolves.toMatchObject({ ok: false })
    expect(window.parent.postMessage).not.toHaveBeenCalled()
  })

  it('postMessage 抛错 → 发送失败路径', async () => {
    window.parent.postMessage = vi.fn(() => {
      throw new Error('dead frame')
    })
    const p = callBridge(ARTIFY_MSG.CANVAS_OPS, {})
    await expect(p).resolves.toMatchObject({ ok: false, error: expect.stringContaining('dead frame') })
  })
})
