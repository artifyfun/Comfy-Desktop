/**
 * Claude Code 通道 —— 传输层:spawn `claude -p --output-format stream-json`。
 *
 * 职责(与 acp/transport 同构的「单 turn 驱动」契约):
 *   const runtime = await createClaudeRuntime(opts)
 *   const { stream } = await runtime.startTurn(input, signal)
 *   for await (const frame of stream) { ... }  // frame = { event, deltas: [] }
 *
 * 每轮 startTurn spawn 一个一次性 claude 进程(claude 无常驻 server 模式;
 * 会话连续性由 --resume <sessionId> 承载——首轮取 result.session_id,后续轮
 * 注入 --resume,上下文跨 decide 复用,与 codex thread 复用语义对齐)。
 *
 * argv 形态(OpenDesign defs/claude.ts 实证 + 本机 2.1.260 实测):
 *   -p                      print 模式;无位置 prompt 时从 stdin 读
 *   --input-format stream-json   stdin 保持打开,可流式投喂多轮(预留)
 *   --output-format stream-json  stdout 输出 JSONL
 *   --verbose               stream-json 必需(否则 init 行缺失)
 *   --include-partial-messages(可选)token 级 delta;旧版 CLI 不认识会 exit 1,
 *                            由 capability 探测决定是否注入
 *   --dangerously-skip-permissions 或 --permission-mode(由调用方档位决定)
 *   --model <id>            模型覆盖(可选)
 *
 * prompt 一律走 stdin(规避 Linux E2BIG ~128KB / Windows ENAMETOOLONG ~32KB
 * argv 上限,OpenDesign 实证);text 输入形态 {type:'text',text}。
 *
 * 纯 child_process;spawn 可注入(mock 单测,零 flaky)。
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import { runError, runFinished, runStarted } from '../types'
import type { AGUIEvent } from '../types'
import { createClaudeMapper } from './mapper'
import type { ClaudeMapper, ClaudeStreamLine } from './mapper'
import { logger } from '../../utils/logger'

/** 单 turn 驱动输出帧(与 acp/transport.AcpRunFrame 同构) */
export interface ClaudeRunFrame {
  event: AGUIEvent | null
  deltas: never[]
}

export interface ClaudeRuntime {
  startTurn(
    input: string,
    signal?: AbortSignal
  ): Promise<{ stream: AsyncGenerator<ClaudeRunFrame, void, unknown> }>
  dispose(): Promise<void>
}

export interface ClaudeRuntimeOptions {
  /** claude 二进制(绝对路径或 PATH 可解析名) */
  binary: string
  env: NodeJS.ProcessEnv
  /** AG-UI threadId(= workbench sessionId) */
  threadId: string
  /** AG-UI runId */
  runId: string
  /** 模型覆盖(可缺省,用 CLI 配置默认) */
  model?: string
  /** 权限模式:'default' 弹 CLI 侧审批;桌面内嵌场景用 bypass(工作台自有 approvalGate 面) */
  permissionMode?: 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions'
  /** token 级 delta 探测通过时注入(默认关——不稳定增量,整块已够用) */
  includePartialMessages?: boolean
  /** 测试注入:自定义进程工厂 */
  spawnProcess?: (opts: {
    binary: string
    args: string[]
    env: NodeJS.ProcessEnv
  }) => ChildProcessWithoutNullStreams
}

