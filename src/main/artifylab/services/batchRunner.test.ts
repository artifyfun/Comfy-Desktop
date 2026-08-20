// batchRunner 顶层 import artifyUtils(→ server → electron),测试环境无 electron
// 二进制,这里 mock 掉模块副作用部分,只测纯函数。
import { describe, expect, it, vi } from 'vitest'

vi.mock('..', () => ({ default: { getConfig: () => ({}), getServerPort: () => 3008 } }))
vi.mock('../utils/logger', () => ({ logger: { info: () => {}, warn: () => {}, error: () => {} } }))

const { buildItemPrompt, convertValueByType, getSeed } = await import('./batchRunner')

const basePrompt = {
  '1': { class_type: 'KSampler', inputs: { seed: 123, steps: 20 } },
  '2': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'model.safetensors' } },
  '3': { class_type: 'CLIPTextEncode', inputs: { text: 'default' } }
} as const

const mapping = [
  { id: '3', key: 'text', category: 'input', valueType: 'string', valueMap: { key: 'prompt' } },
  { id: '1', key: 'steps', category: 'input', valueType: 'number', valueMap: { key: 'n' } },
  { id: '2', key: 'ckpt_name', category: 'input', valueType: 'string', manualValue: 'fixed.safetensors' }
]

describe('convertValueByType', () => {
  it('converts number/boolean/object', () => {
    expect(convertValueByType('42', 'number')).toBe(42)
    expect(convertValueByType('true', 'boolean')).toBe(true)
    expect(convertValueByType('off', 'boolean')).toBe(false)
    expect(convertValueByType('{"a":1}', 'object')).toEqual({ a: 1 })
    expect(() => convertValueByType('abc', 'number')).toThrow()
    expect(() => convertValueByType('maybe', 'boolean')).toThrow()
  })
})

describe('getSeed', () => {
  it('returns 15-digit number with non-zero lead', () => {
    for (let i = 0; i < 20; i++) {
      const s = getSeed()
      expect(String(s)).toHaveLength(15)
      expect(String(s)[0]).not.toBe('0')
    }
  })
})

describe('buildItemPrompt', () => {
  it('does not mutate the base template', () => {
    const before = JSON.stringify(basePrompt)
    buildItemPrompt(basePrompt as never, mapping, { prompt: 'hi', n: 5 })
    expect(JSON.stringify(basePrompt)).toBe(before)
  })

  it('randomizes numeric seed fields', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, {}) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    const seed = out['1']!.inputs['seed']
    expect(typeof seed).toBe('number')
    expect(seed).not.toBe(123)
  })

  it('merges valueMap with type conversion and manualValue wins when no map', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, { prompt: 'hello', n: '30' }) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    expect(out['3']!.inputs['text']).toBe('hello')
    expect(out['1']!.inputs['steps']).toBe(30) // number, not string
    expect(out['2']!.inputs['ckpt_name']).toBe('fixed.safetensors')
  })

  it('keeps template default when mapped field missing from data row', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, {}) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    expect(out['3']!.inputs['text']).toBe('default')
  })

  it('falls back to raw value on conversion failure', () => {
    const out = buildItemPrompt(basePrompt as never, mapping, { n: 'not-a-number' }) as Record<
      string,
      { inputs: Record<string, unknown> }
    >
    expect(out['1']!.inputs['steps']).toBe('not-a-number')
  })
})
