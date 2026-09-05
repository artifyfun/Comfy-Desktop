<template>
  <div class="page-container">
    <!-- 页面头部 -->
    <div class="page-header">
      <div class="header-row">
        <a-button class="nav-btn" @click="goBack">
          <template #icon><LeftOutlined /></template>
          返回
        </a-button>
        <h1 class="page-title">{{ t('batchQueueDetail') }}</h1>
        <div class="header-spacer"></div>
        <a-button class="nav-btn" @click="store.fetchQueue()">
          <template #icon><ReloadOutlined /></template>
          刷新
        </a-button>
      </div>
      <p class="page-description">{{ t('queueDetailDescription') }}</p>
    </div>

    <div class="main-content">
      <!-- 队列设置：完整配置 -->
      <div class="config-card">
        <div class="card-title">⚙️ {{ t('queueSettings') }}</div>
        <div class="config-note-text">{{ t('queueSettingsDesc') }}</div>
        <div class="config-row">
          <a-switch
            v-model:checked="cfgShutdown"
            class="shutdown-switch"
            @change="onShutdownChange"
          />
          <div class="config-info">
            <div class="config-label">{{ t('shutdownAfterRun') }}</div>
            <div class="config-desc">{{ t('shutdownAfterRunDesc') }}</div>
          </div>
        </div>
        <div class="config-row">
          <a-switch v-model:checked="cfgNotify" class="shutdown-switch" @change="onNotifyToggle" />
          <div class="config-info">
            <div class="config-label">{{ t('notifyPhone') }}</div>
            <div class="config-desc">{{ t('notifyPhoneDesc') }}</div>
            <a-input
              v-if="cfgNotify"
              v-model:value="cfgNotifyUrl"
              :placeholder="t('notifyWebhookPlaceholder')"
              size="small"
              class="notify-input"
              @blur="onNotifyUrlChange"
              @press-enter="onNotifyUrlChange"
            />
          </div>
        </div>
        <div class="config-saved" v-if="configSaved">✅ 已应用，对排队中/运行中任务即时生效</div>
      </div>

      <!-- 重启恢复后的暂停提示：需人工继续 -->
      <div class="queue-paused-banner" v-if="store.paused">
        <span class="queue-paused-text">应用重启后队列已暂停，排队任务不会自动执行</span>
        <a-button size="small" type="primary" @click="handleResumeQueue">▶ 继续执行</a-button>
      </div>

      <!-- 队列统计 + 批量操作 -->
      <div class="queue-ops">
        <div class="queue-stats">
          <span class="stat-chip">共 {{ store.queue.length }} 个</span>
          <span class="stat-chip queued">排队 {{ queuedCount }}</span>
          <span class="stat-chip running">运行 {{ runningCount }}</span>
          <span class="stat-chip paused">暂停 {{ pausedCount }}</span>
          <span class="stat-chip done">结束 {{ doneCount }}</span>
        </div>
        <div class="ops-buttons">
          <a-button size="small" danger v-if="store.isRunning" @click="handleStopAll">
            ⏹ 停止全部
          </a-button>
          <a-button size="small" v-if="doneCount > 0" @click="handleClearFinished">
            🧹 清空已完成
          </a-button>
        </div>
      </div>

      <!-- 任务列表 -->
      <div v-if="store.queue.length === 0" class="queue-empty">
        <div class="empty-text">队列为空</div>
        <a-button type="primary" @click="goCreateBatch">＋ 去创建批量任务</a-button>
      </div>
      <div v-else class="job-list">
        <div v-for="job in store.queue" :key="job.id" class="job-card" :class="job.status">
          <div class="job-head">
            <span class="job-badge" :class="job.status">{{ statusText(job.status) }}</span>
            <span class="job-app">{{ job.appName || '批量任务' }}</span>
            <span class="job-config-tags">
              <span v-if="job.autoShutdown" class="cfg-tag shutdown" title="该任务完成后参与关机"
                >⚡关机</span
              >
              <span v-if="job.notifyUrl" class="cfg-tag notify" title="该任务完成时通知"
                >🔔通知</span
              >
            </span>
            <span class="job-time">{{ timeText(job) }}</span>
            <span class="job-spacer"></span>
            <a-button size="small" v-if="job.status === 'queued'" @click="handleMoveTop(job.id)"
              >置顶</a-button
            >
            <a-button
              size="small"
              type="primary"
              ghost
              v-if="job.status === 'running'"
              @click="handlePauseJob(job.id)"
              >⏸ 暂停</a-button
            >
            <a-button size="small" danger v-if="job.status === 'running'" @click="handleStopJob"
              >⏹ 停止</a-button
            >
            <a-button
              size="small"
              type="primary"
              v-if="job.status === 'paused'"
              @click="handleResumeJob(job.id)"
              >▶ 继续</a-button
            >
            <a-button
              size="small"
              danger
              v-if="job.status === 'queued' || job.status === 'paused'"
              @click="handleDequeue(job)"
              >删除出队</a-button
            >
            <a-button
              size="small"
              type="primary"
              ghost
              v-if="['completed', 'stopped', 'failed'].includes(job.status)"
              @click="handleRerun(job)"
              >🔁 重新运行</a-button
            >
            <a-button
              size="small"
              danger
              v-if="['completed', 'stopped', 'failed'].includes(job.status)"
              @click="handleDequeue(job)"
              >删除</a-button
            >
          </div>

          <div class="job-progress">
            <div
              class="job-progress-fill"
              :class="job.status"
              :style="{ width: (job.percent || 0) + '%' }"
            ></div>
            <span class="job-progress-text">{{ job.percent || 0 }}%</span>
          </div>

          <div class="job-foot">
            <span class="job-preview" v-if="job.currentPreview" :title="job.currentPreview">
              {{ job.currentPreview }}
            </span>
            <span class="job-stats"
              >✓ {{ job.success }} · ✗ {{ job.failed }} · {{ job.processed }}/{{ job.total }}</span
            >
          </div>

          <div class="job-expand">
            <a-button type="text" size="small" class="expand-btn" @click="toggleExpand(job.id)">
              {{ expandedJobId === job.id ? '收起' : '展开' }}（日志 {{ (job.logs || []).length }} ·
              结果 {{ (job.results || []).length }}）
            </a-button>
            <div v-if="expandedJobId === job.id" class="job-detail">
              <div class="detail-section" v-if="(job.logs || []).length">
                <div class="detail-title">{{ t('jobLogs') }}</div>
                <div class="log-list">
                  <div
                    v-for="(lg, i) in job.logs.slice(0, 60)"
                    :key="i"
                    class="log-line"
                    :class="lg.type"
                  >
                    <span class="log-time">{{ lg.time }}</span>
                    <span class="log-msg">{{ lg.message }}</span>
                  </div>
                  <div v-if="job.logs.length > 60" class="log-more">…仅显示前 60 条</div>
                </div>
              </div>
              <div class="detail-section" v-if="(job.results || []).length">
                <div class="detail-title">{{ t('jobResults') }}</div>
                <div class="result-list">
                  <div
                    v-for="(r, i) in job.results.slice(0, 20)"
                    :key="i"
                    class="result-line"
                    :class="r.success ? 'ok' : 'fail'"
                  >
                    <span class="result-index">#{{ r.index }}</span>
                    <span class="result-status">{{ r.success ? '✓' : '✗' }}</span>
                    <span class="result-msg" v-if="!r.success && r.error">{{ r.error }}</span>
                    <span class="result-ms" v-if="r.durationMs">{{ r.durationMs }}ms</span>
                  </div>
                  <div v-if="job.results.length > 20" class="log-more">…仅显示前 20 条</div>
                </div>
              </div>
              <div
                class="detail-section"
                v-if="!(job.logs || []).length && !(job.results || []).length"
              >
                <div class="log-more">暂无日志</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'
