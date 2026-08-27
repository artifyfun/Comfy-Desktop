/**
 * 批量任务队列引擎（main 进程）。
 *
 * v2：从"单任务单例"升级为"串行任务队列"：
 *  - jobs[] 有序队列，同一时刻只执行一个任务（concurrency=1）
 *  - pump() 调度循环：取队头 queued → 执行 → 自动取下一个
 *  - 每个任务执行前做工作流切换清理（freeIfWorkflowChanged）：与上次执行的工作流
 *    不同（含首次/C 界面残留）时先 /free 清显存，防模型叠加 OOM；同工作流跳过
 *  - 队列级完成动作：autoShutdown 仅在整个队列空闲时触发（修复多任务时提前关机）
 *  - 落盘持久化：userData/batch-queue.json（防抖写入，启动恢复）
 *  - stop 支持 stopAll：中断当前任务 + 全部排队任务标记 stopped
 *
 * prompt 组装语义与批量页 getPrompt() 保持一致（同 v1，未变更）：
 *   1. 每个 prompt 深拷贝后随机化 seed（数值型 *seed* 字段）
 *   2. 按 inputsMapping 逐节点合并：valueMap（数据列映射 + 类型转换）
 *      优先，其次 manualValue（手动固定值）
 *
 * 执行链复用 mcp/executor 的 queuePrompt/getHistory 轮询，interrupt 复用其
 * stopExecution，工作流切换清理复用 freeIfWorkflowChanged（POST /free）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import electron from 'electron'
import type { ComfyPrompt } from '../appStore'
import {
  queuePrompt,
  getHistory,
  stopExecution,
  freeIfWorkflowChanged,
  forceFreeAndTrack,
  resolveWorkflowKey
} from '../mcp/executor'
import { logger } from '../utils/logger'
import artifyUtils from '..'

/** 单条输入映射节点（与批量页 state.inputs 的 item 同构） */
export interface BatchInputNode {
  id: string | number
  key: string
  category?: string
  valueType?: string
  valueMap?: { key: string; name?: string } | null
  manualValue?: unknown
}

export interface BatchStartOptions {
  /** app 模板 prompt（ComfyUI workflow API JSON） */
  prompt: ComfyPrompt
  inputsMapping: BatchInputNode[]
  /** 数据行（每行一个对象，字段名对应 valueMap.key） */
  items: Array<Record<string, unknown>>
  /** 从第几条开始（1-based），默认 1 */
  startFrom?: number
  /** 完成通知 webhook（空 = 不通知），走已有 /api/notify 通道 */
  notifyUrl?: string
  /** 完成后自动关机（走已有 /api/shutdown，30s 延迟）——队列级：整个队列空闲才触发 */
  autoShutdown?: boolean
  /** 展示用元信息 */
  appId?: string
  appName?: string
}

export interface BatchItemResult {
  index: number
  success: boolean
  error?: string
  durationMs: number
}

export type BatchJobStatus = 'queued' | 'running' | 'paused' | 'completed' | 'stopped' | 'failed'

/** 队列级配置（浮层/详情页即时生效）：autoShutdown 武装会话级关机，notifyUrl 应用到活跃任务 */
export interface QueueConfigPayload {
  autoShutdown?: boolean
  notifyUrl?: string
}

/** 队列中的一个任务（含提交参数 + 进度统计 + 日志/结果） */
export interface BatchJob {
  id: string
  status: BatchJobStatus
  prompt: ComfyPrompt
  inputsMapping: BatchInputNode[]
  items: Array<Record<string, unknown>>
  startFrom: number
  notifyUrl?: string
  autoShutdown?: boolean
  appId?: string
  appName?: string
  total: number
  processed: number
  success: number
  failed: number
  percent: number
  currentIndex: number
  currentPreview: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  logs: Array<{ time: string; type: string; message: string }>
  results: BatchItemResult[]
}

/** 兼容旧类型：当前运行任务的投影（status 无 queued） */
export interface BatchStatus {
  id: string
  status: 'running' | 'completed' | 'stopped' | 'failed'
  total: number
  processed: number
  success: number
  failed: number
  percent: number
  currentIndex: number
  currentPreview: string
  startedAt: string
  updatedAt: string
  appId?: string
  appName?: string
  autoShutdown?: boolean
  notifyUrl?: string
  logs: Array<{ time: string; type: string; message: string }>
  results: BatchItemResult[]
}

/**
 * 队列快照（前端展示用）：刻意**不含** prompt / inputsMapping / items——
 * 这三者可能体积巨大（上万条数据行），2s 轮询全量传输会拖垮网络与前端内存。
 */
