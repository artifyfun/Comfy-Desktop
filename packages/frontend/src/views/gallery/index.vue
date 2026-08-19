<template>
  <div class="page-container bg-tech-dark">
    <div id="app" class="pb-20 min-h-screen">
      <div class="fixed inset-0 grid-lines"></div>
      <AppHeader />

      <main class="relative px-4 mx-auto mt-4 max-w-7xl sm:px-6 lg:px-8">
        <div class="flex flex-wrap gap-3 items-center justify-between mb-6">
          <div class="flex items-center space-x-2">
            <div class="w-8 h-8 text-2xl text-tech-blue">
              <i class="fas fa-images"></i>
            </div>
            <h1 class="text-xl font-bold text-white tech-font">
              {{ t('gallery') }}
            </h1>
            <span class="text-sm text-slate-400">{{ total }} {{ currentLang === 'zh' ? '项' : 'items' }}</span>
          </div>
          <div class="flex items-center gap-2">
            <a-input-search
              v-model:value="query"
              :placeholder="currentLang === 'zh' ? '搜索文件名 / 应用名' : 'Search filename / app'"
              style="width: 220px"
              @search="reload"
            />
            <a-checkbox v-model:checked="starredOnly" @change="reload">
              {{ currentLang === 'zh' ? '仅收藏' : 'Starred' }}
            </a-checkbox>
            <a-button :loading="scanning" @click="scan">
              <i class="mr-1 fas fa-sync"></i>{{ currentLang === 'zh' ? '扫描' : 'Scan' }}
            </a-button>
          </div>
        </div>

        <div v-if="loading" class="py-20 text-center text-slate-400">
          <a-spin size="large" />
        </div>

        <div v-else-if="!items.length" class="py-20 text-center text-slate-400">
          <div class="mb-4"><i class="text-5xl fas fa-images"></i></div>
          {{ currentLang === 'zh' ? '暂无生成记录，先去跑一张吧' : 'No generations yet' }}
          <div class="mt-4">
            <a-button type="primary" @click="goApps">{{ t('app') }}{{ t('center') }}</a-button>
          </div>
        </div>

        <!-- 瀑布流 -->
        <div v-else class="gallery-grid">
          <div
            v-for="item in items"
            :key="item.id"
            class="group relative overflow-hidden rounded-lg cursor-pointer bg-slate-800/60"
            @click="showDetail(item)"
          >
            <img
              :src="thumbUrl(item)"
              :alt="item.filename"
              loading="lazy"
              class="w-full transition-transform duration-300 group-hover:scale-105"
              @error="onImgError($event, item)"
            />
            <div class="absolute inset-x-0 bottom-0 p-2 text-xs text-white bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity group-hover:opacity-100">
              <div class="truncate">{{ item.filename }}</div>
              <div class="flex justify-between text-slate-300">
                <span class="truncate">{{ item.app_name || formatTime(item.created_at) }}</span>
                <span class="flex items-center gap-1">
                  <i
                    class="cursor-pointer"
                    :class="item.starred ? 'fas fa-star text-yellow-400' : 'far fa-star'"
                    @click.stop="toggleStar(item)"
                  ></i>
                  <i class="ml-1 cursor-pointer far fa-trash-alt hover:text-red-400" @click.stop="remove(item)"></i>
                </span>
              </div>
            </div>
          </div>
        </div>

        <div v-if="items.length && items.length < total" class="mt-8 text-center">
          <a-button :loading="loading" @click="loadMore">
            {{ currentLang === 'zh' ? '加载更多' : 'Load more' }}
          </a-button>
        </div>
      </main>

      <!-- 详情弹窗 -->
      <a-modal
        v-model:open="detailOpen"
        :title="detail?.filename"
        width="860px"
        :footer="null"
      >
        <div v-if="detail" class="flex flex-col gap-4 md:flex-row">
          <div class="md:w-1/2">
            <img :src="fullUrl(detail)" class="w-full rounded-lg" />
          </div>
          <div class="space-y-3 md:w-1/2">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item :label="currentLang === 'zh' ? '时间' : 'Time'">{{ formatTime(detail.created_at) }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '应用' : 'App'">{{ detail.app_name || '-' }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '大小' : 'Size'">{{ formatSize(detail.size) }}</a-descriptions-item>
            </a-descriptions>

            <div v-if="detailInputs" class="max-h-56 overflow-auto rounded bg-slate-100 p-3 text-xs">
              <pre class="whitespace-pre-wrap">{{ detailInputs }}</pre>
            </div>

            <div class="flex gap-2">
              <a-button v-if="detail.app_id" type="primary" @click="reRun(detail)">
                <i class="mr-1 fas fa-redo"></i>{{ currentLang === 'zh' ? '用此参数再跑' : 'Re-run' }}
              </a-button>
              <a-button @click="download(detail)">
                <i class="mr-1 fas fa-download"></i>{{ currentLang === 'zh' ? '下载' : 'Download' }}
              </a-button>
            </div>
          </div>
        </div>
      </a-modal>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import AppHeader from '../apps/components/AppHeader.vue'
import { useAppStore } from '@/stores/appStore'
import { useI18nInComponent } from '@/utils/i18n'
import dayjs from 'dayjs'

const { t, currentLang } = useI18nInComponent()
const router = useRouter()
const appStore = useAppStore()

const items = ref([])
const total = ref(0)
const page = ref(1)
const pageSize = 60
const loading = ref(false)
const scanning = ref(false)
const query = ref('')
const starredOnly = ref(false)
const detailOpen = ref(false)
const detail = ref(null)

const serverHost = computed(() => appStore.config?.serverHost || '')
const detailInputs = computed(() => {
  if (!detail.value?.inputs_json) return ''
  try {
    return JSON.stringify(JSON.parse(detail.value.inputs_json), null, 2)
  } catch {
    return detail.value.inputs_json
  }
})

const thumbUrl = (item) => `${serverHost.value}/api/gallery/thumbs/${encodeURIComponent(item.filepath)}.jpg`
const fullUrl = (item) =>
  `${appStore.config?.comfyHost}/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder)}&type=${item.type}`

const onImgError = (e, item) => {
  // 缩略图缺失时回退原图
  if (!e.target.dataset.fallback) {
    e.target.dataset.fallback = '1'
    e.target.src = fullUrl(item)
  }
}

const formatTime = (ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss')
const formatSize = (n) => {
  if (!n) return '-'
  if (n > 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  return `${(n / 1024).toFixed(0)} KB`
}

const fetchList = async () => {
  loading.value = true
  try {
    const res = await fetch(`${serverHost.value}/api/gallery/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page: page.value, pageSize, q: query.value || undefined, starred: starredOnly.value })
    })
    const data = await res.json()
    if (data.code === 200 || data.success) {
      const payload = data.data || data
      total.value = payload.total || 0
      items.value = page.value === 1 ? payload.items : items.value.concat(payload.items)
    } else {
      throw new Error(data.message)
    }
  } catch (e) {
    message.error(`${currentLang.value === 'zh' ? '加载失败' : 'Load failed'}: ${e.message}`)
  } finally {
    loading.value = false
  }
}

const reload = () => {
  page.value = 1
  items.value = []
  fetchList()
}

const loadMore = () => {
  page.value++
  fetchList()
}

const scan = async () => {
  scanning.value = true
  try {
    const res = await fetch(`${serverHost.value}/api/gallery/scan`, { method: 'POST' })
    const data = await res.json()
    const payload = data.data || data
    message.success(
      currentLang.value === 'zh'
        ? `扫描完成：新增 ${payload.added}/${payload.scanned}`
        : `Scan done: ${payload.added}/${payload.scanned} added`
    )
    reload()
  } finally {
    scanning.value = false
  }
}

const toggleStar = async (item) => {
  item.starred = item.starred ? 0 : 1
  await fetch(`${serverHost.value}/api/gallery/star`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, starred: !!item.starred })
  })
}

const remove = async (item) => {
  await fetch(`${serverHost.value}/api/gallery/remove`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id })
  })
  items.value = items.value.filter((i) => i.id !== item.id)
  total.value--
}

const showDetail = (item) => {
  detail.value = item
  detailOpen.value = true
}

const download = (item) => {
  window.open(fullUrl(item), '_blank')
}

const goApps = () => router.push('/')

const reRun = (item) => {
  router.push({ path: '/', query: { app: item.app_id, rerun: item.id } })
}

onMounted(fetchList)
</script>

<style scoped>
.gallery-grid {
  columns: 4 240px;
  column-gap: 12px;
}
.gallery-grid > div {
  margin-bottom: 12px;
  break-inside: avoid;
}
</style>
