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
            <span class="text-sm text-slate-400">
              {{ viewMode === 'dirs' ? dirsCount : total }} {{ currentLang === 'zh' ? '项' : 'items' }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <a-input-search
              v-model:value="query"
              :placeholder="currentLang === 'zh' ? '搜索文件名 / 应用名' : 'Search filename / app'"
              style="width: 220px"
              @search="onFilterChange"
            />
            <a-checkbox v-model:checked="starredOnly" @change="onFilterChange">
              {{ currentLang === 'zh' ? '仅收藏' : 'Starred' }}
            </a-checkbox>
            <a-button :loading="scanning" @click="scan">
              <i class="mr-1 fas fa-sync"></i>{{ currentLang === 'zh' ? '扫描' : 'Scan' }}
            </a-button>
          </div>
        </div>

        <!-- ===== 目录卡片视图（默认） ===== -->
        <template v-if="viewMode === 'dirs'">
          <div v-if="loading" class="py-20 text-center text-slate-400">
            <a-spin size="large" />
          </div>

          <div v-else-if="!dirs.length" class="py-20 text-center text-slate-400">
            <div class="mb-4"><i class="text-5xl fas fa-folder-open"></i></div>
            {{ currentLang === 'zh' ? '暂无生成目录，先去跑一张吧' : 'No directories yet' }}
            <div class="mt-4">
              <a-button type="primary" @click="goApps">{{ t('app') }}{{ t('center') }}</a-button>
            </div>
          </div>

          <div v-else class="dir-grid">
            <!-- 全部目录卡片 -->
            <div
              class="dir-card group"
              @click="selectDir('')"
            >
              <div class="dir-thumb dir-thumb-all">
                <i class="fas fa-layer-group"></i>
              </div>
              <div class="dir-name">{{ currentLang === 'zh' ? '全部' : 'All' }}</div>
              <div class="dir-count">{{ dirsCount }} {{ currentLang === 'zh' ? '项' : 'items' }}</div>
            </div>

            <!-- 目录卡片 -->
            <div
              v-for="d in dirs"
              :key="d.subfolder"
              class="dir-card group"
              :title="d.subfolder"
              @click="selectDir(d.subfolder)"
            >
              <div class="dir-thumb">
                <img
                  v-if="d.filepath"
                  :src="dirThumbUrl(d)"
                  :alt="dirLabel(d.subfolder)"
                  loading="lazy"
                  class="w-full h-full object-cover"
                />
                <i v-else class="fas fa-folder"></i>
              </div>
              <div class="dir-name">{{ dirLabel(d.subfolder) }}</div>
              <div class="dir-count">{{ d.count }} {{ currentLang === 'zh' ? '项' : 'items' }}</div>
            </div>
          </div>
        </template>

        <!-- ===== 目录内图片瀑布流 ===== -->
        <template v-else>
          <div class="mb-4 flex items-center gap-3">
            <a-button size="small" @click="goBackToDirs">
              <i class="mr-1 fas fa-arrow-left"></i>{{ currentLang === 'zh' ? '返回目录' : 'Back' }}
            </a-button>
            <span class="text-sm text-slate-300">
              <i class="mr-1 fas fa-folder"></i>{{ activeDirLabel }}
            </span>
          </div>

          <div v-if="loading" class="py-20 text-center text-slate-400">
            <a-spin size="large" />
          </div>

          <div v-else-if="!items.length" class="py-20 text-center text-slate-400">
            <div class="mb-4"><i class="text-5xl fas fa-images"></i></div>
            {{ currentLang === 'zh' ? '该目录暂无内容' : 'Empty directory' }}
          </div>

          <!-- 瀑布流（虚拟滚动，只渲染可见行） -->
          <div v-else class="gallery-virtual-wrap">
            <GalleryVirtualMasonry
              :items="items"
              :server-host="serverHost"
              :comfy-host="comfyHost"
              :loading="loading"
              :has-more="items.length < total"
              @open="showDetail"
              @star="toggleStar"
              @remove="remove"
              @img-error="onImgError"
              @load-more="loadMore"
            />
          </div>

          <div v-if="items.length && items.length < total" class="mt-8 text-center">
            <a-button :loading="loading" @click="loadMore">
              {{ currentLang === 'zh' ? '加载更多' : 'Load more' }}
            </a-button>
          </div>
        </template>
      </main>

      <!-- 详情弹窗 -->
      <a-modal
        v-model:open="detailOpen"
        :title="detail?.filename"
        width="960px"
        :footer="null"
        @after-close="destroyViewer"
      >
        <div v-if="detail" class="flex flex-col gap-4 md:flex-row">
          <div class="md:w-1/2">
            <!-- Viewer.js inline 预览：滚轮缩放 / 拖拽平移 / 工具栏 -->
            <div class="relative">
              <div
                v-if="!detailLoaded"
                class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-slate-800/60"
              >
                <a-spin />
              </div>
              <img
                ref="detailImageRef"
                :src="fullUrl(detail)"
                class="w-full rounded-lg transition-opacity duration-300"
                :class="{ 'opacity-0': !detailLoaded }"
                alt=""
                @load="onDetailImageLoad"
              />
            </div>
            <div class="mt-2 text-center text-xs text-slate-400">
              {{ currentLang === 'zh' ? '滚轮缩放，拖拽平移，点击图片可全屏' : 'Wheel to zoom, drag to pan, click image for fullscreen' }}
            </div>
          </div>
          <div class="space-y-3 md:w-1/2">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item :label="currentLang === 'zh' ? '时间' : 'Time'">{{ formatTime(detail.created_at) }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '应用' : 'App'">{{ detail.app_name || '-' }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '大小' : 'Size'">{{ formatSize(detail.size) }}</a-descriptions-item>
            </a-descriptions>

            <div v-if="detailJson" class="max-h-48 overflow-auto rounded bg-slate-100 p-3 text-xs">
              <div class="mb-1 font-medium text-slate-600">
                {{
                  detailJsonType === 'workflow'
                    ? (currentLang === 'zh' ? 'UI 工作流（可拖回画布编辑）' : 'UI workflow (drag back to canvas)')
                    : detailJsonType === 'prompt'
                      ? (currentLang === 'zh' ? 'API Prompt（可复原生成）' : 'API prompt (reproducible)')
                      : (currentLang === 'zh' ? '应用输入参数' : 'App inputs')
                }}
              </div>
              <VueJsonPretty
                v-if="detailJsonData"
                :data="detailJsonData"
                :deep="2"
                show-line-numbers
                show-icon
                :show-length="true"
              />
              <pre v-else class="whitespace-pre-wrap">{{ detailJson }}</pre>
            </div>
            <div v-else class="rounded bg-slate-100 p-3 text-xs text-slate-500">
              {{ currentLang === 'zh' ? '该图片暂无参数快照' : 'No parameter snapshot for this image' }}
            </div>

            <div class="flex flex-wrap gap-2">
              <a-button v-if="detail.app_id" type="primary" @click="reRun(detail)">
                <i class="mr-1 fas fa-redo"></i>{{ currentLang === 'zh' ? '用此参数再跑' : 'Re-run' }}
              </a-button>
              <a-button @click="download(detail)">
                <i class="mr-1 fas fa-download"></i>{{ currentLang === 'zh' ? '下载图片' : 'Download image' }}
              </a-button>
              <a-button v-if="detailJson" @click="copyWorkflow">
                <i class="mr-1 fas fa-copy"></i>{{ currentLang === 'zh' ? '复制工作流' : 'Copy workflow' }}
              </a-button>
              <a-button v-if="detailJson" @click="downloadWorkflow">
                <i class="mr-1 fas fa-file-code"></i>{{ currentLang === 'zh' ? '下载工作流' : 'Download workflow' }}
              </a-button>
            </div>
          </div>
        </div>
      </a-modal>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, nextTick, watch, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { message } from 'ant-design-vue'
import Viewer from 'viewerjs'
import 'viewerjs/dist/viewer.css'
import VueJsonPretty from 'vue-json-pretty'
import 'vue-json-pretty/lib/styles.css'
import AppHeader from '../apps/components/AppHeader.vue'
import GalleryVirtualMasonry from './components/GalleryVirtualMasonry.vue'
import { useAppStore } from '@/stores/appStore'
import { useI18nInComponent } from '@/utils/i18n'
import dayjs from 'dayjs'

const { t, currentLang } = useI18nInComponent()
const router = useRouter()
const appStore = useAppStore()

const viewMode = ref('dirs') // 'dirs' = 目录卡片视图 | 'items' = 目录内图片视图
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
const detailLoaded = ref(false)
const dirs = ref([])
const activeDir = ref('')

const serverHost = computed(() => appStore.config?.serverHost || '')
const comfyHost = computed(() => appStore.config?.comfyHost || '')
// 工作流/参数快照：优先 UI workflow（可拖回画布编辑），
// 其次完整 API prompt（可直接复原生成），最后退回 App 输入参数。
const detailJson = computed(() => {
  if (!detail.value) return ''
  const raw = detail.value.workflow_json || detail.value.prompt_json || detail.value.inputs_json
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
})

// 给 vue-json-pretty 用的对象形式（无法解析时返回 null）
const detailJsonData = computed(() => {
  if (!detailJson.value) return null
  try {
    return JSON.parse(detailJson.value)
  } catch {
    return null
  }
})

// 当前展示的 JSON 来源类型，用于标题提示
const detailJsonType = computed(() => {
  if (!detail.value) return ''
  if (detail.value.workflow_json) return 'workflow'
  if (detail.value.prompt_json) return 'prompt'
  if (detail.value.inputs_json) return 'inputs'
  return ''
})

// Viewer.js 图片预览
const detailImageRef = ref(null)
let viewer = null

const initViewer = () => {
  destroyViewer()
  if (!detailImageRef.value) return
  viewer = new Viewer(detailImageRef.value, {
    inline: true,
    viewMode: 1,
    zoomOnWheel: true,
    title: false,
    navbar: false,
    toolbar: {
      zoomIn: 1,
      zoomOut: 1,
      oneToOne: 1,
      reset: 1,
      rotateLeft: 1,
      rotateRight: 1,
      flipHorizontal: 1,
      flipVertical: 1,
    },
  })
}

const destroyViewer = () => {
  if (viewer) {
    try {
      viewer.destroy()
    } catch {
      // 已销毁
    }
    viewer = null
  }
}

// 原图加载完成：隐藏 loading，刷新 Viewer 布局
const onDetailImageLoad = () => {
  detailLoaded.value = true
  nextTick(() => {
    try {
      viewer?.update()
    } catch {
      // Viewer 可能尚未初始化或已销毁
    }
  })
}

watch(detailOpen, (open) => {
  if (open) {
    nextTick(initViewer)
  }
})

onBeforeUnmount(destroyViewer)

// 目录视图下展示的总数 = 所有目录 count 之和
const dirsCount = computed(() => dirs.value.reduce((acc, d) => acc + (Number(d.count) || 0), 0))
const activeDirLabel = computed(() => dirLabel(activeDir.value))

// 缩略图文件名规则须与主进程 scanner.makeThumb 一致：
// subfolder 的 \ 和 / 全部替换为 _，再加 `_` 前缀和 `.jpg` 后缀
const thumbFileName = (subfolder, filename) =>
  `${subfolder ? String(subfolder).replace(/[\\/]/g, '_') + '_' : ''}${filename}.jpg`

const dirThumbUrl = (d) =>
  `${serverHost.value}/api/gallery/thumbs/${encodeURIComponent(thumbFileName(d.subfolder, d.filename))}`
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
      body: JSON.stringify({
        page: page.value,
        pageSize,
        q: query.value || undefined,
        starred: starredOnly.value,
        subfolder: activeDir.value || undefined
      })
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

// 加载目录分层列表（按 subfolder 分组）
const fetchDirs = async () => {
  loading.value = true
  try {
    const res = await fetch(`${serverHost.value}/api/gallery/dirs`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ q: query.value || undefined, starred: starredOnly.value })
    })
    const data = await res.json()
    if (data.code === 200 || data.success) {
      dirs.value = (data.data?.dirs) || []
    } else {
      throw new Error(data.message)
    }
  } catch (e) {
    message.error(`${currentLang.value === 'zh' ? '加载失败' : 'Load failed'}: ${e.message}`)
    dirs.value = []
  } finally {
    loading.value = false
  }
}

