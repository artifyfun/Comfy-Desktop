import express from 'express'
import path from 'node:path'
import dotenv from 'dotenv'
import cookieParser from 'cookie-parser'
import bodyParser from 'body-parser'
import { createServer } from 'node:net'
import type { Server as HttpServer } from 'node:http'
import history from 'connect-history-api-fallback'

// 导入优化后的模块
import { CONFIG } from './config/constants'
import { logger } from './utils/logger'
import { handleApiError } from './utils/errorHandler'
import { getFrontendPath } from './utils/resourcePaths'
import { createMcpRouter } from './mcp'
import { createGalleryRouter } from './gallery/routes'
import { createAppsRouter } from './routes/apps'
import { createAiRouter } from './routes/ai'
import { createConfigRouter } from './routes/config'
import { createProxyRouter } from './routes/proxy'
import { createModelsRouter } from './routes/models'
import { createBatchRouter } from './routes/batch'

// Load environment variables from .env file
dotenv.config()

// 显式类型注解：pnpm 隔离布局下 express() 的推断类型引用了 .pnpm 深层路径，
// 触发 TS2742（类型不可命名）——注解为 express.Express。
const app: express.Express = express()

let server: HttpServer | null = null

// CORS 中间件 - 使用配置的域名
// 必须挂在所有业务路由之前：Express 4 对已注册路由的 OPTIONS 预检请求会
// 自动响应（200 + Allow），直接终结请求链，导致后面的 CORS 头永远不会被
// 写入——dev 模式下 A UI（localhost:5000）跨源请求 server（3008）时，
// 预检响应缺少 Access-Control-Allow-Origin，浏览器直接拦截（net::ERR_FAILED）。
app.use((req, res, next) => {
  const origin = req.headers.origin

  // 检查是否允许该域名
  if (
    CONFIG.CORS_ALLOWED_ORIGINS.includes('*') ||
    (origin && CONFIG.CORS_ALLOWED_ORIGINS.includes(origin))
  ) {
    res.header('Access-Control-Allow-Origin', origin || '*')
  }

  // 如果允许携带凭证，设置相应的头部
  if (CONFIG.CORS_ALLOW_CREDENTIALS) {
    res.header('Access-Control-Allow-Credentials', 'true')
  }

  res.header(
    'Access-Control-Allow-Headers',
    'Authorization,X-API-KEY, Origin, X-Requested-With, Content-Type, Accept, Access-Control-Request-Method'
  )
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PATCH, PUT, DELETE')
  res.header('Allow', 'GET, POST, PATCH, OPTIONS, PUT, DELETE')

  // 显式终结 CORS 预检请求：返回 204，避免落到业务路由被 Express 的
  // 自动 OPTIONS 处理截胡（那样响应缺少 CORS 头，浏览器照样拦截）。
  if (req.method === 'OPTIONS') {
    return res.sendStatus(204)
  }

  next()
})

// 请求体解析：必须挂在所有业务路由之前——Express 按注册顺序执行中间件，
// 若 bodyParser 在路由之后，POST 请求到达路由时 req.body 还是空的，
// 基于 body 的筛选（gallery 的 subfolder/starred/q、config 等）会全部失效。
app.use(bodyParser.json({ limit: CONFIG.BODY_LIMIT }))
app.use(bodyParser.urlencoded({ limit: CONFIG.BODY_LIMIT, extended: true }))
app.use(bodyParser.raw({ limit: CONFIG.BODY_LIMIT }))
app.use(bodyParser.text({ limit: CONFIG.BODY_LIMIT }))
app.use(cookieParser())

// MCP server（暴露 A UI app 为 MCP 工具，供 AI 客户端调用）
// 必须挂在 history() 之前：否则 GET /mcp（Accept */*）会被改写成 index.html（M5）
app.use('/mcp', createMcpRouter())

// Gallery 资产库（同样必须在 history() 之前，GET /api/gallery/thumbs 不能被改写）
app.use(createGalleryRouter())

// 业务路由（自 server.ts 拆分；POST 为主，挂在 history() 之后亦可，但保持同序）
app.use(createAppsRouter())
app.use(createAiRouter())
app.use(createConfigRouter())
app.use(createProxyRouter())
// 模型管理（GET /api/models/file 需在 history() 之前挂载）
app.use(createModelsRouter())
// 常驻批量任务（GET /api/batch/status 需在 history() 之前）
app.use(createBatchRouter())

// 中间件配置
app.use(history())

