<template>
  <div v-if="showModal" class="update-modal-overlay" @click="closeModal">
    <!-- 提示消息 -->
    <div v-if="message.show" class="message-toast" :class="message.type">
      <div class="message-content">
        <i class="message-icon" :class="getMessageIcon(message.type)"></i>
        <span class="message-text">{{ message.text }}</span>
      </div>
    </div>

    <div class="update-modal glass-card" @click.stop>
      <div class="modal-header">
        <h3 class="modal-title">
          <i class="fas fa-sync-alt title-icon"></i>
          {{ t('autoUpdate') }}
        </h3>
        <button class="close-btn" @click="closeModal">
          <i class="fas fa-times"></i>
        </button>
      </div>

      <div class="modal-body">
        <!-- 检查更新中 -->
        <div v-if="updateStatus.checking" class="status-item checking">
          <div class="status-icon">
            <i class="fas fa-spinner fa-spin"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('checkingForUpdates') }}</div>
            <div class="status-desc">{{ t('checkingForNewVersion') }}</div>
            <div class="manual-update-section">
              <div class="manual-update-tip">
                <i class="fas fa-info-circle"></i>
                {{ t('manualUpdateAvailable') }}
              </div>
              <button @click="openManualDownload" class="btn btn-outline">
                <i class="fab fa-github btn-icon"></i>
                {{ t('manualDownload') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 错误状态 -->
        <div v-if="updateStatus.error" class="status-item error">
          <div class="status-icon">
            <i class="fas fa-exclamation-triangle"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('checkUpdateFailed') }}</div>
            <div class="status-desc">{{ updateStatus.error }}</div>
            <div class="manual-update-section">
              <div class="manual-update-tip">
                <i class="fas fa-lightbulb"></i>
                {{ t('manualUpdateTip') }}
              </div>
              <button @click="openManualDownload" class="btn btn-outline">
                <i class="fab fa-github btn-icon"></i>
                {{ t('downloadFromGitHub') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 发现新版本 -->
        <div
          v-if="updateStatus.available && !updateStatus.downloading && !updateStatus.downloaded"
          class="status-item available"
        >
          <div class="status-icon">
            <i class="fas fa-star"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('updateAvailable') }}</div>
            <div class="status-desc">
              {{ t('versionAvailable', { version: updateStatus.version }) }}
            </div>
            <div class="version-info">
              <span class="current-version">{{ t('currentVersion') }}: {{ appInfo.version }}</span>
              <span class="new-version">{{ t('newVersion') }}: {{ updateStatus.version }}</span>
            </div>
          </div>
        </div>

        <!-- 下载中 -->
        <div v-if="updateStatus.downloading" class="status-item downloading">
          <div class="status-icon">
            <i class="fas fa-download"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('downloadingUpdate') }}</div>
            <div class="status-desc">{{ t('downloadingNewVersion') }}</div>
            <div class="progress-bar">
              <div class="progress-fill"></div>
            </div>
            <div class="manual-update-section">
              <div class="manual-update-tip">
                <i class="fas fa-info-circle"></i>
                {{ t('manualUpdateAvailable') }}
              </div>
              <button @click="openManualDownload" class="btn btn-outline">
                <i class="fab fa-github btn-icon"></i>
                {{ t('manualDownload') }}
              </button>
            </div>
          </div>
        </div>

        <!-- 下载完成 -->
        <div v-if="updateStatus.downloaded" class="status-item downloaded">
          <div class="status-icon">
            <i class="fas fa-check-circle"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('updateDownloaded') }}</div>
            <div class="status-desc">{{ t('clickToRestart') }}</div>
          </div>
        </div>

        <!-- 无更新可用 -->
        <div
          v-if="
            !updateStatus.checking &&
            !updateStatus.available &&
            !updateStatus.downloading &&
            !updateStatus.downloaded &&
            !updateStatus.error
          "
          class="status-item no-update"
        >
          <div class="status-icon">
            <i class="fas fa-thumbs-up"></i>
          </div>
          <div class="status-content">
            <div class="status-title">{{ t('alreadyLatestVersion') }}</div>
            <div class="status-desc">
              {{ t('currentVersionIsLatest', { version: appInfo.version }) }}
            </div>
            <div class="manual-update-section">
              <div class="manual-update-tip">
                <i class="fas fa-info-circle"></i>
                {{ t('manualUpdateAvailable') }}
              </div>
              <button @click="openManualDownload" class="btn btn-outline">
                <i class="fab fa-github btn-icon"></i>
                {{ t('checkGitHubReleases') }}
              </button>
            </div>
          </div>
        </div>
      </div>

      <div class="modal-footer">
        <!-- 发现新版本时的按钮 -->
        <div
          v-if="updateStatus.available && !updateStatus.downloading && !updateStatus.downloaded"
          class="btn-group"
        >
          <button @click="downloadUpdate" class="btn btn-primary">
            <i class="fas fa-download btn-icon"></i>
            {{ t('downloadUpdate') }}
          </button>
          <button @click="openManualDownload" class="btn btn-outline">
            <i class="fab fa-github btn-icon"></i>
            {{ t('manualDownload') }}
          </button>
          <button @click="closeModal" class="btn btn-secondary">
            <i class="fas fa-clock btn-icon"></i>
            {{ t('later') }}
          </button>
        </div>

        <!-- 下载完成时的按钮 -->
        <div v-if="updateStatus.downloaded" class="btn-group">
          <button @click="installUpdate" class="btn btn-warning">
            <i class="fas fa-redo btn-icon"></i>
            {{ t('restartAndInstall') }}
          </button>
          <button @click="openManualDownload" class="btn btn-outline">
            <i class="fab fa-github btn-icon"></i>
            {{ t('manualDownload') }}
          </button>
          <button @click="closeModal" class="btn btn-secondary">
            <i class="fas fa-clock btn-icon"></i>
            {{ t('laterRestart') }}
          </button>
        </div>

        <!-- 其他状态时的按钮 -->
        <div v-if="!updateStatus.available && !updateStatus.downloaded" class="btn-group">
          <button
            @click="checkForUpdates"
            class="btn btn-primary"
            :disabled="updateStatus.checking"
          >
            <i class="fas fa-sync-alt btn-icon" :class="{ 'fa-spin': updateStatus.checking }"></i>
            {{ updateStatus.checking ? t('checking') : t('checkForUpdates') }}
          </button>
          <button @click="openManualDownload" class="btn btn-outline">
            <i class="fab fa-github btn-icon"></i>
            {{ t('manualDownload') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted, watch } from 'vue'
import { t } from '@/utils/i18n'

// Props
const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  appInfo: {
    type: Object,
    default: () => ({}),
  },
})

