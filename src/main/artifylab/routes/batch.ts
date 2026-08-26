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
 * POST /api/batch/pause   暂停当前运行任务（保留进度），body { id? }
 * POST /api/batch/job-resume 继续已暂停任务，body { id }
 * POST /api/batch/config  队列级配置（关机/通知），body { autoShutdown?, notifyUrl? }
 * POST /api/batch/rerun   重新运行已结束任务（一键重跑原配置），body { id }
 */
import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { logger } from '../utils/logger'
import {
  startBatch,
  rerunBatchJob,
  stopBatch,
  cancelBatchJob,
  deleteBatchJob,
  clearBatchQueue,
  moveBatchJob,
  getBatchStatus,
  isBatchRunning,
  isQueuePaused,
  resumeQueue,
  listBatchQueue,
  loadQueue,
  pauseBatch,
  resumeBatch,
  setQueueConfig,
  getQueueConfig,
  type BatchStartOptions,
  type QueueConfigPayload
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

  // 重新运行已结束任务（一键重跑原配置）；body { id }
  router.post('/api/batch/rerun', (req: express.Request, res: express.Response) => {
    try {
      const id = (req.body as { id?: string } | undefined)?.id
      if (!id) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
        return
      }
      void rerunBatchJob(id)
        .then((result) => {
          if (!result) {
            res
              .status(HTTP_STATUS.NOT_FOUND)
              .json(createErrorResponse('batch job not found or still active'))
            return
          }
          res.status(HTTP_STATUS.OK).json(
            createSuccessResponse({
              jobId: result.job.id,
              queue: result.queue,
              running: isBatchRunning(),
              paused: isQueuePaused()
            })
          )
        })
        .catch((error: Error) => {
          if (/queue is full/.test(error.message)) {
            res.status(HTTP_STATUS.CONFLICT).json(createErrorResponse(error.message))
          } else {
            logger.error('Failed to rerun batch job', error)
            res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse(error.message))
          }
        })
    } catch (error) {
      logger.error('Failed to rerun batch job', error)
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

  // 删除任意任务（含终态记录）；运行中任务返回 409 请先停止/暂停。body { id }
  router.post('/api/batch/delete', (req: express.Request, res: express.Response) => {
    try {
      const id = (req.body as { id?: string } | undefined)?.id
      if (!id) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
        return
      }
      const ok = deleteBatchJob(id)
      if (!ok) {
        res
          .status(HTTP_STATUS.NOT_FOUND)
          .json(createErrorResponse('batch job not found or still running'))
        return
      }
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ jobs: listBatchQueue(), running: isBatchRunning() }))
    } catch (error) {
      logger.error('Failed to delete batch job', error)
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

  // 暂停当前运行任务（保留进度，可继续）；body { id } 可选，缺省 = 当前运行任务
  router.post('/api/batch/pause', async (req: express.Request, res: express.Response) => {
    try {
      const id = (req.body as { id?: string } | undefined)?.id
      const job = await pauseBatch(id)
      if (!job) {
        res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('no running batch job to pause'))
        return
      }
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          jobs: listBatchQueue(),
          running: isBatchRunning(),
          paused: isQueuePaused()
        })
      )
    } catch (error) {
      logger.error('Failed to pause batch job', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  // 继续执行已暂停任务；body { id } 必填
  router.post('/api/batch/job-resume', (req: express.Request, res: express.Response) => {
    try {
      const id = (req.body as { id?: string } | undefined)?.id
      if (!id) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
        return
      }
      const ok = resumeBatch(id)
      if (!ok) {
        res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('paused batch job not found'))
        return
      }
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ jobs: listBatchQueue(), running: isBatchRunning() }))
    } catch (error) {
      logger.error('Failed to resume batch job', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  // 队列级配置：运行完成后关机 / 通知 webhook；对排队中/运行中任务即时生效
  router.post('/api/batch/config', (req: express.Request, res: express.Response) => {
    try {
      const body = (req.body ?? {}) as { autoShutdown?: unknown; notifyUrl?: unknown }
      const payload: QueueConfigPayload = {}
      if (typeof body.autoShutdown === 'boolean') payload.autoShutdown = body.autoShutdown
      if (typeof body.notifyUrl === 'string') payload.notifyUrl = body.notifyUrl
      setQueueConfig(payload)
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ config: getQueueConfig(), jobs: listBatchQueue() }))
    } catch (error) {
      logger.error('Failed to set batch queue config', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  return router
}
