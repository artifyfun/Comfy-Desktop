/**
 * ComfyUI HTTP 客户端（单一事实源）。
 *
 * 架构审查候选 ④：此前「向 ComfyUI 发带超时 HTTP」有四份实现——
 * executor.fetchTimeout(60s) / plan.fetchTimeout(15s, 同名不同参) /
 * utils/fetch.fetchWithTimeout / 若干文件裸 fetch（超时值 1.2s~12s 不等）。
 * 本模块把这些收敛为领域动词接口：调用方不再关心超时、错误形状、
 * comfyHost 解析。seed 语义（executor.applySeed / batchRunner 自实现 /
 * 前端 getSeed 三处分立）一并收口为 randomizeSeedFields。
 *
 * 接口约定：
 * - 每个动词一个默认超时（对齐各自历史值，行为零变化）；
 * - 注入 deps = { fetch, origin }：测试用假 fetcher，无网络；
 * - 非 2xx 响应统一 throw Error（消息含状态码与 body 摘要）；
 * - 返回已解析 JSON；不抛的业务态（如 history 缺失）返回 null。
 */
import { logger } from './utils/logger'

export interface ComfyClientDeps {
  /** 可注入的 fetch（测试 seam）；缺省用全局 fetch */
  fetch?: typeof fetch
  /** 覆盖 ComfyUI origin（测试 / 显式指定）；缺省读 appStore comfyHost */
  origin?: string
}

interface RequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: string | FormData
  timeoutMs?: number
}

/** appStore 运行时句柄（懒绑定缓存） */
let appStoreHandle: { getConfig(): { comfyHost?: string } } | null = null

export function resolveComfyOrigin(override?: string): string {
  if (override) return override
  // 懒绑定：executor/plan/batchRunner 原本不 import appStore 运行时值——
  // 静态 import 会把 appStore→electron 拉进它们的加载链，测试无 electron
  // 环境下模块加载即炸。server.ts 装配时 bindAppStore 注入；缺省路径只在
  // 主进程运行时走到。
  const handle =
    appStoreHandle ??
    (globalThis as { __comfyClientAppStore?: { getConfig(): { comfyHost?: string } } })
      .__comfyClientAppStore
  if (!handle) throw new Error('ComfyUI origin 未注入（server.ts 装配时应 bindAppStore）')
  const host = handle.getConfig().comfyHost
  if (!host) throw new Error('ComfyUI 未配置（comfyHost 为空）')
  return host.replace(/\/$/, '')
}

/** 主进程装配时注入 appStore（server.ts import appStore 后调用一次）。
 * 同时挂到 globalThis：electron 主 bundle 的 CJS 实例可能与 ESM 转译实例
 * 不同模块注册表，globalThis 保证两边共享同一句柄。 */
export function bindAppStore(handle: { getConfig(): { comfyHost?: string } }): void {
  appStoreHandle = handle
  ;(globalThis as Record<string, unknown>).__comfyClientAppStore = handle
}

/** 带超时的请求（原 executor.fetchTimeout / plan.fetchTimeout 的合并实现） */
export async function comfyFetch(
  path: string,
  options: RequestOptions = {},
  deps: ComfyClientDeps = {}
): Promise<Response> {
  const doFetch = deps.fetch ?? fetch
  const origin = resolveComfyOrigin(deps.origin)
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), options.timeoutMs ?? 60_000)
  try {
    return await doFetch(`${origin}${path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body,
      signal: ctrl.signal
    })
  } finally {
    clearTimeout(timer)
  }
}

async function comfyJson<T>(
  path: string,
  options: RequestOptions,
  deps: ComfyClientDeps
): Promise<T> {
  const res = await comfyFetch(path, options, deps)
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`ComfyUI ${path} HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ''}`)
  }
  return (await res.json()) as T
}

/** JSON 文本 → 对象；空串/非法 JSON 一律 null（调用方据此给出更准确的报错） */
function parseJsonOrNull<T>(text: string): T | null {
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
}

/**
 * 取**绝对 URL** 的媒体字节（`data:` / 本机 `http(s)`）——刻意**不加** ComfyUI origin 前缀。
 *
 * 背景（2026-09-16 真机验证抓到的真实缺陷）：executor.uploadMedia 先前用
 * `comfyFetch(dataUrl, {}, { origin: '' })` 取媒体字节，但 comfyFetch 无条件拼
 * `${origin}${path}`，而 resolveComfyOrigin('') 因空值又回落到 comfyHost ——
 * 请求 URL 变成 `http://localhost:8188data:image/jpeg;base64,…`，于是媒体槽一旦
 * 传 `data:`/`http(s)` 就 500（`Failed to parse URL from http://localhost:8188data:…`）。
 * 媒体字节是**外部绝对地址**，本就不该走 comfy 前缀，故单列一个动词。
 */
export async function fetchAbsoluteMedia(
  url: string,
  deps: ComfyClientDeps = {},
  timeoutMs = 120_000
): Promise<Blob> {
  const doFetch = deps.fetch ?? fetch
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await doFetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`fetch media HTTP ${res.status}`)
    return await res.blob()
  } finally {
    clearTimeout(timer)
  }
}

