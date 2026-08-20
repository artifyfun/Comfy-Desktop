/**
 * 批量任务全局 store：任何页面共享的常驻任务状态。
 *
 * 提交（batch 页）→ main 进程 batchRunner 执行 → 此处 2s 轮询
 * /api/batch/status 同步进度，全局浮层与批量页监控视图都从这里读。
 */
import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { useAppStore } from './appStore'

export const useBatchTaskStore = defineStore('batchTask', () => {
  const appStore = useAppStore()
  const status = ref(null) // BatchStatus | null
  const polling = ref(false)
  let timer = null

  const isRunning = computed(() => status.value?.status === 'running')
  const percent = computed(() => status.value?.percent ?? 0)

  const api = (path) => `${appStore.config?.serverHost || ''}${path}`

  async function fetchStatus() {
    try {
      const res = await fetch(api('/api/batch/status'))
      const json = await res.json()
      status.value = json?.data ?? null
    } catch {
      /* server 暂不可达时保留上次状态 */
    }
  }

  /** 有运行中任务时轮询；停止后补拉一次终态再停 */
  function startPolling() {
    if (polling.value) return
    polling.value = true
    timer = setInterval(async () => {
      await fetchStatus()
      if (status.value && status.value.status !== 'running') {
        stopPolling()
      }
    }, 2000)
  }

  function stopPolling() {
    polling.value = false
    if (timer) clearInterval(timer)
    timer = null
  }

  /** 提交批量任务到 main 进程（fire-and-forget） */
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
    status.value = json.data
    startPolling()
    return json.data
  }

  async function stop() {
    const res = await fetch(api('/api/batch/stop'), { method: 'POST' })
    const json = await res.json().catch(() => ({}))
    if (json?.data) status.value = json.data
    stopPolling()
  }

  return { status, isRunning, percent, polling, fetchStatus, startPolling, stopPolling, submit, stop }
})
