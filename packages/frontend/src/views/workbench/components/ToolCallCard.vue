<!--
  ToolCallCard.vue — AG-UI 迁移 C11:通用工具调用卡(纯展示组件,集成后置)

  信息架构参照 waa TimelineToolGroup.vue(header:状态图标 + 工具名 + 预览 + 次数/时长,
  展开看 args/result),用本项目 tailwind + CSS 变量重写,不搬 element-ui 代码。

  契约(纯 props 驱动,组件不 import store/Pinia;数据由父级从 aguiSession store
  的 kind:'tool' 消息映射):
    name        String  必填,工具名。wb_* 原样展示;shell/file_change/web_search
                        友好化为中文标签(原始名保留在 title tooltip)。
    argsPreview String  折叠态 header 预览行(可选)。缺省时组件从 args 推导:
                        shell→command / web_search→query / file_change→paths,
                        否则取美化 JSON 首行截断。
    args        String|Object  原始参数(可选)。展开态 JSON 美化展示。
    result      String|Object  工具结果(可选)。超过 RESULT_TRUNCATE_LEN 截断 +
                        「展开全部」;展开后长文滚动。
    status      'running'|'done'|'error'  running→spinner / done→静默对勾 /
                        error→红色警示(缺省 running)。
    durationMs  Number  可选,done 态展示耗时(≥1000 显示秒)。
    toolCallId  String  可选,仅透传给扩展 slot,便于父级做 key/埋点。

  扩展点:
    #result  具名插槽,覆盖默认结果渲染(作用域:{ result, status })。
    default  默认插槽,追加在 detail 区域尾部,未来 HITL 等卡片扩展用。
-->
<template>
  <div
    data-testid="tool-call-card"
    class="tool-card rounded-md border bg-black/20 text-xs"
    :class="isError ? 'border-red-500/40' : 'border-[var(--wb-stroke)]'"
  >
    <!-- header:状态 + 图标 + 名称 + 预览 + 时长 + 折叠箭头 -->
    <header
      data-testid="tool-card-header"
      class="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none hover:bg-[var(--wb-surface-hover)] transition-colors"
      :aria-expanded="open"
      @click="toggle"
    >
      <!-- 三态视觉:running spinner(形状区分,色盲友好)/ error 红 / done 静默对勾 -->
      <span
        v-if="isRunning"
        data-testid="tool-card-status-running"
        class="tool-card__spinner shrink-0 inline-block w-3 h-3 rounded-full border border-[var(--wb-stroke-strong)] border-t-[var(--wb-accent)] animate-spin"
        aria-label="运行中"
      ></span>
      <i
        v-else-if="isError"
        data-testid="tool-card-status-error"
        class="fas fa-triangle-exclamation text-red-400 shrink-0"
        aria-label="失败"
      ></i>
      <i
        v-else
        data-testid="tool-card-status-done"
        class="fas fa-check text-emerald-400/70 shrink-0"
        aria-label="完成"
      ></i>

      <i :class="`fas ${toolMeta.icon} text-tech-cyan shrink-0`" aria-hidden="true"></i>
      <span
        data-testid="tool-card-name"
        class="font-mono shrink-0 max-w-[40%] truncate"
        :class="isError ? 'text-red-300' : 'text-[var(--wb-text-1)]'"
        :title="name"
      >{{ toolMeta.label }}</span>
      <span
        v-if="previewLine"
        data-testid="tool-card-preview"
        class="truncate flex-1 min-w-0 font-mono text-[11px] text-[var(--wb-text-2)] opacity-80"
        >{{ previewLine }}</span
      >
      <span v-else class="flex-1"></span>
      <span
        v-if="durationLabel"
        data-testid="tool-card-duration"
        class="shrink-0 text-[10px] text-[var(--wb-text-2)] opacity-70 tabular-nums"
        >{{ durationLabel }}</span
      >
      <i
        class="fas shrink-0 text-[10px] opacity-60"
        :class="open ? 'fa-chevron-down' : 'fa-chevron-right'"
        aria-hidden="true"
      ></i>
    </header>

    <!-- detail:args(JSON 美化)+ result(截断/展开) + 扩展 slot -->
    <section v-if="open" data-testid="tool-card-detail" class="px-2 pb-2 space-y-1.5">
      <div v-if="prettyArgs">
        <div class="text-[10px] text-[var(--wb-text-2)] opacity-70 mb-0.5">参数</div>
        <pre
          data-testid="tool-card-args"
          class="tool-card__scroll max-h-48 overflow-y-auto m-0 p-2 rounded bg-black/40 border border-[var(--wb-stroke)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--wb-text-2)]"
          >{{ prettyArgs }}</pre
        >
      </div>

      <div v-if="resultText">
        <div class="text-[10px] text-[var(--wb-text-2)] opacity-70 mb-0.5">结果</div>
        <!-- #result 插槽:覆盖默认结果渲染 -->
        <slot name="result" :result="result" :status="status">
          <pre
            v-if="!resultExpanded"
            data-testid="tool-card-result"
            class="m-0 p-2 rounded bg-black/40 border border-[var(--wb-stroke)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--wb-text-2)]"
            >{{ resultTruncated }}</pre
          >
          <pre
            v-else
            data-testid="tool-card-result-full"
            class="tool-card__scroll max-h-64 overflow-y-auto m-0 p-2 rounded bg-black/40 border border-[var(--wb-stroke)] font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--wb-text-2)]"
            >{{ resultText }}</pre
          >
          <button
            v-if="isResultTruncated && !resultExpanded"
            data-testid="tool-card-result-expand"
            class="mt-1 text-[10px] px-1.5 py-0.5 rounded text-[var(--wb-accent)] hover:bg-[var(--wb-surface-hover)] transition"
            @click.stop="resultExpanded = true"
          >
            展开全部({{ resultText.length }} 字符)
          </button>
        </slot>
      </div>

      <!-- 默认插槽:未来扩展(HITL 操作、子代理 chip 等) -->
      <slot :tool-call-id="toolCallId" :name="name" :result="result" :status="status" />
    </section>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  name: { type: String, required: true },
  argsPreview: { type: String, default: '' },
  args: { type: [String, Object], default: null },
  result: { type: [String, Object], default: null },
  status: {
    type: String,
    default: 'running',
    validator: (v) => ['running', 'done', 'error'].includes(v),
  },
  durationMs: { type: Number, default: null },
  toolCallId: { type: String, default: '' },
})

