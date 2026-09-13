/**
 * 画布工作流 → 模板参数的自动推断（对标建议 #8 的核心：让"沉淀"出来的模板
 * 真的可复用）。
 *
 * 现状缺口：`publishWorkflow` 缺省只推断**输出**节点（`inferOutputParamNodes`），
 * 于是固化出的模板没有任何可填输入——用户/AI 拿到模板后改不了提示词、seed、
 * 参考图，"复用"是空的。本模块补上输入侧推断。
 *
 * 推断策略为**白名单 + 保守**（宁可少暴露，不可噪音满屏）：
 *   - 文本编码节点（CLIPTextEncode/T5 系）的 text → textarea 参数
 *     （title 含 negative/负 → negative_prompt；否则首个 prompt、后续 prompt_2…）
 *   - seed / steps / cfg / guidance / denoise / width / height / batch_size / shift
 *     → 数值参数（仅当值为字面量，链接输入跳过）
 *   - Load* 节点的首个字符串输入 → 媒体槽（image/video/audio-uploader）
 *
 * 与校验器对齐（plan.ts validateParams）：数值参数 `selectedWidget.type` 必须是
 * 小写 'number'，否则会被当作字符串校验；媒体槽靠 renderComponent 的
 * '-uploader' 后缀走素材值校验。
 */
import type { ComfyPrompt, ParamNode } from '../appStore'

export type InputParamKind = 'text' | 'media' | 'number'

/** 单个候选槽（推断中间态） */
interface Candidate {
  nodeId: string
  inputKey: string
  kind: InputParamKind
  /** 媒体槽的 media kind；数值/文本为 undefined */
  mediaKind?: 'image' | 'video' | 'audio'
  /** 文本节点的标题（用于 positive/negative 判定） */
  title?: string
  /** 数值参数的原始键名（小写归一） */
  key?: string
}

/** 视为链接引用（上游节点输出）的值形态 */
function isLink(v: unknown): boolean {
  return Array.isArray(v) && v.length > 0 && Number.isFinite(Number((v as unknown[])[0]))
}

const TEXT_NODE_RE = /TextEncode|CLIPTextEncode|T5TextEncode|PromptExpander/i
/**
 * 媒体加载器判定：`Load*` 前缀（LoadImage / LoadVideo / LoadImageFromPath…）
 * 或 VHS 等带前缀的加载器。**不能**放宽成 /load/i —— 否则
 * CheckpointLoader/LoraLoader 的模型名字符串会被当成素材槽暴露出去。
 */
const MEDIA_LOADER_RE = /^load|VHS_Load|_LoadVideo|_LoadAudio|_LoadImage/i
/** 数值参数白名单（键名 → 是否整数） */
const NUMERIC_KEYS: Record<string, 'int' | 'float'> = {
  seed: 'int',
  steps: 'int',
  cfg: 'float',
  guidance: 'float',
  guidance_scale: 'float',
  denoise: 'float',
  width: 'int',
  height: 'int',
  batch_size: 'int',
  shift: 'float'
}
/** 数值参数的优先级（越小越靠前；seed/steps 最常被改） */
const NUMERIC_PRIORITY: Record<string, number> = { seed: 0, steps: 1, cfg: 2 }

function mediaKindOf(classType: string): 'image' | 'video' | 'audio' {
  if (/video|vhs/i.test(classType)) return 'video'
  if (/audio|sound|music/i.test(classType)) return 'audio'
  return 'image'
}

/** 文本节点 title 是否表示负面提示词 */
function isNegativeTitle(title: string | undefined): boolean {
  return !!title && /negative|neg_|负|反向/i.test(title)
}

/**
 * 从 API 格式 prompt 推断可参数化输入槽。
 *
 * @param max 参数上限（默认 12；避免固化的模板参数爆炸，模型填参成本上升）
 */