export interface BatchJobSummary {
  id: string
  status: BatchJobStatus
  appId?: string
  appName?: string
  /** 任务级配置（详情页展示用，均为小字段） */
  autoShutdown?: boolean
  notifyUrl?: string
  total: number
  processed: number
  success: number
  failed: number
  percent: number
  currentIndex: number
  currentPreview: string
  createdAt: string
  startedAt?: string
  finishedAt?: string
  updatedAt: string
  logs: Array<{ time: string; type: string; message: string }>
  results: BatchItemResult[]
}

const MAX_LOGS = 500
const MAX_RESULTS = 2000
/** 允许排队 + 运行中的任务总数上限 */
export const MAX_QUEUED = 20
/** 单条 item 从提交到出现 history entry 的超时上限（ComfyUI 重启丢队列时防死循环） */
const MAX_ITEM_POLL_MS = 10 * 60 * 1000

const jobs: BatchJob[] = []
let pumping = false
/** 当前任务 items 循环是否在执行（stop 时置 false 作为中断信号） */
let executing = false
/**
 * 用户手动暂停标志：pauseBatch 置 true（并置 executing=false 中断），
 * resumeBatch 置 false。executeJob 据此返回 'paused'（区别于 stop 的 'stopped'）。
 * 同一时刻最多一个任务被暂停（串行队列），故用布尔即可。
 */
let manualPaused = false
/**
 * 最近一次被"继续"的暂停任务 id：executeJob 消费它做无条件 free（防御暂停期间
 * 用户在 C 界面加载的模型残留），消费后置 null。
 */
let resumedJobId: string | null = null
/**
 * 队列级配置（/api/batch/config 写入）：autoShutdown 立即武装/解除会话级关机意图；
 * notifyUrl 应用到所有排队/运行任务（任务完成时读最新值）。
 */
const queueConfig: { autoShutdown: boolean; notifyUrl: string } = {
  autoShutdown: false,
  notifyUrl: ''
}
/** 队列空闲后 autoShutdown 是否已触发（新任务入队时重置） */
let autoShutdownHandled = false
let loaded = false
let saveTimer: NodeJS.Timeout | null = null
/** 任务间显存卸载开关（默认开，可 setBatchFreeEnabled 覆盖） */
let freeEnabled = true
/**
 * 队列暂停标志：重启恢复出排队任务时为 true，等待用户手动 resumeQueue()。
 * 正常运行时入队/提交新任务会自动解除（startBatch 视为用户主动操作）。
 */
let queuePaused = false
/**
 * 用户是否手动停止过队列（stop / stopAll / 取消运行中任务）。
 * 为 true 时队列空闲不会触发 autoShutdown（防止"停了一半还关机"）；
 * 新提交任务（startBatch）视为新一轮，重置为 false。
 */
let userStopped = false
/**
 * 队列会话的首个任务标记：队列从空闲状态开始执行第一个任务时为 true，
 * 该任务**无条件**前置 free（防御 C 界面等外部残留模型占显存）；
 * 执行完第一个任务后置 false，后续任务按工作流指纹跳过（forceFreeAndTrack vs freeIfWorkflowChanged）。
 * 队列再次空闲时重置为 true。
 */
let sessionFirstFree = true
/**
 * 本队列会话内是否**实际执行过** autoShutdown 任务（executeJob 消费任务时记录）。
 * 区别于 jobs.some(j.autoShutdown)：后者会命中历史残留任务（已完成/已停止的旧记录），
 * 导致"本次没开自动关机却触发关机"。会话结束时（队列空闲）重置。
 */
let sessionAutoShutdown = false

function nowIso(): string {
  return new Date().toISOString()
}

function pushLog(job: BatchJob, type: string, message: string): void {
  job.logs.unshift({ time: new Date().toLocaleTimeString(), type, message })
  if (job.logs.length > MAX_LOGS) job.logs.splice(MAX_LOGS)
}

function trim(job: BatchJob): void {
  if (job.results.length > MAX_RESULTS) job.results.splice(MAX_RESULTS)
}

/** 类型转换（语义同批量页 convertValueByType） */
export function convertValueByType(value: unknown, targetType?: string): unknown {
  switch (targetType) {
    case 'number': {
      const num = Number(value)
      if (Number.isNaN(num)) throw new Error(`Cannot convert "${String(value)}" to number`)
      return num
    }
    case 'boolean': {
      if (typeof value === 'boolean') return value
      const lower = String(value).toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(lower)) return true
      if (['false', '0', 'no', 'off'].includes(lower)) return false
      throw new Error(`Cannot convert "${String(value)}" to boolean`)
    }
    case 'object':
    case 'array': {
      try {
        return JSON.parse(String(value))
      } catch {
        throw new Error(`Cannot convert "${String(value)}" to ${targetType}`)
      }
    }
    case 'string':
    default:
      return typeof value === 'string' ? value : String(value)
  }
}

