/**
 * wb_build_workflow 单测：布局算法 / ops 结构 / 缺失模板处理 / SSE 桥注册表。
 * 不触真实 SSE——emit 桥用注入的 spy 断言。
 */
// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'

// electron app.getPath 被 lib/paths 依赖（service → mcp auth 链），单测用 tmpdir 顶替
vi.mock('electron', () => ({
  app: {
    getAppPath: () => process.cwd(),
    getPath: () => process.env.TMPDIR || '/tmp'
  }
}))

vi.mock('../../workbench/service', () => {
  const templates = [
    { id: 'app:aaa', name: '文生图', mediaType: 'image', prompt: {} },
    { id: 'app:bbb', name: '图生视频', mediaType: 'video', prompt: {} },
    { id: 'app:ccc', name: '配音', mediaType: 'audio', prompt: {} }
  ]
  return {
    workbenchService: {
      getSession: vi.fn((id: string) => (id ? { id } : null)),
      listTemplates: vi.fn(() => templates),
      // 跟着真实实现的口径：容忍 app:<uuid> 与裸 uuid 两种写法
      // （真实实现走 templateLibrary.get，见 templateIdContract.test.ts）
      resolveTemplate: vi.fn((_sid: string, id: string) => {
        const norm = id.startsWith('app:') ? id : `app:${id}`
        return templates.find((t) => t.id === norm) ?? null
      })
    }
  }
})
// 打断循环 import：service → workbenchTools → canvasTools（真实 service 会
// 把 workbenchTools 拉回来，而本测试 import 的 canvasTools 尚未初始化完成）
vi.mock('../workbenchTools', () => ({ createWorkbenchAugmentedRegistry: vi.fn() }))
// shared.ts 依赖链上的重模块（与 workbenchTools.test 同款 mock 形状）
vi.mock('../../appStore', () => ({
  default: { getConfig: () => ({ comfyHost: 'http://127.0.0.1:8188' }) }
}))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

import {
  buildCanvasOpsFromTemplateIds,
  registerCanvasOpsEmit,
  unregisterCanvasOpsEmit,
  clearCanvasOpsEmitsForTest,
  canvasTools
} from './canvasTools'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from './shared'
import type { CanvasAgentOp } from '../../workbench/plan'

// filter 不会自动收窄判别联合 → 显式类型谓词，才能安全访问 nodeId / from / to
type AddOp = Extract<CanvasAgentOp, { type: 'add_app_node' }>
type ConnectOp = Extract<CanvasAgentOp, { type: 'connect_nodes' }>
type SelectOp = Extract<CanvasAgentOp, { type: 'select_nodes' }>
const addsOf = (ops: CanvasAgentOp[]): AddOp[] =>
  ops.filter((o): o is AddOp => o.type === 'add_app_node')
const connectsOf = (ops: CanvasAgentOp[]): ConnectOp[] =>
  ops.filter((o): o is ConnectOp => o.type === 'connect_nodes')
const selectsOf = (ops: CanvasAgentOp[]): SelectOp[] =>
  ops.filter((o): o is SelectOp => o.type === 'select_nodes')

describe('buildCanvasOpsFromTemplateIds', () => {
  beforeEach(() => {
    clearCanvasOpsEmitsForTest()
  })

  it('单模板：一个 add_app_node（网格原点）+ select_nodes', () => {
    const r = buildCanvasOpsFromTemplateIds('s1', ['app:aaa'])
    expect(r.missing).toEqual([])
    expect(r.ops).toHaveLength(2)
    expect(r.ops[0]).toMatchObject({
      type: 'add_app_node',
      appId: 'app:aaa',
      name: '文生图',
      x: 80,
      y: 80
    })
    expect(r.ops[1]?.type).toBe('select_nodes')
  })

  it('三模板：3 add + 2 connect（链式 A→B→C）+ select；网格第二行换行', () => {
    const r = buildCanvasOpsFromTemplateIds('s1', ['app:aaa', 'app:bbb', 'app:ccc'])
    const adds = addsOf(r.ops)
    const connects = connectsOf(r.ops)
    expect(adds).toHaveLength(3)
    // 连接引用的是**本批 add 的 nodeId**（画布对象 id 空间），不是模板 id。
    // 旧断言写的是 'app:app:aaa' —— 那正是前端永远匹配不到、连线被静默丢弃的 bug。
    const refs = adds.map((a) => a.nodeId)
    expect(connects.map((c) => [c.from, c.to])).toEqual([
      [refs[0], refs[1]],
      [refs[1], refs[2]]
    ])
    // 确认卡在应用前渲染，无法反查名字 → 工具侧带 fromName/toName
    expect(connects[0]).toMatchObject({ fromName: '文生图', toName: '图生视频' })
    // 网格坐标：3 列布局，index 0/1/2 都在第一行
    expect(adds[0]).toMatchObject({ x: 80, y: 80 })
    expect(adds[1]).toMatchObject({ x: 80 + 360, y: 80 })
    expect(adds[2]).toMatchObject({ x: 80 + 720, y: 80 })
  })

  it('缺失模板进 missing，不产出 add；全缺失时 ops 为空', () => {
    const r = buildCanvasOpsFromTemplateIds('s1', ['app:aaa', 'app:zzz'])
    expect(r.missing).toEqual(['app:zzz'])
    expect(r.placed).toHaveLength(1)
    const none = buildCanvasOpsFromTemplateIds('s1', ['nope'])
    expect(none.ops).toEqual([])
    expect(none.missing).toEqual(['nope'])
  })
})

