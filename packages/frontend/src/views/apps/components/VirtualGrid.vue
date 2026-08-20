<template>
  <div class="virtual-grid-container">
    <!-- 虚拟滚动容器 -->
    <div v-show="filteredApps.length" ref="scrollContainer" class="virtual-scroll-container">
      <!-- 总高度占位 -->
      <div :style="{ height: totalHeight + 'px' }" class="virtual-scroll-spacer"></div>

      <!-- 可见行容器（基于 @tanstack/vue-virtual 行级虚拟化） -->
      <div
        :style="{ transform: `translateY(${virtualRows[0]?.start ?? 0}px)` }"
        class="virtual-items-container"
      >
        <div
          v-for="row in virtualRows"
          :key="row.key"
          class="grid grid-cols-1 gap-6 mb-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4"
        >
          <AppCard
            v-for="app in rows[row.index]"
            :key="app.id"
            :app="app"
            @view-detail="$emit('view-detail', $event)"
          />
        </div>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="filteredApps.length === 0" class="py-20 text-center">
      <div class="inline-block p-6 mb-6 rounded-full bg-tech-darker">
        <i class="text-5xl fas fa-robot text-tech-blue"></i>
      </div>
      <h3 class="mb-2 text-2xl font-bold text-white">
        {{ searchQuery.trim() || selectedCategory ? t('noAppsFound') : t('noAppsAvailable') }}
      </h3>
      <p class="mx-auto mb-6 max-w-md text-slate-400">
        {{
          searchQuery.trim()
            ? t('noAppsFoundWithQuery', { query: searchQuery })
            : selectedCategory
              ? t('noAppsInCategory', { category: selectedCategory })
              : t('addFirstAppTip')
        }}
      </p>
      <div class="flex justify-center space-x-2">
        <button
          v-if="searchQuery.trim()"
          @click="$emit('clear-search')"
          class="px-6 py-2 font-medium text-white bg-gradient-to-r rounded-lg transition cursor-pointer from-tech-blue to-tech-cyan hover:opacity-90"
        >
          {{ t('clearSearch') }}
        </button>
        <button
          v-if="selectedCategory"
          @click="$emit('clear-filter')"
          class="px-6 py-2 font-medium text-white bg-gradient-to-r rounded-lg transition cursor-pointer from-tech-blue to-tech-cyan hover:opacity-90"
        >
          {{ t('clearFilter') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, nextTick, watch, onUnmounted } from 'vue'
import { useVirtualizer } from '@tanstack/vue-virtual'
import { t } from '@/utils/i18n'
import AppCard from './AppCard.vue'

const props = defineProps({
  apps: {
    type: Array,
    default: () => [],
  },
  searchQuery: {
    type: String,
    default: '',
  },
  selectedCategory: {
    type: String,
    default: '',
  },
})

defineEmits(['view-detail', 'clear-search', 'clear-filter'])

const scrollContainer = ref(null)
const containerHeight = ref(0)
const rowHeight = ref(340) // 默认行高（卡片高度 + gap），挂载后动态测量
const itemsPerRow = ref(3)

// 过滤后的应用列表
const filteredApps = computed(() => {
  if (!props.searchQuery.trim() && !props.selectedCategory) {
    return props.apps
  }
  const query = props.searchQuery.toLowerCase().trim()
  const categoryFilter = props.selectedCategory
  return props.apps.filter((app) => {
    const nameMatch = app.name.toLowerCase().includes(query)
    const categoryMatch = app.category.toLowerCase().includes(query)
    const descriptionMatch = app.description.toLowerCase().includes(query)
    const matchesQuery = !query || nameMatch || categoryMatch || descriptionMatch
    const matchesCategory = categoryFilter ? app.category === categoryFilter : true
    return matchesQuery && matchesCategory
  })
})

// 按行切分（每行 itemsPerRow 个）
const rows = computed(() => {
  const out = []
  for (let i = 0; i < filteredApps.value.length; i += itemsPerRow.value) {
    out.push(filteredApps.value.slice(i, i + itemsPerRow.value))
  }
  return out
})

// @tanstack/vue-virtual：行级虚拟化
// 注意：options 必须整体包成 computed（MaybeRef 用法），count 传普通数字。
// 若 count 直接传 computed 引用，rows 变化时 virtualizer 的 options 不会更新，
// virtual-core 拿到的 count 是 ref 对象本身，测量循环永不执行，导致卡片不渲染。
const virtualizer = useVirtualizer(
  computed(() => ({
    count: rows.value.length,
    getScrollElement: () => scrollContainer.value,
    estimateSize: () => rowHeight.value,
    overscan: 2,
    getItemKey: (index) => rows.value[index]?.[0]?.id ?? index,
  })),
)

const virtualRows = computed(() => virtualizer.value.getVirtualItems())
const totalHeight = computed(() => virtualizer.value.getTotalSize())

// 容器高度（供虚拟化计算视口）
const updateContainerHeight = () => {
  if (scrollContainer.value) {
    containerHeight.value = scrollContainer.value.clientHeight
  }
}

// 动态测量行高：取首行第一个卡片高度 + gap(24px)
const measureRowHeight = () => {
  nextTick(() => {
    const card = document.querySelector('.virtual-items-container .grid > *')
    if (card) {
      rowHeight.value = card.offsetHeight + 24
      virtualizer.value.measure()
    }
  })
}

// 响应式列数（与 tailwind 断点一致）
const updateItemsPerRow = () => {
  if (window.innerWidth >= 1280) {
    itemsPerRow.value = 4
  } else if (window.innerWidth >= 1024) {
    itemsPerRow.value = 3
  } else if (window.innerWidth >= 640) {
    itemsPerRow.value = 2
  } else {
    itemsPerRow.value = 1
  }
}

// 过滤结果变化：重置滚动到顶部
watch(filteredApps, () => {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
  }
})

// 行高 / 列数变化时重测
watch([rowHeight, itemsPerRow], () => {
  nextTick(() => virtualizer.value.measure())
})

// 容器挂载后初始化
let ro = null
const init = () => {
  updateContainerHeight()
  updateItemsPerRow()
  measureRowHeight()
  // 监听容器尺寸变化
  if (scrollContainer.value && window.ResizeObserver) {
    ro = new ResizeObserver(() => {
      updateContainerHeight()
      updateItemsPerRow()
      measureRowHeight()
    })
    ro.observe(scrollContainer.value)
  }
}

watch(scrollContainer, (el) => {
  if (el) {
    nextTick(init)
  }
})

onUnmounted(() => {
  if (ro) {
    ro.disconnect()
    ro = null
  }
})
</script>

<style scoped>
.virtual-grid-container {
  height: 100%;
  width: 100%;
}

.virtual-scroll-container {
  height: 100%;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
}

.virtual-scroll-spacer {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  pointer-events: none;
}

.virtual-items-container {
  position: absolute;
  top: 10px;
  left: 0;
  right: 0;
}

/* 自定义滚动条 */
.virtual-scroll-container::-webkit-scrollbar {
  width: 6px;
}

.virtual-scroll-container::-webkit-scrollbar-track {
  background: rgba(30, 41, 59, 0.3);
  border-radius: 3px;
}

.virtual-scroll-container::-webkit-scrollbar-thumb {
  background: rgba(14, 165, 233, 0.5);
  border-radius: 3px;
}

.virtual-scroll-container::-webkit-scrollbar-thumb:hover {
  background: rgba(14, 165, 233, 0.7);
}
</style>
