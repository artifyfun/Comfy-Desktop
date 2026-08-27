import { describe, it, expect } from 'vitest'
import { resolveCodexBaseUrl } from './agentDriver'

describe('resolveCodexBaseUrl', () => {
  it('显式 baseUrl 最高优先', () => {
    expect(resolveCodexBaseUrl({ baseUrl: 'https://gw.example.com/v1' })).toBe(
      'https://gw.example.com/v1'
    )
  })

  it('无显式/无 config 时落 provider 默认（测试环境 appStore 不可用走 catch）', () => {
    expect(resolveCodexBaseUrl({})).toBe('https://api.deepseek.com/v1')
    expect(resolveCodexBaseUrl({ provider: 'openrouter' })).toBe('https://openrouter.ai/api/v1')
  })

  it('未知 provider 落 deepseek 默认', () => {
    expect(resolveCodexBaseUrl({ provider: 'azure' })).toBe('https://api.deepseek.com/v1')
  })
})
