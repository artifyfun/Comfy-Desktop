<!--
  InteractionApprovalCard.vue — AG-UI 迁移 C15:HITL 工具审批卡(纯展示 + 交互意图)

  消费后端 C14 的 CUSTOM { name:'tool_approval_required' } 事件 value
  (src/main/artifylab/agui/approvalGate.ts 的 toolApprovalRequiredValue 形状):
    { interactionId, mode:'sameflow', toolCalls:[…],
      requestId, threadId, toolName, args, timeoutMs }

  契约(纯 props 驱动,组件不 fetch、不 import store/Pinia;父级负责调
  POST /api/workbench/agent/interaction-response,与 ToolCallCard 同哲学):
    approval  Object  必填,上述 value 形状(卡片只读 toolName/args/timeoutMs)。
    status    'pending'|'approved'|'rejected'|'expired'  缺省 'pending'。

  emits:
    respond({ action, args? })  action ∈ 'approve'|'reject'|'edit';
    approve/reject 不带 args,edit 带 JSON.parse 校验通过后的对象。
    后端语义对齐:edit args 非对象 → 400 可改后重试(前端前置同规则校验,
    非法则行内红字、不 emit);超时兜底在后端,前端到 0 仅做视觉提示。

  视觉/交互:
    pending:amber 警示条 + 工具名友好化(对齐 ToolCallCard 约定)+ args 折叠
    (JSON 美化)+ mm:ss 倒计时(内部 setInterval 每秒,卸载清理;到 0 转
    expired 提示、按钮禁用,但不自动 reject)+ 批准/拒绝/修改参数三按钮
    (修改展开 textarea 预填美化 JSON)。
    approved/rejected/expired:紧凑单行结果条(图标 + 文案 + 工具名),无按钮。
