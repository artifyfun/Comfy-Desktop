<template>
  <div
    class="composer relative"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div
      v-if="dragOver"
      class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-slate-900/90 border-2 border-dashed border-tech-blue rounded-2xl"
    >
      <i class="fas fa-cloud-arrow-up text-3xl text-tech-blue mb-2"></i>
      <div class="text-sm text-slate-200">{{ t('workbenchDropHint') }}</div>
    </div>

    <!-- dsh composer 布局：圆角卡片，textarea 全宽在上，工具条在底 -->
    <div class="rounded-2xl border border-slate-600 bg-slate-800 px-4 pt-3 pb-2 shadow-lg">
      <!-- 附件行（缩略图在上） -->
      <AttachmentRail
        v-if="attachments.length"
        :attachments="attachments"
        @remove="(i) => $emit('remove-attachment', i)"
      />

      <!-- 输入区：全宽 textarea，自适应长高 -->
      <textarea
        ref="textareaEl"
        v-model="draft"
        :placeholder="t('workbenchInputPlaceholder')"
        :disabled="busy"
        class="w-full bg-transparent border-none outline-none resize-none text-[14px] leading-[22px] text-white placeholder-slate-500 max-h-40 min-h-[66px] py-1"
        @input="autoResize"
        @keydown.enter.exact.prevent="onEnter"
        @keydown="onKeydown"
      ></textarea>

      <!-- 技能菜单（浮层锚在卡片上方） -->
      <SkillMenu
        :open="slashOpen"
        :items="filteredSkills"
        :active-index="activeIndex"
        @pick="onSkillPick"
        @active="(i) => (activeIndex = i)"
      />

      <!-- 底部工具条：左（附件/模型）右（发送） -->
      <div class="flex items-center gap-1 min-h-[32px] mt-1">
        <button
          class="w-8 h-8 rounded-full text-slate-400 hover:text-white hover:bg-slate-700 flex items-center justify-center transition"
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
        <div class="flex-1"></div>
        <span v-if="slashOpen" class="text-[11px] text-slate-500 mr-2 hidden sm:inline">
          ↑↓ {{ t('workbenchNavigate') }} · Tab/{{ t('confirm') }} · Esc
        </span>
        <button
          class="w-8 h-8 rounded-full flex items-center justify-center transition disabled:opacity-40"
          :class="
            canSend ? 'bg-tech-blue text-white hover:brightness-110' : 'bg-slate-700 text-slate-400'
          "
          :disabled="!canSend"
          :title="t('workbenchSend')"
          @click="$emit('send')"
        >
          <i class="fas fa-arrow-up"></i>
        </button>
      </div>
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

const canSend = computed(
  () =>
    !props.busy &&
    !props.uploading &&
    (draft.value.trim() !== '' || props.attachments.some((a) => !a.uploading)),
)

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
  el.style.height = Math.min(el.scrollHeight, 160) + 'px'
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