import { LeftOutlined, ReloadOutlined } from '@ant-design/icons-vue'
import { useBatchTaskStore } from '@/stores/batchTaskStore'
import { t } from '@/utils/i18n'
import { showInfo, showSuccess } from '@/utils'

const store = useBatchTaskStore()
const router = useRouter()

const expandedJobId = ref(null)
const cfgShutdown = ref(false)
const cfgNotify = ref(false)
const cfgNotifyUrl = ref('')
const configSaved = ref(false)
let configSaveTimer = null

const queuedCount = computed(() => store.queue.filter((j) => j.status === 'queued').length)
const runningCount = computed(() => store.queue.filter((j) => j.status === 'running').length)
const pausedCount = computed(() => store.queue.filter((j) => j.status === 'paused').length)
const doneCount = computed(
  () => store.queue.filter((j) => !['queued', 'running', 'paused'].includes(j.status)).length,
)

function statusText(status) {
  const map = {
    queued: '排队中',
    running: '执行中',
    paused: '已暂停',
    completed: '已完成',
    stopped: '已停止',
    failed: '失败',
  }
  return map[status] || status
}

function timeText(job) {
  const start = job.startedAt || job.createdAt
  if (!start) return ''
  const base = new Date(start).toLocaleTimeString()
  if (job.finishedAt) return `${base} ~ ${new Date(job.finishedAt).toLocaleTimeString()}`
  return base
}

