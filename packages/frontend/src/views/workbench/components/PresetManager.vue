<template>
  <a-modal
    :open="open"
    :title="t('workbenchManagePresets')"
    :footer="null"
    width="720px"
    @cancel="$emit('update:open', false)"
  >
    <div class="space-y-3">
      <!-- 默认预设提示 -->
      <div class="text-xs text-slate-400">
        {{ t('workbenchPresetDefaultHint') }}：<span class="text-tech-cyan">{{ defaultId }}</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="p in presets"
          :key="p.id"
          class="rounded-lg border p-3 relative"
          :class="p.id === defaultId ? 'border-tech-blue' : 'border-slate-600'"
        >
          <div class="flex items-start justify-between">
            <div class="min-w-0">
              <div class="text-white font-medium truncate">
                {{ p.name?.[lang] || p.id }}
                <a-tag v-if="p.builtin" color="blue" class="ml-1">builtin</a-tag>
                <a-tag v-if="p.id === defaultId" color="cyan" class="ml-1">default</a-tag>
              </div>
              <div class="text-xs text-slate-400 mt-1 line-clamp-2">
                {{ p.description?.[lang] || '' }}
              </div>
              <div v-if="p.intentHint" class="text-[11px] text-slate-500 mt-1 font-mono">
                intent: {{ p.intentHint }}
              </div>
            </div>
          </div>
          <div class="mt-2 flex gap-2 justify-end">
            <a-button
              v-if="!p.builtin && p.id !== defaultId"
              size="small"
              @click="setDefault(p.id)"
            >
              {{ t('workbenchSetDefault') }}
            </a-button>
            <a-button size="small" @click="openCopy(p)">
              <i class="fas fa-copy mr-1"></i>{{ t('workbenchCopyPreset') }}
            </a-button>
            <a-button v-if="!p.builtin" size="small" danger @click="remove(p.id)">
              {{ t('delete') }}
            </a-button>
          </div>
        </div>
      </div>

      <!-- 复制对话框 -->
      <a-modal
        :open="copyOpen"
        :title="t('workbenchCopyPreset')"
        :ok-text="t('confirm')"
        :cancel-text="t('cancel')"
        :ok-button-props="{ loading: copying }"
        @ok="doCopy"
        @cancel="copyOpen = false"
      >
        <a-form layout="vertical">
          <a-form-item label="ID">
            <a-input v-model:value="copyId" placeholder="my-preset" />
          </a-form-item>
          <a-form-item :label="t('appName')">
            <a-input v-model:value="copyName" />
          </a-form-item>
        </a-form>
      </a-modal>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed } from 'vue'
import { message } from 'ant-design-vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'

const props = defineProps({
  open: { type: Boolean, default: false },
  presets: { type: Array, default: () => [] },
  defaultId: { type: String, default: 'standard' },
})
const emit = defineEmits(['update:open', 'changed'])

const { t, getCurrentLanguage } = useI18n()
const appStore = useAppStore()
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

const copyOpen = ref(false)
const copyFrom = ref('')
const copyId = ref('')
const copyName = ref('')
const copying = ref(false)

const origin = computed(() => appStore.config?.serverHost || window.location.origin)

function openCopy(p) {
  copyFrom.value = p.id
  copyId.value = ''
  copyName.value = ''
  copyOpen.value = true
}

async function doCopy() {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(copyId.value)) {
    message.warning(t('workbenchPresetIdRule'))
    return
  }
  copying.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/presets/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: copyFrom.value, id: copyId.value, name: copyName.value }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'create failed')
    copyOpen.value = false
    message.success(t('workbenchPresetCreated'))
    emit('changed')
  } catch (e) {
    message.error(e.message)
  } finally {
    copying.value = false
  }
}

async function setDefault(id) {
  await fetch(`${origin.value}/api/workbench/presets/default`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  message.success(t('workbenchPresetDefaultSet'))
  emit('changed')
}

async function remove(id) {
  const res = await fetch(`${origin.value}/api/workbench/presets/delete`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  })
  if (res.ok) {
    message.success(t('workbenchDeleted'))
    emit('changed')
  }
}
</script>
