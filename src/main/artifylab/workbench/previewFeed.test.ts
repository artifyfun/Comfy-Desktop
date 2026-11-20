// @vitest-environment node
/**
 * 生成过程预览测试（对标建议 #5）。
 *
 * 关注点：ComfyUI WS 消息解析（b64_preview JSON / 旧版二进制 / prompt_id 跟踪）、
 * 帧节流与上限、自动关闭（超时/达上限）、PreviewHub 的按 promptId 缓存与容量淘汰。
 * 全部用注入的假 WebSocket + 假定时器——不需要真 ComfyUI。
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import {
  PreviewHub,
  binaryFrameToDataUrl,
  parsePreviewMessage,
  previewWsUrl,
  startPreviewFeed,
  type WebSocketLike
} from './previewFeed'

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

/** 可编程假 WebSocket */
class FakeWS implements WebSocketLike {
  static instances: FakeWS[] = []
  readyState = 1
  closed = false
  /** 记录客户端发出的消息（用于断言 feature_flags 握手） */
  sent: string[] = []
  /** 模拟运行时的默认值：'blob' */
  binaryType = 'blob'
  onopen: ((ev: unknown) => void) | null = null
  onmessage: ((ev: { data: unknown }) => void) | null = null
  onerror: ((ev: unknown) => void) | null = null
  onclose: ((ev: unknown) => void) | null = null
  constructor(public url: string) {
    FakeWS.instances.push(this)
  }
  close(): void {
    this.closed = true
    this.readyState = 3
  }
  send(data: string): void {
    this.sent.push(data)
  }
  /** 测试驱动：模拟连接建立 */
  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }
  /** 测试驱动：投递一条消息 */
  emit(data: unknown): void {
    this.onmessage?.({ data })
  }
}

const Ctor = FakeWS as unknown as new (url: string) => WebSocketLike

beforeEach(() => {
  FakeWS.instances.length = 0
})

afterEach(() => {
  vi.useRealTimers()
})

describe('previewWsUrl', () => {
  it('http → ws、https → wss，带 clientId 且编码特殊字符', () => {
    expect(previewWsUrl('http://127.0.0.1:8188', 'abc')).toBe('ws://127.0.0.1:8188/ws?clientId=abc')
    expect(previewWsUrl('https://comfy.example.com/', 'a b/c')).toBe(
      'wss://comfy.example.com/ws?clientId=a%20b%2Fc'
    )
  })

  it('多余尾斜杠不产生双斜杠', () => {
    expect(previewWsUrl('http://h:1///', 'x')).toBe('ws://h:1/ws?clientId=x')
  })
})

