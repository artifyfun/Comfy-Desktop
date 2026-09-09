/**
 * ACP host 适配器 —— 会话传输:拉起外部 ACP agent 子进程,驱动单 turn。
 *
 * 职责(对齐 appServerRun.ts 的「单 turn 驱动」契约,路由层/事件管线零改动):
 *   const runtime = await createAcpRuntime(opts)
 *   const { stream } = await runtime.startTurn(input, signal)
 *   for await (const frame of stream) { ... }  // frame = { event?, deltas[] }
 *
 * frame.event 为 exec 形态 ThreadEvent —— ACP 通知不产 exec 事件(事件面不同),
 * 全部走 mapper 直接映射 AG-UI 事件,transport 层以 CUSTOM acp_event 打包透传
 * (路由层 onProgress.stream_delta / thread_event 双路照常,AG-UI 管线消费一致)。
 *
 * 生命周期(对齐 ACP 规范):
 *   spawn(binary, args) → initialize(协议版本协商) → session/new(会话建组)
 *   → session/prompt(每 turn)→ session/update 通知流 → prompt stop reason。
 *   跨 turn 复用同一子进程与 sessionId(上下文连续);dispose() session/cancel
 *   (尽力而为)+ kill + 全量回收。
 *
 * HITL:agent 发来的 session/request_permission(Client→Server 请求)经
 * Client handler 桥接 approvalGate.intercept——approve → allow_once 选项应答;
 * reject/超时 → reject_once;gate 对该 thread 的超时兜底(fail-safe reject)
 * 与 AG-UI 管线共享同一 pending 表。fs/terminal 能力不声明 → agent 不会发起
 * 这两类请求,面收到也不支持(返回协议错误,不 crash)。
 *
 * 纯 child_process + SDK ClientSideConnection;spawn 可注入(mock 单测,零 flaky)。
 */
import { spawn } from 'node:child_process'
import {
  ClientSideConnection,
  PROTOCOL_VERSION,
  ndJsonStream,
  type Agent as IAcpAgent,
  type Client as IAcpClient
} from '@zed-industries/agent-client-protocol'
import type {
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification
} from '@zed-industries/agent-client-protocol/dist/schema'
import { createAcpMapper } from './mapper'
import type { AcpMapper } from './mapper'
import { runError, runFinished, runStarted } from '../types'
import type { AGUIEvent } from '../types'
import type { ApprovalGate } from '../approvalGate'
import { logger } from '../../utils/logger'

/** 会话级 token 用量(prompt turn 之间累计;ACP 无标准 usage 通知,先记 0 基线) */
export interface AcpTurnUsage {
  inputTokens: number
  outputTokens: number
}

/** 单 turn 驱动输出帧(与 appServerRun.RunFrame 同构;event 即 AG-UI 事件) */
export interface AcpRunFrame {
  event: AGUIEvent | null
  deltas: never[]
}

/** ACP agent 连接面(transport 用到的最小子集;测试注入同理收窄) */
export type AcpAgentConnection = Pick<IAcpAgent, 'initialize' | 'newSession' | 'prompt' | 'cancel'>

export interface AcpRuntime {
  /** 驱动一轮;stream 在 prompt 返回(stop reason)后结束 */
  startTurn(
    input: string,
    signal?: AbortSignal
  ): Promise<{ stream: AsyncGenerator<AcpRunFrame, void, unknown> }>
  dispose(): Promise<void>
}

/** session/new 注入的 MCP server(ACP wire 形态:http/sse/stdio 三选一) */
export interface AcpMcpServerInput {
  name: string
  type?: 'http' | 'sse'
  url: string
  headers?: Array<{ name: string; value: string }>
}

export interface AcpRuntimeOptions {
  /** ACP agent 二进制绝对路径(如 kimi / qwen / gemini) */
  binary: string
  /** spawn 参数(如 ['acp'];agent 定义层给出) */
  args: string[]
  /** 子进程环境变量 */
  env: NodeJS.ProcessEnv
  /** AG-UI threadId(= workbench sessionId) */
  threadId: string
  /** AG-UI runId */
  runId: string
  /** 审批门控(与 AG-UI SSE 管线共享同一实例,见 approvalRegistry) */
  approvalGate?: ApprovalGate
  /**
   * session/new 注入的 MCP server 列表(工作台 wb_* 工具面)。
   * 缺省/空 = 不注入(优雅降级,外部 agent 无工作台工具但仍可对话)。
   */
  mcpServers?: AcpMcpServerInput[]
  /** initialize/session 阶段超时(ms),默认 30s */
  setupTimeoutMs?: number
  /** session/prompt 单 turn 超时(ms),默认 15min(对齐 AGUI_RUN_TIMEOUT_MS) */
  turnTimeoutMs?: number
  /** 测试注入:自定义连接工厂(默认 spawn + ClientSideConnection) */
  connect?: (opts: {
    binary: string
    args: string[]
    env: NodeJS.ProcessEnv
    handlers: {
      sessionUpdate(n: SessionNotification): Promise<void>
      requestPermission(p: RequestPermissionRequest): Promise<RequestPermissionResponse>
    }
  }) => AcpAgentConnection
}

