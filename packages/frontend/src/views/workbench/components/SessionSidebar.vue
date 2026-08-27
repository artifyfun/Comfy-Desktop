<template>
  <aside
    class="session-sidebar flex flex-col bg-slate-900/80 border-r border-slate-700 transition-all duration-300 shrink-0"
    :class="collapsed ? 'w-0 overflow-hidden border-r-0' : 'w-60 h-[calc(100vh-160px)]'"
  >
    <!-- 品牌行 + 折叠 -->
    <div class="flex items-center justify-between px-2 h-12 border-b border-slate-700">
      <template v-if="!collapsed">
        <span class="text-sm font-semibold text-white">Artify</span>
        <button class="text-slate-400 hover:text-white px-1" @click="$emit('collapse')">
          <i class="fas fa-angles-left"></i>
        </button>
      </template>
      <button v-else class="w-full text-slate-400 hover:text-white" @click="$emit('collapse')">
        <i class="fas fa-angles-right"></i>
      </button>
    </div>

    <template v-if="!collapsed">
      <!-- 新建会话 -->
      <div class="p-2">
        <button
          class="w-full px-3 py-2 rounded-lg bg-tech-blue/80 hover:bg-tech-blue text-white text-sm font-medium transition flex items-center justify-center gap-2"
          @click="$emit('new-session')"
        >
          <i class="fas fa-plus"></i>{{ t('workbenchNewSession') }}
        </button>
      </div>

      <!-- 搜索 -->
      <div class="px-2 pb-2">
        <input
          v-model="query"
          :placeholder="t('workbenchSearchSessions')"
          class="wb-tech-input w-full px-3 py-1.5 text-sm focus:outline-none"
        />
      </div>

      <!-- 归档切换 -->
      <!-- 归档视图切换（ChatGPT/dsh 语义：查看已归档会话，非批量操作） -->
      <div class="px-2 pb-1 flex items-center justify-between">
        <template v-if="!showArchived">
          <span />
          <button
            class="text-[11px] px-2 py-0.5 rounded flex items-center gap-1.5 text-slate-500 hover:text-slate-300 transition"
            :title="t('workbenchArchivedView')"
            @click="$emit('update:showArchived', true)"
          >
            <i class="fas fa-box-archive"></i>{{ t('workbenchArchivedView') }}
            <span
              v-if="archivedCount > 0"
              class="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-slate-700 text-slate-300"
              >{{ archivedCount }}</span
            >
          </button>
        </template>
        <button
          v-else
          class="flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded text-tech-cyan hover:bg-slate-800 transition"
          @click="$emit('update:showArchived', false)"
        >
          <i class="fas fa-arrow-left text-[10px]"></i>{{ t('workbenchBackToSessions') }}
        </button>
      </div>

      <!-- 会话列表（时间分组） -->
      <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        <div v-if="groups.length === 0" class="text-center text-xs text-slate-500 mt-6">
          {{ showArchived ? t('workbenchNoArchived') : t('workbenchNoSessions') }}
        </div>
        <div v-for="g in groups" :key="g.label">
          <div class="text-[11px] text-slate-500 px-2 pb-1">{{ g.label }}</div>
          <div
            v-for="s in g.sessions"
            :key="s.id"
            class="group relative rounded-lg px-2 py-1.5 cursor-pointer transition"
            :class="s.id === currentId ? 'bg-slate-700/70' : 'hover:bg-slate-800/70'"
            @click="$emit('select', s)"
          >
            <!-- 状态点 -->
            <span
              v-if="statusDot(s)"
              class="absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
              :class="statusDot(s)"
            ></span>
            <div
              class="pl-2 pr-10 text-sm truncate"
              :class="s.id === currentId ? 'text-white' : 'text-slate-300'"
            >
              {{ s.title }}
            </div>
            <!-- 行操作 -->
            <div
              v-if="!showArchived"
              class="absolute right-1 top-1/2 -translate-y-1/2 hidden group-hover:flex gap-0.5"
            >
              <button
                v-if="!s.archived"
                class="w-6 h-6 rounded text-slate-400 hover:text-white hover:bg-slate-600 flex items-center justify-center"
                :title="t('workbenchRename')"
                @click.stop="startRename(s)"
              >
                <i class="fas fa-pen text-xs"></i>
              </button>
              <button
                class="w-6 h-6 rounded text-slate-400 hover:text-white hover:bg-slate-600 flex items-center justify-center"
                :title="t('workbenchArchive')"
                @click.stop="$emit('archive', s)"
              >
                <i class="fas fa-box-archive text-xs"></i>
              </button>
              <button
                class="w-6 h-6 rounded text-slate-400 hover:text-red-400 hover:bg-slate-600 flex items-center justify-center"
                :title="t('delete')"
                @click.stop="$emit('delete', s)"
              >
                <i class="fas fa-trash text-xs"></i>
              </button>
            </div>
            <!-- 归档恢复 -->
            <button
              v-if="showArchived"
              class="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded text-slate-400 hover:text-white hover:bg-slate-600 flex items-center justify-center"
              :title="t('workbenchUnarchive')"
              @click.stop="$emit('unarchive', s)"
            >
              <i class="fas fa-arrow-rotate-left text-xs"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- 底部：设置 + 技能管理 -->
      <div class="p-2 border-t border-slate-700 space-y-0.5">
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-slate-400 hover:text-white hover:bg-slate-800 flex items-center gap-2"
          @click="$emit('manage-presets')"
        >
          <i class="fas fa-bolt w-4"></i>{{ t('workbenchManagePresets') }}
        </button>
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-slate-400 hover:text-white hover:bg-slate-800 flex items-center gap-2"
          @click="$emit('show-env')"
        >
          <i class="fas fa-microchip w-4"></i>{{ t('workbenchEnvInfo') }}
        </button>
      </div>
    </template>
  </aside>

  <a-modal
    v-model:open="renameOpen"
    :title="t('workbenchRenamePrompt')"
    :ok-text="t('confirm')"
    :cancel-text="t('cancel')"
    @ok="confirmRename"
  >
    <a-input
      v-model:value="renameTitle"
      :placeholder="t('workbenchSessionTitle')"
      class="wb-tech-input"
      allow-clear
      @press-enter="confirmRename"
    />
  </a-modal>
