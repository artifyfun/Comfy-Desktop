import type express from 'express'
import type { Request } from 'express'
import { HTTP_STATUS } from '../../config/constants'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'

import { workbenchService } from '../../workbench/service'

export function registerCatalogRoutes(router: express.Router): void {
  router.get('/api/workbench/models', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listModels()))
  })

  // 环境快照（工作台自我认知：技能/本地模型/显存/自定义节点）
  router.get('/api/workbench/env', async (_req, res) => {
    try {
      res.json(createSuccessResponse(await workbenchService.getEnvSnapshot()))
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  // ---------------- 附件上传（多素材） ----------------

  // 工作台运行环境:产物磁盘根目录(同机 ComfyUI 时另存为按钮的数据源)。
  // 只暴露 outputDir 一个字符串,无敏感信息。
  // ---------------- 收藏（产物收藏夹） ----------------

  router.get('/api/workbench/favorites', (req: Request, res) => {
    res.json(
      createSuccessResponse(
        workbenchService.listFavorites((req.query.sessionId as string) || undefined)
      )
    )
  })

  // 跨会话长期记忆:读取(前端可展示/管理);写入走 decide 的 memory intent
  router.get('/api/workbench/memories', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listMemories()))
  })
}
