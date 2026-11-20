import { describe, expect, it } from 'vitest'
import { DEFAULT_LISTEN_HOST, isLoopbackHost, resolveListenHost } from './listenHost'

describe('resolveListenHost', () => {
  it('returns the configured host when a non-empty string', () => {
    expect(resolveListenHost({ listenHost: '0.0.0.0' })).toBe('0.0.0.0')
    expect(resolveListenHost({ listenHost: ' 127.0.0.1 ' })).toBe('127.0.0.1')
  })

  it('falls back to loopback when missing, empty, or wrong type', () => {
    expect(resolveListenHost({})).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost({ listenHost: '   ' })).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost({ listenHost: 0 })).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost(null)).toBe(DEFAULT_LISTEN_HOST)
    expect(resolveListenHost(undefined)).toBe(DEFAULT_LISTEN_HOST)
  })

  it('default is loopback (server must not bind 0.0.0.0 implicitly)', () => {
    expect(DEFAULT_LISTEN_HOST).toBe('127.0.0.1')
  })
})

describe('isLoopbackHost', () => {
  it('recognizes loopback forms', () => {
    expect(isLoopbackHost('127.0.0.1')).toBe(true)
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('::1')).toBe(true)
  })

  it('rejects wildcard and LAN addresses', () => {
    expect(isLoopbackHost('0.0.0.0')).toBe(false)
    expect(isLoopbackHost('192.168.1.10')).toBe(false)
  })
})