/** 15 位随机 seed（首位非 0），与前端 getSeed 一致 */
export function getSeed(n = 15): number {
  let num = ''
  for (let i = 0; i < n; i++) {
    num +=
      i === 0 ? String(Math.floor(Math.random() * 9 + 1)) : String(Math.floor(Math.random() * 10))
  }
  return Number(num)
}

/** 组装单条 prompt（语义同批量页 getPrompt：seed 随机化 → 映射合并） */
export function buildItemPrompt(
  base: BatchStartOptions['prompt'],
  inputs: BatchInputNode[],
  data: Record<string, unknown>
): ComfyPrompt {
  const prompt = structuredClone(base)
  for (const item of Object.values(prompt)) {
    const inputs0 = (item as { inputs?: Record<string, unknown> }).inputs
    if (!inputs0) continue
    for (const k of Object.keys(inputs0)) {
      if (k.toLowerCase().includes('seed') && typeof inputs0[k] === 'number') {
        inputs0[k] = getSeed()
      }
    }
  }
  for (const node of inputs) {
    const target = prompt[node.id] as { inputs?: Record<string, unknown> } | undefined
    if (!target?.inputs || !(node.key in target.inputs)) continue
    let value: unknown = target.inputs[node.key]
    if (node.valueMap?.key) {
      const raw = data[node.valueMap.key]
      if (raw !== undefined) {
        try {
          value = convertValueByType(raw, node.valueType)
        } catch (e) {
          logger.warn('batch type conversion failed, fallback to raw', e)
          value = raw
        }
      }
    } else if (node.manualValue !== undefined) {
      value = node.manualValue
    }
    target.inputs[node.key] = value
  }
  return prompt
}