describe('binaryFrameToDataUrl', () => {
  it('JPEG magic → image/jpeg', () => {
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
    expect(binaryFrameToDataUrl(jpeg).startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('PNG magic → image/png', () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0])
    expect(binaryFrameToDataUrl(png).startsWith('data:image/png;base64,')).toBe(true)
  })

  it('内容可被解码回原字节', () => {
    const bytes = new Uint8Array([0xff, 0xd8, 0xff, 7, 8, 9])
    const b64 = binaryFrameToDataUrl(bytes).split(',')[1]!
    expect(Array.from(Buffer.from(b64, 'base64'))).toEqual([0xff, 0xd8, 0xff, 7, 8, 9])
  })

  // 真机校准（本机 ComfyUI server.py）：encode_bytes = struct.pack(">I", event)
  // + data；send_image 的 data = struct.pack(">I", type_num) + 图像字节
  // → 二进制 WS 帧前 8 字节是头（4B 事件号 + 4B 图像类型），图像从 offset 8 起
  it('ComfyUI 真实帧（8B 头）→ 剥头后 payload 精确等于图像字节', () => {
    const img = [0xff, 0xd8, 0xff, 0xe0, 9, 8, 7]
    const frame = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, ...img])
    const url = binaryFrameToDataUrl(frame)
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Array.from(Buffer.from(url.split(',')[1]!, 'base64'))).toEqual(img)
  })

  it('PNG 类型位 + PNG magic → image/png（同样剥头）', () => {
    const img = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]
    const frame = new Uint8Array([0, 0, 0, 1, 0, 0, 0, 2, ...img])
    const url = binaryFrameToDataUrl(frame)
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(Array.from(Buffer.from(url.split(',')[1]!, 'base64'))).toEqual(img)
  })

  // 真机（ComfyUI 0.34.6）：progress.py 推的是
  // PREVIEW_IMAGE_WITH_METADATA(4)，send_image_with_metadata 拼的是
  // [4B 事件=4][4B 元数据长度][元数据 JSON][图像字节]
  it('真机新格式（事件4 + 元数据前缀）→ 精确剥出图像字节', () => {
    const meta = Buffer.from(
      JSON.stringify({ node_id: '7', prompt_id: 'p', image_type: 'image/jpeg' }),
      'utf8'
    )
    const img = [0xff, 0xd8, 0xff, 0xe0, 0x11, 0x22, 0x33]
    const frame = new Uint8Array([
      0,
      0,
      0,
      4,
      (meta.length >>> 24) & 0xff,
      (meta.length >>> 16) & 0xff,
      (meta.length >>> 8) & 0xff,
      meta.length & 0xff,
      ...meta,
      ...img
    ])
    const url = binaryFrameToDataUrl(frame)
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(Array.from(Buffer.from(url.split(',')[1]!, 'base64'))).toEqual(img)
  })

  it('新格式 PNG 同样精确剥出', () => {
    const meta = Buffer.from(JSON.stringify({ image_type: 'image/png' }), 'utf8')
    const img = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
    const frame = new Uint8Array([0, 0, 0, 4, 0, 0, 0, meta.length, ...meta, ...img])
    const url = binaryFrameToDataUrl(frame)
    expect(url.startsWith('data:image/png;base64,')).toBe(true)
    expect(Array.from(Buffer.from(url.split(',')[1]!, 'base64'))).toEqual(img)
  })

  it('元数据长度越界（损坏帧）→ 空串，不瞎猜', () => {
    // 声明元数据 1MB，实际只有几字节
    const frame = new Uint8Array([0, 0, 0, 4, 0, 16, 0, 0, 0x89, 0x50, 0x4e, 0x47])
    expect(binaryFrameToDataUrl(frame)).toBe('')
  })

  it('无图像 magic 的二进制事件 → 空串（宁可不出帧也不推坏图）', () => {
    expect(binaryFrameToDataUrl(new Uint8Array([0, 0, 0, 9, 1, 2, 3, 4]))).toBe('')
    expect(binaryFrameToDataUrl(new Uint8Array([]))).toBe('')
  })
})

