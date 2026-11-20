/**
 * 外部传输注册表单测:def 完整性、findExternalTransport、resolveExternalBin
 * 校验语义。零子进程/零 electron 依赖。
 */
import { describe, expect, it } from 'vitest'
import {
  EXTERNAL_TRANSPORTS,
  findExternalTransport,
  resolveExternalBin
} from './externalTransports'

describe('EXTERNAL_TRANSPORTS 注册表', () => {
  it('id 唯一且与 settings 合法值一致', () => {
    const ids = EXTERNAL_TRANSPORTS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(ids).toContain('acp')
    expect(ids).toContain('claude')
  })

  it('每个 def 字段完整:label/create 必备;requiresBin 与 defaultBin 互斥合理', () => {
    for (const def of EXTERNAL_TRANSPORTS) {
      expect(def.label).toBeTruthy()
      expect(typeof def.create).toBe('function')
      if (def.requiresBin) {
        // 必填通道必须有缺失指引
        expect(def.missingBinHint).toBeTruthy()
      } else {
        // 可选通道必须有缺省二进制
        expect(def.defaultBin).toBeTruthy()
      }
    }
  })
})

describe('findExternalTransport', () => {
  it('已知 id 命中,未知 id 返回 null', () => {
    expect(findExternalTransport('acp')?.id).toBe('acp')
    expect(findExternalTransport('claude')?.id).toBe('claude')
    expect(findExternalTransport('exec')).toBeNull()
    expect(findExternalTransport('appserver')).toBeNull()
    expect(findExternalTransport('')).toBeNull()
  })
})

describe('resolveExternalBin', () => {
  it('requiresBin 通道:空值抛带指引的错;正常值 trim 返回', () => {
    const acp = findExternalTransport('acp')!
    expect(() => resolveExternalBin(acp, '')).toThrow(/外部 Agent 接入/)
    expect(() => resolveExternalBin(acp, '   ')).toThrow(/kimi/)
    expect(resolveExternalBin(acp, ' /usr/local/bin/qwen ')).toBe('/usr/local/bin/qwen')
  })

  it('可选通道:空值回退 defaultBin;非空值优先', () => {
    const claude = findExternalTransport('claude')!
    expect(resolveExternalBin(claude, '')).toBe('claude')
    expect(resolveExternalBin(claude, '  ')).toBe('claude')
    expect(resolveExternalBin(claude, '/opt/claude-custom')).toBe('/opt/claude-custom')
  })
})
