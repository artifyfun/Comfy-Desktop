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
import localforage from 'localforage'

export const useBatchTaskStore = defineStore('batchTask', () => {
  const appStore = useAppStore()
  /** 全量队列（BatchJob[]，后端序：入队顺序） */
  const queue = ref([])
  /** 队列是否暂停（重启恢复后等待人工继续） */
  const paused = ref(false)
  const polling = ref(false)
  let timer = null

  /**
   * 队列级配置（浮层/详情页/批量页共用，localforage 持久化为默认值）：
   * autoShutdown 运行完成后关机；notifyEnabled + notifyUrl 完成后手机通知。
   * 变更即通过 /api/batch/config 应用到后端（对排队中/运行中任务即时生效）。
   */
  const QUEUE_CONFIG_KEY = 'batch/queue-config'
  const queueConfig = ref({ autoShutdown: false, notifyEnabled: false, notifyUrl: '' })

  /** 当前运行任务（兼容旧 status 字段）；无运行时取暂停任务（保留进度展示） */
  const status = computed(
    () =>
      queue.value.find((j) => j.status === 'running') ??
      queue.value.find((j) => j.status === 'paused') ??
      null
  )
  const isRunning = computed(() => !!queue.value.find((j) => j.status === 'running'))
  /** 当前被暂停的任务 */
  const pausedJob = computed(() => queue.value.find((j) => j.status === 'paused') ?? null)
  /** 等待中的任务数 */
  const queuedCount = computed(() => queue.value.filter((j) => j.status === 'queued').length)
  /** 有活跃任务（排队/运行/暂停），用于浮层可见性与轮询 */
  const hasActive = computed(
    () =>
      queuedCount.value > 0 ||
      !!queue.value.find((j) => j.status === 'running' || j.status === 'paused')
  )
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

  /** 有排队/运行/暂停任务时轮询；全部终态后补拉一次再停 */
  function startPolling() {
    if (polling.value) return
    polling.value = true
    timer = setInterval(async () => {
      await fetchQueue()
      const alive = queue.value.some((j) =>
        ['queued', 'running', 'paused'].includes(j.status)
      )
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

  /** 删除任意任务（含终态记录）；运行中任务请先停止/暂停 */
  async function deleteJob(id) {
    const res = await fetch(api('/api/batch/delete'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  /** 重新运行已结束任务：完整复刻原配置重新入队（无需重新编排队列） */
  async function rerunJob(id) {
    const res = await fetch(api('/api/batch/rerun'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    const json = await res.json().catch(() => ({}))
    if (!res.ok || !json?.success) {
      throw new Error(json?.message || `batch rerun http ${res.status}`)
    }
    if (Array.isArray(json?.data?.queue)) queue.value = json.data.queue
    startPolling()
    return json.data
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

  /** 暂停当前运行任务（保留进度，可继续）；id 缺省 = 当前运行任务 */
  async function pauseJob(id) {
    const res = await fetch(api('/api/batch/pause'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(id ? { id } : {})
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  /** 继续执行已暂停任务 */
  async function resumeJob(id) {
    const res = await fetch(api('/api/batch/job-resume'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id })
    })
    await res.json().catch(() => ({}))
    await fetchQueue()
  }

  // ---------- 队列级配置（关机/通知） ----------

  /** 从 localforage 读取上次保存的队列配置（UI 初始值） */
  async function loadQueueConfig() {
    try {
      const cfg = (await localforage.getItem(QUEUE_CONFIG_KEY)) || {}
      queueConfig.value = {
        autoShutdown: !!cfg.autoShutdown,
        notifyEnabled: !!cfg.notifyEnabled,
        notifyUrl: String(cfg.notifyUrl || '')
      }
    } catch {
      /* ignore */
    }
  }

  /** 本地持久化当前配置（作为新任务的默认值） */
  async function saveQueueConfig() {
    try {
      await localforage.setItem(QUEUE_CONFIG_KEY, {
        autoShutdown: queueConfig.value.autoShutdown,
        notifyEnabled: queueConfig.value.notifyEnabled,
        notifyUrl: queueConfig.value.notifyUrl
      })
    } catch {
      /* ignore */
    }
  }

  /** 合并局部更新到队列配置（不触发后端） */
  function setQueueConfig(patch) {
    if (typeof patch.autoShutdown === 'boolean') {
      queueConfig.value.autoShutdown = patch.autoShutdown
    }
    if (typeof patch.notifyEnabled === 'boolean') {
      queueConfig.value.notifyEnabled = patch.notifyEnabled
    }
    if (typeof patch.notifyUrl === 'string') {
      queueConfig.value.notifyUrl = patch.notifyUrl
    }
  }

  /** 应用队列配置到后端（对排队中/运行中任务即时生效）+ 持久化本机默认 */
  async function applyQueueConfig() {
    const payload = {
      autoShutdown: queueConfig.value.autoShutdown,
      notifyUrl: queueConfig.value.notifyEnabled ? queueConfig.value.notifyUrl.trim() : ''
    }
    try {
      const res = await fetch(api('/api/batch/config'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      await res.json().catch(() => ({}))
    } catch {
      /* server 暂不可达时保留本地状态，下次提交仍会带上 */
    }
    await saveQueueConfig()
    await fetchQueue()
  }

  return {
    queue,
    paused,
    status,
    isRunning,
    pausedJob,
    hasActive,
    queuedCount,
    percent,
    polling,
    queueConfig,
    fetchQueue,
    fetchStatus,
    startPolling,
    stopPolling,
    submit,
    resume,
    stop,
    stopAll,
    cancel,
    deleteJob,
    rerunJob,
    clearFinished,
    moveTop,
    pauseJob,
    resumeJob,
    loadQueueConfig,
    saveQueueConfig,
    setQueueConfig,
    applyQueueConfig
  }
})
