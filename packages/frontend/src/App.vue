<template>
  <a-config-provider
    v-if="appStore.config"
    :locale="appStore.config.lang === 'zh' ? zhCN : enUS"
    :theme="createThemeConfig(appStore.config.theme !== 'light')"
    component-size="medium"
  >
    <a-app class="ant-app">
      <div class="app-container">
        <router-view />
        <!-- 全局浮钮组（搜索/回首页）在 embed iframe（ComfyUI 侧栏工作台）里
             与底部 Composer 工具条重叠且语义重复（宿主有自己的导航），隐藏 -->
        <a-float-button-group
          v-if="!isEmbedRoute"
          shape="square"
          :style="{
            right: '24px',
          }"
        >
          <a-tooltip>
            <template #title>{{ t('search') }}</template>
            <a-float-button @click="state.showGlobalSearch = true">
              <template #icon>
                <i class="fas fa-search"></i>
              </template>
            </a-float-button>
          </a-tooltip>
          <a-tooltip v-if="router.currentRoute.value.path !== '/'">
            <template #title>{{ t('backToHome') }}</template>
            <a-float-button @click="backToHome">
              <template #icon>
                <HomeOutlined />
              </template>
            </a-float-button>
          </a-tooltip>
          <!-- <a-tooltip v-if="router.currentRoute.value.path === '/'">
            <template #title>{{ t('settings') }}</template>
            <a-float-button @click="state.showConfigModal = true">
              <template #icon>
                <SettingOutlined />
              </template>
            </a-float-button>
          </a-tooltip> -->
          <a-tooltip
            v-if="isElectron && appStore.config.comfyHost && router.currentRoute.value.path === '/'"
          >
            <template #title>{{ t('comfyui') }}</template>
            <a-float-button @click="toComfyuiPage">
              <template #icon>
                <img src="/comfyui.png" alt="ComfyUI" />
              </template>
            </a-float-button>
          </a-tooltip>
        </a-float-button-group>
        <Config
          v-if="state.showConfigModal"
          @cancel="state.showConfigModal = false"
          @confirm="handleUpdateConfig"
        />
      </div>
    </a-app>
    <!-- 常驻批量任务浮层：main 进程执行，任何页面可见/可操作 -->
    <BatchTaskFloat />
    <!-- 全局搜索：Cmd/Ctrl+K 或右下角搜索按钮打开 -->
    <GlobalSearch :open="state.showGlobalSearch" @close="state.showGlobalSearch = false" />
  </a-config-provider>
</template>

<script setup>
import { reactive, provide, watch, computed, defineAsyncComponent, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { SettingOutlined, HomeOutlined } from '@ant-design/icons-vue'
import { useAppStore } from '@/stores/appStore'
import { isElectron } from '@/utils'
import { t, setLanguage, useI18n } from '@/utils/i18n'
import { createThemeConfig } from '@/utils/antd-theme'
// Config 弹窗较重(含大量表单+antd 组件),首屏未必打开——异步加载,不进主 chunk
const Config = defineAsyncComponent(() => import('@/components/Config/index.vue'))
import BatchTaskFloat from '@/components/BatchTaskFloat/index.vue'
import GlobalSearch from '@/components/GlobalSearch/index.vue'

import zhCN from 'ant-design-vue/es/locale/zh_CN'
import enUS from 'ant-design-vue/es/locale/en_US'
import dayjs from 'dayjs'
import 'dayjs/locale/zh-cn'
import 'dayjs/locale/en'

const router = useRouter()
// embed 模式（ComfyUI 侧栏工作台 iframe）：隐藏全局浮钮组
const isEmbedRoute = computed(() => router.currentRoute.value.query.embed === '1')

const appStore = useAppStore()

const state = reactive({
  loading: false,
  showConfigModal: false,
  showGlobalSearch: false,
})

// 提供i18n功能给子组件
const i18n = useI18n()
provide('i18n', i18n)

const initConfig = async () => {
  await appStore.initConfig()
  // 设置全局语言状态
  if (appStore.config && appStore.config.lang) {
    setLanguage(appStore.config.lang)
  }
}

// 监听语言变化
watch(
  () => appStore.config?.lang,
  (newLang) => {
    if (newLang) {
      dayjs.locale(appStore.config.lang === 'zh' ? 'zh-cn' : 'en')
      setLanguage(newLang)
    }
  },
)

initConfig()

// 空闲时预取常用路由组件，减少后续切换等待
onMounted(() => {
  const prefetch = () => {
    import('@/views/gallery/index.vue')
    import('@/views/batch/index.vue')
    if (isElectron) {
      import('@/views/market/index.vue')
    }
  }
  if (typeof requestIdleCallback === 'function') {
    requestIdleCallback(prefetch, { timeout: 2000 })
  } else {
    setTimeout(prefetch, 1500)
  }

  // Cmd/Ctrl + K 打开全局搜索
  const onKeydown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault()
      state.showGlobalSearch = true
    }
  }
  window.addEventListener('keydown', onKeydown)
  // onBeforeUnmount 中移除（与组件生命周期一致）
  // 这里保留引用以便未来清理
})

const handleUpdateConfig = async (config) => {
  await appStore.updateConfig(config)
  // 更新全局语言状态
  if (config.lang) {
    setLanguage(config.lang)
  }
  state.showConfigModal = false
}

const backToHome = () => {
  router.replace({
    path: '/',
  })
}

const toComfyuiPage = () => {
  window.electronAPI.ArtifyLab.loadComfyUI()
  // window.open(appStore.config.comfyHost)
}
</script>

<style>
#app {
  width: 100vw;
  height: 100vh;
}

.ant-app {
  width: 100%;
  height: 100%;
}

.app-container {
  width: 100%;
  height: 100%;
}
</style>
