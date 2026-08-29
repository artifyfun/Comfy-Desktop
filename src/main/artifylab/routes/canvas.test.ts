// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createCanvasRouter } from './canvas'

/**
 * /api/canvas/snapshot & /api/canvas/state 单测。
 *
 * - snapshot 合法 body 缓存并回显 seq
 * - snapshot 缺 body → 400
 * - state 无缓存 → {state:null}
 * - state 有缓存 → 返回最近快照
 *
 * 全部走本地临时端口 + 全局 fetch，确定性无竞态（zero tolerance for flaky）。
 */
describe('canvas routes', () => {
  let server: http.Server
  let baseUrl = ''

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter({ latest: null }))
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

  it('accepts and caches a valid snapshot', async () => {
    const app = makeApp()
    const s2 = http.createServer(app)
    await new Promise<void>((resolve) => s2.listen(0, '127.0.0.1', resolve))
    const base2 = `http://127.0.0.1:${(s2.address() as AddressInfo).port}`
    try {
      const res = await fetch(`${base2}/api/canvas/snapshot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          seq: 1,
          workflowName: 'wf',
          nodeCount: 3,
          models: ['a.safetensors'],
          keyParams: {},
          queue: { running: 0, pending: 0 },
          ts: 1
        })
      })
      expect(res.status).toBe(200)
      const body = (await res.json()) as { ok: boolean; data: { seq: number } }
      expect(body.ok).toBe(true)
      expect(body.data.seq).toBe(1)
      const st = await fetch(`${base2}/api/canvas/state`)
      const stBody = (await st.json()) as {
        ok: boolean
        data: { state: { workflowName: string } | null }
      }
      expect(stBody.data.state).toMatchObject({ workflowName: 'wf' })
    } finally {
      await new Promise<void>((resolve) => s2.close(() => resolve()))
    }
  })

  it('rejects missing body with 400', async () => {
    const res = await post('/api/canvas/snapshot', {})
    expect(res.status).toBe(400)
    const body = (await res.json()) as { ok: boolean }
    expect(body.ok).toBe(false)
  })

  it('returns null state when never posted', async () => {
    const res = await fetch(`${baseUrl}/api/canvas/state`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as { ok: boolean; data: { state: unknown } }
    expect(body.ok).toBe(true)
    expect(body.data.state).toBeNull()
  })
})