export function inferInputParamNodes(prompt: ComfyPrompt, max = 12): ParamNode[] {
  const texts: Candidate[] = []
  const medias: Candidate[] = []
  const numbers: Candidate[] = []

  for (const [nodeId, node] of Object.entries(prompt ?? {})) {
    const cls = String(node?.class_type ?? '')
    const inputs = (node?.inputs ?? {}) as Record<string, unknown>
    const title = (node as { _meta?: { title?: string } })?._meta?.title

    // 1) 媒体槽：Load* 节点的首个非链接字符串输入（与 inferFirstMediaSlot 同源）
    if (MEDIA_LOADER_RE.test(cls)) {
      const key = Object.keys(inputs).find(
        (k) => typeof inputs[k] === 'string' && !isLink(inputs[k])
      )
      if (key) {
        medias.push({ nodeId, inputKey: key, kind: 'media', mediaKind: mediaKindOf(cls) })
        continue
      }
    }

    // 2) 文本参数：文本编码节点的 text
    if (TEXT_NODE_RE.test(cls)) {
      for (const [key, v] of Object.entries(inputs)) {
        if (!/text|prompt/i.test(key)) continue
        if (typeof v !== 'string' || isLink(v)) continue
        texts.push({ nodeId, inputKey: key, kind: 'text', title })
      }
      continue
    }

    // 3) 数值参数：白名单键
    for (const [key, v] of Object.entries(inputs)) {
      const norm = key.toLowerCase()
      if (!(norm in NUMERIC_KEYS)) continue
      if (isLink(v)) continue
      if (typeof v !== 'number' && typeof v !== 'string') continue
      if (typeof v === 'string' && !Number.isFinite(Number(v))) continue
      numbers.push({ nodeId, inputKey: key, kind: 'number', key: norm })
    }
  }

  // 排序：文本（prompt 先于 negative）→ 媒体 → seed/steps/cfg → 其他数值
  const textScore = (c: Candidate): number => (isNegativeTitle(c.title) ? 1 : 0)
  texts.sort((a, b) => textScore(a) - textScore(b))
  numbers.sort((a, b) => (NUMERIC_PRIORITY[a.key!] ?? 9) - (NUMERIC_PRIORITY[b.key!] ?? 9))

  const ordered = [...texts, ...medias, ...numbers].slice(0, Math.max(0, max))
  const used = new Set<string>()

  return ordered.map((c) => {
    const name = uniqueName(paramName(c, used), used)
    used.add(name)
    if (c.kind === 'text') {
      return {
        id: Number(c.nodeId) || 0,
        name,
        category: 'input' as const,
        type: 'string',
        renderComponent: 'textarea',
        selectedWidget: { id: c.nodeId, name: c.inputKey, type: 'string' }
      }
    }
    if (c.kind === 'media') {
      return {
        id: Number(c.nodeId) || 0,
        name,
        category: 'input' as const,
        type: 'string',
        renderComponent: `${c.mediaKind}-uploader`,
        selectedWidget: { id: c.nodeId, name: c.inputKey, type: 'string' }
      }
    }
    const numeric = NUMERIC_KEYS[c.key!] ?? 'float'
    return {
      id: Number(c.nodeId) || 0,
      name,
      category: 'input' as const,
      type: numeric,
      renderComponent: 'number',
      // 必须小写 number/float/int：plan.validateParams 用严格相等判数值分支
      selectedWidget: { id: c.nodeId, name: c.inputKey, type: numeric === 'int' ? 'int' : 'float' }
    }
  })
}

/** 参数命名（对齐人类/AI 的直觉词汇） */
function paramName(c: Candidate, used: Set<string>): string {
  if (c.kind === 'text') {
    if (isNegativeTitle(c.title)) return 'negative_prompt'
    // 后续文本编码显式递增 prompt_2/prompt_3…——交给 uniqueName 会得到
    // prompt_2_2 这种兜底名（第二个已占 prompt_2），对模型不友好
    if (!used.has('prompt')) return 'prompt'
    let i = 2
    while (used.has(`prompt_${i}`)) i++
    return `prompt_${i}`
  }
  if (c.kind === 'media') return c.mediaKind ?? 'image'
  return c.key ?? 'value'
}

/** 去重：prompt_2 / prompt_3 …（避免同名参数在 find(name) 时串槽） */
function uniqueName(base: string, used: Set<string>): string {
  if (!used.has(base)) return base
  let i = 2
  while (used.has(`${base}_${i}`)) i++
  return `${base}_${i}`
}
