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
      <div class="text-xs text-[var(--wb-text-2)]">
        {{ t('workbenchPresetDefaultHint') }}：<span class="text-tech-cyan">{{ defaultId }}</span>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div
          v-for="p in sortedPresets"
          :key="p.id"
          class="rounded-lg p-3 relative"
          style="border: 1px solid var(--wb-stroke-strong)"
          :class="p.id === defaultId ? 'pm-sel' : ''"
        >
          <div class="flex items-start justify-between">
            <div class="min-w-0">
              <div class="text-white font-medium truncate">
                {{ p.name?.[lang] || p.id }}
                <a-tag v-if="p.builtin" color="blue" class="ml-1">builtin</a-tag>
                <a-tag v-if="p.id === defaultId" color="cyan" class="ml-1">default</a-tag>
              </div>
              <div class="text-xs text-[var(--wb-text-2)] mt-1 line-clamp-2">
                {{ p.description?.[lang] || '' }}
              </div>
              <div class="text-[11px] text-[var(--wb-text-3)] mt-1 font-mono">
                intent: {{ p.intentHint || 'free'
                }}<template v-if="p.order != null"> · order: {{ p.order }}</template>
              </div>
              <!-- 捆绑模板 + 捆绑技能（内置预设的种子组合只读展示） -->
              <div class="mt-2 space-y-1">
                <div class="flex items-center gap-1 flex-wrap">
                  <span class="text-[11px] text-[var(--wb-text-3)]"
                    >{{ t('workbenchPresetTemplates') }}:</span
                  >
                  <a-tag v-for="s in p.templateIds ?? []" :key="s" class="!m-0 !text-[11px]">
                    {{ templateName(s) }}
                  </a-tag>
                  <span v-if="!p.templateIds?.length" class="text-[11px] text-[var(--wb-text-3)]"
                    >—</span
                  >
                </div>
                <div class="flex items-center gap-1 flex-wrap">
                  <span class="text-[11px] text-[var(--wb-text-3)]"
                    >{{ t('workbenchPresetSkills') }}:</span
                  >
                  <a-tag v-for="s in p.skillIds ?? []" :key="s" class="!m-0 !text-[11px]">
                    {{ skillName(s) }}
                  </a-tag>
                  <span v-if="!p.skillIds?.length" class="text-[11px] text-[var(--wb-text-3)]"
                    >—</span
                  >
                  <button
                    v-if="!p.builtin"
                    class="text-[11px] text-[var(--wb-accent)] hover:underline ml-1"
                    @click="openEditBindings(p)"
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

      <!-- 捆绑编辑弹层（模板 + 技能） -->
      <a-modal
        :open="bindingsOpen"
        :title="`${t('workbenchPresetEditSkills')} — ${editingPreset?.name?.[lang] || editingPreset?.id || ''}`"
        :ok-text="t('confirm')"
        :cancel-text="t('cancel')"
        :ok-button-props="{ loading: savingBindings }"
        @ok="saveBindings"
        @cancel="bindingsOpen = false"
      >
        <!-- 模板组 -->
        <div class="text-xs text-[var(--wb-text-2)] mb-1">{{ t('workbenchPresetTemplates') }}</div>
        <div v-if="templateList.length === 0" class="text-xs text-[var(--wb-text-3)] py-2">
          {{ t('workbenchTemplatesEmptyLib') }}
        </div>
        <div v-else class="space-y-1 max-h-40 overflow-y-auto mb-3">
          <label
            v-for="s in templateList"
            :key="s.id"
            class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--wb-surface-hover)] cursor-pointer"
          >
            <input type="checkbox" :value="s.id" v-model="checkedTemplates" class="wb-tech-check" />
            <span class="text-sm text-white">{{ s.name }}</span>
            <span class="text-[11px] text-[var(--wb-text-3)] font-mono">/{{ s.id }}</span>
            <span class="text-[11px] text-[var(--wb-text-2)] truncate ml-auto">{{
              s.description
            }}</span>
          </label>
        </div>

        <!-- 技能组（按分类分组，可分组全选/全部勾选） -->
        <div class="flex items-center justify-between mb-1">
          <div class="text-xs text-[var(--wb-text-2)]">{{ t('workbenchPresetSkills') }}</div>
          <div v-if="skillsList.length" class="flex gap-2">
            <button
              class="text-[11px] text-[var(--wb-accent)] hover:underline"
              @click="selectAllSkills"
            >
              {{ t('workbenchSkillSelectAll') }}
            </button>
            <button
              class="text-[11px] text-[var(--wb-text-2)] hover:underline"
              @click="checkedSkills = []"
            >
              {{ t('workbenchSkillClearAll') }}
            </button>
          </div>
        </div>
        <div v-if="skillsList.length === 0" class="text-xs text-[var(--wb-text-3)] py-2">
          {{ t('workbenchSkillsEmptyLib') }}
        </div>
        <div v-else class="max-h-56 overflow-y-auto space-y-2">
          <div v-for="g in groupedSkills" :key="g.id">
            <div
              class="flex items-center justify-between px-2 py-1 sticky top-0 z-10"
              style="background: var(--wb-surface)"
            >
              <span class="text-[11px] text-[var(--wb-text-3)] font-medium"
                >{{ g.label }} ({{ g.skills.length }})</span
              >
              <button
                class="text-[11px] text-[var(--wb-accent)] hover:underline"
                @click="toggleGroup(g)"
              >
                {{ groupAllOn(g) ? t('workbenchSkillGroupNone') : t('workbenchSkillGroupAll') }}
              </button>
            </div>
            <label
              v-for="s in g.skills"
              :key="s.name"
              class="flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--wb-surface-hover)] cursor-pointer"
            >
              <input
                type="checkbox"
                :value="s.name"
                v-model="checkedSkills"
                class="wb-tech-check"
              />
              <span class="text-sm text-white font-mono">{{ s.name }}</span>
              <span v-if="!s.valid" class="text-[10px] text-red-400">{{
                t('workbenchSkillInvalid')
              }}</span>
              <span class="text-[11px] text-[var(--wb-text-2)] truncate ml-auto">{{
                s.description
              }}</span>
            </label>
          </div>
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
          <a-form-item :label="t('workbenchPresetTemplates')">
            <div
              class="max-h-32 overflow-y-auto space-y-1.5 p-2 rounded-lg border border-[var(--wb-stroke)]"
            >
              <label
                v-for="tk in templateList"
                :key="tk.id"
                class="flex items-center gap-2 text-sm text-[var(--wb-text-2)] cursor-pointer"
              >
                <input
                  v-model="copyTemplates"
                  type="checkbox"
                  :value="tk.id"
                  class="wb-tech-check"
                />
                <span class="truncate">{{ tk.name }}</span>
              </label>
              <div v-if="!templateList.length" class="text-xs text-[var(--wb-text-3)]">
                {{ t('workbenchTemplatesEmptyLib') }}
              </div>
            </div>
          </a-form-item>
          <a-form-item :label="t('workbenchPresetSkills')">
            <div class="flex gap-2 mb-1">
              <button
                class="text-[11px] text-[var(--wb-accent)] hover:underline"
                @click="copySkills = skillsList.map((s) => s.name)"
              >
                {{ t('workbenchSkillSelectAll') }}
              </button>
              <button
                class="text-[11px] text-[var(--wb-text-2)] hover:underline"
                @click="copySkills = []"
              >
                {{ t('workbenchSkillClearAll') }}
              </button>
            </div>
            <div
              class="max-h-40 overflow-y-auto space-y-2 p-2 rounded-lg border border-[var(--wb-stroke)]"
            >
              <div v-for="g in groupedSkills" :key="g.id">
                <div class="text-[11px] text-[var(--wb-text-3)] font-medium px-1 py-0.5">
                  {{ g.label }} ({{ g.skills.length }})
                </div>
                <label
                  v-for="sk in g.skills"
                  :key="sk.name"
                  class="flex items-center gap-2 text-sm text-[var(--wb-text-2)] cursor-pointer px-1"
                >
                  <input
                    v-model="copySkills"
                    type="checkbox"
                    :value="sk.name"
                    class="wb-tech-check"
                  />
                  <span class="truncate font-mono">{{ sk.name }}</span>
                </label>
              </div>
              <div v-if="!skillsList.length" class="text-xs text-[var(--wb-text-3)]">
                {{ t('workbenchNoSkillsYet') }}
              </div>
            </div>
            <div class="text-[11px] text-[var(--wb-text-3)] mt-1">
              {{ t('workbenchCopySkillsHint') }}
            </div>
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

