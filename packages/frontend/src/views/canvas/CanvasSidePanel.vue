<template>
  <aside
    class="flex h-full flex-col overflow-hidden border-r border-[var(--wb-stroke)] bg-[var(--wb-surface)]"
    :data-v-panel="''"
  >
    <!-- 标题 + 关闭 -->
    <div class="flex items-center gap-2 px-3 pt-3 pb-2">
      <i class="fas fa-layer-group text-xs text-[var(--wb-accent)]"></i>
      <span class="text-sm font-semibold text-[var(--wb-text-1)]">{{
        t('canvasLayersTitle')
      }}</span>
      <span
        v-if="objects.length"
        class="text-[10px] px-1.5 py-0.5 rounded-full bg-[var(--wb-accent)]/15 text-[var(--wb-accent)]"
        >{{ objects.length }}</span
      >
      <div class="flex-1"></div>
      <button
        class="h-6 w-6 rounded-md text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] hover:bg-black/20 transition"
        :title="t('canvasLayersClose')"
        @click="emit('close')"
      >
        <i class="fas fa-times text-xs"></i>
      </button>
    </div>
    <!-- 搜索 + 类型过滤 -->
    <div class="px-3 pb-2">
      <div class="relative">
        <i
          class="fas fa-magnifying-glass absolute left-2 top-1/2 -translate-y-1/2 text-[10px] text-[var(--wb-text-2)]"
        ></i>
        <input
          v-model="q"
          class="h-7 w-full rounded-lg border border-[var(--wb-stroke)] bg-black/20 pl-6 pr-2 text-xs text-[var(--wb-text-1)] outline-none focus:border-[var(--wb-accent)]/60"
          :placeholder="t('canvasLayersSearch')"
        />
      </div>
      <div class="mt-1.5 flex flex-wrap gap-1">
        <button
          v-for="f in filters"
          :key="f.key"
          class="h-5 rounded-full px-2 text-[10px] transition border"
          :class="
            active === f.key
              ? 'border-[var(--wb-accent)]/60 bg-[var(--wb-accent)]/15 text-[var(--wb-accent)]'
              : 'border-[var(--wb-stroke)] text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)]'
          "
          @click="active = active === f.key ? 'all' : f.key"
        >
          {{ f.label }}
        </button>
      </div>
    </div>
    <!-- 列表 -->
    <div class="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
      <div v-if="!rows.length" class="pt-10 text-center text-xs text-[var(--wb-text-2)]">
        {{ q || active !== 'all' ? t('canvasLayersNoMatch') : t('canvasLayersEmpty') }}
      </div>
      <button
        v-for="row in rows"
        :key="row.id"
        class="group flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition"
        :class="row.selected ? 'bg-[var(--wb-accent)]/12' : 'hover:bg-black/15'"
        @click="emit('focus', row.id)"
        @mouseenter="emit('hover', row.id)"
        @mouseleave="emit('hover', null)"
      >
        <!-- 组缩叠箭头 -->
        <i
          v-if="row.isGroup"
          class="fas fa-chevron-right text-[8px] text-[var(--wb-text-2)] transition-transform"
          :class="collapsed.has(row.id) ? '' : 'rotate-90'"
          @click.stop="toggleCollapse(row.id)"
        ></i>
        <span v-else class="w-2"></span>
        <!-- 类型图标 + 状态点 -->
        <i
          :class="row.icon"
          class="w-3.5 text-center text-[11px]"
          :style="{ color: row.color }"
        ></i>
        <span
          v-if="row.statusDot"
          class="h-1.5 w-1.5 shrink-0 rounded-full"
          :class="row.statusDot === 'running' ? 'animate-pulse bg-cyan-300' : ''"
          :style="
            row.statusDot === 'error'
              ? 'background:#f87171'
              : row.statusDot === 'done'
                ? 'background:#4ade80'
                : ''
          "
        ></span>
        <!-- 名称 -->
        <span
          class="min-w-0 flex-1 truncate text-xs"
          :class="row.selected ? 'text-[var(--wb-accent)]' : 'text-[var(--wb-text-1)]'"
          :title="row.label"
          >{{ row.label }}</span
        >
        <!-- 可见性（预留给眼睛开关，P2 接 visibility） -->
        <span class="text-[9px] text-[var(--wb-text-2)] opacity-0 group-hover:opacity-70">
          <i class="fas fa-crosshairs"></i>
        </span>
      </button>
    </div>
  </aside>
</template>

<script setup>
import { computed, ref } from 'vue'
import { useI18n } from '@/utils/i18n'

const props = defineProps({
  objects: { type: Array, required: true },
  selection: { type: Array, required: true },
  groups: { type: Array, required: true },
  hoverNodeId: { type: String, default: null },
})
const emit = defineEmits(['focus', 'hover', 'close'])

const { t } = useI18n()
const q = ref('')
const active = ref('all')
const collapsed = ref(new Set())

