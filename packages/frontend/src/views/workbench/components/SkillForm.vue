<template>
  <a-modal
    :open="open"
    :title="title"
    width="820px"
    :footer="null"
    :mask-closable="false"
    @cancel="close"
  >
    <div class="space-y-3">
      <!-- 名称行 + 从模板开始 -->
      <div class="flex items-end gap-2">
        <a-form-item class="flex-1 !mb-0" required>
          <template #label>
            <span class="text-xs">name</span>
            <span class="text-[11px] text-[var(--wb-text-3)] ml-2">
              {{ t('workbenchSkillNameRule') }}
            </span>
          </template>
          <a-input
            v-model:value="form.name"
            class="wb-tech-input font-mono"
            :disabled="readonly || isBuiltin"
            placeholder="my-skill"
          />
        </a-form-item>
        <a-dropdown v-if="!readonly && !isBuiltin" :trigger="['click']">
          <a-button class="mb-0.5">
            {{ t('workbenchSkillStartFrom') }}
            <i class="fas fa-angle-down ml-1"></i>
          </a-button>
          <template #overlay>
            <a-menu @click="({ key }) => applySkeleton(key)">
              <a-menu-item key="scratch">{{ t('workbenchSkillFromScratch') }}</a-menu-item>
              <a-menu-divider />
              <a-menu-item key="prompt">{{ t('workbenchSkillTplPrompt') }}</a-menu-item>
              <a-menu-item key="sop">{{ t('workbenchSkillTplSop') }}</a-menu-item>
              <a-menu-item key="review">{{ t('workbenchSkillTplReview') }}</a-menu-item>
              <a-menu-item key="writing">{{ t('workbenchSkillTplWriting') }}</a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>

      <!-- 描述 -->
      <a-form-item class="!mb-0">
        <template #label>
          <span class="text-xs">description</span>
          <span class="text-[11px] text-[var(--wb-text-3)] ml-2">
            {{ t('workbenchSkillDescTip') }}
          </span>
        </template>
        <a-textarea
          v-model:value="form.description"
          :rows="2"
          :disabled="readonly || isBuiltin"
          class="wb-tech-input"
        />
      </a-form-item>

      <!-- 正文 -->
      <div>
        <div class="text-xs mb-1">{{ t('workbenchSkillBody') }}</div>
        <MdPreview
          v-if="readonly"
          :model-value="form.body"
          theme="dark"
          preview-theme="github"
          code-theme="github"
          class="rounded-lg overflow-hidden"
        />
        <MdEditor
          v-else
          v-model="form.body"
          theme="dark"
          preview-theme="github"
          code-theme="github"
          :toolbars="toolbars"
          :footers="[]"
          class="!h-[380px] rounded-lg overflow-hidden"
        />
      </div>

      <!-- 底部按钮 -->
      <div v-if="!readonly" class="flex justify-end gap-2 pt-1">
        <a-button @click="close">{{ t('cancel') }}</a-button>
        <a-button type="primary" :loading="saving" @click="save">{{ t('confirm') }}</a-button>
      </div>
    </div>
  </a-modal>
</template>

<script setup>
import { ref, computed, watch } from 'vue'
import { message } from 'ant-design-vue'
import { MdEditor, MdPreview } from 'md-editor-v3'
import 'md-editor-v3/lib/style.css'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'

const props = defineProps({
  open: { type: Boolean, default: false },
  /** 技能列表项（null=新建） */
  skill: { type: Object, default: null },
  readonly: { type: Boolean, default: false },
})
const emit = defineEmits(['update:open', 'saved'])

const { t } = useI18n()
const appStore = useAppStore()
const origin = computed(() => appStore.config?.serverHost || window.location.origin)

const form = ref({ name: '', description: '', body: '' })
const saving = ref(false)

const isBuiltin = computed(() => !!props.skill?.builtin)
const title = computed(() => {
  if (props.readonly) return `${t('workbenchSkillView')} — ${props.skill?.name || ''}`
  return props.skill ? `${t('workbenchSkillEdit')} — ${props.skill.name}` : t('workbenchSkillNew')
})

// 打开时以技能内容初始化（编辑/查看需先拉全文；新建给骨架占位）
watch(
  () => props.open,
  async (v) => {
    if (!v) return
    if (props.skill) {
      const res = await fetch(
        `${origin.value}/api/workbench/skills/read?name=${encodeURIComponent(props.skill.name)}`
      )
      const json = await res.json()
      form.value = {
        name: json?.data?.name ?? props.skill.name,
        description: json?.data?.description ?? '',
        body: json?.data?.body ?? '',
      }
    } else {
      form.value = { name: '', description: '', body: '' }
    }
  }
)

const toolbars = [
  'bold',
  'italic',
  'strikeThrough',
  '-',
  'title',
  'quote',
  'unorderedList',
  'orderedList',
  '-',
  'code',
  'codeRow',
  'table',
  '-',
  'preview',
]

// ---------- 骨架模板（避免面对空白页） ----------
const SKELETONS = {
  prompt: `## 目标
规定生成图像提示词时的结构与措辞偏好。

## 结构约定
1. 主体先行：人物/物体 → 动作/神态 → 环境 → 镜头 → 风格
2. 每段不超过 25 词，用逗号分隔
3. 明确禁止的元素写在最后一段，加 no 前缀

## 措辞偏好
- 用具体名词代替抽象形容（"冲压金属质感" 优于 "高级感"）
- 镜头语言使用摄影术语（85mm, shallow DOF, rim light）`,
  sop: `## 适用场景
（何时使用本技能）

## 步骤
1. 前置检查：确认输入素材与参数齐全
2. 执行：按序调用工具，失败先重试一次再报告
3. 收尾：核对产物数量与命名规范

## 红线
- 不得跳过校验步骤
- 不得覆盖已有产物`,
  review: `## 审查清单
- [ ] 命名与目录结构符合约定
- [ ] 无未处理的错误分支
- [ ] 边界条件：空输入 / 超大输入 / 并发

## 输出格式
按 严重(P0/P1/P2) 分级列出问题，每条给出文件与行号。`,
  writing: `## 语气
专业、克制、不堆砌形容词。

## 结构
- 结论先行，理由随后
- 每段只讲一件事，段首给主题句

## 禁止
- 空洞的修饰语（"非常"、"极其"）
- 未解释的专业缩写`,
}

function applySkeleton(key) {
  if (key === 'scratch') return
  form.value.body = SKELETONS[key] ?? ''
}

async function save() {
  const name = form.value.name.trim()
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(name)) {
    message.warning(t('workbenchSkillNameRule'))
    return
  }
  saving.value = true
  try {
    const renamed = props.skill && name !== props.skill.name
    const res = await fetch(`${origin.value}/api/workbench/skills/${props.skill ? 'update' : 'create'}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        props.skill
          ? { name: props.skill.name, newName: renamed ? name : undefined, description: form.value.description, body: form.value.body }
          : { name, description: form.value.description, body: form.value.body }
      ),
    })
    const json = await res.json()
    if (!res.ok || !json?.success) throw new Error(json?.message || 'save failed')
    message.success(t('workbenchSaved'))
    emit('saved', {
      renamedTo: json?.data?.renamedTo,
      presetsFixed: json?.data?.presetsFixed ?? 0,
    })
  } catch (e) {
    message.error(e.message)
  } finally {
    saving.value = false
  }
}

function close() {
  emit('update:open', false)
}
</script>
