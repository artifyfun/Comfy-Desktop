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