// Emits
const emit = defineEmits(['update:show'])

// Reactive data
const showModal = ref(props.show)
const updateStatus = ref({
  checking: false,
  available: false,
  version: '',
  error: '',
  downloading: false,
  downloaded: false,
})

// 提示消息状态
const message = ref({
  show: false,
  text: '',
  type: 'info', // 'info', 'success', 'warning', 'error'
})

// 监听props变化
const updateShowModal = (newVal) => {
  showModal.value = newVal
  emit('update:show', newVal)
}

// 获取消息图标
const getMessageIcon = (type) => {
  const icons = {
    info: 'fas fa-info-circle',
    success: 'fas fa-check-circle',
    warning: 'fas fa-exclamation-triangle',
    error: 'fas fa-times-circle',
  }
  return icons[type] || icons.info
}

// 显示提示消息
const showMessage = (text, type = 'info', duration = 3000) => {
  message.value = {
    show: true,
    text,
    type,
  }

  // 自动隐藏消息
  setTimeout(() => {
    message.value.show = false
  }, duration)
}

// 关闭modal
const closeModal = () => {
  updateShowModal(false)
}

// 检查更新
const checkForUpdates = async () => {
  try {
    updateStatus.value = {
      ...updateStatus.value,
      checking: true,
      error: '',
    }

    // 调用electron API检查更新
    const result = await window.electronAPI?.checkForUpdates()

    updateStatus.value = {
      ...updateStatus.value,
      checking: false,
      available: result?.isUpdateAvailable || false,
      version: result?.version || '',
    }

    if (result?.isUpdateAvailable) {
      showMessage(t('updateAvailableMessage', { version: result.version }), 'success')
    } else {
      showMessage(t('noUpdateAvailableMessage'), 'info')
    }
  } catch (error) {
    console.error('Failed to check for updates:', error)
    updateStatus.value = {
      ...updateStatus.value,
      checking: false,
      error: error instanceof Error ? error.message : t('updateCheckError'),
    }
    showMessage(t('updateCheckFailedMessage'), 'error')
  }
}

