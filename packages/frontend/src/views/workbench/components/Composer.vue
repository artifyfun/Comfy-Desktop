<template>
  <div
    class="composer border-t border-slate-700 p-3 relative"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div
      v-if="dragOver"
      class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-slate-900/90 border-2 border-dashed border-tech-blue rounded-lg"
    >
      <i class="fas fa-cloud-arrow-up text-3xl text-tech-blue mb-2"></i>
      <div class="text-sm text-slate-200">{{ t('workbenchDropHint') }}</div>
    </div>

    <AttachmentRail
      v-if="attachments.length"
      :attachments="attachments"
      @remove="(i) => $emit('remove-attachment', i)"
    />

    <SkillMenu
      :open="slashOpen"
      :items="filteredSkills"
      :active-index="activeIndex"
      @pick="onSkillPick"
      @active="(i) => (activeIndex = i)"
    />

    <div class="flex gap-2 items-end">
      <button
        class="px-2 py-1 text-sm text-slate-300 hover:text-white rounded transition"
        :title="t('workbenchUpload')"
        :disabled="uploading"
        @click="pickFile"
      >
        <i class="fas fa-paperclip" :class="{ 'animate-pulse': uploading }"></i>
      </button>
      <ModelMenu
        :override="modelOverride"
        @update:override="(v) => $emit('update:modelOverride', v)"
      />
      <textarea
        ref="textareaEl"
        v-model="draft"
        :placeholder="t('workbenchInputPlaceholder')"
        :disabled="busy"
        rows="1"
        class="flex-1 resize-none rounded-lg bg-slate-800 border border-slate-600 px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-tech-blue max-h-32"
        @input="autoResize"
        @keydown.enter.exact.prevent="onEnter"
        @keydown="onKeydown"
      ></textarea>
      <a-button type="primary" :loading="busy" @click="$emit('send')">
        <i class="fas fa-paper-plane"></i>
      </a-button>
    </div>

    <input
      ref="fileEl"
      type="file"
      multiple
      accept="image/*,video/*,audio/*"
      class="hidden"
      @change="onFileChange"
    />
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { useI18n } from '@/utils/i18n'
import AttachmentRail from './AttachmentRail.vue'
import ModelMenu from './ModelMenu.vue'
import SkillMenu from './SkillMenu.vue'

const props = defineProps({
  busy: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  attachments: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  modelOverride: { type: Object, default: null },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits([
  'update:modelValue',
  'send',
  'upload-files',
  'remove-attachment',
  'update:modelOverride',
])

const { t } = useI18n()
const draft = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
})
const dragOver = ref(false)
const fileEl = ref(null)
const textareaEl = ref(null)
const slashOpen = ref(false)
const slashQuery = ref('')
const activeIndex = ref(0)

// 本地过滤（键盘导航在 Composer 统一处理，SkillMenu 纯展示）
const filteredSkills = computed(() => {
  const q = slashQuery.value.toLowerCase()
  if (!q) return props.skills
  return props.skills.filter(
    (s) => s.id.toLowerCase().includes(q) || s.name.toLowerCase().includes(q),
  )
})

// "/" 触发：光标前文本以 / 开头（词首）时弹技能菜单
watch(
  () => props.modelValue,
  (v) => {
    const el = textareaEl.value
    if (!el) {
      slashOpen.value = false
      return
    }
    const pos = el.selectionStart ?? v.length
    const before = v.slice(0, pos)
    const m = before.match(/(?:^|\s)\/([a-zA-Z0-9_:-]*)$/)
    slashOpen.value = !!m
    slashQuery.value = m?.[1] ?? ''
    activeIndex.value = 0
  },
)

function autoResize(e) {
  const el = e.target
  el.style.height = 'auto'
  el.style.height = Math.min(el.scrollHeight, 128) + 'px'
}

function onEnter() {
  if (slashOpen.value && filteredSkills.value.length) {
    onSkillPick(filteredSkills.value[activeIndex.value])
  } else if (!slashOpen.value) {
    emit('send')
  }
}

function onKeydown(e) {
  if (!slashOpen.value) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = Math.min(activeIndex.value + 1, filteredSkills.value.length - 1)
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = Math.max(activeIndex.value - 1, 0)
  } else if (e.key === 'Tab') {
    e.preventDefault()
    if (filteredSkills.value.length) onSkillPick(filteredSkills.value[activeIndex.value])
  } else if (e.key === 'Escape') {
    slashOpen.value = false
  }
}

function onSkillPick(skill) {
  // dsh 语义：pick 落字面 /name 到输入框（token 与手输等价，后端 gesture 识别）
  const v = props.modelValue.replace(/(?:^|\s)\/([a-zA-Z0-9_:-]*)$/, '')
  emit('update:modelValue', `${v} /${skill.id} `.replace(/^\s+/, ''))
  slashOpen.value = false
  textareaEl.value?.focus()
}

function pickFile() {
  fileEl.value?.click()
}

function onFileChange(e) {
  const files = [...e.target.files]
  if (files.length) emit('upload-files', files)
  e.target.value = ''
}

function onDrop(e) {
  dragOver.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) emit('upload-files', files)
}
</script>
