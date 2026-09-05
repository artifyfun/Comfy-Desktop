/**
 * 模型知识（wb_query_models 后端）：代理本机 LoRA Manager（willmiao/
 * ComfyUI-Lora-Manager custom_nodes，API 挂在 ComfyUI 进程 /api/lm/*）的
 * civitai 元数据，给决策 agent 提供本机 lora/checkpoint 的触发词、用法提示
 * 与示例提示词——无头绪时的选型与写词参考。
 *
 * 设计原则：
 * - 全部按需查询（渐进披露）：常驻成本只有 MCP 工具 schema，查询结果不进 spec
 * - civitai 示例提示词复用 LoRA Manager settings 的 API key 与镜像 host
 *   （默认 civitai.red，国内可直连），不重复要求用户填 key
 * - LM 未安装/未运行时返回结构化错误文本，不抛异常
 */
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import appStoreManager from '../appStore'
import { logger } from '../utils/logger'

export type ModelKind = 'loras' | 'checkpoints' | 'embeddings'

const KINDS: ModelKind[] = ['loras', 'checkpoints', 'embeddings']

/** LM list 单条（只声明消费到的字段） */
interface LmItem {
  file_name: string
  file_path?: string
  folder?: string
  model_name?: string
  base_model?: string
  notes?: string
  usage_tips?: string
  tags?: string[]
  auto_tags?: string[]
  preview_url?: string
  from_civitai?: boolean
  civitai?: { id?: number; modelId?: number; name?: string; trainedWords?: string[] }
}

interface CivitaiImage {
  meta?: { prompt?: string; resources?: Array<{ modelVersionId?: number; weight?: number }> }
  nsfwLevel?: number
}

/** LoRA Manager settings（civitai_api_key / civitai_host），60s 缓存 */
let lmSettingsCache: { apiKey: string; host: string; at: number } | null = null

function lmSettings(): { apiKey: string; host: string } {
  if (lmSettingsCache && Date.now() - lmSettingsCache.at < 60_000) {
    return { apiKey: lmSettingsCache.apiKey, host: lmSettingsCache.host }
  }
  let apiKey = ''
  let host = 'civitai.com'
  try {
    const base = process.env.LOCALAPPDATA ?? join(process.env.USERPROFILE ?? '', 'AppData', 'Local')
    const file = join(base, 'ComfyUI-Lora-Manager', 'settings.json')
    if (existsSync(file)) {
      const raw = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>
      apiKey = typeof raw.civitai_api_key === 'string' ? raw.civitai_api_key : ''
      host = typeof raw.civitai_host === 'string' && raw.civitai_host ? raw.civitai_host : host
    }
  } catch (e) {
    logger.debug('modelKnowledge: read LM settings failed', e)
  }
  lmSettingsCache = { apiKey, host, at: Date.now() }
  return { apiKey, host }
}

function lmBase(): string {
  const host = appStoreManager.getConfig().comfyHost
  if (!host) throw new Error('ComfyUI 未配置（comfyHost 为空），无法访问 LoRA Manager API')
  return `${host.replace(/\/$/, '')}/api/lm`
}

function normalizeKind(kind?: string): ModelKind {
  if (kind && (KINDS as string[]).includes(kind)) return kind as ModelKind
  return 'loras'
}

async function fetchLmList(kind: ModelKind): Promise<LmItem[]> {
  const out: LmItem[] = []
  for (let page = 1; page <= 5; page++) {
    const res = await fetch(`${lmBase()}/${kind}/list?page=${page}&page_size=200`, {
      signal: AbortSignal.timeout(8000)
    })
    if (!res.ok)
      throw new Error(`LoRA Manager API ${res.status}（确认 ComfyUI 在运行且插件已安装）`)
    const json = (await res.json()) as { items?: LmItem[]; total_items?: number }
    const items = json.items ?? []
    out.push(...items)
    if (out.length >= (json.total_items ?? 0) || items.length === 0) break
  }
  return out
}

