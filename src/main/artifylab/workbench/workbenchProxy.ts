/**
 * workbench 内嵌的 responses→chat 转换代理。
 *
 * 背景：新版 codex CLI 只支持 OpenAI Responses 协议（wire_api="responses"），
 * 而 new-api 等网关对 /v1/responses 返回 not implemented（无 ChatCompletions→Responses
 * 兼容开关时）。本服务在应用进程内起 127.0.0.1 随机端口，把 codex 的
 * /v1/responses 请求翻译为上游 /v1/chat/completions，流式/工具调用/多模态全支持。
 *
 * 核心转换层提炼自 mimo2codex v0.5.29（MIT，© 7as0nch），同目录 LICENSE 留存：
 * translate/* （reqToChat / respToResponses / streamToSse / minimaxCompat）
 * upstream/*  （openaiCompatClient / chatStream）
 * providers/generic.js 提供可配置的上游适配。刻意不含 admin/db/auth——应用自治、零外部依赖。
 */
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { createGenericProvider } from '../vendor/mimo2codex/providers/generic.js'
import {
  callOpenAICompat,
  UpstreamError
} from '../vendor/mimo2codex/upstream/openaiCompatClient.js'
import { iterChatStreamChunks } from '../vendor/mimo2codex/upstream/chatStream.js'
import { respToResponses } from '../vendor/mimo2codex/translate/respToResponses.js'
import { pipeChatStreamToResponses } from '../vendor/mimo2codex/translate/streamToSse.js'

export interface WorkbenchProxyConfig {
  /** 上游 OpenAI 兼容 base url（如 new-api 网关 http://192.168.x.x:3000/v1） */
  upstreamBaseUrl: string
  upstreamApiKey: string
  /** 上游模型 id（原样转发到 chat/completions 的 model 字段） */
  model: string
  preferredPort?: number
}

interface SelectedRequest {
  provider: ReturnType<typeof createGenericProvider>
  upstreamModel: string
}

function select(cfg: WorkbenchProxyConfig, clientModel: string): SelectedRequest {
  const provider = createGenericProvider({
    id: 'artify-upstream',
    displayName: 'Artify Upstream',
    baseUrl: cfg.upstreamBaseUrl,
    envKey: 'ARTIFY_UPSTREAM_API_KEY',
    wireApi: 'chat',
    defaultModel: cfg.model
  })
  // 模型字段恒改写为本代理配置的上游模型：客户端（codex）侧看到的模型名
  // 允许是任意值（如 "gpt-5" 占位），真正路由由配置决定
  void clientModel
  return { provider, upstreamModel: cfg.model }
}

/**
 * codex 的 responses 请求里，MCP 工具以 `{type:"namespace", name, tools:[…]}` 包装：
 * 模型侧只见裸工具名，执行时 codex 按 `namespace` 字段把调用派回对应 runtime。
 * chat-completions 协议没有 namespace 概念——翻译层把 wrapper 拍平成裸名
 * function tools 后这个归属关系会丢；回程若不带 namespace，codex 一律按默认
 * "functions" namespace 查路由表，MCP 工具查不到 →
 * `codex_core::tools::router: error=unsupported call: wb_*`（stderr 实测）。
 * 这里在请求侧把「裸工具名 → wrapper 名」收进 Map，回程翻译时附回 namespace。
 */
function buildNamespaceMap(tools: unknown): Map<string, string> {
  const map = new Map<string, string>()
  if (!Array.isArray(tools)) return map
  for (const t of tools) {
    if (!t || typeof t !== 'object' || (t as Record<string, unknown>).type !== 'namespace') {
      continue
    }
    const ns = t as { name?: unknown; tools?: unknown }
    if (typeof ns.name !== 'string' || !Array.isArray(ns.tools)) continue
    for (const inner of ns.tools) {
      if (inner && typeof inner === 'object') {
        const name = (inner as Record<string, unknown>).name
        if (typeof name === 'string') map.set(name, ns.name)
      }
    }
  }
  return map
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(payload)
}

function errorEnvelope(status: number, code: string, message: string) {
  return {
    error: {
      message,
      type: status >= 500 ? 'server_error' : 'invalid_request_error',
      code
    }
  }
}

async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

/** codex 探活形态（{model} 无 input/instructions）直接合成 200，不打上游 */
function isProbe(payload: Record<string, unknown>): boolean {
  return !payload.input && !payload.instructions
}

function probeResponse(payload: Record<string, unknown>) {
  return {
    id: 'resp_probe',
    object: 'response',
    created_at: Math.floor(Date.now() / 1000),
    status: 'completed',
    model: payload.model ?? '',
    output: [],
    usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    in_progress: false
  }
}

const KEEPALIVE_MS = 15_000

