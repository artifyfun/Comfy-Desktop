<template>
  <a-modal
    :open="open"
    :title="t('workbenchSkillLib')"
    :footer="null"
    width="860px"
    @cancel="$emit('update:open', false)"
  >
    <div class="space-y-3">
      <div class="text-xs text-[var(--wb-text-2)]">{{ t('workbenchSkillLibHint') }}</div>

      <!-- 工具条：汇总 + 操作 -->
      <div class="flex items-center justify-between gap-2">
        <div class="text-[11px] text-[var(--wb-text-3)] font-mono">
          {{ tokensStat }}
        </div>
        <div class="flex gap-2">
          <a-button size="small" @click="openFolder('')">
            <i class="fas fa-folder-open mr-1"></i>{{ t('workbenchSkillOpenFolder') }}
          </a-button>
          <a-button size="small" @click="importOpen = true">
            <i class="fas fa-file-import mr-1"></i>{{ t('workbenchSkillImport') }}
          </a-button>
          <a-button size="small" type="primary" @click="startCreate">
            <i class="fas fa-plus mr-1"></i>{{ t('workbenchSkillNew') }}
          </a-button>
        </div>
      </div>

      <SkillList
        :items="builtinSkills"
        :loading="loading"
        :group-label="t('workbenchSkillSourceBuiltin')"
        @toggle="toggle"
        @view="view"
        @open-folder="openFolder"
      />
      <SkillList
        :items="userSkills"
        :loading="loading"
        :group-label="t('workbenchSkillSourceManual')"
        :empty-text="t('workbenchSkillsEmptyLib')"
        @toggle="toggle"
        @view="view"
        @edit="edit"
        @remove="remove"
        @open-folder="openFolder"
      />
    </div>

    <!-- 新建/编辑/查看 -->
    <SkillForm
      v-model:open="formOpen"
      :skill="editing"
      :readonly="viewing"
      @saved="onSaved"
    />

    <!-- 导入 -->
    <SkillImportDialog v-model:open="importOpen" @imported="load" />
  </a-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { Modal, message } from 'ant-design-vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import SkillList from './SkillList.vue'
import SkillForm from './SkillForm.vue'
import SkillImportDialog from './SkillImportDialog.vue'

const props = defineProps({
  open: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open'])

const { t } = useI18n()
const appStore = useAppStore()
const origin = computed(() => appStore.config?.serverHost || window.location.origin)

const skills = ref([])
const loading = ref(false)
const formOpen = ref(false)
const importOpen = ref(false)
const editing = ref(null)
const viewing = ref(false)

const builtinSkills = computed(() => skills.value.filter((s) => s.builtin))
const userSkills = computed(() => skills.value.filter((s) => !s.builtin))

const tokensStat = computed(() => {
  const n = skills.value.length
  const resident = skills.value.reduce((a, s) => a + (s.residentTokens || 0), 0)
  const full = skills.value.reduce((a, s) => a + (s.tokens || 0), 0)
  return t('workbenchSkillTokensStat')
    .replace('{n}', n)
    .replace('{a}', Math.round(resident).toLocaleString())
    .replace('{b}', Math.round(full).toLocaleString())
})

async function load() {
  loading.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/skills`)
    const json = await res.json()
    skills.value = json?.data ?? []
  } finally {
    loading.value = false
  }
}

// 打开即拉取（保持最新，技能可能被外部目录操作改过）
function onOpenChanged(v) {
  if (v) load()
}
watch(() => props.open, onOpenChanged)

async function toggle(s) {
  const res = await fetch(`${origin.value}/api/workbench/skills/toggle`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: s.name, enabled: !s.enabled }),
  })
  const json = await res.json()
  if (!res.ok || !json?.success) {
    message.error(json?.message || 'toggle failed')
    return
  }
  s.enabled = !s.enabled
}

function startCreate() {
  editing.value = null
  viewing.value = false
  formOpen.value = true
}

function view(s) {
  editing.value = s
  viewing.value = true
  formOpen.value = true
}

function edit(s) {
  editing.value = s
  viewing.value = false
  formOpen.value = true
}

function onSaved({ renamedTo, presetsFixed }) {
  formOpen.value = false
  load()
  if (renamedTo && presetsFixed > 0) {
    message.success(t('workbenchSkillRenameFix').replace('{n}', presetsFixed))
  }
}

function remove(s) {
  Modal.confirm({
    title: t('workbenchSkillDeleteConfirmTitle'),
    content: t('workbenchSkillDeleteConfirmBody').replace('{name}', s.name),
    okText: t('confirm'),
    okType: 'danger',
    cancelText: t('cancel'),
    onOk: async () => {
      const res = await fetch(`${origin.value}/api/workbench/skills/remove`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: s.name }),
      })
      const json = await res.json()
      if (!res.ok || !json?.success) {
        message.error(json?.message || 'delete failed')
        return
      }
      message.success(t('workbenchDeleted'))
      load()
    },
  })
}

async function openFolder(name) {
  await fetch(`${origin.value}/api/workbench/skills/open-folder`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: name || null }),
  })
}
</script>
