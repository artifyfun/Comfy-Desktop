/**
 * 工作台预设：纯函数层（无 electron 依赖，可单测）。
 *
 * 预设 = 任务预设（对照 dsh 的 agent 组成预设）：约束 codex 单轮决策的
 * 意图范围/提示词模板/推荐模板/默认参数。内置 4 个；自定义 = 复制内置后改
 * （copy-dialog 语义，浏览器只编辑结构化字段）。
 */

export type WorkbenchIntent = 'image' | 'video' | 'audio' | 'text' | 'chat'

export interface WorkbenchPreset {
  id: string
  name: { zh: string; en: string }
  description: { zh: string; en: string }
  builtin: boolean
  /** 排序权重（dsh preset.yml 的 order：列表按此升序，缺省 100） */
  order?: number
  /** 决策提示词模板，{input} 占位符会被用户输入替换 */
  promptTemplate?: string
  /** 意图约束：锁定 codex 决策范围（preset=text-to-image 时 intent 只能 image） */
  intentHint?: WorkbenchIntent
  /** 预推荐模板 id（codex 优先选它） */
  preferredTemplateId?: string
  /** 捆绑模板（可执行工作流模板 id 清单，codex 优先选用的推荐池） */
  templateIds?: string[]
  /** 捆绑技能（SKILL.md 知识技能 name 清单，软约束提示 agent 适用时参考） */
  skillIds?: string[]
  /** 默认参数（决策时作为 params 基线） */
  defaultParams?: Record<string, unknown>
}

export const BUILTIN_PRESETS: WorkbenchPreset[] = [
  {
    id: 'standard',
    name: { zh: '标准', en: 'Standard' },
    description: {
      zh: '无约束，AI 自由决策意图与模板',
      en: 'No constraints; AI decides intent and template freely'
    },
    builtin: true,
    order: 1
  },
  {
    id: 'text-to-image',
    name: { zh: '文生图', en: 'Text to Image' },
    description: {
      zh: '用文字描述生成图片',
      en: 'Generate images from a text description'
    },
    builtin: true,
    order: 2,
    intentHint: 'image',
    promptTemplate: '{input}'
  },
  {
    id: 'image-to-image',
    name: { zh: '图生图', en: 'Image to Image' },
    description: {
      zh: '上传参考图，按描述转绘',
      en: 'Upload reference images and restyle per description'
    },
    builtin: true,
    order: 3,
    intentHint: 'image',
    promptTemplate: '以我上传的图片为参考：{input}'
  },
  {
    id: 'video-gen',
    name: { zh: '视频生成', en: 'Video Generation' },
    description: {
      zh: '文字或图片驱动生成视频',
      en: 'Generate video from text or images'
    },
    builtin: true,
    order: 4,
    intentHint: 'video',
    promptTemplate: '{input}'
  }
]

/** 预设 id 规则（对齐 dsh copy-dialog 的 containment rule） */
export function isValidPresetId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]*$/.test(id)
}

/**
 * 复制内置预设新建自定义预设（copy-dialog 语义）。
 * 返回 null 表示源不存在或 id 非法/已占用。
 */
export function clonePreset(
  from: string,
  id: string,
  nameZh: string,
  existingIds: ReadonlySet<string>
): WorkbenchPreset | null {
  if (!isValidPresetId(id)) return null
  if (existingIds.has(id)) return null
  const src = BUILTIN_PRESETS.find((p) => p.id === from) ?? BUILTIN_PRESETS[0]!
  return {
    ...src,
    id,
    name: { zh: nameZh || src.name.zh, en: nameZh || src.name.en },
    description: { ...src.description },
    builtin: false,
    // 自定义预设紧跟源预设之后（dsh order 语义）
    order: (src.order ?? 100) + 0.5
  }
}

/**
 * 应用预设到用户输入：展开 promptTemplate 的 {input} 占位。
 * 无模板或不含占位符时原样返回。
 */
export function applyPromptTemplate(preset: WorkbenchPreset | undefined, input: string): string {
  const tpl = preset?.promptTemplate
  if (!tpl || !tpl.includes('{input}')) return input
  return tpl.replace(/\{input\}/g, input)
}

/**
 * 决策 spec 用的预设约束段（注入 codex 决策提示，见 service.buildDecisionSpec）。
 * 无约束返回空串。
 */
export function presetConstraintText(preset: WorkbenchPreset | undefined): string {
  if (!preset) return ''
  const parts: string[] = []
  if (preset.intentHint) {
    parts.push(`intent MUST be "${preset.intentHint}"`)
  }
  if (preset.preferredTemplateId) {
    parts.push(`prefer template "${preset.preferredTemplateId}" unless clearly unusable`)
  }
  if (preset.templateIds?.length) {
    // 捆绑模板=可执行推荐池（软约束，非强制唯一）
    parts.push(`prefer templates [${preset.templateIds.join(', ')}] when suitable`)
  }
  if (preset.skillIds?.length) {
    // 捆绑技能=知识文档（SKILL.md，已部署到 $CODEX_HOME/skills/），软约束
    parts.push(
      `prefer skills [${preset.skillIds.join(', ')}] when suitable (read the SKILL.md first)`
    )
  }
  if (preset.defaultParams && Object.keys(preset.defaultParams).length > 0) {
    parts.push(`default params baseline: ${JSON.stringify(preset.defaultParams)}`)
  }
  return parts.join('; ')
}

