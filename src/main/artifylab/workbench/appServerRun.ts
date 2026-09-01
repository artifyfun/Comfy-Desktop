/**
 * C16 — app-server 通道的会话级运行时(workbench-agui-migration.md §C16)。
 *
 * 职责:管理一个常驻的 codex app-server 子进程 + thread,提供与 exec 通道
 * agent.thread.runStreamed 同构的「单 turn 驱动」:
 *
 *   const run = await runtime.startTurn(spec, signal)
 *   for await (const frame of run.stream) { ... } // frame = { event?, deltas[] }
 *
 * 输出对齐 exec 通道两路:
 *   - event: exec 形态 ThreadEvent(translator 翻译);turn 收口帧
 *     (turn.completed/turn.failed/error)作为流尾,end 后 generator 结束;
 *   - deltas: token 级 StreamDelta(mapper.feedStreamDelta 消费)。
 *
 * 生命周期:子进程与 thread 跨 decide 复用(模型上下文连续);dispose() 全量
 * 回收。turn 中断(signal)→ turn/interrupt(尽力而为,进程保留供下轮)。
 *
 * spike 坑位:app-server 不读 CODEX_HOME/config.toml 的 provider 段,provider
 * 必须以 -c 命令行覆盖注入(configArgs 由调用方拼)。
 */
import type { ThreadEvent } from '../vendor/codex-sdk'
import { type AppServerClient, startAppServerClient } from '../agui/appServerClient'
import { type AppServerTranslator, createAppServerTranslator } from '../agui/appServerTranslator'
import { logger } from '../utils/logger'

/** token 级增量(translator 产出的 StreamDelta 同构) */
export interface RunFrameDelta {
  kind: 'text' | 'reasoning'
  itemId: string
  delta: string
}

/** 驱动流的一帧:exec 形态事件(可空)与同批 delta */
export interface RunFrame {
  event: ThreadEvent | null
  deltas: RunFrameDelta[]
}

export interface AppServerRuntime {
  /** 驱动一轮 turn;stream 在 turn 收口(完成/失败/错误)后结束 */
  startTurn(
    input: string,
    signal?: AbortSignal
  ): Promise<{ stream: AsyncGenerator<RunFrame, void, unknown> }>
  dispose(): Promise<void>
}

export interface AppServerRuntimeOptions {
  binary: string
  env: NodeJS.ProcessEnv
  /** -c 配置覆盖(已拼 key=value 形态) */
  configArgs: string[]
  requestTimeoutMs?: number
  /** 测试注入:自定义 client 工厂(默认 startAppServerClient) */
  clientFactory?: (opts: {
    binary: string
    env: NodeJS.ProcessEnv
    configArgs: string[]
    requestTimeoutMs?: number
    onNotification: (n: { method: string; params: Record<string, unknown> }) => void
  }) => Promise<AppServerClient>
}

export async function createAppServerRuntime(
  opts: AppServerRuntimeOptions
): Promise<AppServerRuntime> {
  const { binary, env, configArgs, requestTimeoutMs, clientFactory } = opts

  let threadId: string | null = null
  /** 当前在途 turnId(中断用;单驱动:一个 runtime 同时只跑一个 turn) */
  let activeTurnId: string | null = null
  let disposed = false

  /** 通知派发队列 + 拉取等待者(AsyncGenerator 拉取模型) */
  let queue: RunFrame[] = []
  const waiters: Array<() => void> = []
  const wake = (): void => {
    for (const w of waiters.splice(0)) w()
  }

  const translator: AppServerTranslator = createAppServerTranslator()
  const handleNotification = (n: { method: string; params: Record<string, unknown> }): void => {
    const { events, deltas } = translator.feed(n)
    if (events.length === 0 && deltas.length === 0) return
    if (events.length === 0) {
      queue.push({ event: null, deltas })
      wake()
      return
    }
    // 事件与 delta 分帧下发(delta 先行,事件随后——正文增量优先可见)
    if (deltas.length > 0) {
      queue.push({ event: null, deltas })
    }
    for (const event of events) {
      queue.push({ event, deltas: [] })
    }
    wake()
  }
  const client: AppServerClient = clientFactory
    ? await clientFactory({
        binary,
        env,
        configArgs,
        requestTimeoutMs,
        onNotification: handleNotification
      })
    : startAppServerClient({
        binary,
        env,
        configArgs,
        requestTimeoutMs,
        onNotification: handleNotification
      })

  // initialize 幂等缓存(spike 坑位:不先发 initialize 后续请求被静默丢弃)
  let initPromise: Promise<unknown> | null = null
  const ensureInit = (): Promise<unknown> => {
    if (!initPromise) {
      initPromise = client.request('initialize', {
        clientInfo: { name: 'artify-workbench', title: 'workbench', version: '1.0' }
      })
    }
    return initPromise
  }

  const interruptActive = async (): Promise<void> => {
    if (!threadId || !activeTurnId) return
    const tid = activeTurnId
    try {
      await client.request('turn/interrupt', { threadId, turnId: tid })
    } catch (err) {
      logger.warn('[app-server] turn/interrupt 失败(忽略)', err)
    }
  }

  const runtime: AppServerRuntime = {
    async startTurn(input, signal) {
      if (disposed) throw new Error('app-server runtime 已销毁')
      await ensureInit()

      // thread 复用:首 turn 建 thread,后续直接 turn/start
      if (threadId === null) {
        const res = (await client.request('thread/start', { params: {} })) as {
          thread?: { id?: string }
        }
        threadId = res?.thread?.id ?? null
        if (!threadId) throw new Error('app-server thread/start 未返回 thread.id')
      }

      // spike 坑位:turn/start params 平铺,input 元素 text_elements 必填
      const turnRes = (await client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: input, text_elements: [] }]
      })) as { turn?: { id?: string } }
      const turnId = turnRes?.turn?.id
      if (!turnId) throw new Error('app-server turn/start 未返回 turn.id')
      activeTurnId = turnId

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            void interruptActive()
            wake() // 唤醒拉取循环,让 generator 经 aborted 检查尽快退出
          },
          { once: true }
        )
      }

      const stream = (async function* (): AsyncGenerator<RunFrame, void, unknown> {
        try {
          while (true) {
            while (queue.length === 0) {
              if (signal?.aborted || client.isDead()) return
              await new Promise<void>((r) => waiters.push(r))
            }
            const frame = queue.shift()!
            if (frame.event || frame.deltas.length > 0) yield frame
            const t = frame.event?.type
            if (t === 'turn.completed' || t === 'turn.failed' || t === 'error') return
          }
        } finally {
          if (activeTurnId === turnId) activeTurnId = null
          // 清残帧:中断路径残留的通知不泄漏到下一轮(新 turn 队列干净开始)
          queue = []
        }
      })()
      return { stream }
    },

    async dispose() {
      if (disposed) return
      disposed = true
      wake()
      await client.dispose()
    }
  }

  return runtime
}
