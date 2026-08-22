/**
 * 批量任务队列 API（前端轮询状态 + 队列管理）。
 *
 * POST /api/batch/start   提交任务入队（不再 409，除非队列满），返回当前任务 + 队列
 * GET  /api/batch/status  当前运行任务（null = 无任务；兼容旧前端）
 * POST /api/batch/stop    停止当前任务（interrupt）；body { stopAll } 时连排队任务一起停
 * GET  /api/batch/queue   全量队列快照（队列视图数据源）
 * POST /api/batch/cancel  取消指定任务（排队=移出；运行=停止），body { id }
 * POST /api/batch/clear   清空已结束任务
 * POST /api/batch/move    排队任务置顶/提前，body { id, toTop }
 */
import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { logger } from '../utils/logger'
import {
  startBatch,
  stopBatch,
  cancelBatchJob,
  clearBatchQueue,
  moveBatchJob,
  getBatchStatus,
  isBatchRunning,
  isQueuePaused,
  resumeQueue,
  listBatchQueue,
  loadQueue,
  type BatchStartOptions
} from '../services/batchRunner'

export function createBatchRouter(): express.Router {
  const router = express.Router()

  // 启动时恢复持久化队列（幂等；恢复出的排队任务保持暂停，需人工 resume）
  loadQueue()

  router.post('/api/batch/start', (req: express.Request, res: express.Response) => {
    try {
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
        .then(({ job, queue }) => {
          res
            .status(HTTP_STATUS.OK)
            .json(createSuccessResponse({ status: getBatchStatus(), queue, jobId: job.id }))
        })
        .catch((error: Error) => {
          if (/queue is full/.test(error.message)) {
            res.status(HTTP_STATUS.CONFLICT).json(createErrorResponse(error.message))
          } else {
            logger.error('Failed to start batch', error)
            res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse(error.message))
          }
        })
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

  router.post('/api/batch/stop', async (req: express.Request, res: express.Response) => {
    try {
      const stopAll = Boolean((req.body as { stopAll?: boolean } | undefined)?.stopAll)
      await stopBatch({ stopAll })
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(getBatchStatus()))
    } catch (error) {
      logger.error('Failed to stop batch', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.get('/api/batch/queue', (_req: express.Request, res: express.Response) => {
    try {
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          jobs: listBatchQueue(),
          running: isBatchRunning(),
          paused: isQueuePaused()
        })
      )
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.post('/api/batch/resume', (_req: express.Request, res: express.Response) => {
    try {
      const wasPaused = resumeQueue()
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ resumed: wasPaused, jobs: listBatchQueue() }))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.post('/api/batch/cancel', async (req: express.Request, res: express.Response) => {
    try {
      const id = (req.body as { id?: string } | undefined)?.id
      if (!id) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
        return
      }
      const ok = await cancelBatchJob(id)
      if (!ok) {
        res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('batch job not found'))
        return
      }
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ jobs: listBatchQueue(), running: isBatchRunning() }))
    } catch (error) {
      logger.error('Failed to cancel batch job', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.post('/api/batch/clear', (_req: express.Request, res: express.Response) => {
    try {
      const removed = clearBatchQueue()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ removed, jobs: listBatchQueue() }))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  router.post('/api/batch/move', (req: express.Request, res: express.Response) => {
    try {
      const { id, toTop = true } = (req.body ?? {}) as { id?: string; toTop?: boolean }
      if (!id) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
        return
      }
      const ok = moveBatchJob(id, toTop)
      if (!ok) {
        res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('queued batch job not found'))
        return
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ jobs: listBatchQueue() }))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  return router
}