// 目录显示名：取路径最后一段（兼容 \ 与 / 分隔）
const dirLabel = (subfolder) => {
  const segs = String(subfolder || '').split(/[\\/]/).filter(Boolean)
  return segs[segs.length - 1] || subfolder
}

// 进入目录（空串 = 全部）
const selectDir = (subfolder) => {
  activeDir.value = subfolder
  viewMode.value = 'items'
  page.value = 1
  items.value = []
  fetchList()
}

// 返回目录卡片视图
const goBackToDirs = () => {
  viewMode.value = 'dirs'
  activeDir.value = ''
  page.value = 1
  fetchDirs()
}

// 搜索 / 仅收藏变化：按当前视图刷新对应数据
const onFilterChange = () => {
  if (viewMode.value === 'dirs') {
    fetchDirs()
  } else {
    page.value = 1
    items.value = []
    fetchList()
  }
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
    if (viewMode.value === 'dirs') {
      fetchDirs()
    } else {
      page.value = 1
      items.value = []
      fetchList()
    }
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
  detailLoaded.value = false
  detailOpen.value = true
}

const download = (item) => {
  window.open(fullUrl(item), '_blank')
}

// 复制完整工作流/参数 JSON（与生成该图一致，可复原生成）
const copyWorkflow = async () => {
  if (!detailJson.value) {
    message.warning(currentLang.value === 'zh' ? '该图片暂无参数快照' : 'No parameter snapshot for this image')
    return
  }
  try {
    await navigator.clipboard.writeText(detailJson.value)
    message.success(currentLang.value === 'zh' ? '工作流已复制到剪贴板' : 'Workflow copied to clipboard')
  } catch {
    message.error(currentLang.value === 'zh' ? '复制失败，请手动选择复制' : 'Copy failed, please copy manually')
  }
}

