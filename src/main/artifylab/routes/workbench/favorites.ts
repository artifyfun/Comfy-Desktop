import type express from 'express'
import type { Request } from 'express'
import { CONFIG, HTTP_STATUS } from '../../config/constants'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'
import { workbenchService } from '../../workbench/service'

export function registerFavoritesRoutes(router: express.Router): void {
  router.post('/api/workbench/favorites', async (req: Request, res) => {
    try {
      const { sessionId, promptId, file, note } = req.body as {
        sessionId?: string
        promptId?: string
        file?: { filename: string; subfolder?: string; type?: string }
        note?: string
      }
      if (!sessionId || !promptId || !file?.filename) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('sessionId/promptId/file required'))
        return
      }
      const fav = workbenchService.addFavorite({
        sessionId,
        executionPromptId: promptId,
        file,
        note
      })
      res.json(createSuccessResponse(fav))
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  router.delete('/api/workbench/favorites/:id', (req: Request, res) => {
    const ok = workbenchService.removeFavorite(String(req.params.id ?? ''))
    if (!ok) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('favorite not found'))
      return
    }
    res.json(createSuccessResponse({ ok: true }))
  })

  // ---------------- 内部 API 代理（工作台 → app 内部接口全量打通） ----------------
  // 白名单前缀只含本 Express 自挂的路由（apps/batch/models/config/mcp-config 等）,
  // 明确排除 workbench 自身(防递归)与未知路径(防把 127.0.0.1:3008 当出网跳板)。
  // 工作台前端一律经此代理访问内部能力,不再各自直连。
  const INTERNAL_PREFIXES = [
    '/api/apps',
    '/api/batch',
    '/api/models',
    '/api/config',
    '/api/mcp',
    '/api/notify',
    '/api/history'
  ]
  const LOCAL_EXCLUDED = '/api/workbench'
  router.all('/api/workbench/internal/*', async (req: Request, res) => {
    const restRaw = (req.params as Record<string, string | string[]>)[0] ?? ''
    const rest = Array.isArray(restRaw) ? (restRaw[0] ?? '') : restRaw
    const target = `/${rest}`
    if (
      !INTERNAL_PREFIXES.some((p) => target === p || target.startsWith(p + '/')) ||
      target.startsWith(LOCAL_EXCLUDED)
    ) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('internal path not allowed'))
      return
    }
    // 内置最小转发:目标就是本 server。host 头取请求自带的(浏览器→本机代理)，
    // 兜底 CONFIG.SERVER_HOST:PORT。
    const hostHeader = String(req.headers.host ?? '')
    const authority = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader)
      ? hostHeader
      : `127.0.0.1:${CONFIG.PORT}`
    try {
      const url = `http://${authority}${target}`
      const method = req.method.toUpperCase()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const init: RequestInit = { method, headers }
      if (!['GET', 'HEAD'].includes(method)) {
        init.body = JSON.stringify(req.body ?? {})
      }
      const r = await fetch(url, init)
      const text = await r.text()
      res.status(r.status).type('json').send(text)
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })
}