-->
<template>
  <div
    data-testid="approval-card"
    class="approval-card rounded-md border text-xs"
    :class="
      isPending
        ? 'border-amber-500/40 bg-amber-500/5'
        : 'border-[var(--wb-stroke)] bg-black/20'
    "
  >
    <!-- ==================== pending:待审批 ==================== -->
    <template v-if="isPending">
      <!-- header:呼吸点 + 状态 + 工具名 + 倒计时 -->
      <header class="flex items-center gap-2 px-2 py-1.5">
        <span class="relative flex h-2 w-2 shrink-0" aria-hidden="true">
          <span
            class="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-60"
          ></span>
          <span class="relative inline-flex h-2 w-2 rounded-full bg-amber-400"></span>
        </span>
        <span class="shrink-0 text-amber-300">等待审批</span>
        <i class="fas fa-shield-halved shrink-0 text-amber-400/80" aria-hidden="true"></i>
        <span
          data-testid="approval-tool-name"
          class="max-w-[40%] shrink-0 truncate font-mono text-[var(--wb-text-1)]"
          :title="toolName"
          >{{ toolLabel }}</span
        >
        <span class="flex-1"></span>
        <span
          data-testid="approval-countdown"
          class="shrink-0 text-[11px] tabular-nums"
          :class="countdownUrgent ? 'text-red-300' : 'text-amber-300'"
          :aria-label="`剩余 ${countdownLabel}`"
          >{{ countdownLabel }}</span
        >
      </header>

      <!-- args 折叠(默认收起,展开 JSON 美化) -->
      <div class="px-2 pb-1">
        <button
          type="button"
          data-testid="approval-args-toggle"
          class="flex items-center gap-1 text-[10px] text-[var(--wb-text-2)] opacity-80 transition hover:opacity-100"
          :aria-expanded="argsOpen"
          @click="argsOpen = !argsOpen"
        >
          <i
            class="fas shrink-0 text-[9px]"
            :class="argsOpen ? 'fa-chevron-down' : 'fa-chevron-right'"
            aria-hidden="true"
          ></i>
          参数
        </button>
        <pre
          v-if="argsOpen"
          data-testid="approval-args"
          class="approval-card__scroll m-0 mt-1 max-h-48 overflow-y-auto rounded border border-[var(--wb-stroke)] bg-black/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--wb-text-2)]"
          >{{ prettyArgs }}</pre
        >
      </div>

      <!-- 倒计时到 0:仅 expired 视觉提示(不自动 reject,后端超时已兜底) -->
      <div
        v-if="timedOut"
        data-testid="approval-expired"
        class="mx-2 mb-1 flex items-center gap-1.5 rounded bg-amber-500/10 px-2 py-1 text-amber-300"
      >
        <i class="fas fa-hourglass-end shrink-0" aria-hidden="true"></i>
        <span>已超时,等待后端兜底</span>
      </div>

      <!-- edit 面板:textarea 预填美化 JSON,提交前 JSON.parse + 对象校验 -->
      <div v-if="editOpen" class="space-y-1 px-2 pb-1">
        <textarea
          v-model="editText"
          data-testid="approval-edit-textarea"
          rows="6"
          class="approval-card__scroll w-full resize-y rounded border border-[var(--wb-stroke)] bg-black/40 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all text-[var(--wb-text-1)] outline-none focus:border-amber-400/60"
          aria-label="修改工具参数(JSON)"
        ></textarea>
        <p
          v-if="editError"
          data-testid="approval-error"
          class="m-0 text-[10px] text-red-400"
          role="alert"
          >{{ editError }}</p
        >
        <div class="flex gap-1.5">
          <button
            type="button"
            data-testid="approval-edit-submit"
            class="rounded border border-amber-500/50 px-2 py-1 text-amber-300 transition hover:bg-amber-500/10"
            @click="submitEdit"
          >
            确认修改
          </button>
          <button
            type="button"
            data-testid="approval-edit-cancel"
            class="rounded border border-[var(--wb-stroke-strong)] px-2 py-1 text-[var(--wb-text-2)] transition hover:bg-[var(--wb-surface-hover)]"
            @click="cancelEdit"
          >
            取消
          </button>
        </div>
      </div>

      <!-- 三操作:批准 / 拒绝 / 修改参数 -->
      <footer class="flex items-center gap-1.5 px-2 pb-2">
        <button
          type="button"
          data-testid="approval-approve"
          :disabled="timedOut || inFlight"
          class="rounded border border-emerald-500/50 px-2 py-1 text-emerald-300 transition hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          @click="respond('approve')"
        >
          批准
        </button>
        <button
          type="button"
          data-testid="approval-reject"
          :disabled="timedOut || inFlight"
          class="rounded border border-red-500/50 px-2 py-1 text-red-300 transition hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
          @click="respond('reject')"
        >
          拒绝
        </button>
        <button
          type="button"
          data-testid="approval-edit"
          :disabled="timedOut || inFlight"
          class="rounded border border-[var(--wb-stroke-strong)] px-2 py-1 text-[var(--wb-text-2)] transition hover:bg-[var(--wb-surface-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          @click="openEdit"
        >
          修改参数
        </button>
      </footer>
    </template>

    <!-- ==================== 终态:紧凑单行结果条,无按钮 ==================== -->
    <div v-else data-testid="approval-result" class="flex items-center gap-2 px-2 py-1.5">
      <i :class="terminalMeta.icon" aria-hidden="true"></i>
      <span :class="terminalMeta.textClass">{{ terminalMeta.label }}</span>
      <span class="font-mono text-[11px] text-[var(--wb-text-2)] opacity-80" :title="toolName">{{
        toolLabel
      }}</span>
    </div>
  </div>
</template>

<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  /** CUSTOM tool_approval_required 的 value(toolApprovalRequiredValue 形状) */
  approval: { type: Object, required: true },
  status: {
    type: String,
    default: 'pending',
    validator: (v) => ['pending', 'approved', 'rejected', 'expired'].includes(v),
  },
})

/** 纯意图组件:不 fetch,父级负责调 /api/workbench/agent/interaction-response */
const emit = defineEmits(['respond'])

// ---------- 工具名友好化(对齐 ToolCallCard 约定,C14 白名单 + 约定名,简化版) ----------
const FRIENDLY_TOOLS = {
  wb_execute_template: '执行模板',
  wb_run_workflow: '运行工作流',
  wb_publish_workflow: '发布模板',
  shell: '终端命令',
  file_change: '文件修改',
  web_search: '网络搜索',
}

const toolName = computed(() => (props.approval && props.approval.toolName) || '')
const toolLabel = computed(() => FRIENDLY_TOOLS[toolName.value] || toolName.value)

const isPending = computed(() => props.status === 'pending')