/** 提交单条并轮询至完成（1s 间隔；404/无 entry = 排队/运行中；超时判失败防死循环） */
async function runItem(
  comfyOrigin: string,
  prompt: ComfyPrompt
): Promise<{ ok: boolean; error?: string }> {
  const clientId = randomUUID()
  let promptId: string
  try {
    promptId = await queuePrompt(comfyOrigin, prompt, clientId)
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
  const pollStart = Date.now()
  for (;;) {
    // 暂停与停止都通过 executing=false 中断；错误文案区分，便于用户理解
    if (manualPaused || !executing) {
      return { ok: false, error: manualPaused ? 'paused' : 'stopped' }
    }
    if (Date.now() - pollStart > MAX_ITEM_POLL_MS) {
      return { ok: false, error: `timeout: no history entry within ${MAX_ITEM_POLL_MS / 60000}min` }
    }
    await new Promise((r) => setTimeout(r, 1000))
    let entry: Record<string, unknown> | null
    try {
      entry = await getHistory(comfyOrigin, promptId)
    } catch (e) {
      return { ok: false, error: `history poll: ${(e as Error).message}` }
    }
    if (!entry) continue
    const status = entry.status as { status_str?: string } | undefined
    if (status?.status_str === 'error') {
      return { ok: false, error: JSON.stringify(status).slice(0, 500) }
    }
    return { ok: true }
  }
}

/** 执行单个任务的全部 items；返回终态（stopped=用户中断，paused=用户暂停可继续） */
async function executeJob(job: BatchJob): Promise<'completed' | 'stopped' | 'paused' | 'failed'> {
  executing = true
  try {
    const comfyOrigin = artifyUtils.getConfig().comfy_origin

    // 本会话实际执行过 autoShutdown 任务（仅记录"本次真正跑的"，历史残留不计入）
    if (job.autoShutdown) sessionAutoShutdown = true

    // 暂停后恢复标记：立即消费（无论 freeEnabled），供下方显存清理决策
    const isResume = resumedJobId === job.id
    if (isResume) resumedJobId = null

    // 任务前置清理显存：
    //  - 会话首个任务（队列从空闲开始跑的第一次）：无条件 /free，防 C 界面残留模型；
    //  - 暂停后恢复（resumeBatch 置 resumedJobId）：也无条件 /free——用户暂停期间
    //    很可能去 C 界面操作过，指纹感知不到，同工作流判定会跳过清理，模型叠加易 OOM；
    //  - 其余任务：与上次执行的工作流不同才 /free（同工作流跳过，避免无谓重载）。
    // 失败仅记日志不阻断任务。
    if (freeEnabled) {
      const wfKey = resolveWorkflowKey(job.appId, job.prompt)
      const isSessionFirst = sessionFirstFree
      sessionFirstFree = false
      try {
        if (isSessionFirst || isResume) {
          await forceFreeAndTrack(comfyOrigin, wfKey)
        } else {
          await freeIfWorkflowChanged(comfyOrigin, wfKey)
        }
      } catch (e) {
        logger.warn('free before batch job failed', e)
        pushLog(job, 'error', `free models failed: ${(e as Error).message}`)
      }
    }

    // job.processed 为 1-based 最后已完成项；下一项索引 = processed+1。
    // 支持暂停/停止后"继续"：从上次进度接着跑，不重跑已完成项。
    // 注意 processedBase 必须在循环前固定：循环内 job.processed 会增长，
    // 若用其计算 currentIndex 会造成索引复合递增（跳号）。
    const processedBase = job.processed
    const items = job.items.slice(processedBase)
    for (let i = 0; i < items.length; i++) {
      if (manualPaused || !executing) return manualPaused ? 'paused' : 'stopped'
      const data = items[i]
      if (!data) continue
      const currentIndex = processedBase + i + 1
      let preview = String(currentIndex)
      try {
        preview = JSON.stringify(data).slice(0, 100)
      } catch {
        /* keep fallback */
      }
      job.currentIndex = currentIndex
      job.currentPreview = `${currentIndex}: ${preview}`
      const t0 = Date.now()
      let prompt: ComfyPrompt
      try {
        prompt = buildItemPrompt(job.prompt, job.inputsMapping, data)
      } catch (e) {
        // 单条组装失败：记失败继续（不中断任务）
        const message = (e as Error).message
        job.processed = currentIndex
        job.failed++
        job.percent = Math.round((currentIndex / job.total) * 100)
        job.updatedAt = nowIso()
        pushLog(job, 'error', `#${currentIndex} ${message}`)
        job.results.unshift({ index: currentIndex, success: false, error: message, durationMs: 0 })
        trim(job)
        continue
      }
      const res = await runItem(comfyOrigin, prompt)
      const durationMs = Date.now() - t0
      job.processed = currentIndex
      if (res.ok) job.success++
      else job.failed++
      job.percent = Math.round((currentIndex / job.total) * 100)
      job.updatedAt = nowIso()
      pushLog(
        job,
        res.ok ? 'success' : 'error',
        res.ok
          ? `#${currentIndex} ok (${durationMs}ms)`
          : `#${currentIndex} ${res.error ?? 'error'}`
      )
      job.results.unshift({
        index: currentIndex,
        success: res.ok,
        error: res.error,
        durationMs
      })
      trim(job)
    }
    // 最后一项被暂停/停止中断时循环会自然结束：须按 manualPaused 区分 paused/stopped
    return manualPaused ? 'paused' : executing ? 'completed' : 'stopped'
  } catch (e) {
    logger.error('batch job crashed', e)
    pushLog(job, 'error', (e as Error).message)
    return 'failed'
  } finally {
    executing = false
  }
}

/** 队列调度循环：串行消费 queued，队列空闲时触发关机 */
async function pump(): Promise<void> {
  if (pumping) return
  if (queuePaused) return // 重启恢复后等待人工 resume，不自动执行
  pumping = true
  try {
    for (;;) {
      const job = jobs.find((j) => j.status === 'queued')
      if (!job) break
      job.status = 'running'
      job.startedAt = nowIso()
      job.updatedAt = nowIso()
      pushLog(job, 'info', 'batch started')
      saveQueueSoon()
      const outcome = await executeJob(job)
      job.updatedAt = nowIso()
      job.currentPreview = ''
      // 暂停：任务保持进度，不取下一个任务；等用户手动"继续"后重新入队
      if (outcome === 'paused') {
        job.status = 'paused'
        job.finishedAt = undefined
        pushLog(job, 'info', 'batch paused by user')
        // 暂停态立即落盘（防崩溃丢失"暂停中"状态，被误恢复为 running）
        flushQueue()
        break
      }
      job.finishedAt = nowIso()
      if (outcome === 'completed') {
        job.status = 'completed'
        pushLog(
          job,
          'success',
          `done: total=${job.total} success=${job.success} failed=${job.failed}`
        )
        void notifyJob(job)
      } else if (outcome === 'stopped') {
        job.status = 'stopped'
        pushLog(job, 'info', 'batch stopped by user')
      } else {
        job.status = 'failed'
        pushLog(job, 'error', 'batch failed')
      }
      // 终态立即同步落盘：进度变化走防抖即可，但"完成/失败"必须即时保存，
      // 否则任务刚完成就关机/崩溃时，重启恢复会把它误判为 running → failed。
      flushQueue()
    }
    if (!jobs.some((j) => ['queued', 'running', 'paused'].includes(j.status))) {
      // 队列空闲：下一轮会话的首个任务重新无条件 free（期间用户可能去过 C 界面）
      sessionFirstFree = true
      await finishActionsWhenIdle()
      // 会话结束，清空本会话的自动关机标记（本次是否触发已由上面决定）
      sessionAutoShutdown = false
    }
  } finally {
    pumping = false
  }
}

/** 单任务完成通知（每个任务各自触发，URL 取自该任务） */
async function notifyJob(job: BatchJob): Promise<void> {
  if (!job.notifyUrl || !/^https:\/\//.test(job.notifyUrl)) return
  const serverOrigin = `http://localhost:${artifyUtils.getServerPort() ?? ''}`
  try {
    await fetch(`${serverOrigin}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: job.notifyUrl,
        title: job.appName ? `批量任务完成：${job.appName}` : '批量任务完成',
        body: `total=${job.total} success=${job.success} failed=${job.failed}`
      })
    })
  } catch (e) {
    logger.error('batch notify failed', e)
  }
}

/** 队列级 autoShutdown：仅队列自然跑完时触发；本会话执行过 autoShutdown 任务才算数，用户手动停止过则不触发 */
async function finishActionsWhenIdle(): Promise<void> {
  if (autoShutdownHandled) return
  autoShutdownHandled = true
  if (userStopped) return // 用户手动停止过队列 → 不再自动关机
  if (!sessionAutoShutdown) return // 本会话没执行过 autoShutdown 任务（含历史残留）→ 不关机
  const serverOrigin = `http://localhost:${artifyUtils.getServerPort() ?? ''}`
  try {
    await fetch(`${serverOrigin}/api/shutdown`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ delay: 30, force: true })
    })
  } catch (e) {
    logger.error('batch shutdown failed', e)
  }
}

// ---------- 持久化 ----------

/** 队列文件路径（环境变量可覆盖，便于测试） */
export function getBatchQueueFile(): string {
  if (process.env.BATCH_QUEUE_FILE) return process.env.BATCH_QUEUE_FILE
  const userData =
    typeof electron?.app?.getPath === 'function' ? electron.app.getPath('userData') : ''
  return path.join(userData || os.tmpdir(), 'batch-queue.json')
}

/** 防抖落盘（状态变化频繁，2s 合并一次 IO；异步写避免阻塞主进程事件循环） */
function saveQueueSoon(): void {
  if (saveTimer) clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    saveTimer = null
    void flushQueueAsync()
  }, 2000)
}

