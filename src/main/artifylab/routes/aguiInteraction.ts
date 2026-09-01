/**
 * C14 — HITL 审批应答端点(独立 router,与 A 线 routes/agui.ts 并行,互不触碰;
 * server.ts 注册由 captain 统一接线)。
 *
 * - POST /api/workbench/agent/interaction-response
 *   body {threadId, requestId, action: 'approve'|'reject'|'edit', args?}
 *   → 受理 202 {ok:true}(长挂起 Promise 由门控唤醒,工具续跑);
 *     未知 requestId/threadId 或已终态 → 404;缺参/非法 action/edit 非对象 args → 400。
 *
 * 依赖注入:工厂只收 { gate },单测用 createApprovalGate 直连;
 * 生产在 server.ts 组装(与 routes/agui.ts 的 SSE notify 共用同一 gate 实例)。
 */

import { Router, type Request, type Response } from 'express'
import { createSuccessResponse, createErrorResponse } from '../utils/errorHandler'
import { HTTP_STATUS } from '../config/constants'
import { ApprovalArgsError, type ApprovalAction, type ApprovalGate } from '../agui/approvalGate'

/** 202 Accepted:受理 ≠ 终态,工具执行结果走原 AG-UI 流回推 */
export const INTERACTION_RESPONSE_ACCEPTED = 202

const ACTIONS: readonly ApprovalAction[] = ['approve', 'reject', 'edit']

export interface AguiInteractionDeps {
  gate: ApprovalGate
}

interface InteractionBody {
  threadId?: unknown
  requestId?: unknown
  action?: unknown
  args?: unknown
}

export function createAguiInteractionRouter(deps: AguiInteractionDeps): Router {
  const router = Router()

  router.post('/api/workbench/agent/interaction-response', (req: Request, res: Response) => {
    try {
      const body = (req.body ?? {}) as InteractionBody

      // ---- 缺参/类型校验 → 400(空串同样视为缺参)----
      const threadId = typeof body.threadId === 'string' ? body.threadId.trim() : ''
      const requestId = typeof body.requestId === 'string' ? body.requestId.trim() : ''
      const action = body.action
      if (!threadId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('threadId is required'))
        return
      }
      if (!requestId) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('requestId is required'))
        return
      }
      if (typeof action !== 'string' || !ACTIONS.includes(action as ApprovalAction)) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse("action must be 'approve' | 'reject' | 'edit'"))
        return
      }

      // ---- 门控应答:edit 非对象 args 抛 ApprovalArgsError → 400(pending 不消费,可重试)----
      let resolved: boolean
      try {
        resolved = deps.gate.resolve(threadId, requestId, action as ApprovalAction, body.args)
      } catch (e) {
        if (e instanceof ApprovalArgsError) {
          res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(e.message))
          return
        }
        throw e
      }

      // ---- 未知 threadId/requestId / 已终态(幂等二次应答)→ 404 ----
      if (!resolved) {
        res
          .status(HTTP_STATUS.NOT_FOUND)
          .json(createErrorResponse('unknown or already-resolved requestId for this thread'))
        return
      }

      res.status(INTERACTION_RESPONSE_ACCEPTED).json(createSuccessResponse({ accepted: true }))
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  return router
}