</template>

<script setup>
import { ref, computed } from 'vue'
import { useI18n } from '@/utils/i18n'

const props = defineProps({
  sessions: { type: Array, default: () => [] },
  currentId: { type: String, default: '' },
  collapsed: { type: Boolean, default: false },
  showArchived: { type: Boolean, default: false },
  archivedCount: { type: Number, default: 0 },
})
const emit = defineEmits([
  'select',
  'new-session',
  'collapse',
  'delete',
  'archive',
  'unarchive',
  'rename',
  'update:showArchived',
  'manage-presets',
  'show-env',
])

const { t } = useI18n()
const query = ref('')

const groups = computed(() => {
  const q = query.value.trim().toLowerCase()
  const list = props.sessions.filter((s) => !q || (s.title || '').toLowerCase().includes(q))
  // 时间分组：今天/昨天/更早
  const now = new Date()
  const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const startYesterday = startToday - 86400000
  const byLabel = new Map()
  for (const s of [...list].sort((a, b) => b.updatedAt - a.updatedAt)) {
    let label
    if (s.updatedAt >= startToday) label = t('workbenchToday')
    else if (s.updatedAt >= startYesterday) label = t('workbenchYesterday')
    else label = t('workbenchEarlier')
    if (!byLabel.has(label)) byLabel.set(label, [])
    byLabel.get(label).push(s)
  }
  return [...byLabel.entries()].map(([label, sessions]) => ({ label, sessions }))
})

function statusDot(s) {
  // dsh workspace 状态点：running 蓝 / 待处理琥珀
  if (s._running) return 'bg-blue-400'
  if (s._pending) return 'bg-amber-400'
  return ''
}

// 重命名：统一 wb-tech-input 样式的 Modal（替代原生 window.prompt）
const renameOpen = ref(false)
const renameTitle = ref('')
let renameTarget = null

function startRename(s) {
  renameTarget = s
  renameTitle.value = s.title || ''
  renameOpen.value = true
}

function confirmRename() {
  const title = renameTitle.value.trim()
  if (title && renameTarget) emit('rename', { id: renameTarget.id, title })
  renameOpen.value = false
}
</script>
