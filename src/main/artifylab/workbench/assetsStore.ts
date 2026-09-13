/**
 * 创作资产层（对标建议 #4）——标准对齐：RHTV「角色资产设定表」/ 可灵「元素库」/
 * Firefly「Style Kits」。
 *
 * 资产 = 把「一致性」显式结构化为可引用对象：
 *   { 参考图组 refs + 固定 seed + 参数 params(LoRA 触发词/模板参数覆盖) }
 * 生成时用 `wb_execute_template asset_ids=[...]` 自动挂载到模板素材槽——
 * 一致性从「用户在聊天里贴图」升级为「Agent 自动维护」。
 *
 * 持久化：userData/workbench-assets.json（与 workbench-sessions.json 同目录）。
 * 纯文件存储 + 内存缓存；storePath 以函数注入（对齐 SessionStoreRepo 延迟取
 * app.getPath 的写法，同时让单测可指向临时目录）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { app } from 'electron'
import { logger } from '../utils/logger'

export type AssetKind = 'character' | 'style' | 'prop' | 'other'

/** 合法 kind（UI/工具白名单共用） */
export const ASSET_KINDS: readonly AssetKind[] = ['character', 'style', 'prop', 'other']

/** 单个资产实体（落盘形状） */
export interface CreativeAsset {
  id: string
  /** 人类可读名（模型常用 name 引用，故要求非空且唯一化处理） */
  name: string
  kind: AssetKind
  /** 参考图（已上传文件名或 http(s)/data URL）——按序对应模板素材槽 */
  refs: string[]
  /** 固定种子（复现/跨轮一致；模板有 seed 参数时自动填） */
  seed?: number
  /** 附加参数（LoRA 触发词、模板参数覆盖等；用户显式 params 优先） */
  params: Record<string, unknown>
  notes?: string
  createdAt: string
  updatedAt: string
}

/** 保存入参（id 缺省 = 新建；name 缺省 = 按 id 更新） */
export interface AssetInput {
  id?: string
  name?: string
  kind?: string
  refs?: unknown
  seed?: unknown
  params?: unknown
  notes?: string
}

const MAX_NAME = 80
const MAX_REFS = 12
const MAX_REF_LEN = 2048
const MAX_PARAMS = 40

function nowIso(): string {
  return new Date().toISOString()
}

/** refs 规范化：字符串化、trim、去空、去重、限量 */
export function normalizeRefs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw) {
    if (typeof v !== 'string') continue
    const s = v.trim().slice(0, MAX_REF_LEN)
    if (!s) continue
    if (!out.includes(s)) out.push(s)
    if (out.length >= MAX_REFS) break
  }
  return out
}

/** params 规范化：仅保留标量/数组值（对象值丢弃，防把嵌套结构写进模板参数） */
export function normalizeParams(raw: unknown): Record<string, unknown> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
  const out: Record<string, unknown> = {}
  let n = 0
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (!k || k.length > 64) continue
    if (v === null || v === undefined) continue
    if (typeof v === 'object' && !Array.isArray(v)) continue
    out[k] = v
    if (++n >= MAX_PARAMS) break
  }
  return out
}

function normalizeKind(raw: unknown, fallback: AssetKind = 'character'): AssetKind {
  const s = String(raw ?? '').trim().toLowerCase()
  return (ASSET_KINDS as readonly string[]).includes(s) ? (s as AssetKind) : fallback
}

/**
 * 入参 → 资产（existing 提供时为更新，缺字段沿用旧值）。
 * 校验失败返回 issues 而非抛错（工具层直接把 issues 回给模型改道）。
 */
export function normalizeAssetInput(
  input: AssetInput,
  existing?: CreativeAsset
): { asset: CreativeAsset; issues: string[] } {
  const issues: string[] = []
  const name = String(input.name ?? existing?.name ?? '').trim().slice(0, MAX_NAME)
  if (!name) issues.push('name 不能为空（模型/后续引用按名字或 id 定位资产）')

  const refsRaw = input.refs !== undefined ? input.refs : existing?.refs
  const refs = normalizeRefs(refsRaw)
  if (input.refs !== undefined && refs.length === 0) {
    issues.push('refs 需要至少一个非空字符串（参考图文件名或 http(s)/data URL）')
  }

  let seed: number | undefined = existing?.seed
  if (input.seed !== undefined && input.seed !== null && input.seed !== '') {
    const n = Number(input.seed)
    if (Number.isFinite(n)) seed = Math.trunc(n)
    else issues.push('seed 需要是数字（非数字值已忽略）')
  }

  const params =
    input.params !== undefined ? normalizeParams(input.params) : (existing?.params ?? {})

  const asset: CreativeAsset = {
    id: existing?.id ?? (String(input.id ?? '').trim() || randomUUID()),
    name,
    kind: normalizeKind(input.kind, existing?.kind ?? 'character'),
    refs,
    ...(seed !== undefined ? { seed } : {}),
    params,
    ...(input.notes !== undefined
      ? { notes: String(input.notes).trim().slice(0, 500) }
      : existing?.notes !== undefined
        ? { notes: existing.notes }
        : {}),
    createdAt: existing?.createdAt ?? nowIso(),
    updatedAt: nowIso()
  }
  return { asset, issues }
}