function toggleExpand(id) {
  expandedJobId.value = expandedJobId.value === id ? null : id
}

// ---------- 队列设置 ----------
async function initConfig() {
  await store.loadQueueConfig()
  cfgShutdown.value = store.queueConfig.autoShutdown
  cfgNotify.value = store.queueConfig.notifyEnabled
  cfgNotifyUrl.value = store.queueConfig.notifyUrl
}

function flashSaved() {
  configSaved.value = true
  if (configSaveTimer) clearTimeout(configSaveTimer)
  configSaveTimer = setTimeout(() => {
    configSaved.value = false
  }, 2000)
}

async function applyConfig() {
  await store.applyQueueConfig()
  flashSaved()
}

async function onShutdownChange() {
  store.setQueueConfig({ autoShutdown: cfgShutdown.value })
  await applyConfig()
  showInfo(cfgShutdown.value ? 'autoShutdownEnabled' : 'autoShutdownDisabled')
}

async function onNotifyToggle() {
  store.setQueueConfig({ notifyEnabled: cfgNotify.value })
  await applyConfig()
}

async function onNotifyUrlChange() {
  store.setQueueConfig({ notifyUrl: cfgNotifyUrl.value })
  await applyConfig()
}

// ---------- 队列操作 ----------
function goBack() {
  if (window.history.length > 1) router.back()
  else router.push('/')
}

function goCreateBatch() {
  router.push('/batch')
}

async function handleResumeQueue() {
  await store.resume()
  showSuccess('已恢复队列，排队任务开始依次执行')
}

async function handleStopAll() {
  await store.stopAll()
  showInfo('已停止全部批量任务')
}

async function handleClearFinished() {
  await store.clearFinished()
}

/** 一键重跑：完整复刻原配置重新入队 */
function handleRerun(job) {
  Modal.confirm({
    title: '重新运行批量任务',
    content: `将按「${job.appName || '批量任务'}」的原配置（数据 ${job.total} 条、映射与开始位置）重新入队执行一遍，无需重新编排队列。确定？`,
    okText: '重新运行',
    cancelText: '取消',
    onOk: async () => {
      try {
        await store.rerunJob(job.id)
        showInfo('rerunQueued')
      } catch (e) {
        showInfo(e?.message || '重新运行失败')
      }
    },
  })
}

async function handlePauseJob(id) {
  await store.pauseJob(id)
  showInfo('batchPaused')
}

async function handleStopJob() {
  await store.stop()
  showInfo('executionStopped')
}

async function handleResumeJob(id) {
  await store.resumeJob(id)
  showInfo('batchResumed')
}

async function handleMoveTop(id) {
  await store.moveTop(id)
  showInfo('已置顶')
}

function handleDequeue(job) {
  const isActive = ['queued', 'paused'].includes(job.status)
  Modal.confirm({
    title: isActive ? '删除出队' : '删除任务',
    content: isActive
      ? `确定将「${job.appName || '批量任务'}」移出队列吗？（已完成 ${job.processed}/${job.total}，删除后进度不可恢复）`
      : `确定删除「${job.appName || '批量任务'}」的记录吗？`,
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      if (isActive) {
        await store.cancel(job.id)
      } else {
        await store.deleteJob(job.id)
      }
      showInfo('batchDequeued')
    },
  })
}

onMounted(async () => {
  await initConfig()
  await store.fetchQueue()
  store.startPolling()
})

