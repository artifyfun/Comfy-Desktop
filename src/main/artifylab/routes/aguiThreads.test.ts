// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

/**
 * C5 thread/历史 API 单测(本地临时端口 + 真实 fetch 模式)。
 *
 * - 依赖注入:store 用 :memory: EventStore;sessions 注入 mock(不触碰 service.ts)
 * - 覆盖:分页默认值与越界、messages 空 run、runId 过滤、排序(落库时序/seq 升序)
 * - 确定性断言,无 sleep——符合 AGENTS.md「zero tolerance policy for flaky tests」
 */

import { EventStore } from '../agui/eventStore'
import {
  runStarted,
  runFinished,
  textMessageContent,
  reasoningMessageContent,
  custom
} from '../agui/types'
import { createAguiThreadsRouter, THREADS_PAGE_SIZE_DEFAULT } from './aguiThreads'
import type { WorkbenchSession } from '../workbench/service'

const mockSessions = vi.fn<() => WorkbenchSession[]>(() => [])

let server: http.Server
let baseUrl = ''

function session(partial: Partial<WorkbenchSession> & { id: string }): WorkbenchSession {
  return {
    title: `会话 ${partial.id}`,
    createdAt: 1,
    updatedAt: 1,
    messages: [],
    executions: [],
    ...partial
  }
}

beforeAll(async () => {
  const store = new EventStore(':memory:')
  // thread t1 / run r1:6 条事件(seq 1..6);t1 / run r2:3 条(seq 1..3);t2:空
  store.appendMany('t1', 'r1', [
    runStarted('t1', 'r1'),
    textMessageContent('m1', 'a'),
    textMessageContent('m1', 'b'),
    reasoningMessageContent('rm1', '思考'),
    custom('wb_plan', { steps: [] }),
    runFinished('t1', 'r1')
  ])
  store.appendMany('t1', 'r2', [
    runStarted('t1', 'r2'),
    textMessageContent('m2', 'x'),
    runFinished('t1', 'r2')
  ])

  const app = express()
  app.use(express.json())
  app.use(createAguiThreadsRouter({ store, sessions: () => mockSessions() }))
  server = http.createServer(app)
  baseUrl = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  })
})

afterAll(() => {
  server?.closeAllConnections?.()
  server?.close()
})

async function post(path: string, body?: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
}

