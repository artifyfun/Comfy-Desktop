<template>
  <div ref="scrollContainer" class="gallery-masonry-scroll" @scroll.passive="onScroll">
    <div :style="{ height: totalHeight + 'px', position: 'relative' }">
      <div
        v-for="layout in visibleLayouts"
        :key="layout.item.id"
        class="group absolute overflow-hidden rounded-lg cursor-pointer bg-slate-800/60"
        :class="{
          'ring-2 ring-tech-blue': selectMode && selectedIds.includes(layout.item.id),
        }"
        :style="{
          left: layout.left + 'px',
          top: layout.top + 'px',
          width: layout.width + 'px',
          height: layout.height + 'px',
        }"
        @click="onCardClick(layout.item)"
      >
        <div class="absolute inset-0 bg-slate-800/60 animate-pulse"></div>
        <div
          v-if="selectMode"
          class="absolute top-2 left-2 z-10 flex items-center justify-center w-5 h-5 rounded border border-white/60 bg-black/40"
          :class="{ 'bg-tech-blue border-tech-blue': selectedIds.includes(layout.item.id) }"
          @click.stop="onCardClick(layout.item)"
        >
          <i
            v-if="selectedIds.includes(layout.item.id)"
            class="fas fa-check text-white text-xs"
          ></i>
        </div>
        <img
          :src="thumbUrl(layout.item)"
          :alt="layout.item.filename"
          loading="lazy"
          decoding="async"
          class="relative w-full h-full object-cover transition duration-300 group-hover:scale-105"
          :class="{ 'opacity-0': !loadedItems.has(layout.item.id) }"
          @load="onImgLoad(layout.item, $event)"
          @error="$emit('img-error', $event, layout.item)"
        />
        <div
          class="absolute inset-x-0 bottom-0 p-2 text-xs text-white bg-gradient-to-t from-black/80 to-transparent opacity-0 transition-opacity group-hover:opacity-100"
        >
          <div class="truncate">{{ layout.item.filename }}</div>
          <div class="flex justify-between text-slate-300">
            <span class="truncate">{{ layout.item.app_name || formatTime(layout.item.created_at) }}</span>
            <span class="flex items-center gap-1">
              <i
                class="cursor-pointer"
                :class="layout.item.starred ? 'fas fa-star text-yellow-400' : 'far fa-star'"
                @click.stop="$emit('star', layout.item)"
              ></i>
              <i
                class="ml-1 cursor-pointer far fa-trash-alt hover:text-red-400"
                @click.stop="$emit('remove', layout.item)"
              ></i>
            </span>
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
import { computed, ref, reactive, watch, nextTick, onUnmounted } from 'vue'
import dayjs from 'dayjs'

const props = defineProps({
  items: { type: Array, default: () => [] },
  serverHost: { type: String, default: '' },
  comfyHost: { type: String, default: '' },
  loading: { type: Boolean, default: false },
  hasMore: { type: Boolean, default: false },
  selectMode: { type: Boolean, default: false },
  selectedIds: { type: Array, default: () => [] },
})

const emit = defineEmits(['open', 'star', 'remove', 'img-error', 'load-more', 'toggle-select'])

const scrollContainer = ref(null)
const minColumnWidth = 220
const gap = 12
const cols = ref(3)
const containerWidth = ref(0)
const scrollTop = ref(0)
const viewportHeight = ref(800)

// 图片自然尺寸缓存：id -> { w, h }
const sizeMap = reactive(new Map())
// 已加载完成的图片 id（用于骨架占位淡入）
const loadedItems = reactive(new Set())
// 布局结果：{ item, left, top, width, height }[]
const layouts = ref([])
let layoutDirty = false

const thumbFileName = (subfolder, filename) =>
  `${subfolder ? String(subfolder).replace(/[\\/]/g, '_') + '_' : ''}${filename}.jpg`

const thumbUrl = (item) =>
  `${props.serverHost}/api/gallery/thumbs/${encodeURIComponent(thumbFileName(item.subfolder, item.filename))}`

