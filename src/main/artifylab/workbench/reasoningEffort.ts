/**
 * E1 — 决策链推理强度（reasoning effort）域。
 *
 * 工作台 decide 链路（codex exec/app-server）经 `model_reasoning_effort`
 * config 透传到引擎，引擎按 Responses API `reasoning.effort` 语义控制 agent
 * 规划/思考的投入程度。取值集合取 vendored SDK 官方枚举
 * （codex-sdk.d.ts ModelReasoningEffort）的常用子集：
 *   minimal/low/medium/high/xhigh
 * 不含 max/ultra（面向高端推理模型，glm/deepseek 等决策模型用不上）也不含
 * none（关闭思考属模型/配置层语义，不做 UI 档位）。
 *
 * 会话层还有一档特殊值 'auto'（前端下拉默认）：语义 = 不指定，零行为变化，
 * 引擎按模型默认。后端收到 'auto' 时不会把 model_reasoning_effort 注入
 * 引擎配置——显式传 'auto' 还用于撤销此前会话级具名档位（回引擎默认）。
 * 非法值（越界字符串）一律视为未提供，保持旧行为。
 */

/** 合法 effort 值（含 'auto' 特档；'auto' 只在会话层流转，不落引擎） */
export type ReasoningEffort = 'auto' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh'

/** 全部合法值（路由层枚举校验 / UI 白名单共用） */
export const REASONING_EFFORTS: readonly ReasoningEffort[] = [
  'auto',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh'
]

/** 类型守卫：v 是否为合法 effort 值 */
export function isReasoningEffort(v: unknown): v is ReasoningEffort {
  return typeof v === 'string' && (REASONING_EFFORTS as readonly string[]).includes(v)
}

/**
 * 请求值 → 会话层期望档位。
 * - 非法值 → undefined（忽略，旧行为）
 * - 'auto' / 具名档位 → 原样透传（decide 层把 'auto' 折叠为「不指定」）
 */
export function normalizeReasoningEffort(v: unknown): ReasoningEffort | undefined {
  return isReasoningEffort(v) ? v : undefined
}

/**
 * 会话层档位 → 引擎 config 值。
 * - undefined / 'auto' → undefined（不注入 model_reasoning_effort，引擎默认）
 * - 具名档位 → 原值（minimal/low/medium/high/xhigh，SDK ThreadOptions 合法）
 */
export function toEngineEffort(
  v: ReasoningEffort | undefined
): Exclude<ReasoningEffort, 'auto'> | undefined {
  if (v === undefined || v === 'auto') return undefined
  return v
}
