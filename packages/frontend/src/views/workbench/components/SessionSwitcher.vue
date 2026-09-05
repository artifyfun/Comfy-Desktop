<template>
  <!-- C13 前置:多会话切换 UI(纯组件,index.vue 集成由 captain 后置)。
       横向 tab 条:未归档在前按 updatedAt 降序,归档灰显沉底(可经同一 archive 通道恢复);
       per-session generating spinner 小标(数据源 aguiSession per-thread generating 映射)。 -->
  <div
    data-testid="session-switcher"
    class="session-switcher flex items-center gap-1 overflow-x-auto rounded-lg bg-[var(--wb-surface)] border border-[var(--wb-stroke)] px-1 py-1"
  >
    <!-- 「+ 新会话」入口:空列表时也保留,是唯一可见元素 -->
    <button
      data-testid="session-new"
      class="flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-xs font-medium text-[var(--wb-accent)] transition hover:bg-[var(--wb-surface-hover)]"
      :title="t('workbenchNewSession')"
      @click="emit('new')"
    >
      <i class="fas fa-plus text-[10px]"></i>
      <span class="truncate">{{ t('workbenchNewSession') }}</span>
    </button>

    <template v-if="sortedSessions.length > 0">
      <span class="h-4 w-px shrink-0 bg-[var(--wb-stroke)]" aria-hidden="true"></span>

      <div
        v-for="s in sortedSessions"
        :key="s.threadId"
        role="tab"
        :aria-selected="s.threadId === activeThreadId"
        :data-testid="`session-item-${s.threadId}`"
        :data-thread-id="s.threadId"
        class="group relative flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-2 py-1 text-xs transition"
        :class="[
          s.threadId === activeThreadId
            ? 'is-active bg-[var(--wb-accent)]/15 text-white'
            : 'text-[var(--wb-text-2)] hover:bg-[var(--wb-surface-hover)]',
          s.archived ? 'sess-archived opacity-50 text-[var(--wb-text-2)]' : '',
        ]"
        :title="s.title"
        @click="emit('switch', s.threadId)"
      >
        <!-- generating spinner 小标(色盲友好:形状区分,对齐 ToolCallCard) -->
        <span
          v-if="isGenerating(s.threadId)"
          :data-testid="`session-generating-${s.threadId}`"
          class="inline-block h-2.5 w-2.5 shrink-0 animate-spin rounded-full border border-[var(--wb-stroke-strong)] border-t-[var(--wb-accent)]"
          aria-hidden="true"
        ></span>

        <!-- 标题截断 -->
        <span class="sess-title max-w-40 truncate">{{ s.title || s.threadId }}</span>

        <!-- 归档角标 -->
        <span
          v-if="s.archived"
          class="shrink-0 rounded-full bg-[var(--wb-surface-hover)] px-1 text-[10px] leading-4 text-[var(--wb-text-2)]"
          >{{ t('workbenchArchived') }}</span
        >

        <!-- hover 行操作:归档/恢复(同通道 emit,父级切换 archived 语义);stop 防误触 switch -->
        <button
          :data-testid="`session-archive-${s.threadId}`"
          class="hidden h-4 w-4 shrink-0 items-center justify-center rounded-md text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] group-hover:flex"
          :title="s.archived ? t('workbenchUnarchive') : t('workbenchArchive')"
          @click.stop="emit('archive', s.threadId)"
        >
          <i
            class="text-[10px]"
            :class="s.archived ? 'fas fa-arrow-rotate-left' : 'fas fa-box-archive'"
          ></i>
        </button>
      </div>
    </template>
  </div>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/utils/i18n'

const props = defineProps({
  // 会话列表:{ threadId, title, updatedAt, archived? }(threads/page API 契约)
  sessions: { type: Array, default: () => [] },
  activeThreadId: { type: String, default: '' },
  // threadId → bool 映射(aguiSession per-thread generating)
  generating: { type: Object, default: () => ({}) },
})

const emit = defineEmits(['switch', 'new', 'archive'])

const { t } = useI18n()

// updatedAt 兼容时间戳(number)与 ISO 字符串,脏值按 0 沉底
function toTs(s) {
  const v = s?.updatedAt
  if (v == null) return 0
  const n = typeof v === 'number' ? v : new Date(v).getTime()
  return Number.isFinite(n) ? n : 0
}

// 未归档在前按 updatedAt 降序;归档沉底(同段内也按 updatedAt 降序)
const sortedSessions = computed(() => {
  const active = []
  const archived = []
  for (const s of props.sessions || []) (s?.archived ? archived : active).push(s)
  const byNew = (a, b) => toTs(b) - toTs(a)
  active.sort(byNew)
  archived.sort(byNew)
  return [...active, ...archived]
})

function isGenerating(threadId) {
  return !!props.generating?.[threadId]
}
</script>
