<template>
  <div class="flex overflow-auto fixed inset-0 z-50 justify-center items-center p-4 bg-black/80">
    <div class="relative p-6 w-full max-w-3xl rounded-xl glass-card">
      <button
        @click="handleClose"
        class="absolute top-6 right-6 text-xl text-slate-400 hover:text-white"
      >
        <i class="fas fa-times"></i>
      </button>

      <div class="grid grid-cols-1 gap-8 md:grid-cols-2">
        <div>
          <div class="overflow-hidden h-72 rounded-lg">
            <img :src="currentApp.imageUrl" :alt="currentApp.name" class="object-cover w-full h-full" />
          </div>

          <div class="flex flex-wrap gap-2 mt-4">
            <span class="px-3 py-1 text-sm rounded-full bg-tech-blue/20 text-tech-blue">
              <i class="mr-1 fas fa-microchip"></i> {{ t(currentApp.category) }}
            </span>
            <span class="px-3 py-1 text-sm rounded-full bg-tech-purple/20 text-tech-purple">
              <i class="mr-1 fas fa-bolt"></i> {{ t(currentApp.powerLevel) }}
            </span>
          </div>
        </div>

        <div class="flex flex-col">
          <div class="flex-1">
            <div class="flex items-center mb-2">
              <h3 class="text-2xl font-bold text-white">{{ currentApp.name }}</h3>
            </div>

            <div class="flex justify-between items-center mb-4 text-sm text-slate-400">
              <div>
                <i class="mr-2 far fa-clock"></i>
                <span>{{ t('createdOn', { date: formatDate(currentApp.createdAt) }) }}</span>
              </div>
              <div class="flex justify-end items-center" v-if="isElectron">
                <a-tooltip>
                  <template #title>{{ t('edit') }}</template>
                  <span class="text-xs cursor-pointer text-tech-blue" @click="handleEdit">
                    <i class="fas fa-solid fa-pen-to-square"></i>
                  </span>
                </a-tooltip>
                <a-tooltip>
                  <template #title>{{ t('export') }}</template>
                  <span class="ml-2 text-xs cursor-pointer text-tech-blue" @click="handleExport">
                    <i class="fas fa-solid fa-cloud-arrow-down"></i>
                  </span>
                </a-tooltip>
                <a-tooltip>
                  <template #title>{{ t('versionHistory') }}</template>
                  <span class="ml-2 text-xs cursor-pointer text-tech-blue" @click="showVersions = true">
                    <i class="fas fa-solid fa-clock-rotate-left"></i>
                  </span>
                </a-tooltip>
                <a-tooltip>
                  <template #title>{{ t('checkDeps') }}</template>
                  <span class="ml-2 text-xs cursor-pointer text-tech-blue" @click="handleCheckDeps">
                    <i class="fas fa-solid fa-shield-halved"></i>
                  </span>
                </a-tooltip>
                <a-tooltip>
                  <template #title>{{ t('delete') }}</template>
                  <span class="ml-2 text-xs text-red-500 cursor-pointer" @click="handleDelete">
                    <i class="fas fa-solid fa-trash"></i>
                  </span>
                </a-tooltip>
              </div>
            </div>

            <p class="mb-6 text-slate-300">
              {{ currentApp.description }}
            </p>
          </div>
          <div class="flex gap-2 justify-end">
            <button
              class="py-3 w-full font-medium text-white bg-gradient-to-r rounded-lg cursor-pointer from-tech-blue to-tech-cyan"
              @click="handleLaunch"
            >
              {{ t('launchApp') }}
            </button>
            <button
              v-if="isElectron"
              class="px-1 py-3 font-medium text-white bg-gradient-to-r rounded-lg cursor-pointer text-nowrap from-tech-purple to-tech-blue"
              @click="handleRunWorkflow"
            >
              {{ t('runWorkflow') }}
            </button>
            <button
              v-if="isElectron"
              class="relative px-1 py-3 font-medium text-white bg-gradient-to-r rounded-lg cursor-pointer text-nowrap from-tech-purple to-tech-blue"
              @click="handleRunBatch"
            >
              {{ t('batchMode') }}
            </button>
          </div>
        </div>
      </div>
    </div>
    <!-- 生成模态框 -->
    <GenModal
      ref="genModalRef"
      :show="showGenModal"
      :app="currentApp"
      :config="appStore.config"
      @update:show="showGenModal = $event"
      @save="handleGenSave"
    />
  </div>
  <!-- 版本历史 -->
  <VersionModal
    :open="showVersions"
    :app-id="currentApp.id"
    @cancel="showVersions = false"
    @restored="handleRestored"
  />
  <!-- 依赖检查报告 -->
  <a-modal
    :open="depsModalOpen"
    :title="t('checkDeps')"
    :footer="null"
    @cancel="depsModalOpen = false"
  >
    <a-spin :spinning="depsChecking">
      <div v-if="depsReport">
        <a-alert
          v-if="depsReport.ok"
          type="success"
          :message="t('depsAllPresent')"
          show-icon
          class="mb-4"
        />
        <template v-else>
          <a-alert type="warning" :message="t('depsMissingTitle')" show-icon class="mb-4" />
          <div v-if="depsReport.missingNodes.length">
            <div class="mb-2 font-medium">{{ t('depsMissingNodes') }}</div>
            <ul class="mb-4 ml-5 list-disc">
              <li v-for="n in depsReport.missingNodes" :key="n">
                <code>{{ n }}</code>
              </li>
            </ul>
          </div>
          <div v-if="depsReport.missingModels.length">
            <div class="mb-2 font-medium">{{ t('depsMissingModels') }}</div>
            <ul class="ml-5 list-disc">
              <li v-for="(m, i) in depsReport.missingModels" :key="i">
                <code>{{ m.value }}</code>
                <span class="ml-1 text-slate-400">({{ m.input }} @ {{ m.node }})</span>
              </li>
            </ul>
          </div>
        </template>
      </div>
    </a-spin>
  </a-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { App } from 'ant-design-vue'