/** 折叠态 header 结果/参数预览截断长度 */
const PREVIEW_MAX_LEN = 80
/** 折叠态 result 截断长度(超出出「展开全部」) */
const RESULT_TRUNCATE_LEN = 400

// ---------- 展开状态 ----------
// args 默认折叠;result 截断展开是独立二级开关(header 展开 ≠ result 全文展开)
const open = ref(false)
const resultExpanded = ref(false)

function toggle() {
  open.value = !open.value
}

// ---------- 三态 ----------
const isRunning = computed(() => props.status === 'running')
const isError = computed(() => props.status === 'error')

// ---------- 名称友好化(wb_* 原样,约定名中文化) ----------
const FRIENDLY_TOOLS = {
  shell: { label: '终端命令', icon: 'fa-terminal' },
  file_change: { label: '文件修改', icon: 'fa-file-pen' },
  web_search: { label: '网络搜索', icon: 'fa-magnifying-glass' },
}

const toolMeta = computed(() => {
  const name = props.name || ''
  if (FRIENDLY_TOOLS[name]) return FRIENDLY_TOOLS[name]
  // wb_* 工具(注册表名)原样展示,MCP 插头图标
  if (name.startsWith('wb_')) return { label: name, icon: 'fa-plug' }
  return { label: name, icon: 'fa-circle-dot' }
})

// ---------- args / result 归一化 ----------
/** String|Object → object(可解析时),否则 null */
function toObject(val) {
  if (val && typeof val === 'object') return val
  if (typeof val === 'string') {
    const raw = val.trim()
    if (!raw) return null
    try {
      const parsed = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed : null
    } catch {
      return null
    }
  }
  return null
}

/** JSON 美化:对象直接序列化;字符串尝试 parse 后美化,失败回退原文(trim) */
function prettify(val) {
  if (val == null) return ''
  if (typeof val === 'object') return JSON.stringify(val, null, 2)
  const raw = String(val).replace(/\s+$/, '')
  if (!raw) return ''
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

const prettyArgs = computed(() => prettify(props.args))

const resultText = computed(() => prettify(props.result))

const isResultTruncated = computed(() => resultText.value.length > RESULT_TRUNCATE_LEN)
const resultTruncated = computed(() =>
  isResultTruncated.value
    ? resultText.value.slice(0, RESULT_TRUNCATE_LEN) + ' …'
    : resultText.value,
)

// ---------- 折叠态预览行 ----------
const previewLine = computed(() => {
  if (props.argsPreview) return clip(props.argsPreview)
  const obj = toObject(props.args)
  if (obj) {
    // 约定名按语义取关键字段,信息密度对齐 waa(command/query/paths 直接可读)
    if (props.name === 'shell' && typeof obj.command === 'string') return clip(obj.command)
    if (props.name === 'web_search' && typeof obj.query === 'string') return clip(obj.query)
    if (props.name === 'file_change' && Array.isArray(obj.changes)) {
      const paths = obj.changes.map((c) => c && c.path).filter(Boolean).join(', ')
      if (paths) return clip(paths)
    }
  }
  const text = prettyArgs.value
  if (!text) return ''
  return clip(text.split('\n')[0])
})

function clip(text) {
  const t = String(text).replace(/\s+$/, '')
  return t.length > PREVIEW_MAX_LEN ? t.slice(0, PREVIEW_MAX_LEN) + '…' : t
}

// ---------- 耗时(done 态展示) ----------
const durationLabel = computed(() => {
  if (props.durationMs == null || isRunning.value) return ''
  const ms = Number(props.durationMs)
  if (!Number.isFinite(ms) || ms < 0) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
})
</script>

<style scoped>
/* args / result 全文态滚动容器:细滚动条,对齐 workbench 深色主题 */
.tool-card__scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--wb-stroke-strong) transparent;
}
.tool-card__scroll::-webkit-scrollbar {
  width: 6px;
}
.tool-card__scroll::-webkit-scrollbar-thumb {
  background: var(--wb-stroke-strong);
  border-radius: 3px;
}
</style>
