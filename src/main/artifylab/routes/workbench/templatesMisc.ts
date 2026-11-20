import type express from 'express'
import { HTTP_STATUS } from '../../config/constants'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'

import { templateLibrary } from '../../workbench/templates'
import { workbenchService } from '../../workbench/service'

export function registerTemplatesRoutes(router: express.Router): void {
  router.get('/api/workbench/templates', (_req, res) => {
    res.json(createSuccessResponse(templateLibrary.list()))
  })

  // 最近一轮调试快照（前端「复制调试信息」数据源：spec/原始输出/PLAN/校验/执行）
  router.get('/api/workbench/debug/last', (req, res) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId
    if (!sessionId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('sessionId is required'))
      return
    }
    const log = workbenchService.lastDebugLog(sessionId)
    if (!log) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('no debug log yet'))
      return
    }
    res.json(createSuccessResponse(log))
  })
}