// 下载更新
const downloadUpdate = async () => {
  try {
    updateStatus.value = {
      ...updateStatus.value,
      downloading: true,
    }

    // 调用electron API下载更新
    await window.electronAPI?.downloadUpdate()

    updateStatus.value = {
      ...updateStatus.value,
      downloading: false,
      downloaded: true,
    }

    showMessage(t('updateDownloadedMessage'), 'success')
  } catch (error) {
    console.error('Failed to download update:', error)
    updateStatus.value = {
      ...updateStatus.value,
      downloading: false,
      error: error instanceof Error ? error.message : t('updateDownloadError'),
    }
    showMessage(t('updateDownloadFailedMessage'), 'error')
  }
}

// 安装更新
const installUpdate = async () => {
  try {
    // 调用electron API重启并安装更新
    await window.electronAPI?.restartAndInstall()
  } catch (error) {
    console.error('Failed to install update:', error)
    updateStatus.value = {
      ...updateStatus.value,
      error: error instanceof Error ? error.message : t('updateInstallError'),
    }
    showMessage(t('updateInstallFailedMessage'), 'error')
  }
}

// 手动下载更新
const openManualDownload = () => {
  try {
    // 获取GitHub发布页面链接
    const githubUrl = getGitHubReleaseUrl()

    // 显示确认对话框
    if (confirm(t('confirmManualDownload'))) {
      // 打开GitHub发布页面
      window.open(githubUrl, '_blank')
      showMessage(t('openingGitHubMessage'), 'info')
    }
  } catch (error) {
    console.error('Failed to open manual download:', error)
    showMessage(t('manualDownloadError'), 'error')
  }
}

// 获取GitHub发布页面链接
const getGitHubReleaseUrl = () => {
  // 从appInfo中获取仓库信息，如果没有则使用默认值
  const repo = props.appInfo?.repository || 'artifyfun/artify-frontend'
  const baseUrl = repo.includes('github.com') ? repo : `https://github.com/${repo}`
  return `${baseUrl}/releases/latest`
}

// 监听props.show变化
const watchShow = () => {
  if (props.show && !updateStatus.value.checking && !updateStatus.value.available) {
    // 打开modal时自动检查更新
    setTimeout(() => {
      checkForUpdates()
    }, 500)
  }
}

// Watch props.show changes
watch(
  () => props.show,
  (newVal) => {
    showModal.value = newVal
    if (newVal && !updateStatus.value.checking && !updateStatus.value.available) {
      // 打开modal时自动检查更新
      setTimeout(() => {
        checkForUpdates()
      }, 500)
    }
  },
)

onMounted(() => {
  watchShow()
})
</script>

<style lang="less" scoped>
.update-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  animation: fadeIn 0.3s ease-out;
}

/* 提示消息样式 */
.message-toast {
  position: fixed;
  top: 2rem;
  right: 2rem;
  z-index: 1100;
  max-width: 400px;
  padding: 1rem 1.5rem;
  border-radius: 0.75rem;
  border: 1px solid;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.3);
  animation: messageSlideIn 0.4s ease-out;
  font-weight: 500;
}

.message-toast.info {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
  color: var(--wb-accent);
}

.message-toast.success {
  background: var(--wb-success-bg);
  border-color: var(--wb-success);
  color: var(--wb-success);
}

.message-toast.warning {
  background: rgba(245, 158, 11, 0.15);
  border-color: rgba(245, 158, 11, 0.4);
  color: #f59e0b;
}

