/**
 * AG-UI 会话 store（C9）：消费 C8 管线的结构化 emit 回调，维护扁平消息数组。
 *
 * 与现有 index.vue 的 messages.value 并行共存、按端点切换（迁移文档 C9）：
 * 新 AG-UI 端点走本 store，旧自造 SSE 端点走原逻辑，P3 迁移完成后才删旧路径。
 *
 * 数据形状（扁平消息，元素）：
 *   text      { id, kind:'text', role, text, threadId, createdAt }
 *   reasoning { id, kind:'reasoning', role, text, threadId, createdAt }
 *   tool      { id, kind:'tool', role:'tool', toolCallId, name, args, result, status, threadId, createdAt }
 *   custom    { id, kind:'custom', name, value, threadId, createdAt }
 *
 * 节流设计：text/reasoning 的 delta 先进 per-message 缓冲（pendingDelta），
 * 16ms 定时器统一 flush 到 state —— SSE 高频帧下避免每 delta 一次响应式赋值；
 * 消息 END / run 结束 / loadHistory 收尾强制 flush，保证最终数据完整（零丢失）。
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { readAguiStream } from '@/utils/agui/streamReader'
import { createHandlerContext, dispatch } from '@/utils/agui/handlers'
import { reassemble } from '@/utils/agui/historyReassembler'

const FLUSH_INTERVAL_MS = 16

export const useAguiSessionStore = defineStore('aguiSession', () => {
  /** 扁平消息数组（全部线程混排，按 createdAt/追加序） */
  const messages = ref([])
  /** threadId → messages 切片（同对象引用，支持并行会话） */
  const byThread = ref({})
  /** threadId → 是否生成中 */
  const generating = ref({})
  /** tokenUsage（STATE_DELTA /tokenUsage/* patch 应用结果） */
  const tokenUsage = ref(null)
  /** threadId → 最近一次错误消息（RUN_ERROR / 流读取失败） */
  const error = ref({})

  /** 某会话的消息切片（用法：store.activeMessages(threadId)） */
  const activeMessages = computed(() => (threadId) => byThread.value[threadId] || [])

  // ── delta 节流缓冲（模块内单定时器；keyed by messageId，双线程互不串写）──
  const pendingDelta = new Map() // messageId → { msg, text }
  let flushTimer = null

  function flushDeltas() {
    if (flushTimer != null) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    for (const buf of pendingDelta.values()) {
      if (buf.text) {
        buf.msg.text += buf.text
        buf.text = ''
      }
    }
    pendingDelta.clear()
  }

  function scheduleFlush() {
    if (flushTimer != null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flushDeltas()
    }, FLUSH_INTERVAL_MS)
  }

  // ── 消息构造 / 定位（kind+id 唯一；text/reasoning 按 messageId，tool 按 toolCallId）──

  function appendMessage(threadId, msg) {
    msg.threadId = threadId
    msg.createdAt = Date.now()
    messages.value.push(msg)
    if (!byThread.value[threadId]) byThread.value[threadId] = []
    byThread.value[threadId].push(msg)
    return msg
  }

  function findMessage(threadId, predicate) {
    const slice = byThread.value[threadId]
    if (!slice) return null
    for (let i = slice.length - 1; i >= 0; i -= 1) {
      if (predicate(slice[i])) return slice[i]
    }
    return null
  }

  function ensureTextMessage(threadId, kind, messageId, role) {
    let msg = findMessage(threadId, (m) => (m.kind === 'text' || m.kind === 'reasoning') && m.id === messageId)
    if (!msg) {
      msg = appendMessage(threadId, {
        id: messageId,
        kind,
        role: role || (kind === 'reasoning' ? 'reasoning' : 'assistant'),
        text: '',
      })
    }
    return msg
  }

  function ensureToolMessage(threadId, toolCallId, name) {
    let msg = findMessage(threadId, (m) => m.kind === 'tool' && m.toolCallId === toolCallId)
    if (!msg) {
      msg = appendMessage(threadId, {
        id: toolCallId,
        kind: 'tool',
        role: 'tool',
        toolCallId,
        name: name || '',
        args: '',
        result: null,
        status: 'running',
      })
    } else if (name && !msg.name) {
      msg.name = name
    }
    return msg
  }

  let customSeq = 0
  function appendCustomMessage(threadId, name, value) {
    customSeq += 1
    appendMessage(threadId, { id: `custom-${threadId}-${customSeq}`, kind: 'custom', name, value })
  }

  /** STATE_DELTA → tokenUsage：仅应用 /tokenUsage 与 /tokenUsage/* 路径的 patch */
  function applyTokenUsage(delta) {
    for (const op of delta) {
      if (!op || typeof op.path !== 'string') continue
      const m = op.path.match(/^\/tokenUsage(?:\/([\w-]+))?$/)
      if (!m) continue
      if (!tokenUsage.value) tokenUsage.value = {}
      if (!m[1]) {
        if (op.op !== 'remove' && op.value && typeof op.value === 'object') {
          tokenUsage.value = { ...op.value }
        }
      } else if (op.op === 'remove') {
        delete tokenUsage.value[m[1]]
      } else {
        tokenUsage.value[m[1]] = op.value
      }
    }
  }

  // ── emit 适配层：把 C8 handlers 的结构化回调写进 state ──

  function deltaToBuffer(threadId, kind, messageId, role, delta) {
    const msg = ensureTextMessage(threadId, kind, messageId, role)
    let buf = pendingDelta.get(messageId)
    if (!buf || buf.msg !== msg) {
      buf = { msg, text: '' }
      pendingDelta.set(messageId, buf)
    }
    buf.text += delta || ''
    scheduleFlush()
  }

  function makeEmit(threadId) {
    return (name, payload) => {
      switch (name) {
        case 'run:start':
          generating.value[threadId] = true
          break
        case 'run:finish':
          flushDeltas()
          generating.value[threadId] = false
          break
        case 'run:error':
          flushDeltas()
          error.value[threadId] = payload.message || 'unknown error'
          generating.value[threadId] = false
          break
        case 'text:start':
          ensureTextMessage(threadId, 'text', payload.messageId, payload.role)
          break
        case 'text:delta':
          deltaToBuffer(threadId, 'text', payload.messageId, payload.role, payload.delta)
          break
        case 'text:end':
          ensureTextMessage(threadId, 'text', payload.messageId, payload.role)
          flushDeltas()
          break
        case 'reasoning:start':
          ensureTextMessage(threadId, 'reasoning', payload.messageId, payload.role)
          break
        case 'reasoning:delta':
          deltaToBuffer(threadId, 'reasoning', payload.messageId, payload.role, payload.delta)
          break
        case 'reasoning:end':
          ensureTextMessage(threadId, 'reasoning', payload.messageId, payload.role)
          flushDeltas()
          break
        case 'tool:start':
          ensureToolMessage(threadId, payload.toolCallId, payload.name)
          break
        case 'tool:args': {
          const tool = ensureToolMessage(threadId, payload.toolCallId)
          tool.args = payload.args || ''
          break
        }
        case 'tool:result': {
          const tool = ensureToolMessage(threadId, payload.toolCallId)
          tool.result = payload.content
          tool.status = 'done'
          break
        }
        case 'state:delta':
          applyTokenUsage(payload.delta)
          break
        case 'custom':
          appendCustomMessage(threadId, payload.name, payload.value)
          break
        default:
          break
      }
    }
  }

  // ── actions ──

  /**
   * 绑定 AG-UI SSE 流（fetch Response）并消费到 state。
   * 内部用 streamReader + handlers；emit 回调写 state；返回 promise 流结束 resolve。
   * @param {string} threadId
   * @param {Response} response
   * @returns {Promise<{totalEvents:number, malformedCount:number}>}
   */
  async function bindStream(threadId, response) {
    const ctx = createHandlerContext(makeEmit(threadId))
    error.value[threadId] = null
    generating.value[threadId] = true
    try {
      return await readAguiStream(response, (ev) => dispatch(ctx, ev))
    } catch (err) {
      error.value[threadId] = (err && err.message) || String(err)
      throw err
    } finally {
      flushDeltas()
      generating.value[threadId] = false
    }
  }

  /**
   * 加载历史（B 线 /api/workbench/agent/threads/messages 的 records）。
   * 走 historyReassembler.reassemble → 同一 emit 管线重放；替换该 thread 现有消息。
   * @param {string} threadId
   * @param {Array<{runId, seq, eventType, content}>} records
   */
  function loadHistory(threadId, records) {
    reset(threadId)
    const emit = makeEmit(threadId)
    // 重放是同步干跑：reassemble 内部构造 handler ctx 并逐事件 dispatch → emit 写 state；
    // 结束后强制 flush 缓冲并落定生成态（历史行缺 RUN_FINISHED 时 generating 不悬挂）。
    const result = reassemble(records, emit)
    flushDeltas()
    generating.value[threadId] = false
    return result
  }

  /**
   * 重置某会话：清消息切片 / 生成态 / 错误 / 待 flush 缓冲。
   * @param {string} threadId
   */
  function reset(threadId) {
    messages.value = messages.value.filter((m) => m.threadId !== threadId)
    delete byThread.value[threadId]
    delete generating.value[threadId]
    delete error.value[threadId]
    for (const [key, buf] of pendingDelta) {
      if (buf.msg.threadId === threadId) pendingDelta.delete(key)
    }
    if (flushTimer != null && pendingDelta.size === 0) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
  }

  return {
    // state
    messages,
    byThread,
    generating,
    tokenUsage,
    error,
    // getters
    activeMessages,
    // actions
    bindStream,
    loadHistory,
    reset,
    // 诊断用（测试/调用方可手动触发 flush）
    flushDeltas,
  }
})

export default useAguiSessionStore
