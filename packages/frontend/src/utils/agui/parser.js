// utils/agui/parser.js — AG-UI SSE 分帧解析器（C8，蓝本：waa services/agui/parser.js）
//
// 移植自 web_ai_assistant 同名文件，逻辑原样保留：
// - buffer 跨 chunk 拼接 + dataLine 累积 + 空行 = 事件边界
// - 兼容 event:/keepalive（`:` 开头注释）行
// - 畸形 JSON 忽略并计数（malformedCount，不抛异常）
// - AG-UI 帧格式：无 event: 行，类型在 JSON 的 type 字段内
//   （`data: {"type":"TEXT_MESSAGE_CONTENT",...}\n\n`）
//
// 接口：createParser() → { feed(chunk)→Event[], flush()→Event[], malformedCount }
// 纯函数：输入字符串，输出 { type, ...payload }[]，无 DOM/Vue/Pinia 依赖。

export function createParser() {
  let buffer = ''
  let dataLine = ''
  let lastEventName = '' // event: 行值，作为 data JSON 缺 type 时的回退
  let malformed = 0 // 畸形 JSON 诊断计数（不抛）

  function flushDataLine() {
    if (!dataLine) return null
    try {
      const ev = JSON.parse(dataLine)
      dataLine = ''
      // AG-UI type 字段优先；data JSON 缺 type 时回退到 event: 行
      if (!ev.type && lastEventName) {
        ev.type = lastEventName
      }
      lastEventName = ''
      return ev
    } catch {
      malformed += 1
      dataLine = ''
      lastEventName = ''
      return null
    }
  }

  return {
    // feed — 输入文本块，返回该 chunk 内完整解析的事件数组
    feed(chunk) {
      const events = []
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() || '' // 最后一行可能不完整，留到下次

      for (const line of lines) {
        // 空行 / keepalive 注释行（: 开头）→ 事件边界
        if (line === '' || line.startsWith(':')) {
          const ev = flushDataLine()
          if (ev) events.push(ev)
          lastEventName = ''
          continue
        }
        if (line.startsWith('event:')) {
          // 防御：无空行分隔时先 flush 上一个事件
          const ev = flushDataLine()
          if (ev) events.push(ev)
          lastEventName = line.startsWith('event: ') ? line.slice(7).trim() : line.slice(6).trim()
          continue
        }
        if (line.startsWith('data:')) {
          // 防御：多个 data: 行未以空行分隔时先 flush 前一个
          const ev = flushDataLine()
          if (ev) events.push(ev)
          dataLine = line.startsWith('data: ') ? line.slice(6) : line.slice(5)
        }
      }

      return events
    },

    // flush — 流结束时调用，清空未完成的 buffer + dataLine（尾包无 `\n\n` 结尾的场景）
    flush() {
      const events = []
      if (buffer && buffer.startsWith('data:')) {
        dataLine = buffer.startsWith('data: ') ? buffer.slice(6) : buffer.slice(5)
        buffer = ''
      }
      const ev = flushDataLine()
      if (ev) events.push(ev)
      return events
    },

    // 畸形 JSON 累计计数（诊断用，streamReader 可上报）
    get malformedCount() {
      return malformed
    },
  }
}

export default createParser
