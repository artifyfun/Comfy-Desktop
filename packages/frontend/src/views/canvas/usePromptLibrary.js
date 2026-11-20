/**
 * 画布提示词库（S6b composable）——canvas/index.vue 深拆（第四批③）。
 *
 * 内置分词 + 自定义（localStorage）+ JSON 导入 + 选中词条回填目标
 * （note 就地编辑 / 改写指令 / 生图对话框，按当前激活输入推导；
 * 无目标时复制到剪贴板兜底）。依赖经 deps 注入。
 */
import { ref, reactive, computed } from 'vue'
import { message } from 'ant-design-vue'
import {
  builtinLibrary,
  loadCustomPrompts,
  saveCustomPrompts,
  parseImportedPrompts,
  mergePrompts,
  searchPrompts,
} from './promptLibrary'

/**
 * @param deps { t, objects, selection, hoverNodeId, genNode, noteRewrite,
 *               noteEdit, beforeChange, saveSoon }
 */
export function usePromptLibrary(deps) {
  const { t, objects, selection, hoverNodeId, genNode, noteRewrite, noteEdit } = deps

  const promptLib = reactive({ open: false, q: '', tab: 'builtin' }) // tab: builtin | custom
  const customPrompts = ref([])
  try {
    customPrompts.value = loadCustomPrompts(localStorage)
  } catch {
    customPrompts.value = []
  }

  const promptLibView = computed(() => {
    if (promptLib.tab === 'custom') {
      return searchPrompts(
        [{ category: t('canvasPromptCustomTab'), items: customPrompts.value }],
        promptLib.q,
      )
    }
    return searchPrompts(builtinLibrary(), promptLib.q)
  })

  /** 回填目标推导：生图对话框开着优先，其次改写输入条，再次选中/悬停的 note */
  const promptTarget = computed(() => {
    if (genNode.value) return { kind: 'gen', id: null }
    if (noteRewrite.noteId) return { kind: 'rewrite', id: noteRewrite.noteId }
    const selNote = objects.value.find((o) => o.id === selection.value[0] && o.type === 'note')
    if (selNote) return { kind: 'note', id: selNote.id }
    const hovNote = objects.value.find((o) => o.id === hoverNodeId.value && o.type === 'note')
    if (hovNote) return { kind: 'note', id: hovNote.id }
    return null
  })

  /** 选中词条 → 回填目标（note 编辑/改写指令，按当前激活输入） */
  function applyPrompt(text) {
    const target = promptTarget.value
    if (target?.kind === 'note') {
      const o = objects.value.find((x) => x.id === target.id)
      if (o) {
        deps.beforeChange()
        o.text = o.text ? o.text + '\n' + text : text
        // 正在就地编辑同一便签时，把回填同步进编辑框（否则提交会覆盖掉刚插的词条）
        if (noteEdit.id === target.id) noteEdit.text = o.text
        deps.saveSoon()
      }
    } else if (target?.kind === 'rewrite') {
      noteRewrite.instruction = noteRewrite.instruction
        ? noteRewrite.instruction + '；' + text
        : text
    } else if (target?.kind === 'gen' && genNode.value) {
      genNode.value.prompt = genNode.value.prompt ? genNode.value.prompt + '\n' + text : text
    } else {
      // fix(静默无操作): 无回填目标时点击词条此前什么都不发生——改为复制到
      // 剪贴板 + toast，用户至少拿到词条内容（选中笔记/开生图对话框后回填）。
      try {
        navigator.clipboard.writeText(text)
        message.info(t('canvasPromptCopied'))
      } catch {
        /* 剪贴板不可用（权限/非安全上下文）——只关面板 */
      }
    }
    promptLib.open = false
  }

  function addCustomPrompt(text) {
    const trimmed = String(text || '').trim()
    if (!trimmed) return
    customPrompts.value = [{ text: trimmed, hint: '' }, ...customPrompts.value]
    saveCustomPrompts(customPrompts.value, localStorage)
  }

  function removeCustomPrompt(text) {
    customPrompts.value = customPrompts.value.filter((x) => x.text !== text)
    saveCustomPrompts(customPrompts.value, localStorage)
  }

  function importPromptsFile() {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      f.text()
        .then(parseImportedPrompts)
        .then((list) => {
          customPrompts.value = mergePrompts(list, customPrompts.value)
          saveCustomPrompts(customPrompts.value, localStorage)
          message.success(t('canvasPromptImported').replace('{n}', String(list.length)))
        })
        .catch((e) => message.error(t('canvasPromptImportFailed') + ': ' + (e?.message || '')))
    }
    input.click()
  }

  return {
    promptLib,
    customPrompts,
    promptLibView,
    promptTarget,
    applyPrompt,
    addCustomPrompt,
    removeCustomPrompt,
    importPromptsFile,
  }
}