onBeforeUnmount(() => {
  store.stopPolling()
  if (configSaveTimer) clearTimeout(configSaveTimer)
})
</script>

<style lang="less" scoped>
.page-container {
  width: 100%;
  background: var(--wb-bg-base);
  min-height: 100vh;
  padding: 24px;
  color: var(--wb-text);
}

.page-header {
  margin-bottom: 10px;
  .header-row {
    display: flex;
    align-items: center;
    gap: 16px;
    .nav-btn {
      display: flex;
      align-items: center;
    }
    .page-title {
      font-size: 1.8rem;
      font-weight: 700;
      margin: 0;
      background: var(--wb-accent);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
      background-clip: text;
      font-family: var(--wb-font);
    }
    .header-spacer {
      flex: 1;
    }
  }
  .page-description {
    font-size: 0.95rem;
    color: var(--wb-text-2);
    margin: 8px 0 0 0;
  }
}

.main-content {
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 18px;
}

/* 队列设置卡片 */
.config-card {
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  border-radius: 16px;
  padding: 20px 24px;
  .card-title {
    font-size: 1.1rem;
    font-weight: 600;
    color: var(--wb-text);
    margin-bottom: 4px;
  }
  .config-note-text {
    font-size: 0.8rem;
    color: var(--wb-text-3);
    margin-bottom: 14px;
  }
  .config-row {
    display: flex;
    align-items: flex-start;
    gap: 14px;
    padding: 10px 0;
    border-top: 1px solid var(--wb-stroke);
    .config-info {
      flex: 1;
      .config-label {
        font-weight: 600;
        color: var(--wb-text);
        margin-bottom: 2px;
      }
      .config-desc {
        font-size: 0.85rem;
        color: var(--wb-text-2);
      }
      .notify-input {
        margin-top: 6px;
        max-width: 480px;
      }
    }
  }
  .shutdown-switch {
    margin-top: 2px;
    :deep(.ant-switch) {
      background: var(--wb-stroke-strong);
      border-color: var(--wb-stroke-strong);
    }
    :deep(.ant-switch-checked) {
      background: var(--wb-success);
      border-color: var(--wb-success);
    }
  }
  .config-saved {
    margin-top: 10px;
    font-size: 0.85rem;
    color: var(--wb-success);
  }
}

/* 重启恢复暂停横幅 */
.queue-paused-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 8px;
  background: rgba(245, 158, 11, 0.12);
  border: 1px solid rgba(245, 158, 11, 0.4);
  .queue-paused-text {
    color: #f59e0b;
    font-size: 13px;
  }
}

/* 统计 + 操作 */
.queue-ops {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 10px;
  .queue-stats {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
    .stat-chip {
      padding: 3px 10px;
      border-radius: 12px;
      background: var(--wb-surface);
      border: 1px solid var(--wb-stroke);
      font-size: 12px;
      color: var(--wb-text);
      &.queued {
        color: #f59e0b;
      }
      &.running {
        color: var(--wb-accent-hover);
      }
      &.paused {
        color: #f59e0b;
      }
      &.done {
        color: var(--wb-text-2);
      }
    }
  }
  .ops-buttons {
    display: flex;
    gap: 8px;
  }
}

.queue-empty {
  text-align: center;
  padding: 60px 0;
  border-radius: 16px;
  background: var(--wb-surface-deep);
  border: 1px dashed var(--wb-stroke);
  .empty-text {
    color: var(--wb-text-3);
    margin-bottom: 16px;
  }
}