.message-toast.error {
  background: var(--wb-danger-bg);
  border-color: var(--wb-danger);
  color: var(--wb-danger);
}

.message-content {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}

.message-icon {
  font-size: 1.25rem;
  flex-shrink: 0;
}

.message-text {
  font-size: 0.95rem;
  line-height: 1.4;
  word-break: break-word;
}

@keyframes messageSlideIn {
  from {
    opacity: 0;
    transform: translateX(100%) translateY(-20px);
  }
  to {
    opacity: 1;
    transform: translateX(0) translateY(0);
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.update-modal {
  width: 90%;
  max-width: 580px;
  max-height: 85vh;
  overflow: hidden;
  animation: modalSlideIn 0.4s ease-out;
  position: relative;
  border-radius: 1rem;
}

.update-modal::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 4px;
  background: var(--wb-accent);
}

@keyframes modalSlideIn {
  from {
    opacity: 0;
    transform: translateY(-30px) scale(0.9);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem 1.5rem 1.25rem;
  border-bottom: 1px solid var(--wb-stroke);
  background: var(--wb-surface-deep);
}

.modal-title {
  display: flex;
  align-items: center;
  margin: 0;
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--wb-text);
  
}

.title-icon {
  margin-right: 0.75rem;
  font-size: 1.6rem;
  color: var(--wb-accent);
  animation: spin 2s linear infinite;
}

@keyframes spin {
  from {
    transform: rotate(0deg);
  }
  to {
    transform: rotate(360deg);
  }
}

.close-btn {
  background: var(--wb-stroke);
  border: 1px solid var(--wb-stroke);
  border-radius: 50%;
  color: var(--wb-text-2);
  font-size: 1.25rem;
  cursor: pointer;
  padding: 0.5rem;
  width: 2.5rem;
  height: 2.5rem;
  display: flex;
  align-items: center;
  justify-content: center;
  transition:
    background 0.2s ease,
    border-color 0.2s ease,
    color 0.2s ease,
    transform 0.2s ease;
}

.close-btn:hover {
  background: var(--wb-danger-bg);
  border-color: var(--wb-danger);
  color: var(--wb-danger);
  transform: rotate(90deg);
}

.modal-body {
  padding: 1.5rem;
  min-height: 280px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}

.status-item {
  display: flex;
  align-items: flex-start;
  padding: 1.25rem 1rem;
  border-radius: 0.75rem;
  margin-bottom: 1rem;
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  transition: border-color 0.15s ease;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 20px rgba(0, 0, 0, 0.1);
}

.status-item::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  width: 4px;
  height: 100%;
  background: var(--wb-accent);
  border-radius: 2px;
}

.status-item:hover {
  transform: translateX(5px);
  border-color: var(--wb-accent);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.status-icon {
  font-size: 1.75rem;
  margin-right: 1rem;
  flex-shrink: 0;
  
  width: 3rem;
  height: 3rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  background: var(--wb-accent-bg);
  border: 1px solid var(--wb-accent);
}

.status-content {
  flex: 1;
  min-width: 0;
}

.status-title {
  font-size: 1.125rem;
  font-weight: 600;
  margin-bottom: 0.5rem;
  color: var(--wb-text);
  
  line-height: 1.3;
}

.status-desc {
  font-size: 1rem;
  color: var(--wb-text-2);
  line-height: 1.6;
  margin-bottom: 0.5rem;
  opacity: 0.9;
}

.version-info {
  margin-top: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.current-version,
.new-version {
  font-size: 0.875rem;
  padding: 0.75rem 1rem;
  border-radius: 0.75rem;
  background: var(--wb-accent-bg);
  border: 1px solid var(--wb-accent);
  font-weight: 500;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.current-version::before,
.new-version::before {
  content: '';
  width: 0.5rem;
  height: 0.5rem;
  border-radius: 50%;
  margin-right: 0.625rem;
}

.current-version {
  color: #f59e0b;
  border-color: rgba(245, 158, 11, 0.3);
  background: rgba(245, 158, 11, 0.1);
}

.current-version::before {
  background: #f59e0b;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.new-version {
  color: var(--wb-accent);
  border-color: var(--wb-accent);
  background: var(--wb-accent-bg);
}

.new-version::before {
  background: var(--wb-accent);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

.progress-bar {
  margin-top: 1rem;
  height: 0.5rem;
  background: var(--wb-surface);
  border-radius: 0.25rem;
  overflow: hidden;
  border: 1px solid var(--wb-accent);
  position: relative;
}

.progress-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--wb-accent), var(--wb-accent-hover));
  border-radius: 0.25rem;
  animation: progressAnimation 2s ease-in-out infinite;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
  position: relative;
}

.progress-fill::after {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: transparent;
  animation: shimmer 1.5s infinite;
}

@keyframes progressAnimation {
  0%,
  100% {
    width: 0%;
    opacity: 0.7;
  }
  50% {
    width: 100%;
    opacity: 1;
  }
}

@keyframes shimmer {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(100%);
  }
}