/**
 * 画布 ops 的 **id 空间契约**（2026-09-15 修）。
 *
 * 前端 `applyOneAgentOp` 里 connect_nodes / select_nodes / update_node 都按
 * `objects.find(o => o.id === ...)` 解析——要的是**画布对象 id**，由前端
 * `makeAppNode` 生成（`'a'+ts+rand`）；而这里此前下发的是模板 id（`app:<uuid>`，
 * 还因重复加前缀变成 `app:app:...`）→ 前端永远匹配不到，**连线被静默丢弃**。
 *
 * 本 describe 钉住**主进程侧的半边**：所有节点引用必须落在本批 add 的 nodeId 上。
 * **前端侧的半边**见 `packages/frontend/src/views/canvas/composables.test.js` 的
 * 「工具产出的 ops 批次」用例——两半合起来才是完整的跨边界契约（此前两侧各自
 * 用不同的 id 空间、各自都绿，所以没人发现）。
 */
describe('canvas ops id 空间契约（主进程侧半边）', () => {
  it('connect / select 的每个引用都落在本批 add 的 nodeId 上', () => {
    const r = buildCanvasOpsFromTemplateIds('s1', ['app:aaa', 'app:bbb', 'app:ccc'])
    const addRefs = new Set(addsOf(r.ops).map((o) => o.nodeId))
    expect(addRefs.size).toBe(3)

    for (const op of connectsOf(r.ops)) {
      expect(addRefs.has(op.from)).toBe(true)
      expect(addRefs.has(op.to)).toBe(true)
    }
    const selects = selectsOf(r.ops)
    expect(selects).toHaveLength(1)
    expect(selects[0]!.ids).toHaveLength(3)
    for (const id of selects[0]!.ids) expect(addRefs.has(id)).toBe(true)
  })

  it('nodeId 批内唯一，且不含 app: 模板前缀（不产出 app:app: 双前缀）', () => {
    // 同一模板重复两次也必须拿到不同引用：否则前端 Vue key / 查找都会撞
    const r = buildCanvasOpsFromTemplateIds('s1', ['app:aaa', 'app:aaa'])
    const refs = addsOf(r.ops).map((o) => String(o.nodeId ?? ''))
    expect(refs).toHaveLength(2)
    expect(new Set(refs).size).toBe(2)
    for (const ref of refs) {
      expect(ref.startsWith('app:')).toBe(false)
      expect(ref.startsWith('wf-')).toBe(true)
    }
  })

  it('模板 id 两种口径都能解析（app:<uuid> 与裸 uuid），下发一律规范口径', () => {
    const dashed = buildCanvasOpsFromTemplateIds('s1', ['app:aaa'])
    const bare = buildCanvasOpsFromTemplateIds('s1', ['aaa'])
    expect(dashed.missing).toEqual([])
    expect(bare.missing).toEqual([])
    expect(bare.placed[0]?.appId).toBe('app:aaa')
  })
})

describe('canvasTools 注册与 SSE 桥', () => {
  beforeEach(() => {
    clearCanvasOpsEmitsForTest()
    endWorkbenchToolContext('sess-1')
    endWorkbenchToolContext('sess-2')
    endWorkbenchToolContext('sess-3')
  })

  it('wb_build_workflow 在工具清单中且 schema 必填 template_ids', () => {
    const t = canvasTools.find((w) => w.tool.name === 'wb_build_workflow')
    expect(t).toBeTruthy()
    expect((t!.tool.inputSchema as { required?: string[] }).required).toContain('template_ids')
  })

  it('run 活跃（已注册 emit）→ dispatched:true，ops 经桥直推', async () => {
    beginWorkbenchToolContext('sess-1')
    const spy = vi.fn()
    registerCanvasOpsEmit('sess-1', spy)
    const t = canvasTools.find((w) => w.tool.name === 'wb_build_workflow')!
    const res = (await t.fn({ template_ids: ['app:aaa', 'app:bbb'] }, 'sess-1')) as {
      content: Array<{ text?: string }>
    }
    const payload = JSON.parse(res.content[0]?.text ?? '{}') as {
      ok: boolean
      dispatched: boolean
    }
    expect(payload.ok).toBe(true)
    expect(payload.dispatched).toBe(true)
    expect(spy).toHaveBeenCalledTimes(1)
    const [ops, meta] = spy.mock.calls[0] as [Array<{ type: string }>, { source: string }]
    expect(ops.filter((o) => o.type === 'add_app_node')).toHaveLength(2)
    expect(meta.source).toBe('wb_build_workflow')
  })

  it('无 run（未注册）→ dispatched:false，ops 原样返回', async () => {
    beginWorkbenchToolContext('sess-2')
    const t = canvasTools.find((w) => w.tool.name === 'wb_build_workflow')!
    const res = (await t.fn({ template_ids: ['app:aaa'] }, 'sess-2')) as {
      content: Array<{ text?: string }>
    }
    const payload = JSON.parse(res.content[0]?.text ?? '{}') as {
      dispatched: boolean
      ops: unknown[]
    }
    expect(payload.dispatched).toBe(false)
    expect(payload.ops?.length).toBeGreaterThan(0)
  })

  it('unregister 后桥不再投递', async () => {
    beginWorkbenchToolContext('sess-3')
    const spy = vi.fn()
    registerCanvasOpsEmit('sess-3', spy)
    unregisterCanvasOpsEmit('sess-3')
    const t = canvasTools.find((w) => w.tool.name === 'wb_build_workflow')!
    const res = (await t.fn({ template_ids: ['app:aaa'] }, 'sess-3')) as {
      content: Array<{ text?: string }>
    }
    const payload = JSON.parse(res.content[0]?.text ?? '{}') as { dispatched: boolean }
    expect(payload.dispatched).toBe(false)
    expect(spy).not.toHaveBeenCalled()
  })
})
