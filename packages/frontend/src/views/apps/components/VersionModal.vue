<template>
  <a-modal
    :open="open"
    :title="t('versionHistory')"
    :footer="null"
    width="480px"
    @cancel="$emit('cancel')"
  >
    <a-spin v-if="loading" class="flex justify-center py-8" />
    <div v-else-if="!versions.length" class="py-8 text-center text-slate-400">
      {{ t('noVersions') }}
    </div>
    <div v-else class="max-h-96 overflow-auto">
      <div
        v-for="v in versions"
        :key="v.version"
        class="flex justify-between items-center py-3 border-b border-slate-700 last:border-0"
      >
        <div>
          <div class="font-medium text-white">
            v{{ v.version }} <span class="ml-2 text-xs text-slate-400">{{ v.name }}</span>
          </div>
          <div class="text-xs text-slate-500">{{ formatTime(v.created_at) }}</div>
        </div>
        <a-button size="small" @click="restore(v)">
          <i class="mr-1 fas fa-clock-rotate-left"></i>{{ t('restore') }}
        </a-button>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, watch } from 'vue'
import { message } from 'ant-design-vue'
import { useI18nInComponent } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import dayjs from 'dayjs'

const props = defineProps({
  open: { type: Boolean, default: false },
  appId: { type: String, default: '' },
})
const emit = defineEmits(['cancel', 'restored'])

const { t } = useI18nInComponent()
const appStore = useAppStore()
const versions = ref([])
const loading = ref(false)

const formatTime = (ts) => dayjs(ts).format('YYYY-MM-DD HH:mm:ss')

const fetchVersions = async () => {
  if (!props.appId) return
  loading.value = true
  versions.value = []
  try {
    const res = await appStore.apiRequest('/api/apps/versions', {
      method: 'POST',
      body: JSON.stringify({ id: props.appId }),
    })
    if (res.ok) {
      versions.value = res.data || []
    }
  } finally {
    loading.value = false
  }
}

const restore = async (v) => {
  try {
    // 取版本快照，整体写回（update 前后端会自动再快照当前版本，可随时撤销恢复）
    const res = await appStore.apiRequest('/api/apps/version-detail', {
      method: 'POST',
      body: JSON.stringify({ id: props.appId, version: v.version }),
    })
    if (!res.ok) throw new Error(res.message)
    await appStore.updateApp(res.data)
    message.success(t('versionRestored'))
    emit('restored')
    emit('cancel')
  } catch (e) {
    message.error(e.message)
  }
}

watch(
  () => props.open,
  (open) => open && fetchVersions(),
)
</script>
