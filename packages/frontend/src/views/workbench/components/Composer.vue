<template>
  <div
    class="composer relative"
    @dragover.prevent="dragOver = true"
    @dragleave="dragOver = false"
    @drop.prevent="onDrop"
  >
    <div
      v-if="dragOver"
      class="absolute inset-0 z-40 flex flex-col items-center justify-center bg-[var(--wb-bg-base)]/95 border-2 border-dashed border-[var(--wb-accent)]"
    >
      <i class="fas fa-cloud-arrow-up text-3xl text-[var(--wb-accent)] mb-2"></i>
      <div class="text-sm text-slate-200">{{ t('workbenchDropHint') }}</div>
    </div>

    <!-- dsh composer 布局：圆角卡片，textarea 全宽在上，工具条在底 -->
    <!-- 圆角与中间面板 rounded-xl 一致，内层按 3px 内收对齐 border 重叠 -->
    <div
      class="border border-[var(--wb-stroke)] bg-[var(--wb-surface-deep)] px-4 pt-3 pb-2"
      style="border-radius: var(--wb-r-card)"
    >
      <!-- 附件行（缩略图在上） -->
      <AttachmentRail
        v-if="attachments.length"
        :attachments="attachments"
        @remove="(i) => $emit('remove-attachment', i)"
      />

      <!-- 输入区：全宽 textarea，自适应长高（busy 仅锁发送位为停止位，不打断输入） -->
      <textarea
        ref="textareaEl"
        v-model="draft"
        :placeholder="t('workbenchInputPlaceholder')"
        :disabled="uploading && !busy"
        class="w-full bg-transparent border-none outline-none resize-none text-[14px] leading-[22px] text-white placeholder-slate-500 max-h-40 min-h-[66px] py-1"
        @input="autoResize"
        @keydown.enter.exact="onEnterKey"
        @keydown="onKeydown"
        @compositionstart="composing = true"
        @compositionend="composing = false"
        @paste="onPaste"
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
        <!-- 附件单入口:下拉选「上传实体 / 引用本地路径」,不再并排两个按钮 -->
        <a-dropdown :trigger="['click']">
          <button
            class="w-8 h-8 rounded-full text-[var(--wb-text-2)] hover:text-white hover:bg-[var(--wb-surface-hover)] flex items-center justify-center transition"
            :title="t('workbenchAttach')"
            :disabled="uploading"
            @click.prevent
          >
            <i class="fas fa-paperclip" :class="{ 'animate-pulse': uploading }"></i>
          </button>
          <template #overlay>
            <a-menu @click="onAttachMenu">
              <a-menu-item key="upload">
                <span class="flex flex-col">
                  <span class="flex items-center gap-2">
                    <i class="fas fa-cloud-arrow-up w-4"></i>{{ t('workbenchUpload') }}
                  </span>
                  <span class="text-[11px] text-[var(--wb-text-3)]">{{
                    t('workbenchUploadHint')
                  }}</span>
                </span>
              </a-menu-item>
              <a-menu-item v-if="isElectron" key="reference">
                <span class="flex flex-col">
                  <span class="flex items-center gap-2">
                    <i class="fas fa-link w-4"></i>{{ t('workbenchReferenceLocal') }}
                  </span>
                  <span class="text-[11px] text-[var(--wb-text-3)]">{{
                    t('workbenchReferenceHint')
                  }}</span>
                </span>
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
        <ModelMenu
          :override="modelOverride"
          @update:override="(v) => $emit('update:modelOverride', v)"
        />
        <div class="flex-1 min-w-0"></div>
        <span v-if="slashOpen" class="text-[11px] text-[var(--wb-text-3)] mr-2 hidden sm:inline">
          ↑↓ {{ t('workbenchNavigate') }} · Tab/{{ t('confirm') }} · Esc
        </span>
        <!-- busy 时发送位变停止位（dsh 语义）：icon 在 ▲/■ 间切换，宽度不变不跳动 -->
        <button
          class="w-8 h-8 rounded-full flex items-center justify-center transition"
          :class="
            busy
              ? 'bg-[var(--wb-surface-hover)] text-white hover:bg-red-500/80'
              : canSend
                ? 'bg-[var(--wb-accent)] text-white hover:brightness-110'
                : 'bg-[var(--wb-surface-hover)] text-[var(--wb-text-2)]'
          "
          :disabled="busy ? stopping : !canSend"
          :title="busy ? t('workbenchStop') : t('workbenchSend')"
          @click="busy ? $emit('stop') : $emit('send')"
        >
          <i :class="busy ? 'fas fa-stop text-[11px]' : 'fas fa-arrow-up'"></i>
        </button>
      </div>
    </div>

    <input
      ref="fileEl"
      type="file"
      multiple
      accept="image/*,video/*,audio/*,.pdf,.txt,.md,.json"
      class="hidden"
      @change="onFileChange"
    />
  </div>
</template>

