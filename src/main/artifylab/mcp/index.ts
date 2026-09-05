/**
 * MCP server 组装：底层 Server + StreamableHTTPServerTransport，挂到 express /mcp。
 *
 * 审核修复：H1(session map——支持多客户端/重连，每 session 独立 server/transport，共享 registry)
 *  M5(token 日志脱敏) M6(移除通配 CORS——MCP 客户端非浏览器)。
 *
 * appStore change → registry.sync + 广播 list_changed 到所有 session（决策 #6）。
 */
import { Router, type Request, type Response } from 'express'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { randomUUID } from 'node:crypto'
import appStoreManager from '../appStore'
import { createToolRegistry } from './tools'
import {
  createWorkbenchAugmentedRegistry,
  resolveWorkbenchSessionFromRequest,
  EXTERNAL_ONLY_TOOL_NAMES
} from './workbenchTools'
import {
  createApprovalGatedRegistry,
  getApprovalGate,
  mcpIdentityStorage
} from '../agui/approvalRegistry'
import { getOrCreateMcpToken, validateMcpToken } from './auth'
import { logger } from '../utils/logger'

export function getMcpToken(): string {
  return getOrCreateMcpToken()
}

export function createMcpRouter(): Router {
  const router = Router()
  // 组合 registry：外部 app 工具 + 工作台编排工具（wb_*，decide agent 用）。
  // 外部客户端也能看到 wb_*，但无 decide 上下文时调用会得到明确错误（工具内校验）。
  // 最外层包审批门控（C14）：带 decide 会话身份的调用在白名单工具执行前挂起等审批；
  // 无身份（外部 MCP 客户端）完全直通，行为与门控引入前逐字节一致。
  const registry = createApprovalGatedRegistry(
    createWorkbenchAugmentedRegistry(createToolRegistry()),
    getApprovalGate()
  )

  // H1：每 session 独立 (server, transport)，共享 registry；支持多客户端与重连
  const sessions = new Map<string, { server: Server; transport: StreamableHTTPServerTransport }>()

  const createSessionServer = (): Server => {
    const s = new Server(
      { name: 'artify-apps', version: '1.0.0' },
      { capabilities: { tools: { listChanged: true } } }
    )
    s.setRequestHandler(ListToolsRequestSchema, async () => {
      // decide agent（带会话身份）只暴露 wb_* 编排工具：app 工具是给外部 MCP
      // 客户端的，对决策线程是纯常驻噪音。无身份（外部）返回全量清单。
      const identity = mcpIdentityStorage.getStore()
      const tools = identity
        ? registry.list().filter((t) => !EXTERNAL_ONLY_TOOL_NAMES.has(t.name))
        : registry.list()
      return { tools }
    })
    s.setRequestHandler(CallToolRequestSchema, async (req) => {
      const { name, arguments: args } = req.params
      try {
        // 身份经 AsyncLocalStorage 透传(HTTP 层 mcpIdentityStorage.run 注入,
        // 门控 registry 层读取)——此处无需显式传第三参
        return (await registry.handle(name, args ?? {})) as {
          content: unknown[]
          isError?: boolean
        }
      } catch (e) {
        return { content: [{ type: 'text', text: `Error: ${String(e)}` }], isError: true }
      }
    })
    return s
  }

  // app 增删/改 → sync + 广播 list_changed 到所有已连接 session
  appStoreManager.on('change', () => {
    registry.sync()
    for (const { server } of sessions.values()) {
      server.sendToolListChanged().catch(() => {})
    }
  })

  // 鉴权 + OPTIONS 预检（M6：不设通配 Access-Control-Allow-Origin；MCP 客户端非浏览器，无 CSRF 面）
  router.use((req, res, next) => {
    if (req.method === 'OPTIONS') {
      res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, mcp-session-id')
      res.header('Access-Control-Allow-Methods', 'POST, GET, DELETE')
      res.sendStatus(204)
      return
    }
    if (!validateMcpToken(req)) {
      res.sendStatus(401)
      return
    }
    next()
  })

  const handle = async (req: Request, res: Response): Promise<void> => {
    // C7 身份闭环:X-Workbench-Session header / wb_session query 在 HTTP 层解析一次,
    // 经 AsyncLocalStorage 带进 SDK 的 CallToolRequestSchema handler(SDK 回调拿不到
    // 原始 express req)。无身份(外部 MCP 客户端)store 为 undefined → gated registry
    // 完全直通,外部调用行为与门控引入前逐字节一致。
    const identity = resolveWorkbenchSessionFromRequest(req.headers, req.originalUrl) ?? undefined
    await mcpIdentityStorage.run(identity, async () => {
      await handleInner(req, res)
    })
  }

  const handleInner = async (req: Request, res: Response): Promise<void> => {
    const sessionId = req.headers['mcp-session-id'] as string | undefined
    if (sessionId) {
      const sess = sessions.get(sessionId)
      if (!sess) {
        res.status(404).send('session not found')
        return
      }
      await sess.transport.handleRequest(req, res, req.body)
      return
    }
    // 新 session（initialize 请求无 mcp-session-id）—— 创建独立 server/transport
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID() })
    const server = createSessionServer()
    transport.onclose = () => {
      const sid = transport.sessionId
      if (sid) {
        sessions.delete(sid)
        void server.close().catch(() => {})
      }
    }
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
    const sid = transport.sessionId
    if (sid) sessions.set(sid, { server, transport })
  }

  router.post('/', async (req, res) => {
    try {
      await handle(req, res)
    } catch (e) {
      if (!res.headersSent) res.status(500).send(String(e))
    }
  })
  router.get('/', async (req, res) => {
    try {
      await handle(req, res)
    } catch (e) {
      if (!res.headersSent) res.status(500).send(String(e))
    }
  })
  router.delete('/', async (req, res) => {
    try {
      await handle(req, res)
    } catch (e) {
      if (!res.headersSent) res.status(500).send(String(e))
    }
  })

  // M5：token 脱敏（只显示前 4 位，完整值在配置文件）
  const origin = appStoreManager.getConfig().serverHost
  const token = getOrCreateMcpToken()
  logger.info(
    `[MCP] 已挂载 ${origin}/mcp | token: ${token.slice(0, 4)}***（完整值见 artify-apps.json 的 config.mcpToken）`
  )

  return router
}
