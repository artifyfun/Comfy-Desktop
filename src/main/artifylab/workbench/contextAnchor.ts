/**
 * 长上下文锚定提示（真机发现：glm-5.3-flash 在会话累积 ~77k token 时工具
 * 遵循退化——该调工具时只回短文本。缓解：按水位注入「严格走工具」的锚定段）。
 *
 * 水位（turns 与 totalTokens 双维度，取先到者）：
 *   - normal  : 无注入
 *   - elevated: 轮次 ≥ 8 或 token ≥ 150k → 注入工具纪律锚定
 *   - high    : 轮次 ≥ 16 或 token ≥ 500k → 锚定 + 「收敛到保守方案」提示
 *
 * 纯函数，可单测。
 */

export type ContextWatermark = 'normal' | 'elevated' | 'high'

export interface ContextWatermarkThresholds {
  elevatedTurns: number
  elevatedTokens: number
  highTurns: number
  highTokens: number
}

export const DEFAULT_THRESHOLDS: ContextWatermarkThresholds = {
  elevatedTurns: 8,
  elevatedTokens: 150_000,
  highTurns: 16,
  highTokens: 500_000
}

export function contextWatermark(
  turns: number,
  totalTokens: number,
  thresholds: ContextWatermarkThresholds = DEFAULT_THRESHOLDS
): ContextWatermark {
  if (turns >= thresholds.highTurns || totalTokens >= thresholds.highTokens) return 'high'
  if (turns >= thresholds.elevatedTurns || totalTokens >= thresholds.elevatedTokens)
    return 'elevated'
  return 'normal'
}

const ANCHOR_TOOL_DISCIPLINE = `
## 上下文纪律（会话已较长，务必遵守）
- 本会话已累积多轮上下文。**用户的生成/修改需求必须经 wb_* 工具执行**（先
  wb_list_templates 查可用模板，再 wb_execute_template），严禁只输出文字描述
  或空 PLAN 敷衍。
- 输出 PLAN JSON 时 intent/params 必须与用户最新诉求一致；不确定的参数先查再填。
`

const ANCHOR_CONSERVATIVE = `
- 上下文已很长：优先复用本会话已验证过的模板与参数组合，避免引入新的不确定步骤；
  一次只做一步，每步拿工具结果确认后再继续。
`

/** 按水位返回应注入 spec 的锚定段（normal 返回空串） */
export function contextAnchorText(watermark: ContextWatermark): string {
  if (watermark === 'normal') return ''
  const base = ANCHOR_TOOL_DISCIPLINE
  return watermark === 'high' ? base + ANCHOR_CONSERVATIVE : base
}

/** 便捷入口：直接由 turns/tokens 得到锚定文本 */
export function contextAnchorFor(turns: number, totalTokens: number): string {
  return contextAnchorText(contextWatermark(turns, totalTokens))
}

// ─────────────── C-H20 会话预算软水位(对标 Manus 长会话管理) ───────────────

/** 软警告水位:预算的 90% —— spec 注入「收敛输出」提示 */
export const BUDGET_WARN_RATIO = 0.9

/**
 * 预算临近提示(注入 spec,让模型知道快到顶了):
 * - 收敛输出长度,避免长篇 explanation
 * - 不要发起大规模批量/多步任务(执行不完就被迫迁移)
 */
export function budgetWarnText(maxTokens: number, totalTokens: number): string {
  const remain = Math.max(0, maxTokens - totalTokens)
  return `
## 会话预算提示
本会话 token 预算剩余约 ${Math.round(remain / 1000)}k。请收敛输出长度；避免发起
大规模批量或多步任务；用户的重要偏好请用 wb_remember 记入长期记忆（跨会话有效）。`
}

/** 触顶时的用户提示(前端据此引导一键迁移) */
export const BUDGET_EXHAUSTED_HINT =
  '本会话 token 预算已用完。点击「延续到新会话」——重要偏好已可自动带入，画布与资产不受影响。'