<script setup>
import { isElectron } from '@/utils'
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from '@/utils/i18n'
import AttachmentRail from './AttachmentRail.vue'
import ModelMenu from './ModelMenu.vue'
import SkillMenu from './SkillMenu.vue'

const props = defineProps({
  busy: { type: Boolean, default: false },
  stopping: { type: Boolean, default: false },
  uploading: { type: Boolean, default: false },
  attachments: { type: Array, default: () => [] },
  skills: { type: Array, default: () => [] },
  modelOverride: { type: Object, default: null },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits([
  'update:modelValue',
  'send',
  'stop',
  'upload-files',
  'reference-files',
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
const composing = ref(false) // A3:IME 合成状态(compositionstart/end 翻转,防选词回车误发)
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

function onEnterKey(e) {
  // A3(吸收参考项目 IME 守卫):中文/日文输入法选词或合成中的回车不是"发送"意图,
  // 放行默认行为(确认候选/换行);仅合成结束后的裸回车才发。不带 .prevent 修饰符,
  // 由这里按需 prevent——否则合成中回车被拦截会卡死输入法候选。
  if (composing.value || e.isComposing) return
  e.preventDefault()
  onEnter()
}

function onEnter() {
  if (slashOpen.value && filteredSkills.value.length) {
    onSkillPick(filteredSkills.value[activeIndex.value])
  } else if (props.busy) {
    // 执行中 Enter = 停止（与按钮一致）
    emit('stop')
  } else {
    emit('send')
  }
}

function onKeydown(e) {
  // IME 合成中方向键/Tab 是输入法候选导航,不接管(避免与技能菜单导航打架)
  if (composing.value || e.isComposing) return
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
  // 单选替换（dsh 语义）：移除已有任意 /token（全文），落唯一 /name，
  // 保留用户其余文本；光标落在 token 后继续输入
  const cleaned = props.modelValue.replace(/(?:^|\s)\/[a-zA-Z0-9_:-]+/g, '')
  emit(
    'update:modelValue',
    `${cleaned.trim()} ${cleaned.trim() ? '' : ''}/${skill.id} `.trimStart(),
  )
  slashOpen.value = false
  nextTick(() => {
    const el = textareaEl.value
    if (el) {
      const pos = el.value.length
      el.focus()
      el.setSelectionRange(pos, pos)
    }
  })
}

function pickFile() {
  fileEl.value?.click()
}

function onAttachMenu({ key }) {
  if (key === 'upload') pickFile()
  else if (key === 'reference') pickReference()
}

// B 权限:引用本地文件(不复制,登记绝对路径;执行时按同机检测决定直通或回退上传)
async function pickReference() {
  try {
    const api = window.electronAPI?.ArtifyLab
    if (!api?.referenceLocalFile) return
    const r = await api.referenceLocalFile({
      filters: [
        {
          name: '媒体与文档',
          extensions: [
            'png',
            'jpg',
            'jpeg',
            'webp',
            'gif',
            'mp4',
            'webm',
            'mp3',
            'wav',
            'pdf',
            'txt',
            'md',
            'json',
          ],
        },
      ],
    })
    if (r?.ok && r.items?.length) emit('reference-files', r.items)
  } catch (e) {
    // 用户取消或 IPC 不可用:静默
  }
}

function onFileChange(e) {
  const files = [...e.target.files]
  if (files.length) emit('upload-files', files)
  e.target.value = ''
}

// A4(吸收参考项目粘贴图经验):剪贴板图片(截图/网页复制图)→ 附件,与拖放同通道。
// 纯文本粘贴不受影响(无 image item 时直接放行默认);粘贴图文混排时图转附件、
// 文本不抢插,避免 textarea 出现乱码/富文本残留。
function onPaste(e) {
  const cd = e.clipboardData
  const files = []
  const items = cd && cd.items
  if (items) {
    for (const it of items) {
      if (it.kind === 'file' && it.type && it.type.startsWith('image/')) {
        const f = it.getAsFile()
        if (f) files.push(f)
      }
    }
  }
  // 兜底通道:部分环境 items 只给 text/plain 而 files 有图
  if (!files.length && cd && cd.files && cd.files.length) {
    for (const f of cd.files) {
      if (f.type && f.type.startsWith('image/')) files.push(f)
    }
  }
  if (!files.length) return
  // 剪贴板截图常无文件名(File.name 只读,需重建):按 mime 补标准名,防上传链 filename 空
  for (let i = 0; i < files.length; i++) {
    if (!files[i].name) {
      const m = /image\/(\w+)/.exec(files[i].type || '')
      const ext = m && m[1] ? m[1].replace('jpeg', 'jpg') : 'png'
      files[i] = new File([files[i]], `paste-${Date.now()}-${i}.${ext}`, {
        type: files[i].type || 'image/png',
      })
    }
  }
  e.preventDefault()
  emit('upload-files', files)
}

function onDrop(e) {
  dragOver.value = false
  const files = [...(e.dataTransfer?.files ?? [])]
  if (files.length) emit('upload-files', files)
}
</script>
