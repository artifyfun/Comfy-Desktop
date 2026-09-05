<template>
  <a-modal
    :open="show"
    @update:open="handleModalUpdate"
    :title="t('appBuilding')"
    width="100%"
    :wrap-class-name="`full-modal ${currentStep === 'style' && buildMode === 'ai' ? 'style-modal' : buildMode}`"
    destroyOnClose
    :maskClosable="false"
    @cancel="handleCancel"
  >
    <!-- Build Mode Selector -->
    <div class="flex gap-4 mb-6">
      <a-radio-group v-model:value="buildMode" button-style="solid">
        <a-radio-button value="local">{{ t('localBuild') }}</a-radio-button>
        <a-radio-button value="ai">{{ t('aiBuild') }}</a-radio-button>
      </a-radio-group>
    </div>

    <template #footer>
      <!-- Local build footer -->
      <div v-if="buildMode === 'local'">
        <a-button @click="handleCancel">{{ t('cancel') }}</a-button>
        <a-button type="primary" @click="handleLocalSave">{{ t('save') }}</a-button>
      </div>
      <!-- AI build footer (original logic) -->
      <div v-else>
        <div v-if="currentStep === 'style'">
          <a-button @click="handleCancel">{{ t('cancel') }}</a-button>
          <a-button
            type="primary"
            :loading="optimizePromptLoading"
            :disabled="!canProceed"
            @click="handleStyleConfirm"
          >
            {{ t('startBuild') }} <i class="fa-solid fa-chevron-right"></i>
          </a-button>
        </div>
        <div v-else>
          <a-button
            v-if="!(genLoading || responseLoading || appStore.isLoading)"
            @click="handleBackToStyle"
            ><i class="fa-solid fa-chevron-left"></i> {{ t('backToStyle') }}</a-button
          >
          <a-button danger v-if="genLoading" @click="handleStopBuilding">{{
            t('stopBuilding')
          }}</a-button>
          <a-button
            v-if="!(genLoading || responseLoading || appStore.isLoading)"
            @click="handleRebuild"
            >{{ t('rebuildApp') }}</a-button
          >
          <a-button
            type="primary"
            :loading="genLoading || responseLoading || appStore.isLoading"
            @click="handleSave"
            >{{ t('save') }}</a-button
          >
        </div>
      </div>
    </template>

    <!-- Local build preview -->
    <div v-if="buildMode === 'local'" class="editor-box">
      <splitpanes class="default-theme">
        <pane>
          <CodeEditor :value="localHtml" :readonly="true" />
        </pane>
        <pane>
          <Preview
            class="preview-iframe"
            :html="genHtml(genApp, localHtml, appStore.config)"
            :isAiWorking="false"
          />
        </pane>
      </splitpanes>
    </div>

    <!-- AI build step-based UI (original logic) -->
    <div style="height: 100%" v-else>
      <div v-if="currentStep === 'style'" class="style-selection-container">
        <div class="style-selection-content">
          <div class="style-selection-header">
            <h3 class="mb-2 text-xl font-bold text-white">{{ t('selectAppStyle') }}</h3>
            <p class="mb-6 text-[var(--wb-text)]">{{ t('styleSelectionDescription') }}</p>
          </div>

          <!-- Tab切换 -->
          <div class="style-tabs">
            <a-tabs v-model:activeKey="activeTab" class="style-tabs-container">
              <a-tab-pane key="preset" :tab="t('presetStyles')">
                <!-- 预设风格选择 -->
                <div v-if="appStore.isLoading" class="flex justify-center items-center py-12">
                  <a-spin size="large" />
                  <span class="ml-3 text-[var(--wb-text)]">{{ t('loadingStyles') }}</span>
                </div>

                <div v-else-if="appStore.buildStyles.length > 0" class="style-grid-container">
                  <div class="style-grid">
                    <div
                      v-for="style in appStore.buildStyles"
                      :key="style.id"
                      @click="handleChangeBuildStyle(style)"
                      :class="[
                        'style-card',
                        selectedStyleId === style.id ? 'style-card-selected' : 'style-card-default',
                      ]"
                    >
                      <div class="style-image-container">
                        <img
                          :src="style.image"
                          :alt="style[`${appStore.config.lang}_name`]"
                          class="style-image"
                        />
                        <div class="style-overlay">
                          <div class="style-name">{{ style[`${appStore.config.lang}_name`] }}</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>

                <div v-else class="py-12 text-center">
                  <div class="mb-4 text-[var(--wb-text-2)]">
                    <i class="text-2xl fas fa-exclamation-triangle"></i>
                  </div>
                  <p class="text-[var(--wb-text)]">{{ t('noBuildStyles') }}</p>
                </div>
              </a-tab-pane>

              <a-tab-pane key="advanced" :disabled="!selectedStyleId">
                <template #tab>
                  <span class="relative">
                    {{ t('advancedConfig') }}
                  </span>
                </template>
                <!-- 高级配置 -->
                <div class="advanced-config-container">
                  <div class="config-section">
                    <h4 class="config-title">{{ t('appStyle') }}</h4>
                    <p class="config-description">{{ t('appStyleDescription') }}</p>
                    <div class="code-editor-container">
                      <CodeEditor
                        :value="customStyleCode"
                        :language="'html'"
                        @change="customStyleCode = $event"
                      />
                    </div>
                    <div class="preview-container">
                      <h5 class="preview-title">{{ t('preview') }}</h5>
                      <div class="preview-frame">
                        <Preview
                          v-if="customStyleCode"
                          :html="customStyleCode"
                          :isAiWorking="false"
                          class="style-preview"
                        />
                        <div v-else class="preview-placeholder">
                          <i class="mb-2 text-2xl fas fa-eye text-[var(--wb-text-2)]"></i>
                          <span class="text-[var(--wb-text-2)]">{{ t('previewPlaceholder') }}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  <div class="config-section">
                    <h4 class="config-title">{{ t('appFunction') }}</h4>
                    <p class="config-description">
                      <span>{{ t('appFunctionDescription') }}</span>
                      <!-- <a-button
                        type="primary"
                        class="ml-2"
                        :loading="optimizePromptLoading"
                        :disabled="optimizePromptLoading"
                        @click="handleOptimizePrompt"
                      >
                        {{ t('optimizePrompt') }}
                      </a-button> -->
                    </p>
                    <div class="code-editor-container">
                      <a-spin :tip="t('waitingAIResponse')" :spinning="optimizePromptLoading">
                        <CodeEditor
                          :value="customFunctionCode"
                          :language="'markdown'"
                          @change="customFunctionCode = $event"
                        />
                      </a-spin>
                    </div>
                  </div>
                </div>
              </a-tab-pane>
            </a-tabs>
          </div>
        </div>
      </div>
      <div v-else-if="currentStep === 'generate'" class="editor-box">
        <a-spin :tip="t('waitingAIResponse')" :spinning="responseLoading || appStore.isLoading">
          <splitpanes class="default-theme">
            <pane>
              <CodeEditor
                ref="genEditorRef"
                :value="genApp.code"
                @change="($event) => (genApp.code = $event)"
              />
            </pane>
            <pane>
              <Preview
                v-if="genApp.code.includes('<body>')"
                class="preview-iframe"
                :html="genHtml(genApp, genApp.code, appStore.config)"
                :isAiWorking="genLoading"
              />
              <div
                v-else-if="genLoading"
                class="flex flex-col justify-center items-center w-full h-full"
              >
                <a-spin />
                <span class="text-tech-blue">{{ t('aiBuilding') }}</span>
              </div>
            </pane>
          </splitpanes>
        </a-spin>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, watch, computed } from 'vue'
