<template>
  <div class="compact-list-container">
    <!-- 虚拟滚动容器 -->
    <div
      v-show="filteredApps.length"
      ref="scrollContainer"
      class="virtual-scroll-container"
      @scroll="handleScroll"
    >
      <!-- 总高度占位 -->
      <div :style="{ height: totalHeight + 'px' }" class="virtual-scroll-spacer"></div>

      <!-- 可见项目容器 -->
      <div :style="{ transform: `translateY(${offsetY}px)` }" class="virtual-items-container">
        <transition-group name="card" tag="div" class="space-y-2">
          <div
            v-for="app in visibleApps"
            :key="app.id"
            class="compact-app-item"
            @click="$emit('view-detail', app)"
          >
            <!-- 应用图标 -->
            <div class="overflow-hidden flex-shrink-0 mr-4 w-12 h-12 rounded-md bg-tech-darker">
              <img
                v-if="app.imageUrl"
                :src="app.imageUrl"
                :alt="app.name"
                class="object-cover w-full h-full"
              />
              <div v-else class="flex justify-center items-center w-full h-full text-[var(--wb-text-2)]">
                <i class="text-xl fas fa-robot"></i>
              </div>
            </div>

            <!-- 应用信息 -->
            <div class="flex-1 min-w-0">
              <div class="flex justify-between items-center mb-1">
                <h3 class="text-sm font-semibold text-white truncate">
                  {{ app.name }}
                </h3>
                <div class="flex items-center space-x-2">
                  <!-- 分类标签 -->
                  <span
                    class="px-2 py-1 text-xs font-medium rounded-full text-tech-blue bg-tech-blue/10"
                  >
                    {{ t(app.category) }}
                  </span>
                  <!-- 状态指示器 -->
                  <div class="w-2 h-2 bg-[var(--wb-success)] rounded-full"></div>
                </div>
              </div>

              <p class="text-xs text-[var(--wb-text-2)] line-clamp-2">
                {{ app.description }}
              </p>

              <!-- 元数据 -->
              <div class="flex items-center mt-2 space-x-4 text-xs text-[var(--wb-text-2)]">
                <span class="flex items-center">
                  <i class="mr-1 fas fa-clock"></i>
                  {{ formatDate(app.createdAt) }}
                </span>
                <!-- <span class="flex items-center">
                  <i class="mr-1 fas fa-code"></i>
                  {{ app.template ? Object.keys(app.template).length : 0 }} {{ t('nodes') }}
                </span> -->
                <span v-if="app.isFromMarket" class="flex items-center text-[var(--wb-text-2)]">
                  <i class="mr-1 fas fa-store"></i>
                  {{ t('fromMarket') }}
                </span>
              </div>
            </div>
          </div>
        </transition-group>
      </div>
    </div>

    <!-- 空状态 -->
    <div v-if="filteredApps.length === 0" class="py-20 text-center">
      <div class="inline-block p-6 mb-6 rounded-full bg-tech-darker">
        <i class="text-5xl fas fa-robot text-[var(--wb-text-2)]"></i>
      </div>
      <h3 class="mb-2 text-2xl font-bold text-white">
        {{ searchQuery.trim() || selectedCategory ? t('noAppsFound') : t('noAppsAvailable') }}
      </h3>
      <p class="mx-auto mb-6 max-w-md text-[var(--wb-text-2)]">
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
          class="btn-comfy-primary px-6 py-2 font-medium text-white rounded-md transition cursor-pointer"
        >
          {{ t('clearSearch') }}
        </button>
        <button
          v-if="selectedCategory"
          @click="$emit('clear-filter')"
          class="btn-comfy-primary px-6 py-2 font-medium text-white rounded-md transition cursor-pointer"
        >
          {{ t('clearFilter') }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed, ref, onMounted, onUnmounted, nextTick, watch } from 'vue'
import { App } from 'ant-design-vue'
import { t } from '@/utils/i18n'

const { modal } = App.useApp()

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

const emit = defineEmits(['view-detail', 'edit', 'delete', 'clear-search', 'clear-filter'])

// 处理删除确认
const handleDelete = (app) => {
  modal.confirm({
    title: t('deleteApp'),
    content: t('deleteAppConfirm', { name: app.name }),
    okText: t('confirm'),
    cancelText: t('cancel'),
    onOk: () => {
      emit('delete', app)
    },
  })
}

// 虚拟滚动相关状态
const scrollContainer = ref(null)
const scrollTop = ref(0)
const containerHeight = ref(0)
const itemHeight = ref(80) // 紧凑列表项的高度
const bufferSize = ref(5) // 缓冲区大小
const resizeObserver = ref(null)