// ---------- 预设捆绑编辑（模板=可执行推荐池 / 技能=SKILL.md 知识技能） ----------
const bindingsOpen = ref(false)
const editingPreset = ref(null)
const checkedTemplates = ref([])
const checkedSkills = ref([])
const savingBindings = ref(false)
const templateList = ref([])
const skillsList = ref([])

async function loadTemplateList() {
  const res = await fetch(`${origin.value}/api/workbench/templates`)
  const json = await res.json()
  templateList.value = json?.data ?? []
}

async function loadSkillsList() {
  const res = await fetch(`${origin.value}/api/workbench/skills`)
  const json = await res.json()
  skillsList.value = json?.data ?? []
}

function templateName(id) {
  return templateList.value.find((s) => s.id === id)?.name || id
}

function skillName(id) {
  return skillsList.value.find((s) => s.name === id)?.name || id
}

// ---------- 技能分类分组（catalog.json 的 category id，固定序） ----------
const CATEGORY_ORDER = ['core', 'image', 'prompt', 'video', 'creative', 'training', 'ops', 'other']

function categoryLabel(id) {
  const key = `workbenchSkillCat${String(id || 'other')
    .charAt(0)
    .toUpperCase()}${String(id).slice(1)}`
  const label = t(key)
  return label === key ? t('workbenchSkillCatOther') : label
}

