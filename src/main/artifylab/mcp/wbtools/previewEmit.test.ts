// @vitest-environment node
/**
 * 编排路径（工具内 wait 阻塞）的生成过程预览推送测试（对标建议 #5 补完）。
 *
 * 缺口背景：预览原本只在「快路径」生效——前端收到 wb_artifact 回执才 startPoll，
 * 而编排路径（wb_execute_template wait=true）执行在工具内阻塞、没有回执，前端
 * 不轮询 → 预览帧无人消费。现在 pollUntilDone 每轮顺带经会话 SSE 推出
 * CUSTOM preview_frame。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('../../workbench/service', () => ({
  workbenchService: { pollExecution: vi.fn() }
}))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

import { pollUntilDone } from './shared'
import { workbenchService } from '../../workbench/service'
import {
  clearSessionEmitsForTest,
  emitSessionCustom,
  registerSessionEmit,
  sessionEmitFor,
  unregisterSessionEmit
} from '../../agui/sessionEmit'

const frameValue = {
  promptId: 'p1',
  dataUrl: 'data:image/jpeg;base64,AAAA',
  at: 1_700_000_000_000
}

beforeEach(() => {
  clearSessionEmitsForTest()
  vi.mocked(workbenchService.pollExecution).mockReset()
})

afterEach(() => {
  vi.useRealTimers()
  clearSessionEmitsForTest()
})

describe('pollUntilDone 推 preview_frame', () => {
  it('运行中带 preview → 经会话 SSE 推出；终态不再推', async () => {
    vi.useFakeTimers()
    vi.mocked(workbenchService.pollExecution)
      .mockResolvedValueOnce({
        status: 'running',
        outputs: null,
        outputsText: '',
        preview: { data_url: frameValue.dataUrl, at: frameValue.at }
      } as never)
      .mockResolvedValueOnce({
        status: 'success',
        outputs: { '9': { images: [] } },
        outputsText: 'done'
      } as never)

    const seen: Array<{ name: string; value: unknown }> = []
    registerSessionEmit('s1', (e) => {
      const ev = e as { name?: string; value?: unknown }
      if (ev.name) seen.push({ name: ev.name, value: ev.value })
    })

    const promise = pollUntilDone('s1', 'p1')
    await vi.advanceTimersByTimeAsync(3_100)
    const result = await promise

    expect(result.ok).toBe(true)
    expect(result.stage).toBe('completed')
    expect(seen).toHaveLength(1)
    expect(seen[0]!.name).toBe('preview_frame')
    expect(seen[0]!.value).toMatchObject({
      promptId: 'p1',
      dataUrl: frameValue.dataUrl,
      at: frameValue.at
    })
  })

  it('多轮都带 preview → 每轮推一条（节流由 3s 轮询节奏保证）', async () => {
    vi.useFakeTimers()
    vi.mocked(workbenchService.pollExecution)
      .mockResolvedValueOnce({
        status: 'running',
        outputs: null,
        outputsText: '',
        preview: { data_url: 'data:image/jpeg;base64,AA', at: 1 }
      } as never)
      .mockResolvedValueOnce({
        status: 'running',
        outputs: null,
        outputsText: '',
        preview: { data_url: 'data:image/jpeg;base64,BB', at: 2 }
      } as never)
      .mockResolvedValueOnce({ status: 'success', outputs: {}, outputsText: '' } as never)

    const datUrls: string[] = []
    registerSessionEmit('s1', (e) => {
      const ev = e as { name?: string; value?: { dataUrl?: string } }
      if (ev.name === 'preview_frame' && ev.value?.dataUrl) datUrls.push(ev.value.dataUrl)
    })

    const promise = pollUntilDone('s1', 'p1')
    await vi.advanceTimersByTimeAsync(6_500)
    await promise

    expect(datUrls).toEqual(['data:image/jpeg;base64,AA', 'data:image/jpeg;base64,BB'])
  })

  it('无 SSE 通道（外部 MCP 直调）→ 静默跳过，不影响返回', async () => {
    vi.mocked(workbenchService.pollExecution).mockResolvedValueOnce({
      status: 'success',
      outputs: {},
      outputsText: 'ok'
    } as never)

    const result = await pollUntilDone('no-channel', 'p1')

    expect(result.ok).toBe(true)
    expect(result.outputs_text).toBe('ok')
  })

  it('失败终态返回错误信息（预览不干扰失败语义）', async () => {
    vi.mocked(workbenchService.pollExecution).mockResolvedValueOnce({
      status: 'error',
      error: 'OOM',
      outputs: null,
      outputsText: ''
    } as never)

    const result = await pollUntilDone('s1', 'p1')

    expect(result.ok).toBe(false)
    expect(result.stage).toBe('failed')
    expect(result.error).toBe('OOM')
  })
})

describe('sessionEmit 注册表', () => {
  it('注册后可推；注销/清空后推不动（返回 false 而不抛错）', () => {
    const spy = vi.fn()
    registerSessionEmit('s1', spy)
    expect(sessionEmitFor('s1')).toBe(spy)
    expect(emitSessionCustom('s1', 'x', { a: 1 })).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)

    unregisterSessionEmit('s1')
    expect(sessionEmitFor('s1')).toBeUndefined()
    expect(emitSessionCustom('s1', 'x', {})).toBe(false)

    expect(emitSessionCustom('never-registered', 'x', {})).toBe(false)
  })

  it('同一会话只能有一条通道（后注册覆盖前者，防两表互相覆盖）', () => {
    const a = vi.fn()
    const b = vi.fn()
    registerSessionEmit('s1', a)
    registerSessionEmit('s1', b)
    emitSessionCustom('s1', 'x', {})
    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalledTimes(1)
  })
})