/** 资产存储（文件 + 内存缓存；写入即时落盘） */
export class AssetsStore {
  private cache: CreativeAsset[] | null = null

  constructor(private readonly options: { storePath: () => string }) {}

  private load(): CreativeAsset[] {
    if (this.cache) return this.cache
    const path = this.options.storePath()
    let items: CreativeAsset[] = []
    try {
      if (existsSync(path)) {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown
        if (Array.isArray(parsed)) items = parsed.filter(isAssetLike)
      }
    } catch (e) {
      // 损坏文件不阻断：空库起步（原文件保留待人工检查），避免工作台整体不可用
      logger.warn('assets store: 读取失败，按空库处理', e)
      items = []
    }
    this.cache = items
    return items
  }

  private persist(items: CreativeAsset[]): void {
    const path = this.options.storePath()
    try {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, JSON.stringify(items, null, 2), 'utf8')
      this.cache = items
    } catch (e) {
      logger.warn('assets store: 写入失败', e)
      throw new Error('资产保存失败（磁盘写入异常）', { cause: e })
    }
  }

  list(): CreativeAsset[] {
    return this.load().map(cloneAsset)
  }

  get(id: string): CreativeAsset | undefined {
    const hit = this.load().find((a) => a.id === id)
    return hit ? cloneAsset(hit) : undefined
  }

  /**
   * 引用解析：优先 id 精确匹配，其次 name（大小写不敏感）匹配。
   * 模型手里常只有名字（「小美」「赛博朋克风」），id 是内部产物。
   */
  resolve(key: string): CreativeAsset | undefined {
    const k = String(key ?? '').trim()
    if (!k) return undefined
    const items = this.load()
    const byId = items.find((a) => a.id === k)
    if (byId) return cloneAsset(byId)
    const lower = k.toLowerCase()
    const byName = items.find((a) => a.name.toLowerCase() === lower)
    return byName ? cloneAsset(byName) : undefined
  }

  /** 保存（无 id 或 id 不存在 = 新建；同名资产自动去重名加后缀） */
  save(input: AssetInput): { asset: CreativeAsset; created: boolean; issues: string[] } {
    const items = this.load()
    const existing = input.id ? items.find((a) => a.id === input.id) : undefined
    const { asset, issues } = normalizeAssetInput(input, existing)
    if (existing) {
      const idx = items.findIndex((a) => a.id === existing.id)
      const next = [...items]
      next[idx] = asset
      this.persist(next)
      return { asset: cloneAsset(asset), created: false, issues }
    }
    // 新建：重名 → 追加序号（保证 name 引用可解析）
    let name = asset.name
    if (name && items.some((a) => a.name.toLowerCase() === name.toLowerCase())) {
      let i = 2
      while (items.some((a) => a.name.toLowerCase() === `${name} ${i}`.toLowerCase())) i++
      issues.push(`同名资产已存在，本次以「${name} ${i}」保存`)
      name = `${name} ${i}`
    }
    const created = { ...asset, name }
    this.persist([...items, created])
    return { asset: cloneAsset(created), created: true, issues }
  }

  remove(id: string): boolean {
    const items = this.load()
    const next = items.filter((a) => a.id !== id)
    if (next.length === items.length) return false
    this.persist(next)
    return true
  }

  /** 仅测试可见：丢弃内存缓存（模拟进程重启后从盘重读） */
  invalidateCacheForTest(): void {
    this.cache = null
  }
}

function isAssetLike(v: unknown): v is CreativeAsset {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o.id === 'string' && typeof o.name === 'string'
}

/**
 * 出参克隆：refs 数组与 params 对象必须复制——否则调用方（工具层/挂载层）
 * 的原地改动会污染内存缓存，并在下一次 persist 时被写进磁盘。
 */
function cloneAsset(a: CreativeAsset): CreativeAsset {
  const params: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(a.params)) params[k] = Array.isArray(v) ? [...v] : v
  return { ...a, refs: [...a.refs], params }
}

/** 默认存储位置（对齐 workbench-sessions.json 同目录约定） */
export function assetsPath(): string {
  return join(app.getPath('userData'), 'workbench-assets.json')
}

/** 进程级单例（routes/wbtools 共用；测试请直接 new AssetsStore） */
export const assetsStore = new AssetsStore({ storePath: assetsPath })
