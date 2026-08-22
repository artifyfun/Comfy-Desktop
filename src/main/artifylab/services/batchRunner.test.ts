// batchRunner 顶层 import artifyUtils(→ server → electron),测试环境无 electron
// 二进制,这里 mock 掉模块副作用部分;executor 也 mock,只测引擎行为与纯函数。
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { BatchStartOptions } from './batchRunner'
import type * as BatchRunnerNS from './batchRunner'

// executor mock：固定对象（vi.mock factory 只执行一次，不能在 beforeEach 里替换）。
// 副作用：前一个测试实例的残留后台任务会调用同一组 mock —— 每个测试结束前必须
// settleQueue 把队列清干净，否则计数污染下一个测试。
const mocks = {
  queuePrompt: vi.fn(),
  getHistory: vi.fn(),
  stopExecution: vi.fn(),
  freeModels: vi.fn(),
  resolveWorkflowKey: vi.fn((appId?: string) => (appId ? `app:${appId}` : 'prompt:no-id')),
  // 模拟 executor 内部的工作流跟踪：同 key 跳过，不同/首次 free 并更新 key
  freeIfWorkflowChanged: vi.fn(),
  // 会话首个任务的无条件清理：直接 free 并更新 key
  forceFreeAndTrack: vi.fn()
}
vi.mock('../mcp/executor', () => mocks)
vi.mock('..', () => ({
  default: {
    getConfig: () => ({ comfy_origin: 'http://localhost:8188' }),
    getServerPort: () => 3008
  }
}))
vi.mock('../utils/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))
vi.mock('electron', () => ({ default: { getPath: () => '' } }))

const { buildItemPrompt, convertValueByType, getSeed } = await import('./batchRunner')

const basePrompt = {
  '1': { class_type: 'KSampler', inputs: { seed: 123, steps: 20 } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'default' } }
} as const

const mapping = [
  { id: '3', key: 'text', category: 'input', valueType: 'string', valueMap: { key: 'prompt' } },
  { id: '1', key: 'steps', category: 'input', valueType: 'number', valueMap: { key: 'n' } },
  {
    id: '2',
    key: 'ckpt_name',
    category: 'input',
    valueType: 'string',
    manualValue: 'fixed.safetensors'
  }
]

describe('convertValueByType', () => {
  it('converts number/boolean/object', () => {
    expect(convertValueByType('42', 'number')).toBe(42)
    expect(convertValueByType('true', 'boolean')).toBe(true)
    expect(convertValueByType('off', 'boolean')).toBe(false)
    expect(convertValueByType('{"a":1}', 'object')).toEqual({ a: 1 })
    expect(() => convertValueByType('abc', 'number')).toThrow()
    expect(() => convertValueByType('maybe', 'boolean')).toThrow()
  })
})

describe('getSeed', () => {
  it('returns 15-digit number with non-zero lead', () => {
    for (let i = 0; i < 20; i++) {
      const s = getSeed()
      expect(String(s)).toHaveLength(15)
      expect(String(s)[0]).not.toBe('0')
    }
  })
})

describe('buildItemPrompt', () => {
  it('does not mutate the base template', () => {
    const before = JSON.stringify(basePrompt)
    buildItemPrompt(basePrompt as never, mapping, { prompt: 'hi', n: 5 })
    expect(JSON.stringify(basePrompt)).toBe(before)
  })

  it('randomizes numeric seed fields', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, {}) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    const seed = out['1']!.inputs['seed']
    expect(typeof seed).toBe('number')
    expect(seed).not.toBe(123)
  })

  it('merges valueMap with type conversion and manualValue wins when no map', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, {
      prompt: 'hello',
      n: '30'
    }) as Record<string, { inputs: Record<string, unknown> }>
    expect(out['3']!.inputs['text']).toBe('hello')
    expect(out['1']!.inputs['steps']).toBe(30) // number, not string
    expect(out['2']!.inputs['ckpt_name']).toBe('fixed.safetensors')
  })

  it('keeps template default when mapped field missing from data row', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, {}) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    expect(out['3']!.inputs['text']).toBe('default')
  })

  it('falls back to raw value on conversion failure', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, { n: 'not-a-number' }) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    expect(out['1']!.inputs['steps']).toBe('not-a-number')
  })
})