export async function createClaudeRuntime(opts: ClaudeRuntimeOptions): Promise<ClaudeRuntime> {
  const {
    binary,
    env,
    threadId,
    runId,
    model,
    permissionMode = 'bypassPermissions',
    includePartialMessages = false,
    spawnProcess
  } = opts

  let disposed = false
  /** 跨 turn 复用的 claude session id(首轮 result 行回填) */
  let claudeSessionId: string | null = null

  const runtime: ClaudeRuntime = {
    async startTurn(input, signal) {
      if (disposed) throw new Error('claude runtime 已销毁')

      const args = [
        '-p',
        '--input-format',
        'stream-json',
        '--output-format',
        'stream-json',
        '--verbose',
        '--permission-mode',
        permissionMode
      ]
      if (model) args.push('--model', model)
      if (includePartialMessages) args.push('--include-partial-messages')
      if (claudeSessionId) args.push('--resume', claudeSessionId)

      const child: ChildProcessWithoutNullStreams = spawnProcess
        ? spawnProcess({ binary, args, env })
        : (spawn(binary, args, {
            env,
            stdio: ['pipe', 'pipe', 'pipe']
          }) as ChildProcessWithoutNullStreams)

      const mapper: ClaudeMapper = createClaudeMapper({ threadId, runId })

      /** 通知派发队列 + 拉取等待者(与 acp/transport 同款拉取模型) */
      let queue: ClaudeRunFrame[] = []
      const waiters: Array<() => void> = []
      const wake = (): void => {
        for (const w of waiters.splice(0)) w()
      }
      const pushEvent = (event: AGUIEvent): void => {
        queue.push({ event, deltas: [] })
        wake()
      }
      /** 哨兵空帧:进程已退出且终帧已发,generator 见帧即收流 */
      const pushSentinel = (): void => {
        queue.push({ event: null, deltas: [] })
        wake()
      }

      // 生命周期帧(对齐 ACP/codex 通道)
      pushEvent(runStarted(threadId, runId))

      /** result 行的 session_id → 跨轮 --resume;stop_reason !== success → RUN_ERROR */
      let resultSeen: Promise<void> = Promise.resolve()

      const rl = createInterface({ input: child.stdout })
      rl.on('line', (line) => {
        const s = line.trim()
        if (!s) return
        let parsed: ClaudeStreamLine
        try {
          parsed = JSON.parse(s) as ClaudeStreamLine
        } catch {
          logger.debug('[claude] 非 JSON 行,跳过', s.slice(0, 200))
          return
        }
        if (parsed.type === 'result') {
          const sid = typeof parsed.session_id === 'string' ? parsed.session_id : null
          if (sid) claudeSessionId = sid
          const isError = parsed.is_error === true || parsed.subtype !== 'success'
          if (isError) {
            pushEvent(
              runError(
                `claude turn 异常收口: ${String(parsed.subtype ?? 'unknown')}`,
                String(parsed.subtype ?? 'unknown')
              )
            )
          }
        }
        for (const ev of mapper.feed(parsed)) pushEvent(ev)
      })

      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (d: string) => {
        logger.debug('[claude] stderr', d.slice(0, 500))
      })
      child.on('error', (err) => {
        pushEvent(runError(`claude 进程错误: ${String(err)}`))
        wake()
      })

      // prompt 走 stdin(stream-json 形态);写完即 end(单轮模式)
      try {
        child.stdin.write(
          JSON.stringify({
            type: 'user',
            message: { role: 'user', content: [{ type: 'text', text: input }] }
          }) + '\n'
        )
        child.stdin.end()
      } catch (err) {
        pushEvent(runError(`claude stdin 写入失败: ${String(err)}`))
      }

      if (signal) {
        signal.addEventListener(
          'abort',
          () => {
            try {
              if (!child.killed) child.kill('SIGTERM')
            } catch {
              /* 忽略 */
            }
            wake()
          },
          { once: true }
        )
      }

      /** 进程退出 → 终帧 + 哨兵帧(generator 收流收口;终帧是流结束唯一哨兵) */
      resultSeen = new Promise<void>((resolve) => {
        child.once('exit', (code, procSignal) => {
          if (code !== 0 && !signal?.aborted) {
            pushEvent(runError(`claude 进程退出(code=${code} signal=${procSignal})`))
          }
          // 队列里已有 RUN_ERROR 时不补 RUN_FINISHED(AG-UI 一 run 恰一终帧)
          const errored = queue.some((f) => f.event?.type === 'RUN_ERROR')
          if (!signal?.aborted && !errored) {
            pushEvent(runFinished(threadId, runId))
          }
          pushSentinel()
          resolve()
        })
      })

      const stream = (async function* (): AsyncGenerator<ClaudeRunFrame, void, unknown> {
        try {
          while (true) {
            while (queue.length === 0) {
              if (signal?.aborted) return
              await new Promise<void>((r) => waiters.push(r))
            }
            const frame = queue.shift()!
            if (frame.event) yield frame
            if (frame.event?.type === 'RUN_ERROR') return
            if (frame.event === null) return
          }
        } finally {
          await resultSeen
          // 清残帧:turn 间队列干净开始
          queue = []
          rl.close()
          try {
            if (!child.killed) child.kill('SIGKILL')
          } catch {
            /* 已退出 */
          }
        }
      })()
      return { stream }
    },

    async dispose() {
      disposed = true
    }
  }

  return runtime
}
