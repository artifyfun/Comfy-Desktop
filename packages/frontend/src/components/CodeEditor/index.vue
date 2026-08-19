<template>
  <div class="code-editor">
    <div ref="editorContainerRef" class="editor-container"></div>
  </div>
</template>

<script setup>
import { useDebounceFn } from '@vueuse/core'
import { ref, toRaw, onMounted, onBeforeUnmount, watch } from 'vue'

// 按需加载 monaco：只引入核心 editor.api + 用到的语言 contribution，
// 不再走 vite-plugin-monaco-editor（避免全量打包 ~170MB 的 monaco 及全部 worker）。
const MONACO_EDITOR_API = 'monaco-editor/esm/vs/editor/editor.api'

const emit = defineEmits(['change'])

const props = defineProps({
  value: {
    type: String,
  },
  language: {
    type: String,
    default: 'html',
  },
  readOnly: {
    type: Boolean,
    default: false,
  },
})
const editorContainerRef = ref(null)
const editor = ref(null)

// 只加载项目实际使用的语言，避免引入其余语言的 tokenizer/worker
// 注意：monaco 的 json 是内置语言（不在 basic-languages），无需引入
async function loadLanguageContribution(lang) {
  switch (lang) {
    case 'markdown':
      await import('monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js')
      break
    case 'javascript':
    case 'typescript':
      await import('monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js')
      break
    case 'css':
      await import('monaco-editor/esm/vs/basic-languages/css/css.contribution.js')
      break
    case 'html':
    default:
      await import('monaco-editor/esm/vs/basic-languages/html/html.contribution.js')
  }
}

onMounted(async () => {
  // 配置 editor worker（语法高亮等后台任务），只挂一个 editor worker 即可
  const editorWorker = (await import('monaco-editor/esm/vs/editor/editor.worker?worker')).default
  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  }

  // 核心编辑器 API（不含语言服务）
  const monaco = await import(MONACO_EDITOR_API)
  await loadLanguageContribution(props.language)

  editor.value = monaco.editor.create(editorContainerRef.value, {
    value: props.value,
    readOnly: props.readOnly,
    language: props.language,
    theme: 'vs-dark',
    selectOnLineNumbers: true,
    automaticLayout: true,
    renderSideBySide: false,
  })

  editor.value.onDidChangeModelContent(() => {
    emit('change', getEditorValue())
  })
})

// 监听 value 属性变化
watch(
  () => props.value,
  (newValue) => {
    if (editor.value && newValue !== getEditorValue()) {
      setEditorValue(newValue)
      if (props.readOnly) {
        scrollToBottom()
      }
    }
  },
)

function getEditorValue() {
  return toRaw(editor.value).getValue()
}

const debounceSetValue = useDebounceFn(setEditorValue, 500)

function setEditorValue(code) {
  toRaw(editor.value).setValue(code)
}

function scrollToBottom() {
  toRaw(editor.value).revealLine(toRaw(editor.value).getModel()?.getLineCount() ?? 0)
}

defineExpose({
  getEditorValue,
  setEditorValue,
  debounceSetValue,
  scrollToBottom,
})

onBeforeUnmount(() => {
  if (editor.value) {
    toRaw(editor.value).dispose()
  }
})
</script>

<style lang="less" scoped>
.code-editor {
  width: 100%;
  height: 100%;
}
.editor-container {
  width: 100%;
  height: 100%;
}
</style>
