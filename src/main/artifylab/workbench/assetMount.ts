/**
 * 资产 → 模板参数挂载（对标建议 #4 的执行侧，纯函数零依赖）。
 *
 * 职责：把创作资产（参考图组 + seed + 参数）翻译成某模板的一次具体参数集，
 * 使「一致性」不再依赖用户在对话里贴图：
 *   - refs  → 按序填进模板的素材槽（*-uploader 参数），用户已显式填的槽不动
 *   - seed  → 模板存在 seed 类参数且用户未指定时填第一个（跨轮复现）
 *   - params→ 合并进参数（资产之间后者覆盖前者，用户显式参数最高优先级）
 *
 * 槽位类型宽容度对齐 service.allowedMediaKindsForUploader：video 槽可吃图
 * （VHS 等工作流常见），audio 槽只吃音频，未知槽全类型。
 */
import type { CreativeAsset } from './assetsStore'
import type { WorkflowTemplate } from './templateCore'

export type SlotKind = 'image' | 'video' | 'audio'

export interface MediaSlot {
  name: string
  kind: SlotKind
}

export interface AssetMountApplied {
  assetId: string
  name: string
  /** 参考图实际落到的槽（按 refs 顺序，长度可能小于 refs） */
  slots: string[]
  /** 实际写入的 seed（模板有 seed 参数且用户未指定时） */
  seedApplied?: number
  /** 合并进 params 的键 */
  paramsApplied: string[]
}

export interface AssetMountResult {
  params: Record<string, unknown>
  applied: AssetMountApplied[]
  issues: string[]
}

/** 模板的媒体素材槽（rc 以 -uploader 结尾的 input 参数） */
export function listMediaSlots(template: Pick<WorkflowTemplate, 'paramsNodes'>): MediaSlot[] {
  return (template.paramsNodes ?? [])
    .filter((p) => p.category === 'input' && /-uploader$/i.test(p.renderComponent ?? ''))
    .map((p) => ({ name: p.name, kind: uploaderKind(p.renderComponent ?? '') }))
}

function uploaderKind(rc: string): SlotKind {
  if (/video/i.test(rc)) return 'video'
  if (/audio/i.test(rc)) return 'audio'
  return 'image'
}

/** 槽可接受的素材类型（宽容顺序；video 槽可吃图） */
function acceptsFor(slotKind: SlotKind): SlotKind[] {
  if (slotKind === 'video') return ['video', 'image']
  if (slotKind === 'audio') return ['audio']
  return ['image']
}

/** 资产期望的素材类型（当前均为图片：角色/风格/道具参考） */
function assetMediaKinds(_asset: CreativeAsset): SlotKind[] {
  return ['image']
}

function isFilled(v: unknown): boolean {
  if (v === undefined || v === null) return false
  if (typeof v === 'string') return v.trim().length > 0
  if (Array.isArray(v)) return v.length > 0
  return true
}

/** seed 类参数名（精确 seed 或 test_/noise_ 等前缀式命名） */
const SEED_PARAM_RE = /(^|[^a-z])seed([^a-z]|$)/i

export function mountAssetsToTemplate(
  template: Pick<WorkflowTemplate, 'paramsNodes'>,
  assets: CreativeAsset[],
  userParams: Record<string, unknown> = {}
): AssetMountResult {
  const params: Record<string, unknown> = { ...userParams }
  const issues: string[] = []
  const applied: AssetMountApplied[] = []
  if (assets.length === 0) return { params, applied, issues }

  const slots = listMediaSlots(template)
  /** 本轮已被占用的槽（用户已填 + 本次挂载） */
  const taken = new Set<string>(slots.filter((s) => isFilled(params[s.name])).map((s) => s.name))

  const imageSlots = slots.filter((s) => s.kind === 'image')
  if (imageSlots.length === 0 && assets.some((a) => a.refs.length > 0)) {
    issues.push(
      `模板「${String((template as { name?: string }).name ?? '')}」没有图片素材槽（image-uploader），资产参考图无法挂载`
    )
  }

  for (const asset of assets) {
    const want = assetMediaKinds(asset)
    const entry: AssetMountApplied = {
      assetId: asset.id,
      name: asset.name,
      slots: [],
      paramsApplied: []
    }

    // 1) 参考图 → 素材槽（类型相容 + 未被占用；先同类槽，再含宽容槽）。
    // 语义：用户/模型已填的槽不动，资产参考图**顺位**填入剩余槽——保持 refs
    // 相对顺序（主参考图优先占位），槽不够时丢弃靠后参考图并报 issue，而不是
    // 反过来丢弃主参考图去凑槽序。
    const ordered = [
      ...slots.filter((s) => want.includes(s.kind)),
      ...slots.filter((s) => !want.includes(s.kind) && acceptsFor(s.kind).some((k) => want.includes(k)))
    ]
    for (const ref of asset.refs) {
      // ref 可自带类型提示：形如 "video:<file>"（少见，但允许显式指定）
      const m = /^(image|video|audio):(.+)$/i.exec(ref)
      const refKind = (m ? m[1]!.toLowerCase() : 'image') as SlotKind
      const refValue = m ? m[2]!.trim() : ref
      const slot =
        ordered.find((s) => !taken.has(s.name) && acceptsFor(s.kind).includes(refKind)) ??
        ordered.find((s) => !taken.has(s.name))
      if (!slot) {
        issues.push(
          `资产「${asset.name}」的参考图「${refValue}」没有可用素材槽（模板素材槽已用完）`
        )
        break
      }
      taken.add(slot.name)
      params[slot.name] = refValue
      entry.slots.push(slot.name)
    }

    // 2) seed → seed 类参数（用户/前序资产已占则跳过）
    if (asset.seed !== undefined) {
      const seedSlot = (template.paramsNodes ?? []).find(
        (p) =>
          p.category === 'input' &&
          !/-uploader$/i.test(p.renderComponent ?? '') &&
          SEED_PARAM_RE.test(p.name)
      )
      if (seedSlot && !isFilled(params[seedSlot.name])) {
        params[seedSlot.name] = asset.seed
        entry.seedApplied = asset.seed
      } else if (seedSlot && isFilled(params[seedSlot.name])) {
        issues.push(
          `资产「${asset.name}」的 seed=${asset.seed} 未写入（参数 ${seedSlot.name} 已被指定为 ${String(params[seedSlot.name])}）`
        )
      }
    }

    // 3) params 合并（资产附带参数；用户显式值优先）
    for (const [k, v] of Object.entries(asset.params)) {
      if (isFilled(userParams[k])) continue
      params[k] = v
      entry.paramsApplied.push(k)
    }

    applied.push(entry)
  }

  return { params, applied, issues }
}
