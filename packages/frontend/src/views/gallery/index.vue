<template>
  <div class="page-container bg-tech-dark h-full flex flex-col overflow-hidden">
    <!-- 主内容区（高度链：AppLayout 锁高 → 本页 flex 内滚，目录流/瀑布流各自内部滚动，
         避免 calc(100vh-*) 未折算 header 高度导致页面恒有纵向滚动条） -->
    <div id="app" class="flex flex-col flex-1 min-h-0 min-w-0">
      <main
        class="relative flex flex-col flex-1 min-h-0 w-full px-4 mx-auto mt-4 max-w-7xl sm:px-6 lg:px-8"
      >
        <div class="shrink-0 flex flex-wrap gap-3 items-center justify-between mb-6">
          <div class="flex items-center space-x-2">
            <div class="w-8 h-8 text-2xl text-tech-blue">
              <i class="fas fa-images"></i>
            </div>
            <h1 class="text-2xl font-bold text-white">
              {{ t('gallery') }}
            </h1>
            <span class="text-sm text-[var(--wb-text-2)]">
              {{ viewMode === 'dirs' ? dirsCount : total }}
              {{ currentLang === 'zh' ? '项' : 'items' }}
            </span>
          </div>
          <div class="flex items-center gap-2">
            <div class="relative">
              <input
                v-model="query"
                type="text"
                :placeholder="
                  currentLang === 'zh' ? '搜索文件名 / 应用名' : 'Search filename / app'
                "
                class="px-4 py-2 pl-10 w-full text-white rounded-[var(--wb-r-ctrl)] tech-input focus:outline-none"
                style="width: 200px"
                @keyup.enter="onFilterChange"
                @input="onFilterChange"
              />
              <i
                class="absolute left-3 top-1/2 transform -translate-y-1/2 fas fa-search text-[var(--wb-text-2)]"
              ></i>
              <button
                v-if="query"
                @click="clearQuery"
                class="absolute right-3 top-1/2 transform -translate-y-1/2 text-[var(--wb-text-2)] hover:text-[var(--wb-text)]"
              >
                <i class="fas fa-times"></i>
              </button>
            </div>
            <a-checkbox v-model:checked="starredOnly" @change="onFilterChange">
              {{ currentLang === 'zh' ? '仅收藏' : 'Starred' }}
            </a-checkbox>
            <a-button :loading="scanning" @click="scan">
              <i class="mr-1 fas fa-sync"></i>{{ currentLang === 'zh' ? '扫描' : 'Scan' }}
            </a-button>
            <a-button
              v-if="viewMode === 'items'"
              :type="selectionMode ? 'primary' : 'default'"
              @click="toggleSelectionMode"
            >
              <i class="mr-1 fas fa-check-square"></i>{{ currentLang === 'zh' ? '多选' : 'Select' }}
            </a-button>
          </div>
        </div>

        <!-- 批量操作条 -->
        <div
          v-if="viewMode === 'items' && selectionMode"
          class="shrink-0 mb-4 flex flex-wrap items-center gap-3 rounded-[var(--wb-r-ctrl)] bg-[var(--wb-surface-deep)] px-4 py-2"
        >
          <span class="text-sm text-[var(--wb-text)]">{{ selectedLabel }}</span>
          <a-button size="small" @click="toggleSelectAll">
            <i class="mr-1 fas" :class="allSelected ? 'fa-square' : 'fa-check-double'"></i
            >{{
              allSelected
                ? currentLang === 'zh'
                  ? '取消全选'
                  : 'Deselect all'
                : currentLang === 'zh'
                  ? '全选'
                  : 'Select all'
            }}
          </a-button>
          <a-button size="small" @click="batchStar(true)">
            <i class="mr-1 fas fa-star"></i>{{ currentLang === 'zh' ? '批量收藏' : 'Star all' }}
          </a-button>
          <a-button size="small" @click="batchStar(false)">
            <i class="mr-1 fas fa-star-half-alt"></i
            >{{ currentLang === 'zh' ? '取消收藏' : 'Unstar all' }}
          </a-button>
          <a-popconfirm
            :title="
              currentLang === 'zh'
                ? `确定删除选中的 ${selectedIds.length} 项吗？磁盘文件将被一并删除，不可恢复`
                : `Delete ${selectedIds.length} selected items? Files will be removed from disk permanently`
            "
            ok-text="删除"
            cancel-text="取消"
            @confirm="batchRemove"
          >
            <a-button size="small" danger>
              <i class="mr-1 fas fa-trash"></i
              >{{ currentLang === 'zh' ? '批量删除' : 'Delete all' }}
            </a-button>
          </a-popconfirm>
          <a-button size="small" @click="toggleSelectionMode">
            {{ currentLang === 'zh' ? '取消' : 'Cancel' }}
          </a-button>
        </div>

        <!-- ===== 目录卡片视图（默认） ===== -->
        <template v-if="viewMode === 'dirs'">
          <!-- 目录卡片视图：网格内容超一屏时在本容器内滚（外层锁高，无页面级滚动条） -->
          <div class="flex-1 min-h-0 overflow-y-auto overflow-x-hidden">
          <div v-if="loading" class="py-20 text-center text-[var(--wb-text-2)]">
            <a-spin size="large" />
          </div>

          <div v-else-if="!dirs.length" class="py-20 text-center text-[var(--wb-text-2)]">
            <div class="mb-4"><i class="text-5xl fas fa-folder-open"></i></div>
            {{ currentLang === 'zh' ? '暂无生成目录，先去跑一张吧' : 'No directories yet' }}
            <div class="mt-4">
              <a-button type="primary" @click="goApps">{{ t('app') }}{{ t('center') }}</a-button>
            </div>
          </div>

          <div v-else class="dir-grid">
            <!-- 全部目录卡片 -->
            <div class="dir-card group" @click="selectDir('')">
              <div class="dir-thumb dir-thumb-all">
                <i class="fas fa-layer-group"></i>
              </div>
              <div class="dir-name">{{ currentLang === 'zh' ? '全部' : 'All' }}</div>
              <div class="dir-count">
                {{ dirsCount }} {{ currentLang === 'zh' ? '项' : 'items' }}
              </div>
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
              <div class="dir-del" @click.stop>
                <a-popconfirm
                  :title="dirRemoveTitle(d)"
                  ok-text="删除"
                  cancel-text="取消"
                  @confirm="removeDir(d)"
                >
                  <a-button size="small" danger type="text" class="dir-del-btn">
                    <i class="far fa-trash-alt"></i>
                  </a-button>
                </a-popconfirm>
              </div>
            </div>
          </div>
          </div>
        </template>

        <!-- ===== 目录内图片瀑布流 ===== -->
        <template v-else>
          <!-- 目录内视图：flex 链锁高，返回行/加载更多常驻，瀑布流容器占满剩余高度自滚 -->
          <div class="flex-1 min-h-0 flex flex-col overflow-hidden">
          <div class="shrink-0 mb-4 flex items-center gap-3">
            <a-button size="small" @click="goBackToDirs">
              <i class="mr-1 fas fa-arrow-left"></i>{{ currentLang === 'zh' ? '返回目录' : 'Back' }}
            </a-button>
            <span class="text-sm text-[var(--wb-text)]">
              <i class="mr-1 fas fa-folder"></i>{{ activeDirLabel }}
            </span>
          </div>

          <div v-if="loading" class="flex-1 min-h-0 overflow-y-auto py-20 text-center text-[var(--wb-text-2)]">
            <a-spin size="large" />
          </div>

          <div
            v-else-if="!items.length"
            class="flex-1 min-h-0 overflow-y-auto py-20 text-center text-[var(--wb-text-2)]"
          >
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
              :select-mode="selectionMode"
              :selected-ids="selectedIds"
              @open="showDetail"
              @star="toggleStar"
              @remove="remove"
              @img-error="onImgError"
              @load-more="loadMore"
              @toggle-select="toggleSelect"
            />
          </div>

          <div
            v-if="items.length && items.length < total"
            class="shrink-0 mt-8 text-center"
          >
            <a-button :loading="loading" @click="loadMore">
              {{ currentLang === 'zh' ? '加载更多' : 'Load more' }}
            </a-button>
          </div>
          </div>
        </template>
      </main>

      <!-- 详情弹窗 -->
      <a-modal
        v-model:open="detailOpen"
        :title="detail?.filename"
        width="960px"
        :top="48"
        :footer="null"
        @after-close="destroyViewer"
      >
        <div v-if="detail" class="flex flex-col gap-4 md:flex-row">
          <div class="md:w-2/3">
            <!-- Viewer.js inline 预览：滚轮缩放 / 拖拽平移 / 工具栏 -->
            <div class="relative">
              <div
                v-if="!detailLoaded"
                class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[var(--wb-surface-deep)]"
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
            <div class="mt-2 text-center text-xs text-[var(--wb-text-2)]">
              {{
                currentLang === 'zh'
                  ? '滚轮缩放，拖拽平移，点击图片可全屏'
                  : 'Wheel to zoom, drag to pan, click image for fullscreen'
              }}
            </div>
          </div>
          <div class="space-y-3 md:w-1/3">
            <a-descriptions :column="1" size="small">
              <a-descriptions-item :label="currentLang === 'zh' ? '时间' : 'Time'">{{
                formatTime(detail.created_at)
              }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '应用' : 'App'">{{
                detail.app_name || '-'
              }}</a-descriptions-item>
              <a-descriptions-item :label="currentLang === 'zh' ? '大小' : 'Size'">{{
                formatSize(detail.size)
              }}</a-descriptions-item>
            </a-descriptions>

            <div class="flex flex-wrap gap-2">
              <a-button v-if="detail.app_id" type="primary" @click="reRun(detail)">
                <i class="mr-1 fas fa-redo"></i
                >{{ currentLang === 'zh' ? '用此参数再跑' : 'Re-run' }}
              </a-button>
              <a-button @click="download(detail)">
                <i class="mr-1 fas fa-download"></i
                >{{ currentLang === 'zh' ? '下载图片' : 'Download image' }}
              </a-button>
              <a-button v-if="detailJson" @click="copyWorkflow">
                <i class="mr-1 fas fa-copy"></i
                >{{ currentLang === 'zh' ? '复制工作流' : 'Copy workflow' }}
              </a-button>
              <a-button v-if="detailJson" @click="downloadWorkflow">
                <i class="mr-1 fas fa-file-code"></i
                >{{ currentLang === 'zh' ? '下载工作流' : 'Download workflow' }}
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
import { useRouter, useRoute } from 'vue-router'
import { message, Modal } from 'ant-design-vue'
import Viewer from 'viewerjs'
import 'viewerjs/dist/viewer.css'
import GalleryVirtualMasonry from './components/GalleryVirtualMasonry.vue'
import { useAppStore } from '@/stores/appStore'
import { useI18nInComponent } from '@/utils/i18n'
import dayjs from 'dayjs'

