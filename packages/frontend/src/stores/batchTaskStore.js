/**
 * 批量任务全局 store：任何页面共享的常驻队列状态。
 *
 * 提交（batch 页）→ main 进程 batchRunner 队列引擎 → 此处 2s 轮询
 * /api/batch/queue 同步全量队列，全局浮层与批量页队列面板都从这里读。
 *
 * 兼容旧字段：status（= 当前运行任务投影）、isRunning、percent，旧组件零改动。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './appStore'

export const useBatchTaskStore = defineStore('batchTask', () => {
  const appStore = useAppStore()
  /** 全量队列（BatchJob[]，后端序：入队顺序） */
  const queue = ref([])
  /** 队列是否暂停（重启恢复后等待人工继续） */
  const paused = ref(false)
  const polling = ref(false)
  let timer = null

  /** 当前运行任务（兼容旧 status 字段） */
  const status = computed(() => queue.value.find((j) => j.status === 'running') ?? null)
  const isRunning = computed(() => !!status.value)
  /** 等待中的任务数 */
  const queuedCount = computed(() => queue.value.filter((j) => j.status === 'queued').length)
  const percent = computed(() => status.value?.percent ?? 0)

  const api = (path) => `${appStore.config?.serverHost || ''}${path}`

  async function fetchQueue() {
    try {
      const res = await fetch(api('/api/batch/queue'))
      const json = await res.json()
      const jobs = json?.data?.jobs
      if (Array.isArray(jobs)) queue.value = jobs
      if (typeof json?.data?.paused === 'boolean') paused.value = json.data.paused
    } catch {
      /* server 暂不可达时保留上次状态 */
    }
  }

  async function fetchStatus() {
    try {
      const res = await fetch(api('/api/batch/status'))
      const json = await res.json()
      const s = json?.data ?? null
      if (s) {
        // /status 只返回运行任务；把它的进度合并进本地队列对应项
        const idx = queue.value.findIndex((j) => j.id === s.id)
        if (idx >= 0) queue.value[idx] = { ...queue.value[idx], ...s }
        else queue.value = [s, ...queue.value]
      } else if (queue.value.some((j) => j.status === 'running')) {
        // 运行任务消失了（如 ComfyUI 重启）→ 重新拉全量
        await fetchQueue()
      }
    } catch {
      /* ignore */
    }
  }

  /** 有排队/运行任务时轮询；全部终态后补拉一次再停 */
  function startPolling() {
    if (polling.value) return
    polling.value = true
    timer = setInterval(async () => {
      await fetchQueue()
      const alive = queue.value.some((j) => j.status === 'queued' || j.status === 'running')
      if (!alive) stopPolling()
    }, 2000)
  }

  function stopPolling() {
    polling.value = false
    if (timer) clearInterval(timer)
    timer = null
  }

  /** 提交批量任务到 main 进程（入队，fire-and-forget）；返回 { jobId, queue } */
  async function submit(payload) {
    const res = await fetch(api('/api/batch/start'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    })
    const json = await res.json()
    if (!res.ok || !json?.success) {
      throw new Error(json?.message || `batch start http ${res.status}`)
    }
    const data = json.data
    if (Array.isArray(data?.queue)) queue.value = data.queue
    startPolling()
    return data
  }

  /** 人工继续执行队列（重启恢复后排队任务保持暂停，需用户点击恢复） */
  async function resume() {
    const res = await fetch(api('/api/batch/resume'), { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (json?.data?.paused === false) paused.value = false
    if (Array.isArray(json?.data?.jobs)) queue.value = json.data.jobs
    startPolling()
  }

  /** 停止当前运行任务（排队任务继续） */
  async function stop() {
    const res = await fetch(api('/api/batch/stop'), { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (json?.data?.status) {
      const s = json.data
      const idx = queue.value.findIndex((j) => j.id === s.id)
      if (idx >= 0) queue.value[idx] = { ...queue.value[idx], ...s }
    }
    await fetchQueue()
  }

  /** 停止整个队列：中断当前 + 取消全部排队 */
  async function stopAll() {
    const res = await fetch(api('/api/batch/stop'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stopAll: true })
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  /** 取消单个任务（排队=移出；运行=停止） */
  async function cancel(id) {
    const res = await fetch(api('/api/batch/cancel'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  /** 清空已结束任务 */
  async function clearFinished() {
    const res = await fetch(api('/api/batch/clear'), { method: 'POST' })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  /** 排队任务置顶 */
  async function moveTop(id) {
    const res = await fetch(api('/api/batch/move'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, toTop: true })
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  return {
    queue,
    paused,
    status,
    isRunning,
    queuedCount,
    percent,
    polling,
    fetchQueue,
    fetchStatus,
    startPolling,
    stopPolling,
    submit,
    resume,
    stop,
    stopAll,
    cancel,
    clearFinished,
    moveTop
  }
})
