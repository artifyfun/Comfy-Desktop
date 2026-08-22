import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  executeApp,
  getExecutionStatus,
  extractOutputs,
  assertSafeMediaUrl,
  getSeed,
  freeIfWorkflowChanged,
  forceFreeAndTrack,
  resolveWorkflowKey,
  resetWorkflowKey
} from './executor'
import type { App, ComfyPrompt, ParamNode } from '../appStore'

function makeApp(prompt: ComfyPrompt, paramsNodes: ParamNode[] = []): App {
  return {
    id: 'app-1',
    name: 'test app',
    createdAt: 0,
    updatedAt: 0,
    template: { prompt, paramsNodes }
  }
}

const ORIGIN = 'http://127.0.0.1:8188'

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
    if (url.startsWith('data:')) return new Response(new Blob(['x']), { status: 200 })
    if (url.includes('/free')) {
      return new Response('{}', { status: 200 })
    }
    if (url.includes('/prompt')) {
      return new Response(JSON.stringify({ prompt_id: 'p-test-1' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      })
    }
    throw new Error(`unexpected fetch: ${url}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  // 工作流跟踪是模块级状态，跨测试重置，避免"上一个 app"残留影响
  resetWorkflowKey()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function submittedPrompt(): ComfyPrompt {
  const call = fetchMock.mock.calls.find(([u]) => String(u).endsWith('/prompt'))
  expect(call).toBeDefined()
  const init = call![1] as RequestInit | undefined
  const body = JSON.parse(String(init?.body))
  return body.prompt as ComfyPrompt
}

describe('getSeed', () => {
  it('生成 15 位数字且首位非 0', () => {
    const s = getSeed()
    expect(String(s)).toMatch(/^[1-9][0-9]{14}$/)
  })
})

describe('assertSafeMediaUrl', () => {
  it('data: URL 通过', () => {
    expect(() => assertSafeMediaUrl('data:image/png;base64,AAAA')).not.toThrow()
  })
  it('本机 http(s) 通过', () => {
    for (const u of [
      'http://127.0.0.1:8188/view?x=1',
      'http://localhost:8188/view',
      'http://[::1]:8188/view'
    ]) {
      expect(() => assertSafeMediaUrl(u)).not.toThrow()
    }
  })
  it('内网/公网地址拒绝（SSRF）', () => {
    for (const u of [
      'http://192.168.1.10/secret',
      'http://169.254.169.254/latest/meta-data',
      'http://10.0.0.1/x',
      'https://evil.com/x'
    ]) {
      expect(() => assertSafeMediaUrl(u)).toThrow(/host not allowed/)
    }
  })
  it('非法 scheme 拒绝', () => {
    for (const u of ['ftp://127.0.0.1/x', 'file:///etc/passwd', 'not a url']) {
      expect(() => assertSafeMediaUrl(u)).toThrow()
    }
  })
})

describe('executeApp', () => {
  it('显式 seed 生效（randomize_seed 默认 false）', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123, cfg: 4 } } })
    const res = await executeApp(app, { seed: 42 }, ORIGIN)
    expect(res.status).toBe('queued')
    expect(submittedPrompt()['1']!.inputs.seed).toBe(42)
  })
  it('未传 seed 时自动随机', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } })
    await executeApp(app, {}, ORIGIN)
    const seed = submittedPrompt()['1']!.inputs.seed as number
    expect(String(seed)).toMatch(/^[1-9][0-9]{14}$/)
  })
  it('randomize_seed=true 强制随机覆盖显式 seed', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } })
    await executeApp(app, { seed: 42, randomize_seed: true }, ORIGIN)
    const seed = submittedPrompt()['1']!.inputs.seed as number
    expect(seed).not.toBe(42)
    expect(String(seed)).toMatch(/^[1-9][0-9]{14}$/)
  })
  it('NaN/非法 seed 拒绝', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } })
    await expect(executeApp(app, { seed: 'abc' }, ORIGIN)).rejects.toThrow(
      'seed must be a finite number'
    )
    await expect(executeApp(app, { seed: Number.NaN }, ORIGIN)).rejects.toThrow(
      'seed must be a finite number'
    )
  })
  it('媒体参数只接受 data: URL（SSRF 拦截）', async () => {
    const app = makeApp({ '3': { class_type: 'LoadImage', inputs: { image: 'default.png' } } }, [
      {
        id: 3,
        category: 'input',
        type: 'LoadImage',
        name: 'img',
        renderComponent: 'image-uploader',
        selectedWidget: { name: 'image' }
      }
    ])
    await expect(executeApp(app, { img: 'http://192.168.1.1/evil.png' }, ORIGIN)).rejects.toThrow(
      /host not allowed/
    )
  })
  it('普通参数按 node id + widget 合并', async () => {
    const app = makeApp({ '2': { class_type: 'KSampler', inputs: { cfg: 4.0 } } }, [
      {
        id: 2,
        category: 'input',
        type: 'KSampler',
        name: 'cfg',
        renderComponent: 'slider',
        selectedWidget: { name: 'cfg' }
      }
    ])
    await executeApp(app, { cfg: 7.5 }, ORIGIN)
    expect(submittedPrompt()['2']!.inputs.cfg).toBe(7.5)
  })
})

describe('getExecutionStatus', () => {
  it('未提交过的 prompt_id → error（不再永久 running）', async () => {
    const res = await getExecutionStatus(ORIGIN, 'never-submitted')
    expect(res.status).toBe('error')
    expect(res.error).toMatch(/unknown prompt_id/)
  })

  it('404（仍排队/运行中）→ running', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } })
    await executeApp(app, {}, ORIGIN)
    const promptId = 'p-test-1'
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/history/${promptId}`)) return new Response('{}', { status: 404 })
      throw new Error(`unexpected: ${url}`)
    })
    const res = await getExecutionStatus(ORIGIN, promptId)
    expect(res.status).toBe('running')
  })

  it('ComfyUI 执行错误 → error 带消息', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } })
    await executeApp(app, {}, ORIGIN)
    const promptId = 'p-test-1'
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/history/${promptId}`)) {
        return new Response(
          JSON.stringify({ [promptId]: { status: { status_str: 'error', messages: ['boom'] } } }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      }
      throw new Error(`unexpected: ${url}`)
    })
    const res = await getExecutionStatus(ORIGIN, promptId)
    expect(res.status).toBe('error')
    expect(res.error).toContain('boom')
  })

  it('success → 只返回声明的 output 节点产物', async () => {
    const app = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 123 } } }, [
      { id: 9, category: 'output', type: 'SaveImage', name: 'result' }
    ])
    await executeApp(app, {}, ORIGIN)
    const promptId = 'p-test-1'
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes(`/history/${promptId}`)) {
        return new Response(
          JSON.stringify({
            [promptId]: {
              status: { status_str: 'success' },
              outputs: {
                '9': { images: [{ type: 'output', filename: 'a.png' }] },
                '99': { images: [{ type: 'output', filename: 'b.png' }] }
              }
            }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      }
      throw new Error(`unexpected: ${url}`)
    })
    const res = await getExecutionStatus(ORIGIN, promptId)
    expect(res.status).toBe('success')
    const outputs = res.outputs as Record<string, unknown>
    expect(Object.keys(outputs)).toEqual(['9'])
    expect((outputs['9'] as { filename: string }).filename).toBe('a.png')
  })
})

describe('extractOutputs', () => {
  it('对象数组回退分支输出 JSON 而非 [object Object]', () => {
    const paramsNodes: ParamNode[] = [{ id: 7, category: 'output', type: 'X', name: 'out' }]
    const raw = { '7': { items: [{ type: 'temp', filename: 'x.png' }] } }
    const out = extractOutputs(paramsNodes, raw)
    expect(String(out['7'])).toContain('x.png')
    expect(String(out['7'])).not.toBe('[object Object]')
  })
})

describe('freeIfWorkflowChanged / 工作流切换前置清理', () => {
  function freeCallCount(): number {
    return fetchMock.mock.calls.filter(([u]) => String(u).includes('/free')).length
  }

  it('resolveWorkflowKey: appId 优先，缺失时退化 prompt 指纹', () => {
    expect(resolveWorkflowKey('app-x')).toBe('app:app-x')
    expect(resolveWorkflowKey(undefined, { '1': { class_type: 'A', inputs: {} } })).toContain(
      'prompt:'
    )
  })

  it('首次执行 free；同工作流跳过；换工作流再 free', async () => {
    expect(await freeIfWorkflowChanged(ORIGIN, 'app:a')).toBe(true)
    expect(await freeIfWorkflowChanged(ORIGIN, 'app:a')).toBe(false)
    expect(await freeIfWorkflowChanged(ORIGIN, 'app:b')).toBe(true)
    expect(freeCallCount()).toBe(2)
  })

  it('forceFreeAndTrack 无条件 free 并更新指纹（后续同 key 跳过）', async () => {
    await forceFreeAndTrack(ORIGIN, 'app:x')
    expect(freeCallCount()).toBe(1) // 无条件清了一次
    expect(await freeIfWorkflowChanged(ORIGIN, 'app:x')).toBe(false) // 指纹已记录 → 跳过
    expect(freeCallCount()).toBe(1)
  })

  it('executeApp 切换 app 时发 /free；首次执行也 free（防外部残留）', async () => {
    const appA = makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 1 } } })
    const appB: App = {
      ...makeApp({ '1': { class_type: 'KSampler', inputs: { seed: 2 } } }),
      id: 'app-2',
      name: 'app2'
    }
    await executeApp(appA, {}, ORIGIN)
    expect(freeCallCount()).toBe(1) // 首次执行防御性 free
    await executeApp(appB, {}, ORIGIN)
    expect(freeCallCount()).toBe(2) // 切换 app → free
    await executeApp(appA, {}, ORIGIN)
    expect(freeCallCount()).toBe(3) // 换回 app-a → 又 free
  })
})