/* 状态样式 */
.status-item.checking {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
}

.status-item.checking::before {
  background: var(--wb-accent);
}

.status-item.checking .status-icon {
  animation: pulse 1.5s infinite;
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
  color: var(--wb-accent-hover);
}

.status-item.error {
  background: var(--wb-danger-bg);
  border-color: var(--wb-danger);
}

.status-item.error::before {
  background: var(--wb-danger);
}

.status-item.error .status-icon {
  background: var(--wb-danger-bg);
  border-color: var(--wb-danger);
  color: var(--wb-danger);
}

.status-item.available {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
}

.status-item.available::before {
  background: var(--wb-accent);
}

.status-item.available .status-icon {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
  color: var(--wb-accent);
}

.status-item.downloading {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
}

.status-item.downloading::before {
  background: var(--wb-accent);
}

.status-item.downloading .status-icon {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
  color: var(--wb-accent-hover);
}

.status-item.downloaded {
  background: var(--wb-success-bg);
  border-color: var(--wb-success);
}

.status-item.downloaded::before {
  background: var(--wb-success);
}

.status-item.downloaded .status-icon {
  background: var(--wb-success-bg);
  border-color: var(--wb-success);
  color: var(--wb-success);
}

.status-item.no-update {
  background: var(--wb-surface);
  border-color: var(--wb-stroke);
}

.status-item.no-update::before {
  background: var(--wb-success);
}

.status-item.no-update .status-icon {
  background: var(--wb-success-bg);
  border-color: var(--wb-success);
  color: var(--wb-success);
}

@keyframes pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 1;
  }
  50% {
    transform: scale(1.1);
    opacity: 0.8;
  }
}

.modal-footer {
  padding: 1.5rem;
  border-top: 1px solid var(--wb-stroke);
  background: var(--wb-surface-deep);
}

.btn-group {
  display: flex;
  gap: 1rem;
  justify-content: flex-end;
  align-items: center;
}

.btn {
  display: flex;
  align-items: center;
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--wb-stroke);
  border-radius: 0.75rem;
  font-size: 1rem;
  font-weight: 500;
  cursor: pointer;
  transition: border-color 0.15s ease;
  min-width: 140px;
  justify-content: center;
  position: relative;
  overflow: hidden;
  box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1);
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
  transform: none !important;
  box-shadow: none;
}

.btn-icon {
  margin-right: 0.5rem;
  font-size: 1.1rem;
  transition: transform 0.3s ease;
}

.btn:hover .btn-icon {
  transform: scale(1.1);
}

.btn-primary {
  background: var(--wb-accent);
  border-color: var(--wb-accent);
  color: #fff;
}

.btn-primary:hover:not(:disabled) {
  background: var(--wb-accent-hover);
  border-color: var(--wb-accent-hover);
}

.btn-warning {
  background: var(--wb-danger);
  border-color: var(--wb-danger);
  color: #fff;
}

.btn-warning:hover:not(:disabled) {
  background: var(--wb-danger);
  border-color: var(--wb-danger);
  opacity: 0.88;
}

