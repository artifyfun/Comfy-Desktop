<template>
  <header
    class="relative px-4 py-3 mx-auto max-w-7xl sm:px-6 lg:px-8"
    style="min-height: var(--wb-topbar-h)"
  >
    <div
      class="flex flex-col space-y-4 md:flex-row md:items-center md:justify-between md:space-y-0"
    >
      <!-- 左侧标题 -->
      <div class="flex items-center space-x-4">
        <div class="flex items-center space-x-3 cursor-pointer" @click="toggleAboutModal">
          <div class="flex justify-center items-center w-7 h-7 rounded-md brand-mark">A</div>
          <h1 class="text-lg font-semibold text-white">
            Artify<span class="text-slate-400 font-medium">{{
              currentLang === 'zh' ? '工坊' : 'Lab'
            }}</span>
          </h1>
        </div>
      </div>

      <!-- 右侧操作 -->
      <div class="flex items-center space-x-4">
        <!-- 桌面端导航 -->
        <nav class="flex space-x-4" v-if="isElectron">
          <router-link
            :to="firstNavTo"
            class="nav-tab"
            :class="{ 'nav-tab-on': $route.path === firstNavTo }"
          >
            <i :class="firstNavIcon"></i>
            {{ firstNavLabel || t('appCenter') }}
          </router-link>
          <router-link
            to="/gallery"
            class="nav-tab"
            :class="{ 'nav-tab-on': $route.path === '/gallery' }"
          >
            <i class="mr-2 fas fa-images"></i>
            {{ t('gallery') }}
          </router-link>
          <router-link
            to="/workbench"
            class="nav-tab"
            :class="{ 'nav-tab-on': $route.path === '/workbench' }"
          >
            <i class="mr-2 fas fa-wand-magic-sparkles"></i>
            {{ t('workbench') }}
          </router-link>
        </nav>
        <!-- 语言切换 -->
        <button
          v-if="isElectron"
          @click="toggleLanguage"
          class="px-3 py-1.5 text-sm font-medium rounded-md transition duration-150 text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)]"
        >
          <i class="mr-2 fas fa-globe"></i>
          {{ currentLang === 'zh' ? 'EN' : '中文' }}
        </button>

        <!-- 关于按钮 -->
        <button
          @click="toggleAboutModal"
          class="px-3 py-1.5 text-sm font-medium rounded-md transition duration-150 text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)]"
        >
          <i class="mr-2 fas fa-info-circle"></i>
          {{ t('about') }}
        </button>

        <!-- 设置按钮 -->
        <button
          v-if="isElectron"
          @click="toggleConfigModal"
          class="px-3 py-1.5 text-sm font-medium rounded-md transition duration-150 text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)]"
        >
          <i class="mr-2 fas fa-cog"></i>
          {{ t('settings') }}
        </button>
      </div>
    </div>

    <!-- About 组件 -->
    <About v-if="showAboutModal" @clickClose="toggleAboutModal" />

    <!-- 配置组件 -->
    <Config v-if="showConfigModal" @cancel="toggleConfigModal" @confirm="handleUpdateConfig" />
  </header>
</template>

<script setup>
import { ref } from 'vue'
import { useI18nInComponent } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import About from '@/components/About/index.vue'
import Config from '@/components/Config/index.vue'
import { isElectron } from '@/utils'

const { t, currentLang } = useI18nInComponent()
const appStore = useAppStore()

// 首导航项可配置：默认「应用中心」（/）；如后续要恢复应用市场入口，
// 传 first-nav-to="/market" first-nav-label 覆盖即可。
const props = defineProps({
  firstNavTo: { type: String, default: '/' },
  firstNavLabel: { type: String, default: '' },
  firstNavIcon: { type: String, default: 'mr-2 fas fa-th-large' },
})

// 模态框状态
const showAboutModal = ref(false)
const showConfigModal = ref(false)

// 切换关于模态框
const toggleAboutModal = () => {
  showAboutModal.value = !showAboutModal.value
}

// 切换配置模态框
const toggleConfigModal = () => {
  showConfigModal.value = !showConfigModal.value
}

// 切换语言
const toggleLanguage = () => {
  const newLang = appStore.config.lang === 'zh' ? 'en' : 'zh'
  appStore.updateConfig({ lang: newLang })
}

// 处理配置更新
const handleUpdateConfig = async (config) => {
  await appStore.updateConfig(config)
  showConfigModal.value = false
}
</script>

<style scoped>
/* Comfy 顶部 tab:激活 = 白字 + 2px azure 底条 */
.nav-tab {
  position: relative;
  padding: 6px 12px;
  font-size: 13px;
  font-weight: 500;
  color: var(--wb-text-2);
  border-radius: var(--wb-r-ctrl);
  transition:
    color 0.15s ease,
    background 0.15s ease;
}
.nav-tab:hover {
  color: #fff;
  background: var(--wb-surface-hover);
}
.nav-tab-on {
  color: #fff;
}
.nav-tab-on::after {
  content: '';
  position: absolute;
  left: 10px;
  right: 10px;
  bottom: -6px;
  height: 2px;
  background: var(--wb-accent);
  border-radius: 1px;
}
.brand-mark {
  background: var(--wb-ink);
  color: var(--wb-brand);
  font-weight: 800;
  font-size: 14px;
  line-height: 1;
}
</style>