import { App } from 'ant-design-vue'
import { t } from '@/utils/i18n'
import { showError } from '@/utils'
import { genHtml, genPrompt, genLocalHtml } from '@/utils/genPrompt.js'
import { Splitpanes, Pane } from 'splitpanes'
import 'splitpanes/dist/splitpanes.css'
import Preview from '@/components/Preview/index.vue'
import CodeEditor from '@/components/CodeEditor/index.vue'
import { useAppStore } from '@/stores/appStore'

const { modal } = App.useApp()

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  app: {
    type: Object,
    default: () => ({}),
  },
})

const emit = defineEmits(['update:show', 'save'])

const genEditorRef = ref(null)
const genLoading = ref(false)
const responseLoading = ref(false)
const abortControllerRef = ref(null)
const currentStep = ref('style') // 'style' 或 'generate'
const selectedStyleId = ref('')
const activeTab = ref('preset')
const customStyleCode = ref('')
const customFunctionCode = ref('')
const optimizePromptLoading = ref(false)
const buildMode = ref('ai') // 'ai' or 'local'

const appStore = useAppStore()

// 计算是否可以继续
const canProceed = computed(() => {
  return !optimizePromptLoading.value && !!customStyleCode.value && !!customFunctionCode.value
})

// 生成应用数据
const genApp = ref(props.app)

