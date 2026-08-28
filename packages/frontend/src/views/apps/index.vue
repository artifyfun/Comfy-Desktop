<template>
  <div class="page-container bg-tech-dark">
    <div id="app" class="pb-20 min-h-screen">
      <!-- 顶部导航：应用中心页自己展示「应用市场」入口，避免自指 -->
      <AppHeader
        :first-nav-to="'/market'"
        :first-nav-label="t('market')"
        first-nav-icon="mr-2 fas fa-store"
      />

      <!-- 主内容区 -->
      <main class="relative px-4 mx-auto mt-4 max-w-7xl sm:px-6 lg:px-8">
        <!-- 标题区域 -->
        <!-- <div class="mb-10 text-center">
          <h2 class="mb-4 text-4xl font-bold text-white md:text-5xl">
            <span class="text-[var(--wb-accent)]">{{ t('app') }}</span> {{ t('center') }}
          </h2>
          <p class="mx-auto max-w-2xl text-xl text-slate-300">
            {{ t('exploreFrontierAI') }}
          </p>
        </div> -->
        <div class="flex items-center mb-2 space-x-4">
          <div class="flex items-center space-x-2">
            <div class="w-8 h-8 text-2xl text-[var(--wb-accent)]">
              <i class="fas fa-home"></i>
            </div>
            <h1 class="text-2xl font-bold text-white">{{ t('app') }}{{ t('center') }}</h1>
          </div>
        </div>

        <!-- 操作区域 -->
        <AppActions
          :apps="appStore.apps"
          :search-query="searchQuery"
          :selected-category="selectedCategory"
          :search-history="searchHistory"
          :view-mode="viewMode"
          @update:search-query="searchQuery = $event"
          @update:selected-category="selectedCategory = $event"
          @update:view-mode="viewStore.updateViewMode"
          @search="handleSearch"
          @history-click="handleHistoryClick"
          @suggestion-click="handleSuggestionClick"
          @clear-history="clearAllHistory"
          @delete-history-item="deleteHistoryItem"
          @create-new="handleShowAppForm"
          @import-app="handleAppUploadChange"
        />

        <!-- 应用网格 -->
        <div class="h-[calc(100vh-270px)]">
          <a-spin :spinning="appStore.isLoading">
            <AppGrid
              :apps="appStore.apps"
              :search-query="searchQuery"
              :selected-category="selectedCategory"
              :view-mode="viewMode"
              @view-detail="viewAppDetail"
              @edit="handleShowAppForm"
              @delete="removeApp"
              @clear-search="searchQuery = ''"
              @clear-filter="selectedCategory = ''"
            />
          </a-spin>
        </div>
      </main>

      <!-- 添加应用表单 -->
      <AppForm v-if="showAppForm" :app="currentApp" @close="showAppForm = false" @save="saveApp" />

      <!-- 应用详情 -->
      <AppDetail
        v-if="!!selectedApp"
        :app="selectedApp"
        @close="selectedApp = null"
        @edit="handleShowAppForm"
        @delete="removeApp"
      />
    </div>
  </div>
</template>

<script setup>
import { ref, computed } from 'vue'
import localforage from 'localforage'
import { useRoute, useRouter } from 'vue-router'
import { uuidv4, showError, showSuccess, showInfo } from '@/utils'
import { useAppStore } from '@/stores/appStore'
import { useViewStore } from '@/stores/viewStore'
import { t } from '@/utils/i18n'
import AppHeader from './components/AppHeader.vue'
import AppActions from './components/AppActions.vue'
import AppGrid from './components/AppGrid.vue'
import AppForm from './components/AppForm.vue'
import AppDetail from './components/AppDetail.vue'

const appStore = useAppStore()
const viewStore = useViewStore()
const route = useRoute()
const router = useRouter()

// 新增应用表单状态
const showAppForm = ref(false)
const selectedApp = ref(null)

// 搜索相关
const searchQuery = ref('')
const searchHistory = ref([])

// 分类筛选
const selectedCategory = ref('')

// 视图模式 - 使用 viewStore 中的状态
const viewMode = computed(() => viewStore.viewMode)

// 新应用数据模型
const currentApp = ref(null)

// 添加搜索历史
const addToSearchHistory = (query) => {
  if (query.trim() && !searchHistory.value.includes(query.trim())) {
    searchHistory.value.unshift(query.trim())
    // 限制历史记录数量
    if (searchHistory.value.length > 5) {
      searchHistory.value = searchHistory.value.slice(0, 5)
    }
  }
}

