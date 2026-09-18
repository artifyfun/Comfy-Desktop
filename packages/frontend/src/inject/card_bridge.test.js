// @vitest-environment happy-dom
/**
 * 注入桥消息面单测（2026-09-19）
 *
 * 背景：`src/inject/` 14 个模块此前**零测试**，而 `handleArtifyMessage` 是
 * 「工作台 iframe ↔ 宿主画布」唯一写通道 —— 它决定了 A 面（workbench）发来的
 * `artify:canvas-ops` / `artify:canvas-execute` 怎么落成宿主操作、怎么回 ack、
 * 失败怎么透传。W16 只验了 A 面这一侧的协议形状（假宿主），真桥的实现一直是盲区。
 *
 * 这里把 digest 侧（applyCanvasOps / checkpoint / 摘要推送）mock 掉，
 * 只钉 card_bridge 自己的职责：**路由 + ack 形状 + 提交流程 + 失败透传**。
 * digest 的真实 op 语义属于另一层（依赖 LiteGraph/ComfyUI 全局）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./digest.js', () => ({
  pushCanvasDigest: vi.fn(),
  applyCanvasOps: vi.fn(async (ops) => ({
    ok: true,
    applied: ops.length,
    results: ops.map(() => ({ ok: true })),
  })),
  saveExpressCheckpoint: vi.fn(async () => 'cp-test-1'),
}))
vi.mock('./card_node.js', () => ({
  ARTIFY_CARD_TYPE: 'ArtifyDisplayCard',
  getCardApp: vi.fn(() => null), // 无 app：只 warn 不抛
}))

import { pushCanvasDigest, applyCanvasOps, saveExpressCheckpoint } from './digest.js'
import { getCardApp } from './card_node.js'
import {
  handleArtifyMessage,
  postToEmbed,
  sendCardsToEmbed,
  setEmbedWindow,
} from './card_bridge.js'
import { ARTIFY_MSG } from './protocol.js'

/** 捕获回执：假 embed window 收到的所有 postMessage（JSON 解析后） */
let embedPosts
let fakeEmbed
/** 捕获 console.warn（断言「不抛、只告警」的降级路径） */
let warns

function setApp(app) {
  window.app = app
}

function graphApp(extra = {}) {
  return {
    graph: { _nodes: [] },
    graphToPrompt: vi.fn(async () => ({
      workflow: { nodes: [{ id: 1 }], links: [] },
      output: { 1: { class_type: 'KSampler', inputs: { seed: 1 } } },
    })),
    ...extra,
  }
}

/** 标准 fetch 响应桩 */
function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body }
}

beforeEach(() => {
  embedPosts = []
  fakeEmbed = { postMessage: vi.fn((s) => embedPosts.push(JSON.parse(s))) }
  setEmbedWindow(fakeEmbed)
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...a) => warns.push(a.join(' ')))
  window.__ARTIFY_LAB_API__ = 'http://api.test'
  delete window.app
  vi.clearAllMocks()
  vi.mocked(applyCanvasOps).mockResolvedValue({ ok: true, applied: 1, results: [{ ok: true }] })
  vi.mocked(saveExpressCheckpoint).mockResolvedValue('cp-test-1')
  vi.mocked(getCardApp).mockReturnValue(null)
})

afterEach(() => {
  setEmbedWindow(null)
  delete window.app
  delete window.__ARTIFY_LAB_API__
  vi.restoreAllMocks()
})