// 静态文件中间件
const setupStaticFiles = () => {
  const staticPath = getFrontendPath()

  logger.info('Setting up static file paths', {
    staticPath
  })

  // 静态文件头部设置函数
  const setStaticHeaders = (res: express.Response, filePath: string) => {
    if (filePath.endsWith('.js')) {
      res.setHeader('Content-Type', 'application/javascript')
    } else if (filePath.endsWith('.css')) {
      res.setHeader('Content-Type', 'text/css')
    } else if (filePath.endsWith('.json')) {
      res.setHeader('Content-Type', 'application/json')
    }
    res.setHeader('Cache-Control', CONFIG.STATIC_CACHE_CONTROL)
  }

  app.use('/', express.static(staticPath, { setHeaders: setStaticHeaders }))
}

// 限流中间件
// app.use(rateLimitMiddleware);

// 设置静态文件
setupStaticFiles()

// 处理所有其他路由
app.get('*', (req, res) => {
  // 检查是否是静态资源请求
  const staticExtensions = [
    '.js',
    '.css',
    '.png',
    '.jpg',
    '.jpeg',
    '.gif',
    '.svg',
    '.ico',
    '.woff',
    '.woff2',
    '.ttf',
    '.eot',
    '.json',
    '.map'
  ]
  const isStaticResource = staticExtensions.some((ext) => req.path.endsWith(ext))

  if (isStaticResource) {
    // 静态资源不存在时返回404
    return res.status(404).json({ error: 'Static resource not found' })
  }

  // 对于所有其他请求，返回index.html以支持前端路由
  const indexPath = path.join(getFrontendPath(), 'index.html')
  res.sendFile(indexPath)
})

// 全局错误处理中间件
app.use(
  (error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    logger.error('Unhandled error', error)
    handleApiError(error, res)
  }
)

export default app

export function startServer(): Promise<HttpServer> {
  return new Promise((resolve, reject) => {
    // 检查服务器是否已经在运行
    if (server && server.listening) {
      logger.info(`Server is already running on port ${CONFIG.PORT}`)
      return resolve(server)
    }

    // 在生产环境启动前检查并更新静态资源

    // 尝试启动服务器，如果端口被占用则自动选择其他端口
    // 优先尝试常用端口范围
    const preferredPorts = [Number(CONFIG.PORT), 3002, 3003, 9528, 8082, 5002, 5003]
    tryPreferredPorts(preferredPorts, 0)

    function tryPreferredPorts(ports: number[], index: number) {
      if (index >= ports.length) {
        // 所有首选端口都不可用，开始顺序尝试
        tryStartServer(Number(CONFIG.PORT))
        return
      }

      const port = ports[index]!
      const testServer = createServer()
      testServer.listen(port, () => {
        testServer.close(() => {
          // 端口可用，启动实际服务器
          startActualServer(port)
        })
      })

      testServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Preferred port ${port} is in use, trying next preferred port...`)
          tryPreferredPorts(ports, index + 1)
        } else {
          logger.error('Port test failed', err)
          reject(err)
        }
      })
    }

    function tryStartServer(port: number, attempts: number = 0) {
      // 检查端口是否可用
      const testServer = createServer()
      testServer.listen(port, () => {
        testServer.close(() => {
          // 端口可用，启动实际服务器
          startActualServer(port)
        })
      })

      testServer.on('error', (err: NodeJS.ErrnoException) => {
        if (err.code === 'EADDRINUSE') {
          logger.warn(`Port ${port} is already in use, trying next port...`)
          // 尝试下一个端口
          const nextPort = port + 1
          const maxAttempts = CONFIG.PORT_RANGE

          if (attempts < maxAttempts) {
            tryStartServer(nextPort, attempts + 1)
          } else {
            const endPort = Number(CONFIG.PORT) + maxAttempts
            logger.error(`No available ports found in range ${CONFIG.PORT}-${endPort}`)
            reject(
              new Error(
                `No available ports found in range ${CONFIG.PORT}-${endPort}. Please check your system or try a different starting port.`
              )
            )
          }
        } else {
          logger.error('Port test failed', err)
          reject(err)
        }
      })
    }

    function startActualServer(port: number) {
      server = app.listen(port, () => {
        logger.info(`Server is running on port ${port}`)
        resolve(server!)
        // 启动后后台扫描 output 目录，增量补录存量图片到 gallery.db
        setTimeout(() => {
          import('./gallery/scanner')
            .then((m) => m.scanOutputDir())
            .then((r) =>
              logger.info(`gallery scan done: ${r.added}/${r.scanned} in ${r.outputDir}`)
            )
            .catch((e) => logger.warn(`gallery scan failed: ${(e as Error).message}`))
        }, 5000)
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        logger.error('Server error', err)
        reject(err)
      })
    }
  })
}

export function getServer(): HttpServer | null {
  return server
}

export function getServerPort(): number | null {
  if (server && server.listening) {
    const address = server.address()
    if (address && typeof address === 'object' && 'port' in address) {
      return address.port
    }
  }
  return null
}
