import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { handleApiError, createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { fetchWithRetry } from '../utils/fetch'
import { sendWebhookNotification, scheduleSystemShutdown } from '../services/systemActions'
import { memoryCache } from '../services/cache'
import artifyUtils from '..'

interface NgrokConfig {
  comfy_origin: string
  server_origin: string
}

/**
 * ComfyUI 代理（/view /history /queue）、缓存、ngrok、关机接口（自 server.ts 平移）。
 */
export function createProxyRouter(): express.Router {
  const router = express.Router()

  // ---------- 缓存管理 ----------
  // 缓存管理接口
  router.get('/api/cache/stats', (_req: express.Request, res: express.Response) => {
    try {
      const stats = memoryCache.getStats()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(stats))
    } catch (error) {
      logger.error('Failed to get cache stats', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to get cache stats'))
    }
  })

  router.post('/api/cache/clear', (_req: express.Request, res: express.Response) => {
    try {
      memoryCache.clear()
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(null, '缓存已清空'))
    } catch (error) {
      logger.error('Failed to clear cache', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse('Failed to clear cache'))
    }
  })

  // ---------- 完成通知（Bark / Telegram / 通用 webhook） ----------
  // 桌面端代理转发，避免浏览器 CORS 限制。body: { url, title, body }
  // Bark:    https://api.day.app/<key> （GET，标题/正文拼路径）
  // Telegram: https://api.telegram.org/bot<token>/sendMessage（POST JSON）
  // 通用:    POST JSON {title, body}（server酱等）
  router.post('/api/notify', async (req: express.Request, res: express.Response) => {
    try {
      const r = await sendWebhookNotification({
        url: String(req.body?.url || ''),
        title: String(req.body?.title || ''),
        body: String(req.body?.body || '')
      })
      if ('error' in r) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error))
        return
      }
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ status: r.status }, `notify http ${r.status}`))
    } catch (error) {
      logger.error('Notify failed', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  // ---------- ngrok ----------
  let lastNgrokAuthtoken: string | null = null
  let lastNgrokConfig: NgrokConfig | null = null
  let chatListener: any = null
  let comfyListener: any = null

  async function initNgrok(token: string): Promise<NgrokConfig> {
    if (!token) {
      throw new Error('ngrokAuthtoken is required')
    }

    if (token === lastNgrokAuthtoken && lastNgrokConfig) {
      return lastNgrokConfig
    }

    try {
      await chatListener?.close()
      await comfyListener?.close()
    } catch (error) {
      logger.warn('Error closing previous ngrok listeners', error)
    }

    const config = artifyUtils.getConfig()
    if (!config.server_origin || !config.comfy_origin) {
      throw new Error('server_origin and comfy_origin must be set in config')
    }

    // 动态导入：原生绑定（@ngrok/ngrok-win32-x64-msvc）缺失时只影响
    // ngrok 功能本身，不再拖崩整个 server 启动
    const ngrokModule = await import('@ngrok/ngrok')
    try {
      chatListener = await ngrokModule.forward({
        addr: config.server_origin,
        authtoken: token
      })
      comfyListener = await ngrokModule.forward({
        addr: config.comfy_origin,
        authtoken: token
      })

      const ngrokConfig: NgrokConfig = {
        comfy_origin: comfyListener.url(),
        server_origin: chatListener.url()
      }

      lastNgrokAuthtoken = token
      lastNgrokConfig = ngrokConfig
      return ngrokConfig
    } catch (error) {
      lastNgrokAuthtoken = null
      lastNgrokConfig = null
      chatListener = null
      comfyListener = null
      throw error
    }
  }

  router.post('/api/ngrok/url', async (req: express.Request, res: express.Response) => {
    try {
      const { comfy_origin, server_origin } = await initNgrok(req.body.ngrokAuthtoken)
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ comfy_origin, server_origin }))
    } catch (error) {
      logger.error('Failed to init ngrok', error)
      handleApiError(error, res)
    }
  })

  // ---------- ComfyUI 代理 ----------
  // GET /view：同源图片代理。前端画布「圈选裁剪」要把产物图画进 canvas 再导出，
  // 直接 img.src=comfy_origin 会污染 canvas（ComfyUI 不带 CORS 头）→ toBlob 抛
  // SecurityError。走本代理后图片与页面同源，canvas 可导出。
  router.get('/view', async (req, res) => {
    try {
      const config = artifyUtils.getConfig()
      const queryString = new URLSearchParams(req.query as Record<string, string>).toString()
      const imageResponse = await fetchWithRetry(`${config.comfy_origin}/view?${queryString}`, {
        method: 'GET'
      })
      if (!imageResponse.ok) {
        res.status(imageResponse.status).json(createErrorResponse('Failed to fetch image'))
        return
      }
      res.setHeader(
        'Content-Type',
        imageResponse.headers.get('Content-Type') || 'application/octet-stream'
      )
      res.setHeader('Cache-Control', 'public, max-age=3600')
      if (imageResponse.body) {
        for await (const chunk of imageResponse.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk)
        }
        res.end()
      } else {
        res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .json(createErrorResponse('No image data received'))
      }
    } catch (error) {
      logger.error('Failed to get image', error)
      handleApiError(error, res)
    }
  })

  router.post('/view', async (req, res) => {
    try {
      const config = artifyUtils.getConfig()
      const queryString = new URLSearchParams(req.query as Record<string, string>).toString()
      const imageResponse = await fetchWithRetry(
        `${config.comfy_origin}/view?${queryString}&rand=${Math.random()}`,
        { method: 'GET' }
      )

      if (!imageResponse.ok) {
        throw new Error(
          `Failed to fetch image: ${imageResponse.status} ${imageResponse.statusText}`
        )
      }

      res.setHeader(
        'Content-Type',
        imageResponse.headers.get('Content-Type') || 'application/octet-stream'
      )
      if (imageResponse.body) {
        for await (const chunk of imageResponse.body as unknown as AsyncIterable<Uint8Array>) {
          res.write(chunk)
        }
        res.end()
      } else {
        res
          .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
          .json(createErrorResponse('No image data received'))
      }
    } catch (error) {
      logger.error('Failed to get image', error)
      handleApiError(error, res)
    }
  })

  // 历史记录获取
  router.post('/history/:id', async (req, res) => {
    try {
      const config = artifyUtils.getConfig()
      const response = await fetchWithRetry(`${config.comfy_origin}/history/${req.params.id}`, {
        method: 'GET'
      })

      if (!response.ok) {
        throw new Error(`Failed to fetch history: ${response.status} ${response.statusText}`)
      }
      const data = (await response.json()) as any
      res.status(HTTP_STATUS.OK).json(data)
    } catch (error) {
      logger.error('Failed to get history', error)
      handleApiError(error, res)
    }
  })

  // queue获取
  router.post('/queue', async (_req, res) => {
    try {
      const config = artifyUtils.getConfig()
      const response = await fetchWithRetry(`${config.comfy_origin}/queue`, { method: 'GET' })

      if (!response.ok) {
        throw new Error(`Failed to fetch queue: ${response.status} ${response.statusText}`)
      }
      const data = (await response.json()) as any
      res.status(HTTP_STATUS.OK).json(data)
    } catch (error) {
      logger.error('Failed to get queue', error)
      handleApiError(error, res)
    }
  })

  // ---------- 系统关机 ----------
  router.post('/api/shutdown', async (req: express.Request, res: express.Response) => {
    try {
      const { delay = 0, force = false } = req.body
      const r = scheduleSystemShutdown({ delay: Number(delay), force: !!force })
      if ('error' in r) {
        const status = r.error.startsWith('Delay')
          ? HTTP_STATUS.BAD_REQUEST
          : r.error.startsWith('Unsupported')
            ? HTTP_STATUS.INTERNAL_SERVER_ERROR
            : HTTP_STATUS.UNAUTHORIZED
        res.status(status).json(createErrorResponse(r.error))
        return
      }
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ started: true }))
    } catch (error) {
      logger.error('Shutdown failed', error)
      handleApiError(error, res)
    }
  })
  return router
}