describe('parsePreviewMessage', () => {
  it('b64_preview JSON → 帧（补 data URL 前缀）', () => {
    const msg = JSON.stringify({ type: 'b64_preview', data: { image: 'AAAA', nodeId: '3' } })
    expect(parsePreviewMessage(msg, 'p1')).toEqual({
      promptId: 'p1',
      dataUrl: 'data:image/jpeg;base64,AAAA'
    })
  })

  it('旧版 preview 类型同样识别', () => {
    const msg = JSON.stringify({ type: 'preview', data: { image: 'BBBB' } })
    expect(parsePreviewMessage(msg, 'p1')?.dataUrl).toBe('data:image/jpeg;base64,BBBB')
  })

  it('已是 data URL 的 image 原样透传（不重复加前缀）', () => {
    const msg = JSON.stringify({ type: 'b64_preview', data: { image: 'data:image/png;base64,CC' } })
    expect(parsePreviewMessage(msg, 'p1')?.dataUrl).toBe('data:image/png;base64,CC')
  })

  it('帧自带 prompt_id 时优先用消息里的（多任务并行不串号）', () => {
    const msg = JSON.stringify({ type: 'b64_preview', data: { image: 'X', prompt_id: 'p-real' } })
    expect(parsePreviewMessage(msg, 'p-fallback')?.promptId).toBe('p-real')
  })

  it('非预览消息 → null，但 prompt_id 变化经回调上报', () => {
    const seen: string[] = []
    const msg = JSON.stringify({ type: 'executing', data: { node: 5, prompt_id: 'p-9' } })
    expect(parsePreviewMessage(msg, 'p0', (id) => seen.push(id))).toBeNull()
    expect(seen).toEqual(['p-9'])
  })

  it('二进制帧 → 帧（用 fallback prompt_id）', () => {
    const buf = new Uint8Array([0xff, 0xd8, 0xff, 1, 2]).buffer
    const parsed = parsePreviewMessage(buf, 'p-abc')
    expect(parsed?.promptId).toBe('p-abc')
    expect(parsed?.dataUrl.startsWith('data:image/jpeg;base64,')).toBe(true)
  })

  it('畸形输入一律 null（不抛错）', () => {
    expect(parsePreviewMessage('not json', 'p')).toBeNull()
    expect(parsePreviewMessage('{"type":"status"}', 'p')).toBeNull()
    expect(parsePreviewMessage(JSON.stringify({ type: 'b64_preview', data: {} }), 'p')).toBeNull()
    expect(
      parsePreviewMessage(JSON.stringify({ type: 'b64_preview', data: { image: '' } }), 'p')
    ).toBeNull()
    expect(parsePreviewMessage(123, 'p')).toBeNull()
    // 非预览二进制事件（无图像 magic）：丢弃而非推出解不开的帧
    expect(parsePreviewMessage(new Uint8Array([0, 0, 0, 9, 1, 2, 3, 4]).buffer, 'p')).toBeNull()
    expect(parsePreviewMessage(new Uint8Array(0).buffer, 'p')).toBeNull()
  })
})