// 本地构建HTML
const localHtml = computed(() => {
  return genLocalHtml(genApp.value, appStore.config)
})

const handleChangeBuildStyle = (style) => {
  selectedStyleId.value = style.id
  customStyleCode.value = style.html
  customFunctionCode.value = genPrompt(genApp.value, style, appStore.config).userPrompt
}

// 监听show变化，重置步骤和模式
watch(
  () => props.show,
  async (newShow) => {
    if (newShow) {
      buildMode.value = 'local'
      currentStep.value = 'style'
      selectedStyleId.value = ''
      activeTab.value = 'preset'
      customStyleCode.value = ''
      customFunctionCode.value = ''
      // 加载构建风格
      await appStore.loadBuildStyles()
      const style = appStore.buildStyles[0]
      handleChangeBuildStyle(style)
    }
  },
)

const handleModalUpdate = (value) => {
  emit('update:show', value)
}

const handleCancel = () => {
  if (currentStep.value === 'generate' && abortControllerRef.value) {
    abortControllerRef.value.abort()
  }
  genLoading.value = false
  responseLoading.value = false
  currentStep.value = 'style'
  selectedStyleId.value = ''
  activeTab.value = 'preset'
  customStyleCode.value = ''
  customFunctionCode.value = ''
  emit('update:show', false)
}

const handleStopBuilding = () => {
  if (abortControllerRef.value) {
    abortControllerRef.value.abort()
  }
  genLoading.value = false
  responseLoading.value = false
}

const handleStyleConfirm = async () => {
  if (activeTab.value === 'preset') {
    if (!selectedStyleId.value) {
      showError(t('pleaseSelectStyle'))
      return
    }
  } else {
    // 高级配置模式
    if (!customStyleCode.value || !customFunctionCode.value) {
      showError(t('pleaseInputStyleAndFunction'))
      return
    }
  }

  // 切换到代码生成步骤
  currentStep.value = 'generate'
  setTimeout(() => {
    genAppCode()
  })
}

const handleSave = () => {
  if (!genApp.value.code) {
    showError(t('pleaseBuildAppFirst'))
    return
  }
  emit('save', genApp.value)
  emit('update:show', false)
}

const handleLocalSave = () => {
  if (!localHtml.value) {
    showError(t('pleaseBuildAppFirst'))
    return
  }
  genApp.value.code = localHtml.value
  emit('save', genApp.value)
  emit('update:show', false)
}

const handleBackToStyle = () => {
  currentStep.value = 'style'
}

// 生成应用代码的方法（Codex agent 驱动，替换一次性提示词）
const genAppCode = async () => {
  const apiKey = appStore.config.api_key
  if (!apiKey) {
    showError(t('pleaseSetApiKey'))
    return
  }
  if (responseLoading.value || genLoading.value) {
    return
  }
  const buildStyle = appStore.buildStyles.find((item) => item.id === selectedStyleId.value)
  genApp.value.code = ''
  abortControllerRef.value = new AbortController()
  const signal = abortControllerRef.value.signal
  responseLoading.value = true

  const setCode = (code) => {
    genApp.value.code = code
  }
  const handleFinalCode = (finalDoc) => {
    setCode(finalDoc)
    genLoading.value = false
  }

  try {
    const request = await fetch(`${appStore.config.serverHost}/api/build-app`, {
      method: 'POST',
      body: JSON.stringify({
        appId: genApp.value.id || `tmp-${Date.now()}`,
        name: genApp.value.name,
        description: genApp.value.description,
        paramsNodes: (genApp.value.template && genApp.value.template.paramsNodes) || [],
        style: buildStyle
          ? buildStyle[`${appStore.config.lang}_name`] || buildStyle.id
          : selectedStyleId.value,
        provider: appStore.config.provider || 'deepseek',
        apiKey: appStore.config.api_key,
        baseUrl: appStore.config.base_url || '',
        model: appStore.config.buildModel || 'deepseek-v4-flash',
      }),
      headers: {
        'Content-Type': 'application/json',
      },
      signal,
    })

    if (request && request.body) {
      if (!request.ok) {
        try {
          const res = await request.json()
          showError(res.message || t('aiRequestFailed'))
        } catch (parseError) {
          showError(t('processingResponseFailed'))
        }
        genLoading.value = false
        responseLoading.value = false
        return
      }

      responseLoading.value = false
      genLoading.value = true
      const reader = request.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''

      const read = async () => {
        try {
          const { done, value } = await reader.read()
          if (done) {
            abortControllerRef.value = null
            return
          }
          buffer += decoder.decode(value, { stream: true })
          // 按 SSE 事件块（空行分隔）解析
          const blocks = buffer.split('\n\n')
          buffer = blocks.pop() || ''
          for (const block of blocks) {
            const lines = block.split('\n').filter((l) => l.trim())
            let eventName = 'message'
            const dataLines = []
            for (const line of lines) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim()
              else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
            }
            if (!dataLines.length) continue
            const dataStr = dataLines.join('\n')
            try {
              const payload = JSON.parse(dataStr)
              if (eventName === 'done' && payload.code) {
                handleFinalCode(payload.code)
              } else if (eventName === 'error') {
                showError(payload.message || t('aiResponseError'))
                genLoading.value = false
                responseLoading.value = false
              }
              // type==='log' 的进度事件暂不渲染 UI（构建完成后统一展示结果）
            } catch {
              // 忽略非 JSON 数据
            }
          }
          read()
        } catch (error) {
          if (error.name === 'AbortError') {
            // 用户取消，保留已生成部分
          } else {
            showError(error.message || t('aiResponseError'))
          }
          abortControllerRef.value = null
          genLoading.value = false
          responseLoading.value = false
        }
      }

      read()
    }
  } catch (error) {
    if (error.name === 'AbortError') {
      // 用户取消，不显示错误
    } else {
      showError(error.message || t('aiRequestFailed'))
    }
    genLoading.value = false
    abortControllerRef.value = null
  }
}

