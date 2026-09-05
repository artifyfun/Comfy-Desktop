<template>
  <a-modal
    :open="open"
    :title="currentLang === 'zh' ? '全局搜索' : 'Global Search'"
    width="640px"
    :footer="null"
    @cancel="$emit('close')"
  >
    <div class="global-search">
      <div class="global-search-bar">
        <div class="relative flex-1">
          <input
            v-model="keyword"
            type="text"
            :placeholder="currentLang === 'zh' ? '搜索应用 / 图片…' : 'Search apps / images…'"
            class="px-4 py-2 pl-10 w-full text-white rounded-lg tech-input focus:outline-none"
            @keyup.enter="runSearch"
            @input="onInput"
          />
          <i
            class="absolute left-3 top-1/2 transform -translate-y-1/2 fas fa-search text-[var(--wb-text-2)]"
          ></i>
          <button
            v-if="keyword.trim()"
            @click="clearKeyword"
            class="absolute right-3 top-1/2 transform -translate-y-1/2 text-[var(--wb-text-2)] hover:text-white"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>
      </div>

      <div v-if="loading" class="py-10 text-center text-[var(--wb-text-2)]">
        <a-spin />
      </div>

      <div v-else-if="!keyword.trim()" class="py-10 text-center text-[var(--wb-text-2)]">
        {{ currentLang === 'zh' ? '输入关键词开始搜索' : 'Type a keyword to search' }}
      </div>

      <div v-else-if="!hasResults" class="py-10 text-center text-[var(--wb-text-2)]">
        {{ currentLang === 'zh' ? '未找到匹配结果' : 'No matching results' }}
      </div>

      <div v-else class="global-search-results">
        <div v-if="apps.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '应用' : 'Apps' }}</div>
          <div v-for="app in apps" :key="'app-' + app.id" class="search-item" @click="goApp(app)">
            <i class="mr-2 fas fa-th-large text-tech-blue"></i>
            <span class="flex-1 truncate">{{ app.name }}</span>
            <span class="text-xs text-[var(--wb-text-3)] truncate">{{ app.category || '' }}</span>
          </div>
        </div>

        <div v-if="marketApps.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '市场' : 'Market' }}</div>
          <div
            v-for="app in marketApps"
            :key="'market-' + app.id"
            class="search-item"
            @click="goMarket"
          >
            <i class="mr-2 fas fa-store text-tech-blue"></i>
            <span class="flex-1 truncate">{{ app.name }}</span>
            <span class="text-xs text-[var(--wb-text-3)] truncate">{{ app.category || '' }}</span>
          </div>
        </div>

        <div v-if="images.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '图片' : 'Images' }}</div>
          <div v-for="img in images" :key="'img-' + img.id" class="search-item" @click="goImages">
            <i class="mr-2 fas fa-image text-tech-blue"></i>
            <span class="flex-1 truncate">{{ img.filename }}</span>
            <span class="text-xs text-[var(--wb-text-3)] truncate">{{ img.app_name || '' }}</span>
          </div>
        </div>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useDebounceFn } from '@vueuse/core'
import { useAppStore } from '@/stores/appStore'
import { useI18nInComponent } from '@/utils/i18n'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const { currentLang } = useI18nInComponent()
const router = useRouter()
const appStore = useAppStore()

const keyword = ref('')
const loading = ref(false)
const apps = ref([])
const marketApps = ref([])
const images = ref([])

const hasResults = computed(
  () => apps.value.length + marketApps.value.length + images.value.length > 0,
)

const serverHost = computed(() => appStore.config?.serverHost || '')

const runSearch = async () => {
  const q = keyword.value.trim()
  if (!q) {
    apps.value = []
    marketApps.value = []
    images.value = []
    return
  }
  loading.value = true
  try {
    // 应用（本地）
    if (!appStore.apps.length) await appStore.loadApps()
    const ql = q.toLowerCase()
    apps.value = appStore.apps.filter(
      (a) =>
        a.name?.toLowerCase().includes(ql) ||
        a.description?.toLowerCase().includes(ql) ||
        a.category?.toLowerCase().includes(ql),
    )

    // 市场应用
    if (!appStore.marketApps.length) await appStore.loadMarketApps()
    marketApps.value = appStore.marketApps.filter(
      (a) =>
        a.name?.toLowerCase().includes(ql) ||
        a.description?.toLowerCase().includes(ql) ||
        a.category?.toLowerCase().includes(ql),
    )

    // 图片（gallery 列表接口支持 q）
    const imgRes = await fetch(`${serverHost.value}/api/gallery/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, pageSize: 10, q }),
    })
    const imgJson = await imgRes.json()
    images.value = imgJson?.data?.items || []
  } catch (e) {
    console.warn('global search failed', e)
  } finally {
    loading.value = false
  }
}

const onInput = useDebounceFn(runSearch, 300)

// 清空关键词并触发搜索（结果列表随之清空）
const clearKeyword = () => {
  keyword.value = ''
  runSearch()
}

watch(
  () => props.open,
  (open) => {
    if (open) {
      keyword.value = ''
      apps.value = []
      marketApps.value = []
      images.value = []
    }
  },
)

const goApp = (app) => {
  emit('close')
  router.push({ path: '/', query: { app: app.id } })
}

const goMarket = () => {
  emit('close')
  router.push('/market')
}

const goImages = () => {
  emit('close')
  router.push({ path: '/gallery', query: { q: keyword.value.trim() } })
}
</script>

<style scoped>
.global-search-bar {
  display: flex;
  align-items: stretch;
}
/* 与应用中心一致的搜索输入框样式（单层边框） */
.tech-input {
  background: var(--wb-surface);
  border: 1px solid var(--wb-stroke);
  transition:
    background 0.3s ease,
    border-color 0.3s ease,
    box-shadow 0.3s ease;
}
.tech-input:focus {
  border-color: var(--wb-accent);
  box-shadow: 0 0 0 2px rgba(11, 140, 233, 0.2);
}
.global-search-results {
  max-height: 60vh;
  overflow-y: auto;
  margin-top: 12px;
}
.search-group {
  margin-bottom: 12px;
}
.search-group-title {
  font-size: 12px;
  color: var(--wb-text-2);
  margin-bottom: 4px;
  padding-left: 4px;
}
.search-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: var(--wb-text);
  transition: background 0.15s;
}
.search-item:hover {
  background: rgba(56, 189, 248, 0.12);
}
</style>