describe('CANVAS_OPS —— 工作台下发画布指令', () => {
  it('结构级 op → 先落 checkpoint，ack 带 checkpointId 与 requestId', async () => {
    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_OPS,
      requestId: 'r-1',
      reason: 'wb_sync',
      ops: [{ type: 'addNode', classType: 'KSampler' }],
    })

    expect(saveExpressCheckpoint).toHaveBeenCalledWith('wb_sync')
    expect(applyCanvasOps).toHaveBeenCalledTimes(1)
    expect(embedPosts).toEqual([
      {
        type: ARTIFY_MSG.CANVAS_OPS_RESULT,
        requestId: 'r-1',
        checkpointId: 'cp-test-1',
        ok: true,
        applied: 1,
        results: [{ ok: true }],
      },
    ])
  })

  it('纯 setWidget（参数级）→ 不落 checkpoint（checkpointId null）', async () => {
    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_OPS,
      requestId: 'r-2',
      ops: [{ type: 'setWidget', nodeId: '3', name: 'seed', value: 7 }],
    })

    expect(saveExpressCheckpoint).not.toHaveBeenCalled()
    expect(embedPosts[0]).toMatchObject({ requestId: 'r-2', checkpointId: null, ok: true })
  })

  it('applyCanvasOps 抛错 → ack {ok:false,error}，错误截断 120 字符', async () => {
    vi.mocked(applyCanvasOps).mockRejectedValueOnce(new Error('x'.repeat(400)))

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_OPS,
      requestId: 'r-3',
      ops: [{ type: 'loadWorkflow' }],
    })

    const ack = embedPosts[0]
    expect(ack.ok).toBe(false)
    expect(ack.error.length).toBe(120)
    expect(ack.requestId).toBe('r-3')
  })

  it('checkpoint 返回 null（express 未起/无 app）也不阻塞 applyCanvasOps', async () => {
    vi.mocked(saveExpressCheckpoint).mockResolvedValueOnce(null)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_OPS,
      requestId: 'r-4',
      ops: [{ type: 'addNode' }],
    })

    expect(applyCanvasOps).toHaveBeenCalled()
    expect(embedPosts[0]).toMatchObject({ checkpointId: null, ok: true })
  })
})

describe('CANVAS_EXECUTE —— 执行宿主当前工作流', () => {
  it('画布未就绪（无 app）→ ack 报 graphToPrompt unavailable，且不 fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({ type: ARTIFY_MSG.CANVAS_EXECUTE, requestId: 'e-1' })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(embedPosts[0]).toMatchObject({
      type: ARTIFY_MSG.CANVAS_EXECUTE_RESULT,
      requestId: 'e-1',
      ok: false,
    })
    expect(embedPosts[0].error).toContain('graphToPrompt unavailable')
  })

  it('单次执行 → POST /api/canvas/execute，body 用 graphToPrompt().output 作为 prompt', async () => {
    setApp(graphApp())
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes({ success: true, data: { promptId: 'p-9' } }))
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_EXECUTE,
      requestId: 'e-2',
      nodeOverrides: { 3: { seed: 42 } },
      name: 'my-wf',
      sessionId: 's-1',
    })

    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe('http://api.test/api/canvas/execute')
    expect(JSON.parse(init.body)).toEqual({
      prompt: { 1: { class_type: 'KSampler', inputs: { seed: 1 } } },
      nodeOverrides: { 3: { seed: 42 } },
      name: 'my-wf',
      sessionId: 's-1',
    })
    expect(embedPosts[0]).toMatchObject({ ok: true, promptId: 'p-9', requestId: 'e-2' })
  })

  it('graphToPrompt 直接返回 prompt（无 output 包装）也能取到', async () => {
    setApp(graphApp({ graphToPrompt: vi.fn(async () => ({ 5: { class_type: 'SaveImage' } })) }))
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonRes({ success: true, data: { promptId: 'p-10' } }))
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({ type: ARTIFY_MSG.CANVAS_EXECUTE, requestId: 'e-3' })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).prompt).toEqual({
      5: { class_type: 'SaveImage' },
    })
  })

  it('服务端 success:false → ack 透传服务端 message，不当作成功', async () => {
    setApp(graphApp())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonRes({ success: false, message: '队列已满' })),
    )

    await handleArtifyMessage({ type: ARTIFY_MSG.CANVAS_EXECUTE, requestId: 'e-4' })

    expect(embedPosts[0]).toMatchObject({ ok: false, requestId: 'e-4' })
    expect(embedPosts[0].error).toContain('队列已满')
  })

  it('HTTP 500 且 body 非 JSON → ack 报 HTTP 状态码（JSON 解析失败也要有可读错误）', async () => {
    setApp(graphApp())
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        json: async () => {
          throw new Error('not json')
        },
      }),
    )

    await handleArtifyMessage({ type: ARTIFY_MSG.CANVAS_EXECUTE, requestId: 'e-5' })

    expect(embedPosts[0]).toMatchObject({ ok: false })
    expect(embedPosts[0].error).toContain('HTTP 500')
  })
})

