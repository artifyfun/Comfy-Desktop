/**
 * E1 — reasoningEffort 域单测：合法集 / 类型守卫 / normalize(请求值→会话档位)
 * / toEngineEffort(会话档位→引擎 config 值)。
 */
import { describe, expect, it } from 'vitest'
import {
  REASONING_EFFORTS,
  isReasoningEffort,
  normalizeReasoningEffort,
  toEngineEffort,
  type ReasoningEffort
} from './reasoningEffort'

describe('reasoningEffort 域', () => {
  it('合法集含 auto 特档 + 5 个具名档位(不含 max/ultra/none)', () => {
    expect(REASONING_EFFORTS).toEqual(['auto', 'minimal', 'low', 'medium', 'high', 'xhigh'])
    // 类型层面拒绝越界值(max/ultra 面向高端推理模型,决策链不暴露)
    const _domain: readonly ReasoningEffort[] = REASONING_EFFORTS
    expect(_domain).toHaveLength(6)
  })

  it('isReasoningEffort 接受全部合法值,拒绝越界/非字符串', () => {
    for (const v of REASONING_EFFORTS) expect(isReasoningEffort(v)).toBe(true)
    expect(isReasoningEffort('none')).toBe(false)
    expect(isReasoningEffort('max')).toBe(false)
    expect(isReasoningEffort('ultra')).toBe(false)
    expect(isReasoningEffort('High')).toBe(false)
    expect(isReasoningEffort('')).toBe(false)
    expect(isReasoningEffort(42)).toBe(false)
    expect(isReasoningEffort(null)).toBe(false)
    expect(isReasoningEffort(undefined)).toBe(false)
    expect(isReasoningEffort({})).toBe(false)
  })

  it('normalizeReasoningEffort:合法原样透传(auto 保留为显式撤销档),非法 → undefined', () => {
    expect(normalizeReasoningEffort('high')).toBe('high')
    expect(normalizeReasoningEffort('auto')).toBe('auto')
    expect(normalizeReasoningEffort('xhigh')).toBe('xhigh')
    expect(normalizeReasoningEffort('none')).toBeUndefined()
    expect(normalizeReasoningEffort(undefined)).toBeUndefined()
    expect(normalizeReasoningEffort(123)).toBeUndefined()
  })

  it('toEngineEffort:具名档位原样透传;auto/undefined 折叠为 undefined(不注入引擎)', () => {
    expect(toEngineEffort('low')).toBe('low')
    expect(toEngineEffort('high')).toBe('high')
    expect(toEngineEffort('auto')).toBeUndefined()
    expect(toEngineEffort(undefined)).toBeUndefined()
  })
})
