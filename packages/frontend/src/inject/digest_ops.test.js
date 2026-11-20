// @vitest-environment happy-dom
/**
 * 注入桥「画布 op 应用」单测（2026-09-19）
 *
 * `applyOneOp` / `applyCanvasOps` 是注入脚本里唯一真正**改宿主画布**的代码：
 * 工作台下发的 setWidget / addNode / removeNode / relink / loadWorkflow / align /
 * autoLayout 全部经它落到 ComfyUI 的 LiteGraph 图上。它此前零测试。
 *
 * 这里只注入桩 graph（`g._nodes` + `add/remove/links`）与 `window.LiteGraph`，
 * 不碰真 ComfyUI —— 断言的是**语义**：错误文案、before/after 回执、对齐几何、
 * 单条失败不中断后续、loadWorkflow 是终态替换。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./canvas_patches.js', () => ({
  getComfyUIApp: () => ({ app: window.app, LiteGraph: window.LiteGraph }),
}))

import { applyOneOp, applyCanvasOps, findNodeById, pushCanvasDigest } from './digest.js'
import { CANVAS_BRIDGE, setEmbedWindow } from './card_bridge.js'
import { ARTIFY_MSG } from './protocol.js'

let warns

/** 桩 graph：够 findNodeById / add / remove / links 用 */
function makeG(nodes = [], links = {}) {
  const list = [...nodes]
  return {
    _nodes: list,
    links,
    add: vi.fn((n) => list.push(n)),
    remove: vi.fn((n) => {
      const i = list.indexOf(n)
      if (i >= 0) list.splice(i, 1)
    }),
    change: vi.fn(),
    setDirtyCanvas: vi.fn(),
  }
}

/** 桩节点：widgets / pos / size / inputs / outputs / connect 齐备 */
function makeNode(
  id,
  { x = 0, y = 0, w = 200, h = 100, widgets = [], inputs = [], outputs = [] } = {},
) {
  return {
    id,
    pos: [x, y],
    size: [w, h],
    widgets,
    inputs,
    outputs,
    connect: vi.fn(),
  }
}

/** 让 fire-and-forget 的摘要推送（pushCanvasDigest 未 await）在本用例内收尾 */
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(async () => {
  await flush() // 等上一用例的 pushCanvasDigest 跑完，否则 digestPushing 会卡住下一用例
  warns = []
  vi.spyOn(console, 'warn').mockImplementation((...a) => warns.push(a.join(' ')))
  delete window.app
  delete window.LiteGraph
  delete window.__ARTIFY_LAB_API__ // 不设 API → 摘要推送不发 fetch
  setEmbedWindow(null)
  CANVAS_BRIDGE.lastDigestJson = '' // 去重状态跨用例重置
  // 默认 fetch 桩：applyCanvasOps 末尾会 fire-and-forget 一次摘要推送，
  // 里面 fetch('/queue') 若不桩会打真网（happy-dom 解析成 localhost:3000 →
  // ECONNREFUSED，且挂起期间 digestPushing 恒 true → 后续用例被并发跳过）
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, status: 0, json: async () => ({}) })),
  )
})

