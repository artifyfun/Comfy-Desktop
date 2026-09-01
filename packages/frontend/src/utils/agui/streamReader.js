// utils/agui/streamReader.js — ReadableStream 读取 + parser.feed + dispatch（C8，蓝本：waa 同名文件）
//
// 读取 fetch response.body（ReadableStream），逐 chunk 解码 → parser.feed → 逐事件 dispatch。
// 与 waa 的差异：dispatch 是调用方注入的简单函数 `(event) => void`（waa 是
// { dispatch, runContext } pipeline 对象 + dispatchBatch 批派发概念；本管线单会话内
// 逐事件直写 store，批量化交给 C9 的 16ms 节流，不需要 pipeline/batch）。
// 流结束 flush 尾包 + 返回诊断（totalEvents / malformedCount）。

import { createParser } from './parser.js'

/**
 * readAguiStream — 消费 AG-UI SSE 流
 * @param {Response} response fetch 返回（含 body.getReader()）
 * @param {(event: object) => void} dispatch 单事件派发函数
 * @param {{onChunk?: (info: {events: number, totalEvents: number}) => void}} [opts]
 *   - onChunk({events, totalEvents}) 性能诊断回调
 * @returns {Promise<{totalEvents: number, malformedCount: number}>}
 */
export async function readAguiStream(response, dispatch, opts = {}) {
  const parser = createParser()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const onChunk = opts.onChunk
  let totalEvents = 0

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    const text = decoder.decode(value, { stream: true })
    const events = parser.feed(text)
    for (const ev of events) {
      dispatch(ev)
    }
    totalEvents += events.length
    if (onChunk) onChunk({ events: events.length, totalEvents })
    // 不让帧 —— 每 chunk 处理瞬时完成（几字节 parse + dispatch），
    // 渲染批处理由 store 侧节流承担（C9）。
  }

  // flush 尾包（流末未以空行结尾的残留 data）
  const tail = parser.flush()
  for (const ev of tail) {
    dispatch(ev)
  }
  totalEvents += tail.length

  return { totalEvents, malformedCount: parser.malformedCount }
}

export default readAguiStream
