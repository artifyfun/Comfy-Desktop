<template>
  <aside
    class="session-sidebar flex flex-col bg-[var(--wb-bg-base)] border-r border-[var(--wb-stroke)] transition-all duration-300 shrink-0"
    :class="collapsed ? 'w-0 overflow-hidden border-r-0' : float ? 'w-64 h-full' : 'w-60'"
  >
    <!-- 品牌行 + 折叠 -->
    <div class="flex items-center justify-between px-2 h-12 border-b border-[var(--wb-stroke)]">
      <template v-if="!collapsed">
        <span class="text-sm font-semibold text-white">Artify</span>
        <button class="text-[var(--wb-text-2)] hover:text-white px-1" @click="$emit('collapse')">
          <i class="fas fa-angles-left"></i>
        </button>
      </template>
      <button v-else class="w-full text-[var(--wb-text-2)] hover:text-white" @click="$emit('collapse')">
        <i class="fas fa-angles-right"></i>
      </button>
    </div>

    <template v-if="!collapsed">
      <!-- 新建会话 -->
      <div class="p-2">
        <button
          class="w-full px-3 py-2 rounded-md bg-[var(--wb-accent)] hover:bg-[var(--wb-accent-hover)] text-white text-sm font-medium transition flex items-center justify-center gap-2"
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
            class="text-[11px] px-2 py-0.5 rounded-md flex items-center gap-1.5 text-[var(--wb-text-3)] hover:text-[var(--wb-text)] transition"
            :title="t('workbenchArchivedView')"
            @click="$emit('update:showArchived', true)"
          >
            <i class="fas fa-box-archive"></i>{{ t('workbenchArchivedView') }}
            <span
              v-if="archivedCount > 0"
              class="text-[10px] leading-none px-1.5 py-0.5 rounded-full bg-[var(--wb-surface-hover)] text-[var(--wb-text-2)]"
              >{{ archivedCount }}</span
            >
          </button>
        </template>
        <button
          v-else
          class="flex items-center gap-1.5 text-[11px] px-1.5 py-0.5 rounded text-[var(--wb-accent)] hover:bg-[var(--wb-surface-hover)] transition"
          @click="$emit('update:showArchived', false)"
        >
          <i class="fas fa-arrow-left text-[10px]"></i>{{ t('workbenchBackToSessions') }}
        </button>
      </div>

      <!-- 会话列表（时间分组） -->
      <div class="flex-1 overflow-y-auto px-2 pb-2 space-y-3">
        <div v-if="groups.length === 0" class="text-center text-xs text-[var(--wb-text-3)] mt-6">
          {{ showArchived ? t('workbenchNoArchived') : t('workbenchNoSessions') }}
        </div>
        <div v-for="g in groups" :key="g.label">
          <div class="text-[11px] text-[var(--wb-text-3)] px-2 pb-1">{{ g.label }}</div>
          <div
            v-for="s in g.sessions"
            :key="s.id"
            class="group relative rounded-lg px-2 py-1.5 cursor-pointer transition"
            :class="
              s.id === currentId ? 'bg-[var(--wb-surface)] sess-on' : 'hover:bg-[var(--wb-surface)]'
            "
            @click="$emit('select', s)"
          >
            <!-- 状态点 -->
            <span
              v-if="statusDot(s)"
              class="absolute left-1 top-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
              :class="statusDot(s)"
            ></span>
            <div
              class="pl-2 pr-8 text-sm truncate"
              :class="s.id === currentId ? 'text-white' : 'text-[var(--wb-text-2)]'"
            >
              {{ s.title }}
            </div>
            <!-- 行操作:单入口「⋯」dropdown,避免平铺 5 个按钮挤占标题宽度 -->
            <!-- 受控 open:菜单展开时保持按钮可见(鼠标移入菜单会离开 item,hover 失效) -->
            <div
              v-if="!showArchived"
              class="absolute right-1 top-1/2 -translate-y-1/2"
              :class="menuOpenId === s.id ? 'block' : 'hidden group-hover:block'"
            >
              <a-dropdown
                :trigger="['click']"
                placement="bottomRight"
                :open="menuOpenId === s.id"
                @open-change="(o) => (menuOpenId = o ? s.id : '')"
              >
                <button
                  class="w-6 h-6 rounded-md text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
                  :title="t('workbenchSessionActions')"
                  @click.stop
                >
                  <i class="fas fa-ellipsis-h text-xs"></i>
                </button>
                <template #overlay>
                  <a-menu @click="({ key }) => onSessionAction(key, s)">
                    <a-menu-item key="export-json">
                      <span class="flex items-center gap-2"
                        ><i class="fas fa-file-export w-4"></i
                        >{{ t('workbenchExportSession') }}</span
                      >
                    </a-menu-item>
                    <a-menu-item key="export-bundle">
                      <span class="flex items-center gap-2"
                        ><i class="fas fa-file-zipper w-4"></i
                        >{{ t('workbenchExportBundle') }}</span
                      >
                    </a-menu-item>
                    <a-menu-item key="rename" v-if="!s.archived">
                      <span class="flex items-center gap-2"
                        ><i class="fas fa-pen w-4"></i>{{ t('workbenchRename') }}</span
                      >
                    </a-menu-item>
                    <a-menu-item key="archive">
                      <span class="flex items-center gap-2"
                        ><i class="fas fa-box-archive w-4"></i>{{ t('workbenchArchive') }}</span
                      >
                    </a-menu-item>
                    <a-menu-divider />
                    <a-menu-item key="delete" danger>
                      <span class="flex items-center gap-2"
                        ><i class="fas fa-trash w-4"></i>{{ t('delete') }}</span
                      >
                    </a-menu-item>
                  </a-menu>
                </template>
              </a-dropdown>
            </div>
            <!-- 归档恢复 -->
            <button
              v-if="showArchived"
              class="absolute right-1 top-1/2 -translate-y-1/2 w-6 h-6 rounded-md text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
              :title="t('workbenchUnarchive')"
              @click.stop="$emit('unarchive', s)"
            >
              <i class="fas fa-arrow-rotate-left text-xs"></i>
            </button>
          </div>
        </div>
      </div>

      <!-- 底部：设置 + 技能管理 -->
      <div class="px-2 pb-1 pt-1">
        <button
          class="w-full text-left px-2 py-1.5 rounded text-xs text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center gap-2"
          :title="t('workbenchImportSessionTip')"
          @click="$emit('import-session')"
        >
          <i class="fas fa-file-import"></i>{{ t('workbenchImportSession') }}
        </button>
      </div>
      <div class="p-2 border-t border-[var(--wb-stroke)] space-y-0.5">
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center gap-2"
          @click="$emit('show-guide')"
        >
          <i class="fas fa-circle-question w-4"></i>{{ t('workbenchUsageGuide') }}
        </button>
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center gap-2"
          @click="$emit('manage-presets')"
        >
          <i class="fas fa-bolt w-4"></i>{{ t('workbenchManagePresets') }}
        </button>
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center gap-2"
          @click="$emit('manage-skills')"
        >
          <i class="fas fa-book-open w-4"></i>{{ t('workbenchSkillLib') }}
        </button>
        <button
          class="w-full text-left px-2 py-1.5 rounded text-sm text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center gap-2"
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
  // 浮层形态（embed 画布侧栏）：展开时 h-full 撑满浮层容器，宽度取容器 w-64
  float: { type: Boolean, default: false },
})
const emit = defineEmits([
  'select',
  'new-session',
  'collapse',
  'delete',
  'archive',
  'unarchive',
  'rename',
  'export-session',
  'import-session',
  'update:showArchived',
  'manage-presets',
  'manage-skills',
  'show-env',
  'show-guide',
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

// 会话行「⋯」菜单：受控 open，展开时钉住触发按钮（否则鼠标移入菜单即 hover 失效按钮消失）
const menuOpenId = ref('')

function onSessionAction(key, s) {
  menuOpenId.value = ''
  if (key === 'export-json') emit('export-session', s, 'json')
  else if (key === 'export-bundle') emit('export-session', s, 'bundle')
  else if (key === 'rename') startRename(s)
  else if (key === 'archive') emit('archive', s)
  else if (key === 'delete') emit('delete', s)
}

function statusDot(s) {
  // dsh workspace 状态点：running 蓝 / 待处理琥珀
  if (s._running) return 'bg-[var(--wb-accent)]'
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

<style scoped>
/* Comfy 选中语义:左侧 3px azure 条（对齐 .side-bar-button-selected） */
.sess-on {
  position: relative;
}
.sess-on::before {
  content: '';
  position: absolute;
  left: 0;
  top: 8px;
  bottom: 8px;
  width: 3px;
  background: var(--wb-accent);
  border-radius: 2px;
}
</style>