afterEach(async () => {
  await flush() // 先让残留调用用着本轮 stub 跑完，再 restore（否则它去用真 fetch）
  delete window.app
  delete window.LiteGraph
  delete window.__ARTIFY_LAB_API__
  setEmbedWindow(null)
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('applyOneOp · setWidget（参数级写入）', () => {
  it('命中 → 回执带 before/after，且触发 widget.callback（seed 等控件依赖它同步内部态）', async () => {
    const cb = vi.fn()
    const node = makeNode(3, { widgets: [{ name: 'seed', value: 1, callback: cb }] })
    const g = makeG([node])

    const r = await applyOneOp(g, { type: 'setWidget', nodeId: 3, widget: 'seed', value: 42 })

    expect(r).toEqual({ ok: true, nodeId: 3, widget: 'seed', before: 1, after: 42 })
    expect(node.widgets[0].value).toBe(42)
    expect(cb).toHaveBeenCalledWith(42)
  })

  it('节点不存在 / widget 名不存在 → 分别是两条可读错误（便于回执 bisect）', async () => {
    const g = makeG([makeNode(3, { widgets: [{ name: 'seed', value: 1 }] })])

    expect((await applyOneOp(g, { type: 'setWidget', nodeId: 99, widget: 'seed' })).error).toBe(
      'node 99 not found',
    )
    expect((await applyOneOp(g, { type: 'setWidget', nodeId: 3, widget: 'nope' })).error).toBe(
      'widget nope not found on node 3',
    )
  })

  it('widget.callback 抛错被容忍（不回滚、不冒泡）', async () => {
    const node = makeNode(3, {
      widgets: [
        {
          name: 'seed',
          value: 1,
          callback: () => {
            throw new Error('控件内部炸了')
          },
        },
      ],
    })
    const g = makeG([node])

    const r = await applyOneOp(g, { type: 'setWidget', nodeId: 3, widget: 'seed', value: 7 })
    expect(r.ok).toBe(true)
    expect(node.widgets[0].value).toBe(7)
  })

  it('字符串 id 也能命中（前端 id 类型漂移容忍）', async () => {
    const g = makeG([makeNode(7, { widgets: [{ name: 'steps', value: 20 }] })])
    expect(findNodeById(g, '7')).toBeTruthy()
    expect(
      (await applyOneOp(g, { type: 'setWidget', nodeId: '7', widget: 'steps', value: 30 })).ok,
    ).toBe(true)
  })
})

describe('applyOneOp · addNode / removeNode', () => {
  it('addNode → createNode(type)，widgetsValues/pos 透传，add 到图', async () => {
    const created = makeNode(101)
    window.LiteGraph = { createNode: vi.fn(() => created) }
    const g = makeG()

    const r = await applyOneOp(g, {
      type: 'addNode',
      nodeType: 'KSampler',
      widgetsValues: [1, 20],
      pos: [10, 20],
    })

    expect(window.LiteGraph.createNode).toHaveBeenCalledWith('KSampler')
    expect(created.widgets_values).toEqual([1, 20])
    expect(created.pos).toEqual([10, 20])
    expect(g.add).toHaveBeenCalledWith(created)
    expect(r).toEqual({ ok: true, nodeId: 101, type: 'KSampler' })
  })

  it('未注册类型 → 报错且不 add', async () => {
    window.LiteGraph = { createNode: vi.fn(() => null) }
    const g = makeG()

    const r = await applyOneOp(g, { type: 'addNode', nodeType: 'NoSuchNode' })
    expect(r).toEqual({ ok: false, error: 'node type NoSuchNode not registered' })
    expect(g.add).not.toHaveBeenCalled()
  })

  it('未给 pos → 落到 [100,300) 区间（避免全叠在原点）', async () => {
    const created = makeNode(102)
    window.LiteGraph = { createNode: vi.fn(() => created) }
    await applyOneOp(makeG(), { type: 'addNode', nodeType: 'KSampler' })

    expect(created.pos[0]).toBeGreaterThanOrEqual(100)
    expect(created.pos[0]).toBeLessThan(300)
    expect(created.pos[1]).toBeGreaterThanOrEqual(100)
  })

  it('removeNode → g.remove(node)；找不到则报错', async () => {
    const node = makeNode(5)
    const g = makeG([node])

    expect(await applyOneOp(g, { type: 'removeNode', nodeId: 5 })).toEqual({ ok: true, nodeId: 5 })
    expect(g.remove).toHaveBeenCalledWith(node)
    expect((await applyOneOp(g, { type: 'removeNode', nodeId: 5 })).error).toBe('node 5 not found')
  })
})

describe('applyOneOp · relink', () => {
  it('成功 → from.connect(outIdx, to, inIdx)，回执带 slot 名', async () => {
    const from = makeNode(1, { outputs: [{ name: 'MODEL', links: [] }] })
    const to = makeNode(2, { inputs: [{ name: 'model', link: null }] })
    const g = makeG([from, to])

    const r = await applyOneOp(g, {
      type: 'relink',
      fromNodeId: 1,
      fromSlot: 0,
      toNodeId: 2,
      toSlot: 0,
    })

    expect(from.connect).toHaveBeenCalledWith(0, to, 0)
    expect(r).toEqual({ ok: true, from: 1, to: 2, slot: 'MODEL' })
  })

  it('端点节点缺失 / from slot 越界 → 分别报错（不静默连到 0 号口）', async () => {
    const from = makeNode(1, { outputs: [{ name: 'MODEL' }] })
    const g = makeG([from])

    expect(
      (await applyOneOp(g, { type: 'relink', fromNodeId: 1, toNodeId: 404, toSlot: 0 })).error,
    ).toBe('relink endpoint node not found')
    expect(
      (await applyOneOp(g, { type: 'relink', fromNodeId: 1, fromSlot: 9, toNodeId: 1, toSlot: 0 }))
        .error,
    ).toBe('from slot missing')
  })
})

describe('applyOneOp · 非法入参', () => {
  it('缺 op 或 op.type → op.type required', async () => {
    const g = makeG()
    expect((await applyOneOp(g, null)).error).toBe('op.type required')
    expect((await applyOneOp(g, {})).error).toBe('op.type required')
  })

  it('未知 type → unknown op type <name>', async () => {
    expect((await applyOneOp(makeG(), { type: 'teleport' })).error).toBe('unknown op type teleport')
  })
})

describe('applyOneOp · align / autoLayout（C 侧对齐落点）', () => {
  const boxes = () => [
    makeNode(1, { x: 0, y: 0, w: 200, h: 100 }),
    makeNode(2, { x: 300, y: 50, w: 100, h: 60 }),
  ]

  it('left → 左缘对齐到最小 x；right → 右缘齐平（用异宽节点，避免 no-op 假绿）', async () => {
    let g = makeG(boxes())
    await applyOneOp(g, { type: 'align', mode: 'left', nodes: [1, 2] })
    expect(g._nodes.map((n) => n.pos[0])).toEqual([0, 0])

    g = makeG(boxes())
    await applyOneOp(g, { type: 'align', mode: 'right', nodes: [1, 2] })
    // 最右缘 = 300+100 = 400 → 节点1 落在 400-200 = 200
    expect(g._nodes.map((n) => n.pos[0])).toEqual([200, 300])
  })

  it('hcenter → 中心对齐到包围盒中心（不要求等宽）', async () => {
    const g = makeG(boxes())
    await applyOneOp(g, { type: 'align', mode: 'hcenter', nodes: [1, 2] })
    const cx = (n) => n.pos[0] + n.size[0] / 2
    expect(Math.abs(cx(g._nodes[0]) - cx(g._nodes[1]))).toBeLessThan(0.01)
  })

  it('hdist → 等距分布，首尾不动（gap 由剩余空间除以间隔数）', async () => {
    const g = makeG([
      makeNode(1, { x: 0, w: 100 }),
      makeNode(2, { x: 200, w: 100 }),
      makeNode(3, { x: 500, w: 100 }),
    ])
    const r = await applyOneOp(g, { type: 'align', mode: 'hdist', nodes: [1, 2, 3] })

    const xs = g._nodes.map((n) => n.pos[0])
    expect(r).toEqual({ ok: true, count: 3, mode: 'hdist' })
    expect(xs[0]).toBe(0)
    expect(xs[2]).toBe(500)
    expect(g._nodes[1].pos[0] - (g._nodes[0].pos[0] + 100)).toBeCloseTo(
      g._nodes[2].pos[0] - (g._nodes[1].pos[0] + 100),
      1,
    )
  })

  it('未知 mode → 报错；节点为空且无选中 → no target nodes', async () => {
    const g = makeG(boxes())
    expect(
      (await applyOneOp(g, { type: 'align', mode: 'diagonal', nodes: [1, 2] })).error,
    ).toContain('unknown align mode')
    expect((await applyOneOp(makeG(), { type: 'align', mode: 'left' })).error).toBe(
      'no target nodes',
    )
  })

  it('autoLayout → 链式 A→B→C 分出三列，x 严格递增', async () => {
    // 1 → 2 → 3：links 用官方形状 {origin_id, target_id}
    const a = makeNode(1, { x: 500, y: 300 })
    const b = makeNode(2, { x: 0, y: 0, inputs: [{ name: 'in', link: 11 }] })
    const c = makeNode(3, { x: 0, y: 0, inputs: [{ name: 'in', link: 12 }] })
    const g = makeG([a, b, c], {
      11: { origin_id: 1, target_id: 2 },
      12: { origin_id: 2, target_id: 3 },
    })

    const r = await applyOneOp(g, { type: 'autoLayout', nodes: [1, 2, 3] })

    expect(r).toEqual({ ok: true, count: 3, direction: 'forward' })
    expect(a.pos[0]).toBeLessThan(b.pos[0])
    expect(b.pos[0]).toBeLessThan(c.pos[0])
  })
})

describe('applyCanvasOps · 批量语义', () => {
  it('空/非数组 → ops must be non-empty；图未就绪 → graph not ready', async () => {
    window.app = { graph: makeG() }
    expect((await applyCanvasOps([])).error).toBe('ops must be non-empty')
    expect((await applyCanvasOps(null)).error).toBe('ops must be non-empty')

    delete window.app
    expect((await applyCanvasOps([{ type: 'addNode' }])).error).toBe('graph not ready')
  })

  it('单条失败不中断后续：results 逐条记账，applied 只数成功的', async () => {
    const node = makeNode(3, { widgets: [{ name: 'seed', value: 1 }] })
    window.app = { graph: makeG([node]) }

    const r = await applyCanvasOps([
      { type: 'setWidget', nodeId: 404, widget: 'seed', value: 1 }, // 失败
      { type: 'setWidget', nodeId: 3, widget: 'seed', value: 9 }, // 成功
    ])

    expect(r.ok).toBe(true)
    expect(r.applied).toBe(1)
    expect(r.results).toHaveLength(2)
    expect(r.results[0]).toMatchObject({ ok: false, error: 'node 404 not found' })
    expect(r.results[1].ok).toBe(true)
  })

  it('全部失败 → ok:false（工作台据此报错，而不是假装成功）', async () => {
    window.app = { graph: makeG() }
    const r = await applyCanvasOps([{ type: 'removeNode', nodeId: 1 }])
    expect(r).toMatchObject({ ok: false, applied: 0 })
  })

  it('loadWorkflow 是终态替换：前面已有成功 op 时，后续 op 直接丢弃（不执行）', async () => {
    const node = makeNode(3, { widgets: [{ name: 'seed', value: 1 }] })
    window.app = { graph: makeG([node]) }

    const r = await applyCanvasOps([
      { type: 'setWidget', nodeId: 3, widget: 'seed', value: 5 },
      { type: 'loadWorkflow', workflow: { nodes: [] } }, // 不该被执行
      { type: 'removeNode', nodeId: 3 }, // 更不该执行
    ])

    expect(r.results).toHaveLength(1)
    expect(r.applied).toBe(1)
    expect(node.pos).toEqual([0, 0]) // 没被 remove
    expect(window.app.graph.remove).not.toHaveBeenCalled()
  })

  it('结构级 op 会 captureCanvasState（进官方 undo 栈）；纯 setWidget 不 capture', async () => {
    const capture = vi.fn()
    const node = makeNode(3, { widgets: [{ name: 'seed', value: 1 }] })
    window.app = {
      graph: makeG([node]),
      extensionManager: {
        workflow: { activeWorkflow: { changeTracker: { captureCanvasState: capture } } },
      },
    }

    await applyCanvasOps([{ type: 'setWidget', nodeId: 3, widget: 'seed', value: 2 }])
    expect(capture).not.toHaveBeenCalled()

    await applyCanvasOps([{ type: 'removeNode', nodeId: 3 }])
    expect(capture).toHaveBeenCalledTimes(1)
  })

  it('changeTracker 的 captureCanvasState 抛错不影响 ops 执行（撤销栈不可用也要能改画布）', async () => {
    const node = makeNode(3, { widgets: [{ name: 'seed', value: 1 }] })
    window.app = {
      graph: makeG([node]),
      extensionManager: {
        workflow: {
          activeWorkflow: {
            changeTracker: {
              captureCanvasState: () => {
                throw new Error('undo 栈坏了')
              },
            },
          },
        },
      },
    }

    const r = await applyCanvasOps([{ type: 'setWidget', nodeId: 3, widget: 'seed', value: 8 }])
    expect(r).toMatchObject({ ok: true, applied: 1 })
  })
})

describe('pushCanvasDigest · 画布摘要推送（C → A 实时那一路）', () => {
  /** 最小 app 桩：够 buildCanvasDigest 取节点/工作流名 */
  function seedApp() {
    window.app = {
      graph: {
        _nodes: [
          { id: 1, type: 'KSampler', widgets_values: [7, 20, 7.5, 'euler'] },
          { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['model.safetensors'] },
        ],
      },
      extensionManager: { workflow: { activeWorkflow: { name: 'wf-1' } } },
    }
  }

  /** fetch 桩：/queue 返回空队列，/api/canvas/snapshot 记账 */
  function stubFetch() {
    const calls = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url) => {
        calls.push(String(url))
        if (String(url).endsWith('/queue')) {
          return { ok: true, json: async () => ({ queue_running: [], queue_pending: [] }) }
        }
        return { ok: true, json: async () => ({ success: true }) }
      }),
    )
    return calls
  }

  it('embed 窗口就绪 → 推 CANVAS_STATE（工作台据此刷新画布认知）', async () => {
    seedApp()
    stubFetch()
    const posts = []
    setEmbedWindow({ postMessage: vi.fn((s) => posts.push(JSON.parse(s))) })

    await pushCanvasDigest(true)

    expect(posts).toHaveLength(1)
    expect(posts[0].type).toBe(ARTIFY_MSG.CANVAS_STATE)
    expect(posts[0].state).toMatchObject({
      workflowName: 'wf-1',
      nodeCount: 2,
      models: ['model.safetensors'],
      keyParams: { seed: 7, steps: 20, cfg: 7.5, sampler: 'euler' },
    })
    expect(warns).toEqual([]) // 修复前这里是 ReferenceError（被 catch 成 warn）
  })

  it('embed 未就绪 → 不发 message，但仍落 express 快照（服务端 PLAN 的画布上下文）', async () => {
    seedApp()
    const calls = stubFetch()
    window.__ARTIFY_LAB_API__ = 'http://api.test'
    setEmbedWindow(null)

    await pushCanvasDigest(true)

    expect(calls).toContain('http://api.test/api/canvas/snapshot')
    expect(warns).toEqual([])
  })

  it('内容没变（剥离 seq/ts 比较）→ 去重不发；画布变了才发', async () => {
    seedApp()
    stubFetch()
    const posts = []
    setEmbedWindow({ postMessage: vi.fn((s) => posts.push(JSON.parse(s))) })

    await pushCanvasDigest(false)
    await pushCanvasDigest(false)
    // 两次构建之间画布没动：虽然 seq/ts 必变，但去重签名剥离了它们 → 第二次被拦
    expect(posts).toHaveLength(1)

    // 画布真的变了（加节点）→ 内容签名变 → 推送，且 seq 仍递增（接收方防乱序）
    window.app.graph._nodes.push({
      id: 9,
      type: 'KSampler',
      widgets_values: [1, 2, 3, 'euler'],
    })
    await pushCanvasDigest(false)
    expect(posts).toHaveLength(2)
    expect(posts[1].state.nodeCount).toBe(3)
    expect(posts[1].state.seq).toBeGreaterThan(posts[0].state.seq)
  })

  it('force=true 总是发（GET_CANVAS_STATE / embed 重连依赖它）', async () => {
    seedApp()
    stubFetch()
    const posts = []
    setEmbedWindow({ postMessage: vi.fn((s) => posts.push(JSON.parse(s))) })

    await pushCanvasDigest(false)
    await pushCanvasDigest(true) // 内容没变也强制发
    expect(posts).toHaveLength(2)
  })
})