// ---------- 斜杠触发（技能 = 预设 + 模板快捷方式） ----------

export interface SlashToken {
  /** 命中的模板 id（技能）；预设点击选择，不参与斜杠 */
  id: string
  kind: 'template'
  /** token 后剩余文本（不含 token 本身） */
  rest: string
}

/**
 * 从消息文本识别首个斜杠 token（dsh gesture boundary 模式：
 * whitespace 分界的 /name token，可出现在任意位置）。
 * 未命中返回 null。
 */
/**
 * 解析斜杠 token（模板快捷方式语义，单选）。
 *
 * 预设不参与斜杠——预设是点击选择的（会话级），见 NewSessionDialog/
 * 会话头 chip。模板 id 含冒号（app:xxx），字符类需含 ':'；仍要求
 * whitespace 分界，url 中的 /path（前邻非空白）不会被误命中。
 */
export function parseSlashToken(
  text: string,
  _presets: readonly { id: string }[],
  templates: readonly { id: string }[]
): SlashToken | null {
  const re = /(?:^|\s)\/([a-zA-Z0-9][a-zA-Z0-9_:-]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const name = m[1]!.toLowerCase()
    const tokenLen = m[0].length
    const before = text.slice(0, m.index)
    const rest = text.slice(m.index + tokenLen)
    if (templates.some((t) => t.id.toLowerCase() === name)) {
      return { id: name, kind: 'template', rest: (before + ' ' + rest).trim() }
    }
  }
  return null
}

// ---------- 附件（多素材） ----------

export type AttachmentKind = 'image' | 'video' | 'audio' | 'file'

export interface AttachmentMeta {
  /** ComfyUI upload 返回的 name（含 subfolder 前缀） */
  name: string
  subfolder?: string
  type?: string
  kind: AttachmentKind
  /** 原始文件名（展示用） */
  filename: string
  size: number
  mime?: string
  /** B 权限:本地文件引用的绝对路径（未上传实体;执行时同机检测直通） */
  localPath?: string
}

/** 从 mime/扩展名派生素材类型 */
export function deriveAttachmentKind(filename: string, mime?: string): AttachmentKind {
  const m = (mime || '').toLowerCase()
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  const ext = (filename.split('.').pop() || '').toLowerCase()
  if (['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'tiff'].includes(ext)) return 'image'
  if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'gifv'].includes(ext)) return 'video'
  if (['mp3', 'wav', 'flac', 'ogg', 'm4a', 'aac'].includes(ext)) return 'audio'
  return 'file'
}

/** 决策 spec 用的附件清单摘要（如 "2 images, 1 video" + 文件名列表） */
export function attachmentSummary(attachments: readonly AttachmentMeta[]): string {
  if (attachments.length === 0) return ''
  const counts = new Map<AttachmentKind, number>()
  for (const a of attachments) counts.set(a.kind, (counts.get(a.kind) ?? 0) + 1)
  const parts = [...counts.entries()].map(([k, n]) => `${n} ${k}${n > 1 ? 's' : ''}`)
  const names = attachments.map((a) => a.filename).join(', ')
  return `${parts.join(', ')}: ${names}`
}

// ---------- 执行期：附件按序填充媒体输入参数 ----------

export interface MediaInputSlot {
  /** 参数名（模板 paramsNodes 中） */
  param: string
  /** 该参数接受的素材类型（由参数类型派生） */
  accept: AttachmentKind[]
}

/**
 * 附件按序分配到媒体输入位。
 * 规则：先按类型匹配（accept 包含附件 kind），同类型内按数组顺序；
 * 每个附件只分配一次；匹配不到的附件忽略（记录 ignored）。
 */
export function assignAttachmentsToSlots(
  attachments: readonly AttachmentMeta[],
  slots: readonly MediaInputSlot[]
): {
  assignments: Array<{ slot: MediaInputSlot; attachment: AttachmentMeta }>
  ignored: AttachmentMeta[]
} {
  const used = new Set<number>()
  const assignments: Array<{ slot: MediaInputSlot; attachment: AttachmentMeta }> = []
  for (const slot of slots) {
    for (let i = 0; i < attachments.length; i++) {
      if (used.has(i)) continue
      const a = attachments[i]!
      if (slot.accept.includes(a.kind)) {
        used.add(i)
        assignments.push({ slot, attachment: a })
        break // 每个输入位填一个附件（多素材=多个输入位）
      }
    }
  }
  const ignored = attachments.filter((_, i) => !used.has(i))
  return { assignments, ignored }
}
