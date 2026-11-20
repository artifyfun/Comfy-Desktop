/**
 * 批量执行历史（localforage）——batch/index.vue 拆分（第一批①b）。
 *
 * 执行记录的增删改查与断点续跑恢复：historyKey 按 appId 隔离，
 * ensureHistoryLoaded 惰性加载 + 按 updatedAt 倒序；upsert 语义保留
 * lastIndexProcessed 修复（update.processed 已含跳过前缀，不再重复叠加）。
 * 依赖（currentApp/currentJobId/state 等）经 deps 注入。
 */
import { ref, computed } from 'vue'
import localforage from 'localforage'
import { showError, uuidv4 } from '@/utils'

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
}

/**
 * @param deps { currentApp, currentJobId, batchTaskStore, executionProgress,
 *               startFromIndex, state, selectedSourceType, directoryPath,
 *               fileFilter, uploadedFiles, jsonInput, batchData }
 */
export function useBatchHistory(deps) {
  const {
    currentApp,
    currentJobId,
    batchTaskStore,
    executionProgress,
    startFromIndex,
    state,
    selectedSourceType,
    directoryPath,
    fileFilter,
    uploadedFiles,
    jsonInput,
    batchData,
  } = deps

  const showHistoryDialog = ref(false)
  const historyRecords = ref([])
  const currentHistoryRecordId = ref(null)
  const historyLoadedKey = ref('')
  const historyKey = computed(() =>
    currentApp.value && currentApp.value.id ? `batch/history/${currentApp.value.id}` : '',
  )

  async function ensureHistoryLoaded() {
    if (!historyKey.value) {
      return
    }
    if (historyLoadedKey.value === historyKey.value && historyRecords.value.length) return
    try {
      const list = (await localforage.getItem(historyKey.value)) || []
      historyRecords.value = Array.isArray(list) ? list : []
      // 按更新时间倒序
      historyRecords.value.sort(
        (a, b) => new Date(b.updatedAt || b.createdAt) - new Date(a.updatedAt || a.createdAt),
      )
      historyLoadedKey.value = historyKey.value
    } catch (error) {
      // 读取失败时不清空已有列表（避免把「读不到」伪装成「无记录」），仅记录并提示。
      console.error('加载历史记录失败:', error)
      showError('historyLoadFailed')
    }
  }

  async function saveHistory() {
    if (!historyKey.value) return
    try {
      await localforage.setItem(historyKey.value, JSON.parse(JSON.stringify(historyRecords.value)))
    } catch (error) {
      console.error('保存历史记录失败:', error)
      showError('historySaveFailed')
    }
  }

  async function createNewHistoryRecord() {
    const newId = uuidv4()
    const now = new Date().toISOString()
    const record = {
      id: newId,
      taskId: currentJobId.value ?? batchTaskStore.status?.id ?? null,
      appId: currentApp.value?.id,
      appName: currentApp.value?.name,
      createdAt: now,
      updatedAt: now,
      status: 'running',
      clientId: state.clientId,
      total: executionProgress.total,
      processed: 0,
      success: 0,
      failed: 0,
      percent: 0,
      startFromIndex: startFromIndex.value,
      lastIndexProcessed: startFromIndex.value - 1,
      inputsMapping: deepClone(state.inputs),
      batchSource: {
        type: selectedSourceType.value,
        directoryPath: directoryPath.value,
        fileFilter: fileFilter.value,
        uploadedFiles:
          deepClone(uploadedFiles.value?.map((f) => ({ name: f.name, size: f.size }))) || [],
        jsonInput: jsonInput.value,
      },
      batchData: deepClone(batchData.value),
      logs: [],
      results: [],
    }
    historyRecords.value.unshift(record)
    await saveHistory()
    return newId
  }

  async function upsertHistoryRecord(update) {
    if (!update?.id) return
    const idx = historyRecords.value.findIndex((r) => r.id === update.id)
    if (idx === -1) return
    const rec = historyRecords.value[idx]
    const merged = { ...rec, ...update }
    if (typeof update.processed === 'number') {
      // update.processed 已包含跳过前缀（init 为 startFromIndex-1），其值即 1-based
      // currentIndex；之前额外 +(startFromIndex-1) 会重复叠加，导致断点续跑时
      // lastIndexProcessed 偏大、再次续跑跳过未处理项（数据丢失）。
      merged.lastIndexProcessed = Math.max(rec.lastIndexProcessed || 0, update.processed)
    }
    if (Array.isArray(update.logs) && update.logs.length) {
      merged.logs = [...update.logs, ...(rec.logs || [])]
    }
    if (update.resultItem) {
      merged.results = [...(rec.results || []), update.resultItem]
      merged.lastIndexProcessed = Math.max(rec.lastIndexProcessed || 0, update.resultItem.index)
    }
    merged.updatedAt = new Date().toISOString()
    historyRecords.value.splice(idx, 1, merged)
    await saveHistory()
  }

  async function openHistoryDialog() {
    await ensureHistoryLoaded()
    showHistoryDialog.value = true
  }

  async function deleteHistoryRecord(id) {
    const idx = historyRecords.value.findIndex((r) => r.id === id)
    if (idx > -1) {
      historyRecords.value.splice(idx, 1)
      await saveHistory()
    }
  }

  return {
    showHistoryDialog,
    historyRecords,
    currentHistoryRecordId,
    historyKey,
    ensureHistoryLoaded,
    saveHistory,
    createNewHistoryRecord,
    upsertHistoryRecord,
    openHistoryDialog,
    deleteHistoryRecord,
  }
}
