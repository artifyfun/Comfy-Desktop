<template>
  <div class="picker-mask" @mousedown.self="$emit('close')">
    <div class="picker">
      <div class="flex items-center justify-between mb-3">
        <span class="text-sm font-medium text-[var(--wb-text-1)]">
          <i class="fas fa-cube text-[var(--wb-accent)] mr-1"></i>{{ t('canvasAppPickerTitle') }}
        </span>
        <input v-model="q" class="search" :placeholder="t('canvasAppPickerSearch')" />
        <button class="text-[var(--wb-text-2)] hover:text-white" @click="$emit('close')">
          <i class="fas fa-times"></i>
        </button>
      </div>
      <a-spin :spinning="loading">
        <div class="grid">
          <button v-for="a in filtered" :key="a.id" class="card" @click="$emit('pick', a)">
            <img v-if="a.imageUrl" :src="a.imageUrl" class="cover" />
            <div v-else class="cover cover-empty"><i class="fas fa-cube"></i></div>
            <div class="meta">
              <div class="name" :title="a.name">{{ a.name }}</div>
              <div class="desc">{{ a.description || a.category || '' }}</div>
            </div>
          </button>
          <div v-if="!loading && !filtered.length" class="empty">
            {{ t('canvasAppPickerEmpty') }}
          </div>
        </div>
      </a-spin>
    </div>
  </div>
</template>

<script setup>
/**
 * 应用拾取器：列出用户应用（appStore.apps），选中 → emit('pick', app)。
 * 只有带工作流（template.prompt 非空）的应用可作为节点。
 */
import { ref, computed, onMounted } from 'vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'

defineEmits(['close', 'pick'])
const { t } = useI18n()
const appStore = useAppStore()
const q = ref('')
const loading = ref(false)

const usable = computed(() =>
  (appStore.apps || []).filter(
    (a) => a && a.template && a.template.prompt && Object.keys(a.template.prompt).length > 0,
  ),
)
const filtered = computed(() => {
  const s = q.value.trim().toLowerCase()
  if (!s) return usable.value
  return usable.value.filter(
    (a) =>
      (a.name || '').toLowerCase().includes(s) || (a.description || '').toLowerCase().includes(s),
  )
})

onMounted(async () => {
  loading.value = true
  try {
    await appStore.loadApps()
  } catch {
    /* 错误 toast 已由 store 处理 */
  } finally {
    loading.value = false
  }
})
</script>

<style scoped>
.picker-mask {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
}
.picker {
  width: 560px;
  max-width: calc(100% - 32px);
  max-height: 70%;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid var(--wb-stroke);
  background: var(--wb-surface);
  padding: 14px;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.5);
}
.search {
  width: 180px;
  border-radius: 8px;
  border: 1px solid var(--wb-stroke);
  background: rgba(0, 0, 0, 0.2);
  padding: 4px 10px;
  color: var(--wb-text-1);
  outline: none;
  font-size: 12px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
  overflow-y: auto;
  /* 多行超出弹窗时滚动的关键：a-spin 包装层不传高度，grid 用视口相对
     max-height 自行约束（弹窗本体 max-height:70% 同基准） */
  max-height: calc(70vh * 0.7);
  padding-top: 4px;
}
.card {
  display: flex;
  flex-direction: column;
  border-radius: 10px;
  border: 1px solid var(--wb-stroke);
  background: rgba(0, 0, 0, 0.15);
  overflow: hidden;
  text-align: left;
  transition: border-color 0.15s;
}
.card:hover {
  border-color: var(--wb-accent);
}
.cover {
  width: 100%;
  height: 84px;
  object-fit: cover;
  background: rgba(0, 0, 0, 0.3);
}
.cover-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--wb-text-2);
  font-size: 22px;
}
.meta {
  padding: 6px 8px;
}
.name {
  font-size: 12px;
  color: var(--wb-text-1);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.desc {
  font-size: 10px;
  color: var(--wb-text-2);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.empty {
  grid-column: 1 / -1;
  text-align: center;
  color: var(--wb-text-2);
  padding: 24px 0;
  font-size: 12px;
}
</style>
