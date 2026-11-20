/**
 * C16 — codex app-server 子进程 JSON-RPC 客户端(workbench-agui-migration.md §C16)。
 *
 * 职责:拉起 `codex app-server` 子进程(stdio 传输),提供:
 *   - request(method, params):带 id 的 JSON-RPC 请求,Promise 化(响应/超时)
 *   - 通知流:onNotification 回调(method + params 逐条上抛)
 *   - dispose():turn/interrupt + kill + 流清理
 *
 * spike 实测坑位(0.149.x,迁移文档 C16 节):
 *   - app-server 不读 CODEX_HOME/config.toml 的 model_provider 段 → provider
 *     必须 -c 命令行覆盖(args 注入,与生产 exec 通道的 SDK config 覆盖同构);
 *   - initialize 必须先发,否则后续请求被静默丢弃;
 *   - turn/start params 平铺(threadId + input 顶层),thread/start params 有
 *     params 嵌套——两个方法形态不一致,客户端不猜结构,由调用方给全。
 *
 * 纯 child_process 实现,零 electron 依赖,可直接单测(mock spawn)。
 */
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process'
import { createInterface } from 'node:readline'
import { logger } from '../utils/logger'

/** app-server JSON-RPC 通知(method + params) */
export interface AppServerNotification {
  method: string
  params: Record<string, unknown>
}

/** JSON-RPC 错误对象(协议层) */
interface JsonRpcError {
  code: number
  message: string
}

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export interface AppServerClientOptions {
  /** codex 二进制绝对路径 */
  binary: string
  /** 子进程环境变量(CODEX_HOME / provider env_key 等由调用方注入) */
  env: NodeJS.ProcessEnv
  /** -c 配置覆盖参数(已拼好的 key=value 形态) */
  configArgs?: string[]
  /** 单请求超时(ms),默认 120s(decide 轮可跑数分钟,通知不算请求) */
  requestTimeoutMs?: number
  /** 逐行 stdout 解析失败时是否抛(默认 false 记日志跳过——脏行不该杀会话) */
  onNotification: (n: AppServerNotification) => void
}

export interface AppServerClient {
  request(method: string, params: unknown): Promise<unknown>
  dispose(): Promise<void>
  /** 子进程是否已退出(killed/崩溃) */
  isDead(): boolean
}

export function startAppServerClient(opts: AppServerClientOptions): AppServerClient {
  const { binary, env, configArgs = [], requestTimeoutMs = 120_000, onNotification } = opts

  const args = ['app-server', ...configArgs.flatMap((c) => ['-c', c])]
  let child: ChildProcessWithoutNullStreams
  try {
    child = spawn(binary, args, {
      env,
      stdio: ['pipe', 'pipe', 'pipe']
    }) as ChildProcessWithoutNullStreams
  } catch (err) {
    throw new Error(`app-server spawn 失败: ${String(err)}`, { cause: err })
  }

  const pending = new Map<number, PendingRequest>()
  let nextId = 1
  let dead = false
  let disposed = false

  const failAll = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer)
      p.reject(err)
    }
    pending.clear()
  }

  child.once('exit', (code, signal) => {
    dead = true
    failAll(new Error(`app-server 进程退出(code=${code} signal=${signal})`))
  })
  child.once('error', (err) => {
    dead = true
    failAll(new Error(`app-server 进程错误: ${String(err)}`))
  })

  // stderr 只留日志(协议错误排查用),不影响流
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', (d: string) => {
    logger.debug('[app-server] stderr', d.slice(0, 500))
  })

  // stdout 逐行 JSON-RPC 消息
  const rl = createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    const s = line.trim()
    if (!s) return
    let msg: {
      id?: number | string
      method?: string
      params?: Record<string, unknown>
      result?: unknown
      error?: JsonRpcError
    }
    try {
      msg = JSON.parse(s)
    } catch {
      logger.debug('[app-server] 非 JSON 行,跳过', s.slice(0, 200))
      return
    }
    if (msg.method !== undefined) {
      // 通知(或 server→client 请求:审批类。C16 首版不处理,原样上抛由上层决定)
      try {
        onNotification({ method: msg.method, params: msg.params ?? {} })
      } catch (err) {
        logger.warn('[app-server] 通知处理异常(不杀会话)', err)
      }
      return
    }
    // 响应
    const id = typeof msg.id === 'string' ? Number(msg.id) : msg.id
    if (typeof id !== 'number' || !Number.isFinite(id)) return
    const p = pending.get(id)
    if (!p) return
    pending.delete(id)
    clearTimeout(p.timer)
    if (msg.error) p.reject(new Error(`app-server ${String(msg.error.code)}: ${msg.error.message}`))
    else p.resolve(msg.result)
  })

  const send = (obj: unknown): void => {
    if (dead) throw new Error('app-server 进程已退出')
    child.stdin.write(JSON.stringify(obj) + '\n')
  }

  return {
    request(method, params) {
      return new Promise((resolve, reject) => {
        if (dead || disposed) {
          reject(new Error('app-server 客户端不可用(已退出/已销毁)'))
          return
        }
        const id = nextId++
        const timer = setTimeout(() => {
          pending.delete(id)
          reject(new Error(`app-server 请求超时: ${method}`))
        }, requestTimeoutMs)
        pending.set(id, { resolve, reject, timer })
        try {
          send({ jsonrpc: '2.0', id, method, params })
        } catch (err) {
          clearTimeout(timer)
          pending.delete(id)
          reject(err instanceof Error ? err : new Error(String(err)))
        }
      })
    },
    async dispose() {
      if (disposed) return
      disposed = true
      failAll(new Error('app-server 客户端已销毁'))
      rl.close()
      if (!child.killed) child.kill('SIGKILL')
    },
    isDead: () => dead
  }
}
