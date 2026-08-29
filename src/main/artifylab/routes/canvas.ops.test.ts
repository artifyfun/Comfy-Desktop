// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createCanvasRouter, type CanvasDigestStore, type CheckpointStore } from './canvas'

/**
 * /api/canvas ops 通道单测（M2）。
 *
 * - POST /api/canvas/ops：合法 ops 入审计队列，200 回 {queued:true}
 * - 非法 body（ops 非数组/空）→ 400
 * - POST /api/canvas/checkpoint：落库返回 checkpointId（递增）
 * - GET /api/canvas/checkpoints?limit=2：新→旧返回
 * - POST /api/canvas/rollback：标记回滚到指定 checkpoint 并清空审计队列
 *
 * 全部走本地临时端口 + 全局 fetch，确定性无竞态。
 */
describe('canvas ops channel', () => {
  let server: http.Server
  let baseUrl = ''
  // 声明即初始化：beforeAll 建路由时捕获这两个对象引用；beforeEach 只重置
  // 字段不换对象（换对象会让路由仍指向旧 store，用例间互相看不到写入）
  const digestStore: CanvasDigestStore = { latest: null }
  const checkpointStore: CheckpointStore = { items: [], nextId: 1, rollbackTo: null, audit: [] }

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter(digestStore, checkpointStore))
    return app
  }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  beforeAll(async () => {
    server = http.createServer(makeApp())
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    digestStore.latest = null
    checkpointStore.items = []
    checkpointStore.nextId = 1
    checkpointStore.rollbackTo = null
    checkpointStore.audit = []
  })

  it('queues valid ops for bridge pickup', async () => {
    const res = await post('/api/canvas/ops', {
      ops: [{ type: 'setWidget', nodeId: 4, widget: 'steps', value: 20 }],
      reason: 'test'
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { queued: number } }
    expect(body.ok).toBe(true)
    expect(body.data.queued).toBe(1)
  })

  it('rejects invalid ops body', async () => {
    const res = await post('/api/canvas/ops', { ops: 'nope' })
    expect(res.status).toBe(400)
  })

  it('checkpoints and lists newest first', async () => {
    await post('/api/canvas/checkpoint', {
      reason: 'before-add',
      workflow: { nodes: [], links: [] }
    })
    const res2 = await post('/api/canvas/checkpoint', {
      reason: 'before-remove',
      workflow: { nodes: [], links: [] }
    })
    const b2 = (await res2.json()) as { data: { checkpointId: number } }
    expect(b2.data.checkpointId).toBe(2)

    const list = await fetch(`${baseUrl}/api/canvas/checkpoints?limit=1`)
    const lb = (await list.json()) as { data: { items: Array<{ id: number }> } }
    expect(lb.data.items).toHaveLength(1)
    expect(lb.data.items[0]?.id).toBe(2)
  })

  it('rollback marks target and clears pending ops', async () => {
    await post('/api/canvas/checkpoint', { reason: 'cp1', workflow: { nodes: [{ id: 1 }] } })
    await post('/api/canvas/ops', {
      ops: [{ type: 'setWidget', nodeId: 1, widget: 'steps', value: 1 }]
    })

    const res = await post('/api/canvas/rollback', { checkpointId: 1 })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: { rollbackTo: number; workflow: { nodes: Array<{ id: number }> } | null }
    }
    expect(body.data.rollbackTo).toBe(1)
    expect(body.data.workflow?.nodes[0]?.id).toBe(1)

    // 回滚后审计队列清空（旧 ops 作废）
    const list = await fetch(`${baseUrl}/api/canvas/checkpoints?limit=5`)
    const lb = (await list.json()) as { data: { audit: unknown[] } }
    expect(lb.data.audit).toHaveLength(0)
    // rollbackTo 标记落到了路由捕获的同一 store 上
    expect(checkpointStore.rollbackTo).toBe(1)
  })

  it('rejects rollback to unknown checkpoint', async () => {
    const res = await post('/api/canvas/rollback', { checkpointId: 999 })
    expect(res.status).toBe(404)
  })
})