const handleRebuild = () => {
  modal.confirm({
    title: t('rebuildApp'),
    content: t('rebuildAppTip'),
    okText: t('confirm'),
    cancelText: t('cancel'),
    onOk: () => {
      genAppCode()
    },
  })
}

const optimizePrompt = async () => {
  optimizePromptLoading.value = true
  try {
    const request = await fetch(`${appStore.config.serverHost}/api/optimize-prompt`, {
      method: 'POST',
      body: JSON.stringify({
        prompt: customFunctionCode.value,
        api_key: appStore.config.api_key,
        base_url: appStore.config.base_url,
        model: appStore.config.model,
        language: appStore.config.lang,
      }),
      headers: {
        'Content-Type': 'application/json',
      },
    })
    if (!request.ok) {
      const res = await request.json()
      showError(res.message || t('aiRequestFailed'))
      optimizePromptLoading.value = false
      return
    }
    const data = await request.json()
    if (data && data.optimizedPrompt) {
      customFunctionCode.value = data.optimizedPrompt
    } else {
      showError(t('aiResponseError'))
    }
  } catch (error) {
    showError(error.message || t('aiRequestFailed'))
  } finally {
    optimizePromptLoading.value = false
  }
}

const handleOptimizePrompt = () => {
  if (!customFunctionCode.value) {
    showError(t('pleaseInputStyleAndFunction'))
    return
  }
  modal.confirm({
    title: t('optimizePrompt'),
    content: t('optimizePromptConfirm'),
    okText: t('confirm'),
    cancelText: t('cancel'),
    async onOk() {
      optimizePrompt()
    },
  })
}
</script>

<style lang="less">
.full-modal {
  &.style-modal {
    .ant-modal {
      height: auto;
    }
  }
  &.local,
  &.ai {
    .ant-modal-body {
      height: 100%;
      .editor-box {
        height: calc(100% - 60px);
      }
    }
  }
  .ant-modal {
    max-width: 100%;
    top: 0;
    padding-bottom: 0;
    margin: 0;
    width: 100%;
    height: 100%;
    & > div {
      width: 100%;
      height: 100%;
    }
  }
  .ant-modal-content {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh);
    width: 100%;
    height: 100%;
    background: var(--wb-bg-base);
    border: 1px solid var(--wb-stroke);
    border-radius: var(--wb-r-modal);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  .ant-modal-header {
    background: transparent;
    border-bottom: 1px solid var(--wb-stroke);
    padding: 20px 24px;
  }
  .ant-modal-title {
    color: var(--wb-text);
    font-family: var(--wb-font);
    font-weight: 600;
  }
  .ant-modal-body {
    flex: 1;
    background: transparent;
    color: var(--wb-text);
    .editor-box {
      width: 100%;
      height: 100%;
      .preview-iframe {
        width: 100%;
        height: 100%;
        border: none;
        user-select: none;
        margin: 0;
      }
    }
  }
  .ant-modal-footer {
    background: transparent;
    border-top: 1px solid var(--wb-stroke);
    padding: 16px 24px;
  }
}