// ---------- args 展示(折叠 + JSON 美化,归一化逻辑同 ToolCallCard) ----------
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

const prettyArgs = computed(() => prettify(props.approval && props.approval.args))
const argsOpen = ref(false)

// ---------- 倒计时:timeoutMs 起算,每秒 -1000;到 0 仅视觉转 expired ----------
const remainingMs = ref(0)
const timedOut = ref(false)
let timer = null

function stopTimer() {
  if (timer != null) {
    clearInterval(timer)
    timer = null
  }
}

function tick() {
  remainingMs.value = Math.max(0, remainingMs.value - 1000)
  if (remainingMs.value <= 0) {
    stopTimer()
    timedOut.value = true
  }
}

/** 挂载 / approval·status 变化时重置;仅 pending 且 timeoutMs 有效时启动 */
function resetCountdown() {
  stopTimer()
  timedOut.value = false
  const ms = Number(props.approval && props.approval.timeoutMs)
  remainingMs.value = Number.isFinite(ms) && ms > 0 ? ms : 0
  if (remainingMs.value > 0 && props.status === 'pending') {
    timer = setInterval(tick, 1000)
  }
}

const countdownLabel = computed(() => {
  const total = Math.max(0, Math.ceil(remainingMs.value / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
})

/** 最后 1 分钟转红警示 */
const countdownUrgent = computed(
  () => !timedOut.value && remainingMs.value > 0 && remainingMs.value <= 60 * 1000,
)

// setup 同步初始化一次(首帧即有正确剩余值,不等 mounted);此后 approval
// 的 requestId 或 status 变化时重置(挂载后 watch 与初始化重复执行一次,幂等)
resetCountdown()
watch([() => props.approval && props.approval.requestId, () => props.status], resetCountdown)
onBeforeUnmount(stopTimer)

// ---------- edit 流:展开 → 预填 → JSON.parse + 严格对象校验 → emit ----------
const editOpen = ref(false)
const editText = ref('')
const editError = ref('')

function openEdit() {
  editError.value = ''
  // 预填对齐后端 toolCalls[].arguments 的初始值语义:对象直接美化
  editText.value = prettify(props.approval && props.approval.args) || '{}'
  editOpen.value = true
}

function cancelEdit() {
  editOpen.value = false
  editError.value = ''
}

function submitEdit() {
  editError.value = ''
  let parsed
  try {
    parsed = JSON.parse(editText.value)
  } catch {
    editError.value = '参数不是合法 JSON,请修正后重试'
    return
  }
  // 严格对象校验,对齐后端 ApprovalArgsError(顶层不允许数组/标量/null)
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    editError.value = '参数必须是 JSON 对象(顶层不允许数组或标量)'
    return
  }
  emit('respond', { action: 'edit', args: parsed })
  editOpen.value = false
}

// ---------- 三操作(approve/reject 不带 args;超时后禁用不 emit) ----------
/** 审查修复 M3:提交在途禁点(桥 respondApproval 亦有终态防抖,双保险) */
const inFlight = computed(() => !!(props.message && props.message._approvalInFlight))

function respond(action) {
  if (inFlight.value) return
  if (!isPending.value || timedOut.value) return
  emit('respond', { action })
}

// ---------- 终态单行结果条 ----------
const TERMINAL_META = {
  approved: {
    icon: 'fas fa-circle-check text-emerald-400/80 shrink-0',
    label: '已批准',
    textClass: 'text-emerald-300',
  },
  rejected: {
    icon: 'fas fa-ban text-red-400/80 shrink-0',
    label: '已拒绝',
    textClass: 'text-red-300',
  },
  expired: {
    icon: 'fas fa-hourglass-end text-amber-400/80 shrink-0',
    label: '已超时',
    textClass: 'text-amber-300',
  },
}

const terminalMeta = computed(() => TERMINAL_META[props.status] || TERMINAL_META.expired)
</script>

<style scoped>
/* args / 编辑 textarea 滚动容器:细滚动条,对齐 workbench 深色主题(同 ToolCallCard) */
.approval-card__scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--wb-stroke-strong) transparent;
}
.approval-card__scroll::-webkit-scrollbar {
  width: 6px;
}
.approval-card__scroll::-webkit-scrollbar-thumb {
  background: var(--wb-stroke-strong);
  border-radius: 3px;
}
</style>
