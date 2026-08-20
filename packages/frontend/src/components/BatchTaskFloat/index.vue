<template>
  <!-- 常驻批量任务浮层：main 进程执行，不随页面卸载。任何页面右下角可见/可操作。 -->
  <div v-if="visible" class="batch-float">
    <div v-if="!expanded" class="batch-float-pill" @click="expanded = true">
      <span class="dot" :class="statusClass"></span>
      <span class="pill-text">{{ pillText }}</span>
      <div class="pill-bar"><div class="pill-bar-fill" :style="{ transform: `scaleX(${percent / 100})` }"></div></div>
    </div>

    <div v-else class="batch-float-panel">
      <div class="panel-header">
        <span class="dot" :class="statusClass"></span>
        <span class="panel-title">{{ headerText }}</span>
        <button class="panel-close" @click="expanded = false">×</button>
      </div>

      <div class="panel-progress">
        <div class="progress-track">
          <div class="progress-fill" :class="statusClass" :style="{ transform: `scaleX(${percent / 100})` }"></div>
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

      <div v-if="recentLogs.length" class="panel-logs">
        <div v-for="(log, i) in recentLogs" :key="i" class="log-line" :class="log.type">
          <span class="log-time">{{ log.time }}</span>
          <span class="log-msg">{{ log.message }}</span>
        </div>
      </div>

      <div class="panel-actions">
        <button v-if="store.isRunning" class="btn btn-danger" @click="handleStop">
          ⏹ {{ t('stopExecution') }}
        </button>
        <button class="btn" @click="goBatch">{{ t('batchTaskDetail') }}</button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useBatchTaskStore } from '@/stores/batchTaskStore'
import { t } from '@/utils/i18n'

const store = useBatchTaskStore()
const router = useRouter()
const expanded = ref(false)

const s = computed(() => store.status || {})
const percent = computed(() => store.percent)
const visible = computed(() => !!store.status && (store.isRunning || expanded.value))
const statusClass = computed(() =>
  store.isRunning ? 'running' : (s.value.status === 'completed' ? 'ok' : 'err')
)
const pillText = computed(() =>
  store.isRunning ? `${s.value.processed}/${s.value.total} · ${percent.value}%` : t('batchTaskDone')
)
const headerText = computed(() =>
  store.isRunning
    ? `${s.value.appName || t('batchExecution')} · ${percent.value}%`
    : t('batchTaskDone')
)
const recentLogs = computed(() => (s.value.logs || []).slice(0, 8))

onMounted(() => {
  // 启动时探一次：main 进程可能有正在跑的任务（如刷新/重开面板后恢复显示）
  store.fetchStatus().then(() => {
    if (store.isRunning) store.startPolling()
  })
})

async function handleStop() {
  await store.stop()
  expanded.value = true
}

function goBatch() {
  expanded.value = false
  router.push('/batch')
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

/* 收起态：小胶囊 */
.batch-float-pill {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  background: rgba(15, 23, 42, 0.92);
  border: 1px solid rgba(56, 70, 102, 0.8);
  border-radius: 20px;
  cursor: pointer;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  &:hover {
    border-color: #0ea5e9;
  }
  .pill-text {
    color: #e2e8f0;
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
      background: #0ea5e9;
      transform-origin: left center;
      transition: transform 0.3s ease-out;
    }
  }
}

/* 展开态：面板 */
.batch-float-panel {
  width: 340px;
  background: rgba(15, 23, 42, 0.96);
  border: 1px solid rgba(56, 70, 102, 0.8);
  border-radius: 10px;
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
    color: #e2e8f0;
    font-weight: 600;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .panel-close {
    background: none;
    border: none;
    color: #94a3b8;
    font-size: 16px;
    cursor: pointer;
    line-height: 1;
    &:hover {
      color: #e2e8f0;
    }
  }
}

.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  &.running {
    background: #0ea5e9;
  }
  &.ok {
    background: #10b981;
  }
  &.err {
    background: #ef4444;
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
        background: #0ea5e9;
      }
      &.ok {
        background: #10b981;
      }
      &.err {
        background: #ef4444;
      }
    }
  }
  .progress-text {
    color: #94a3b8;
    white-space: nowrap;
  }
}

.panel-stats {
  display: flex;
  gap: 12px;
  color: #94a3b8;
  .ok {
    color: #10b981;
  }
  .fail {
    color: #ef4444;
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
  max-height: 140px;
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
      color: #64748b;
      flex-shrink: 0;
    }
    .log-msg {
      color: #94a3b8;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    &.success .log-msg {
      color: #10b981;
    }
    &.error .log-msg {
      color: #ef4444;
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
    border: 1px solid rgba(56, 70, 102, 0.8);
    background: rgba(255, 255, 255, 0.06);
    color: #e2e8f0;
    cursor: pointer;
    &:hover {
      border-color: #0ea5e9;
    }
    &.btn-danger {
      border-color: rgba(239, 68, 68, 0.6);
      color: #f87171;
      &:hover {
        background: rgba(239, 68, 68, 0.15);
      }
    }
  }
}
</style>