const DEFAULT_SETUP_TIMEOUT_MS = 30_000
const DEFAULT_TURN_TIMEOUT_MS = 15 * 60 * 1000

export async function createAcpRuntime(opts: AcpRuntimeOptions): Promise<AcpRuntime> {
  const {
    binary,
    args,
    env,
    threadId,
    runId,
    approvalGate,
    mcpServers = [],
    setupTimeoutMs = DEFAULT_SETUP_TIMEOUT_MS,
    turnTimeoutMs = DEFAULT_TURN_TIMEOUT_MS,
    connect
  } = opts

  const mapper: AcpMapper = createAcpMapper({ threadId, runId })
  let disposed = false
  /** prompt turn 在途标记(cancel 收口判断用) */
  let promptInFlight = false

  /** 通知派发队列 + 拉取等待者(与 appServerRun 同款 AsyncGenerator 拉取模型) */
  let queue: AcpRunFrame[] = []
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }
  const pushEvent = (event: AGUIEvent): void => {
    queue.push({ event, deltas: [] })
    wake()
  }
  /** 哨兵空帧:prompt 已收口,generator 见帧即收流 */
  const pushSentinel = (): void => {
    queue.push({ event: null, deltas: [] })
    wake()
  }

  // ---- Client 侧 handler:agent → client 的请求/通知 ----
  const clientHandlers = {
    sessionUpdate: async (n: SessionNotification): Promise<void> => {
      for (const ev of mapper.feed(n)) pushEvent(ev)
    },
    requestPermission: async (p: RequestPermissionRequest): Promise<RequestPermissionResponse> => {
      if (!approvalGate) {
        // 无门控通道(单测/无 SSE run):放行第一个 allow 类选项,无则 reject_once
        const allow = p.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
        return allow
          ? { outcome: { outcome: 'selected', optionId: allow.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      }
      const toolName = p.toolCall?.title ?? 'acp_tool'
      const result = await approvalGate.intercept(threadId, toolName, {
        toolCallId: p.toolCall?.toolCallId ?? '',
        options: p.options.map((o) => ({ optionId: o.optionId, kind: o.kind, name: o.name }))
      })
      if (!result.approved) {
        const reject = p.options.find((o) => o.kind === 'reject_once' || o.kind === 'reject_always')
        return reject
          ? { outcome: { outcome: 'selected', optionId: reject.optionId } }
          : { outcome: { outcome: 'cancelled' } }
      }
      const allow = p.options.find((o) => o.kind === 'allow_once' || o.kind === 'allow_always')
      if (!allow) return { outcome: { outcome: 'cancelled' } }
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
  }

  // ---- 连接建立 ----
  /** 子进程强杀柄(defaultConnect 装配;注入 connect 时保持 null) */
  let kill: (() => void) | null = null
  const agent: AcpAgentConnection = (() => {
    const defaultConnect: NonNullable<AcpRuntimeOptions['connect']> = (connectOpts) => {
      let child: ReturnType<typeof spawn> | null = null
      child = spawn(connectOpts.binary, connectOpts.args, {
        env: connectOpts.env,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      child.on('error', (err) => {
        logger.warn(`[acp] 子进程错误: ${String(err)}`)
        pushEvent(runError(`ACP agent 进程错误: ${String(err)}`))
        wake()
      })
      // Node Readable/Writable → Web streams(适配 SDK ndJsonStream):
      // stdin 直写;stdout 逐行拆帧(NDJSON),end 时关闭流
      const writable = new WritableStream<Uint8Array>({
        write(chunk) {
          if (child?.stdin && !child.stdin.destroyed) child.stdin.write(chunk)
        }
      })
      let stdoutBuf = ''
      const readable = new ReadableStream<Uint8Array>({
        start(controller) {
          child?.stdout?.setEncoding('utf8')
          child?.stdout?.on('data', (s: string) => {
            stdoutBuf += s
            let idx: number
            while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
              const line = stdoutBuf.slice(0, idx)
              stdoutBuf = stdoutBuf.slice(idx + 1)
              if (!line.trim()) continue
              controller.enqueue(new TextEncoder().encode(line + '\n'))
            }
          })
          child?.stdout?.on('end', () => controller.close())
        }
      })
      kill = () => {
        if (child && !child.killed) child.kill('SIGKILL')
      }
      const stream = ndJsonStream(writable, readable)
      return new ClientSideConnection(
        () => connectOpts.handlers as unknown as IAcpClient,
        stream
      ) as unknown as AcpAgentConnection
    }
    const doConnect = connect ?? defaultConnect
    return doConnect({ binary, args, env, handlers: clientHandlers })
  })()

  /** 幂等握手:initialize → session/new(缓存,首 turn 触发) */
  let setupPromise: Promise<string> | null = null
  const ensureSession = (): Promise<string> => {
    if (!setupPromise) {
      setupPromise = (async () => {
        const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
          Promise.race([
            p,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`ACP ${what} 超时(${ms}ms)`)), ms).unref?.()
            )
          ])
        const initRes = (await withTimeout(
          agent.initialize({
            protocolVersion: PROTOCOL_VERSION,
            clientCapabilities: {
              fs: { readTextFile: false, writeTextFile: false },
              terminal: false
            }
          }),
          setupTimeoutMs,
          'initialize'
        )) as { protocolVersion?: number | string }
        logger.info(`[acp] initialize 协议版本 ${String(initRes?.protocolVersion ?? '?')}`)
        const sessionRes = (await withTimeout(
          agent.newSession({
            cwd: process.cwd(),
            // AcpMcpServerInput → ACP wire 形态(type 归一 http;SDK 的 http/sse
            // 变体要求 headers 必填——缺省给空数组)
            mcpServers: mcpServers.map((s) => ({
              type: s.type ?? 'http',
              name: s.name,
              url: s.url,
              headers: s.headers ?? []
            }))
          }),
          setupTimeoutMs,
          'session/new'
        )) as { sessionId?: string }
        if (!sessionRes?.sessionId) throw new Error('ACP session/new 未返回 sessionId')
        return sessionRes.sessionId
      })()
    }
    return setupPromise
  }

  const runtime: AcpRuntime = {
    async startTurn(input, signal) {
      if (disposed) throw new Error('ACP runtime 已销毁')
      const sessionId = await ensureSession()

      // 生命周期帧:RUN_STARTED 与 codex 通道 thread.started→RUN_STARTED 对齐
      pushEvent(runStarted(threadId, runId))

      promptInFlight = true
      let turnFailed = false
      const promptPromise = agent
        .prompt({ sessionId, prompt: [{ type: 'text', text: input }] })
        .then((res: { stopReason?: string }) => {
          // stop reason:end = 正常收口;cancelled/max_tokens 等 → RUN_ERROR 留痕
          if (res.stopReason && res.stopReason !== 'end_turn') {
            turnFailed = true
            pushEvent(runError(`ACP turn 异常收口: ${res.stopReason}`, res.stopReason))
          }
          return res
        })
        .catch((err: unknown) => {
          turnFailed = true
          pushEvent(runError(`ACP prompt 失败: ${String(err)}`))
          return { stopReason: 'error' as const }
        })

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            // session/cancel 是通知(无响应);prompt Promise 会带 cancelled 收口
            try {
              void agent.cancel({ sessionId })
            } catch {
              /* 进程已死时忽略 */
            }
            wake()
          },
          { once: true }
        )
      }

      const turnTimeout = setTimeout(() => {
        try {
          void agent.cancel({ sessionId })
        } catch {
          /* 忽略 */
        }
      }, turnTimeoutMs)
      turnTimeout.unref?.()

      // prompt 收口 → 补终帧 + 哨兵帧唤醒 generator 收流(终帧是流结束的
      // 唯一哨兵:generator 阻塞在队列拉取上,必须由生产侧唤醒)
      void promptPromise.then(() => {
        promptInFlight = false
        if (!signal?.aborted && !turnFailed) {
          pushEvent(runFinished(threadId, runId))
        }
        pushSentinel()
      })

      const stream = (async function* (): AsyncGenerator<AcpRunFrame, void, unknown> {
        try {
          while (true) {
            while (queue.length === 0) {
              if (signal?.aborted) return
              await new Promise<void>((r) => waiters.push(r))
            }
            const frame = queue.shift()!
            if (frame.event) yield frame
            // RUN_ERROR 是终帧(与 codexMapper/路由终帧口径一致);哨兵空帧
            // (event=null)表示 prompt 已收口、终帧已发,结束拉取
            if (frame.event?.type === 'RUN_ERROR') return
            if (frame.event === null) return
          }
        } finally {
          turnTimeout.unref?.()
          clearTimeout(turnTimeout)
          await promptPromise
          promptInFlight = false
          // 清残帧:turn 间队列干净开始
          queue = []
        }
      })()
      return { stream }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      if (promptInFlight) {
        try {
          const sessionId = await ensureSession()
          void agent.cancel({ sessionId })
        } catch {
          /* 忽略 */
        }
      }
      wake()
      kill?.()
    }
  }

  return runtime
}