describe('POST /api/workbench/agent/threads/page', () => {
  it('默认分页 pagenum=1 / pagesize=20,响应 {rowCount, records} 对齐 waa', async () => {
    mockSessions.mockReturnValue([
      session({ id: 's1', updatedAt: 300 }),
      session({ id: 's2', updatedAt: 200 })
    ])
    const res = await post('/api/workbench/agent/threads/page', { params: { pagination: {} } })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { data: { rowCount: number; records: unknown[] } }
    expect(body.data.rowCount).toBe(2)
    expect(body.data.records).toMatchObject([
      { threadId: 's1', title: '会话 s1', updatedAt: 300, archived: false },
      { threadId: 's2', title: '会话 s2', updatedAt: 200, archived: false }
    ])
  })

  it('pagesize 翻页:第 2 页取剩余,rowCount 为全量', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      session({ id: `s${i + 1}`, updatedAt: 1000 - i })
    )
    mockSessions.mockReturnValue(many)
    const p1 = await post('/api/workbench/agent/threads/page', {
      params: { pagination: { pagenum: 1, pagesize: 20 } }
    })
    const p2 = await post('/api/workbench/agent/threads/page', {
      params: { pagination: { pagenum: 2, pagesize: 20 } }
    })
    const b1 = (await p1.json()) as { data: { rowCount: number; records: { threadId: string }[] } }
    const b2 = (await p2.json()) as { data: { rowCount: number; records: { threadId: string }[] } }
    expect(b1.data.rowCount).toBe(25)
    expect(b1.data.records).toHaveLength(20)
    expect(b1.data.records[0]!.threadId).toBe('s1')
    expect(b2.data.records).toHaveLength(5)
    expect(b2.data.records[0]!.threadId).toBe('s21')
  })

  it('分页越界:pagenum 超出返回空 records 但 rowCount 保留;空列表返回 0/[]', async () => {
    mockSessions.mockReturnValue([session({ id: 's1' })])
    const far = await post('/api/workbench/agent/threads/page', {
      params: { pagination: { pagenum: 99, pagesize: 20 } }
    })
    const farBody = (await far.json()) as { data: { rowCount: number; records: unknown[] } }
    expect(farBody.data.rowCount).toBe(1)
    expect(farBody.data.records).toEqual([])

    mockSessions.mockReturnValue([])
    const empty = await post('/api/workbench/agent/threads/page', { params: { pagination: {} } })
    const emptyBody = (await empty.json()) as { data: { rowCount: number; records: unknown[] } }
    expect(emptyBody.data).toEqual({ rowCount: 0, records: [] })
  })

  it('archived 会话原样透传;无 body/无 pagination 时也用默认分页', async () => {
    mockSessions.mockReturnValue([
      session({ id: 'sa', archived: true, updatedAt: 10 }),
      session({ id: 'sb', updatedAt: 20 })
    ])
    const noBody = await post('/api/workbench/agent/threads/page')
    const body = (await noBody.json()) as {
      data: { rowCount: number; records: { archived: boolean; threadId: string }[] }
    }
    expect(body.data.rowCount).toBe(2)
    const byId = Object.fromEntries(body.data.records.map((r) => [r.threadId, r]))
    expect(byId.sa!.archived).toBe(true)
    expect(byId.sb!.archived).toBe(false)
  })

  it('非法 pagesize(0/超上限)被钳制到 [1, 100]', async () => {
    mockSessions.mockReturnValue(Array.from({ length: 120 }, (_, i) => session({ id: `s${i}` })))
    const zero = await post('/api/workbench/agent/threads/page', {
      params: { pagination: { pagenum: 1, pagesize: 0 } }
    })
    const zeroBody = (await zero.json()) as { data: { records: unknown[] } }
    expect(zeroBody.data.records).toHaveLength(1) // pagesize 钳到 1

    const huge = await post('/api/workbench/agent/threads/page', {
      params: { pagination: { pagenum: 1, pagesize: 9999 } }
    })
    const hugeBody = (await huge.json()) as { data: { records: unknown[] } }
    expect(hugeBody.data.records).toHaveLength(100) // 钳到上限 100
  })
})