describe('CANVAS_EXECUTE 批量：行键「节点id.widget名」→ inputsMapping + items', () => {
  it('sharedParams 合并进每一行；行键解析出 id/key/valueMap', async () => {
    setApp(graphApp())
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ success: true, data: { jobId: 'j-1' } }))
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_EXECUTE,
      requestId: 'b-1',
      name: 'batch-wf',
      sessionId: 's-2',
      batch: {
        sharedParams: { '9.steps': 30 },
        items: [{ '3.seed': 1 }, { '3.seed': 2 }],
      },
    })

    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(fetchMock.mock.calls[0][0]).toBe('http://api.test/api/canvas/batch')
    expect(body.inputsMapping).toEqual([
      { id: '3', key: 'seed', valueMap: { key: '3.seed' } },
      { id: '9', key: 'steps', valueMap: { key: '9.steps' } },
    ])
    expect(body.items).toEqual([
      { '9.steps': 30, '3.seed': 1 },
      { '9.steps': 30, '3.seed': 2 },
    ])
    expect(embedPosts[0]).toMatchObject({ ok: true, jobId: 'j-1', batch: true, requestId: 'b-1' })
  })

  it('行键格式非法（无「id.名」）→ ack 报错且不 fetch', async () => {
    setApp(graphApp())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_EXECUTE,
      requestId: 'b-2',
      batch: { items: [{ badKey: 1 }, { badKey: 2 }] },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(embedPosts[0].error).toContain('节点id.widget名')
  })

  it('只有 1 行 → ack 报错（批量的意义在 ≥2 行）', async () => {
    setApp(graphApp())
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_EXECUTE,
      requestId: 'b-3',
      batch: { items: [{ '3.seed': 1 }] },
    })

    expect(fetchMock).not.toHaveBeenCalled()
    expect(embedPosts[0].error).toContain('至少 2 行')
  })

  it('「id/名」斜杠写法同样命中（正则同时接受 . 与 /）', async () => {
    setApp(graphApp())
    const fetchMock = vi.fn().mockResolvedValue(jsonRes({ success: true, data: { jobId: 'j-2' } }))
    vi.stubGlobal('fetch', fetchMock)

    await handleArtifyMessage({
      type: ARTIFY_MSG.CANVAS_EXECUTE,
      requestId: 'b-4',
      batch: { items: [{ '3/seed': 1 }, { '3/seed': 2 }] },
    })

    expect(JSON.parse(fetchMock.mock.calls[0][1].body).inputsMapping[0]).toEqual({
      id: '3',
      key: 'seed',
      valueMap: { key: '3/seed' },
    })
  })
})

describe('其他消息与回传通道', () => {
  it('GET_CANVAS_STATE → 触发摘要推送', async () => {
    await handleArtifyMessage({ type: ARTIFY_MSG.GET_CANVAS_STATE })
    expect(pushCanvasDigest).toHaveBeenCalled()
  })

  it('DISPLAY_CARD 在画布未就绪时只告警不抛（产物不丢帧、不打断）', async () => {
    await expect(
      handleArtifyMessage({ type: ARTIFY_MSG.DISPLAY_CARD, files: [{ filename: 'a.png' }] }),
    ).resolves.toBeUndefined()
    expect(warns.join('\n')).toContain('app not ready')
  })

  it('postToEmbed 在 iframe 未打开时静默丢弃（写通道只在 embed 打开时可用）', () => {
    setEmbedWindow(null)
    expect(() => postToEmbed({ type: 'x' })).not.toThrow()
    expect(fakeEmbed.postMessage).not.toHaveBeenCalled()
  })

  it('sendCardsToEmbed 无 embed window → 告警跳过；有则发 CARD_ATTACH（files 已展开）', () => {
    setEmbedWindow(null)
    sendCardsToEmbed([{ properties: { files: [{ filename: 'a.png' }] } }])
    expect(warns.join('\n')).toContain('card attach skipped')

    setEmbedWindow(fakeEmbed)
    sendCardsToEmbed([{ properties: { files: [{ filename: 'a.png' }] } }])
    expect(embedPosts).toEqual([{ type: ARTIFY_MSG.CARD_ATTACH, files: [{ filename: 'a.png' }] }])
  })
})
