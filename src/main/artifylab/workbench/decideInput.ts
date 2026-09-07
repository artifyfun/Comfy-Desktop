/**
 * decide 输入解析——纯函数层（候选 ⑤）。
 *
 * 从 service.decide 的输入预处理段抽出：斜杠 token 剥离 > 会话预设解析 >
 * 失效技能过滤 > 提示词模板展开。无 IO、无 service 依赖（getPreset 经
 * deps 注入），可单测。
 */
import {
  parseSlashToken,
  applyPromptTemplate,
  type AttachmentMeta,
  type WorkbenchPreset
} from './presetCore'

/** 预设解析依赖（service 注入；测试可伪造） */
export interface ResolveDecideInputDeps {
  /** 按预设 id 取预设（service.getPreset） */
  getPreset(id: string): WorkbenchPreset | null
  /** 模板清单（斜杠 token 补全用） */
  templates: Array<{ id: string; name: string }>
  /** 失效技能过滤（service.effectivePreset 语义；缺省原样返回） */
  effectivePreset?(preset: WorkbenchPreset | undefined): WorkbenchPreset | undefined
}

/** 解析结果 */
export interface ResolvedDecideInput {
  /** 预设模板展开后的决策输入（附件-only 场景给默认占位提示） */
  input: string
  /** 斜杠 token 剥离后的用户原文 */
  rawUserText: string
  /** 解析后的会话预设（已过滤失效技能） */
  preset: WorkbenchPreset | undefined
  presetId?: string
  /** 用户显式指定的模板 id（"/触发词"语法糖） */
  templateShortcut?: string
}

/** 解析 decide 输入：斜杠 token > 会话预设 > 模板展开 */
export function resolveDecideInput(
  rawInput: string,
  deps: ResolveDecideInputDeps,
  opts: { sessionPresetId?: string; attachments?: readonly AttachmentMeta[] } = {}
): ResolvedDecideInput {
  const slash = parseSlashToken(rawInput, [], deps.templates)
  let templateShortcut: string | undefined
  let userInput = rawInput
  if (slash?.kind === 'template') {
    templateShortcut = slash.id
    userInput = slash.rest
  }
  const raw =
    opts.sessionPresetId && deps.getPreset(opts.sessionPresetId)
      ? (deps.getPreset(opts.sessionPresetId) as WorkbenchPreset)
      : undefined
  const preset = deps.effectivePreset ? deps.effectivePreset(raw) : raw
  // 附件-only 输入给默认占位提示（空串会让模型失去指令锚点）
  const baseInput = userInput.trim() || '按我上传的素材生成'
  const input = applyPromptTemplate(preset, baseInput)
  return {
    input,
    rawUserText: userInput,
    preset,
    ...(opts.sessionPresetId ? { presetId: opts.sessionPresetId } : {}),
    ...(templateShortcut ? { templateShortcut } : {})
  }
}