function compact(it: LmItem) {
  return {
    file_name: it.file_name,
    model_name: it.model_name ?? it.civitai?.name,
    base_model: it.base_model,
    trigger_words: it.civitai?.trainedWords ?? [],
    tags: [...(it.tags ?? []), ...(it.auto_tags ?? [])].slice(0, 8),
    from_civitai: !!it.from_civitai
  }
}

function matchQuery(it: LmItem, q: string): boolean {
  const hay = [
    it.file_name,
    it.model_name,
    it.civitai?.name,
    ...(it.civitai?.trainedWords ?? []),
    ...(it.tags ?? []),
    ...(it.auto_tags ?? [])
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return q
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => hay.includes(term))
}

/** 搜索本机模型知识清单（按需，返回紧凑条目） */
export async function searchModelKnowledge(
  kindInput?: string,
  query?: string,
  limit = 15
): Promise<{
  kind: ModelKind
  total: number
  matched: number
  items: ReturnType<typeof compact>[]
}> {
  const kind = normalizeKind(kindInput)
  const list = await fetchLmList(kind)
  const filtered = query ? list.filter((it) => matchQuery(it, query)) : list
  return {
    kind,
    total: list.length,
    matched: filtered.length,
    items: filtered.slice(0, limit).map(compact)
  }
}

/** civitai 示例提示词：按 modelVersionId 拉 images meta.prompt（带 lora 权重参考） */
async function fetchExamplePrompts(
  modelVersionId: number,
  limit = 3
): Promise<Array<{ prompt: string; lora_weight?: number }>> {
  const { apiKey, host } = lmSettings()
  const url = `https://${host}/api/v1/images?modelVersionId=${modelVersionId}&limit=${limit * 3}`
  const headers: Record<string, string> = {}
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`civitai API ${res.status}`)
  const json = (await res.json()) as { items?: CivitaiImage[] }
  const out: Array<{ prompt: string; lora_weight?: number }> = []
  const seen = new Set<string>()
  for (const im of json.items ?? []) {
    const prompt = (im.meta?.prompt ?? '').trim()
    if (!prompt || seen.has(prompt)) continue
    seen.add(prompt)
    const res = (im.meta?.resources ?? []).find((r) => r.modelVersionId === modelVersionId)
    out.push({ prompt: prompt.slice(0, 500), lora_weight: res?.weight })
    if (out.length >= limit) break
  }
  return out
}

/** 单模型详情：触发词 + 用法提示 + 备注 + 示例提示词 */
export async function modelKnowledgeDetail(
  file: string,
  kindInput?: string
): Promise<Record<string, unknown>> {
  const kind = normalizeKind(kindInput)
  const list = await fetchLmList(kind)
  const target = file.toLowerCase()
  const it =
    list.find((x) => x.file_name.toLowerCase() === target) ??
    list.find((x) => (x.file_path ?? '').toLowerCase().endsWith(target)) ??
    list.find((x) => x.file_name.toLowerCase().includes(target))
  if (!it) {
    return { ok: false, error: `未在本机 ${kind} 中找到「${file}」，先用 action=search 搜清单` }
  }
  const detail: Record<string, unknown> = {
    ok: true,
    kind,
    file_name: it.file_name,
    file_path: it.file_path,
    folder: it.folder,
    model_name: it.model_name ?? it.civitai?.name,
    base_model: it.base_model,
    trigger_words: it.civitai?.trainedWords ?? [],
    usage_tips: it.usage_tips || undefined,
    notes: it.notes || undefined,
    tags: [...(it.tags ?? []), ...(it.auto_tags ?? [])].slice(0, 12),
    civitai_version_id: it.civitai?.id,
    preview_url: it.preview_url
  }
  if (it.civitai?.id) {
    try {
      detail.example_prompts = await fetchExamplePrompts(it.civitai.id)
    } catch (e) {
      detail.example_prompts_error = e instanceof Error ? e.message : String(e)
    }
  }
  return detail
}

