// toast 通知：ant-design-vue notification 封装（右上角、无遮罩、i18n）。
import { notification, message } from 'ant-design-vue'
import { t } from '@/utils/i18n'

// 全局通知配置：右上角弹出、无遮罩、不拦截点击（notification 无遮罩层，
// pointer-events 只作用于提示卡片本身，不影响页面交互）
notification.config({
  placement: 'topRight',
  duration: 2.5,
  maxCount: 3,
})

// 应用分类枚举
export const APP_CATEGORIES = {
  IMAGE_GENERATION: 'imageGeneration',
  VIDEO_GENERATION: 'videoGeneration',
  TEXT_PROCESSING: 'textProcessing',
  SPEECH_RECOGNITION: 'speechRecognition',
  DATA_ANALYSIS: 'dataAnalysis',
  INTELLIGENT_ASSISTANT: 'intelligentAssistant',
}

// 应用级别枚举
export const APP_POWER_LEVELS = {
  BASIC: 'basic',
  INTERMEDIATE: 'intermediate',
  ADVANCED: 'advanced',
  PROFESSIONAL: 'professional',
}

export const copyToClipboard = (text) => {
  navigator.clipboard.writeText(text)
  message.success(t('copySuccess'))
}

// 通用错误提示函数，支持i18n —— 右上角弹出，不遮罩不影响点击
export function showError(key, params = {}) {
  notification.error({ message: t(key, params) })
}

// 通用成功提示函数，支持i18n
export function showSuccess(key, params = {}) {
  notification.success({ message: t(key, params) })
}

// 通用警告提示函数，支持i18n
export function showWarning(key, params = {}) {
  notification.warning({ message: t(key, params) })
}

// 通用信息提示函数，支持i18n
export function showInfo(key, params = {}) {
  notification.info({ message: t(key, params) })
}
