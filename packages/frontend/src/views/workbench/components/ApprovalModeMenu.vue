<template>
  <a-dropdown :trigger="['click']">
    <button
      class="px-2 py-1 text-slate-300 hover:text-white rounded transition flex items-center"
      :title="t('workbenchApprovalModeTitle')"
    >
      <i class="fas fa-shield-halved"></i>
      <span class="ml-1 hidden sm:inline text-xs">{{ currentLabel }}</span>
    </button>
    <template #overlay>
      <a-menu @click="onMenu">
        <a-menu-item key="standard">
          <span class="flex flex-col py-0.5">
            <span class="flex items-center gap-2 text-[13px]">
              <i v-if="mode === 'standard'" class="fas fa-check text-[var(--wb-accent)] w-3.5"></i>
              <i v-else class="fas fa-check w-3.5 opacity-0"></i>
              {{ t('workbenchApprovalStandard') }}
            </span>
          </span>
        </a-menu-item>
        <a-menu-item key="conservative">
          <span class="flex flex-col py-0.5">
            <span class="flex items-center gap-2 text-[13px]">
              <i
                v-if="mode === 'conservative'"
                class="fas fa-check text-[var(--wb-accent)] w-3.5"
              ></i>
              <i v-else class="fas fa-check w-3.5 opacity-0"></i>
              {{ t('workbenchApprovalConservative') }}
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
  /** 'standard' | 'conservative'（后端 ApprovalMode 白名单值） */
  mode: { type: String, default: 'standard' },
})
const emit = defineEmits(['update:mode'])

const { t } = useI18n()

const currentLabel = computed(() =>
  props.mode === 'conservative'
    ? t('workbenchApprovalModeConservativeShort')
    : t('workbenchApprovalModeStandardShort'),
)

/** a-menu 点击：antd-vue 事件载荷为 { key, keyPath, item, domEvent } */
function onMenu({ key }) {
  emit('update:mode', key)
}
</script>