describe('startPreviewFeed', () => {
  const base = (onFrame: (f: { promptId: string; dataUrl: string; at: number }) => void) => ({
    origin: 'http://127.0.0.1:8188',
    clientId: 'cid-1',
    promptId: 'p1',
    onFrame,
    WebSocketCtor: Ctor,
    minIntervalMs: 400
  })

  it('连接 URL 带 clientId；预览帧经节流后回调', () => {
    const frames: Array<{ dataUrl: string }> = []
    const feed = startPreviewFeed(base((f) => frames.push(f)))
    expect(FakeWS.instances[0]!.url).toBe('ws://127.0.0.1:8188/ws?clientId=cid-1')

    FakeWS.instances[0]!.emit(JSON.stringify({ type: 'b64_preview', data: { image: 'A' } }))
    expect(frames).toHaveLength(1)
    expect(frames[0]!.dataUrl).toBe('data:image/jpeg;base64,A')
    expect(feed.stats.frames).toBe(1)
    feed.stop()
  })

  // 真机前提：不声明 supports_preview_metadata 时 ComfyUI 一帧都不推（progress.py
  // 的 feature_flags.supports_feature 门），且必须是本连接的第一条消息（server.py
  // 的 first_message）。这条断言锁住"最容易被删掉但删了就静默零帧"的那一行。
  it('onopen 立即发 feature_flags 能力协商（含 supports_preview_metadata）', () => {
    const feed = startPreviewFeed(base(() => {}))
    const ws = FakeWS.instances[0]!
    expect(ws.sent).toHaveLength(0)
    ws.open()
    expect(ws.sent).toHaveLength(1)
    expect(JSON.parse(ws.sent[0]!)).toEqual({
      type: 'feature_flags',
      data: { supports_preview_metadata: true }
    })
    feed.stop()
  })

  it('已 stop 后 onopen 不再发协商（连接已关，发送无意义）', () => {
    const feed = startPreviewFeed(base(() => {}))
    const ws = FakeWS.instances[0]!
    feed.stop()
    ws.open()
    expect(ws.sent).toHaveLength(0)
  })

  // 真机前提：binaryType 默认 'blob'，不改会以 Blob 交付 → 解析器认不出 → 静默 0 帧
  it('建连后立即把 binaryType 置为 arraybuffer', () => {
    const feed = startPreviewFeed(base(() => {}))
    expect(FakeWS.instances[0]!.binaryType).toBe('arraybuffer')
    feed.stop()
  })

  it('binaryType 被运行时忽略时，Blob 交付的帧仍能解析（兜底）', async () => {
    const frames: string[] = []
    const feed = startPreviewFeed(base((f) => frames.push(f.dataUrl)))
    const ws = FakeWS.instances[0]!
    // 真机新格式帧：[4B 事件=4][4B 元数据长度][元数据][图像]
    const meta = Buffer.from(JSON.stringify({ node_id: '7' }), 'utf8')
    const img = [0xff, 0xd8, 0xff, 0xe0, 0x42]
    const frame = new Uint8Array([0, 0, 0, 4, 0, 0, 0, meta.length, ...meta, ...img])
    ws.emit(new Blob([frame]))
    await new Promise((r) => setTimeout(r, 20))
    expect(frames).toHaveLength(1)
    expect(Array.from(Buffer.from(frames[0]!.split(',')[1]!, 'base64'))).toEqual(img)
    feed.stop()
  })

  it('send 抛错不影响采集（握手失败降级，不中断 feed）', () => {
    const frames: string[] = []
    const feed = startPreviewFeed(base((f) => frames.push(f.dataUrl)))
    const ws = FakeWS.instances[0]!
    ws.send = () => {
      throw new Error('socket not open')
    }
    expect(() => ws.open()).not.toThrow()
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: 'B' } }))
    expect(frames).toEqual(['data:image/jpeg;base64,B'])
    feed.stop()
  })

  it('节流：间隔不足的帧被丢弃并计数，时间推进后恢复下发', () => {
    vi.useFakeTimers()
    const frames: string[] = []
    const feed = startPreviewFeed(base((f) => frames.push(f.dataUrl)))
    const ws = FakeWS.instances[0]!

    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '1' } })) // 首帧（-Infinity 基线）
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '2' } })) // 同刻 → 丢
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '3' } })) // 同刻 → 丢
    expect(frames).toEqual(['data:image/jpeg;base64,1'])
    expect(feed.stats.dropped).toBe(2)

    vi.advanceTimersByTime(500)
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '4' } }))
    expect(frames).toEqual(['data:image/jpeg;base64,1', 'data:image/jpeg;base64,4'])
    expect(feed.stats.dropped).toBe(2)
    feed.stop()
  })

  it('prompt_id 经 executing 消息跟踪（后续无 id 的帧归属正确）', () => {
    const got: string[] = []
    const feed = startPreviewFeed(base((f) => got.push(f.promptId)))
    const ws = FakeWS.instances[0]!

    ws.emit(JSON.stringify({ type: 'executing', data: { node: 1, prompt_id: 'p-live' } }))
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: 'A' } }))
    expect(got).toEqual(['p-live'])
    feed.stop()
  })

  it('达到 maxFrames 自动关闭（不再接收）', () => {
    vi.useFakeTimers()
    const frames: string[] = []
    const feed = startPreviewFeed({ ...base((f) => frames.push(f.dataUrl)), maxFrames: 2 })
    const ws = FakeWS.instances[0]!

    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '1' } }))
    vi.advanceTimersByTime(500)
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '2' } }))
    expect(feed.closed).toBe(true)
    expect(ws.closed).toBe(true)

    vi.advanceTimersByTime(500)
    ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: '3' } }))
    expect(frames).toHaveLength(2)
  })

  it('超时自动关闭（长任务兜底不泄漏连接）', () => {
    vi.useFakeTimers()
    const feed = startPreviewFeed({ ...base(() => {}), timeoutMs: 5_000 })
    const ws = FakeWS.instances[0]!
    expect(feed.closed).toBe(false)

    vi.advanceTimersByTime(5_000)
    expect(feed.closed).toBe(true)
    expect(ws.closed).toBe(true)
  })

  it('stop 幂等：重复调用不抛错，连接只关一次', () => {
    const feed = startPreviewFeed(base(() => {}))
    const ws = FakeWS.instances[0]!
    feed.stop()
    expect(ws.closed).toBe(true)
    expect(() => feed.stop()).not.toThrow()
    expect(feed.closed).toBe(true)
  })

  it('onFrame 抛错不影响采集（隔离回调异常）', () => {
    vi.useFakeTimers()
    let calls = 0
    const feed = startPreviewFeed({
      ...base(() => {
        calls++
        throw new Error('consumer boom')
      })
    })
    const ws = FakeWS.instances[0]!
    expect(() =>
      ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: 'A' } }))
    ).not.toThrow()
    vi.advanceTimersByTime(500)
    expect(() =>
      ws.emit(JSON.stringify({ type: 'b64_preview', data: { image: 'B' } }))
    ).not.toThrow()
    expect(calls).toBe(2)
    expect(feed.stats.frames).toBe(2)
    feed.stop()
  })

  it('非预览消息不影响帧计数', () => {
    const feed = startPreviewFeed(base(() => {}))
    const ws = FakeWS.instances[0]!
    ws.emit(JSON.stringify({ type: 'status', data: {} }))
    ws.emit(JSON.stringify({ type: 'progress', data: { value: 3, max: 20 } }))
    expect(feed.stats.frames).toBe(0)
    expect(feed.stats.dropped).toBe(0)
    feed.stop()
  })

  it('无 WebSocket 运行时 → 返回 no-op handle（不抛错）', () => {
    // Node 22 自带全局 WebSocket，必须真把它摘掉才走降级分支
    const g = globalThis as { WebSocket?: unknown }
    const saved = g.WebSocket
    try {
      delete g.WebSocket
      const feed = startPreviewFeed({
        origin: 'http://127.0.0.1:8188',
        clientId: 'c',
        promptId: 'p',
        onFrame: () => {}
      })
      expect(feed.closed).toBe(true)
      expect(() => feed.stop()).not.toThrow()
    } finally {
      g.WebSocket = saved
    }
  })
})

