/**
 * 常驻批量任务执行引擎（main 进程）。
 *
 * 背景：原批量执行在渲染进程 batch/index.vue 的 for 循环里逐条
 * waitForPrompt，离开页面 = 组件卸载 = 任务被杀。本模块把执行循环
 * 下沉到 main 进程，前端只负责提交任务与轮询状态，任何页面（含
 * 关闭 A UI 面板）都不影响执行。
 *
 * prompt 组装语义与批量页 getPrompt() 保持一致：
 *   1. 每个 prompt 深拷贝后随机化 seed（数值型 *seed* 字段）
 *   2. 按 inputsMapping 逐节点合并：valueMap（数据列映射 + 类型转换）
 *      优先，其次 manualValue（手动固定值）
 *
 * 执行链复用 mcp/executor 的 queuePrompt/getHistory 轮询，interrupt
 * 复用其 stopExecution。
 */
import { randomUUID } from 'node:crypto'
import type { ComfyPrompt } from '../appStore'
import { queuePrompt, getHistory, stopExecution } from '../mcp/executor'
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
  /** 完成后自动关机（走已有 /api/shutdown，30s 延迟） */
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
  /** 最近日志（unshift + 上限裁剪，避免内存无限增长） */
  logs: Array<{ time: string; type: string; message: string }>
  results: BatchItemResult[]
}

const MAX_LOGS = 500
const MAX_RESULTS = 2000

let current: BatchStatus | null = null
let running = false

function nowIso(): string {
  return new Date().toISOString()
}

function pushLog(type: string, message: string): void {
  if (!current) return
  current.logs.unshift({ time: new Date().toLocaleTimeString(), type, message })
  if (current.logs.length > MAX_LOGS) current.logs.splice(MAX_LOGS)
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
    num += i === 0 ? String(Math.floor(Math.random() * 9 + 1)) : String(Math.floor(Math.random() * 10))
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

/** 提交单条并轮询至完成（1s 间隔；404/无 entry = 排队/运行中） */
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
  for (;;) {
    if (!running) return { ok: false, error: 'stopped' }
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

export function getBatchStatus(): BatchStatus | null {
  return current ? { ...current, logs: [...current.logs], results: [...current.results] } : null
}

export function isBatchRunning(): boolean {
  return running
}

export async function stopBatch(): Promise<void> {
  if (!running) return
  running = false
  const comfyOrigin = artifyUtils.getConfig().comfy_origin
  try {
    await stopExecution(comfyOrigin)
  } catch (e) {
    logger.error('batch interrupt failed', e)
  }
  if (current) {
    current.status = 'stopped'
    current.updatedAt = nowIso()
    pushLog('info', 'batch stopped by user')
  }
}

/** 启动批量任务（同一时刻只允许一个；进行中再提交抛错） */
export async function startBatch(opts: BatchStartOptions): Promise<BatchStatus> {
  if (running) throw new Error('a batch task is already running')
  const startFrom = Math.max(1, opts.startFrom ?? 1)
  const items = opts.items.slice(startFrom - 1)
  current = {
    id: randomUUID(),
    status: 'running',
    total: opts.items.length,
    processed: startFrom - 1,
    success: 0,
    failed: 0,
    percent: 0,
    currentIndex: startFrom - 1,
    currentPreview: '',
    startedAt: nowIso(),
    updatedAt: nowIso(),
    appId: opts.appId,
    appName: opts.appName,
    logs: [],
    results: []
  }
  running = true
  // 异步执行：立即返回状态快照，前端轮询 /api/batch/status
  void executeLoop(opts, items, startFrom).catch((e) => {
    logger.error('batch loop crashed', e)
    if (current) {
      current.status = 'failed'
      current.updatedAt = nowIso()
      pushLog('error', (e as Error).message)
    }
    running = false
  })
  return getBatchStatus()!
}

async function executeLoop(
  opts: BatchStartOptions,
  items: Array<Record<string, unknown>>,
  startFrom: number
): Promise<void> {
  const comfyOrigin = artifyUtils.getConfig().comfy_origin
  try {
    for (let i = 0; i < items.length; i++) {
      if (!running) break
      const data = items[i]
      if (!data) continue
      const currentIndex = startFrom + i
      let preview = String(currentIndex)
      try {
        preview = JSON.stringify(data).slice(0, 100)
      } catch {
        /* keep fallback */
      }
      if (current) {
        current.currentIndex = currentIndex
        current.currentPreview = `${currentIndex}: ${preview}`
      }
      const t0 = Date.now()
      const prompt = buildItemPrompt(opts.prompt, opts.inputsMapping, data)
      const res = await runItem(comfyOrigin, prompt)
      const durationMs = Date.now() - t0
      if (current) {
        current.processed = currentIndex
        if (res.ok) current.success++
        else current.failed++
        current.percent = Math.round((currentIndex / current.total) * 100)
        current.updatedAt = nowIso()
        pushLog(
          res.ok ? 'success' : 'error',
          res.ok ? `#${currentIndex} ok (${durationMs}ms)` : `#${currentIndex} ${res.error ?? 'error'}`
        )
        current.results.unshift({ index: currentIndex, success: res.ok, error: res.error, durationMs })
        if (current.results.length > MAX_RESULTS) current.results.splice(MAX_RESULTS)
      }
    }
    if (running && current) {
      current.status = 'completed'
      current.currentPreview = ''
      current.updatedAt = nowIso()
      pushLog(
        'success',
        `done: total=${current.total} success=${current.success} failed=${current.failed}`
      )
      await finishActions(opts)
    }
  } finally {
    running = false
    if (current) current.updatedAt = nowIso()
  }
}

/** 完成后动作：通知 + 自动关机（复用本 server 的 HTTP 接口） */
async function finishActions(opts: BatchStartOptions): Promise<void> {
  const serverOrigin = `http://localhost:${artifyUtils.getServerPort() ?? ''}`
  if (opts.notifyUrl && /^https:\/\//.test(opts.notifyUrl)) {
    try {
      await fetch(`${serverOrigin}/api/notify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: opts.notifyUrl,
          title: '批量任务完成',
          body: `total=${current?.total} success=${current?.success} failed=${current?.failed}`
        })
      })
    } catch (e) {
      logger.error('batch notify failed', e)
    }
  }
  if (opts.autoShutdown) {
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
}
