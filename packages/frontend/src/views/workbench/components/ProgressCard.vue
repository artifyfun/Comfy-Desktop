<!--
  ProgressCard.vue — P1-B3 plan/进度任务卡(纯展示组件,数据由父级归一)

  双数据源(方案 C=A+B 混合):
    mode 'todo'      原生清单:codex todo_list item(TodoItem={text,completed})。
                      同 runId 的 updated/completed 多帧由父级原位 upsert 到同一
                      张卡(aguiBridge.upsertTodos),本组件只负责渲染当前快照。
    mode 'activity'  合成兜底:run 无原生 todo 时,由父级把该轮在途/已完成的
                      reasoning+tool_item 消息归一为步骤叙事(父级仅在存在在途
                      项时挂卡——全完成后回落既有「过程(N 步)」折叠行,零重复)。

  契约(纯 props 驱动,不 import store/不 fetch;与 ToolCallCard/ReasoningBlock
  同哲学):
    mode      'todo' | 'activity'         数据源模式(必填)。
    running   Boolean  是否存在在途项/流式中(缺省 false)。
                        running→true  自动展开;todo 终态(全勾)保持展开不打断。
    title     String   头部标题(父级已本地化,避免组件引 i18n 的测试噪音)。
    items     Array    todo 模式:原生条目 [{text, completed}]。
    steps     Array    activity 模式:[{label, icon, status:'completed'|'in_progress',
                       detail?}]。detail 存在时点击行展开 <pre>。

  视觉:深色卡片对齐 ToolCallCard——header 三态(运行 spinner 芯片 / 全勾对勾 /
  计数 chip)+ 每行前导状态图标(✓ emerald / 空圈 dim / spinner),色盲友好。
-->
<template>
  <div
    data-testid="progress-card"
    class="progress-card rounded-md border border-[var(--wb-stroke)] bg-black/20 text-xs"
    :class="mode === 'todo' ? 'progress-card--todo' : 'progress-card--activity'"
  >
    <!-- header:状态 + 标题 + done/total + 折叠箭头 -->
    <header
      data-testid="progress-header"
      class="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none hover:bg-[var(--wb-surface-hover)] transition-colors"
      :aria-expanded="open"
      @click="toggle"
    >
      <i
        :class="`fas ${mode === 'todo' ? 'fa-list-check' : 'fa-bars-progress'} text-tech-cyan shrink-0`"
        aria-hidden="true"
      ></i>
      <span data-testid="progress-title" class="text-[var(--wb-text-1)] font-medium">{{
        title
      }}</span>
      <span v-if="running" data-testid="progress-spinner" class="flex items-center gap-1">
        <span
          class="inline-block w-3 h-3 rounded-full border border-[var(--wb-stroke-strong)] border-t-[var(--wb-accent)] animate-spin"
          aria-label="运行中"
        ></span>
      </span>
      <span v-else-if="allDone" class="text-emerald-400/80" aria-label="已完成">
        <i class="fas fa-check"></i>
      </span>
      <span v-else class="flex-1"></span>
      <span
        data-testid="progress-count"
        class="shrink-0 text-[10px] text-[var(--wb-text-2)] opacity-70 tabular-nums"
        >{{ doneCount }}/{{ totalCount }}</span
      >
      <i
        class="fas shrink-0 text-[10px] opacity-60"
        :class="open ? 'fa-chevron-down' : 'fa-chevron-right'"
        aria-hidden="true"
      ></i>
    </header>

    <!-- body:todo 清单行 / activity 步骤行 -->
    <section v-if="open" data-testid="progress-body" class="px-2 pb-2">
      <!-- todo:复选框语义(原生 items 直通,completed/done 双字段兼容) -->
      <div v-if="mode === 'todo'" class="progress-card__scroll max-h-56 overflow-y-auto space-y-1">
        <div
          v-for="(it, k) in items"
          :key="k"
          data-testid="progress-row"
          class="flex items-center gap-2 min-w-0 py-0.5"
          :class="isTodoDone(it) ? 'opacity-80' : ''"
        >
          <i
            data-testid="progress-todo-check"
            class="shrink-0 text-[11px]"
            :class="
              isTodoDone(it)
                ? 'fas fa-circle-check text-emerald-400/90'
                : 'far fa-circle text-[var(--wb-text-3)]'
            "
            aria-hidden="true"
          ></i>
          <span
            class="truncate flex-1 min-w-0 text-[var(--wb-text-2)]"
            :class="isTodoDone(it) ? 'line-through opacity-60' : ''"
            >{{ todoText(it) }}</span
          >
        </div>
        <div
          v-if="items.length === 0"
          class="py-0.5 text-[var(--wb-text-3)]"
          data-testid="progress-empty"
        >
          0 项
        </div>
      </div>

      <!-- activity:步骤叙事(完成对勾 / 当前 spinner),行点击展开 detail -->
      <div
        v-else
        data-testid="progress-steps"
        class="progress-card__scroll max-h-56 overflow-y-auto space-y-0.5"
      >
        <div
          v-for="(st, k) in steps"
          :key="k"
          class="flex items-start gap-2 min-w-0 rounded px-0.5 py-0.5"
          :class="st.detail ? 'cursor-pointer hover:bg-[var(--wb-surface-hover)]' : ''"
          @click="st.detail && toggleStep(k)"
        >
          <span class="shrink-0 w-3 h-3 mt-0.5 flex items-center justify-center">
            <span
              v-if="stepRunning(st)"
              class="inline-block w-3 h-3 rounded-full border border-[var(--wb-stroke-strong)] border-t-[var(--wb-accent)] animate-spin"
            ></span>
            <i
              v-else
              class="fas fa-circle-check text-emerald-400/80 text-[11px]"
              aria-hidden="true"
            ></i>
          </span>
          <i
            v-if="st.icon"
            :class="`fas ${st.icon} text-tech-cyan shrink-0 mt-0.5`"
            aria-hidden="true"
          ></i>
          <span
            data-testid="progress-step-label"
            class="font-mono text-[11px] truncate flex-1 min-w-0 text-[var(--wb-text-2)]"
            :title="st.label"
            >{{ st.label }}</span
          >
          <i
            v-if="st.detail"
            class="fas shrink-0 text-[10px] opacity-50 mt-1"
            :class="stepOpen.has(k) ? 'fa-chevron-down' : 'fa-chevron-right'"
            aria-hidden="true"
          ></i>
        </div>
        <pre
          v-for="k in expandedStepKeys"
          :key="'d' + k"
          data-testid="progress-step-detail"
          class="mt-0.5 max-h-48 overflow-y-auto rounded bg-black/40 border border-[var(--wb-stroke)] p-2 whitespace-pre-wrap break-all text-[var(--wb-text-2)] font-mono text-[11px] leading-relaxed"
          >{{ steps[k].detail }}</pre
        >
      </div>
    </section>
  </div>