// 处理搜索
const handleSearch = () => {
  if (searchQuery.value.trim()) {
    addToSearchHistory(searchQuery.value)
  }
}

async function init() {
  await appStore.loadApps()
  await handleRerunQuery()
}

/**
 * 消费 Gallery「复用参数再跑」的跳转：/?app=<id>&rerun=<gallery asset id>
 * 流程：拉 gallery 记录 → 把记录的 inputs 预写入 workflow state 槽位
 * （useWorkflow 的 getLastState 会读取并合并）→ 激活 app → 跳 /web 运行。
 */
async function handleRerunQuery() {
  const appId = route.query.app
  const rerunId = route.query.rerun
  if (!appId || !rerunId) return
  try {
    const origin = appStore.config?.serverHost || window.location.origin
    const res = await fetch(`${origin}/api/gallery/detail?id=${encodeURIComponent(rerunId)}`)
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'gallery detail failed')
    const record = json.data || {}
    const inputs = record.inputs_json ? JSON.parse(record.inputs_json) : null
    if (!inputs) {
      showInfo(t('noParamsRecorded'))
      router.replace({ query: {} })
      return
    }
    const app = appStore.apps.find((a) => a.id === appId)
    if (!app) {
      showError(t('appNotFound'))
      router.replace({ query: {} })
      return
    }
    await localforage.setItem(`workflows/state/${appId}`, { inputs })
    await appStore.updateConfig({ activeAppId: appId })
    // 先落盘再清 query，避免中途 replace 触发重入
    router.replace({ query: {} })
    router.push('/web')
  } catch (e) {
    console.warn('rerun failed', e)
    showError(e.message || 'rerun failed')
    router.replace({ query: {} })
  }
}

init()

// 添加新应用
async function saveApp(app) {
  if (app.id) {
    await appStore.updateApp(app)
    selectedApp.value = JSON.parse(JSON.stringify(app))
  } else {
    const newItem = {
      ...app,
    }
    await appStore.addApp(newItem)
  }
  showAppForm.value = false
}

function handleShowAppForm(app) {
  if (app) {
    currentApp.value = JSON.parse(JSON.stringify(app))
  } else {
    const defaultData = appStore.getAppSchema()
    currentApp.value = JSON.parse(JSON.stringify(defaultData))
  }
  showAppForm.value = true
}

function removeApp(app) {
  appStore.removeApp(app.id)
  selectedApp.value = null
}

// 查看应用详情
function viewAppDetail(app) {
  selectedApp.value = JSON.parse(JSON.stringify(app))
}

async function handleAppUploadChange({ file }) {
  // 检查文件类型
  if (!file.name.toLowerCase().endsWith('.json')) {
    showError('onlyJsonFilesAllowed')
    return
  }

  try {
    const reader = new FileReader()
    reader.onload = async () => {
      try {
        const data = JSON.parse(reader.result)

        // 判断数据类型：如果是对象，视为单个应用；如果是数组，视为多个应用
        let appsToImport = []

        if (Array.isArray(data)) {
          // 数组：多个应用
          appsToImport = data
        } else if (typeof data === 'object' && data !== null) {
          // 对象：单个应用
          appsToImport = [data]
        } else {
          throw new Error('Invalid data format')
        }

        // 验证应用数据结构
        const validApps = appsToImport.filter((app) => {
          return app && typeof app === 'object' && app.name && app.template && app.template.prompt
        })

        if (validApps.length === 0) {
          showError('noValidAppsFound')
          return
        }

        // 为每个应用生成新的ID并导入
        const appsWithNewIds = validApps.map((app) => ({ ...app, id: uuidv4() }))
        await appStore.mergeApps(appsWithNewIds)

        showSuccess('importSuccess', { count: validApps.length })
      } catch (error) {
        console.error('导入应用失败:', error)
        showError('importAppsError')
      }
    }
    reader.readAsText(file)
  } catch (error) {
    console.error('文件读取失败:', error)
    showError('importAppsError')
  }
}

function handleHistoryClick(history) {
  searchQuery.value = history
}

function handleSuggestionClick(suggestion) {
  searchQuery.value = suggestion
}

function clearAllHistory() {
  searchHistory.value = []
}

function deleteHistoryItem(index) {
  searchHistory.value.splice(index, 1)
}
</script>

<style lang="less" scoped>
.page-container {
  height: 100%;
  width: 100%;
  font-family: var(--wb-font);
  background: var(--wb-bg-base);
  min-height: 100vh;
  color: var(--wb-text);
  overflow-x: hidden;

  .grid-lines {
    display: none;
  }
}
</style>