async function flushQueueAsync(): Promise<void> {
  const file = getBatchQueueFile()
  try {
    await fs.promises.mkdir(path.dirname(file), { recursive: true })
    await fs.promises.writeFile(file, JSON.stringify(jobs), 'utf-8')
  } catch (e) {
    logger.error('save batch queue failed', e)
  }
}

/** 立即同步落盘（应用退出前可调用，保证退出瞬间状态不丢） */
export function flushQueue(): void {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const file = getBatchQueueFile()
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(jobs), 'utf-8')
  } catch (e) {
    logger.error('save batch queue failed', e)
  }
}

/**
 * 启动恢复：queued 保留但**暂停**（等用户手动 resume，不自动执行）；
 * running 标 failed（无法跨重启续跑）；已完成/停止/失败原样保留。幂等（仅首次生效）。
 */
export function loadQueue(): void {
  if (loaded) return
  loaded = true
  const file = getBatchQueueFile()
  try {
    if (!fs.existsSync(file)) return
    const raw = fs.readFileSync(file, 'utf-8')
    const data = JSON.parse(raw) as BatchJob[]
    if (!Array.isArray(data)) return
    jobs.length = 0
    for (const j of data) {
      if (!j || typeof j.id !== 'string' || !Array.isArray(j.items)) continue
      j.logs = Array.isArray(j.logs) ? j.logs : []
      j.results = Array.isArray(j.results) ? j.results : []
      if (j.status === 'running') {
        j.status = 'failed'
        j.logs.unshift({
          time: new Date().toLocaleTimeString(),
          type: 'error',
          message: `应用重启导致中断（实际可能已部分完成，进度 ${j.processed}/${j.total}）`
        })
      }
      jobs.push(j)
    }
    logger.info(`batch queue restored: ${jobs.length} jobs`)
    if (jobs.some((j) => j.status === 'queued')) {
      queuePaused = true
      logger.info('batch queue has queued jobs; paused until manual resume')
    }
    // 注意：不自动 pump —— 排队任务需用户点击"继续执行"后恢复
  } catch (e) {
    logger.error('load batch queue failed', e)
  }
}

// ---------- 对外 API ----------

