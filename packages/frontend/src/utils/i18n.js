// 国际化工具 —— 逻辑层。
// 翻译数据在 ./locales/{zh,en}.json（数据/逻辑分离：翻译变更不再触碰本文件）。
import { ref, computed, inject } from 'vue'
import zh from './locales/zh.json'
import en from './locales/en.json'

const translations = { zh, en }

// 全局语言状态
const currentLang = ref('zh')

// 设置当前语言
export function setLanguage(lang) {
  currentLang.value = lang
}

// 获取当前语言
export function getCurrentLanguage() {
  return currentLang.value
}

/** 按 key 路径取译文；带插值（{param} 占位）。查不到返回 key 本身。 */
export function translate(key, lang = 'zh', params = {}) {
  // 防御：调用方可能传入 undefined（如 app.category 缺失时），
  // 直接返回空串，避免渲染函数崩溃导致整页卡死。
  if (!key) return ''
  const keys = key.split('.')
  let value = translations[lang] || translations.zh

  for (const k of keys) {
    if (value && typeof value === 'object' && k in value) {
      value = value[k]
    } else {
      // 如果找不到翻译，返回key本身
      return key
    }
  }

  let result = value || key

  // 替换参数
  if (typeof result === 'string' && Object.keys(params).length > 0) {
    Object.keys(params).forEach((param) => {
      result = result.replace(new RegExp(`{${param}}`, 'g'), params[param])
    })
  }

  return result
}

// 获取翻译文本（当前语言）
export function t(key, params = {}) {
  return translate(key, currentLang.value, params)
}

// 兼容旧版的按语言翻译（原 tWithLang，已并入 t/translate）
export function tWithLang(key, lang = 'zh', params = {}) {
  return translate(key, lang, params)
}

// 根据语言获取翻译对象
export function getTranslations(lang = 'zh') {
  return translations[lang] || translations.zh
}

// 创建i18n composable
export function useI18n() {
  return {
    t,
    setLanguage,
    getCurrentLanguage,
    currentLang: computed(() => currentLang.value),
  }
}

// 在子组件中使用的i18n composable
export function useI18nInComponent() {
  const i18n = inject('i18n')
  if (!i18n) {
    console.warn('i18n not provided, falling back to global i18n')
    return useI18n()
  }
  return i18n
}

export default {
  t,
  tWithLang,
  getTranslations,
  setLanguage,
  getCurrentLanguage,
  useI18n,
  useI18nInComponent,
}
