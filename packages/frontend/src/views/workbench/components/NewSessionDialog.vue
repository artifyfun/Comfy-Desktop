<template>
  <a-modal
    :open="open"
    :title="t('workbenchNewSession')"
    :ok-text="t('confirm')"
    :cancel-text="t('cancel')"
    @ok="create"
    @cancel="$emit('update:open', false)"
  >
    <div class="space-y-4 py-2">
      <div>
        <div class="text-sm text-slate-300 mb-2">{{ t('workbenchPresetPick') }}</div>
        <div class="flex flex-wrap gap-2">
          <button
            v-for="p in presets"
            :key="p.id"
            class="px-3 py-1.5 rounded-full border text-sm transition"
            :class="
              selectedId === p.id
                ? 'bg-tech-blue/80 border-tech-blue text-white'
                : 'border-slate-600 text-slate-300 hover:border-tech-blue'
            "
            @click="selectedId = p.id"
          >
            <i :class="presetIcon(p)" class="mr-1"></i>{{ presetName(p) }}
          </button>
        </div>
        <div v-if="selected" class="mt-2 text-xs text-slate-400">
          {{ selected.description?.[lang] || selected.description?.zh }}
        </div>
      </div>
      <div>
        <div class="text-sm text-slate-300 mb-1">{{ t('workbenchSessionTitle') }}</div>
        <a-input v-model:value="title" :placeholder="t('workbenchTitleAuto')" allow-clear />
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/utils/i18n'

const props = defineProps({
  open: { type: Boolean, default: false },
  presets: { type: Array, default: () => [] },
  defaultPresetId: { type: String, default: 'standard' },
})
const emit = defineEmits(['update:open', 'create'])

const { t } = useI18n()
const selectedId = ref(props.defaultPresetId)
const title = ref('')
const lang = useI18n().getCurrentLanguage?.() === 'en' ? 'en' : 'zh'

watch(
  () => props.open,
  (v) => {
    if (v) {
      selectedId.value = props.defaultPresetId
      title.value = ''
    }
  },
)

const selected = computed(() => props.presets.find((p) => p.id === selectedId.value))

function presetName(p) {
  return p.name?.[lang] || p.name?.zh || p.id
}
function presetIcon(p) {
  if (p.intentHint === 'video') return 'fas fa-film'
  if (p.intentHint === 'image') return 'fas fa-image'
  return 'fas fa-bolt'
}

function create() {
  emit('create', { presetId: selectedId.value, title: title.value.trim() || undefined })
  emit('update:open', false)
}
</script>