const { t, currentLang } = useI18nInComponent()
const router = useRouter()
const route = useRoute()
const appStore = useAppStore()

const viewMode = ref('dirs') // 'dirs' = 目录卡片视图 | 'items' = 目录内图片视图
const items = ref([])
const selectionMode = ref(false)
const selectedIds = ref([])
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
// 供「复制工作流 / 下载工作流」按钮使用。
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
        subfolder: activeDir.value || undefined,
      }),
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
      body: JSON.stringify({ q: query.value || undefined, starred: starredOnly.value }),
    })
    const data = await res.json()
    if (data.code === 200 || data.success) {
      dirs.value = data.data?.dirs || []
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
  const segs = String(subfolder || '')
    .split(/[\\/]/)
    .filter(Boolean)
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

// 清空搜索关键词并刷新
const clearQuery = () => {
  query.value = ''
  onFilterChange()
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
        : `Scan done: ${payload.added}/${payload.scanned} added`,
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

// ===== 多选 / 批量操作 =====
const toggleSelectionMode = () => {
  selectionMode.value = !selectionMode.value
  if (!selectionMode.value) {
    selectedIds.value = []
  }
}

// 全选 / 取消全选（当前已加载列表）
const allSelected = computed(
  () => items.value.length > 0 && items.value.every((i) => selectedIds.value.includes(i.id)),
)
// 已选计数文案（含「仅已加载」提示；独立 computed 避免模板内联复杂表达式）
const selectedLabel = computed(() => {
  const n = selectedIds.value.length
  const loadedOnly = items.value.length > 0 && n < total.value
  if (currentLang.value === 'zh') {
    return n === 0 ? '已选 0 项' : `已选 ${n} 项${loadedOnly ? '（当前已加载）' : ''}`
  }
  return `${n} selected${loadedOnly ? ' (loaded only)' : ''}`
})
const toggleSelectAll = () => {
  if (allSelected.value) {
    const ids = new Set(items.value.map((i) => i.id))
    selectedIds.value = selectedIds.value.filter((id) => !ids.has(id))
  } else {
    selectedIds.value = [...new Set([...selectedIds.value, ...items.value.map((i) => i.id)])]
  }
}

const toggleSelect = (item) => {
  const idx = selectedIds.value.indexOf(item.id)
  if (idx > -1) {
    selectedIds.value.splice(idx, 1)
  } else {
    selectedIds.value.push(item.id)
  }
}

const batchStar = async (starred) => {
  if (!selectedIds.value.length) return
  try {
    await fetch(`${serverHost.value}/api/gallery/batch-star`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds.value, starred }),
    })
    items.value.forEach((i) => {
      if (selectedIds.value.includes(i.id)) i.starred = starred ? 1 : 0
    })
    message.success(
      currentLang.value === 'zh'
        ? `已${starred ? '收藏' : '取消收藏'} ${selectedIds.value.length} 项`
        : `${selectedIds.value.length} item(s) ${starred ? 'starred' : 'unstarred'}`,
    )
  } catch (e) {
    message.error(
      `${currentLang.value === 'zh' ? '批量操作失败' : 'Batch operation failed'}: ${e.message}`,
    )
  }
}

