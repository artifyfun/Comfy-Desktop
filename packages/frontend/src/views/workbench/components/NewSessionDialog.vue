<template>
  <a-modal
    :open="open"
    :title="t('workbenchNewSession')"
    :ok-text="t('confirm')"
    :cancel-text="t('cancel')"
    :ok-button-props="{ disabled: !selected }"
    @ok="create"
    @cancel="$emit('update:open', false)"
  >
    <div class="space-y-4 py-2">
      <div>
        <div class="text-sm text-[var(--wb-text-2)] mb-2">{{ t('workbenchPresetPick') }}</div>
        <!-- dsh preset 卡片列表：name + description + 意图标签，点选整卡 -->
        <div class="space-y-2 max-h-72 overflow-y-auto pr-1">
          <button
            v-for="p in sortedPresets"
            :key="p.id"
            class="relative w-full text-left p-3 transition flex items-start gap-3"
            style="border: 1px solid var(--wb-stroke-strong); border-radius: var(--wb-r-card)"
            :class="
              selectedId === p.id
                ? 'bg-[var(--wb-surface)]'
                : 'hover:bg-[var(--wb-surface)] bg-[var(--wb-surface-deep)]'
            "
            @click="selectedId = p.id"
          >
            <span
              class="mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
              :class="
                selectedId === p.id ? 'bg-[rgba(11,140,233,0.35)]' : 'bg-[var(--wb-surface-hover)]'
              "
            >
              <i
                :class="[
                  presetIcon(p),
                  selectedId === p.id ? 'text-[var(--wb-accent)]' : 'text-[var(--wb-text-2)]',
                ]"
                class="text-sm"
              ></i>
            </span>
            <span class="min-w-0 flex-1">
              <span class="flex items-center gap-2">
                <span class="text-white text-sm font-medium truncate">{{ presetName(p) }}</span>
                <span
                  v-if="p.id === defaultPresetId"
                  class="text-[10px] text-tech-cyan border border-tech-cyan/40 rounded px-1"
                  >default</span
                >
                <span v-if="p.builtin" class="text-[10px] text-[var(--wb-text-3)]">builtin</span>
              </span>
              <span class="block text-xs text-[var(--wb-text-2)] mt-0.5 leading-relaxed">
                {{ presetDesc(p) }}
              </span>
              <span
                v-if="p.intentHint"
                class="inline-block mt-1 text-[10px] font-mono text-[var(--wb-text-3)] border border-[var(--wb-stroke)] rounded px-1.5 py-0.5"
              >
                /{{ p.id }} · intent: {{ p.intentHint }}
              </span>
            </span>
            <i
              class="fas fa-circle-check mt-1 shrink-0"
              :class="selectedId === p.id ? 'text-[var(--wb-accent)]' : 'text-[var(--wb-text-3)]'"
            ></i>
          </button>
        </div>
      </div>
      <div>
        <div class="text-sm text-[var(--wb-text-2)] mb-1">{{ t('workbenchSessionTitle') }}</div>
        <a-input
          v-model:value="title"
          :placeholder="t('workbenchTitleAuto')"
          allow-clear
          class="wb-tech-input"
        />
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

const { t, getCurrentLanguage } = useI18n()
const selectedId = ref(props.defaultPresetId)
const title = ref('')
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

watch(
  () => props.open,
  (v) => {
    if (v) {
      selectedId.value = props.defaultPresetId
      title.value = ''
    }
  },
)

const sortedPresets = computed(() =>
  [...props.presets].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
)
const selected = computed(() => props.presets.find((p) => p.id === selectedId.value))

function presetName(p) {
  return p.name?.[lang.value] || p.name?.zh || p.id
}
function presetDesc(p) {
  return p.description?.[lang.value] || p.description?.zh || ''
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

<style scoped>
/* Comfy 选中语义:白描边（--node-stroke-selected） */
.sel-white {
  border: 1px solid var(--wb-selected) !important;
}
</style>
