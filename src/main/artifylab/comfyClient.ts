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

/** POST /prompt → prompt_id。 */
export async function queuePrompt(
  prompt: unknown,
  clientId: string,
  deps: ComfyClientDeps = {}
): Promise<string> {
  const json = await comfyJson<{ prompt_id?: string; error?: unknown }>(
    '/prompt',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ prompt, client_id: clientId }),
      timeoutMs: 60_000
    },
    deps
  )
  if (json.error) throw new Error(`queuePrompt error: ${JSON.stringify(json.error)}`)
  if (!json.prompt_id) throw new Error('queuePrompt: response missing prompt_id')
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
