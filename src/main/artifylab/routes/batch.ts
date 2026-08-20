/**
 * 常驻批量任务 API（前端轮询状态）。
 *
 * POST /api/batch/start  提交任务（prompt + inputsMapping + items），立即返回
 * GET  /api/batch/status 当前任务状态（null = 无任务）
 * POST /api/batch/stop   停止当前任务（interrupt ComfyUI）
 */
import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { logger } from '../utils/logger'
import {
  startBatch,
  stopBatch,
  getBatchStatus,
  isBatchRunning,
  type BatchStartOptions
} from '../services/batchRunner'

export function createBatchRouter(): express.Router {
  const router = express.Router()

  router.post('/api/batch/start', (req: express.Request, res: express.Response) => {
    try {
      if (isBatchRunning()) {
        res
          .status(409)
          .json(createErrorResponse('a batch task is already running'))
        return
      }
      const body = req.body as Partial<BatchStartOptions>
      if (!body.prompt || typeof body.prompt !== 'object') {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('prompt is required'))
        return
      }
      if (!Array.isArray(body.items) || body.items.length === 0) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('items must be non-empty'))
        return
      }
      if (!Array.isArray(body.inputsMapping)) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('inputsMapping must be an array'))
        return
      }
      void startBatch(body as BatchStartOptions)
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(getBatchStatus()))
    } catch (error) {
      logger.error('Failed to start batch', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.get('/api/batch/status', (_req: express.Request, res: express.Response) => {
    try {
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(getBatchStatus()))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.post('/api/batch/stop', async (_req: express.Request, res: express.Response) => {
    try {
      await stopBatch()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(getBatchStatus()))
    } catch (error) {
      logger.error('Failed to stop batch', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  return router
}
