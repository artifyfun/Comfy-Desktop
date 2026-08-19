<template>
  <div class="page-container bg-tech-dark">
    <div id="app" class="pb-20 min-h-screen">
      <div class="fixed inset-0 grid-lines"></div>
      <AppHeader />

      <main class="relative px-4 mx-auto mt-4 max-w-7xl sm:px-6 lg:px-8">
        <div class="flex items-center justify-between mb-4">
          <div class="flex items-center space-x-2">
            <div class="w-8 h-8 text-2xl text-tech-blue">
              <i class="fas fa-cube"></i>
            </div>
            <h1 class="text-xl font-bold text-white tech-font">{{ t('modelsTitle') }}</h1>
          </div>
          <div class="flex items-center gap-2">
            <a-button :loading="scanning" @click="loadList">
              {{ t('refresh') }}
            </a-button>
            <a-button :loading="checkingDups" @click="checkDuplicates">
              {{ t('findDuplicates') }}
            </a-button>
          </div>
        </div>

        <!-- 统计 -->
        <div class="grid grid-cols-2 gap-3 mb-4 md:grid-cols-4">
          <div class="p-3 rounded-lg glass-card">
            <div class="text-xs text-slate-400">{{ t('modelsCount') }}</div>
            <div class="text-lg font-bold text-white">{{ stats.count }}</div>
          </div>
          <div class="p-3 rounded-lg glass-card">
            <div class="text-xs text-slate-400">{{ t('modelsTotalSize') }}</div>
            <div class="text-lg font-bold text-white">{{ formatSize(stats.totalSize) }}</div>
          </div>
          <div class="p-3 rounded-lg glass-card">
            <div class="text-xs text-slate-400">{{ t('modelsTypes') }}</div>
            <div class="text-lg font-bold text-white">{{ Object.keys(stats.byType || {}).length }}</div>
          </div>
          <div class="p-3 rounded-lg glass-card">
            <div class="text-xs text-slate-400">{{ t('modelsLargest') }}</div>
            <div class="text-lg font-bold text-white truncate">
              {{ largest?.name || '-' }}
            </div>
            <div class="text-xs text-slate-500">{{ largest ? formatSize(largest.size) : '' }}</div>
          </div>
        </div>

        <!-- 类型筛选 -->
        <div class="flex flex-wrap gap-2 mb-4">
          <button
            v-for="(v, k) in stats.byType"
            :key="k"
            class="px-3 py-1 text-sm rounded-full transition-colors"
            :class="selectedType === k ? 'bg-tech-blue text-white' : 'bg-slate-700/50 text-slate-300 hover:bg-slate-600/50'"
            @click="toggleType(k)"
          >
            {{ k }} <span class="opacity-60">({{ v.count }})</span>
          </button>
        </div>

        <!-- 搜索 -->
        <a-input-search
          v-model:value="search"
          :placeholder="t('searchModels')"
          class="mb-4"
          allow-clear
        />

        <!-- 列表 -->
        <a-spin :spinning="scanning">
          <div class="overflow-x-auto rounded-lg glass-card">
            <table class="w-full text-sm" v-if="filtered.length">
              <thead>
                <tr class="text-left text-slate-400 border-b border-slate-700">
                  <th class="p-2">{{ t('modelsName') }}</th>
                  <th class="p-2">{{ t('modelsTypeCol') }}</th>
                  <th class="p-2">{{ t('modelsSize') }}</th>
                  <th class="p-2">{{ t('modelsModified') }}</th>
                  <th class="p-2"></th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="item in filtered"
                  :key="item.relPath"
                  class="border-b border-slate-800 hover:bg-slate-800/40"
                >
                  <td class="p-2 text-white">
                    <span class="mr-1">{{ item.name }}</span>
                    <a-tag v-if="verifyResults[item.relPath] === 'ok'" color="success" class="ml-1">
                      <i class="fas fa-check"></i>
                    </a-tag>
                    <a-tooltip v-else-if="verifyResults[item.relPath]?.error">
                      <template #title>{{ verifyResults[item.relPath].error }}</template>
                      <a-tag color="error" class="ml-1"><i class="fas fa-xmark"></i></a-tag>
                    </a-tooltip>
                  </td>
                  <td class="p-2 text-slate-400">{{ item.type }}</td>
                  <td class="p-2 text-slate-400">{{ formatSize(item.size) }}</td>
                  <td class="p-2 text-slate-400">{{ formatTime(item.mtime) }}</td>
                  <td class="p-2 text-right">
                    <a-button
                      v-if="item.name.endsWith('.safetensors')"
                      size="small"
                      :loading="verifying === item.relPath"
                      @click="verifyFile(item)"
                    >
                      {{ t('verify') }}
                    </a-button>
                  </td>
                </tr>
              </tbody>
            </table>
            <div v-else class="p-8 text-center text-slate-500">{{ t('modelsEmpty') }}</div>
            <div v-if="totalMatched > filtered.length" class="p-2 text-center text-xs text-slate-500">
              {{ t('modelsTruncated', { shown: filtered.length, total: totalMatched }) }}
            </div>
          </div>
        </a-spin>

        <!-- 重复检测弹窗 -->
        <a-modal
          :open="dupsOpen"
          :title="t('duplicateModels')"
          :footer="null"
          width="720px"
          @cancel="dupsOpen = false"
        >
          <a-alert
            v-if="dupGroups.length === 0"
            type="success"
            :message="t('noDuplicates')"
            show-icon
          />
          <template v-else>
            <a-alert type="warning" class="mb-3" show-icon>
              <template #message>
                {{ t('dupGroupsFound', { count: dupGroups.length }) }} ·
                {{ t('dupWasted', { size: formatSize(dupWasted) }) }}
              </template>
            </a-alert>
            <div class="max-h-96 space-y-3 overflow-auto">
              <div
                v-for="(group, gi) in dupGroups"
                :key="gi"
                class="p-2 rounded bg-slate-800/60"
              >
                <div class="mb-1 text-xs text-slate-400">
                  {{ group[0].type }} · {{ formatSize(group[0].size) }} × {{ group.length }}
                </div>
                <div v-for="f in group" :key="f.relPath" class="text-sm text-white">
                  {{ f.relPath }}
                </div>
              </div>
            </div>
          </template>
        </a-modal>
      </main>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAppStore } from '@/stores/appStore'