describe('POST /api/workbench/agent/threads/messages', () => {
  it('全量列出 thread 事件:落库时序排序,content 为事件 JSON 原文', async () => {
    const res = await post('/api/workbench/agent/threads/messages', { threadId: 't1' })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      data: {
        rowCount: number
        records: { runId: string; seq: number; eventType: string; content: string }[]
      }
    }
    // 默认 limit 500 → 9 条全量(r1 6 条 + r2 3 条)
    expect(body.data.rowCount).toBe(9)
    expect(body.data.records.map((r) => r.runId)).toEqual([
      'r1',
      'r1',
      'r1',
      'r1',
      'r1',
      'r1',
      'r2',
      'r2',
      'r2'
    ])
    expect(body.data.records.map((r) => r.eventType)).toEqual([
      'RUN_STARTED',
      'TEXT_MESSAGE',
      'TEXT_MESSAGE',
      'REASONING',
      'CUSTOM',
      'RUN_FINISHED',
      'RUN_STARTED',
      'TEXT_MESSAGE',
      'RUN_FINISHED'
    ])
    // content 保真:parse 后 == 原事件(前端直接 parse 喂管线)
    const first = JSON.parse(body.data.records[0]!.content) as { type: string; threadId: string }
    expect(first).toMatchObject({ type: 'RUN_STARTED', threadId: 't1', runId: 'r1' })
    const delta = JSON.parse(body.data.records[1]!.content) as { delta: string }
    expect(delta.delta).toBe('a')
  })

  it('runId 过滤:r2 只返回本 run 事件,seq 升序', async () => {
    const res = await post('/api/workbench/agent/threads/messages', { threadId: 't1', runId: 'r2' })
    const body = (await res.json()) as {
      data: { rowCount: number; records: { runId: string; seq: number }[] }
    }
    expect(body.data.rowCount).toBe(3)
    expect(body.data.records.map((r) => [r.runId, r.seq])).toEqual([
      ['r2', 1],
      ['r2', 2],
      ['r2', 3]
    ])
  })

  it('空 run / 无事件 thread:rowCount=0, records=[]', async () => {
    const emptyThread = await post('/api/workbench/agent/threads/messages', { threadId: 't2' })
    const emptyThreadBody = (await emptyThread.json()) as {
      data: { rowCount: number; records: unknown[] }
    }
    expect(emptyThreadBody.data).toEqual({ rowCount: 0, records: [] })

    const noThread = await post('/api/workbench/agent/threads/messages', { threadId: 'nope' })
    const noThreadBody = (await noThread.json()) as {
      data: { rowCount: number; records: unknown[] }
    }
    expect(noThreadBody.data).toEqual({ rowCount: 0, records: [] })
  })

  it('分页 offset/limit:翻页无缝,limit 大于剩余量只返回剩余', async () => {
    const p1 = await post('/api/workbench/agent/threads/messages', {
      threadId: 't1',
      offset: 0,
      limit: 4
    })
    const p2 = await post('/api/workbench/agent/threads/messages', {
      threadId: 't1',
      offset: 4,
      limit: 4
    })
    const tail = await post('/api/workbench/agent/threads/messages', {
      threadId: 't1',
      offset: 8,
      limit: 500
    })
    const p1Res = (await p1.json()) as { data: { records: { runId: string; seq: number }[] } }
    const p2Res = (await p2.json()) as { data: { records: { runId: string; seq: number }[] } }
    const bt = (await tail.json()) as { data: { rowCount: number } }
    expect(p1Res.data.records).toHaveLength(4)
    expect(p2Res.data.records).toHaveLength(4)
    expect(bt.data.rowCount).toBe(1)
    // 无缝无重叠:9 条事件取 8 条,(runId, seq) 对互不重复
    const pairs = [...p1Res.data.records, ...p2Res.data.records].map((r) => `${r.runId}#${r.seq}`)
    expect(pairs).toHaveLength(8)
    expect(new Set(pairs).size).toBe(8)
  })

  it('缺 threadId → 400;非 string threadId → 400', async () => {
    const missing = await post('/api/workbench/agent/threads/messages', {})
    expect(missing.status).toBe(400)
    const missingBody = (await missing.json()) as { ok: boolean }
    expect(missingBody.ok).toBe(false)

    const wrongType = await post('/api/workbench/agent/threads/messages', { threadId: 42 })
    expect(wrongType.status).toBe(400)
  })

  it('sessions 抛错 → 500 + ok:false(messages 数据源不受 sessions 影响,反之亦然)', async () => {
    mockSessions.mockImplementation(() => {
      throw new Error('store boom')
    })
    const pageFail = await post('/api/workbench/agent/threads/page', { params: { pagination: {} } })
    expect(pageFail.status).toBe(500)
    const pageFailBody = (await pageFail.json()) as { ok: boolean; message: string }
    expect(pageFailBody.ok).toBe(false)
    expect(pageFailBody.message).toBe('store boom')

    // messages 走 store,不受 sessions 故障影响
    const msgOk = await post('/api/workbench/agent/threads/messages', { threadId: 't1', limit: 1 })
    expect(msgOk.status).toBe(200)
    const msgOkBody = (await msgOk.json()) as { data: { rowCount: number } }
    expect(msgOkBody.data.rowCount).toBe(1)

    mockSessions.mockReturnValue([])
  })

  it('常量导出:默认 pagesize 为 20(对齐 waa)', () => {
    expect(THREADS_PAGE_SIZE_DEFAULT).toBe(20)
  })
})