// 下载工作流/参数 JSON
const downloadWorkflow = () => {
  if (!detailJson.value) {
    message.warning(currentLang.value === 'zh' ? '该图片暂无参数快照' : 'No parameter snapshot for this image')
    return
  }
  const base = detail.value?.filename?.replace(/\.[^.]+$/, '') || 'workflow'
  const blob = new Blob([detailJson.value], { type: 'application/json' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${base}.workflow.json`
  a.click()
  URL.revokeObjectURL(url)
}

const goApps = () => router.push('/')

const reRun = (item) => {
  router.push({ path: '/', query: { app: item.app_id, rerun: item.id } })
}

onMounted(fetchDirs)
</script>

<style scoped>
.dir-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}
.dir-card {
  background: rgba(30, 41, 59, 0.6);
  border: 1px solid rgba(148, 163, 184, 0.15);
  border-radius: 10px;
  overflow: hidden;
  cursor: pointer;
  transition: border-color 0.2s;
}
.dir-card:hover {
  border-color: rgba(56, 189, 248, 0.5);
}
.dir-thumb {
  height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(15, 23, 42, 0.6);
  font-size: 34px;
  color: rgba(56, 189, 248, 0.6);
}
.dir-thumb img {
  display: block;
}
.dir-thumb-all {
  font-size: 44px;
  color: rgba(56, 189, 248, 0.7);
}
.dir-name {
  padding: 8px 10px 0;
  font-size: 13px;
  color: #e2e8f0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dir-count {
  padding: 2px 10px 10px;
  font-size: 12px;
  color: #94a3b8;
}
.gallery-virtual-wrap {
  height: calc(100vh - 280px);
  min-height: 320px;
}
</style>
