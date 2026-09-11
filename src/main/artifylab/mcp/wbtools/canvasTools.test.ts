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
      listTemplates: vi.fn(() => templates)
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
    const adds = r.ops.filter((o) => o.type === 'add_app_node')
    const connects = r.ops.filter((o) => o.type === 'connect_nodes')
    expect(adds).toHaveLength(3)
    expect(connects).toEqual([
      { type: 'connect_nodes', from: 'app:app:aaa', to: 'app:app:bbb' },
      { type: 'connect_nodes', from: 'app:app:bbb', to: 'app:app:ccc' }
    ])
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
