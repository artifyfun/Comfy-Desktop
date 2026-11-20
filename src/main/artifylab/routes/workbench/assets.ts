/**
 * 创作资产库 REST 端点（C-H5 资产面板数据源；对标建议 #4 的 UI 侧）。
 *
 * - GET  /api/workbench/assets            全量清单（新→旧）
 * - GET  /api/workbench/assets/:id        单个详情
 * - POST /api/workbench/assets/save       新建/更新（body = AssetInput）
 * - POST /api/workbench/assets/remove     删除（body {id}）
 *
 * 直接复用 assetsStore 单例（与 wb_assets MCP 工具同源，模型与用户看同一份）。
 */
import type { Router, Request, Response } from 'express'
import { createSuccessResponse, createErrorResponse } from '../../utils/errorHandler'
import { HTTP_STATUS } from '../../config/constants'
import { assetsStore } from '../../workbench/assetsStore'

export function registerAssetsRoutes(router: Router): void {
  router.get('/api/workbench/assets', (_req: Request, res: Response) => {
    try {
      const assets = assetsStore.list()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ total: assets.length, assets }))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to list assets'))
    }
  })

  router.get('/api/workbench/assets/:id', (req: Request, res: Response) => {
    try {
      const id = typeof req.params.id === 'string' ? req.params.id : ''
      const asset = assetsStore.get(id)
      if (!asset) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('Asset not found'))
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(asset))
    } catch (error) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse('Failed to get asset'))
    }
  })

  router.post('/api/workbench/assets/save', (req: Request, res: Response) => {
    try {
      const result = assetsStore.save(req.body ?? {})
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          ok: true,
          created: result.created,
          id: result.asset.id,
          issues: result.issues
        })
      )
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error)
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(msg))
    }
  })

  router.post('/api/workbench/assets/remove', (req: Request, res: Response) => {
    try {
      const id = typeof req.body?.id === 'string' ? req.body.id : ''
      const ok = assetsStore.remove(id)
      if (!ok) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('Asset not found'))
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ ok: true }))
    } catch (error) {
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to remove asset'))
    }
  })
}
