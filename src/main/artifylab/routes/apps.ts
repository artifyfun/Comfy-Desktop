import express from 'express'
import { CONFIG, HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { handleApiError, createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { fetchWithRetry } from '../utils/fetch'
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
      // 远程市场数据源（S3）可能不可用/已下线——抓取成功返回列表，
      // 失败时兜底空数组，避免前端每次进入应用市场都报错。
      const response = await fetchWithRetry(CONFIG.APP_MARKET_URL, {
        method: 'GET',
        signal: AbortSignal.timeout(8000)
      })
      if (response.ok) {
        const json = await response.json()
        const apps = Array.isArray(json) ? json : json?.data
        return res
          .status(HTTP_STATUS.OK)
          .json(createSuccessResponse(Array.isArray(apps) ? apps : []))
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse([]))
    } catch (error) {
      logger.error('Failed to get market apps', error)
      // 数据源不可达不算致命错误——返回空列表，前端展示空市场而非报错
      res.status(HTTP_STATUS.OK).json(createSuccessResponse([]))
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

  /**
   * 检查 App 依赖（模型 / 自定义节点）是否齐全。
   * 原理：拉 ComfyUI /object_info，比对——
   *  1. 节点缺失：prompt 里用到的 class_type 不在 object_info 中 → 缺自定义节点
   *  2. 模型缺失：combo 型输入（ckpt_name / lora_name / vae_name 等模型选择器）
   *     的当前值不在合法值列表（ComfyUI 按已安装模型文件生成）中 → 缺模型
   * body: { app }，返回 { ok, missingNodes: string[], missingModels: {node,input,value}[] }
   */
  router.post('/api/apps/check-deps', async (req: express.Request, res: express.Response) => {
    try {
      const { app } = req.body ?? {}
      const prompt = app?.template?.prompt
      if (!prompt || typeof prompt !== 'object') {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('app.template.prompt is required'))
      }

      const comfyHost = appStoreManager.getConfig().comfyHost
      const objInfoRes = await fetchWithRetry(`${comfyHost}/object_info`, { method: 'GET' })
      if (!objInfoRes.ok) {
        return res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .json(createErrorResponse(`object_info http ${objInfoRes.status}`))
      }
      const objectInfo = (await objInfoRes.json()) as Record<
        string,
        { input?: Record<string, unknown[]> }
      >

      const missingNodes: string[] = []
      const missingModels: Array<{ node: string; input: string; value: string }> = []

      for (const [nodeId, nodeUnknown] of Object.entries(prompt)) {
        const node = nodeUnknown as { class_type: string; inputs?: Record<string, unknown> }
        const classDef = objectInfo[node.class_type]
        if (!classDef) {
          if (!missingNodes.includes(node.class_type)) missingNodes.push(node.class_type)
          continue
        }
        const required = classDef.input?.required ?? []
        for (const [inputName, inputDef] of Object.entries(required)) {
          // combo 型输入：['a','b',...]（数组首元素为数组或字符串列表）
          const def = inputDef as unknown[]
          const values = Array.isArray(def?.[0]) ? (def[0] as unknown[]) : null
          if (!values || values.length === 0) continue
          const val = (node.inputs ?? {})[inputName]
          if (typeof val === 'string' && !values.includes(val)) {
            missingModels.push({ node: nodeId, input: inputName, value: val })
          }
        }
      }

      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          ok: missingNodes.length === 0 && missingModels.length === 0,
          missingNodes,
          missingModels
        })
      )
    } catch (error) {
      logger.error('Failed to check app deps', error)
      handleApiError(res, 'Failed to check app deps')
    }
  })
  return router
}