/** 当前运行任务投影（兼容旧 /api/batch/status） */
export function getBatchStatus(): BatchStatus | null {
  const job = jobs.find((j) => j.status === 'running')
  if (!job) return null
  return {
    id: job.id,
    status: 'running',
    total: job.total,
    processed: job.processed,
    success: job.success,
    failed: job.failed,
    percent: job.percent,
    currentIndex: job.currentIndex,
    currentPreview: job.currentPreview,
    startedAt: job.startedAt ?? job.createdAt,
    updatedAt: job.updatedAt,
    appId: job.appId,
    appName: job.appName,
    autoShutdown: job.autoShutdown,
    notifyUrl: job.notifyUrl,
    logs: [...job.logs],
    results: [...job.results]
  }
}

/** 全量队列快照（前端队列视图数据源；裁剪掉 prompt/inputsMapping/items 大字段） */
export function listBatchQueue(): BatchJobSummary[] {
  return jobs.map((j) => ({
    id: j.id,
    status: j.status,
    appId: j.appId,
    appName: j.appName,
    autoShutdown: j.autoShutdown,
    notifyUrl: j.notifyUrl,
    total: j.total,
    processed: j.processed,
    success: j.success,
    failed: j.failed,
    percent: j.percent,
    currentIndex: j.currentIndex,
    currentPreview: j.currentPreview,
    createdAt: j.createdAt,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    updatedAt: j.updatedAt,
    logs: [...j.logs],
    results: [...j.results]
  }))
}

export function isBatchRunning(): boolean {
  return jobs.some((j) => j.status === 'running')
}

/** 任务间显存卸载开关（默认开） */
export function setBatchFreeEnabled(enabled: boolean): void {
  freeEnabled = enabled
}

/** 队列是否处于"重启恢复后等待人工继续"状态 */
export function isQueuePaused(): boolean {
  return queuePaused
}

/**
 * 人工恢复队列：解除暂停并触发调度，排队任务开始依次执行。
 * 未暂停时调用也安全（幂等，仅触发一次 pump）。
 */
export function resumeQueue(): boolean {
  const wasPaused = queuePaused
  queuePaused = false
  manualPaused = false // 恢复队列 = 解除所有暂停语义，排队任务开始依次执行
  if (wasPaused) {
    logger.info('batch queue resumed by user')
    saveQueueSoon()
  }
  void pump()
  return wasPaused
}

/** 提交批量任务：入队 + 触发调度；队列满（>=MAX_QUEUED）抛错 */
export async function startBatch(
  opts: BatchStartOptions
): Promise<{ job: BatchJob; queue: BatchJobSummary[] }> {
  ensureLoaded()
  const activeCount = jobs.filter((j) => ['queued', 'running', 'paused'].includes(j.status)).length
  if (activeCount >= MAX_QUEUED) {
    throw new Error(`batch queue is full (max ${MAX_QUEUED})`)
  }
  if (opts.autoShutdown) autoShutdownHandled = false
  // 用户主动提交新任务 = 明确操作意图：解除重启暂停 + 解除手动暂停（新的一轮）
  manualPaused = false
  resumedJobId = null // 清除上一轮可能残留的恢复标记
  if (queuePaused) {
    queuePaused = false
    logger.info('batch queue unpaused by new submission')
  }
  // 新提交视为新的一轮：解除"用户手动停止过"状态，自然跑完可再次触发关机
  userStopped = false
  const startFrom = Math.max(1, opts.startFrom ?? 1)
  const now = nowIso()
  const job: BatchJob = {
    id: randomUUID(),
    status: 'queued',
    prompt: opts.prompt,
    inputsMapping: opts.inputsMapping,
    items: opts.items,
    startFrom,
    notifyUrl: opts.notifyUrl,
    autoShutdown: opts.autoShutdown,
    appId: opts.appId,
    appName: opts.appName,
    total: opts.items.length,
    processed: startFrom - 1,
    success: 0,
    failed: 0,
    percent: 0,
    currentIndex: startFrom - 1,
    currentPreview: '',
    createdAt: now,
    updatedAt: now,
    logs: [],
    results: []
  }
  jobs.push(job)
  saveQueueSoon()
  void pump()
  return { job, queue: listBatchQueue() }
}

/**
 * 重新运行已结束的批量任务（一键重跑，无需重新编排队列）：
 *  - 仅允许终态任务（completed/stopped/failed）重跑；queued/running/paused 拒绝（未结束）
 *  - 完整复刻原任务配置：prompt / inputsMapping / items / startFrom / autoShutdown / notifyUrl / appId / appName
 *  - prompt/items 共享引用（buildItemPrompt 内部 structuredClone 保护原对象，只读安全）
 *  - 视为用户主动的新一轮：解除重启暂停/手动暂停，重置 userStopped，队列满抛错
 *  - 返回 null = 不存在或不可重跑；队列满抛 Error('batch queue is full')
 */
