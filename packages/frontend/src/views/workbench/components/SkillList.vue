<template>
  <div>
    <div class="text-[11px] text-[var(--wb-text-3)] px-1 pb-1 font-medium tracking-wide">
      {{ groupLabel }} ({{ items.length }})
    </div>
    <div
      v-if="items.length === 0 && !loading"
      class="text-xs text-[var(--wb-text-3)] px-2 py-3 text-center rounded-lg"
      style="border: 1px dashed var(--wb-stroke)"
    >
      {{ emptyText }}
    </div>
    <div class="space-y-1">
      <div
        v-for="s in items"
        :key="s.name"
        class="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-[var(--wb-surface-hover)] group"
      >
        <!-- 启停 -->
        <a-tooltip :title="s.enabled ? '' : t('workbenchSkillDisabledHint')">
          <input
            type="checkbox"
            class="wb-tech-check"
            :checked="s.enabled"
            @change="$emit('toggle', s)"
          />
        </a-tooltip>

        <div class="min-w-0 flex-1">
          <div class="flex items-center gap-1.5">
            <span class="text-sm text-white font-mono truncate">{{ s.name }}</span>
            <a-tag v-if="s.category" color="geekblue" class="!m-0 !text-[10px] !leading-4 !px-1">
              {{ categoryLabel(s.category) }}
            </a-tag>
            <a-tag v-if="!s.valid" color="red" class="!m-0 !text-[10px] !leading-4 !px-1">
              {{ t('workbenchSkillInvalid') }}
            </a-tag>
            <a-tag v-for="e in s.extras" :key="e" class="!m-0 !text-[10px] !leading-4 !px-1">
              {{ e }}
            </a-tag>
          </div>
          <div class="text-xs text-[var(--wb-text-2)] truncate">
            {{ s.description || (s.issues && s.issues.join('; ')) }}
          </div>
        </div>

        <!-- 来源 -->
        <span class="text-[10px] text-[var(--wb-text-3)] shrink-0">{{
          sourceLabel(s.source)
        }}</span>
        <!-- token -->
        <span class="text-[10px] text-[var(--wb-text-3)] font-mono shrink-0 w-16 text-right">
          {{ s.tokens.toLocaleString() }}t
        </span>

        <!-- 操作 -->
        <div class="flex gap-0.5 shrink-0">
          <button
            class="w-6 h-6 rounded text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
            :title="t('workbenchSkillView')"
            @click="$emit('view', s)"
          >
            <i class="fas fa-eye text-xs"></i>
          </button>
          <button
            v-if="!s.builtin"
            class="w-6 h-6 rounded text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
            :title="t('workbenchSkillEdit')"
            @click="$emit('edit', s)"
          >
            <i class="fas fa-pen text-xs"></i>
          </button>
          <button
            class="w-6 h-6 rounded text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
            :title="t('workbenchSkillOpenFolder')"
            @click="$emit('open-folder', s.name)"
          >
            <i class="fas fa-folder-open text-xs"></i>
          </button>
          <button
            v-if="!s.builtin"
            class="w-6 h-6 rounded text-[var(--wb-text-2)] hover:text-red-400 hover:bg-[var(--wb-surface-active)] flex items-center justify-center"
            :title="t('delete')"
            @click="$emit('remove', s)"
          >
            <i class="fas fa-trash text-xs"></i>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup>
import { useI18n } from '@/utils/i18n'

defineProps({
  items: { type: Array, default: () => [] },
  groupLabel: { type: String, default: '' },
  emptyText: { type: String, default: '' },
  loading: { type: Boolean, default: false },
})
defineEmits(['toggle', 'view', 'edit', 'remove', 'open-folder'])

const { t } = useI18n()

function sourceLabel(source) {
  const key = `workbenchSkillSource${String(source || 'manual')
    .charAt(0)
    .toUpperCase()}${String(source || 'manual').slice(1)}`
  const label = t(key)
  return label === key ? source : label
}

function categoryLabel(id) {
  const key = `workbenchSkillCat${String(id || 'other')
    .charAt(0)
    .toUpperCase()}${String(id).slice(1)}`
  const label = t(key)
  return label === key ? id : label
}
</script>