// ───────────────────────── 领域动词 ─────────────────────────

/** GET /object_info（全量节点 schema）。历史超时 10s/15s，统一 15s。 */
export async function getObjectInfo(
  deps: ComfyClientDeps = {},
  timeoutMs = 15_000
): Promise<Record<string, unknown>> {
  return comfyJson('/object_info', { timeoutMs }, deps)
}

/** GET /object_info/{nodeType}（单节点 schema；画布 bad_param 建议用）。 */
export async function getNodeObjectInfo(
  nodeType: string,
  deps: ComfyClientDeps = {},
  timeoutMs = 3_000
): Promise<Record<string, unknown>> {
  return comfyJson(`/object_info/${encodeURIComponent(nodeType)}`, { timeoutMs }, deps)
}

/** GET /system_stats（显存探测）。历史超时 8s。 */
export async function getSystemStats(
  deps: ComfyClientDeps = {},
  timeoutMs = 8_000
): Promise<Record<string, unknown>> {
  return comfyJson('/system_stats', { timeoutMs }, deps)
}

/** GET /history/{promptId}。404 / 无 entry → null（仍排队或运行中）；5xx → throw。 */
export async function getHistory(
  promptId: string,
  deps: ComfyClientDeps = {},
  timeoutMs = 60_000
): Promise<Record<string, unknown> | null> {
  const res = await comfyFetch(`/history/${encodeURIComponent(promptId)}`, { timeoutMs }, deps)
  if (res.status === 404) return null
  if (!res.ok) {
    throw new Error(`ComfyUI /history/${promptId} HTTP ${res.status}`)
  }
  const json = (await res.json()) as Record<string, unknown>
  return (json[promptId] as Record<string, unknown>) ?? null
}

/** ComfyUI /prompt 的 node_errors 单节点摘要（该校验失败的节点的输出分支会被丢弃） */
export interface QueueNodeError {
  nodeId: string
  classType: string
  messages: string[]
}

/**
 * /prompt 校验告警按 promptId 暂存，供轮询到终态时消费。
 *
 * 背景（2026-09-16 真机验证抓到的真实缺陷）：ComfyUI 的 /prompt **只要还有
 * 一个**输出节点通过校验就返回 HTTP 200，其余校验失败的节点连其输出分支被
 * **静默丢弃**。旧 queuePrompt 只读 prompt_id，于是这类工作流会以
 * 「status=success + 零产物（或只剩 temp 预览帧）」收尾——既有 Anima 系模板的
 * 4 个 `Save Images Mikey` 就是这么整条静默丢掉的，外层看不到任何线索。
 * 与之同类：KA2 模板因同类原因直接 400/500，旧错误消息截断 200 字后也看不全。
 */
const queueDiagnostics = new Map<string, QueueNodeError[]>()
const MAX_QUEUE_DIAGNOSTICS = 500

/** 读取某次提交的 ComfyUI 校验告警（无则空数组） */
export function getQueueDiagnostics(promptId: string): QueueNodeError[] {
  return queueDiagnostics.get(promptId) ?? []
}

/** 终态消费后清理（与 executor.promptAppMap 同寿命语义，防内存滞留） */
export function clearQueueDiagnostics(promptId: string): void {
  queueDiagnostics.delete(promptId)
}

function describeNodeError(err: unknown): string {
  if (!err || typeof err !== 'object') return String(err)
  const e = err as {
    type?: string
    message?: string
    details?: unknown
    extra_info?: { input_name?: string } | null
  }
  const parts: string[] = []
  if (e.type) parts.push(e.type)
  if (e.extra_info?.input_name) parts.push(`缺少必填输入 ${e.extra_info.input_name}`)
  else if (typeof e.details === 'string' && e.details) parts.push(e.details)
  if (e.message) parts.push(e.message)
  return parts.join(' / ') || '未知校验错误'
}

/** 把 /prompt 的 node_errors 压成可读结构（prompt 用于补 class_type） */
export function summarizeNodeErrors(nodeErrors: unknown, prompt?: unknown): QueueNodeError[] {
  if (!nodeErrors || typeof nodeErrors !== 'object') return []
  const graph = (prompt ?? {}) as Record<string, { class_type?: string } | undefined>
  const out: QueueNodeError[] = []
  for (const [nodeId, info] of Object.entries(
    nodeErrors as Record<string, { errors?: unknown; class_name?: string }>
  )) {
    const errors = Array.isArray(info?.errors) ? info.errors : []
    out.push({
      nodeId,
      // ComfyUI 在 node_errors 里也带 class_name；prompt 图里取不到时用它兜底
      classType: graph[nodeId]?.class_type ?? info?.class_name ?? '未知节点',
      messages: errors.map(describeNodeError)
    })
  }
  return out
}