</template>

<script setup>
import { computed, ref, watch } from 'vue'

const props = defineProps({
  mode: { type: String, default: 'todo', validator: (v) => ['todo', 'activity'].includes(v) },
  running: { type: Boolean, default: false },
  title: { type: String, default: '' },
  items: { type: Array, default: () => [] },
  steps: { type: Array, default: () => [] },
})

// ---------- 展开状态:running 出现即展开;todo 终态保持展开不打断 ----------
const open = ref(props.running)
watch(
  () => props.running,
  (val, oldVal) => {
    if (val && !oldVal) open.value = true
  },
)

function toggle() {
  open.value = !open.value
}

// activity 行级 detail 展开(按行下标,独立于整体折叠)
const stepOpen = ref(new Set())
function toggleStep(k) {
  const next = new Set(stepOpen.value)
  if (next.has(k)) next.delete(k)
  else next.add(k)
  stepOpen.value = next
}
const expandedStepKeys = computed(() => [...stepOpen.value].sort((a, b) => a - b))

// ---------- 计数(两种模式统一 done/total 口径) ----------
const isTodoDone = (it) => !!it && (it.completed === true || it.done === true)
const todoText = (it) => (it && typeof it.text === 'string' ? it.text : '')
const stepRunning = (st) => st && st.status === 'in_progress'

const totalCount = computed(() => (props.mode === 'todo' ? props.items.length : props.steps.length))
const doneCount = computed(() =>
  props.mode === 'todo'
    ? props.items.filter(isTodoDone).length
    : props.steps.filter((s) => !stepRunning(s)).length,
)
const allDone = computed(
  () => totalCount.value > 0 && doneCount.value === totalCount.value && !props.running,
)
</script>

<style scoped>
/* 细滚动条:对齐 workbench 深色主题(与 reasoning-block__scroll 同款) */
.progress-card__scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--wb-stroke-strong) transparent;
}
.progress-card__scroll::-webkit-scrollbar {
  width: 6px;
}
.progress-card__scroll::-webkit-scrollbar-thumb {
  background: var(--wb-stroke-strong);
  border-radius: 3px;
}
</style>