export async function rerunBatchJob(
  id: string
): Promise<{ job: BatchJob; queue: BatchJobSummary[] } | null> {
  ensureLoaded()
  const src = jobs.find((j) => j.id === id)
  if (!src) return null
  if (!['completed', 'stopped', 'failed'].includes(src.status)) return null

  const activeCount = jobs.filter((j) => ['queued', 'running', 'paused'].includes(j.status)).length
  if (activeCount >= MAX_QUEUED) {
    throw new Error(`batch queue is full (max ${MAX_QUEUED})`)
  }
  if (src.autoShutdown) autoShutdownHandled = false
  // 用户主动重跑 = 明确操作意图：解除暂停语义，视为新的一轮
  manualPaused = false
  resumedJobId = null
  queuePaused = false
  userStopped = false

  const startFrom = Math.max(1, src.startFrom ?? 1)
  const now = nowIso()
  const job: BatchJob = {
    id: randomUUID(),
    status: 'queued',
    prompt: src.prompt,
    inputsMapping: src.inputsMapping,
    items: src.items,
    startFrom,
    notifyUrl: src.notifyUrl,
    autoShutdown: src.autoShutdown,
    appId: src.appId,
    appName: src.appName,
    total: src.items.length,
    processed: startFrom - 1,
    success: 0,
    failed: 0,
    percent: 0,
    currentIndex: startFrom - 1,
    currentPreview: '',
    createdAt: now,
    updatedAt: now,
    logs: [],
    results: []
  }
  jobs.push(job)
  saveQueueSoon()
  void pump()
  return { job, queue: listBatchQueue() }
}

/**
 * 停止：默认只停当前运行任务（interrupt + 由调度置 stopped），排队任务继续；
 * stopAll 时全部 queued 任务批量标 stopped。任何用户停止动作都会抑制 autoShutdown。
 */
export async function stopBatch(opts?: { stopAll?: boolean }): Promise<BatchStatus | null> {
  userStopped = true
  manualPaused = false // 停止优先于暂停：中断后按 stopped 处理，而不是 paused
  const active = jobs.find((j) => j.status === 'running')
  if (active) {
    executing = false
    try {
      await stopExecution(artifyUtils.getConfig().comfy_origin)
    } catch (e) {
      logger.error('batch interrupt failed', e)
    }
    // 任务状态由 pump 的 executeJob 返回 stopped 后统一设置
  }
  if (opts?.stopAll) {
    for (const j of jobs) {
      // 暂停任务也属于"全部"：一并停止（保留在队列中便于查看记录）
      if (j.status === 'queued' || j.status === 'paused') {
        j.status = 'stopped'
        j.finishedAt = nowIso()
        j.updatedAt = nowIso()
        pushLog(j, 'info', 'cancelled by stopAll')
      }
    }
    saveQueueSoon()
  }
  return getBatchStatus()
}

/** 取消：排队任务移出队列；运行任务等价 stop；暂停任务移出队列。幂等，不存在返回 false */
export async function cancelBatchJob(id: string): Promise<boolean> {
  const idx = jobs.findIndex((j) => j.id === id)
  if (idx === -1) return false
  const j = jobs[idx]
  if (!j) return false
  if (j.status === 'queued' || j.status === 'paused') {
    if (j.status === 'paused') manualPaused = false
    jobs.splice(idx, 1)
    // 最后一个排队任务被取消后，若队列已空则同步解除暂停态（避免横幅残留）
    if (queuePaused && !jobs.some((x) => x.status === 'queued')) queuePaused = false
    pushLog(j, 'info', 'cancelled by user')
    saveQueueSoon()
    return true
  }
  if (j.status === 'running') {
    await stopBatch()
    return true
  }
  return false
}

/** 清空已结束任务（queued/running/paused 保留），返回移除数量 */
export function clearBatchQueue(): number {
  const removed = jobs.filter(
    (j) => j.status !== 'queued' && j.status !== 'running' && j.status !== 'paused'
  ).length
  if (removed > 0) {
    jobs.splice(
      0,
      jobs.length,
      ...jobs.filter(
        (j) => j.status === 'queued' || j.status === 'running' || j.status === 'paused'
      )
    )
    saveQueueSoon()
  }
  return removed
}

/**
 * 按 id 删除任意任务（含终态记录）：排队/暂停/已完成/失败/停止均可移除；
 * 运行中任务请先停止/暂停（避免 pump 对已脱离队列的 job 写状态造成竞态）。
 * 不存在返回 false。
 */
export function deleteBatchJob(id: string): boolean {
  const idx = jobs.findIndex((j) => j.id === id)
  if (idx === -1) return false
  const j = jobs[idx]
  if (!j) return false
  if (j.status === 'running') return false
  if (j.status === 'paused') manualPaused = false
  jobs.splice(idx, 1)
  if (queuePaused && !jobs.some((x) => x.status === 'queued')) queuePaused = false
  saveQueueSoon()
  return true
}

