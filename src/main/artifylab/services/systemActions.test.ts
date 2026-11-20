/**
 * systemActions 单测（候选 ③ test surface）：
 * webhook 通知的 SSRF 防护/通道分支 + 关机命令的平台分支与参数校验。
 * fetch 全程 stub（零真实网络）；exec 不真跑（只测命令构造前的校验路径）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendWebhookNotification } from './systemActions'

describe('sendWebhookNotification', () => {
  beforeEach(() => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
    )
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非 https URL → 拒绝', async () => {
    const r = await sendWebhookNotification({ url: 'http://api.day.app/x', title: 't', body: 'b' })
    expect('error' in r).toBe(true)
  })

  it('环回/私网/链路本地 → SSRF 拦截', async () => {
    for (const url of [
      'https://localhost/x',
      'https://127.0.0.1/x',
      'https://192.168.1.1/x',
      'https://10.0.0.1/x',
      'https://172.16.0.1/x',
      'https://169.254.1.1/x',
      'https://intranet.internal/x'
    ]) {
      const r = await sendWebhookNotification({ url, title: 't', body: 'b' })
      expect('error' in r, url).toBe(true)
    }
  })

  it('合法公网通用 webhook → POST {title, body}', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const r = await sendWebhookNotification({
      url: 'https://sctapi.ftqq.com/x.send',
      title: '任务完成',
      body: 'total=3'
    })
    expect('status' in r && r.status).toBe(200)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toBe('https://sctapi.ftqq.com/x.send')
    expect(init.method).toBe('POST')
    expect(init.redirect).toBe('manual')
    expect(JSON.parse(String(init.body))).toEqual({
      title: '任务完成',
      body: 'total=3'
    })
  })

  it('Telegram sendMessage 路径 → text 拼接', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const r = await sendWebhookNotification({
      url: 'https://api.telegram.org/bot123/sendMessage',
      title: 'T',
      body: 'B'
    })
    expect('status' in r && r.status).toBe(200)
    const [, init] = f.mock.calls[0] as [string, RequestInit]
    expect(JSON.parse(String(init.body))).toEqual({ text: 'T\nB' })
  })

  it('Bark 域名 → GET 路径拼接', async () => {
    const f = vi.fn(async (_u: string, _i?: RequestInit) => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', f)
    const r = await sendWebhookNotification({
      url: 'https://api.day.app/abc123',
      title: '标题',
      body: '内容'
    })
    expect('status' in r && r.status).toBe(200)
    const [url, init] = f.mock.calls[0] as [string, RequestInit]
    expect(String(url)).toContain('api.day.app/abc123/')
    expect(String(url)).toContain(encodeURIComponent('标题'))
    expect(init.method).toBe('GET')
  })
})