const batchRemove = async () => {
  if (!selectedIds.value.length) return
  try {
    const res = await fetch(`${serverHost.value}/api/gallery/batch-remove`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: selectedIds.value }),
    })
    const data = await res.json()
    if (data.code !== 200 && !data.success) throw new Error(data.message)
    items.value = items.value.filter((i) => !selectedIds.value.includes(i.id))
    total.value -= selectedIds.value.length
    selectedIds.value = []
    selectionMode.value = false
    message.success(
      currentLang.value === 'zh'
        ? '已删除选中项（含磁盘文件）'
        : 'Selected items deleted (files removed)',
    )
  } catch (e) {
    message.error(
      `${currentLang.value === 'zh' ? '批量删除失败' : 'Batch delete failed'}: ${e.message}`,
    )
  }
}

// 删除整个目录（物理目录 + 缩略图 + 库记录）
const dirRemoveTitle = (d) =>
  currentLang.value === 'zh'
    ? `删除整个目录「${dirLabel(d.subfolder)}」及其 ${d.count} 项图片？磁盘文件将被一并删除，不可恢复`
    : `Delete directory "${dirLabel(d.subfolder)}" and its ${d.count} images? Files will be removed from disk permanently`

const removeDir = async (d) => {
  try {
    const res = await fetch(`${serverHost.value}/api/gallery/remove-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subfolder: d.subfolder }),
    })
    const data = await res.json()
    if (data.code !== 200 && !data.success) throw new Error(data.message)
    const payload = data.data || data
    const removed = payload.removedFiles ?? d.count
    message.success(
      currentLang.value === 'zh'
        ? `已删除目录「${dirLabel(d.subfolder)}」（${removed} 个文件）`
        : `Directory "${dirLabel(d.subfolder)}" deleted (${removed} files)`,
    )
    if (activeDir.value === d.subfolder) {
      goBackToDirs()
    } else {
      fetchDirs()
    }
  } catch (e) {
    message.error(
      `${currentLang.value === 'zh' ? '删除目录失败' : 'Delete directory failed'}: ${e.message}`,
    )
  }
}

const toggleStar = async (item) => {
  item.starred = item.starred ? 0 : 1
  await fetch(`${serverHost.value}/api/gallery/star`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: item.id, starred: !!item.starred }),
  })
}

const remove = (item) => {
  Modal.confirm({
    title: currentLang.value === 'zh' ? '删除这张图片？' : 'Delete this image?',
    content:
      currentLang.value === 'zh'
        ? '磁盘文件将被一并删除，不可恢复'
        : 'The file will be removed from disk permanently',
    okText: currentLang.value === 'zh' ? '删除' : 'Delete',
    cancelText: currentLang.value === 'zh' ? '取消' : 'Cancel',
    okButtonProps: { danger: true },
    async onOk() {
      const res = await fetch(`${serverHost.value}/api/gallery/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: item.id }),
      })
      const data = await res.json()
      if (data.code !== 200 && !data.success) throw new Error(data.message)
      items.value = items.value.filter((i) => i.id !== item.id)
      total.value--
      message.success(
        currentLang.value === 'zh' ? '已删除（含磁盘文件）' : 'Deleted (file removed)',
      )
    },
    onError: (err) => {
      message.error(
        `${currentLang.value === 'zh' ? '删除失败' : 'Delete failed'}: ${err?.message ?? err}`,
      )
    },
  })
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
    message.warning(
      currentLang.value === 'zh' ? '该图片暂无参数快照' : 'No parameter snapshot for this image',
    )
    return
  }
  try {
    await navigator.clipboard.writeText(detailJson.value)
    message.success(
      currentLang.value === 'zh' ? '工作流已复制到剪贴板' : 'Workflow copied to clipboard',
    )
  } catch {
    message.error(
      currentLang.value === 'zh' ? '复制失败，请手动选择复制' : 'Copy failed, please copy manually',
    )
  }
}