// ---------- 队列引擎（executor 全 mock，单条 item ~1s 内成功） ----------

const queueFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bq-')), 'queue.json')

const mkOpts = (over: Partial<BatchStartOptions> = {}): BatchStartOptions => ({
  prompt: basePrompt as never,
  inputsMapping: [],
  items: [{ a: 1 }],
  ...over
})

type BatchRunnerModule = typeof BatchRunnerNS

/** 等待队列满足 predicate（执行是异步的） */
async function waitFor(
  predicate: () => boolean,
  timeoutMs = 15000,
  intervalMs = 50
): Promise<void> {
  const t0 = Date.now()
  while (!predicate()) {
    if (Date.now() - t0 > timeoutMs) throw new Error('waitFor timeout')
    await new Promise((r) => setTimeout(r, intervalMs))
  }
}

/** 收尾：停掉全部（当前 + 排队），等无 running 任务，避免残留任务污染下个测试 */
async function settleQueue(mod: BatchRunnerModule): Promise<void> {
  await mod.stopBatch({ stopAll: true })
  await waitFor(() => !mod.isBatchRunning(), 5000, 50)
}

beforeAll(() => {
  process.env.BATCH_QUEUE_FILE = queueFile
})

afterAll(() => {
  delete process.env.BATCH_QUEUE_FILE
})

