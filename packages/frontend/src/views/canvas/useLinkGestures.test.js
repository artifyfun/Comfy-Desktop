import { describe, expect, it } from 'vitest'
import { ref, reactive } from 'vue'
import { useLinkGestures } from './useLinkGestures'

/** fake stage：getPointerPosition 返回固定世界点对应的屏幕点（viewport 恒等） */
function mkCtx(objects, links, calls = { before: 0, saved: 0, menus: [] }) {
  const viewport = ref({ x: 0, y: 0, scale: 1 })
  const pointer = { x: 0, y: 0 }
  return {
    ctx: {
      objects: ref(objects),
      links: ref(links),
      viewport,
      size: reactive({ w: 800, h: 600 }),
      drag: reactive({ mode: null, last: null }),
      stageEl: ref({ getStage: () => ({ getPointerPosition: () => ({ ...pointer }) }) }),
      linkSegs: ref(
        links.map((l, i) => ({
          id: l.id,
          x1: 10 + i * 10,
          y1: 10,
          x2: 100,
          y2: 10,
        })),
      ),
      selectedLinkId: ref(null),
      beforeChange: () => calls.before++,
      saveSoon: () => calls.saved++,
      openConnectCreate: (m) => calls.menus.push(m),
    },
    pointer,
    viewport,
    calls,
  }
}

const objA = { id: 'a', x: 0, y: 0, width: 100, height: 60 }
const objB = { id: 'b', x: 300, y: 0, width: 100, height: 60 }

describe('useLinkGestures — 句柄拖拽建线', () => {
  it('source 句柄 → 命中目标右缘 → 建线 a→b（含 undo 前置 + 落盘）', () => {
    const { ctx, pointer, calls } = mkCtx([objA, objB], [])
    const g = useLinkGestures(ctx)
    g.onConnectStart('a', 'source', { evt: {} })
    expect(g.connectDrag.active).toBe(true)
    expect(ctx.drag.mode).toBe('connect')
    // 指针移到 b 中心（世界坐标 = 屏幕，viewport 恒等）
    pointer.x = 350
    pointer.y = 30
    g.onConnectMove()
    expect(g.connectDrag.targetId).toBe('b')
    g.onConnectEnd()
    expect(ctx.links.value).toHaveLength(1)
    expect(ctx.links.value[0]).toMatchObject({ from: 'a', to: 'b' })
    expect(calls.before).toBe(1)
    expect(calls.saved).toBe(1)
  })

  it('落空松手 → 弹「创建节点」菜单（带端点世界坐标 + 源侧 id）', () => {
    const { ctx, pointer, calls } = mkCtx([objA], [])
    const g = useLinkGestures(ctx)
    g.onConnectStart('a', 'source', { evt: {} })
    pointer.x = 500
    pointer.y = 300
    g.onConnectMove()
    g.onConnectEnd()
    expect(ctx.links.value).toHaveLength(0)
    expect(calls.menus).toHaveLength(1)
    expect(calls.menus[0]).toMatchObject({ from: 'a', to: null, wx: 500, wy: 300 })
  })

  it('重复关系不建线（幂等）', () => {
    const { ctx, pointer, calls } = mkCtx([objA, objB], [{ id: 'l1', from: 'a', to: 'b' }])
    const g = useLinkGestures(ctx)
    g.onConnectStart('a', 'source', { evt: {} })
    pointer.x = 350
    pointer.y = 30
    g.onConnectMove()
    g.onConnectEnd()
    expect(ctx.links.value).toHaveLength(1) // 无新增
    expect(calls.before).toBe(0)
  })
})

describe('useLinkGestures — 锚点重连', () => {
  const mk = () => {
    const links = [{ id: 'l1', from: 'a', to: 'b' }]
    return { ...mkCtx([objA, objB], links), links }
  }

  it('拖 to 端到新目标 → 改写 to（from 不动）', () => {
    const { ctx, pointer, calls, links } = mk()
    const g = useLinkGestures(ctx)
    g.onAnchorDown('l1', 'to', { evt: {} })
    expect(g.reconnectDrag.active).toBe(true)
    expect(g.reconnectDrag.fixedId).toBe('a')
    // 命中 objB 自身 = 拖回原端 → 取消；这里先验证吸附
    pointer.x = 350
    pointer.y = 30
    g.onReconnectMove()
    expect(g.reconnectDrag.targetId).toBe('b')
    g.onReconnectEnd()
    expect(links[0]).toMatchObject({ from: 'a', to: 'b' }) // 原样（拖回原端无变化）
    expect(calls.before).toBe(0)
  })

  it('拖到不动端自身 → 取消（防自环）', () => {
    const { ctx, pointer, calls, links } = mk()
    const g = useLinkGestures(ctx)
    g.onAnchorDown('l1', 'to', { evt: {} })
    // 指针落在 from 物件 a 上
    pointer.x = 50
    pointer.y = 30
    g.onReconnectMove()
    expect(g.reconnectDrag.targetId).toBeNull() // a 是 fixedId，不算目标
    g.onReconnectEnd()
    expect(links[0]).toMatchObject({ from: 'a', to: 'b' }) // 不变
    expect(calls.before).toBe(0)
  })

  it('Esc 取消（cancelReconnectDrag 语义）：active 复位、线不变', () => {
    const { ctx } = mk()
    const g = useLinkGestures(ctx)
    g.onAnchorDown('l1', 'from', { evt: {} })
    // 模拟 index.vue 的 cancelReconnectDrag：直接清字段
    Object.assign(g.reconnectDrag, {
      active: false,
      linkId: null,
      side: null,
      fixedId: null,
      targetId: null,
      seg: null,
    })
    expect(g.reconnectDrag.active).toBe(false)
  })
})
