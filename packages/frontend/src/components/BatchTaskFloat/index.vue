<template>
  <!-- 常驻批量任务浮层：main 进程执行，不随页面卸载。任何页面右下角可见/可操作。
       embed 窄容器：贴左侧、抬高到 Composer 上方（bottom 172 ≈ 输入卡高度），不遮发送钮 -->
  <div v-if="visible" class="batch-float" :class="{ 'batch-float-embed': isEmbed }">
    <div v-if="!expanded" class="batch-float-pill" @click="expanded = true">
      <span class="dot" :class="statusClass"></span>
      <span class="pill-text">{{ pillText }}</span>
      <div class="pill-bar">
        <div class="pill-bar-fill" :style="{ transform: `scaleX(${percent / 100})` }"></div>
      </div>
    </div>

    <div v-else class="batch-float-panel">
      <div class="panel-header">
        <span class="dot" :class="statusClass"></span>
        <span class="panel-title">{{ headerText }}</span>
        <button class="panel-close" @click="expanded = false">×</button>
      </div>

      <div class="panel-progress" v-if="store.status && store.status.total > 0">
        <div class="progress-track">
          <div
            class="progress-fill"
            :class="statusClass"
            :style="{ transform: `scaleX(${percent / 100})` }"
          ></div>
        </div>
        <span class="progress-text">{{ s.processed }}/{{ s.total }}（{{ percent }}%）</span>
      </div>

      <div class="panel-stats">
        <span class="ok">✓ {{ s.success }}</span>
        <span class="fail">✗ {{ s.failed }}</span>
        <span v-if="s.currentPreview" class="current" :title="s.currentPreview">
          {{ s.currentPreview }}
        </span>
      </div>

      <!-- 队列设置：运行完成后关机 / 通知手机 -->
      <div class="panel-config">
        <div class="config-toggle" @click="showConfig = !showConfig">
          <span class="config-title">⚙️ 队列设置</span>
          <span class="config-arrow" :class="{ open: showConfig }">▾</span>
        </div>
        <div v-if="showConfig" class="config-body">
          <div class="config-row">
            <button class="mini-switch" :class="{ on: cfg.autoShutdown }" @click="toggleShutdown">
              <span class="mini-knob"></span>
            </button>
            <span class="config-label">运行完成后关机</span>
          </div>
          <div class="config-row">
            <button class="mini-switch" :class="{ on: cfg.notifyEnabled }" @click="toggleNotify">
              <span class="mini-knob"></span>
            </button>
            <span class="config-label">完成后通知手机</span>
          </div>
          <div v-if="cfg.notifyEnabled" class="config-url-row">
            <input
              v-model="notifyUrlDraft"
              class="config-input"
              :placeholder="'Bark / Telegram / server酱 webhook'"
              @blur="applyNotifyUrl"
              @keyup.enter="applyNotifyUrl"
            />
          </div>
          <div class="config-note">
            <span v-if="cfg.autoShutdown">⚡ 队列跑完自动关机（30s）</span>
            <span v-if="cfg.autoShutdown && cfg.notifyEnabled"> · </span>
            <span v-if="cfg.notifyEnabled">🔔 完成即推送</span>
            <span v-if="!cfg.autoShutdown && !cfg.notifyEnabled">变更即时生效</span>
          </div>
        </div>
      </div>

      <!-- 队列摘要：暂停任务 + 排队中任务 -->
      <div class="panel-queue" v-if="queuedJobs.length > 0 || pausedJob">
        <div class="queue-summary">
          <template v-if="pausedJob">已暂停 {{ pausedJob.appName || '任务' }} · </template>
          队列中 {{ queuedJobs.length }} 个任务等待执行
        </div>
        <div class="queue-mini-list">
          <!-- 暂停任务（保留进度，可继续/删除） -->
          <div v-if="pausedJob" class="queue-mini-item paused">
            <span class="queue-mini-name">{{ pausedJob.appName || '批量任务' }}</span>
            <span class="queue-mini-meta"
              >{{ pausedJob.processed }}/{{ pausedJob.total }} 已暂停</span
            >
            <button class="mini-act ok" title="继续执行" @click="handleResumeJob(pausedJob.id)">
              ▶
            </button>
            <button class="mini-act danger" title="删除出队" @click="handleDequeue(pausedJob.id)">
              ✕
            </button>
          </div>
          <div v-for="qj in queuedJobs.slice(0, 4)" :key="qj.id" class="queue-mini-item">
            <span class="queue-mini-name">{{ qj.appName || '批量任务' }}</span>
            <span class="queue-mini-meta">{{ qj.processed }}/{{ qj.total }}</span>
            <button class="mini-act" title="置顶" @click="handleMoveTop(qj.id)">↑</button>
            <button class="mini-act danger" title="删除出队" @click="handleDequeue(qj.id)">
              ✕
            </button>
          </div>
          <div class="queue-mini-more" v-if="queuedJobs.length > 4">
            还有 {{ queuedJobs.length - 4 }} 个…
          </div>
        </div>
      </div>

      <div v-if="recentLogs.length" class="panel-logs">
        <div v-for="(log, i) in recentLogs" :key="i" class="log-line" :class="log.type">
          <span class="log-time">{{ log.time }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
      </div>

      <div class="panel-actions">
        <button v-if="store.isRunning" class="btn" @click="handlePause">⏸ {{ t('pause') }}</button>
        <button v-if="store.isRunning" class="btn btn-danger" @click="handleStop">
          ⏹ {{ t('stopExecution') }}
        </button>
        <button v-if="pausedJob" class="btn btn-ok" @click="handleResumeJob(pausedJob.id)">
          ▶ {{ t('resume') }}
        </button>
        <button class="btn btn-primary" @click="goDetail">📋 {{ t('batchQueueDetail') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'
import { useBatchTaskStore } from '@/stores/batchTaskStore'
import { t } from '@/utils/i18n'
import { showInfo } from '@/utils'

const store = useBatchTaskStore()
const router = useRouter()
const expanded = ref(false)
const showConfig = ref(false)
const notifyUrlDraft = ref('')
// embed 模式（ComfyUI 侧栏 iframe）：右下角与 Composer 发送钮重叠，
// 浮层收到输入区上方（bottom 让出 Composer 高度），左对齐避免盖发送钮
const isEmbed = computed(() => new URLSearchParams(window.location.search).get('embed') === '1')

const cfg = computed(() => store.queueConfig)
const s = computed(() => store.status || {})
const percent = computed(() => store.percent)
const visible = computed(
  () =>
    store.isRunning ||
    store.queuedCount > 0 ||
    !!store.pausedJob ||
    (expanded.value && store.queue.length > 0),
)
const statusClass = computed(() => {
  if (store.isRunning) return 'running'
  if (store.pausedJob) return 'waiting'
  if (store.queuedCount > 0) return 'waiting'
  return s.value.status === 'completed' ? 'ok' : 'err'
})
// 全部终态时的汇总文案（区分成功/失败，避免"已完成"误导）
const doneText = computed(() => {
  const total = store.queue.length
  if (total === 0) return t('batchTaskDone')
  const failed = store.queue.filter((j) => j.status === 'failed' || j.status === 'stopped').length
  const done = store.queue.filter((j) => j.status === 'completed').length
  if (failed === 0) return t('batchTaskDone')
  return `${done} 成功 · ${failed} 失败/停止`
})
const pillText = computed(() => {
  if (store.isRunning) {
    return (
      `${s.value.processed}/${s.value.total} · ${percent.value}%` +
      (store.queuedCount > 0 ? ` · 队列中 ${store.queuedCount}` : '')
    )
  }
  if (store.pausedJob) {
    return `已暂停 ${s.value.processed}/${s.value.total} · 队列中 ${store.queuedCount}`
  }
  if (store.paused) return '队列已暂停'
  if (store.queuedCount > 0) return `排队中 ${store.queuedCount} 个任务`
  return doneText.value
})
const headerText = computed(() => {
  if (store.isRunning) {
    return (
      `${s.value.appName || t('batchExecution')} · ${percent.value}%` +
      (store.queuedCount > 0 ? `（队列 ${store.queuedCount}）` : '')
    )
  }
  if (store.pausedJob) {
    return `已暂停：${s.value.appName || t('batchExecution')} · ${percent.value}%`
  }
  if (store.paused) return '队列已暂停，点击查看详情'
  if (store.queuedCount > 0) return `排队中 ${store.queuedCount} 个任务`
  return doneText.value
})
const queuedJobs = computed(() => store.queue.filter((j) => j.status === 'queued'))
const pausedJob = computed(() => store.pausedJob)
const recentLogs = computed(() => (s.value.logs || []).slice(0, 8))

onMounted(async () => {
  // 启动时探一次：main 进程可能有正在跑/排队的任务（如刷新/重开面板后恢复显示）
  await store.loadQueueConfig()
  notifyUrlDraft.value = store.queueConfig.notifyUrl
  await store.fetchQueue()
  if (store.isRunning || store.queuedCount > 0 || store.pausedJob) store.startPolling()
})

watch(
  () => store.queueConfig.notifyUrl,
  (v) => {
    notifyUrlDraft.value = v || ''
  },
)

async function handleStop() {
  await store.stop()
  expanded.value = true
}

async function handlePause() {
  await store.pauseJob()
  showInfo('batchPaused')
  expanded.value = true
}

async function handleResumeJob(id) {
  await store.resumeJob(id)
  showInfo('batchResumed')
}

function handleDequeue(id) {
  Modal.confirm({
    title: '删除出队',
    content: '确定将该任务移出队列吗？（已完成的进度将丢失）',
    okText: '删除',
    okType: 'danger',
    cancelText: '取消',
    onOk: async () => {
      await store.cancel(id)
      showInfo('batchDequeued')
    },
  })
}

async function handleMoveTop(id) {
  await store.moveTop(id)
}

// ---- 队列设置 ----
async function toggleShutdown() {
  store.setQueueConfig({ autoShutdown: !cfg.value.autoShutdown })
  await store.applyQueueConfig()
  showInfo(cfg.value.autoShutdown ? 'autoShutdownEnabled' : 'autoShutdownDisabled')
}

async function toggleNotify() {
  store.setQueueConfig({ notifyEnabled: !cfg.value.notifyEnabled })
  await store.applyQueueConfig()
}

async function applyNotifyUrl() {
  store.setQueueConfig({ notifyUrl: notifyUrlDraft.value })
  await store.applyQueueConfig()
}

function goDetail() {
  expanded.value = false
  router.push('/batch/detail')
}
</script>

<style scoped lang="less">
.batch-float {
  position: fixed;
  right: 20px;
  bottom: 20px;
  z-index: 1100;
  font-size: 12px;
  user-select: none;
}

/* embed 侧栏（312px iframe）：避让右下角 Composer 发送钮 */
.batch-float-embed {
  right: auto;
  left: 10px;
  bottom: 172px;
  max-width: calc(100vw - 20px);
}

/* 收起态：小胶囊 */
.batch-float-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  &:hover {
    border-color: var(--wb-accent);
  }
  .pill-text {
    color: var(--wb-text);
    white-space: nowrap;
  }
  .pill-bar {
    width: 60px;
    height: 4px;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.12);
    overflow: hidden;
    .pill-bar-fill {
      width: 100%;
      height: 100%;
      background: var(--wb-accent);
      transform-origin: left center;
      transition: transform 0.3s ease-out;
    }
  }
}

/* 展开态：面板 */
.batch-float-panel {
  width: 360px;
  max-height: 78vh;
  overflow-y: auto;
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  border-radius: 12px;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.panel-header {
  display: flex;
  align-items: center;
  gap: 8px;
  .panel-title {
    flex: 1;
    color: var(--wb-text);
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .panel-close {
    background: none;
    border: none;
    color: var(--wb-text-2);
    font-size: 16px;
    cursor: pointer;
    line-height: 1;
    &:hover {
      color: var(--wb-text);
    }
  }
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  &.running {
    background: var(--wb-accent);
  }
  &.waiting {
    background: #f59e0b;
  }
  &.ok {
    background: var(--wb-success);
  }
  &.err {
    background: var(--wb-danger);
  }
}

/* 队列设置 */
.panel-config {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
  .config-toggle {
    display: flex;
    align-items: center;
    justify-content: space-between;
    cursor: pointer;
    .config-title {
      color: var(--wb-accent);
      font-size: 11px;
      font-weight: 600;
    }
    .config-arrow {
      color: var(--wb-text-3);
      font-size: 10px;
      transition: transform 0.2s;
      &.open {
        transform: rotate(180deg);
      }
    }
  }
  .config-body {
    display: flex;
    flex-direction: column;
    gap: 6px;
    margin-top: 6px;
    padding-top: 6px;
    border-top: 1px solid var(--wb-stroke);
  }
  .config-row {
    display: flex;
    align-items: center;
    gap: 8px;
    .config-label {
      color: var(--wb-text);
      font-size: 11px;
    }
  }
  .config-url-row {
    margin-top: 2px;
    .config-input {
      width: 100%;
      box-sizing: border-box;
      background: var(--wb-surface);
      border: 1px solid var(--wb-stroke);
      border-radius: 4px;
      color: var(--wb-text);
      font-size: 11px;
      padding: 4px 8px;
      outline: none;
      &:focus {
        border-color: var(--wb-accent);
      }
      &::placeholder {
        color: var(--wb-text-3);
      }
    }
  }
  .config-note {
    color: var(--wb-text-3);
    font-size: 10px;
    line-height: 1.4;
  }
}

/* 迷你开关 */
.mini-switch {
  width: 28px;
  height: 16px;
  border-radius: 8px;
  background: var(--wb-stroke-strong);
  border: 1px solid var(--wb-text-3);
  position: relative;
  cursor: pointer;
  flex-shrink: 0;
  padding: 0;
  transition: background 0.2s;
  .mini-knob {
    position: absolute;
    top: 1px;
    left: 1px;
    width: 12px;
    height: 12px;
    border-radius: 50%;
    background: var(--wb-text-2);
    transition:
      left 0.2s,
      background 0.2s;
  }
  &.on {
    background: var(--wb-success);
    border-color: var(--wb-success);
    .mini-knob {
      left: 13px;
      background: #ffffff;
    }
  }
}

/* 队列摘要 */
.panel-queue {
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
  .queue-summary {
    color: #f59e0b;
    font-size: 11px;
    margin-bottom: 4px;
  }
  .queue-mini-list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    .queue-mini-item {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 11px;
      color: var(--wb-text-2);
      &.paused {
        color: #f59e0b;
      }
      .queue-mini-name {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .queue-mini-meta {
        flex-shrink: 0;
      }
      .mini-act {
        background: rgba(255, 255, 255, 0.08);
        border: 1px solid var(--wb-stroke);
        border-radius: 4px;
        color: var(--wb-text-2);
        font-size: 10px;
        line-height: 1;
        padding: 3px 5px;
        cursor: pointer;
        &:hover {
          color: var(--wb-text);
          border-color: var(--wb-accent);
        }
        &.ok {
          color: var(--wb-success);
          &:hover {
            border-color: var(--wb-success);
          }
        }
        &.danger {
          color: var(--wb-danger);
          &:hover {
            border-color: var(--wb-danger);
            background: var(--wb-danger-bg);
          }
        }
      }
    }
    .queue-mini-more {
      font-size: 11px;
      color: var(--wb-text-3);
    }
  }
}

.panel-progress {
  display: flex;
  align-items: center;
  gap: 8px;
  .progress-track {
    flex: 1;
    height: 6px;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.1);
    overflow: hidden;
    .progress-fill {
      width: 100%;
      height: 100%;
      transform-origin: left center;
      transition: transform 0.3s ease-out;
      &.running {
        background: var(--wb-accent);
      }
      &.ok {
        background: var(--wb-success);
      }
      &.err {
        background: var(--wb-danger);
      }
    }
  }
  .progress-text {
    color: var(--wb-text-2);
    white-space: nowrap;
  }
}

.panel-stats {
  display: flex;
  gap: 12px;
  color: var(--wb-text-2);
  .ok {
    color: var(--wb-success);
  }
  .fail {
    color: var(--wb-danger);
  }
  .current {
    flex: 1;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    text-align: right;
  }
}

.panel-logs {
  max-height: 100px;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.25);
  border-radius: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  .log-line {
    display: flex;
    gap: 6px;
    font-size: 11px;
    line-height: 1.5;
    .log-time {
      color: var(--wb-text-3);
      flex-shrink: 0;
    }
    .log-msg {
      color: var(--wb-text-2);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    &.success .log-msg {
      color: var(--wb-success);
    }
    &.error .log-msg {
      color: var(--wb-danger);
    }
  }
}

.panel-actions {
  display: flex;
  gap: 8px;
  .btn {
    flex: 1;
    padding: 5px 0;
    border-radius: 6px;
    border: 1px solid var(--wb-stroke);
    background: rgba(255, 255, 255, 0.06);
    color: var(--wb-text);
    cursor: pointer;
    &:hover {
      border-color: var(--wb-accent);
    }
    &.btn-danger {
      border-color: var(--wb-danger);
      color: var(--wb-danger);
      &:hover {
        background: var(--wb-danger-bg);
      }
    }
    &.btn-ok {
      border-color: var(--wb-success);
      color: var(--wb-success);
      &:hover {
        background: var(--wb-success-bg);
      }
    }
    &.btn-primary {
      background: var(--wb-accent);
      border: none;
      color: #fff;
      &:hover {
        background: var(--wb-accent-hover);
      }
    }
  }
}
</style>