const filters = computed(() => [
  { key: 'all', label: t('canvasKindAll') },
  { key: 'image', label: t('canvasKindImage') },
  { key: 'note', label: t('canvasKindNote') },
  { key: 'app', label: t('canvasKindApp') },
  { key: 'frame', label: t('canvasKindFrame') },
  { key: 'video', label: t('canvasKindVideo') },
])

const TYPE_META = {
  image: { icon: 'fas fa-image', color: '#38bdf8' },
  video: { icon: 'fas fa-film', color: '#a78bfa' },
  note: { icon: 'fas fa-note-sticky', color: '#fbbf24' },
  app: { icon: 'fas fa-cube', color: '#818cf8' },
  frame: { icon: 'fas fa-vector-square', color: '#a8a29e' },
  shot: { icon: 'fas fa-clapperboard', color: '#f472b6' },
  audio: { icon: 'fas fa-music', color: '#34d399' },
}

/** 行标签：note 取文本截断；image/video 取 name；app 取 name/appId；其余类型名 */
function labelOf(o) {
  if (o.type === 'note')
    return (o.text || '').replace(/\s+/g, ' ').slice(0, 24) || t('canvasKindNote')
  if (o.type === 'image' || o.type === 'video') {
    if (o.name) return o.name
    try {
      if (o.src && o.src.startsWith('http')) {
        const u = new URL(o.src)
        return (
          u.searchParams.get('filename') ||
          decodeURIComponent(u.pathname.split('/').pop() || '') ||
          t(o.type === 'image' ? 'canvasKindImage' : 'canvasKindVideo')
        )
      }
    } catch {
      /* blob:/data: */
    }
    return (
      t(o.type === 'image' ? 'canvasKindImage' : 'canvasKindVideo') + ' #' + String(o.id).slice(-4)
    )
  }
  if (o.type === 'app') return o.name || o.appId || t('canvasKindApp')
  if (o.type === 'frame') return o.name || t('canvasKindFrame')
  if (o.type === 'shot') return o.name || t('canvasKindShot')
  return o.type
}

/** 状态点：app 的 running/done/error；其余类型无 */
function statusDotOf(o) {
  if (o.type !== 'app') return ''
  if (o.status === 'running') return 'running'
  if (o.status === 'error') return 'error'
  if (o.status === 'done') return 'done'
  return ''
}

/** 扁平行：组在其成员之上渲染，成员缩进；命中过滤的成员其组保留 */
const rows = computed(() => {
  const query = q.value.trim().toLowerCase()
  const match = (o) => {
    if (active.value !== 'all' && o.type !== active.value) return false
    if (!query) return true
    return labelOf(o).toLowerCase().includes(query)
  }
  const groupIdOf = new Map()
  for (const g of props.groups) for (const m of g.members) groupIdOf.set(m, g.id)
  const groupById = new Map(props.groups.map((g) => [g.id, g]))
  const out = []
  const memberIds = new Set(groupIdOf.keys())
  // 组行（组自身或任一成员命中即保留；成员被过滤时组行照常显示）
  for (const g of props.groups) {
    const gm = groupById.get(g.id)
    if (!gm) continue
    const selfHit = match({ ...gm, type: 'frame' })
    const kids = g.members.map((id) => props.objects.find((o) => o.id === id)).filter(Boolean)
    const anyKidHit = kids.some(match)
    if (!selfHit && !anyKidHit) continue
    out.push({
      id: g.id,
      label: (gm.name || t('canvasKindGroup')) + ' · ' + kids.length,
      icon: TYPE_META.frame.icon,
      color: TYPE_META.frame.color,
      isGroup: true,
      selected: props.selection.includes(g.id),
      statusDot: '',
    })
    if (collapsed.value.has(g.id)) continue
    for (const k of kids) {
      if (!match(k)) continue
      out.push({
        id: k.id,
        label: labelOf(k),
        icon: (TYPE_META[k.type] || {}).icon || 'fas fa-square',
        color: (TYPE_META[k.type] || {}).color || '#a8a29e',
        isGroup: false,
        indent: true,
        selected: props.selection.includes(k.id),
        statusDot: statusDotOf(k),
      })
    }
  }
  // 无组物件
  for (const o of props.objects) {
    if (memberIds.has(o.id)) continue
    if (o.type === 'frame') continue // frame 即组容器
    if (!match(o)) continue
    out.push({
      id: o.id,
      label: labelOf(o),
      icon: (TYPE_META[o.type] || {}).icon || 'fas fa-square',
      color: (TYPE_META[o.type] || {}).color || '#a8a29e',
      isGroup: false,
      indent: false,
      selected: props.selection.includes(o.id),
      statusDot: statusDotOf(o),
    })
  }
  return out
})

function toggleCollapse(id) {
  const next = new Set(collapsed.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  collapsed.value = next
}
</script>