// 风格选择样式
.style-selection-container {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 20px;
}

.style-selection-content {
  width: 100%;
  max-width: 1200px;
  height: 100%;
  display: flex;
  flex-direction: column;
}

.style-selection-header {
  text-align: center;
  margin-bottom: 20px;
  flex-shrink: 0;
}

.style-tabs {
  .style-tabs-container {
    .ant-tabs-nav {
      margin-bottom: 20px;
      .ant-tabs-nav-list {
        .ant-tabs-tab {
          color: var(--wb-text-2);
          font-size: 1rem;
          font-weight: 500;
          &.ant-tabs-tab-active {
            color: var(--wb-accent);
            font-weight: 600;
          }
        }
      }
    }
  }
}

.advanced-config-container {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.config-section {
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  padding: 20px;
}

.config-title {
  font-size: 1.2rem;
  font-weight: 600;
  color: var(--wb-text);
  margin-bottom: 8px;
}

.config-description {
  font-size: 0.9rem;
  color: var(--wb-text-2);
  margin-bottom: 15px;
}

.code-editor-container {
  height: 400px;
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  overflow: hidden;
  background: var(--wb-surface);

  .code-editor {
    height: 100%;
  }
}

.preview-container {
  margin-top: 20px;
  .preview-title {
    font-size: 1rem;
    font-weight: 500;
    color: var(--wb-text);
    margin-bottom: 8px;
  }
  .preview-frame {
    width: 100%;
    height: 200px;
    border: 1px solid var(--wb-stroke);
    border-radius: var(--wb-r-card);
    overflow: hidden;
    background: var(--wb-surface);
    display: flex;
    align-items: center;
    justify-content: center;
    .style-preview {
      width: 100%;
      height: 100%;
      border: none;
      user-select: none;
    }
    .preview-placeholder {
      text-align: center;
      color: var(--wb-text-2);
      .fas {
        margin-bottom: 8px;
      }
    }
  }
}

.style-grid-container {
  flex: 1;
  overflow-y: auto;
  padding: 10px 0;

  /* 自定义滚动条样式 */
  scrollbar-width: thin;
  scrollbar-color: var(--wb-accent) var(--wb-surface-deep);
}

.style-grid-container::-webkit-scrollbar {
  width: 8px;
}

.style-grid-container::-webkit-scrollbar-track {
  background: var(--wb-surface-deep);
  border-radius: 4px;
}

.style-grid-container::-webkit-scrollbar-thumb {
  background: var(--wb-accent);
  border-radius: 4px;
  transition: background 0.3s ease;
}

.style-grid-container::-webkit-scrollbar-thumb:hover {
  background: var(--wb-accent-hover);
}

.style-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 20px;
  padding: 10px 0;
}

.style-card {
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  overflow: hidden;
  cursor: pointer;
  transition:
    transform 0.15s ease,
    border-color 0.15s ease;
}

.style-card:hover {
  border-color: var(--wb-stroke-strong);
}

.style-card-selected {
  border-color: var(--wb-selected);
  background: var(--wb-accent-bg);
}

.style-card-default {
  border-color: var(--wb-stroke);
}

.style-image-container {
  position: relative;
  height: 200px;
  overflow: hidden;
}

.style-image {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.style-card:hover .style-image {
  transform: scale(1.05);
}

.style-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: rgba(23, 23, 24, 0.72);
  padding: 20px;
  color: white;
  opacity: 0;
  transition: opacity 0.3s ease;
}

.style-card:hover .style-overlay {
  opacity: 1;
}

.style-name {
  font-size: 1.2rem;
  font-weight: 600;
  margin-bottom: 5px;
}

.style-description {
  font-size: 0.9rem;
  opacity: 0.9;
}

.style-info {
  padding: 20px;
}

.style-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--wb-text);
  margin-bottom: 8px;
}

.style-subtitle {
  font-size: 0.9rem;
  color: var(--wb-text-2);
  line-height: 1.4;
}

// 响应式设计
@media (max-width: 768px) {
  .style-selection-container {
    padding: 10px;
  }

  .style-selection-content {
    max-width: 100%;
  }

  .style-grid {
    grid-template-columns: 1fr;
    gap: 15px;
  }

  .style-image-container {
    height: 150px;
  }

  .style-grid-container {
    padding: 5px 0;
  }
}

@media (max-width: 480px) {
  .style-selection-header {
    margin-bottom: 15px;
  }

  .style-grid {
    gap: 12px;
  }

  .style-card {
    border-radius: var(--wb-r-card);
  }
}
</style>