// 动态测量第一个compact-app-item高度
const measureItemHeight = () => {
  nextTick(() => {
    const item = document.querySelector('.virtual-items-container .compact-app-item')
    if (item) {
      // 取高度+margin-bottom（8px）
      itemHeight.value = item.offsetHeight + 8
    }
  })
}

// 计算属性：过滤后的应用列表
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

// 计算总高度
const totalHeight = computed(() => {
  return filteredApps.value.length * itemHeight.value
})

// 计算可见范围
const visibleRange = computed(() => {
  const start = Math.floor(scrollTop.value / itemHeight.value)
  const visibleItems = Math.ceil(containerHeight.value / itemHeight.value) + bufferSize.value * 2
  const end = Math.min(start + visibleItems, filteredApps.value.length)

  return {
    start: Math.max(0, start - bufferSize.value),
    end: Math.min(filteredApps.value.length, end + bufferSize.value),
  }
})

// 计算偏移量
const offsetY = computed(() => {
  return Math.max(0, visibleRange.value.start * itemHeight.value)
})

// 可见的应用列表
const visibleApps = computed(() => {
  return filteredApps.value.slice(visibleRange.value.start, visibleRange.value.end)
})

// 防抖函数
const debounce = (func, wait) => {
  let timeout
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout)
      func(...args)
    }
    clearTimeout(timeout)
    timeout = setTimeout(later, wait)
  }
}

// 处理滚动事件
const handleScroll = debounce(() => {
  if (scrollContainer.value) {
    scrollTop.value = scrollContainer.value.scrollTop
  }
}, 16) // 约60fps

// 监听容器大小变化
const updateContainerHeight = () => {
  if (scrollContainer.value) {
    containerHeight.value = scrollContainer.value.clientHeight
  }
  measureItemHeight() // 容器变化时重新测量高度
}

// 监听窗口大小变化
const handleResize = () => {
  updateContainerHeight()
}

// 监听过滤结果变化，重置滚动位置
watch(filteredApps, () => {
  if (scrollContainer.value) {
    scrollContainer.value.scrollTop = 0
    scrollTop.value = 0
  }
})

// 格式化日期
const formatDate = (date) => {
  if (!date) return ''
  const d = new Date(date)
  return d.toLocaleDateString()
}

onMounted(() => {
  nextTick(() => {
    updateContainerHeight()
    handleResize()
    window.addEventListener('resize', handleResize)
    measureItemHeight() // 初始测量高度
    if (scrollContainer.value) {
      resizeObserver.value = new ResizeObserver(() => {
        updateContainerHeight()
        measureItemHeight() // 容器变化时重新测量高度
      })
      resizeObserver.value.observe(scrollContainer.value)
    }
  })
})

onUnmounted(() => {
  window.removeEventListener('resize', handleResize)
  if (resizeObserver.value) {
    resizeObserver.value.disconnect()
  }
})
</script>

<style scoped>
.compact-list-container {
  height: 100%;
  display: flex;
  flex-direction: column;
}

.virtual-scroll-container {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  position: relative;
  min-height: 0; /* 重要：确保flex子元素可以收缩 */
}

.virtual-scroll-spacer {
  position: relative;
}

.virtual-items-container {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
}

.compact-app-item {
  display: flex;
  align-items: center;
  padding: 12px 16px;
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  border-radius: var(--wb-r-card);
  cursor: pointer;
  transition:
    background 0.2s ease,
    border-color 0.2s ease;
  margin-bottom: 8px;
}

.compact-app-item:last-child {
  margin-bottom: 0;
}

.compact-app-item:hover {
  background: var(--wb-surface-hover);
  border-color: var(--wb-stroke-strong);
}

.line-clamp-2 {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.card-enter-active {
  transition:
    opacity 0.2s ease,
    transform 0.2s ease;
}

.card-enter-from {
  opacity: 0;
  transform: translateY(20px) scale(0.95);
}

/* 自定义滚动条 */
.virtual-scroll-container::-webkit-scrollbar {
  width: 6px;
}

.virtual-scroll-container::-webkit-scrollbar-track {
  background: var(--wb-surface-deep);
  border-radius: 3px;
}

.virtual-scroll-container::-webkit-scrollbar-thumb {
  background: var(--wb-accent);
  border-radius: 3px;
}

.virtual-scroll-container::-webkit-scrollbar-thumb:hover {
  background: var(--wb-accent-hover);
}
</style>
