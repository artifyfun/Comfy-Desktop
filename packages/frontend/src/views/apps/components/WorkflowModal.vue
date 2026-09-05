<template>
  <a-modal
    :open="show"
    @update:open="handleModalUpdate"
    :title="t('editWorkflow')"
    width="100%"
    wrap-class-name="full-modal workflow-modal"
    destroyOnClose
    :maskClosable="false"
    :okText="t('save')"
    @ok="handleSave"
    @cancel="handleCancel"
  >
    <div class="editor-box">
      <ComfyuiWorkflowEditor
        ref="editorRef"
        style="height: 800px"
        :template="template"
        :name="name"
        @onload="workflowLoading = false"
      />
    </div>
  </a-modal>
</template>

<script setup>
import { ref } from 'vue'
import { t } from '@/utils/i18n'
import { showError } from '@/utils'
import ComfyuiWorkflowEditor from '@/components/ComfyuiWorkflowEditor/index.vue'

const props = defineProps({
  show: {
    type: Boolean,
    default: false,
  },
  template: {
    type: Object,
    default: () => ({}),
  },
  name: {
    type: String,
    default: 'ArtifyLab Workflow',
  },
})

const emit = defineEmits(['update:show', 'save'])

const editorRef = ref(null)
const workflowLoading = ref(true)

const handleModalUpdate = (value) => {
  emit('update:show', value)
}

const handleCancel = () => {
  emit('update:show', false)
}

const handleSave = async () => {
  try {
    const { prompt = {}, paramsNodes = [], workflow } = await editorRef.value.getData()
    if (!paramsNodes.length) {
      return showError(t('pleaseAddParams'))
    }
    emit('save', { prompt, paramsNodes, workflow })
    emit('update:show', false)
  } catch (e) {
    showError(t('workflowSaveFailed', { error: e }))
  }
}
</script>

<style lang="less">
.full-modal {
  &.workflow-modal {
    .ant-modal-content {
      height: unset;
    }
  }
  .ant-modal {
    max-width: 100%;
    top: 0;
    padding-bottom: 0;
    margin: 0;
    width: 100%;
    height: 100%;
    & > div {
      width: 100%;
      height: 100%;
    }
  }
  .ant-modal-content {
    display: flex;
    flex-direction: column;
    min-height: calc(100vh);
    width: 100%;
    height: 100%;
    background: var(--wb-bg-base);
    border: 1px solid var(--wb-stroke);
    border-radius: var(--wb-r-modal);
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  }
  .ant-modal-header {
    background: transparent;
    border-bottom: 1px solid var(--wb-stroke);
    padding: 20px 24px;
  }
  .ant-modal-title {
    color: var(--wb-text);
    font-family: var(--wb-font);
    font-weight: 600;
  }
  .ant-modal-body {
    flex: 1;
    background: transparent;
    color: var(--wb-text);
    .editor-box {
      width: 100%;
      height: 100%;
      .preview-iframe {
        width: 100%;
        height: 100%;
        border: none;
        user-select: none;
      }
    }
  }
  .ant-modal-footer {
    background: transparent;
    border-top: 1px solid var(--wb-stroke);
    padding: 16px 24px;
  }
}
</style>
