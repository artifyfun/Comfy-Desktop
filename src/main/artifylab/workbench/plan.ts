/**
 * 工作台 PLAN 校验（workbench-plan.md Phase 1 步骤 3）。
 *
 * codex 产出的 PLAN 先过这里：模板存在性 → 参数类型/范围 → 模型已安装
 * （/object_info + 模型名比对）→ VRAM watchdog（/system_stats）。
 * 校验失败返回可读错误，由编排层打回 codex 重试（≤2 次）。
 */
import type { ComfyPrompt } from '../appStore'
import type { WorkflowTemplate } from './templateCore'
import { logger } from '../utils/logger'

/** codex 决策输出的结构化执行计划 */
export interface WorkbenchPlan {
  intent: 'image' | 'video' | 'audio' | 'text' | 'chat'
  /** intent=chat 时直接回复用户；其余意图必须带模板与参数 */
  reply?: string
  templateId?: string
  params?: Record<string, unknown>
  /** 会话内链式：引用上一次执行的产物（图→视频） */
  usePreviousOutput?: boolean
  reason?: string // codex 解释（展示给用户）
  /** P2e：首条消息时可带的会话标题（≤20 字，用户手改过不覆盖） */
  title?: string
}

export interface PlanValidationIssue {
  field: string
  message: string
}

export interface PlanValidationResult {
  ok: boolean
  issues: PlanValidationIssue[]
  template?: WorkflowTemplate
}

/** fetch 带超时（与 executor 一致的容错） */
function fetchTimeout(url: string, ms = 15000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/** 参数基础校验：类型 + 数值范围（对照 selectedWidget.options） */
function validateParams(
  template: WorkflowTemplate,
  params: Record<string, unknown>
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = []
  const inputs = template.paramsNodes.filter((n) => n.category === 'input')
  for (const [k, v] of Object.entries(params)) {
    const node = inputs.find((n) => n.name === k)
    if (!node) {
      // 未知参数：宽松处理（executor 会忽略无法映射的），但记 issue 供 codex 修正
      issues.push({ field: `params.${k}`, message: '未知参数（模板未声明）' })
      continue
    }
    const widgetType = node.selectedWidget?.type
    if (widgetType === 'number' || widgetType === 'float' || widgetType === 'int') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ field: `params.${k}`, message: `期望数字，得到 ${typeof v}` })
        continue
      }
      const { min, max } = node.selectedWidget?.options ?? {}
      if (min != null && v < min)
        issues.push({ field: `params.${k}`, message: `小于最小值 ${min}` })
      if (max != null && v > max)
        issues.push({ field: `params.${k}`, message: `大于最大值 ${max}` })
    } else if (widgetType === 'boolean') {
      if (typeof v !== 'boolean')
        issues.push({ field: `params.${k}`, message: `期望布尔，得到 ${typeof v}` })
    } else if (Array.isArray(node.selectedWidget?.options?.values)) {
      const values = node.selectedWidget.options.values.map(String)
      if (!values.includes(String(v)))
        issues.push({ field: `params.${k}`, message: `不在可选值内: ${values.join('/')}` })
    } else if (typeof v !== 'string') {
      // 其余 widget（text/combo 无 options 等）宽松：可字符串化的都收
      if (v !== null && typeof v !== 'object') continue // number 也放行（executor 会原样填 widget）
      issues.push({ field: `params.${k}`, message: `期望字符串，得到 ${typeof v}` })
    }
  }
  // 必填参数提醒（有 description 无默认值的输入参数未提供 → 提示 codex，不阻断）
  return issues
}

/** 对 live ComfyUI /object_info 校验节点图（官方 validate_workflow 思路） */
export async function validateAgainstObjectInfo(
  comfyOrigin: string,
  prompt: ComfyPrompt
): Promise<PlanValidationIssue[]> {
  try {
    const res = await fetchTimeout(`${comfyOrigin}/object_info`)
    if (!res.ok) return []
    const info = (await res.json()) as Record<string, unknown>
    const issues: PlanValidationIssue[] = []
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (!(node.class_type in info)) {
        issues.push({
          field: `workflow.${nodeId}`,
          message: `节点类型不存在: ${node.class_type}（自定义节点未安装？）`
        })
      }
    }
    return issues
  } catch (e) {
    // ComfyUI 未启动等：不阻断（执行时 executor 会给出真实错误）
    logger.warn('workbench object_info check failed', e)
    return []
  }
}