import { t } from '@/utils/i18n'
import { showInfo } from '@/utils'
import { downloadJSON, isElectron } from '@/utils'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/appStore'
import GenModal from './GenModal.vue'

const { modal } = App.useApp()
const router = useRouter()
const appStore = useAppStore()

const props = defineProps({
  app: {
    type: Object,
    default: () => ({}),
  },
})

import VersionModal from './VersionModal.vue'

const emit = defineEmits(['close', 'edit', 'delete'])

const showGenModal = ref(false)
const showVersions = ref(false)

// ===== 依赖检查 =====
const depsModalOpen = ref(false)
const depsChecking = ref(false)
const depsReport = ref(null)

const handleCheckDeps = async () => {
  depsModalOpen.value = true
  depsChecking.value = true
  depsReport.value = null
  try {
    const res = await fetch(`${appStore.config.serverHost}/api/apps/check-deps`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: currentApp.value })
    })
    const json = await res.json()
    if (!res.ok || !json?.success) {
      throw new Error(json?.message || `http ${res.status}`)
    }
    depsReport.value = json.data
  } catch (e) {
    console.error('检查依赖失败:', e)
    showInfo(e.message || t('depsCheckFailed'))
    depsModalOpen.value = false
  } finally {
    depsChecking.value = false
  }
}

// 引用
const genModalRef = ref(null)

// 内部状态
const currentApp = ref(props.app)

// 监听 props.app 变化，自动同步 currentApp
watch(
  () => props.app,
  (newApp) => {
    currentApp.value = JSON.parse(JSON.stringify(newApp))
  },
  { deep: true, immediate: true }
)

// 版本恢复后刷新详情
const handleRestored = async () => {
  await appStore.loadApps()
  const fresh = appStore.apps.find((a) => a.id === currentApp.value.id)
  if (fresh) currentApp.value = JSON.parse(JSON.stringify(fresh))
}

// 处理关闭
const handleClose = () => {
  emit('close')
}

// 处理编辑
const handleEdit = () => {
  emit('edit', JSON.parse(JSON.stringify(currentApp.value)))
}

// 处理导出
const handleExport = () => {
  downloadJSON(currentApp.value, `artifylab-app-${currentApp.value.name}-${new Date().toLocaleDateString()}.json`)
}

// 处理删除
const handleDelete = () => {
  modal.confirm({
    title: t('deleteApp'),
    content: t('deleteAppConfirm', { name: currentApp.value.name }),
    okText: t('confirm'),
    cancelText: t('cancel'),
    onOk: () => {
      emit('delete', currentApp.value)
      handleClose()
    },
  })
}

// 处理启动
const handleLaunch = async () => {
  if (currentApp.value.code) {
    await appStore.updateConfig({ activeAppId: currentApp.value.id })
    router.push({
      path: '/web',
    })
    handleClose()
  } else if (
    currentApp.value.template?.workflow &&
    Object.keys(currentApp.value.template?.prompt || {}).length
  ) {
    modal.confirm({
      title: t('buildApp'),
      content: t('appNotBuilt'),
      okText: t('confirm'),
      cancelText: t('cancel'),
      onOk: () => {
        showGenModal.value = true
      },
    })
  } else {
    showInfo(t('missingWorkflow'))
  }
}

// 处理运行工作流
const handleRunWorkflow = async () => {
  if (currentApp.value.template?.workflow) {
    await appStore.updateConfig({ activeAppId: currentApp.value.id })
    window.electronAPI.ArtifyLab.loadComfyUI()
  } else {
    showInfo(t('missingWorkflow'))
  }
}

const handleRunBatch = async () => {
  await appStore.updateConfig({ activeAppId: currentApp.value.id })
  router.push({
    path: '/batch',
  })
  handleClose()
}

// 格式化日期
function formatDate(date) {
  return new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}

// 处理生成保存
const handleGenSave = async (genApp) => {
  currentApp.value = JSON.parse(JSON.stringify(genApp))
  await appStore.updateApp(currentApp.value)
  showGenModal.value = false
}
</script>

<style scoped>
.glass-card {
  background: rgba(15, 23, 42, 0.6);
  border: 1px solid rgba(56, 70, 102, 0.4);
  box-shadow: 0 8px 32px rgba(2, 8, 32, 0.4);
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity 0.3s ease;
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>