/**
 * 调整排队任务顺序：toTop=true 移到 queued 区最前，false 移到 queued 区末尾。
 * 仅对 queued 任务生效；不存在返回 false。
 */
export function moveBatchJob(id: string, toTop = true): boolean {
  const idx = jobs.findIndex((j) => j.id === id && j.status === 'queued')
  if (idx === -1) return false
  const [j] = jobs.splice(idx, 1)
  if (!j) return false
  const firstQueued = jobs.findIndex((x) => x.status === 'queued')
  if (firstQueued === -1) {
    jobs.push(j)
  } else if (toTop) {
    jobs.splice(firstQueued, 0, j)
  } else {
    let last = firstQueued
    for (let i = firstQueued + 1; i < jobs.length; i++) {
      if (jobs[i]?.status === 'queued') last = i
    }
    jobs.splice(last + 1, 0, j)
  }
  saveQueueSoon()
  return true
}

function ensureLoaded(): void {
  if (!loaded) loadQueue()
}

/**
 * 暂停当前运行任务（或指定 id 的运行任务）：
 * 中断 ComfyUI + 置 executing=false 让 executeJob 返回 'paused'，
 * 任务保持进度与队列位置，可 resumeBatch 继续。非停止（不抑制 autoShutdown）。
 * 无运行任务返回 null。
 */
export async function pauseBatch(id?: string): Promise<BatchJob | null> {
  const job = id
    ? jobs.find((j) => j.id === id && j.status === 'running')
    : jobs.find((j) => j.status === 'running')
  if (!job) return null
  manualPaused = true
  executing = false
  try {
    await stopExecution(artifyUtils.getConfig().comfy_origin)
  } catch (e) {
    logger.error('batch pause interrupt failed', e)
  }
  pushLog(job, 'info', 'pausing…')
  saveQueueSoon()
  return job
}

/**
 * 继续执行已暂停任务：恢复 queued 状态并触发调度，从上次进度接着跑。
 * 不存在（未暂停/已被删除）返回 false。
 */
export function resumeBatch(id: string): boolean {
  const job = jobs.find((j) => j.id === id && j.status === 'paused')
  if (!job) return false
  manualPaused = false
  // 用户点"继续" = 明确的人工操作：同时解除重启恢复后的队列暂停态，
  // 否则 queuePaused=true 时 pump 直接 return，任务会卡在 queued 不执行
  queuePaused = false
  job.status = 'queued'
  job.finishedAt = undefined
  job.updatedAt = nowIso()
  // 标记恢复：executeJob 对恢复任务做无条件 free（防御暂停期间 C 界面残留模型）
  resumedJobId = job.id
  pushLog(job, 'info', 'resumed by user')
  saveQueueSoon()
  void pump()
  return true
}

/**
 * 队列级配置（浮层/详情页即时生效）：
 *  - autoShutdown：立即武装/解除会话级关机意图（sessionAutoShutdown），
 *    并同步到所有排队/运行/暂停任务（暂停任务恢复执行时读最新值，避免旧配置残留）
 *  - autoShutdownHandled 同步：开启 = 允许本轮再触发一次关机；关闭 = 禁止触发
 *    （否则本会话已触发过一次关机后，仅通过配置开启不会再触发）
 *  - notifyUrl：同步到所有排队/运行/暂停任务（完成通知读取最新值），空串 = 关闭
 */
export function setQueueConfig(cfg: QueueConfigPayload): void {
  if (typeof cfg.autoShutdown === 'boolean') {
    queueConfig.autoShutdown = cfg.autoShutdown
    sessionAutoShutdown = cfg.autoShutdown
    autoShutdownHandled = !cfg.autoShutdown
  }
  if (typeof cfg.notifyUrl === 'string') {
    queueConfig.notifyUrl = cfg.notifyUrl.trim()
  }
  for (const j of jobs) {
    if (j.status === 'queued' || j.status === 'running' || j.status === 'paused') {
      if (typeof cfg.autoShutdown === 'boolean') j.autoShutdown = cfg.autoShutdown
      if (typeof cfg.notifyUrl === 'string') {
        j.notifyUrl = queueConfig.notifyUrl || undefined
      }
    }
  }
  saveQueueSoon()
}

export function getQueueConfig(): { autoShutdown: boolean; notifyUrl: string } {
  return { ...queueConfig }
}

// 进程退出前同步落盘一次：防抖只防 2s 内合并 IO，退出瞬间的最近状态靠这里兜底。
// exit 事件只允许同步操作（flushQueue 为同步写盘，失败不影响退出）。
process.on('exit', () => {
  try {
    flushQueue()
  } catch {
    /* 退出路径尽力而为 */
  }
})
