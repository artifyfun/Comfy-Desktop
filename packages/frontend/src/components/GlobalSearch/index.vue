<template>
  <a-modal
    :open="open"
    :title="currentLang === 'zh' ? '全局搜索' : 'Global Search'"
    width="640px"
    :footer="null"
    @cancel="$emit('close')"
  >
    <div class="global-search">
      <a-input-search
        v-model:value="keyword"
        :placeholder="currentLang === 'zh' ? '搜索应用 / 图片 / 模型…' : 'Search apps / images / models…'"
        size="large"
        autofocus
        allow-clear
        @change="onInput"
        @search="runSearch"
      >
        <template #prefix><i class="fas fa-search text-slate-400"></i></template>
      </a-input-search>

      <div v-if="loading" class="py-10 text-center text-slate-400">
        <a-spin />
      </div>

      <div v-else-if="!keyword.trim()" class="py-10 text-center text-slate-400">
        {{ currentLang === 'zh' ? '输入关键词开始搜索' : 'Type a keyword to search' }}
      </div>

      <div v-else-if="!hasResults" class="py-10 text-center text-slate-400">
        {{ currentLang === 'zh' ? '未找到匹配结果' : 'No matching results' }}
      </div>

      <div v-else class="global-search-results">
        <div v-if="apps.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '应用' : 'Apps' }}</div>
          <div
            v-for="app in apps"
            :key="'app-' + app.id"
            class="search-item"
            @click="goApp(app)"
          >
            <i class="mr-2 fas fa-th-large text-tech-blue"></i>
            <span class="flex-1 truncate">{{ app.name }}</span>
            <span class="text-xs text-slate-500 truncate">{{ app.category || '' }}</span>
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
            <span class="text-xs text-slate-500 truncate">{{ app.category || '' }}</span>
          </div>
        </div>

        <div v-if="images.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '图片' : 'Images' }}</div>
          <div
            v-for="img in images"
            :key="'img-' + img.id"
            class="search-item"
            @click="goImages"
          >
            <i class="mr-2 fas fa-image text-tech-blue"></i>
            <span class="flex-1 truncate">{{ img.filename }}</span>
            <span class="text-xs text-slate-500 truncate">{{ img.app_name || '' }}</span>
          </div>
        </div>

        <div v-if="models.length" class="search-group">
          <div class="search-group-title">{{ currentLang === 'zh' ? '模型' : 'Models' }}</div>
          <div
            v-for="model in models"
            :key="'model-' + model.id"
            class="search-item"
            @click="goModels"
          >
            <i class="mr-2 fas fa-cube text-tech-blue"></i>
            <span class="flex-1 truncate">{{ model.name }}</span>
            <span class="text-xs text-slate-500 truncate">{{ model.type || '' }}</span>
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
const models = ref([])

const hasResults = computed(
  () => apps.value.length + marketApps.value.length + images.value.length + models.value.length > 0
)

const serverHost = computed(() => appStore.config?.serverHost || '')

const runSearch = async () => {
  const q = keyword.value.trim()
  if (!q) {
    apps.value = []
    marketApps.value = []
    images.value = []
    models.value = []
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
        a.category?.toLowerCase().includes(ql)
    )

    // 市场应用
    if (!appStore.marketApps.length) await appStore.loadMarketApps()
    marketApps.value = appStore.marketApps.filter(
      (a) =>
        a.name?.toLowerCase().includes(ql) ||
        a.description?.toLowerCase().includes(ql) ||
        a.category?.toLowerCase().includes(ql)
    )

    // 图片（gallery 列表接口支持 q）
    const imgRes = await fetch(`${serverHost.value}/api/gallery/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: 1, pageSize: 10, q })
    })
    const imgJson = await imgRes.json()
    images.value = (imgJson?.data?.items) || []

    // 模型（一次拉全量后前端过滤）
    const modelRes = await fetch(`${serverHost.value}/api/models/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const modelJson = await modelRes.json()
    const allModels = modelJson?.data?.items || []
    models.value = allModels.filter(
      (m) => m.name?.toLowerCase().includes(ql) || m.type?.toLowerCase().includes(ql)
    )
  } catch (e) {
    console.warn('global search failed', e)
  } finally {
    loading.value = false
  }
}

const onInput = useDebounceFn(runSearch, 300)

watch(
  () => props.open,
  (open) => {
    if (open) {
      keyword.value = ''
      apps.value = []
      marketApps.value = []
      images.value = []
      models.value = []
    }
  }
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

const goModels = () => {
  emit('close')
  router.push({ path: '/models', query: { q: keyword.value.trim() } })
}
</script>

<style scoped>
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
  color: #94a3b8;
  margin-bottom: 4px;
  padding-left: 4px;
}
.search-item {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  border-radius: 8px;
  cursor: pointer;
  color: #e2e8f0;
  transition: background 0.15s;
}
.search-item:hover {
  background: rgba(56, 189, 248, 0.12);
}
</style>
