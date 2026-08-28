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
          v-for="p in sortedPresets"
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
              <div class="text-[11px] text-slate-500 mt-1 font-mono">
                intent: {{ p.intentHint || 'free'
                }}<template v-if="p.order != null"> · order: {{ p.order }}</template>
              </div>
              <!-- 捆绑技能（dsh preset skills/ 语义） -->
              <div v-if="!p.builtin" class="mt-2">
                <div class="flex items-center gap-1 flex-wrap">
                  <span class="text-[11px] text-slate-500">{{ t('workbenchPresetSkills') }}:</span>
                  <a-tag v-for="s in p.skillIds ?? []" :key="s" class="!m-0 !text-[11px]">
                    {{ skillName(s) }}
                  </a-tag>
                  <span v-if="!p.skillIds?.length" class="text-[11px] text-slate-600">—</span>
                  <button
                    class="text-[11px] text-tech-blue hover:underline ml-1"
                    @click="openSkills(p)"
                  >
                    {{ t('workbenchPresetEditSkills') }}
                  </button>
                </div>
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

      <!-- 技能勾选弹层（预设捆绑技能） -->
      <a-modal
        :open="skillsOpen"
        :title="`${t('workbenchPresetEditSkills')} — ${editingPreset?.name?.[lang] || editingPreset?.id || ''}`"
        :ok-text="t('confirm')"
        :cancel-text="t('cancel')"
        :ok-button-props="{ loading: savingSkills }"
        @ok="saveSkills"
        @cancel="skillsOpen = false"
      >
        <div v-if="skillsList.length === 0" class="text-sm text-slate-400 py-4 text-center">
          {{ t('workbenchSkillsEmptyLib') }}
        </div>
        <div v-else class="space-y-1 max-h-80 overflow-y-auto">
          <label
            v-for="s in skillsList"
            :key="s.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-slate-700/40 cursor-pointer"
          >
            <input type="checkbox" :value="s.id" v-model="checkedSkills" class="wb-tech-check" />
            <span class="text-sm text-white">{{ s.name }}</span>
            <span class="text-[11px] text-slate-500 font-mono">/{{ s.id }}</span>
            <span class="text-[11px] text-slate-400 truncate ml-auto">{{ s.description }}</span>
          </label>
        </div>
      </a-modal>

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
            <a-input v-model:value="copyId" placeholder="my-preset" class="wb-tech-input" />
          </a-form-item>
          <a-form-item :label="t('appName')">
            <a-input v-model:value="copyName" class="wb-tech-input" />
          </a-form-item>
          <a-form-item :label="t('workbenchPresetSkills')">
            <div
              class="max-h-40 overflow-y-auto space-y-1.5 p-2 rounded-lg border border-slate-700/60"
            >
              <label
                v-for="sk in skillsList"
                :key="sk.id"
                class="flex items-center gap-2 text-sm text-slate-300 cursor-pointer"
              >
                <input v-model="copySkills" type="checkbox" :value="sk.id" class="wb-tech-check" />
                <span class="truncate">{{ sk.name }}</span>
              </label>
              <div v-if="!skillsList.length" class="text-xs text-slate-500">
                {{ t('workbenchNoSkillsYet') }}
              </div>
            </div>
            <div class="text-[11px] text-slate-500 mt-1">{{ t('workbenchCopySkillsHint') }}</div>
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

// ---------- 技能捆绑编辑（dsh preset skills/ 语义） ----------
const skillsOpen = ref(false)
const editingPreset = ref(null)
const checkedSkills = ref([])
const savingSkills = ref(false)
const skillsList = ref([])

async function loadSkillsList() {
  const res = await fetch(`${origin.value}/api/workbench/skills`)
  const json = await res.json()
  skillsList.value = json?.data ?? []
}

function skillName(id) {
  return skillsList.value.find((s) => s.id === id)?.name || id
}

async function openSkills(p) {
  editingPreset.value = p
  checkedSkills.value = [...(p.skillIds ?? [])]
  if (skillsList.value.length === 0) await loadSkillsList()
  skillsOpen.value = true
}

async function saveSkills() {
  savingSkills.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/presets/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editingPreset.value.id, skillIds: checkedSkills.value }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'save failed')
    skillsOpen.value = false
    message.success(t('workbenchSaved'))
    emit('changed')
  } catch (e) {
    message.error(e.message)
  } finally {
    savingSkills.value = false
  }
}

const { t, getCurrentLanguage } = useI18n()
const appStore = useAppStore()
const lang = computed(() => (getCurrentLanguage?.() === 'en' ? 'en' : 'zh'))

const copyOpen = ref(false)

// dsh preset.yml order 语义：列表按 order 升序
const sortedPresets = computed(() =>
  [...props.presets].sort((a, b) => (a.order ?? 100) - (b.order ?? 100)),
)
const copyFrom = ref('')
const copyId = ref('')
const copyName = ref('')
const copySkills = ref([])
const copying = ref(false)

const origin = computed(() => appStore.config?.serverHost || window.location.origin)

async function openCopy(p) {
  copyFrom.value = p.id
  copyId.value = ''
  copyName.value = ''
  // 一步到位:预勾源预设的技能,可当场增删(源是内置时其技能多继承自 spec)
  copySkills.value = [...(p.skillIds ?? [])]
  if (skillsList.value.length === 0) await loadSkillsList()
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
    // 一步到位:勾了技能就写入新预设(与编辑技能同一端点)
    if (copySkills.value.length > 0) {
      await fetch(`${origin.value}/api/workbench/presets/skills`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: copyId.value, skillIds: copySkills.value }),
      })
    }
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
