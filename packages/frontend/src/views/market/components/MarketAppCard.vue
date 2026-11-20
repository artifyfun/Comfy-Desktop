<template>
  <div
    class="overflow-hidden relative p-5 cursor-pointer glass-card"
    style="border-radius: var(--wb-r-card)"
    @click="$emit('view-detail', app)"
  >
    <!-- 封面图片 -->
    <div class="overflow-hidden relative mb-4 h-48 rounded-lg app-imageUrl">
      <div class="absolute inset-0 z-10 bg-[#171718]/40"></div>
      <div
        class="absolute top-3 right-3 px-2 py-1 text-sm font-medium text-white rounded bg-tech-blue/80"
      >
        {{ t(app.category) }}
      </div>
      <img :src="app.imageUrl" :alt="app.name" class="object-cover w-full h-full" />
    </div>

    <!-- 应用信息 -->
    <div class="px-1">
      <div class="flex justify-between items-start mb-2">
        <h3 class="text-xl font-bold text-white">{{ app.name }}</h3>
        <!-- <span class="flex items-center text-sm text-tech-blue">
          <i class="mr-1 fas fa-star"></i>
          {{ app.rating || '4.5' }}
        </span> -->
      </div>

      <p class="overflow-hidden mb-3 h-12 text-sm text-[var(--wb-text)]">
        {{ app.description }}
      </p>

      <div class="flex justify-between items-center text-sm text-[var(--wb-text-2)]">
        <div class="flex items-center">
          <i class="mr-2 far fa-clock"></i>
          <span>{{ formatDate(app.createdAt) }}</span>
        </div>
        <div class="flex items-center space-x-1">
          <i class="fas fa-bolt text-[var(--wb-text-2)]"></i>
          <span>{{ t(app.powerLevel) }}</span>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { t } from '@/utils/i18n'

defineProps({
  app: {
    type: Object,
    required: true,
  },
})

defineEmits(['view-detail', 'install'])

// 格式化日期
function formatDate(date) {
  return new Date(date).toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  })
}
</script>

<style scoped>
.glass-card {
  background: var(--wb-surface-deep);
  border: 1px solid var(--wb-stroke);
  transition:
    background 0.15s ease,
    border-color 0.15s ease;
}

.glass-card:hover {
  background: var(--wb-surface);
  border-color: var(--wb-selected);
}

.app-imageUrl {
  transition: transform 0.2s ease-out;
}

.glass-card:hover .app-imageUrl {
  transform: scale(1.05);
}
</style>
