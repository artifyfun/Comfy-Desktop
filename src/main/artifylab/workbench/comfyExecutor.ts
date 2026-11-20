/**
 * comfyExecutor —— ComfyUI 执行语义的单一实现（架构评审 A3）。
 *
 * 历史：batchRunner.runItem 自带「queuePrompt + 1s 轮询 + 产物裸扫」，
 * workbench 走 getExecutionStatus + extractFiles——同一执行语义两份实现，
 * 超时/错误/产物口径各自维护（batchRunner 注释自认「与工作台 extractFiles
 * 同构」）。本 module 收口为 submit / await / extract / interrupt 四个
 * 动作，两条调用链共享同一份语义。
 *
 * 接口形状（依赖注入，测试用 FakeAdapter 驱动）：
 * - submit(prompt)           → promptId
 * - awaitResult(promptId, opts) → { status, outputs, files, error }
 *    轮询 history 至终态；opts 可注入间隔/超时/shouldAbort
 * - extract(outputs, paramsNodes?) → 文件清单（复用 executionLog.extractFiles
 *    的「声明优先、裸扫兜底」语义——batch 裸扫 = paramsNodes 传 undefined）
 * - interrupt()              → 中断当前执行
 *
 * 与旧实现的语义对齐（零行为变化的收口）：
 * - batch 侧：轮询 1s 间隔、超时 MAX_ITEM_POLL_MS、404/无 entry = 进行中、
 *   status_str==='error' = 失败；产物键 images/gifs（裸扫语义，audio/video
 *   由 extractFiles 覆盖为超集——batch 预览只显示图片，超集无害）
 * - workbench 侧：getExecutionStatus 的 success/error 语义在 awaitResult
 *    的返回 status 上保持一致
 */
import { randomUUID } from 'node:crypto'
import { queuePrompt, getHistory, interrupt } from '../comfyClient'
import { extractFiles } from './executionLog'
import type { ParamNode } from '../appStore'
import type { WorkbenchOutputFile } from './sessionTypes'

export type ComfyPrompt = Record<string, unknown>

/** 轮询适配器（生产用默认实现；测试注入 fake） */
export interface ComfyAdapter {
  queuePrompt(prompt: unknown, clientId: string, origin: string): Promise<string>
  /** 404 / 无 entry → null（进行中）；网络错误 → throw */
  getHistory(promptId: string, origin: string): Promise<Record<string, unknown> | null>
  interrupt(origin: string): Promise<void>
  /** 轮询间隔（默认 1000ms，测试可缩短） */
  pollIntervalMs?: number
}

const defaultAdapter: ComfyAdapter = {
  queuePrompt: (prompt, clientId, origin) => queuePrompt(prompt, clientId, { origin }),
  getHistory: (promptId, origin) => getHistory(promptId, { origin }),
  interrupt: (origin) => interrupt({ origin }),
  pollIntervalMs: 1000
}

export type ExecutionOutcome =
  | { status: 'success'; files: WorkbenchOutputFile[]; outputs: Record<string, unknown> }
  | { status: 'error'; error: string }
  | { status: 'aborted'; reason: string }

export interface AwaitOptions {
  /** 总超时 ms（默认 10 分钟，与 batch MAX_ITEM_POLL_MS 对齐由调用方传） */
  timeoutMs?: number
  /** 每轮轮询前调用；返回 true 则中止（paused/stopped 语义） */
  shouldAbort?: () => boolean
  abortReason?: string
}

/** 提交 prompt，返回 promptId（clientId 自动生成） */
export async function submit(
  prompt: ComfyPrompt,
  origin: string,
  adapter: ComfyAdapter = defaultAdapter
): Promise<string> {
  return adapter.queuePrompt(prompt, randomUUID(), origin)
}

/**
 * 轮询 history 至终态。终态判定与两侧旧实现一致：
 * - entry.status.status_str === 'error' → error
 * - entry 出现且非 error → success（outputs 交由调用方/extract 处理）
 * - 超时 / abort → aborted
 */
export async function awaitResult(
  promptId: string,
  origin: string,
  opts: AwaitOptions = {},
  adapter: ComfyAdapter = defaultAdapter
): Promise<ExecutionOutcome> {
  const interval = adapter.pollIntervalMs ?? 1000
  const timeout = opts.timeoutMs ?? 600_000
  const pollStart = Date.now()
  // 首轮也等一个间隔（与 batch 旧行为一致：queue 后 sleep(1000) 再首查）
  for (;;) {
    if (opts.shouldAbort?.()) {
      return { status: 'aborted', reason: opts.abortReason ?? 'aborted' }
    }
    if (Date.now() - pollStart > timeout) {
      return {
        status: 'aborted',
        reason: `timeout: no history entry within ${Math.round(timeout / 60000)}min`
      }
    }
    await new Promise((r) => setTimeout(r, interval))
    let entry: Record<string, unknown> | null
    try {
      entry = await adapter.getHistory(promptId, origin)
    } catch (e) {
      return { status: 'error', error: `history poll: ${(e as Error).message}` }
    }
    if (!entry) continue
    const status = entry.status as { status_str?: string } | undefined
    if (status?.status_str === 'error') {
      return { status: 'error', error: JSON.stringify(status).slice(0, 500) }
    }
    const outputs = (entry.outputs as Record<string, unknown> | undefined) ?? {}
    return { status: 'success', outputs, files: extractFiles(undefined, outputs) }
  }
}

/** 产物提取（声明优先/裸扫兜底的单一语义；batch = paramsNodes undefined） */
export function extract(
  outputs: Record<string, unknown> | null | undefined,
  paramsNodes?: ParamNode[]
): WorkbenchOutputFile[] {
  return extractFiles(paramsNodes, outputs)
}

/** 中断当前执行 */
export function interruptExecution(origin: string, adapter: ComfyAdapter = defaultAdapter) {
  return adapter.interrupt(origin)
}

/** submit + awaitResult 一步到位（batch 单条执行的最小 interface） */
export async function runOnce(
  prompt: ComfyPrompt,
  origin: string,
  opts: AwaitOptions & { adapter?: ComfyAdapter } = {}
): Promise<ExecutionOutcome> {
  const { adapter, ...awaitOpts } = opts
  let promptId: string
  try {
    promptId = await submit(prompt, origin, adapter)
  } catch (e) {
    return { status: 'error', error: (e as Error).message }
  }
  return awaitResult(promptId, origin, awaitOpts, adapter)
}