const groupedSkills = computed(() => {
  const groups = new Map()
  for (const s of skillsList.value) {
    const cat = s.category || 'other'
    if (!groups.has(cat)) groups.set(cat, [])
    groups.get(cat).push(s)
  }
  return CATEGORY_ORDER.filter((c) => groups.has(c)).map((c) => ({
    id: c,
    label: categoryLabel(c),
    skills: groups.get(c),
  }))
})

function groupAllOn(g) {
  return g.skills.every((s) => checkedSkills.value.includes(s.name))
}

function toggleGroup(g) {
  const names = g.skills.map((s) => s.name)
  const allOn = names.every((n) => checkedSkills.value.includes(n))
  checkedSkills.value = allOn
    ? checkedSkills.value.filter((n) => !names.includes(n))
    : [...new Set([...checkedSkills.value, ...names])]
}

function selectAllSkills() {
  checkedSkills.value = skillsList.value.map((s) => s.name)
}

async function openEditBindings(p) {
  editingPreset.value = p
  checkedTemplates.value = [...(p.templateIds ?? [])]
  checkedSkills.value = [...(p.skillIds ?? [])]
  await Promise.all([
    templateList.value.length === 0 ? loadTemplateList() : Promise.resolve(),
    skillsList.value.length === 0 ? loadSkillsList() : Promise.resolve(),
  ])
  bindingsOpen.value = true
}

async function saveBindings() {
  savingBindings.value = true
  try {
    const res = await fetch(`${origin.value}/api/workbench/presets/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editingPreset.value.id, templateIds: checkedTemplates.value }),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'save failed')
    const res2 = await fetch(`${origin.value}/api/workbench/presets/skills`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: editingPreset.value.id, skillIds: checkedSkills.value }),
    })
    const json2 = await res2.json()
    if (!res2.ok || !json2?.success) throw new Error(json2?.message || 'save failed')
    bindingsOpen.value = false
    message.success(t('workbenchSaved'))
    emit('changed')
  } catch (e) {
    message.error(e.message)
  } finally {
    savingBindings.value = false
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
    // 一步到位:勾了模板/技能就写入新预设(与编辑绑定同一组端点)
    await fetch(`${origin.value}/api/workbench/presets/templates`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: copyId.value, templateIds: copyTemplates.value }),
    })
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

<style scoped>
.pm-sel {
  border-color: var(--wb-accent) !important;
}
</style>
