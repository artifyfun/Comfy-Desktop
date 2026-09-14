// @vitest-environment node
/**
 * 画布工作流快照暂存测试（对标建议 #8）。
 *
 * 关注点：暂存/取回一致性、LRU 淘汰、非法输入的静默忽略（不能让脏数据占坑，
 * 否则 wb_publish_workflow 会拿一个空 workflow 去固化）。
 */
import { describe, expect, it } from 'vitest'
import { CanvasWorkflowStore } from './canvasWorkflowStore'
import type { ComfyPrompt } from '../appStore'

const wf = (n: number): ComfyPrompt =>
  ({ '1': { class_type: `Node${n}`, inputs: {} } }) as unknown as ComfyPrompt

describe('CanvasWorkflowStore', () => {
  it('remember → get 取回同一引用；未命中为 undefined', () => {
    const store = new CanvasWorkflowStore()
    const w = wf(1)
    store.remember('p1', w)
    expect(store.get('p1')).toBe(w)
    expect(store.has('p1')).toBe(true)
    expect(store.get('p2')).toBeUndefined()
    expect(store.has('p2')).toBe(false)
    expect(store.size).toBe(1)
  })

  it('非法输入被忽略（空 id / 空对象 / 非对象）', () => {
    const store = new CanvasWorkflowStore()
    store.remember('', wf(1))
    store.remember('p1', {} as ComfyPrompt)
    store.remember('p2', null as unknown as ComfyPrompt)
    expect(store.size).toBe(0)
    // 空 workflow 不占坑：后续 get 不该拿到空壳
    expect(store.get('p1')).toBeUndefined()
  })

  it('容量上限：超限淘汰最旧（LRU）', () => {
    const store = new CanvasWorkflowStore(2)
    store.remember('p1', wf(1))
    store.remember('p2', wf(2))
    store.remember('p3', wf(3))
    expect(store.size).toBe(2)
    expect(store.has('p1')).toBe(false)
    expect(store.has('p3')).toBe(true)
  })

  it('重复 remember 同 promptId：覆盖值并提升为最近（不被误淘汰）', () => {
    const store = new CanvasWorkflowStore(2)
    store.remember('p1', wf(1))
    store.remember('p2', wf(2))
    const updated = wf(11)
    store.remember('p1', updated)
    store.remember('p3', wf(3))

    expect(store.get('p1')).toBe(updated)
    expect(store.has('p2')).toBe(false) // 最旧的 p2 被淘汰，而非 p1
  })

  it('clear 清空', () => {
    const store = new CanvasWorkflowStore()
    store.remember('p1', wf(1))
    store.clear()
    expect(store.size).toBe(0)
  })
})