/** 模型文件探测：/object_info 里 loader 节点的可选值含模型名即视为已安装 */
export async function validateModels(
  comfyOrigin: string,
  template: WorkflowTemplate
): Promise<PlanValidationIssue[]> {
  const required = template.requiredModels ?? []
  if (required.length === 0) return []
  try {
    const res = await fetchTimeout(`${comfyOrigin}/object_info`)
    if (!res.ok) return []
    const info = (await res.json()) as Record<
      string,
      { input?: { required?: Record<string, unknown> } }
    >
    const issues: PlanValidationIssue[] = []
    for (const model of required) {
      const base = model.split('/').pop() ?? model
      // 任意 loader 节点的任意枚举入参里能找到该模型名 → 已安装
      const installed = Object.values(info).some((node) => {
        const req = node.input?.required ?? {}
        return Object.values(req).some((spec) => {
          if (!Array.isArray(spec)) return false
          // combo 形如 [["model_a.safetensors", ...], {tooltip}]
          const combo = spec[0]
          return Array.isArray(combo) && combo.some((v) => String(v) === base)
        })
      })
      if (!installed) {
        issues.push({
          field: 'models',
          message: `模型未安装: ${model}（请先在模型管理中下载）`
        })
      }
    }
    return issues
  } catch {
    return [] // ComfyUI 不可达时不阻断
  }
}

/** VRAM watchdog（抄 artokun hook）：空闲 <1GB 拦截（可被 force 跳过） */
export async function checkVram(
  comfyOrigin: string,
  force = false
): Promise<PlanValidationIssue[]> {
  if (force) return []
  try {
    const res = await fetchTimeout(`${comfyOrigin}/system_stats`, 8000)
    if (!res.ok) return []
    const stats = (await res.json()) as {
      devices?: Array<{ vram_free?: number }>
    }
    const free = stats.devices?.[0]?.vram_free
    if (typeof free === 'number' && free < 1024 * 1024 * 1024) {
      return [
        {
          field: 'vram',
          message: `显存空闲仅 ${(free / 1024 / 1024 / 1024).toFixed(1)}GB（<1GB），执行可能 OOM。可在 ComfyUI 中释放显存后重试，或强制执行。`
        }
      ]
    }
    return []
  } catch {
    return []
  }
}

/** PLAN 主校验入口（本地部分，不发网络请求） */
export function validatePlanLocal(
  plan: WorkbenchPlan,
  templates: WorkflowTemplate[]
): PlanValidationResult {
  const issues: PlanValidationIssue[] = []
  if (plan.intent === 'chat') {
    if (!plan.reply || !plan.reply.trim()) {
      issues.push({ field: 'reply', message: 'chat 意图必须带 reply' })
    }
    return { ok: issues.length === 0, issues }
  }
  if (plan.intent === 'text') {
    // 文本意图走 ai.ts，无需模板
    if (!plan.reply) issues.push({ field: 'reply', message: 'text 意图暂以 reply 承载文本结果' })
    return { ok: issues.length === 0, issues }
  }
  // image/video/audio：必须有模板
  if (!plan.templateId) {
    issues.push({ field: 'templateId', message: `${plan.intent} 意图必须指定 templateId` })
    return { ok: false, issues }
  }
  const template = templates.find((t) => t.id === plan.templateId)
  if (!template) {
    issues.push({ field: 'templateId', message: `模板不存在: ${plan.templateId}` })
    return { ok: false, issues }
  }
  if (plan.params) issues.push(...validateParams(template, plan.params))
  return { ok: issues.length === 0, issues, template }
}