describe('PreviewHub', () => {
  it('set/get 往返；未命中 undefined', () => {
    const hub = new PreviewHub()
    hub.set('p1', 'data:image/jpeg;base64,A')
    expect(hub.get('p1')?.dataUrl).toBe('data:image/jpeg;base64,A')
    expect(hub.get('p2')).toBeUndefined()
  })

  it('空 promptId 或空帧被忽略（不污染缓存）', () => {
    const hub = new PreviewHub()
    hub.set('', 'x')
    hub.set('p1', '')
    expect(hub.size).toBe(0)
  })

  it('容量上限：超限淘汰最旧条目', () => {
    const hub = new PreviewHub(2)
    hub.set('p1', 'a')
    hub.set('p2', 'b')
    hub.set('p3', 'c')
    expect(hub.size).toBe(2)
    expect(hub.get('p1')).toBeUndefined()
    expect(hub.get('p3')?.dataUrl).toBe('c')
  })

  it('重复 set 同 key 提升为最近使用（不被误淘汰）', () => {
    const hub = new PreviewHub(2)
    hub.set('p1', 'a')
    hub.set('p2', 'b')
    hub.set('p1', 'a2')
    hub.set('p3', 'c')
    expect(hub.get('p1')?.dataUrl).toBe('a2')
    expect(hub.get('p2')).toBeUndefined()
  })

  it('clear / clearAll', () => {
    const hub = new PreviewHub()
    hub.set('p1', 'a')
    hub.set('p2', 'b')
    hub.clear('p1')
    expect(hub.get('p1')).toBeUndefined()
    hub.clearAll()
    expect(hub.size).toBe(0)
  })
})