/* ------------------------------------------------------------------ */
/* civitai 在线搜索（wb_query_models action=civitai）                   */
/* ------------------------------------------------------------------ */

export interface CivitaiSearchItem {
  model_id: number
  model_name: string
  type: string
  creator?: string
  base_models: string[]
  downloads?: number
  thumbs_up?: number
  nsfw_level?: number
  version_id: number
  version_name?: string
  trigger_words: string[]
  page_url: string
}

export interface CivitaiSearchResult {
  ok: boolean
  source: string
  query?: string
  total: number
  items: CivitaiSearchItem[]
  error?: string
}

interface CivitaiModelResp {
  id: number
  name?: string
  type?: string
  nsfwLevel?: number
  creator?: { username?: string }
  stats?: { downloadCount?: number; thumbsUpCount?: number }
  modelVersions?: Array<{
    id: number
    name?: string
    baseModel?: string
    trainedWords?: string[]
  }>
}

/** 搜索结果缓存：key=完整查询串，60s TTL，防同轮多 agent 重复打 API */
const civitaiSearchCache = new Map<string, { at: number; data: CivitaiSearchResult }>()
const CIVITAI_CACHE_TTL = 60_000

/** civitai API key（复用 LoRA Manager settings 的 civitai_api_key，60s 缓存同源） */
export function getCivitaiApiKey(): string {
  return lmSettings().apiKey
}

/** civitai 在线搜索：REST /api/v1/models（query+types 官方检索，2026-09 实测可用）。 */
export async function searchCivitaiModels(opts: {
  query: string
  type?: string
  baseModels?: string[]
  sort?: string
  nsfw?: boolean
  limit?: number
  page?: number
}): Promise<CivitaiSearchResult> {
  const { apiKey, host } = lmSettings()
  const params = new URLSearchParams()
  params.set('query', opts.query)
  if (opts.type) params.set('types', opts.type)
  for (const bm of opts.baseModels ?? []) params.append('baseModels', bm)
  if (opts.sort) params.set('sort', opts.sort)
  // nsfw 分级过滤：X=全量（需 API key）；缺省走 API 默认（SFW）
  if (opts.nsfw !== false) params.set('nsfw', 'X')
  params.set('limit', String(Math.max(1, Math.min(opts.limit ?? 10, 20))))
  if (opts.page && opts.page > 1) params.set('page', String(opts.page))
  const url = `https://${host}/api/v1/models?${params.toString()}`

  const cached = civitaiSearchCache.get(url)
  if (cached && Date.now() - cached.at < CIVITAI_CACHE_TTL) return cached.data

  try {
    const headers: Record<string, string> = {}
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(12000) })
    if (!res.ok) throw new Error(`civitai API ${res.status}`)
    const json = (await res.json()) as {
      items?: CivitaiModelResp[]
      metadata?: { totalItems?: number }
    }
    const items: CivitaiSearchItem[] = (json.items ?? []).map((m) => {
      const v = m.modelVersions?.[0]
      return {
        model_id: m.id,
        model_name: m.name ?? '',
        type: m.type ?? '',
        creator: m.creator?.username,
        base_models: v?.baseModel ? [v.baseModel] : [],
        downloads: m.stats?.downloadCount,
        thumbs_up: m.stats?.thumbsUpCount,
        nsfw_level: m.nsfwLevel,
        version_id: v?.id ?? 0,
        version_name: v?.name,
        trigger_words: v?.trainedWords ?? [],
        page_url: `https://${host}/models/${m.id}`
      }
    })
    const data: CivitaiSearchResult = {
      ok: true,
      source: host,
      query: opts.query,
      total: json.metadata?.totalItems ?? items.length,
      items
    }
    if (civitaiSearchCache.size > 40) civitaiSearchCache.clear()
    civitaiSearchCache.set(url, { at: Date.now(), data })
    return data
  } catch (e) {
    return {
      ok: false,
      source: host,
      query: opts.query,
      total: 0,
      items: [],
      error: e instanceof Error ? e.message : String(e)
    }
  }
}