/* 任务列表 */
.job-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.job-card {
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  &.running {
    border-color: var(--wb-accent);
  }
  &.paused {
    border-color: rgba(245, 158, 11, 0.55);
  }
  &.completed {
    border-color: rgba(16, 185, 129, 0.4);
  }
  &.stopped,
  &.failed {
    border-color: rgba(239, 68, 68, 0.35);
  }

  .job-head {
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    .job-badge {
      flex-shrink: 0;
      padding: 1px 8px;
      border-radius: 10px;
      font-size: 11px;
      line-height: 18px;
      color: var(--wb-text-2);
      background: var(--wb-surface);
      &.queued {
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.15);
      }
      &.running {
        color: var(--wb-accent-hover);
        background: var(--wb-accent-bg);
      }
      &.paused {
        color: #f59e0b;
        background: rgba(245, 158, 11, 0.15);
      }
      &.completed {
        color: #6ee7b7;
        background: rgba(16, 185, 129, 0.15);
      }
      &.stopped,
      &.failed {
        color: #fca5a5;
        background: rgba(239, 68, 68, 0.15);
      }
    }
    .job-app {
      color: var(--wb-text);
      font-size: 13px;
      font-weight: 500;
      max-width: 240px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .job-config-tags {
      display: flex;
      gap: 4px;
      .cfg-tag {
        font-size: 11px;
        padding: 1px 6px;
        border-radius: 6px;
        &.shutdown {
          color: #fca5a5;
          background: rgba(239, 68, 68, 0.12);
          border: 1px solid rgba(239, 68, 68, 0.3);
        }
        &.notify {
          color: var(--wb-accent-hover);
          background: var(--wb-accent-bg);
          border: 1px solid var(--wb-accent);
        }
      }
    }
    .job-time {
      color: var(--wb-text-3);
      font-size: 11px;
    }
    .job-spacer {
      flex: 1;
    }
  }

  .job-progress {
    position: relative;
    height: 6px;
    margin: 10px 0 8px;
    border-radius: 3px;
    background: var(--wb-surface-deep);
    overflow: hidden;
    .job-progress-fill {
      height: 100%;
      border-radius: 3px;
      background: var(--wb-accent);
      transition: width 0.35s ease;
      &.paused {
        background: #f59e0b;
      }
      &.completed {
        background: var(--wb-success);
      }
      &.stopped,
      &.failed {
        background: var(--wb-danger);
      }
    }
    .job-progress-text {
      position: absolute;
      right: 6px;
      top: -16px;
      font-size: 11px;
      color: var(--wb-text-2);
    }
  }

  .job-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    .job-preview {
      flex: 1;
      color: var(--wb-text-3);
      font-size: 11px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .job-stats {
      flex-shrink: 0;
      color: var(--wb-text-2);
      font-size: 11px;
    }
  }

  .job-expand {
    margin-top: 8px;
    .expand-btn {
      color: var(--wb-accent-hover);
      font-size: 12px;
      padding: 0;
    }
    .job-detail {
      margin-top: 8px;
      border-top: 1px solid var(--wb-stroke);
      padding-top: 8px;
      .detail-section {
        margin-bottom: 10px;
        .detail-title {
          font-size: 12px;
          font-weight: 600;
          color: var(--wb-text-2);
          margin-bottom: 6px;
        }
      }
      .log-list {
        max-height: 180px;
        overflow-y: auto;
        background: var(--wb-surface-deep);
        border-radius: 6px;
        padding: 6px 10px;
        .log-line {
          display: flex;
          gap: 8px;
          font-size: 11px;
          line-height: 1.7;
          .log-time {
            color: var(--wb-text-3);
            flex-shrink: 0;
          }
          .log-msg {
            color: var(--wb-text-2);
            word-break: break-all;
          }
          &.success .log-msg {
            color: var(--wb-success);
          }
          &.error .log-msg {
            color: var(--wb-danger);
          }
          &.info .log-msg {
            color: var(--wb-accent-hover);
          }
        }
      }
      .result-list {
        max-height: 180px;
        overflow-y: auto;
        background: var(--wb-surface-deep);
        border-radius: 6px;
        padding: 6px 10px;
        .result-line {
          display: flex;
          gap: 8px;
          font-size: 11px;
          line-height: 1.7;
          .result-index {
            color: var(--wb-text-3);
            flex-shrink: 0;
            font-family: monospace;
          }
          .result-status {
            flex-shrink: 0;
          }
          .result-msg {
            color: #fca5a5;
            word-break: break-all;
            flex: 1;
          }
          .result-ms {
            color: var(--wb-text-3);
            flex-shrink: 0;
            font-family: monospace;
          }
          &.ok .result-status {
            color: var(--wb-success);
          }
          &.fail .result-status {
            color: var(--wb-danger);
          }
        }
      }
      .log-more {
        font-size: 11px;
        color: var(--wb-text-3);
        font-style: italic;
      }
    }
  }
}
</style>