import AppHeader from '../apps/components/AppHeader.vue'
import { t } from '@/utils/i18n'

const router = useRouter()
const appStore = useAppStore()

const items = ref([])
const stats = ref({ count: 0, totalSize: 0, byType: {} })
const scanning = ref(false)
const search = ref('')
const selectedType = ref('')
const verifying = ref('')
const verifyResults = ref({}) // { [relPath]: 'ok' | { error } }
const dupsOpen = ref(false)
const checkingDups = ref(false)
const dupGroups = ref([])
const dupWasted = ref(0)

const host = computed(() => appStore.config?.serverHost || window.location.origin)
// 渲染上限：万级模型全量渲染 DOM 会卡，截断显示 + 提示（后端列表仍完整统计）
const RENDER_LIMIT = 500
const filtered = computed(() => {
  let list = items.value
  if (selectedType.value) list = list.filter((i) => i.type === selectedType.value)
  const q = search.value.trim().toLowerCase()
  if (q) list = list.filter((i) => i.name.toLowerCase().includes(q))
  return list.slice(0, RENDER_LIMIT)
})
const totalMatched = computed(() => {
  let list = items.value
  if (selectedType.value) list = list.filter((i) => i.type === selectedType.value)
  const q = search.value.trim().toLowerCase()
  if (q) list = list.filter((i) => i.name.toLowerCase().includes(q))
  return list.length
})
const largest = computed(() => [...items.value].sort((a, b) => b.size - a.size)[0] || null)

function toggleType(k) {
  selectedType.value = selectedType.value === k ? '' : k
}

function formatSize(bytes) {
  if (!bytes) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = bytes
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function formatTime(ms) {
  return new Date(ms).toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

async function loadList() {
  scanning.value = true
  try {
    const res = await fetch(`${host.value}/api/models/list`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({})
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || `http ${res.status}`)
    items.value = json.data.items || []
    stats.value = json.data.stats || { count: 0, totalSize: 0, byType: {} }
  } catch (e) {
    console.error('加载模型列表失败:', e)
  } finally {
    scanning.value = false
  }
}

async function verifyFile(item) {
  verifying.value = item.relPath
  try {
    const res = await fetch(`${host.value}/api/models/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relPath: item.relPath })
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || `http ${res.status}`)
    verifyResults.value = {
      ...verifyResults.value,
      [item.relPath]: json.data.ok ? 'ok' : { error: json.data.error }
    }
  } catch (e) {
    verifyResults.value = { ...verifyResults.value, [item.relPath]: { error: e.message } }
  } finally {
    verifying.value = ''
  }
}

async function checkDuplicates() {
  checkingDups.value = true
  try {
    const res = await fetch(`${host.value}/api/models/duplicates`, { method: 'POST' })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || `http ${res.status}`)
    dupGroups.value = json.data.groups || []
    dupWasted.value = json.data.wastedBytes || 0
    dupsOpen.value = true
  } catch (e) {
    console.error('重复检测失败:', e)
  } finally {
    checkingDups.value = false
  }
}

onMounted(loadList)
</script>

<style scoped>
.glass-card {
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(56, 70, 102, 0.4);
}
</style>