export function startWorkbenchProxy(
  config: WorkbenchProxyConfig
): Promise<{ server: Server; port: number; baseUrl: string }> {
  const server = createServer((req, res) => {
    void (async () => {
      try {
        if (req.method === 'GET' && (req.url === '/' || req.url === '/healthz')) {
          return sendJson(res, 200, { ok: true, name: 'artify-workbench-proxy' })
        }
        if (req.method !== 'POST' || !(req.url === '/v1/responses' || req.url === '/responses')) {
          return sendJson(
            res,
            404,
            errorEnvelope(404, 'not_found', `no route for ${req.method} ${req.url ?? ''}`)
          )
        }

        let payload: Record<string, unknown>
        try {
          payload = await readJsonBody(req)
        } catch (err) {
          return sendJson(res, 400, errorEnvelope(400, 'invalid_json', String(err)))
        }
        if (!payload.model) {
          return sendJson(
            res,
            400,
            errorEnvelope(400, 'missing_model', "request body must include 'model'")
          )
        }
        if (isProbe(payload)) {
          return sendJson(res, 200, probeResponse(payload))
        }
        const namespaceMap = buildNamespaceMap(payload.tools)

        const { provider, upstreamModel } = select(config, String(payload.model))
        const chat = provider.preprocessResponses(payload, {
          runtime: { baseUrl: config.upstreamBaseUrl, apiKey: config.upstreamApiKey },
          exposeReasoning: true,
          dataDir: undefined,
          disableThinking: false,
          forceHighEffort: false,
          webSearchEnabled: false,
          upstreamModel
        }) as Record<string, unknown>
        chat.model = upstreamModel
        chat.stream = !!payload.stream

        const ac = new AbortController()
        req.on('close', () => ac.abort())

        if (!payload.stream) {
          const upstreamRes = await callOpenAICompat(
            {
              baseUrl: config.upstreamBaseUrl,
              apiKey: config.upstreamApiKey,
              contextOverflowMode: 'passthrough',
              modelInfo: { id: upstreamModel }
            },
            chat,
            ac.signal
          )
          const chatJson = await upstreamRes.json()
          const responses = respToResponses(chatJson, payload, {
            exposeReasoning: true,
            extractInlineThink: false,
            namespaceMap
          })
          return sendJson(res, 200, responses)
        }

        // 流式：先回 SSE 头 + keepalive，再接上游流翻译为 responses SSE
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no'
        })
        const write = (event: string, data: unknown): void => {
          if (res.writableEnded || res.destroyed) return
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
        }
        const keepalive = setInterval(() => {
          if (!res.writableEnded && !res.destroyed) res.write(': keepalive\n\n')
        }, KEEPALIVE_MS)
        res.on('close', () => clearInterval(keepalive))

        let upstreamRes
        try {
          upstreamRes = await callOpenAICompat(
            {
              baseUrl: config.upstreamBaseUrl,
              apiKey: config.upstreamApiKey,
              contextOverflowMode: 'passthrough',
              modelInfo: { id: upstreamModel }
            },
            chat,
            ac.signal
          )
        } catch (err) {
          clearInterval(keepalive)
          const code = err instanceof UpstreamError ? err.code : 'internal_error'
          if (!res.writableEnded && !res.destroyed) {
            write('error', { type: 'error', code, message: String(err), sequence_number: 9999 })
            res.end()
          }
          return
        }
        try {
          const chunks = iterChatStreamChunks(upstreamRes)
          await pipeChatStreamToResponses(
            {
              write,
              comment: () => {},
              end: (): void => {},
              closed: (): boolean => res.writableEnded || res.destroyed
            },
            { chunks },
            payload,
            { exposeReasoning: true, extractInlineThink: false, namespaceMap }
          )
        } catch (err) {
          if (!res.writableEnded && !res.destroyed) {
            write('error', {
              type: 'error',
              code: 'stream_error',
              message: String(err),
              sequence_number: 9999
            })
          }
        } finally {
          clearInterval(keepalive)
          if (!res.writableEnded && !res.destroyed) res.end()
        }
      } catch (err) {
        const isUpstream = err instanceof UpstreamError
        const status = isUpstream ? err.status : 500
        if (!res.headersSent) {
          sendJson(
            res,
            status,
            errorEnvelope(status, isUpstream ? err.code : 'internal_error', String(err))
          )
        } else if (!res.writableEnded) {
          res.end()
        }
      }
    })()
  })

  return new Promise((resolve, reject) => {
    const port = config.preferredPort ?? 0
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      const boundPort = typeof address === 'object' && address ? address.port : port
      resolve({ server, port: boundPort, baseUrl: `http://127.0.0.1:${boundPort}/v1` })
    })
  })
}
