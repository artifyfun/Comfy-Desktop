import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { handleApiError, createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import appStoreManager from '../appStore'

/**
 * App CRUD + 市场接口（自 server.ts 平移，行为不变）。
 */
export function createAppsRouter(): express.Router {
  const router = express.Router()

  // App 相关接口
  router.post('/api/apps', (_req: express.Request, res: express.Response) => {
    try {
      const apps = appStoreManager.getAllApps()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(apps))
    } catch (error) {
      logger.error('Failed to get apps', error)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse('Failed to get apps'))
    }
  })

  router.post('/api/market/apps', async (_req: express.Request, res: express.Response) => {
    try {
      // const { data: apps } = await cachedFetchGet(CONFIG.APP_MARKET_URL) as { data: any };
      // res.status(HTTP_STATUS.OK).json(createSuccessResponse(apps));
      throw new Error('ASSETS NOT FOUND')
    } catch (error) {
      logger.error('Failed to get market apps', error)
      handleApiError(error, res)
    }
  })

  // 根据ID获取app
  router.post('/api/apps/detail', (req: express.Request, res: express.Response) => {
    try {
      const { id } = req.body
      const app = appStoreManager.getAppById(id)

      if (!app) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('App not found'))
      }

      res.status(HTTP_STATUS.OK).json(createSuccessResponse(app))
    } catch (error) {
      logger.error('Failed to get app', error)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse('Failed to get app'))
    }
  })

  // 创建app
  router.post('/api/apps/create', (req: express.Request, res: express.Response) => {
    try {
      const { name } = req.body

      if (!name) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('name field is required'))
      }

      const newApp = appStoreManager.createApp(req.body)

      res.status(HTTP_STATUS.CREATED).json(createSuccessResponse(newApp))
    } catch (error) {
      logger.error('Failed to create app', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to create app'))
    }
  })

  // 更新app
  router.post('/api/apps/update', (req: express.Request, res: express.Response) => {
    try {
      const { id } = req.body

      if (!id) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id field is required'))
      }

      const { id: _, ...updateData } = req.body
      const updatedApp = appStoreManager.updateApp(id, updateData)

      if (!updatedApp) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('App not found'))
      }

      res.status(HTTP_STATUS.OK).json(createSuccessResponse(updatedApp))
    } catch (error) {
      logger.error('Failed to update app', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to update app'))
    }
  })

  // 删除app
  router.post('/api/apps/remove', (req: express.Request, res: express.Response) => {
    try {
      const { id } = req.body

      if (!id) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id field is required'))
      }

      const success = appStoreManager.removeApp(id)

      if (!success) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('App not found'))
      }

      res.status(HTTP_STATUS.OK).json(createSuccessResponse(null, 'App deleted successfully'))
    } catch (error) {
      logger.error('Failed to delete app', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to delete app'))
    }
  })

  // 导入apps
  router.post('/api/apps/import', (req: express.Request, res: express.Response) => {
    try {
      const { apps } = req.body

      if (!Array.isArray(apps)) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('apps field must be an array'))
      }

      // 验证每个app是否有必需的字段
      for (const app of apps) {
        if (!app.id || !app.name) {
          return res
            .status(HTTP_STATUS.BAD_REQUEST)
            .json(createErrorResponse('Each app must contain id and name fields'))
        }
      }

      appStoreManager.importApps(apps)

      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ importedCount: apps.length }, 'Apps imported successfully'))
    } catch (error) {
      logger.error('Failed to import apps', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to import apps'))
    }
  })
  return router
}
