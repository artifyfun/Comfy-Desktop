<template>
  <div class="page-container">
    <!-- 页面标题 -->
    <div class="page-header">
      <h1 class="page-title">{{ t('batchMode') }}</h1>
      <p class="page-description">{{ t('batchModeDescription') }}</p>
    </div>

    <!-- 主要内容区域 -->
    <div class="main-content">
      <div class="flex justify-end mb-2" style="padding: 24px 0">
        <a-button @click="openHistoryDialog" class="nav-btn">
          📝 {{ t('viewExecutionHistory') }}
        </a-button>
      </div>
      <!-- 步骤指示器 -->
      <a-steps :current="currentStep" class="steps-container">
        <a-step :title="t('selectSource')" :description="t('selectSourceDesc')" />
        <a-step :title="t('mapData')" :description="t('mapDataDesc')" />
        <a-step :title="t('execute')" :description="t('executeDesc')" />
      </a-steps>

      <!-- 步骤1: 选择批量来源 -->
      <div v-if="currentStep === 0" class="step-content">
        <div class="source-selection">
          <h3 class="step-title">{{ t('selectBatchSource') }}</h3>

          <!-- 来源类型选择 -->
          <div class="source-types">
            <a-radio-group v-model:value="selectedSourceType" class="source-type-group">
              <a-radio-button value="directory" class="source-type-btn">
                <template #icon><FolderOpenOutlined /></template>
                {{ t('fileDirectory') }}
              </a-radio-button>
              <a-radio-button value="file" class="source-type-btn">
                <template #icon><FileTextOutlined /></template>
                {{ t('uploadFile') }}
              </a-radio-button>
              <a-radio-button value="json" class="source-type-btn">
                <template #icon><CodeOutlined /></template>
                {{ t('writeJSON') }}
              </a-radio-button>
            </a-radio-group>
          </div>

          <!-- 文件目录选择 -->
          <div v-if="selectedSourceType === 'directory'" class="source-config">
            <div class="config-item">
              <label class="config-label">{{ t('selectDirectory') }}</label>
              <div class="directory-selector">
                <a-input
                  v-model:value="directoryPath"
                  :placeholder="t('directoryPathPlaceholder')"
                  readonly
                  class="path-input"
                />
                <a-button type="primary" class="path-btn" @click="selectDirectory">
                  <template #icon><FolderOpenOutlined /></template>
                  {{ t('browse') }}
                </a-button>
              </div>
              <div v-if="directoryFiles.length > 0" class="file-preview">
                <div class="file-preview-header">
                  <h4>{{ t('foundFiles') }} ({{ filteredDirectoryFiles.length }})</h4>
                  <div class="file-filter">
                    <a-radio-group v-model:value="fileFilter" size="small">
                      <a-radio-button value="all"
                        >{{ t('all') }} ({{ directoryFiles.length }})</a-radio-button
                      >
                      <a-radio-button
                        v-for="(count, type) in fileCounts"
                        :key="type"
                        :value="type"
                        v-show="count > 0"
                      >
                        {{ t(type + 'Only') }} ({{ count }})
                      </a-radio-button>
                    </a-radio-group>
                  </div>
                </div>
                <div class="file-list">
                  <div
                    v-for="file in filteredDirectoryFiles.slice(0, 10)"
                    :key="file.path"
                    class="file-item"
                  >
                    <FileOutlined v-if="!file.isDirectory && !getFileTypeIcon(file.name)" />
                    <FolderOutlined v-else-if="file.isDirectory" />
                    <component :is="getFileTypeIcon(file.name)" v-else />
                    <span class="file-name">{{ file.name }}</span>
                    <span class="file-path">{{ file.relativePath }}</span>
                    <span class="file-size">{{ formatFileSize(file.size) }}</span>
                  </div>
                  <div v-if="filteredDirectoryFiles.length > 10" class="more-files">
                    {{ t('andMoreFiles', { count: filteredDirectoryFiles.length - 10 }) }}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <!-- 文件上传 -->
          <div v-if="selectedSourceType === 'file'" class="source-config">
            <div class="config-item">
              <label class="config-label">{{ t('uploadFile') }}</label>
              <a-upload
                v-model:file-list="uploadedFiles"
                :before-upload="beforeFileUpload"
                :multiple="false"
                accept=".csv,.xlsx,.xls,.json"
                class="file-upload"
              >
                <a-button class="upload-btn" type="primary">
                  <template #icon><UploadOutlined /></template>
                  {{ t('selectFile') }}
                </a-button>
                <template #itemRender="{ file }">
                  <div class="uploaded-file">
                    <FileTextOutlined />
                    <span>{{ file.name }}</span>
                    <DeleteOutlined class="remove-file-btn" @click="removeFile(file)" />
                  </div>
                </template>
              </a-upload>
              <div class="file-format-hint">
                {{ t('supportedFormats') }}: CSV, Excel (.xlsx, .xls), JSON
              </div>
            </div>
          </div>

          <!-- JSON输入 -->
          <div v-if="selectedSourceType === 'json'" class="source-config">
            <div class="config-item">
              <label class="config-label">{{ t('inputJSON') }}</label>
              <div class="json-editor-container">
                <CodeEditor
                  ref="jsonEditorRef"
                  :value="jsonInput"
                  language="json"
                  @change="handleJsonChange"
                  class="json-editor"
                />
              </div>
              <div class="json-hint">
                {{ t('jsonFormatHint') }}
              </div>
            </div>
          </div>

          <!-- 数据预览 -->
          <div v-if="batchData.length > 0" class="data-preview">
            <h4>{{ t('dataPreview') }} ({{ batchData.length }} {{ t('items') }})</h4>
            <div class="preview-table">
              <a-table
                :columns="previewColumns"
                :data-source="batchData.slice(0, 5)"
                :pagination="false"
                size="small"
                class="preview-table-component"
              />
              <div v-if="batchData.length > 5" class="more-data">
                {{ t('andMoreItems', { count: batchData.length - 5 }) }}
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 步骤2: 数据映射 -->
      <div v-if="currentStep === 1" class="step-content">
        <div class="mapping-container">
          <div class="mapping-header">
            <h3 class="step-title" style="margin-bottom: 0">{{ t('mapDataFields') }}</h3>
            <div class="drag-tip-inline">
              <InfoCircleOutlined class="drag-tip-icon" />
              <span class="drag-tip-text">{{ t('dragTip') }}</span>
            </div>
          </div>

          <div class="mapping-layout">
            <!-- 左侧：可映射的数据源 -->
            <div class="mapping-source">
              <h4 class="mapping-section-title">{{ t('availableData') }}</h4>
              <div class="data-source-list">
                <div
                  v-for="field in availableFields"
                  :key="field.key"
                  class="data-field-item"
                  :title="field.preview"
                  draggable="true"
                  @dragstart="handleDragStart($event, field)"
                  @dragend="handleDragEnd"
                >
                  <div class="field-icon">
                    <DatabaseOutlined />
                  </div>
                  <div class="field-info">
                    <div class="field-name">{{ field.name }}</div>
                    <div class="field-key">{{ field.key }}</div>
                    <div class="field-type">{{ getFieldType(field) }}</div>
                  </div>
                  <div class="field-preview">{{ field.preview }}</div>
                </div>
              </div>
            </div>

            <!-- 中间：映射区域 -->
            <div class="mapping-center">
              <div class="mapping-arrow">
                <ArrowRightOutlined />
              </div>
            </div>

            <!-- 右侧：目标输入字段 -->
            <div class="mapping-target">
              <h4 class="mapping-section-title">{{ t('targetInputs') }}</h4>
              <div class="target-inputs-list">
                <div
                  v-for="input in state.inputs"
                  :key="input.id"
                  class="target-input-item"
                  :class="{ 'has-mapping': input.valueMap || input.manualValue !== undefined }"
                  @dragover="handleDragOver"
                  @drop="handleDrop($event, input)"
                >
                  <div class="input-header">
                    <div class="input-icon">
                      <EditOutlined />
                    </div>
                    <div class="input-info">
                      <div class="input-label">{{ input.label }}</div>
                      <div class="input-key">{{ input.key }}</div>
                      <div class="input-type">{{ input.valueType }}</div>
                    </div>
                  </div>

                  <!-- 映射显示 -->
                  <div v-if="input.valueMap" class="mapping-display">
                    <div class="mapped-field">
                      <DatabaseOutlined />
                      <span>{{ input.valueMap.name }}</span>
                      <span class="type-match" v-if="isTypeCompatible(input.valueMap, input)">
                        ✅ {{ t('typeMatch') }}
                      </span>
                      <span class="type-mismatch" v-else> ⚠️ {{ t('typeMismatch') }} </span>
                      <a-button
                        type="text"
                        size="small"
                        @click="removeMapping(input)"
                        class="remove-mapping"
                      >
                        <template #icon><CloseOutlined /></template>
                      </a-button>
                    </div>
                  </div>

                  <!-- 手动输入显示 -->
                  <div v-else-if="input.manualValue !== undefined" class="manual-input-display">
                    <div class="manual-field">
                      <EditOutlined />
                      <span>{{ t('manualValue') }}: {{ input.manualValue }}</span>
                      <a-button
                        type="text"
                        size="small"
                        @click="removeManualValue(input)"
                        class="remove-mapping"
                      >
                        <template #icon><CloseOutlined /></template>
                      </a-button>
                    </div>
                  </div>

                  <!-- 拖拽提示和手动输入 -->
                  <div v-else class="drop-zone">
                    <InboxOutlined />
                    <span>{{ t('dragFieldHere') }}</span>
                    <div class="manual-input-section">
                      <a-divider>{{ t('or') }}</a-divider>
                      <a-input
                        v-model:value="input.manualInputValue"
                        :placeholder="t('enterManualValue')"
                        size="small"
                        @press-enter="setManualValue(input)"
                        @blur="setManualValue(input)"
                      />
                      <a-button
                        type="primary"
                        size="small"
                        @click="setManualValue(input)"
                        class="manual-input-btn"
                      >
                        {{ t('setValue') }}
                      </a-button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 步骤3: 执行批量处理 -->
      <div v-if="currentStep === 2" class="step-content">
        <div class="execution-container">
          <h3 class="step-title">{{ t('executeBatchProcessing') }}</h3>

          <!-- 统计信息卡片 -->
          <div class="custom-stats-row">
            <div class="stat-card">
              <div class="stat-label">{{ t('totalItems') }}</div>
              <div class="stat-value">{{ executionProgress.total }}</div>
            </div>
            <div class="stat-card success">
              <div class="stat-label">{{ t('success') }}</div>
              <div class="stat-value">{{ executionProgress.success }}</div>
            </div>
            <div class="stat-card error">
              <div class="stat-label">{{ t('failed') }}</div>
              <div class="stat-value">{{ executionProgress.failed }}</div>
            </div>
            <div class="stat-card">
              <div class="stat-label">{{ t('processed') }}</div>
              <div class="stat-value">{{ executionProgress.processed }}</div>
            </div>
          </div>

          <!-- 开始项选择拖动条（原生input） -->
          <div class="native-slider-row" v-if="batchData.length > 1">
            <label class="native-slider-label">{{ t('startFromItemLabel') }}</label>
            <input
              type="range"
              min="1"
              :max="batchData.length"
              v-model="startFromIndex"
              :disabled="isExecuting"
              class="native-slider"
            />
            <span class="native-slider-value">{{ startFromIndex }} / {{ batchData.length }}</span>
          </div>

          <!-- 自动关闭计算机配置 -->
          <div class="auto-shutdown-config">
            <div class="shutdown-toggle">
              <a-switch v-model:checked="autoShutdownEnabled" class="shutdown-switch" />
              <div class="shutdown-info">
                <div class="shutdown-label">{{ t('autoShutdown') }}</div>
                <div class="shutdown-description">{{ t('autoShutdownDescription') }}</div>
                <div class="shutdown-note">
                  <InfoCircleOutlined class="shutdown-note-icon" />
                  <span>{{ t('autoShutdownNote') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 完成通知配置（Bark / Telegram / server酱 webhook） -->
          <div class="auto-shutdown-config">
            <div class="shutdown-toggle">
              <a-switch v-model:checked="notifyEnabled" class="shutdown-switch" />
              <div class="shutdown-info">
                <div class="shutdown-label">{{ t('notifyOnComplete') }}</div>
                <a-input
                  v-if="notifyEnabled"
                  v-model:value="notifyWebhookUrl"
                  :placeholder="t('notifyWebhookPlaceholder')"
                  size="small"
                  style="margin-top: 4px"
                />
                <div class="shutdown-note">
                  <InfoCircleOutlined class="shutdown-note-icon" />
                  <span>{{ t('notifyWebhookNote') }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 进度条 -->
          <div class="custom-progress-bar">
            <div
              class="custom-progress-inner"
              :style="{
                transform: `scaleX(${executionProgress.percent / 100})`,
                background: executionProgress.strokeColor,
              }"
            ></div>
            <span class="custom-progress-text">{{ executionProgress.percent }}%</span>
          </div>
          <div
            class="mb-2 eta-row"
            v-if="
              isExecuting &&
              executionProgress.processed > 0 &&
              executionProgress.processed < executionProgress.total
            "
          >
            ⏳ {{ t('estimatedRemaining') }}: {{ estimatedRemainingText }}
          </div>

          <!-- 当前处理项高亮 -->
          <div class="current-item-highlight" v-if="executionProgress.currentItem">
            <span>{{ t('currentProcessingLabel') }}</span>
            <span class="current-item-content">{{ executionProgress.currentItem }}</span>
          </div>

          <!-- 日志列表 -->
          <ul class="custom-log-list" v-if="executionLogs.length > 0">
            <li v-for="(log, idx) in executionLogs" :key="idx" :class="log.type">
              <span class="log-time">{{ log.time }}</span>
              <span class="log-message">{{ log.message }}</span>
            </li>
          </ul>

          <!-- 操作按钮 -->
          <div class="custom-actions">
            <button class="relative btn-primary" v-if="!isExecuting" @click="executeBatch">
              ▶️ {{ t('startBatchExecution') }}
            </button>
            <button class="btn-danger" v-else @click="stopExecution">
              ⏹️ {{ t('stopExecution') }}
            </button>
            <button class="btn-default" @click="openOutputDirectory">
              📂 {{ t('openOutputDirectory') }}
            </button>
            <button class="btn-default" v-if="executionLogs.length > 0" @click="clearLogs">
              🧹 {{ t('clearLogs') }}
            </button>
          </div>

          <!-- 排队等待提示 -->
          <div class="queue-waiting-tip" v-if="myJob && myJob.status === 'queued'">
            <span class="queue-waiting-dot"></span>
            <span>本任务已加入队列，前方还有 {{ queueWaitCount }} 个任务等待执行</span>
          </div>
        </div>

        <!-- 任务队列面板 -->
        <div class="task-queue-panel">
          <!-- 重启恢复后的暂停提示：需人工继续 -->
          <div class="queue-paused-banner" v-if="batchTaskStore.paused">
            <span class="queue-paused-text">应用重启后队列已暂停，排队任务不会自动执行</span>
            <a-button size="small" type="primary" @click="handleResumeQueue">▶ 继续执行</a-button>
          </div>
          <div class="queue-header">
            <h4 class="queue-title">📋 任务队列</h4>
            <div class="queue-header-actions">
              <a-button size="small" @click="goQueueDetail">📋 队列详情</a-button>
              <a-button
                size="small"
                danger
                v-if="batchTaskStore.isRunning"
                @click="stopAllExecution"
              >
                ⏹️ 停止全部
              </a-button>
              <a-button size="small" v-if="finishedCount > 0" @click="handleClearFinished">
                🧹 清空已完成
              </a-button>
            </div>
          </div>
          <div class="queue-empty" v-if="batchTaskStore.queue.length === 0">
            暂无任务，提交后自动排队依次执行
          </div>
          <div class="queue-list" v-else>
            <div
              class="queue-item"
              v-for="job in batchTaskStore.queue"
              :key="job.id"
              :class="job.status"
            >
              <div class="queue-item-head">
                <span class="queue-badge" :class="job.status">{{ statusText(job.status) }}</span>
                <span class="queue-app">{{ job.appName || '批量任务' }}</span>
                <span class="queue-meta">{{ job.processed }}/{{ job.total }}</span>
                <span class="queue-spacer"></span>
                <a-button size="small" v-if="job.status === 'queued'" @click="handleMoveTop(job.id)"
                  >置顶</a-button
                >
                <a-button
                  size="small"
                  danger
                  v-if="job.status === 'queued'"
                  @click="handleCancelJob(job.id)"
                  >删除出队</a-button
                >
                <a-button
                  size="small"
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
                  v-if="job.status === 'paused'"
                  @click="handleCancelJob(job.id)"
                  >删除</a-button
                >
                <a-button
                  size="small"
                  v-if="['completed', 'stopped', 'failed'].includes(job.status)"
                  @click="handleRerun(job)"
                  >🔁 重跑</a-button
                >
              </div>
              <div class="queue-progress">
                <div
                  class="queue-progress-fill"
                  :class="job.status"
                  :style="{ width: (job.percent || 0) + '%' }"
                ></div>
              </div>
              <div class="queue-item-foot">
                <span class="queue-preview" v-if="job.currentPreview" :title="job.currentPreview">{{
                  job.currentPreview
                }}</span>
                <span class="queue-stats">✓ {{ job.success }} · ✗ {{ job.failed }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- 步骤导航 -->
      <div class="step-navigation">
        <a-button v-if="currentStep > 0" @click="previousStep" class="nav-btn">
          <template #icon><LeftOutlined /></template>
          {{ t('previous') }}
        </a-button>

        <a-button
          v-if="currentStep < 2"
          type="primary"
          @click="nextStep"
          :disabled="!canProceed"
          class="nav-btn"
        >
          {{ t('next') }}
          <template #icon><RightOutlined /></template>
        </a-button>
      </div>
    </div>
  </div>

  <!-- 执行记录弹窗 -->
  <a-modal
    v-model:open="showHistoryDialog"
    :title="t('executionHistoryTitle')"
    width="820px"
    :footer="null"
  >
    <div class="history-dialog">
      <div v-if="historyRecords.length === 0" class="history-empty">
        {{ t('noExecutionRecords') }}
      </div>
      <div v-else class="history-list">
        <div class="history-item" v-for="rec in historyRecords" :key="rec.id">
          <div class="history-head">
            <div class="title">
              <span class="name">{{ rec.appName || t('app') }}</span>
              <span class="status" :class="rec.status">{{ getStatusText(rec.status) }}</span>
            </div>
            <div class="meta">
              <span>{{ t('createdAt') }}: {{ new Date(rec.createdAt).toLocaleString() }}</span>
              <span>{{ t('updatedAt') }}: {{ new Date(rec.updatedAt).toLocaleString() }}</span>
            </div>
          </div>
          <div class="history-body">
            <div class="row">
              <span>{{ t('totalCount') }}: {{ rec.total }}</span>
              <span>{{ t('successCount') }}: {{ rec.success }}</span>
              <span>{{ t('failedCount') }}: {{ rec.failed }}</span>
              <span>{{ t('progressPercent') }}: {{ rec.percent }}%</span>
              <span>{{ t('startIndex') }}: {{ rec.startFromIndex }}</span>
              <span>{{ t('lastCompleted') }}: {{ rec.lastIndexProcessed }}</span>
            </div>
            <div class="mini-progress">
              <div class="mini-progress-inner" :style="{ width: (rec.percent || 0) + '%' }"></div>
              <span class="mini-progress-text">{{ rec.percent }}%</span>
            </div>
            <div class="row logs" v-if="rec.logs && rec.logs.length">
              <span class="log" v-for="(lg, i) in rec.logs.slice(0, 3)" :key="i">
                [{{ lg.time }}] {{ lg.type }}: {{ lg.message }}
              </span>
              <span v-if="rec.logs.length > 3">…</span>
            </div>
          </div>
          <div class="history-actions">
            <a-button size="small" type="primary" @click="restoreFromRecord(rec)">{{
              t('continueFromLast')
            }}</a-button>
            <a-button size="small" danger @click="deleteHistoryRecord(rec.id)">{{
              t('deleteRecord')
            }}</a-button>
          </div>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { reactive, ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { Modal } from 'ant-design-vue'
import { ComfyUIClient } from '@artifyfun/comfy-ui-client'
import { useAppStore } from '@/stores/appStore'
import { genMeta } from '@/utils/genPrompt'
import { t } from '@/utils/i18n'
import { showError, showSuccess, showInfo, uuidv4, getSeed, debounce } from '@/utils'
import CodeEditor from '@/components/CodeEditor/index.vue'
import { ExcelProcessor } from '@/utils/excel-utils'
import localforage from 'localforage'
import { useBatchTaskStore } from '@/stores/batchTaskStore'
import {
  FolderOpenOutlined,
  FileTextOutlined,
  CodeOutlined,
  UploadOutlined,
  DeleteOutlined,
  FileOutlined,
  DatabaseOutlined,
  EditOutlined,
  ArrowRightOutlined,
  InboxOutlined,
  CloseOutlined,
  LeftOutlined,
  RightOutlined,
  FolderOutlined,
  PictureOutlined,
  FilePdfOutlined,
  FileWordOutlined,
  FileExcelOutlined,
  FilePptOutlined,
  VideoCameraOutlined,
  SoundOutlined,
  InfoCircleOutlined,
} from '@ant-design/icons-vue'

const state = reactive({
  inputs: [],
  clientId: uuidv4(),
})

const appStore = useAppStore()
const batchTaskStore = useBatchTaskStore()
const router = useRouter()

const currentApp = ref(null)

// 步骤控制
const currentStep = ref(0)

// 批量来源相关
const selectedSourceType = ref('directory')
const directoryPath = ref('')
const directoryFiles = ref([])
const fileFilter = ref('all') // 文件过滤选项
const uploadedFiles = ref([])
const jsonInput = ref('[]')
const jsonEditorRef = ref(null)

const client = ref(null)

const getClient = () => {
  if (!client.value) {
    client.value = new ComfyUIClient(appStore.config.comfyHost, state.clientId, {
      logger: { info: () => {}, warn: () => {}, error: console.error, debug: () => {} },
    })
  }
  return client.value
}

// 批量数据
const batchData = ref([])
const availableFields = ref([])

// 映射相关
const draggedField = ref(null)

// 执行相关
const isExecuting = ref(false)
const startFromIndex = ref(1) // 新增：开始执行的位置
const autoShutdownEnabled = ref(false) // 新增：自动关闭计算机开关
const notifyEnabled = ref(false) // 新增：完成通知开关
const notifyWebhookUrl = ref('') // 新增：Bark/Telegram/server酱 webhook URL

// 队列相关：本页提交的任务 id（可能排队等待，也可能在跑）
const currentJobId = ref(null)
const myJob = computed(() => batchTaskStore.queue.find((j) => j.id === currentJobId.value) ?? null)
// 排在我前面的排队任务数
const queueWaitCount = computed(() => {
  const idx = batchTaskStore.queue.findIndex((j) => j.id === currentJobId.value)
  if (idx === -1) return 0
  return batchTaskStore.queue.slice(0, idx).filter((j) => j.status === 'queued').length
})
const finishedCount = computed(
  () =>
    batchTaskStore.queue.filter((j) => !['queued', 'running', 'paused'].includes(j.status)).length,
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

const executionProgress = reactive({
  total: 0,
  processed: 0,
  success: 0,
  failed: 0,
  percent: 0,
  status: 'normal',
  strokeColor: '#10b981',
  currentItem: '',
})
const executionLogs = ref([]) // 新增：执行日志
// 日志上限：长任务下 unshift 无限增长会拖垮内存与渲染，超限丢弃最旧（尾部）
const EXECUTION_LOGS_MAX = 500
watch(executionLogs, (logs) => {
  if (logs.length > EXECUTION_LOGS_MAX) {
    logs.splice(EXECUTION_LOGS_MAX)
  }
})

// 预计剩余时间统计
const executionTimeStats = reactive({
  totalMs: 0,
  count: 0,
})

const averageItemMs = computed(() => {
  return executionTimeStats.count > 0 ? executionTimeStats.totalMs / executionTimeStats.count : 0
})

const estimatedRemainingMs = computed(() => {
  const remaining = Math.max(executionProgress.total - executionProgress.processed, 0)
  return Math.round(remaining * averageItemMs.value)
})

const estimatedRemainingText = computed(() => formatDuration(estimatedRemainingMs.value))

function nowMs() {
  try {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now()
    }
  } catch (_) {}
  return Date.now()
}

function formatDuration(ms) {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return t('lessThanOneSecond')
  const totalSeconds = Math.max(1, Math.floor(ms / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  const parts = []
  if (days) parts.push(`${days}${t('dayUnit')}`)
  if (hours) parts.push(`${hours}${t('hourUnit')}`)
  if (minutes) parts.push(`${minutes}${t('minuteUnit')}`)
  if (seconds && parts.length < 3) parts.push(`${seconds}${t('secondUnit')}`)
  return parts.length ? parts.join(t('timeUnitSeparator')) : t('lessThanOneSecond')
}

// ===== 执行记录（localforage） =====
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
// ===== 队列级配置（关机/通知）：与浮层/详情页共用一份，变更即时应用到后端 =====
async function loadQueueConfig() {
  await batchTaskStore.loadQueueConfig()
  autoShutdownEnabled.value = batchTaskStore.queueConfig.autoShutdown
  notifyEnabled.value = batchTaskStore.queueConfig.notifyEnabled
  notifyWebhookUrl.value = batchTaskStore.queueConfig.notifyUrl
}
function syncQueueConfig() {
  batchTaskStore.setQueueConfig({
    autoShutdown: autoShutdownEnabled.value,
    notifyEnabled: notifyEnabled.value,
    notifyUrl: notifyWebhookUrl.value,
  })
}
// URL 输入防抖应用（避免每敲一个字符就打一次后端）
const debouncedApplyQueueConfig = debounce(() => {
  syncQueueConfig()
  batchTaskStore.applyQueueConfig()
}, 800)
let queueConfigLoaded = false
watch(autoShutdownEnabled, () => {
  if (!queueConfigLoaded) return
  syncQueueConfig()
  batchTaskStore.applyQueueConfig()
})
watch(notifyEnabled, () => {
  if (!queueConfigLoaded) return
  syncQueueConfig()
  batchTaskStore.applyQueueConfig()
})
watch(notifyWebhookUrl, () => {
  if (!queueConfigLoaded) return
  debouncedApplyQueueConfig()
})

function deepClone(obj) {
  return JSON.parse(JSON.stringify(obj))
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

function restoreFromRecord(rec) {
  if (!rec) return
  // 恢复源与数据、映射
  selectedSourceType.value = rec.batchSource?.type || 'json'
  directoryPath.value = rec.batchSource?.directoryPath || ''
  fileFilter.value = rec.batchSource?.fileFilter || 'all'
  jsonInput.value = rec.batchSource?.jsonInput || '[]'
  batchData.value = Array.isArray(rec.batchData) ? deepClone(rec.batchData) : []
  state.inputs = Array.isArray(rec.inputsMapping) ? deepClone(rec.inputsMapping) : state.inputs
  updateAvailableFields()
  // 继续索引：lastIndexProcessed 是 1-based 已完成项，续跑应从「下一项」开始，
  // 否则会重跑最后一项（固定 seed 工作流会产生重复输出）。
  const nextIndex = Math.min((rec.lastIndexProcessed || 0) + 1, batchData.value.length)
  startFromIndex.value = Math.max(1, nextIndex)
  currentStep.value = 2
  showHistoryDialog.value = false
}

// 计算属性
const canProceed = computed(() => {
  switch (currentStep.value) {
    case 0:
      return batchData.value.length > 0
    case 1:
      return state.inputs.some((input) => input.valueMap || input.manualValue !== undefined)
    default:
      return true
  }
})

// 文件计数统计
const fileCounts = computed(() => {
  const counts = {
    files: 0,
    directories: 0,
    images: 0,
    videos: 0,
    audios: 0,
    texts: 0,
    documents: 0,
  }

  directoryFiles.value.forEach((file) => {
    if (file.isDirectory) {
      counts.directories++
    } else {
      counts.files++

      const fileName = file.name.toLowerCase()
      if (fileTypes.images.some((ext) => fileName.endsWith(ext))) {
        counts.images++
      } else if (fileTypes.videos.some((ext) => fileName.endsWith(ext))) {
        counts.videos++
      } else if (fileTypes.audios.some((ext) => fileName.endsWith(ext))) {
        counts.audios++
      } else if (fileTypes.texts.some((ext) => fileName.endsWith(ext))) {
        counts.texts++
      } else if (fileTypes.documents.some((ext) => fileName.endsWith(ext))) {
        counts.documents++
      }
    }
  })

  return counts
})

// 文件类型定义
const fileTypes = {
  images: [
    '.jpg',
    '.jpeg',
    '.png',
    '.gif',
    '.bmp',
    '.webp',
    '.svg',
    '.ico',
    '.tiff',
    '.tif',
    '.jfif',
  ],
  videos: [
    '.mp4',
    '.avi',
    '.mov',
    '.wmv',
    '.flv',
    '.webm',
    '.mkv',
    '.m4v',
    '.3gp',
    '.ogv',
    '.ts',
    '.mts',
    '.m2ts',
    '.vob',
    '.asf',
    '.rm',
    '.rmvb',
    '.divx',
    '.xvid',
  ],
  audios: [
    '.mp3',
    '.wav',
    '.flac',
    '.aac',
    '.ogg',
    '.wma',
    '.m4a',
    '.opus',
    '.aiff',
    '.au',
    '.ra',
    '.mid',
    '.midi',
    '.amr',
    '.ape',
    '.alac',
    '.wv',
  ],
  texts: [
    '.txt',
    '.md',
    '.json',
    '.xml',
    '.html',
    '.htm',
    '.css',
    '.js',
    '.ts',
    '.jsx',
    '.tsx',
    '.vue',
    '.py',
    '.java',
    '.cpp',
    '.c',
    '.h',
    '.php',
    '.rb',
    '.go',
    '.rs',
    '.swift',
    '.kt',
    '.scala',
    '.sql',
    '.sh',
    '.bat',
    '.ps1',
    '.yaml',
    '.yml',
    '.toml',
    '.ini',
    '.cfg',
    '.conf',
    '.log',
  ],
  documents: [
    '.pdf',
    '.doc',
    '.docx',
    '.xls',
    '.xlsx',
    '.ppt',
    '.pptx',
    '.odt',
    '.ods',
    '.odp',
    '.rtf',
    '.csv',
  ],
}

// 过滤后的文件列表
const filteredDirectoryFiles = computed(() => {
  if (fileFilter.value === 'all') {
    return directoryFiles.value
  }

  const filterMap = {
    files: (file) => !file.isDirectory,
    directories: (file) => file.isDirectory,
    images: (file) =>
      !file.isDirectory && fileTypes.images.some((ext) => file.name.toLowerCase().endsWith(ext)),
    videos: (file) =>
      !file.isDirectory && fileTypes.videos.some((ext) => file.name.toLowerCase().endsWith(ext)),
    audios: (file) =>
      !file.isDirectory && fileTypes.audios.some((ext) => file.name.toLowerCase().endsWith(ext)),
    texts: (file) =>
      !file.isDirectory && fileTypes.texts.some((ext) => file.name.toLowerCase().endsWith(ext)),
    documents: (file) =>
      !file.isDirectory && fileTypes.documents.some((ext) => file.name.toLowerCase().endsWith(ext)),
  }

  const filterFn = filterMap[fileFilter.value]
  return filterFn ? directoryFiles.value.filter(filterFn) : directoryFiles.value
})

const previewColumns = computed(() => {
  if (batchData.value.length === 0) return []

  const firstItem = batchData.value[0]
  return Object.keys(firstItem).map((key) => {
    const column = {
      title: key,
      dataIndex: key,
      key: key,
      ellipsis: true,
    }

    // 根据字段类型设置不同的宽度和格式化
    switch (key) {
      case 'fileName':
        column.width = 200
        break
      case 'filePath':
        column.width = 300
        break
      case 'relativePath':
        column.width = 250
        break
      case 'fileSize':
        column.width = 100
        column.customRender = ({ text }) => formatFileSize(text)
        break
      case 'lastModified':
        column.width = 150
        column.customRender = ({ text }) => new Date(text).toLocaleString()
        break
      case 'isDirectory':
        column.width = 80
        column.customRender = ({ text }) => (text ? 'true' : 'false')
        break
      case 'fileExtension':
        column.width = 80
        break
      case 'fileNameWithoutExt':
        column.width = 150
        break
      default:
        column.width = 120
    }

    return column
  })
})

// 初始化
async function init() {
  await appStore.initConfig()
  const app = await appStore.getAppById(appStore.config.activeAppId)
  currentApp.value = app
  if (!app) {
    // activeAppId 失效（应用被删除等）：避免 genMeta(null) 解构抛错导致整页白屏。
    console.error('当前应用不存在: activeAppId =', appStore.config.activeAppId)
    showError('currentAppNotFound')
    return
  }
  const inputs = genMeta(currentApp.value)
    .components.children.filter((node) => ['form-item'].includes(node.componentName))
    .map((node) => {
      return {
        id: node.id,
        key: node.props.key,
        label: node.props.label,
        valueType: node.props.valueType || 'undefined',
        valueMap: null,
        manualValue: undefined,
        manualInputValue: '',
      }
    })

  state.inputs = inputs
  // 加载当前应用的执行记录
  await ensureHistoryLoaded()
}

// 选择目录
async function selectDirectory() {
  try {
    if (window.electronAPI) {
      const result = await window.electronAPI.ArtifyLab.selectFile()
      if (!result) return

      directoryPath.value = result
      await scanDirectory(result)
    } else {
      showError('electronNotAvailable')
    }
  } catch (error) {
    console.error('选择目录失败:', error)
    showError('selectDirectoryFailed')
  }
}

// 扫描目录
async function scanDirectory(path) {
  try {
    if (window.electronAPI) {
      const files = await window.electronAPI.ArtifyLab.scanFolder(path)
      directoryFiles.value = files.map((file) => ({
        name: file.fileName,
        path: file.fullPath,
        size: file.size,
        type: file.isDirectory ? 'directory' : 'file',
        extension: file.extension,
        isDirectory: file.isDirectory,
        lastModified: file.lastModified,
        relativePath: file.relativePath,
      }))

      // 生成批量数据
      generateBatchDataFromFiles()
    }
  } catch (error) {
    console.error('扫描目录失败:', error)
    showError('scanDirectoryFailed')
  }
}

// 从文件生成批量数据
function generateBatchDataFromFiles() {
  batchData.value = filteredDirectoryFiles.value.map((file) => ({
    fileName: file.name,
    filePath: file.path,
    fileSize: file.size,
    fileType: file.type,
    fileExtension: file.extension,
    // file.extension 来自 path.extname，含前导点（'.jpg'），按其本身长度截断即可，
    // 之前用 length+1 会多砍一个字符（photo.jpg → phot）。
    fileNameWithoutExt: file.extension ? file.name.slice(0, -file.extension.length) : file.name,
    isDirectory: file.isDirectory,
    lastModified: file.lastModified,
    relativePath: file.relativePath,
  }))

  updateAvailableFields()
}

// 文件上传处理
function beforeFileUpload(file) {
  // 使用ExcelProcessor验证文件
  if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
    const validation = ExcelProcessor.validateExcelFile(file)
    if (!validation.isValid) {
      showError(validation.errors[0])
      return false
    }
  } else {
    // 其他文件类型验证
    const isValidType = ['text/csv', 'application/json'].includes(file.type)
    if (!isValidType) {
      showError('unsupportedFileType')
      return false
    }

    const isLt10M = file.size / 1024 / 1024 < 10
    if (!isLt10M) {
      showError('fileTooLarge')
      return false
    }
  }

  return false // 阻止自动上传，手动处理
}

// 处理文件上传
async function handleFileUpload(file) {
  try {
    if (file.name.endsWith('.xlsx') || file.name.endsWith('.xls')) {
      // Excel文件处理
      await parseExcelFile(file)
    } else {
      // 其他文件处理
      const reader = new FileReader()
      reader.onload = (e) => {
        const content = e.target.result
        parseFileContent(content, file.name)
      }
      reader.readAsText(file)
    }
  } catch (error) {
    console.error('文件处理失败:', error)
    showError('fileProcessingFailed')
  }
}

// 解析文件内容
function parseFileContent(content, fileName) {
  try {
    let data = []

    if (fileName.endsWith('.json')) {
      data = JSON.parse(content)
    } else if (fileName.endsWith('.csv')) {
      data = parseCSV(content)
    } else {
      showError('unsupportedFileType')
      return
    }

    if (Array.isArray(data)) {
      batchData.value = data
      updateAvailableFields()
      showSuccess('fileParsedSuccessfully')
    } else {
      showError('invalidDataFormat')
    }
  } catch (error) {
    console.error('解析文件失败:', error)
    showError('fileParseFailed')
  }
}

// 解析Excel文件
async function parseExcelFile(file) {
  try {
    // 使用ExcelProcessor解析文件
    const result = await ExcelProcessor.parseExcelFile(file, {
      sheetIndex: 0, // 使用第一个工作表
      headerRow: 0, // 第一行作为表头
      dataStartRow: 1, // 从第二行开始读取数据
      maxRows: 10000, // 最大读取10000行
      includeEmptyRows: false, // 不包含空行
      dateFormat: 'YYYY-MM-DD', // 日期格式
      numberFormat: 'string', // 数字转换为字符串
    })

    batchData.value = result.data
    updateAvailableFields()
    showSuccess('excelFileParsedSuccessfully')

    // 显示文件信息
    console.log('Excel文件解析成功:', {
      sheetName: result.sheetName,
      totalRows: result.totalRows,
      headers: result.headers,
    })

    return result.data
  } catch (error) {
    console.error('Excel文件解析失败:', error)
    showError('excelParseFailed')
    throw error
  }
}

// 解析CSV
function parseCSV(content) {
  const lines = content.split('\n')
  const headers = lines[0].split(',').map((h) => h.trim())
  const data = []

  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim()) {
      const values = lines[i].split(',').map((v) => v.trim())
      const item = {}
      headers.forEach((header, index) => {
        item[header] = values[index] || ''
      })
      data.push(item)
    }
  }

  return data
}

// 移除文件
function removeFile(file) {
  const index = uploadedFiles.value.findIndex((f) => f.uid === file.uid)
  if (index > -1) {
    uploadedFiles.value.splice(index, 1)
  }
}

// JSON输入处理
function handleJsonChange(value) {
  jsonInput.value = value
  try {
    const data = JSON.parse(value)
    if (Array.isArray(data)) {
      batchData.value = data
      updateAvailableFields()
    }
  } catch (error) {
    // JSON格式错误时不更新数据
  }
}

// 更新可用字段
function updateAvailableFields() {
  if (batchData.value.length === 0) {
    availableFields.value = []
    return
  }

  const firstItem = batchData.value[0]
  availableFields.value = Object.keys(firstItem).map((key) => ({
    key: key,
    name: key,
    preview:
      String(firstItem[key]).substring(0, 128) + (String(firstItem[key]).length > 128 ? '...' : ''),
  }))
}

// 拖拽处理
function handleDragStart(event, field) {
  draggedField.value = field
  event.dataTransfer.effectAllowed = 'move'
}

function handleDragEnd() {
  draggedField.value = null
}

function handleDragOver(event) {
  event.preventDefault()
  event.dataTransfer.dropEffect = 'move'
}

function handleDrop(event, input) {
  event.preventDefault()
  if (draggedField.value) {
    // 检查类型兼容性
    if (isTypeCompatible(draggedField.value, input)) {
      input.valueMap = draggedField.value
      input.manualValue = undefined // 清除手动输入
      input.manualInputValue = '' // 清除手动输入框
      draggedField.value = null
    } else {
      // 类型不匹配时显示警告
      showError('typeMismatchError', {
        fieldName: draggedField.value.name,
        fieldType: getFieldType(draggedField.value),
        inputType: input.valueType,
      })
    }
  }
}

// 移除映射
function removeMapping(input) {
  input.valueMap = null
}

// 设置手动输入值
function setManualValue(input) {
  if (input.manualInputValue && input.manualInputValue.trim()) {
    try {
      // 根据目标类型进行转换
      input.manualValue = convertValueByType(input.manualInputValue.trim(), input.valueType)
      input.valueMap = null // 清除映射
    } catch (error) {
      showError('valueConversionError', {
        value: input.manualInputValue,
        targetType: input.valueType,
        error: error.message,
      })
    }
  }
}

// 移除手动输入值
function removeManualValue(input) {
  input.manualValue = undefined
  input.manualInputValue = ''
}

// 获取字段类型
function getFieldType(field) {
  if (batchData.value.length === 0) return 'unknown'

  const firstItem = batchData.value[0]
  const value = firstItem[field.key]
  return Object.prototype.toString.call(value).slice(8, -1).toLowerCase()
}

// 检查类型兼容性
function isTypeCompatible(field, input) {
  const fieldType = getFieldType(field)
  const targetType = input.valueType

  // 类型兼容性映射
  const typeCompatibility = {
    string: ['string'], // string只能映射到string
    number: ['number', 'string'], // number可以映射到number或string
    boolean: ['boolean', 'string'], // boolean可以映射到boolean或string
    object: ['object', 'string'], // object可以映射到object或string
    array: ['array', 'string'], // array可以映射到array或string
    null: ['string', 'number', 'boolean', 'object', 'array'], // null可以映射到任何类型
    undefined: ['string', 'number', 'boolean', 'object', 'array'], // undefined可以映射到任何类型
  }

  return (
    typeCompatibility[fieldType]?.includes(targetType) ||
    fieldType === targetType ||
    targetType === 'undefined'
  )
}

// 根据目标类型转换值
function convertValueByType(value, targetType) {
  switch (targetType) {
    case 'string':
      return String(value)

    case 'number':
      const num = Number(value)
      if (isNaN(num)) {
        throw new Error(`Cannot convert "${value}" to number`)
      }
      return num

    case 'boolean':
      if (typeof value === 'boolean') return value
      const lowerValue = String(value).toLowerCase()
      if (['true', '1', 'yes', 'on'].includes(lowerValue)) return true
      if (['false', '0', 'no', 'off'].includes(lowerValue)) return false
      throw new Error(`Cannot convert "${value}" to boolean`)

    case 'object':
      try {
        return JSON.parse(value)
      } catch {
        throw new Error(`Cannot convert "${value}" to object`)
      }

    case 'array':
      try {
        const parsed = JSON.parse(value)
        if (Array.isArray(parsed)) return parsed
        throw new Error(`Value is not an array`)
      } catch {
        throw new Error(`Cannot convert "${value}" to array`)
      }

    default:
      return value
  }
}

// 步骤导航
function nextStep() {
  if (currentStep.value < 2) {
    currentStep.value++
  }
}

function previousStep() {
  if (currentStep.value > 0) {
    currentStep.value--
  }
}

function getPrompt(data) {
  const prompt = JSON.parse(JSON.stringify(currentApp.value.template.prompt))
  Object.keys(prompt).forEach((key) => {
    const item = prompt[key]
    if (typeof item.inputs?.seed === 'number') {
      item.inputs.seed = getSeed(15)
    }
  })
  state.inputs.forEach((node) => {
    let value = prompt[node.id].inputs[node.key] // 默认值

    if (node.valueMap) {
      // 使用映射的字段值
      const rawValue = data[node.valueMap.key]
      if (rawValue !== undefined) {
        try {
          // 根据目标类型进行转换
          value = convertValueByType(rawValue, node.valueType)
        } catch (error) {
          console.warn(`Type conversion failed for ${node.key}:`, error)
          value = rawValue // 使用原始值作为后备
        }
      }
    } else if (node.manualValue !== undefined) {
      // 使用手动输入的值
      value = node.manualValue
    }

    prompt[node.id].inputs[node.key] = value
  })
  return prompt
}

// 将任意异常转为可读文本（Event/Error/字符串等），避免日志显示 "[object Event]"
function toErrorMessage(err) {
  if (err instanceof Error) return err.message || String(err)
  if (err && typeof err === 'object') {
    if (typeof err.message === 'string') return err.message
    if (typeof err.type === 'string') return `${err.type} 事件错误`
    try {
      return JSON.stringify(err)
    } catch {
      return '未知错误'
    }
  }
  return String(err)
}

const getOutputs = async (prompt) => {
  const client = getClient()
  try {
    await client.connect()
    // comfy-ui-client >= 0.4: getResult() 已移除，等价物 waitForPrompt()
    const result = await client.waitForPrompt(prompt)
    client.disconnect() // 0.4+ 同步且幂等
    return result
  } catch (error) {
    console.log(error)
    client.disconnect()
    throw error
  }
}

function interrupt() {
  const client = getClient()
  return client.interrupt()
}

// 执行批量处理
async function executeBatch() {
  if (!currentApp.value?.template?.prompt) {
    showError('batchExecutionFailed')
    return
  }

  executionProgress.status = 'normal'
  executionProgress.strokeColor = '#10b981'
  executionProgress.currentItem = ''
  executionLogs.value = []

  try {
    // 提交到 main 进程队列引擎：运行中也能入队，排队等待执行
    const data = await batchTaskStore.submit({
      prompt: JSON.parse(JSON.stringify(currentApp.value.template.prompt)),
      inputsMapping: deepClone(state.inputs),
      items: deepClone(batchData.value),
      startFrom: startFromIndex.value,
      notifyUrl: notifyEnabled.value ? notifyWebhookUrl.value.trim() : '',
      autoShutdown: autoShutdownEnabled.value,
      appId: currentApp.value.id,
      appName: currentApp.value.name,
    })
    currentJobId.value = data.jobId
    isExecuting.value = true
    executionProgress.total = batchData.value.length
    executionProgress.processed = startFromIndex.value - 1
    // 新建一条执行历史（含完整源数据/映射/批量数据），后续轮询增量更新
    currentHistoryRecordId.value = await createNewHistoryRecord()
    if (queueWaitCount.value > 0) {
      showInfo(`已加入任务队列，前方还有 ${queueWaitCount.value} 个任务等待执行`)
    } else {
      showSuccess('batchExecutionStarted')
    }

    // 本页监控：轮询 store 同步进度（离开页面无碍，浮层/再进页面仍可看）
    watchBatchTask()
  } catch (error) {
    console.error('批量任务提交失败:', error)
    showError('batchExecutionFailed')
    executionProgress.status = 'exception'
    executionProgress.strokeColor = '#ef4444'
  }
}

// 监听常驻任务：同步到本页进度 UI + 落历史记录（按本页提交的任务 jobId 过滤）
let batchWatchStop = null
function watchBatchTask() {
  if (batchWatchStop) batchWatchStop()
  let lastResultCount = 0
  let queuedLogged = false
  const unwatch = watch(
    () => (myJob.value ? myJob.value.updatedAt : 0) + (myJob.value?.status || ''),
    async () => {
      const job = myJob.value
      if (!job) return

      // 排队中：只提示，不同步进度（进度是别的任务的）
      if (job.status === 'queued') {
        if (!queuedLogged) {
          queuedLogged = true
          executionLogs.value.unshift({
            time: new Date().toLocaleTimeString(),
            message: `已加入队列，等待执行（前方 ${queueWaitCount.value} 个任务）`,
            type: 'info',
          })
        }
        isExecuting.value = true
        return
      }
      queuedLogged = false

      executionProgress.total = job.total
      executionProgress.processed = job.processed
      executionProgress.success = job.success
      executionProgress.failed = job.failed
      executionProgress.percent = job.percent
      executionProgress.currentItem = job.currentPreview
      if (job.currentPreview && job.status === 'running') {
        executionLogs.value.unshift({
          time: new Date().toLocaleTimeString(),
          message: job.currentPreview,
          type: 'info',
        })
      }

      // 增量写入执行历史：新完成的 item 追加到 history.results
      if (currentHistoryRecordId.value && Array.isArray(job.results)) {
        const newResults = job.results.slice(lastResultCount)
        lastResultCount = job.results.length
        for (const r of newResults) {
          await upsertHistoryRecord({
            id: currentHistoryRecordId.value,
            resultItem: {
              index: r.index,
              success: r.success,
              error: r.error,
              durationMs: r.durationMs,
            },
          })
        }
        await upsertHistoryRecord({
          id: currentHistoryRecordId.value,
          processed: job.processed,
          success: job.success,
          failed: job.failed,
          percent: job.percent,
          logs: job.currentPreview
            ? [{ time: new Date().toLocaleTimeString(), message: job.currentPreview, type: 'info' }]
            : undefined,
        })
      }

      if (job.status !== 'running') {
        isExecuting.value = false
        if (job.status === 'paused') {
          // 暂停中：进度保持，不当作终态；保留监控以便"继续"后恢复同步
          executionProgress.status = 'exception'
          executionProgress.strokeColor = '#fbbf24'
          executionProgress.currentItem = job.currentPreview
          return
        }
        executionProgress.status = job.status === 'completed' ? 'success' : 'exception'
        executionProgress.strokeColor = job.status === 'completed' ? '#10b981' : '#ef4444'
        executionProgress.currentItem = ''
        if (job.status === 'completed') {
          showSuccess('batchExecutionCompleted', {
            total: job.total,
            success: job.success,
            failed: job.failed,
          })
        }
        if (currentHistoryRecordId.value) {
          await upsertHistoryRecord({
            id: currentHistoryRecordId.value,
            status:
              job.status === 'completed'
                ? 'completed'
                : job.status === 'stopped'
                  ? 'stopped'
                  : 'failed',
            processed: job.processed,
            success: job.success,
            failed: job.failed,
            percent: job.percent,
          })
        }
        if (batchWatchStop) batchWatchStop()
      }
    },
    { deep: false },
  )
  batchWatchStop = unwatch
}

// 刷新页面/重新进入时恢复本 app 运行中/排队任务的历史记录绑定
async function restoreRunningTask() {
  await batchTaskStore.fetchQueue()
  await ensureHistoryLoaded()
  // 优先恢复本 app 的运行中任务，其次排队任务
  const candidate =
    batchTaskStore.queue.find((j) => j.status === 'running' && j.appId === currentApp.value?.id) ||
    batchTaskStore.queue.find((j) => j.status === 'queued' && j.appId === currentApp.value?.id)
  if (!candidate) return
  currentJobId.value = candidate.id
  const record = historyRecords.value.find((r) => r.taskId === candidate.id)
  if (record) {
    currentHistoryRecordId.value = record.id
  }
  isExecuting.value = true
  executionProgress.total = candidate.total
  executionProgress.processed = candidate.processed
  executionProgress.success = candidate.success
  executionProgress.failed = candidate.failed
  executionProgress.percent = candidate.percent
  executionProgress.currentItem = candidate.currentPreview
  batchTaskStore.startPolling()
  watchBatchTask()
}

// 停止执行（只停当前任务，队列中后续任务继续）
async function stopExecution() {
  // 先停 main 进程常驻引擎（interrupt 已由后端执行）
  try {
    await batchTaskStore.stop()
  } catch (e) {
    console.error('stop batch runner 失败:', e)
  }
  // 停止动作各自隔离捕获：一个失败不能掩盖另一个，且 interrupt/unload 失败要可见。
  try {
    await interrupt()
  } catch (e) {
    console.error('interrupt 失败:', e)
  }
  try {
    await unloadModel()
  } catch (e) {
    console.error('卸载模型失败:', e)
  }
  // 立即设置停止状态，防止继续执行
  isExecuting.value = false

  showInfo('executionStopped')

  // 更新进度状态
  executionProgress.status = 'exception'
  executionProgress.strokeColor = '#ef4444'
  executionProgress.currentItem = ''

  // 添加停止日志
  executionLogs.value.unshift({
    time: new Date().toLocaleTimeString(),
    message: t('executionStoppedByUser') + '（队列中后续任务继续执行）',
    type: 'info',
  })

  // 标记记录已停止
  await upsertHistoryRecord({
    id: currentHistoryRecordId.value,
    status: 'stopped',
    currentItem: '',
  })
}

// 停止全部：中断当前任务 + 取消所有排队任务
async function stopAllExecution() {
  try {
    await batchTaskStore.stopAll()
  } catch (e) {
    console.error('stop all batch 失败:', e)
  }
  isExecuting.value = false
  showInfo('已停止全部批量任务')
  executionLogs.value.unshift({
    time: new Date().toLocaleTimeString(),
    message: '已停止全部任务（含排队中的任务）',
    type: 'info',
  })
  await upsertHistoryRecord({
    id: currentHistoryRecordId.value,
    status: 'stopped',
    currentItem: '',
  })
}

// 队列操作
async function handleResumeQueue() {
  await batchTaskStore.resume()
  showSuccess('已恢复队列，排队任务开始依次执行')
}
async function handleCancelJob(id) {
  await batchTaskStore.cancel(id)
  if (currentJobId.value === id) {
    currentJobId.value = null
    isExecuting.value = false
  }
  showInfo('已取消该任务')
}
async function handlePauseJob(id) {
  await batchTaskStore.pauseJob(id)
  if (currentJobId.value === id) {
    isExecuting.value = false
  }
  showInfo('已暂停，可点击"继续"从进度处恢复')
}
async function handleResumeJob(id) {
  await batchTaskStore.resumeJob(id)
  if (currentJobId.value === id) {
    isExecuting.value = true
  }
  showInfo('已继续执行')
}
async function handleStopJob() {
  await batchTaskStore.stop()
  isExecuting.value = false
  showInfo('executionStopped')
}
async function handleMoveTop(id) {
  await batchTaskStore.moveTop(id)
  showInfo('已置顶')
}
async function handleClearFinished() {
  await batchTaskStore.clearFinished()
}
function goQueueDetail() {
  router.push('/batch/detail')
}

/** 一键重跑：完整复刻原配置重新入队（无需重新编排队列） */
function handleRerun(job) {
  Modal.confirm({
    title: '重新运行批量任务',
    content: `将按「${job.appName || '批量任务'}」的原配置（数据 ${job.total} 条、映射与开始位置）重新入队执行一遍，确定？`,
    okText: '重新运行',
    cancelText: '取消',
    onOk: async () => {
      try {
        await batchTaskStore.rerunJob(job.id)
        showInfo('rerunQueued')
      } catch (e) {
        showInfo(e?.message || '重新运行失败')
      }
    },
  })
}

// 清除日志
function clearLogs() {
  executionLogs.value = []
}

// 获取文件类型图标
function getFileTypeIcon(fileName) {
  const ext = fileName.toLowerCase()
  if (fileTypes.images.some((type) => ext.endsWith(type))) {
    return PictureOutlined
  } else if (fileTypes.videos.some((type) => ext.endsWith(type))) {
    return VideoCameraOutlined
  } else if (fileTypes.audios.some((type) => ext.endsWith(type))) {
    return SoundOutlined
  } else if (ext.endsWith('.pdf')) {
    return FilePdfOutlined
  } else if (ext.endsWith('.doc') || ext.endsWith('.docx')) {
    return FileWordOutlined
  } else if (ext.endsWith('.xls') || ext.endsWith('.xlsx')) {
    return FileExcelOutlined
  } else if (ext.endsWith('.ppt') || ext.endsWith('.pptx')) {
    return FilePptOutlined
  } else if (fileTypes.texts.some((type) => ext.endsWith(type))) {
    return FileTextOutlined
  }
  return null
}

// 格式化文件大小
function formatFileSize(bytes) {
  if (bytes === 0) return '0 B'
  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i]
}

// 获取状态文本
function getStatusText(status) {
  const statusMap = {
    running: t('statusRunning'),
    completed: t('statusCompleted'),
    failed: t('statusFailed'),
    stopped: t('statusStopped'),
  }
  return statusMap[status] || status
}

// 打开输出目录
async function openOutputDirectory() {
  try {
    if (window.electronAPI) {
      // 打开固定的输出目录，具体路径由后端实现
      await window.electronAPI.ArtifyLab.openOutputFolder()
    } else {
      showError('electronNotAvailable')
    }
  } catch (error) {
    console.error('打开输出目录失败:', error)
    showError('openOutputDirectoryFailed')
  }
}

// 处理自动关闭计算机
async function handleNotify({ title, body }) {
  try {
    const response = await fetch(`${appStore.config.serverHost}/api/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        url: notifyWebhookUrl.value.trim(),
        title,
        body,
      }),
    })
    const json = await response.json().catch(() => ({}))
    if (!response.ok || !json?.success) {
      throw new Error(json?.message || `notify http ${response.status}`)
    }
    executionLogs.value.unshift({
      time: new Date().toLocaleTimeString(),
      message: t('notifySent'),
      type: 'success',
    })
  } catch (error) {
    console.error('完成通知失败:', error)
    executionLogs.value.unshift({
      time: new Date().toLocaleTimeString(),
      message: t('notifyFailed'),
      type: 'error',
    })
  }
}

async function handleAutoShutdown() {
  try {
    // 添加关闭日志
    executionLogs.value.unshift({
      time: new Date().toLocaleTimeString(),
      message: t('shutdownInProgress'),
      type: 'info',
    })

    // 调用关闭API
    await shutdown()

    // 显示成功消息
    showSuccess('shutdownSuccess')

    // 添加成功日志
    executionLogs.value.unshift({
      time: new Date().toLocaleTimeString(),
      message: t('shutdownSuccess'),
      type: 'success',
    })
  } catch (error) {
    console.error('自动关闭计算机失败:', error)
    showError('shutdownFailed')
    executionLogs.value.unshift({
      time: new Date().toLocaleTimeString(),
      message: t('shutdownFailed'),
      type: 'error',
    })
  }
}

async function shutdown() {
  const response = await fetch(`${appStore.config.serverHost}/api/shutdown`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      delay: 30,
      force: true,
    }),
  })

  if (!response.ok) {
    throw new Error('Shutdown request failed')
  }

  return response.json()
}

async function unloadModel() {
  const response = await fetch(`${appStore.config.comfyHost}/free`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      unload_models: true,
      free_memory: true,
    }),
  })

  if (!response.ok) {
    throw new Error('UnloadModel failed')
  }
}

// 监听文件上传变化
watch(uploadedFiles, (files) => {
  if (files.length > 0) {
    const file = files[0]
    handleFileUpload(file.originFileObj)
  }
})

// 监听文件过滤变化
watch(fileFilter, () => {
  if (directoryFiles.value.length > 0) {
    // 如果当前选择的过滤器类型没有文件，自动切换到"all"
    if (fileFilter.value !== 'all' && fileCounts.value[fileFilter.value] === 0) {
      fileFilter.value = 'all'
    }
    generateBatchDataFromFiles()
  }
})

onMounted(async () => {
  await loadQueueConfig()
  queueConfigLoaded = true
  await init()
  await restoreRunningTask()
})

// 离开页面：批量任务已在 main 进程常驻执行，这里只断开本页监控，不再杀任务
onBeforeUnmount(() => {
  if (batchWatchStop) {
    batchWatchStop()
    batchWatchStop = null
  }
})

// 在应用ID变更后自动加载对应历史记录
watch(historyKey, (newKey) => {
  if (newKey) {
    ensureHistoryLoaded()
  }
})
</script>

<style lang="less" scoped src="./batch.less"></style>