const formatTime = (ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss')

const colWidth = computed(() => {
  const n = Math.max(1, cols.value)
  return Math.max(1, (containerWidth.value - gap * (n - 1)) / n)
})

// 单张图片的显示高度：有自然尺寸按比例，否则用估算值
const itemHeight = (item) => {
  const size = sizeMap.get(item.id)
  if (size && size.w > 0 && size.h > 0) {
    return Math.max(1, (colWidth.value * size.h) / size.w)
  }
  return Math.max(1, colWidth.value * 0.75)
}

// 经典瀑布流布局：每次选当前最矮的列放下一个 item
const layoutAll = () => {
  const n = Math.max(1, cols.value)
  const colHeights = new Array(n).fill(0)
  const next = []
  for (const item of props.items) {
    let col = 0
    for (let i = 1; i < n; i++) {
      if (colHeights[i] < colHeights[col]) col = i
    }
    const h = itemHeight(item)
    next.push({
      item,
      left: col * (colWidth.value + gap),
      top: colHeights[col],
      width: colWidth.value,
      height: h,
    })
    colHeights[col] += h + gap
  }
  layouts.value = next
  layoutDirty = false
}

const totalHeight = computed(() => {
  const n = Math.max(1, cols.value)
  const colHeights = new Array(n).fill(0)
  for (const l of layouts.value) {
    const end = l.top + l.height
    const col = Math.round(l.left / (colWidth.value + gap))
    if (col >= 0 && col < n && end > colHeights[col]) colHeights[col] = end
  }
  return Math.max(0, ...colHeights)
})

// 可见项：只渲染视口内的卡片
const visibleLayouts = computed(() => {
  const top = scrollTop.value - 200
  const bottom = scrollTop.value + viewportHeight.value + 200
  return layouts.value.filter((l) => l.top + l.height >= top && l.top <= bottom)
})

// 卡片点击：多选模式切换选中，普通模式打开详情
const onCardClick = (item) => {
  if (props.selectMode) {
    emit('toggle-select', item)
  } else {
    emit('open', item)
  }
}

// 图片加载完成：缓存自然尺寸并触发重排
const onImgLoad = (item, e) => {
  const target = e.target
  loadedItems.add(item.id)
  const w = target.naturalWidth
  const h = target.naturalHeight
  if (!w || !h) return
  const prev = sizeMap.get(item.id)
  if (!prev || prev.w !== w || prev.h !== h) {
    sizeMap.set(item.id, { w, h })
    scheduleLayout()
  }
}

let scheduleTimer = null
const scheduleLayout = () => {
  if (scheduleTimer) return
  scheduleTimer = setTimeout(() => {
    scheduleTimer = null
    layoutAll()
    nextTick(() => virtualMeasure())
  }, 16)
}

const updateCols = () => {
  if (!scrollContainer.value) return
  const w = scrollContainer.value.clientWidth
  containerWidth.value = w
  const nextCols = Math.max(1, Math.floor((w + gap) / (minColumnWidth + gap)))
  if (nextCols !== cols.value) {
    cols.value = nextCols
    layoutAll()
  }
}

const onScroll = () => {
  const el = scrollContainer.value
  if (!el) return
  scrollTop.value = el.scrollTop
  viewportHeight.value = el.clientHeight
  if (!props.loading && props.hasMore && el.scrollTop + el.clientHeight >= el.scrollHeight - 300) {
    emit('load-more')
  }
}

// 简单触发一次 measure（占位，保留接口）
const virtualMeasure = () => {}

let ro = null
const init = () => {
  updateCols()
  if (scrollContainer.value) {
    scrollTop.value = scrollContainer.value.scrollTop
    viewportHeight.value = scrollContainer.value.clientHeight
  }
  layoutAll()
  if (scrollContainer.value && window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      updateCols()
    })
    ro.observe(scrollContainer.value)
  }
}

watch(scrollContainer, (el) => {
  if (el) nextTick(init)
})

watch(
  () => props.items,
  () => {
    scheduleLayout()
  },
  { deep: false }
)

watch(colWidth, () => layoutAll())

onUnmounted(() => {
  if (scheduleTimer) clearTimeout(scheduleTimer)
  if (ro) {
    ro.disconnect()
    ro = null
  }
})
</script>

<style scoped>
.gallery-masonry-scroll {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}
</style>
