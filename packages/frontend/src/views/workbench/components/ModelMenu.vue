<template>
  <a-dropdown :trigger="['click']">
    <button
      class="px-2 py-1 text-sm text-[var(--wb-text-2)] hover:text-white rounded-md transition"
      :title="t('workbenchModelSelect')"
    >
      <i class="fas fa-microchip"></i>
      <span class="ml-1 hidden sm:inline text-xs">{{ currentLabel }}</span>
    </button>
    <template #overlay>
      <a-menu @click="onMenu">
        <a-menu-item-group :title="t('workbenchModelDecision')">
          <a-menu-item key="decision-default">
            {{ defaultDecisionModel }}（{{ t('workbenchModelDefault') }}）
          </a-menu-item>
        </a-menu-item-group>
        <a-menu-item-group :title="t('workbenchModelBuild')">
          <a-menu-item key="build-default">
            {{ defaultBuildModel }}（{{ t('workbenchModelDefault') }}）
          </a-menu-item>
        </a-menu-item-group>
      </a-menu>
    </template>
  </a-dropdown>
</template>

<script setup>
import { computed } from 'vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'

const props = defineProps({
  override: { type: Object, default: null },
})
const emit = defineEmits(['update:override'])

const { t } = useI18n()
const appStore = useAppStore()

const defaultDecisionModel = computed(() => appStore.config?.buildModel || 'deepseek-v4-flash')
const defaultBuildModel = computed(() => appStore.config?.buildModel || defaultDecisionModel.value)
const currentLabel = computed(() => {
  const o = props.override || {}
  return o.decisionModel || o.buildModel || defaultDecisionModel.value
})

function onMenu({ key }) {
  // MVP：恢复默认（模型清单派生后续接入网关 /models 探测后开放完整列表）
  if (key === 'decision-default' || key === 'build-default') {
    emit('update:override', {})
  }
}
</script>
