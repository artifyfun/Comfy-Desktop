<template>
  <a-dropdown :trigger="['click']">
    <button
      class="px-2 py-1 text-[var(--wb-text-2)] hover:text-white rounded-md transition flex items-center"
      :title="t('workbenchReasoningEffortTitle')"
    >
      <i class="fas fa-gauge-high"></i>
      <span class="ml-1 hidden sm:inline text-xs">{{ currentLabel }}</span>
    </button>
    <template #overlay>
      <a-menu @click="onMenu" class="!min-w-[210px]">
        <a-menu-item v-for="opt in options" :key="opt.value">
          <span class="flex flex-col py-0.5">
            <span class="flex items-center gap-2 text-[13px]">
              <i v-if="effort === opt.value" class="fas fa-check text-[var(--wb-accent)] w-3.5"></i>
              <i v-else class="fas fa-check w-3.5 opacity-0"></i>
              {{ t(opt.labelKey) }}
            </span>
            <span class="text-[11px] text-[var(--wb-text-3)] pl-[22px]">
              {{ t(opt.hintKey) }}
            </span>
          </span>
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/utils/i18n'

const props = defineProps({
  /** 'auto' | 'low' | 'medium' | 'high' | 'xhigh'(默认 auto=不指定;minimal 后端支持但不上 UI) */
  effort: { type: String, default: 'auto' },
})
const emit = defineEmits(['update:effort'])

const { t } = useI18n()

/** UI 档位:auto(默认,不指定)+ 4 常用档(minimal 与 auto 过近不上 UI;
 *  后端域仍接受,未来需要可直接从 API 传) */
const options = [
  {
    value: 'auto',
    labelKey: 'workbenchReasoningEffortAuto',
    hintKey: 'workbenchReasoningEffortAutoHint',
  },
  {
    value: 'low',
    labelKey: 'workbenchReasoningEffortLow',
    hintKey: 'workbenchReasoningEffortLowHint',
  },
  {
    value: 'medium',
    labelKey: 'workbenchReasoningEffortMedium',
    hintKey: 'workbenchReasoningEffortMediumHint',
  },
  {
    value: 'high',
    labelKey: 'workbenchReasoningEffortHigh',
    hintKey: 'workbenchReasoningEffortHighHint',
  },
  {
    value: 'xhigh',
    labelKey: 'workbenchReasoningEffortXhigh',
    hintKey: 'workbenchReasoningEffortXhighHint',
  },
]

const SHORT_KEYS = {
  auto: 'workbenchReasoningEffortAutoShort',
  low: 'workbenchReasoningEffortLowShort',
  medium: 'workbenchReasoningEffortMediumShort',
  high: 'workbenchReasoningEffortHighShort',
  xhigh: 'workbenchReasoningEffortXhighShort',
}

const currentLabel = computed(() => t(SHORT_KEYS[props.effort] || SHORT_KEYS.auto))

function onMenu({ key }) {
  emit('update:effort', key)
}
</script>