.btn-secondary {
  background: var(--wb-surface);
  border-color: var(--wb-stroke);
  color: var(--wb-text-2);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--wb-surface-hover);
  border-color: var(--wb-stroke-strong);
  color: var(--wb-text);
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--wb-accent);
  color: var(--wb-accent);
}

.btn-outline:hover:not(:disabled) {
  background: var(--wb-accent-bg);
  border-color: var(--wb-accent);
}

/* 手动更新区域样式 */
.manual-update-section {
  margin-top: 1.25rem;
  padding: 1rem;
  background: var(--wb-accent-bg);
  border: 1px solid var(--wb-accent);
  border-radius: 0.75rem;
}

.manual-update-tip {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 1rem;
  font-size: 0.9rem;
  color: var(--wb-text-2);
  font-weight: 500;
}

.manual-update-tip i {
  color: var(--wb-accent);
  font-size: 1rem;
}

.manual-update-section .btn {
  width: 100%;
  justify-content: center;
  margin-top: 0.5rem;
}

/* 响应式设计 */
@media (max-width: 768px) {
  .message-toast {
    top: 1rem;
    right: 1rem;
    left: 1rem;
    max-width: none;
    padding: 0.875rem 1.25rem;
  }

  .update-modal {
    width: 95%;
    margin: 1.25rem;
    max-width: none;
    border-radius: 1rem;
  }

  .modal-header,
  .modal-body,
  .modal-footer {
    padding: 1.25rem;
  }

  .modal-body {
    min-height: 240px;
  }

  .btn-group {
    flex-direction: column;
    gap: 1rem;
  }

  .btn {
    width: 100%;
    min-width: auto;
    padding: 0.875rem 1.25rem;
  }

  .status-item {
    padding: 1.25rem;
    margin-bottom: 1.25rem;
  }

  .status-icon {
    font-size: 1.5rem;
    margin-right: 1.25rem;
    width: 2.5rem;
    height: 2.5rem;
  }

  .status-title {
    font-size: 1.125rem;
  }

  .status-desc {
    font-size: 0.95rem;
  }

  .version-info {
    gap: 0.625rem;
  }

  .current-version,
  .new-version {
    padding: 0.625rem 0.875rem;
    font-size: 0.875rem;
  }
}

@media (max-width: 480px) {
  .message-toast {
    top: 0.75rem;
    right: 0.75rem;
    left: 0.75rem;
    padding: 0.75rem 1rem;
    border-radius: 0.5rem;
  }

  .message-icon {
    font-size: 1.125rem;
  }

  .message-text {
    font-size: 0.875rem;
  }

  .update-modal {
    width: 98%;
    margin: 0.625rem;
    border-radius: 0.875rem;
  }

  .modal-header,
  .modal-body,
  .modal-footer {
    padding: 1.25rem;
  }

  .modal-title {
    font-size: 1.25rem;
  }

  .title-icon {
    font-size: 1.375rem;
    margin-right: 0.625rem;
  }

  .close-btn {
    width: 2.5rem;
    height: 2.5rem;
    padding: 0.5rem;
  }

  .status-item {
    padding: 1rem;
    margin-bottom: 1rem;
    border-radius: 0.75rem;
  }

  .status-icon {
    font-size: 1.375rem;
    margin-right: 1rem;
    width: 2.25rem;
    height: 2.25rem;
  }

  .status-title {
    font-size: 1rem;
    margin-bottom: 0.5rem;
  }

  .status-desc {
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .version-info {
    margin-top: 1rem;
    gap: 0.5rem;
  }

  .current-version,
  .new-version {
    padding: 0.5rem 0.75rem;
    font-size: 0.8rem;
    border-radius: 0.5rem;
  }

  .progress-bar {
    margin-top: 1rem;
    height: 0.375rem;
  }

  .btn {
    padding: 0.75rem 1.25rem;
    font-size: 0.95rem;
    border-radius: 0.75rem;
  }

  .btn-icon {
    font-size: 1rem;
    margin-right: 0.5rem;
  }
}
</style>
