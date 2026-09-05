<template>
  <!-- 全局布局壳：header 只挂载一次，路由切换只替换内容区（参考 vue-router 嵌套路由
       + Vben Admin / vue-naive-admin 的 LAYOUT 父路由模式）。
       收益：① 消除各页面重复引入 header；② header 不再随路由重挂载/抖动；
       ③ 内容区滚动条在 wrapper 内，视口宽度恒定，彻底消除滚动条出没导致的横向位移。 -->
  <div class="flex flex-col h-screen overflow-hidden">
    <AppHeader
      v-if="showHeader"
      class="shrink-0"
      :first-nav-to="firstNavTo"
      :first-nav-label="firstNavLabel"
      :first-nav-icon="firstNavIcon"
    />
    <div
      class="flex-1 min-h-0"
      :class="
        route.meta.scrollable === false ? 'overflow-hidden' : 'overflow-y-auto overflow-x-hidden'
      "
    >
      <router-view />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { t } from '@/utils/i18n'
import AppHeader from '@/views/apps/components/AppHeader.vue'

const route = useRoute()

// 工作台三形态复刻（与 workbench/index.vue 的 isNarrow 同源逻辑）：
// C 宿主 iframe（embed=1 / 宿主 iframe）→ 窄栏无 header；独立窗口路由形态才有
const showHeader = computed(() => {
  if (route.path === '/workbench') {
    const inIframe = typeof window !== 'undefined' && window.parent && window.parent !== window
    if (inIframe || route.query.embed === '1' || route.query.canvas === '1') return false
  }
  return true
})

// 首导航可按页定制（meta.headerFirstNav* 驱动）：
// 应用中心首页指向市场避免自指；其余页默认指向应用中心
const firstNavTo = computed(() => route.meta.headerFirstNav ?? '/')
const firstNavLabel = computed(() => {
  const key = route.meta.headerFirstNavKey
  return key ? t(key) : ''
})
const firstNavIcon = computed(() => route.meta.headerFirstNavIcon ?? 'mr-2 fas fa-th-large')
</script>