describe('batch queue engine', () => {
  let lastWfKey: string | null

  beforeEach(() => {
    // 固定 mock 对象，只重置行为；resetModules 拿到干净 jobs 队列；
    // 删掉持久化文件，避免上一个测试的防抖落盘被 loadQueue 读到。
    lastWfKey = null
    mocks.queuePrompt.mockReset().mockResolvedValue('pid-1')
    mocks.getHistory.mockReset().mockResolvedValue({ status: { status_str: 'success' } })
    mocks.stopExecution.mockReset().mockResolvedValue(undefined)
    mocks.freeModels.mockReset().mockResolvedValue(undefined)
    mocks.freeIfWorkflowChanged
      .mockReset()
      .mockImplementation(async (_origin: string, key: string) => {
        if (lastWfKey === key) return false
        lastWfKey = key
        await mocks.freeModels('http://localhost:8188')
        return true
      })
    mocks.forceFreeAndTrack.mockReset().mockImplementation(async (_origin: string, key: string) => {
      await mocks.freeModels('http://localhost:8188')
      lastWfKey = key
    })
    vi.resetModules()
    fs.rmSync(queueFile, { force: true })
  })

  it('enqueues instead of rejecting when another task is queued', async () => {
    const mod = await import('./batchRunner')
    const r1 = await mod.startBatch(mkOpts({ appId: 'app-a' }))
    const r2 = await mod.startBatch(mkOpts({ appId: 'app-b' }))
    // pump 同步把队头标 running，后入队的保持 queued
    expect(['queued', 'running']).toContain(r1.job.status)
    expect(r2.job.status).toBe('queued')
    expect(mod.listBatchQueue()).toHaveLength(2)
    expect(mod.isBatchRunning()).toBe(true)
    await settleQueue(mod)
  })

  it('session-first job frees unconditionally; different workflows free per job', async () => {
    const mod = await import('./batchRunner')
    const r1 = await mod.startBatch(mkOpts({ appId: 'app-a' }))
    const r2 = await mod.startBatch(mkOpts({ appId: 'app-b' }))
    await waitFor(() =>
      mod
        .listBatchQueue()
        .every((j) => j.status === 'completed' || j.status === 'stopped' || j.status === 'failed')
    )
    const q = mod.listBatchQueue()
    expect(q.find((j) => j.id === r1.job.id)?.status).toBe('completed')
    expect(q.find((j) => j.id === r2.job.id)?.status).toBe('completed')
    // 任务1 = 会话首个 → 无条件 free；任务2 不同工作流 → 也 free
    expect(mocks.forceFreeAndTrack).toHaveBeenCalledTimes(1)
    expect(mocks.freeIfWorkflowChanged).toHaveBeenCalledTimes(1)
    expect(mocks.freeModels).toHaveBeenCalledTimes(2)
    expect(mocks.queuePrompt).toHaveBeenCalledTimes(2)
  })

  it('second same-workflow job skips free after session-first unconditional free', async () => {
    const mod = await import('./batchRunner')
    await mod.startBatch(mkOpts({ appId: 'same' }))
    await mod.startBatch(mkOpts({ appId: 'same' }))
    await waitFor(() => mod.listBatchQueue().every((j) => j.status === 'completed'))
    // 任务1 = 会话首个 → 无条件 free（1 次）；任务2 同工作流 → 跳过
    expect(mocks.forceFreeAndTrack).toHaveBeenCalledTimes(1)
    expect(mocks.freeIfWorkflowChanged).toHaveBeenCalledTimes(1)
    expect(mocks.freeModels).toHaveBeenCalledTimes(1)
  })

  it('new idle session re-arms unconditional free for first job', async () => {
    const mod = await import('./batchRunner')
    // 第一轮：任务1 无条件 free，任务2 同工作流跳过
    await mod.startBatch(mkOpts({ appId: 'app-x' }))
    await mod.startBatch(mkOpts({ appId: 'app-x' }))
    await waitFor(() => mod.listBatchQueue().every((j) => j.status === 'completed'))
    expect(mocks.freeModels).toHaveBeenCalledTimes(1)
    // 队列空闲后提交新一轮 → 首个任务再次无条件 free（模拟用户去了 C 界面再回来）
    await mod.startBatch(mkOpts({ appId: 'app-x' }))
    await waitFor(() => mod.listBatchQueue().filter((j) => j.status === 'completed').length === 3)
    expect(mocks.forceFreeAndTrack).toHaveBeenCalledTimes(2)
    expect(mocks.freeModels).toHaveBeenCalledTimes(2)
  })

  it('cancel removes a queued job', async () => {
    const mod = await import('./batchRunner')
    const r1 = await mod.startBatch(mkOpts())
    const r2 = await mod.startBatch(mkOpts())
    const removed = await mod.cancelBatchJob(r2.job.id)
    expect(removed).toBe(true)
    expect(mod.listBatchQueue()).toHaveLength(1)
    expect(mod.listBatchQueue()[0]!.id).toBe(r1.job.id)
    await settleQueue(mod)
  })

  it('stopAll marks queued jobs as stopped', async () => {
    const mod = await import('./batchRunner')
    await mod.startBatch(mkOpts())
    const r2 = await mod.startBatch(mkOpts())
    await mod.stopBatch({ stopAll: true })
    const q = mod.listBatchQueue()
    expect(q.find((j) => j.id === r2.job.id)?.status).toBe('stopped')
    expect(mocks.stopExecution).toHaveBeenCalled()
    await settleQueue(mod)
  })

  it('moveBatchJob brings a queued job to front', async () => {
    const mod = await import('./batchRunner')
    await mod.startBatch(mkOpts())
    const r2 = await mod.startBatch(mkOpts())
    const r3 = await mod.startBatch(mkOpts())
    expect(mod.moveBatchJob(r3.job.id)).toBe(true)
    const queued = mod.listBatchQueue().filter((j) => j.status === 'queued')
    expect(queued[0]!.id).toBe(r3.job.id)
    expect(queued[1]!.id).toBe(r2.job.id)
    await settleQueue(mod)
  })

  it('clear removes finished jobs only', async () => {
    const mod = await import('./batchRunner')
    await mod.startBatch(mkOpts())
    await mod.startBatch(mkOpts())
    await waitFor(() =>
      mod.listBatchQueue().every((j) => j.status !== 'queued' && j.status !== 'running')
    )
    const removed = mod.clearBatchQueue()
    expect(mod.listBatchQueue()).toHaveLength(0)
    expect(removed).toBeGreaterThan(0)
  })

  it('rejects when queue is full', async () => {
    const mod = await import('./batchRunner')
    for (let i = 0; i < mod.MAX_QUEUED; i++) {
      await mod.startBatch(mkOpts())
    }
    await expect(mod.startBatch(mkOpts())).rejects.toThrow(/queue is full/)
    await settleQueue(mod)
  })

  it('loadQueue restores: running marked failed, queued paused until resume', async () => {
    vi.resetModules()
    fs.writeFileSync(
      queueFile,
      JSON.stringify([
        {
          id: 'r1',
          status: 'running',
          startFrom: 1,
          total: 1,
          processed: 0,
          success: 0,
          failed: 0,
          percent: 0,
          currentIndex: 0,
          currentPreview: '',
          createdAt: 'now',
          updatedAt: 'now',
          prompt: {},
          inputsMapping: [],
          items: [],
          logs: [],
          results: []
        },
        {
          id: 'q1',
          status: 'queued',
          startFrom: 1,
          total: 1,
          processed: 0,
          success: 0,
          failed: 0,
          percent: 0,
          currentIndex: 0,
          currentPreview: '',
          createdAt: 'now',
          updatedAt: 'now',
          prompt: {},
          inputsMapping: [],
          items: [{ a: 1 }],
          logs: [],
          results: []
        }
      ])
    )
    const mod2 = await import('./batchRunner')
    mod2.loadQueue()
    const q = mod2.listBatchQueue()
    expect(q.find((j) => j.id === 'r1')?.status).toBe('failed')
    // 排队任务保持 queued 且队列暂停：不自动执行
    expect(q.find((j) => j.id === 'q1')?.status).toBe('queued')
    expect(mod2.isQueuePaused()).toBe(true)
    expect(mocks.queuePrompt).not.toHaveBeenCalled()
    // 人工恢复后才开始执行
    expect(mod2.resumeQueue()).toBe(true)
    expect(mod2.isQueuePaused()).toBe(false)
    await waitFor(() => mod2.listBatchQueue().find((j) => j.id === 'q1')?.status === 'completed')
    await mod2.stopBatch({ stopAll: true })
  })

  it('new submission unpauses a paused queue', async () => {
    vi.resetModules()
    fs.writeFileSync(
      queueFile,
      JSON.stringify([
        {
          id: 'q1',
          status: 'queued',
          startFrom: 1,
          total: 1,
          processed: 0,
          success: 0,
          failed: 0,
          percent: 0,
          currentIndex: 0,
          currentPreview: '',
          createdAt: 'now',
          updatedAt: 'now',
          prompt: {},
          inputsMapping: [],
          items: [{ a: 1 }],
          logs: [],
          results: []
        }
      ])
    )
    const mod = await import('./batchRunner')
    mod.loadQueue()
    expect(mod.isQueuePaused()).toBe(true)
    // 用户主动提交新任务 = 恢复队列
    await mod.startBatch(mkOpts({ appId: 'new' }))
    expect(mod.isQueuePaused()).toBe(false)
    await waitFor(() =>
      mod.listBatchQueue().every((j) => j.status !== 'queued' && j.status !== 'running')
    )
    await mod.stopBatch({ stopAll: true })
  })

  it('natural completion triggers auto-shutdown once', async () => {
    const mod = await import('./batchRunner')
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    await mod.startBatch(mkOpts({ autoShutdown: true }))
    await waitFor(() => fetchSpy.mock.calls.some(([u]) => String(u).includes('/api/shutdown')))
    expect(fetchSpy.mock.calls.filter(([u]) => String(u).includes('/api/shutdown'))).toHaveLength(1)
    vi.unstubAllGlobals()
  })

  it('manual stop suppresses auto-shutdown', async () => {
    const mod = await import('./batchRunner')
    const fetchSpy = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchSpy)
    await mod.startBatch(mkOpts({ autoShutdown: true }))
    await mod.startBatch(mkOpts())
    await mod.stopBatch({ stopAll: true })
    // 等队列全部终态（含被中断的 running → stopped）
    await waitFor(() =>
      mod.listBatchQueue().every((j) => j.status === 'stopped' || j.status === 'failed')
    )
    // 给 pump 收尾留时间，确认没有触发关机请求
    await new Promise((r) => setTimeout(r, 100))
    expect(fetchSpy.mock.calls.some(([u]) => String(u).includes('/api/shutdown'))).toBe(false)
    vi.unstubAllGlobals()
  })
})
