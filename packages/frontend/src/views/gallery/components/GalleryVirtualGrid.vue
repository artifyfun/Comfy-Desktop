<template>
  <div ref="scrollContainer" class="gallery-virtual-scroll" @scroll.passive="onScroll">
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div
        :style="{ transform: `translateY(${virtualRows[0]?.start ?? 0}px)` }"
        class="gallery-virtual-items"
      >
        <div
          v-for="row in virtualRows"
          :key="row.key"
          class="gallery-row"
          :style="{
            gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))`,
            height: rowHeight + 'px',
          }"
        >
          <div
            v-for="item in rows[row.index]"
            :key="item.id"
            class="group relative overflow-hidden rounded-lg cursor-pointer bg-slate-800/60"
            @click="$emit('open', item)"
          >
            <img
              :src="thumbUrl(item)"
              :alt="item.filename"
              loading="lazy"
              decoding="async"
              class="w-full h-full object-cover transition-transform duration-300 group-hover:scale-105"
              @error="$emit('img-error', $event, item)"
            />
            <div
              class="absolute inset-x-0 bottom-0 p-2 text-xs text-white bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
            >
              <div class="truncate">{{ item.filename }}</div>
              <div class="flex justify-between text-slate-300">
                <span class="truncate">{{ item.app_name || formatTime(item.created_at) }}</span>
                <span class="flex items-center gap-1">
                  <i
                    class="cursor-pointer"
                    :class="item.starred ? 'fas fa-star text-yellow-400' : 'far fa-star'"
                    @click.stop="$emit('star', item)"
                  ></i>
                  <i
                    class="ml-1 cursor-pointer far fa-trash-alt hover:text-red-400"
                    @click.stop="$emit('remove', item)"
                  ></i>
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div v-if="loading" class="py-10 text-center text-slate-400">
      <a-spin size="large" />
    </div>
  </div>
</template>

<script setup>
import { computed, ref, watch, nextTick, onUnmounted } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import dayjs from 'dayjs'

const props = defineProps({
  items: { type: Array, default: () => [] },
  serverHost: { type: String, default: '' },
  comfyHost: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  hasMore: { type: Boolean, default: false },
})

const emit = defineEmits(['open', 'star', 'remove', 'img-error', 'load-more'])

const scrollContainer = ref(null)
const rowHeight = 220
const minColumnWidth = 220
const gap = 12
const cols = ref(3)
const containerWidth = ref(0)

// 缩略图文件名规则与主进程 scanner.makeThumb 一致
const thumbFileName = (subfolder, filename) =>
  `${subfolder ? String(subfolder).replace(/[\\/]/g, '_') + '_' : ''}${filename}.jpg`

const thumbUrl = (item) =>
  `${props.serverHost}/api/gallery/thumbs/${encodeURIComponent(thumbFileName(item.subfolder, item.filename))}`

const fullUrl = (item) =>
  `${props.comfyHost}/view?filename=${encodeURIComponent(item.filename)}&subfolder=${encodeURIComponent(item.subfolder)}&type=${item.type}`

const formatTime = (ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss')

// 按行切分
const rows = computed(() => {
  const out = []
  const n = Math.max(1, cols.value)
  for (let i = 0; i < props.items.length; i += n) {
    out.push(props.items.slice(i, i + n))
  }
  return out
})

// options 整体包成 computed（MaybeRef 用法），count 传普通数字；
// 直接传 computed 引用时 count 变化不会驱动 virtualizer 更新，导致不渲染
const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollContainer.value,
    estimateSize: () => rowHeight,
    overscan: 2,
    getItemKey: (index) => rows.value[index]?.[0]?.id ?? index,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// 响应式列数：按容器宽度计算
const updateCols = () => {
  if (!scrollContainer.value) return
  const w = scrollContainer.value.clientWidth
  containerWidth.value = w
  cols.value = Math.max(1, Math.floor((w + gap) / (minColumnWidth + gap)))
}

// 滚动到底自动加载更多
const onScroll = () => {
  const el = scrollContainer.value
  if (!el || props.loading || !props.hasMore) return
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
    emit('load-more')
  }
}

let ro = null
const init = () => {
  updateCols()
  if (scrollContainer.value && window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      updateCols()
      nextTick(() => virtualizer.value.measure())
    })
    ro.observe(scrollContainer.value)
  }
}

watch(scrollContainer, (el) => {
  if (el) {
    nextTick(init)
  }
})

watch(
  () => props.items.length,
  () => nextTick(() => virtualizer.value.measure()),
)

onUnmounted(() => {
  if (ro) {
    ro.disconnect()
    ro = null
  }
})
</script>

<style scoped>
.gallery-virtual-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}

.gallery-virtual-items {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.gallery-row {
  display: grid;
  gap: 12px;
  padding-bottom: 12px;
}

.gallery-row > * {
  min-height: 0;
}
</style>
