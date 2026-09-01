// @vitest-environment node
import { describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'

/**
 * C14 交互应答端点单测(照 routes/aguiThreads.test.ts 的本地端口 + 真实 fetch 模式;
 * mock 依赖只有 gate 本身,真实 createApprovalGate 直连端点,零 sleep)。
 *
 * 覆盖:202 受理并真正唤醒挂起的 intercept(approve / reject / edit)/
 * 未知 requestId & threadId → 404 / 缺参与非法 action → 400 /
 * edit 非对象 args → 400 且可重试 / 二次应答幂等 → 404。
 * 每用例独立 gate + server,互不串扰。
 */

import { createApprovalGate, type ApprovalGate, type ApprovalRequest } from '../agui/approvalGate'
import { INTERACTION_RESPONSE_ACCEPTED, createAguiInteractionRouter } from './aguiInteraction'

async function startServer(gate: ApprovalGate): Promise<{ url: string; close: () => void }> {
  const app = express()
  app.use(express.json())
  app.use(createAguiInteractionRouter({ gate }))
  const server = http.createServer(app)
  const url = await new Promise<string>((resolve) => {
    server.listen(0, '127.0.0.1', () =>
      resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)
    )
  })
  return {
    url,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    }
  }
}

function postTo(url: string, body: unknown): Promise<Response> {
  return fetch(`${url}/api/workbench/agent/interaction-response`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
}

describe('POST /api/workbench/agent/interaction-response', () => {
  it('常量:202 受理语义(受理 ≠ 终态)', () => {
    expect(INTERACTION_RESPONSE_ACCEPTED).toBe(202)
  })

  it('approve → 202 {ok:true},且真正唤醒对应 thread 挂起的 intercept(approved:true)', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const { url, close } = await startServer(gate)

    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))
    const pending = gate.intercept('t1', 'wb_run_workflow', { workflow: { a: 1 } })

    const res = await postTo(url, { threadId: 't1', requestId: req.requestId, action: 'approve' })
    expect(res.status).toBe(202)
    const body = (await res.json()) as { ok: boolean; data?: { accepted: boolean } }
    expect(body.ok).toBe(true)
    expect(body.data).toEqual({ accepted: true })

    await expect(pending).resolves.toEqual({
      suspended: true,
      approved: true,
      args: { workflow: { a: 1 } }
    })
    close()
  })

  it('reject → 202 且挂起恢复 approved:false;edit → 202 且 args 被替换', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow', 'wb_publish_workflow'] })
    const { url, close } = await startServer(gate)

    const received: ApprovalRequest[] = []
    gate.register('t1', (r) => received.push(r))
    const rejected = gate.intercept('t1', 'wb_run_workflow', { i: 1 })
    const edited = gate.intercept('t1', 'wb_publish_workflow', { i: 2 })

    expect(
      (await postTo(url, { threadId: 't1', requestId: received[0]!.requestId, action: 'reject' }))
        .status
    ).toBe(202)
    await expect(rejected).resolves.toEqual({ suspended: true, approved: false })

    expect(
      (
        await postTo(url, {
          threadId: 't1',
          requestId: received[1]!.requestId,
          action: 'edit',
          args: { i: 22 }
        })
      ).status
    ).toBe(202)
    await expect(edited).resolves.toEqual({ suspended: true, approved: true, args: { i: 22 } })

    close()
  })

  it('未知 requestId → 404;未知 threadId → 404', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const { url, close } = await startServer(gate)

    const noRequest = await postTo(url, { threadId: 't1', requestId: 'ghost', action: 'approve' })
    expect(noRequest.status).toBe(404)
    expect((await noRequest.json()) as { ok: boolean }).toMatchObject({ ok: false })

    const noThread = await postTo(url, {
      threadId: 'ghost',
      requestId: 'whatever',
      action: 'approve'
    })
    expect(noThread.status).toBe(404)

    close()
  })

  it('缺参:threadId / requestId / action 缺失或非法 → 400', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const { url, close } = await startServer(gate)

    expect((await postTo(url, { requestId: 'r', action: 'approve' })).status).toBe(400)
    expect((await postTo(url, { threadId: 't1', action: 'approve' })).status).toBe(400)
    expect((await postTo(url, { threadId: 't1', requestId: 'r' })).status).toBe(400)
    expect((await postTo(url, { threadId: 't1', requestId: 'r', action: 'force' })).status).toBe(
      400
    )

    close()
  })

  it('edit 非对象 args → 400(ApprovalArgsError),pending 未消费,随后可正确 edit 重试', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const { url, close } = await startServer(gate)

    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))
    const pending = gate.intercept('t1', 'wb_run_workflow', { keep: 1 })

    const bad = await postTo(url, {
      threadId: 't1',
      requestId: req.requestId,
      action: 'edit',
      args: [1]
    })
    expect(bad.status).toBe(400)
    expect((await bad.json()) as { ok: boolean }).toMatchObject({ ok: false })

    const good = await postTo(url, {
      threadId: 't1',
      requestId: req.requestId,
      action: 'edit',
      args: { fixed: true }
    })
    expect(good.status).toBe(202)
    await expect(pending).resolves.toEqual({
      suspended: true,
      approved: true,
      args: { fixed: true }
    })

    close()
  })

  it('二次应答幂等:已终态的 requestId 再 POST → 404,结果不被改写', async () => {
    const gate = createApprovalGate({ whitelist: ['wb_run_workflow'] })
    const { url, close } = await startServer(gate)

    let req!: ApprovalRequest
    gate.register('t1', (r) => (req = r))
    const pending = gate.intercept('t1', 'wb_run_workflow', { a: 1 })

    expect(
      (await postTo(url, { threadId: 't1', requestId: req.requestId, action: 'approve' })).status
    ).toBe(202)
    const again = await postTo(url, { threadId: 't1', requestId: req.requestId, action: 'reject' })
    expect(again.status).toBe(404)
    await expect(pending).resolves.toEqual({ suspended: true, approved: true, args: { a: 1 } })

    close()
  })
})
