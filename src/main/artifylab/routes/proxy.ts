import express from 'express'
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { handleApiError, createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { fetchWithRetry } from '../utils/fetch'
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
      const url = String(req.body?.url || '').trim()
      const title = String(req.body?.title || '').slice(0, 200)
      const bodyText = String(req.body?.body || '').slice(0, 2000)
      if (!/^https:\/\//i.test(url)) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('url must be a valid https webhook'))
        return
      }
      let parsed: URL
      try {
        parsed = new URL(url)
      } catch {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid url'))
        return
      }

      let resp: Response
      if (parsed.pathname.includes('/sendMessage')) {
        // Telegram Bot API
        resp = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text: `${title}\n${bodyText}`.trim() })
        })
      } else if (parsed.hostname === 'api.day.app' || parsed.hostname === 'api.bark.app') {
        // Bark：路径拼接（encodeURIComponent）
        const barkUrl = `${parsed.origin}${parsed.pathname}/${encodeURIComponent(title)}/${encodeURIComponent(bodyText || 'done')}`
        resp = await fetchWithRetry(barkUrl, { method: 'GET' })
      } else {
        // 通用 webhook（server酱 / 飞书 / 钉钉等）
        resp = await fetchWithRetry(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, body: bodyText })
        })
      }
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ status: resp.status }, `notify http ${resp.status}`))
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

      // 验证延迟时间
      if (delay < 0 || delay > 3600) {
        return res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('Delay must be between 0 and 3600 seconds'))
      }

      const currentPlatform = platform()
      let shutdownCommand: string

      // 根据操作系统构建关机命令
      switch (currentPlatform) {
        case 'win32': {
          // Windows 关机命令
          const forceFlag = force ? '/f' : ''
          const delayFlag = delay > 0 ? `/t ${delay}` : ''
          shutdownCommand = `shutdown /s ${forceFlag} ${delayFlag}`.trim()
          break
        }

        case 'darwin':
          // macOS 关机命令
          if (delay > 0) {
            shutdownCommand = `sudo shutdown -h +${Math.ceil(delay / 60)}`
          } else {
            shutdownCommand = 'sudo shutdown -h now'
          }
          break

        case 'linux':
          // Linux 关机命令
          if (delay > 0) {
            shutdownCommand = `sudo shutdown -h +${Math.ceil(delay / 60)}`
          } else {
            shutdownCommand = 'sudo shutdown -h now'
          }
          break

        default:
          return res
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .json(createErrorResponse(`Unsupported operating system: ${currentPlatform}`))
      }

      logger.info('Executing shutdown command', {
        platform: currentPlatform,
        command: shutdownCommand,
        delay,
        force
      })

      // 执行关机命令
      exec(shutdownCommand, (error, stdout, stderr) => {
        if (error) {
          logger.error('Shutdown command failed', {
            error: error.message,
            stderr,
            platform: currentPlatform
          })

          // 如果是权限错误，提供更友好的错误信息
          if (error.message.includes('permission') || error.message.includes('denied')) {
            return res
              .status(HTTP_STATUS.UNAUTHORIZED)
              .json(
                createErrorResponse(
                  'Permission denied. Please run the application with administrator/sudo privileges.'
                )
              )
          }

          return res
            .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
            .json(createErrorResponse(`Shutdown failed: ${error.message}`))
        }

        logger.info('Shutdown command executed successfully', {
          stdout,
          platform: currentPlatform
        })

        const message =
          delay > 0 ? `System will shutdown in ${delay} seconds` : 'System shutdown initiated'

        res.status(HTTP_STATUS.OK).json(
          createSuccessResponse(
            {
              command: shutdownCommand,
              platform: currentPlatform,
              delay,
              force
            },
            message
          )
        )
      })
    } catch (error) {
      handleApiError(error, res)
    }
  })

  return router
}
