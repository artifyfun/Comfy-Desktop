/**
 * comfyClient 单测（候选 ④ 的 test surface）：
 * 注入假 fetcher 验证各领域动词的 URL 拼接 / 超时传递 / 错误形状 / 404 语义。
 * appStore 依赖走 require 懒加载——这里 mock 掉避免拉起 electron。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// appStore 不 mock 文件（require/动态 import 在 vite 转译下不可靠）：
// 直接 bindAppStore 注入句柄——这正是 seam 的设计意图。

import {
  bindAppStore,
  clearQueueDiagnostics,
  comfyFetch,
  formatQueueNodeErrors,
  getObjectInfo,
  getNodeObjectInfo,
  getSystemStats,
  getHistory,
  getQueueDiagnostics,
  queuePrompt,
  uploadImage,
  interrupt,
  freeMemory,
  randomSeed,
  randomizeSeedFields
} from './comfyClient'

beforeEach(() => {
  bindAppStore({ getConfig: () => ({ comfyHost: 'http://127.0.0.1:8188/' }) })
})

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' }
  })
}

describe('resolveComfyOrigin（经 comfyFetch 间接验证）', () => {
  it('override 优先于 appStore comfyHost', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}))
    await comfyFetch('/x', {}, { fetch: f as unknown as typeof fetch, origin: 'http://h:1' })
    expect(f.mock.calls[0]?.[0]).toBe('http://h:1/x')
  })

  it('缺省读 appStore comfyHost 并去掉尾斜杠', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}))
    await comfyFetch('/y', {}, { fetch: f as unknown as typeof fetch })
    expect(f.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8188/y')
  })
})

describe('领域动词', () => {
  it('getObjectInfo → GET /object_info', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ KSampler: {} }))
    const out = await getObjectInfo({ fetch: f as unknown as typeof fetch })
    expect(f.mock.calls[0]?.[0]).toBe('http://127.0.0.1:8188/object_info')
    expect('KSampler' in out).toBe(true)
  })

  it('getNodeObjectInfo → 编码节点名', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}))
    await getNodeObjectInfo('Load Image (NT)', { fetch: f as unknown as typeof fetch })
    expect(f.mock.calls[0]?.[0]).toContain('/object_info/Load%20Image%20(NT)')
  })

  it('getSystemStats → GET /system_stats', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({ devices: [] }))
    const out = (await getSystemStats({ fetch: f as unknown as typeof fetch })) as {
      devices?: unknown[]
    }
    expect(f.mock.calls[0]?.[0]).toContain('/system_stats')
    expect(Array.isArray(out.devices)).toBe(true)
  })

  it('getHistory：404 → null（仍运行语义）', async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('{}', { status: 404 })
    )
    expect(await getHistory('p1', { fetch: f as unknown as typeof fetch })).toBeNull()
  })

  it('getHistory：命中 → 返回该 promptId 的 entry', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ 'p-1': { status: { status_str: 'success' } } })
    )
    const entry = await getHistory('p-1', { fetch: f as unknown as typeof fetch })
    expect((entry?.status as { status_str?: string })?.status_str).toBe('success')
  })

  it('getHistory：5xx → throw（M3 永不误判 running）', async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('boom', { status: 502 })
    )
    await expect(getHistory('p1', { fetch: f as unknown as typeof fetch })).rejects.toThrow(/502/)
  })

  it('queuePrompt：POST /prompt，返回 prompt_id', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ prompt_id: 'pid-9' })
    )
    const id = await queuePrompt({ n: {} }, 'client-1', { fetch: f as unknown as typeof fetch })
    expect(id).toBe('pid-9')
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(url).toContain('/prompt')
    expect(init.method).toBe('POST')
    expect(String(init.body)).toContain('"client_id":"client-1"')
  })

  it('queuePrompt：响应缺 prompt_id → throw', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse({}))
    await expect(queuePrompt({}, 'c', { fetch: f as unknown as typeof fetch })).rejects.toThrow(
      /missing prompt_id/
    )
  })

  // 2026-09-16 真机验证抓到的缺陷回归：ComfyUI 只要还有一个输出节点可用就返回
  // 200，其余校验失败的节点连其输出分支**静默丢弃**。旧实现只看 prompt_id，
  // 于是这类工作流以「success + 零正式产物」收尾（既有 Anima 系模板的 4 个
  // Save Images Mikey 整体被丢，外层零线索）。
  it('queuePrompt：200 但带 node_errors → 仍返回 promptId，并把丢弃项记入诊断', async () => {
    const prompt = {
      '178': { class_type: 'Save Images Mikey', inputs: {} },
      '138': { class_type: 'Load Text File', inputs: { dictionary_name: '[filename]' } }
    }
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({
        prompt_id: 'pid-diag',
        node_errors: {
          '138': {
            class_name: 'Load Text File',
            errors: [
              {
                type: 'required_input_missing',
                message: 'Required input is missing',
                extra_info: { input_name: 'file' }
              }
            ]
          }
        }
      })
    )
    const id = await queuePrompt(prompt, 'c', { fetch: f as unknown as typeof fetch })
    expect(id).toBe('pid-diag')
    const diags = getQueueDiagnostics(id)
    expect(diags).toHaveLength(1)
    expect(diags[0]!.nodeId).toBe('138')
    expect(diags[0]!.classType).toBe('Load Text File')
    expect(diags[0]!.messages.join()).toMatch(/required_input_missing/)
    expect(diags[0]!.messages.join()).toMatch(/缺少必填输入 file/)
    expect(formatQueueNodeErrors(diags)).toContain('138 Load Text File')
    clearQueueDiagnostics(id)
    expect(getQueueDiagnostics(id)).toEqual([])
  })

  it('queuePrompt：HTTP 400 → 错误消息带上「哪个节点缺什么输入」（不再只截 200 字）', async () => {
    const prompt = { '36': { class_type: 'Load Text File', inputs: {} } }
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            error: { type: 'prompt_outputs_failed_validation', message: 'Prompt outputs failed' },
            node_errors: {
              '36': {
                errors: [
                  {
                    type: 'required_input_missing',
                    extra_info: { input_name: 'file' }
                  }
                ]
              }
            }
          }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
    )
    await expect(queuePrompt(prompt, 'c', { fetch: f as unknown as typeof fetch })).rejects.toThrow(
      /36 Load Text File.*缺少必填输入 file/s
    )
  })

  it('uploadImage：FormData 直传，返回含 subfolder 前缀的 name', async () => {
    const f = vi.fn(async (_url: string, _init?: RequestInit) =>
      jsonResponse({ name: 'a.png', subfolder: 'sub', type: 'input' })
    )
    const out = await uploadImage(new Blob(['x']), 'a.png', {
      fetch: f as unknown as typeof fetch
    })
    expect(out.name).toBe('sub/a.png')
    expect(out.subfolder).toBe('sub')
    expect(f.mock.calls[0]?.[1]?.body).toBeInstanceOf(FormData)
  })

  it('interrupt / freeMemory：非 2xx → throw', async () => {
    const f = vi.fn(
      async (_url: string, _init?: RequestInit) => new Response('no', { status: 500 })
    )
    await expect(interrupt({ fetch: f as unknown as typeof fetch })).rejects.toThrow(/500/)
    await expect(freeMemory({ fetch: f as unknown as typeof fetch })).rejects.toThrow(/500/)
  })
})

describe('seed 收口', () => {
  it('randomSeed：15 位、首位非 0', () => {
    for (let i = 0; i < 20; i++) {
      const s = randomSeed()
      expect(String(s)).toHaveLength(15)
      expect(String(s)[0]).not.toBe('0')
    }
  })

  it('randomizeSeedFields：只随机数值型 seed 字段', () => {
    const prompt = {
      '1': { inputs: { seed: 1, steps: 20, seed_text: 'keep' } },
      '2': { inputs: { noise_seed: 2 } },
      '3': { inputs: { text: 'no seed here' } }
    }
    randomizeSeedFields(prompt)
    expect(prompt['1'].inputs?.seed).not.toBe(1)
    expect(String(prompt['1'].inputs?.seed)).toHaveLength(15)
    expect(prompt['1'].inputs?.steps).toBe(20)
    expect(prompt['1'].inputs?.seed_text).toBe('keep')
    expect(prompt['2'].inputs?.noise_seed).not.toBe(2)
    expect(prompt['3'].inputs?.text).toBe('no seed here')
  })
})