// 下载工作流/参数 JSON
const downloadWorkflow = () => {
  if (!detailJson.value) {
    message.warning(
      currentLang.value === 'zh' ? '该图片暂无参数快照' : 'No parameter snapshot for this image',
    )
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

onMounted(() => {
  const q = typeof route.query.q === 'string' ? route.query.q : ''
  if (q) {
    query.value = q
    viewMode.value = 'items'
    activeDir.value = ''
    page.value = 1
    fetchList()
  } else {
    fetchDirs()
  }
})
</script>

<style scoped>
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

.dir-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 14px;
}
.dir-card {
  position: relative;
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  overflow: hidden;
  cursor: pointer;
  transition:
    border-color 0.2s,
    background 0.2s;
}
.dir-card:hover {
  background: var(--wb-surface-hover);
  border-color: var(--wb-stroke-strong);
}
.dir-del {
  position: absolute;
  top: 6px;
  right: 6px;
  z-index: 5;
  opacity: 0;
  transition: opacity 0.2s;
}
.dir-card:hover .dir-del {
  opacity: 1;
}
.dir-del-btn {
  background: rgba(0, 0, 0, 0.55);
  border-radius: 6px;
}
.dir-thumb {
  height: 110px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--wb-surface);
  font-size: 34px;
  color: var(--wb-text-3);
}
.dir-thumb img {
  display: block;
}
.dir-thumb-all {
  font-size: 44px;
  color: var(--wb-text-2);
}
.dir-name {
  padding: 8px 10px 0;
  font-size: 13px;
  color: var(--wb-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dir-count {
  padding: 2px 10px 10px;
  font-size: 12px;
  color: var(--wb-text-2);
}
.gallery-virtual-wrap {
  /* flex 链撑满剩余高度（替代 calc(100vh-280px)：外层 header 折算差会让页面恒有滚动条）；
     min-height 兜底小窗口，masonry 内部 .gallery-masonry-scroll 自滚 */
  flex: 1 1 0%;
  min-height: 320px;
  min-width: 0;
  overflow: hidden;
}
</style>
