// utils/agui/__tests__/parser.test.js — SSE 分帧解析测试（C8 验收，用例思路对齐 waa parser.test.js）
// 覆盖：单帧完整 / 跨 chunk 碎片 / 粘包多事件 / 尾包 flush / malformed 计数 /
//        keepalive 注释 / event: 行回退 / type 字段优先 / 多 data: 行 / 空 feed
import { describe, expect, it } from 'vitest'
import { createParser } from '../parser'

const frame = (event) => `data: ${JSON.stringify(event)}\n\n`

describe('agui/parser — SSE 分帧', () => {
  it('单帧完整事件：data JSON 的 type 字段', () => {
    const p = createParser()
    const evs = p.feed('data: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('TEXT_MESSAGE_CONTENT')
    expect(evs[0].delta).toBe('hi')
  })

  it('跨 chunk 碎片拼接：一个事件被切成两块', () => {
    const p = createParser()
    expect(p.feed('data: {"type":"RUN_START')).toHaveLength(0)
    const evs = p.feed('ED","runId":"r1"}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('RUN_STARTED')
    expect(evs[0].runId).toBe('r1')
  })

  it('跨 chunk 切在 `\n\n` 中间也不丢事件', () => {
    const p = createParser()
    expect(p.feed(frame({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }) + '\n')).toHaveLength(1)
    const evs = p.feed('\n' + frame({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }))
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('RUN_FINISHED')
  })

  it('粘包：一个 chunk 含多个事件', () => {
    const p = createParser()
    const chunk =
      frame({ type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' }) +
      frame({ type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'abc' }) +
      frame({ type: 'TEXT_MESSAGE_END', messageId: 'm1' })
    const evs = p.feed(chunk)
    expect(evs).toHaveLength(3)
    expect(evs.map((e) => e.type)).toEqual(['TEXT_MESSAGE_START', 'TEXT_MESSAGE_CONTENT', 'TEXT_MESSAGE_END'])
  })

  it('畸形 JSON 忽略 + 计数（不抛异常）', () => {
    const p = createParser()
    const evs = p.feed('data: {not json}\n\n')
    expect(evs).toHaveLength(0)
    expect(p.malformedCount).toBe(1)
    // 后续正常帧不受影响
    expect(p.feed(frame({ type: 'RUN_STARTED', threadId: 't', runId: 'r' }))).toHaveLength(1)
    expect(p.malformedCount).toBe(1)
  })

  it('malformed 跨 chunk 累计', () => {
    const p = createParser()
    p.feed('data: {bad}\n\n')
    p.feed('data: [broken\n\n')
    expect(p.malformedCount).toBe(2)
  })

  it('keepalive 注释行（: 开头）不产出事件', () => {
    const p = createParser()
    const evs = p.feed(': keepalive\n\n')
    expect(evs).toHaveLength(0)
    // 混在事件流中间的 keepalive 也不干扰
    const evs2 = p.feed(frame({ type: 'CUSTOM', name: 'keepalive' }) + ': ping\n\n' + frame({ type: 'RUN_FINISHED', threadId: 't', runId: 'r' }))
    expect(evs2).toHaveLength(2)
  })

  it('flush 尾包：未以空行结尾的残留 data 被补产出', () => {
    const p = createParser()
    p.feed('data: {"type":"RUN_FINISHED"}')
    const evs = p.flush()
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('RUN_FINISHED')
  })

  it('flush 后再 flush 为空（不重复产出）', () => {
    const p = createParser()
    p.feed('data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}')
    expect(p.flush()).toHaveLength(1)
    expect(p.flush()).toHaveLength(0)
  })

  it('flush 尾包畸形 JSON 同样计数', () => {
    const p = createParser()
    p.feed('data: {trunc')
    expect(p.flush()).toHaveLength(0)
    expect(p.malformedCount).toBe(1)
  })

  it('event: 行作为 data JSON 缺 type 时的回退', () => {
    const p = createParser()
    const evs = p.feed('event: STATE_DELTA\ndata: {"delta":[]}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('STATE_DELTA')
  })

  it('data JSON 的 type 优先于 event: 行', () => {
    const p = createParser()
    const evs = p.feed('event: FALLBACK\ndata: {"type":"TEXT_MESSAGE_CONTENT"}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('TEXT_MESSAGE_CONTENT')
  })

  it('多个 data: 行未以空行分隔：各自成事件（防御）', () => {
    const p = createParser()
    const evs = p.feed('data: {"type":"RUN_STARTED","threadId":"t","runId":"r"}\ndata: {"type":"RUN_FINISHED","threadId":"t","runId":"r"}\n\n')
    expect(evs).toHaveLength(2)
    expect(evs[0].type).toBe('RUN_STARTED')
    expect(evs[1].type).toBe('RUN_FINISHED')
  })

  it('data: 无空格（紧凑写法）同样解析', () => {
    const p = createParser()
    const evs = p.feed('data:{"type":"RUN_STARTED","threadId":"t","runId":"r"}\n\n')
    expect(evs).toHaveLength(1)
    expect(evs[0].type).toBe('RUN_STARTED')
  })

  it('空字符串 feed 安全', () => {
    const p = createParser()
    expect(p.feed('')).toHaveLength(0)
    expect(p.flush()).toHaveLength(0)
  })

  it('与后端 encodeSseFrame 契约互认（C1 帧格式端到端）', async () => {
    // 不 import 后端 TS；这里内联同款帧格式断言：data 单行 JSON + \n\n，无 event: 行
    const event = { type: 'TOOL_CALL_START', timestamp: 1, toolCallId: 'c1', toolCallName: 'wb_x' }
    const p = createParser()
    const evs = p.feed(`data: ${JSON.stringify(event)}\n\n`)
    expect(evs).toHaveLength(1)
    expect(evs[0]).toEqual(event)
  })
})