/** 一行摘要（错误消息与告警文案共用） */
export function formatQueueNodeErrors(list: QueueNodeError[], limit = 6): string {
  const head = list
    .slice(0, limit)
    .map((d) => `${d.nodeId} ${d.classType}（${d.messages.join('；')}）`)
    .join('、')
  return list.length > limit ? `${head} 等 ${list.length} 个节点` : head
}

/** POST /prompt → prompt_id。校验失败的节点记入 getQueueDiagnostics（不阻断提交）。 */
export async function queuePrompt(
  prompt: unknown,
  clientId: string,
  deps: ComfyClientDeps = {}
): Promise<string> {
  const res = await comfyFetch(
    '/prompt',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      timeoutMs: 60_000
    },
    deps
  )
  const raw = await res.text().catch(() => '')
  type PromptResponse = { prompt_id?: string; error?: unknown; node_errors?: unknown }
  const json = parseJsonOrNull<PromptResponse>(raw)

  // 失败响应：把 node_errors 一并说清。旧实现走 comfyJson 并把 body 截到 200 字，
  // 恰好把最有用的「哪个节点缺什么输入」截掉 —— KA2 的 500 就是这样变得不可诊断的。
  if (!res.ok) {
    const diags = summarizeNodeErrors(json?.node_errors, prompt)
    const detail = diags.length ? `；节点校验失败 → ${formatQueueNodeErrors(diags)}` : ''
    const head = json?.error ? JSON.stringify(json.error) : raw.slice(0, 400)
    throw new Error(`ComfyUI /prompt HTTP ${res.status}: ${head}${detail}`)
  }
  if (json?.error) throw new Error(`queuePrompt error: ${JSON.stringify(json.error)}`)
  if (!json?.prompt_id) throw new Error('queuePrompt: response missing prompt_id')

  const diags = summarizeNodeErrors(json.node_errors, prompt)
  if (diags.length) {
    queueDiagnostics.set(json.prompt_id, diags)
    if (queueDiagnostics.size > MAX_QUEUE_DIAGNOSTICS) {
      const oldest = queueDiagnostics.keys().next().value
      if (oldest != null) queueDiagnostics.delete(oldest)
    }
    logger.warn(
      `ComfyUI 丢弃了 ${diags.length} 个校验失败的输出分支（prompt ${json.prompt_id}）：` +
        formatQueueNodeErrors(diags)
    )
  }
  return json.prompt_id
}

/** POST /upload/image → { name(含 subfolder 前缀), subfolder, type }。 */
export async function uploadImage(
  blob: Blob,
  filename: string,
  deps: ComfyClientDeps = {}
): Promise<{ name: string; subfolder: string; type: string }> {
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  const json = await comfyJson<{ name: string; subfolder: string; type: string; error?: unknown }>(
    '/upload/image',
    { method: 'POST', body: form, timeoutMs: 60_000 },
    deps
  )
  if (json.error) throw new Error(`uploadMedia error: ${JSON.stringify(json.error)}`)
  const filepath = json.subfolder ? `${json.subfolder}/${json.name}` : json.name
  return { name: filepath, subfolder: json.subfolder, type: json.type }
}

/** POST /interrupt（中断当前执行）。 */
export async function interrupt(deps: ComfyClientDeps = {}): Promise<void> {
  const res = await comfyFetch('/interrupt', { method: 'POST', timeoutMs: 60_000 }, deps)
  if (!res.ok) throw new Error(`ComfyUI /interrupt HTTP ${res.status}`)
}

/** POST /free（卸载模型 + 释放显存）。 */
export async function freeMemory(deps: ComfyClientDeps = {}): Promise<void> {
  const res = await comfyFetch(
    '/free',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ unload_models: true, free_memory: true }),
      timeoutMs: 60_000
    },
    deps
  )
  if (!res.ok) throw new Error(`ComfyUI /free HTTP ${res.status}`)
}

// ───────────────────────── seed 语义收口 ─────────────────────────

/** 15 位随机整数 seed（首位非 0）。原 executor.getSeed / batchRunner.getSeed 双胞胎合并。 */
export function randomSeed(n = 15): number {
  let num = ''
  for (let i = 0; i < n; i++) {
    num +=
      i === 0 ? String(Math.floor(Math.random() * 9 + 1)) : String(Math.floor(Math.random() * 10))
  }
  return Number(num)
}

/** seed 字段随机化（原 executor.applySeed 的 randomize 分支 + batchRunner.buildItemPrompt 内联版）。 */
export function randomizeSeedFields(prompt: {
  [nodeId: string]: { inputs?: Record<string, unknown> }
}): void {
  for (const node of Object.values(prompt)) {
    const inputs = node?.inputs
    if (!inputs) continue
    for (const k of Object.keys(inputs)) {
      if (k.toLowerCase().includes('seed') && typeof inputs[k] === 'number') {
        inputs[k] = randomSeed()
      }
    }
  }
}
