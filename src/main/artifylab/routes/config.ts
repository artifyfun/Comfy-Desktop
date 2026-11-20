import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import appStoreManager from '../appStore'

/**
 * 用户配置接口（自 server.ts 平移，行为不变）。
 */
export function createConfigRouter(): express.Router {
  const router = express.Router()
  // 获取config
  router.post('/api/config', (_req: express.Request, res: express.Response) => {
    try {
      const config = appStoreManager.getConfig()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(config))
    } catch (error) {
      logger.error('Failed to get config', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to get config'))
    }
  })

  // 保存config
  router.post('/api/config/update', (req: express.Request, res: express.Response) => {
    try {
      const config = req.body
      appStoreManager.saveConfig(config)

      res.status(HTTP_STATUS.OK).json(createSuccessResponse(null, 'Config saved successfully'))
    } catch (error) {
      logger.error('Failed to save config', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to save config'))
    }
  })

  return router
}
