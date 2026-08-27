<template>
  <div
    v-if="open"
    class="absolute bottom-full left-0 mb-2 w-80 max-h-80 overflow-y-auto rounded-lg border border-slate-600 bg-slate-800 shadow-2xl z-50"
  >
    <div class="p-2 text-xs text-slate-400 border-b border-slate-700 sticky top-0 bg-slate-800">
      {{ t('workbenchSkillHint') }}
    </div>
    <div class="py-1">
      <div v-if="items.length === 0" class="px-3 py-2 text-sm text-slate-400">
        {{ t('workbenchSkillEmpty') }}
      </div>
      <button
        v-for="(s, i) in items"
        :key="s.kind + s.id"
        class="w-full text-left px-3 py-2 flex items-start gap-2"
        :class="i === activeIndex ? 'bg-slate-700/80' : 'hover:bg-slate-700/50'"
        @click="$emit('pick', s)"
        @mousemove="$emit('active', i)"
      >
        <i
          :class="s.kind === 'preset' ? 'fas fa-bolt' : 'fas fa-diagram-project'"
          class="mt-0.5 text-tech-blue"
        ></i>
        <div class="min-w-0">
          <div class="text-sm text-white truncate">
            {{ s.name }}
            <span class="text-[10px] text-slate-400 font-mono">/{{ s.id }}</span>
          </div>
          <div class="text-xs text-slate-400 truncate">{{ s.description }}</div>
        </div>
      </button>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from '@/utils/i18n'

defineProps({
  open: { type: Boolean, default: false },
  items: { type: Array, default: () => [] },
  activeIndex: { type: Number, default: 0 },
})
defineEmits(['pick', 'active'])
const { t } = useI18n()
</script>
