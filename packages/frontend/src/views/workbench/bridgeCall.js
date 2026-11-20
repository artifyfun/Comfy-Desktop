/**
 * 工作台 iframe → 注入桥的请求/ack 通道（artify:* 协议的 A 侧 adapter）。
 *
 * 收口此前散在 index.vue 的三份平行实现（ops 确认 / 模板同步 / 画布执行）：
 * requestId 关联、超时兜底、listener 清理统一在此持有——调用方一行 await。
 *
 * 语义：永不 reject。成功 resolve ack 数据（含 ok:true 字段的原文）；
 * 超时/发送失败 resolve { ok:false, error }。需要 throw 语义的调用方自行包一层。
 */
import { ARTIFY_ACK_OF } from '@/inject/protocol.js'

let seq = 0

/**
 * 发一条需 ack 的桥消息。
 * @param {string} type ARTIFY_MSG 里的请求类型（必须是 ARTIFY_ACK_OF 的键）
 * @param {object} payload 除 type/requestId 外的字段
 * @param {{timeout?: number}} [opts] 超时毫秒数，默认 8000
 * @returns {Promise<object>} ack 数据或 { ok:false, error }
 */
export function callBridge(type, payload = {}, opts = {}) {
  const ackType = ARTIFY_ACK_OF[type]
  if (!ackType) {
    return Promise.resolve({ ok: false, error: `unknown bridge request type: ${type}` })
  }
  const timeout = opts.timeout ?? 8000
  const requestId = `br-${Date.now()}-${++seq}`
  return new Promise((resolve) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', onAck)
      clearTimeout(timer)
      resolve(value)
    }
    function onAck(event) {
      let data = event.data
      if (typeof data === 'string') {
        try {
          data = JSON.parse(data)
        } catch {
          return
        }
      }
      if (data && data.type === ackType && data.requestId === requestId) finish(data)
    }
    const timer = setTimeout(() => finish({ ok: false, error: 'bridge timeout' }), timeout)
    window.addEventListener('message', onAck)
    try {
      window.parent.postMessage(JSON.stringify({ type, requestId, ...payload }), '*')
    } catch (e) {
      finish({ ok: false, error: String(e).slice(0, 120) })
    }
  })
}
