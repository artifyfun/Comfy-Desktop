import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { regenerateMcpToken } from '../mcp/auth'
import { buildMcpConfigInfo } from '../mcp/configInfo'

/**
 * MCP 接入配置接口（供 A UI 设置弹窗 / mcp-setup 面板展示）。
 *
 * GET  /api/mcp/config           → { url, token, appCount, listenHost, loopback }
 * POST /api/mcp/regenerate-token → { token }（旧 token 立即失效）
 *
 * 注意：这是 Artify 内嵌 MCP server 的配置面，与官方 comfy-mcp（外部 pip 包）
 * 无关；token 值会明文返回给本机前端用于复制——server 默认仅回环监听
 * （Phase 0），局域网放开需显式改 config.listenHost。
 */
export function createMcpConfigRouter(): express.Router {
  const router = express.Router()

  router.get('/api/mcp/config', (_req: express.Request, res: express.Response) => {
    try {
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(buildMcpConfigInfo()))
    } catch (error) {
      logger.error('Failed to get MCP config', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to get MCP config'))
    }
  })

  router.post('/api/mcp/regenerate-token', (_req: express.Request, res: express.Response) => {
    try {
      const token = regenerateMcpToken()
      logger.info('[MCP] token regenerated (old token invalidated)')
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ token }))
    } catch (error) {
      logger.error('Failed to regenerate MCP token', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to regenerate MCP token'))
    }
  })

  return router
}
