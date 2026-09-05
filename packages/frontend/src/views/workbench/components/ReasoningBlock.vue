<!--
  ReasoningBlock.vue — AG-UI 迁移 C12:思考折叠块(纯展示组件,集成后置)

  交互参照 waa TimelineReasoning.vue:默认收起、流式中自动展开 + shimmer 流光、
  流完自动折叠、正文限高滚动;视觉用本项目 tailwind + CSS 变量重写。

  契约(纯 props 驱动,组件不 import store/Pinia;数据由父级从 aguiSession store
  的 kind:'reasoning' 消息映射):
    text      String  思考文本(流式增量直接拼好传入)。
    streaming Boolean 是否仍在接收(缺省 false)。true→展开 + 标题流光 +
                      「思考中…」;true→false 自动折叠;false→false 不打断
                      用户手动展开状态。
  默认折叠态:header 显示首行摘要(空文本时显示占位)。
  正文超过 8 行限高滚动(流式中粘底跟随,用户上滚打断)。

  扩展点:
    #title  具名插槽,覆盖默认标题文案(作用域:{ streaming })。
-->
<template>
  <div
    data-testid="reasoning-block"
    class="reasoning-block rounded-md border border-[var(--wb-stroke)] bg-[var(--wb-surface)] text-xs"
    :class="{ 'reasoning-block--streaming': streaming }"
  >
    <header
      data-testid="reasoning-toggle"
      class="flex items-center gap-2 px-2 py-1.5 rounded-md cursor-pointer select-none hover:bg-[var(--wb-surface-hover)] transition-colors"
      :aria-expanded="open"
      @click="toggle"
    >
      <i class="fas fa-brain text-[var(--wb-text-2)] shrink-0" aria-hidden="true"></i>
      <span
        data-testid="reasoning-title"
        class="text-[var(--wb-text-2)]"
        :class="streaming ? 'reasoning-block__shimmer' : ''"
      >
        <slot name="title" :streaming="streaming">{{ streaming ? '思考中…' : '深度思考' }}</slot>
      </span>
      <span
        v-if="summaryLine"
        data-testid="reasoning-summary"
        class="truncate flex-1 min-w-0 font-mono text-[11px] text-[var(--wb-text-2)] opacity-60"
        >{{ summaryLine }}</span
      >
      <span v-else class="flex-1"></span>
      <i
        class="fas shrink-0 text-[10px] opacity-60"
        :class="open ? 'fa-chevron-down' : 'fa-chevron-right'"
        aria-hidden="true"
      ></i>
    </header>

    <!-- 正文:展开态渲染;限高滚动,流式中粘底跟随 -->
    <section v-if="open" data-testid="reasoning-body-wrap" class="px-2 pb-2">
      <div
        ref="bodyEl"
        data-testid="reasoning-body"
        class="reasoning-block__scroll max-h-56 overflow-y-auto p-2 rounded bg-[var(--wb-surface-deep)] border border-[var(--wb-stroke)] text-[11px] leading-relaxed whitespace-pre-wrap break-words text-[var(--wb-text-2)]"
        @scroll="onBodyScroll"
        >{{ text }}</div
      >
    </section>
  </div>
</template>

<script setup>
import { computed, nextTick, ref, watch } from 'vue'

const props = defineProps({
  text: { type: String, default: '' },
  streaming: { type: Boolean, default: false },
})

// 默认折叠(waa 同款);streaming 时自动展开,流完自动折叠;
// 流完(false→false 的普通点击)不覆盖用户手动展开选择。
const open = ref(props.streaming)

watch(
  () => props.streaming,
  (val, oldVal) => {
    if (oldVal && !val) {
      // 流完自动折叠(waa: streaming true→false → isOpen = false)
      open.value = false
    } else if (val && !oldVal) {
      open.value = true
    }
  },
)

watch(open, (val) => {
  if (val && props.streaming) scrollToBottom()
})

watch(
  () => props.text,
  () => {
    if (open.value && autoScroll.value) scrollToBottom()
  },
)

function toggle() {
  open.value = !open.value
}

// ---------- 折叠态摘要:首行截断 ----------
const SUMMARY_MAX_LEN = 100

const summaryLine = computed(() => {
  const firstLine = (props.text || '').split('\n').find((l) => l.trim()) || ''
  const t = firstLine.trim()
  if (!t) return ''
  return t.length > SUMMARY_MAX_LEN ? t.slice(0, SUMMARY_MAX_LEN) + '…' : t
})

// ---------- 正文滚动(粘底跟随) ----------
const bodyEl = ref(null)
// 距底部 ≤50px 视为"在底部"(阈值与 waa/MessageList 一致);用户上滚打断跟随
const autoScroll = ref(true)

function onBodyScroll(e) {
  const el = e.target
  autoScroll.value = el.scrollHeight - el.scrollTop - el.clientHeight <= 50
}

function scrollToBottom() {
  nextTick(() => {
    if (bodyEl.value) bodyEl.value.scrollTop = bodyEl.value.scrollHeight
  })
}
</script>

<style scoped>
/* 正文滚动容器:细滚动条,对齐 workbench 深色主题 */
.reasoning-block__scroll {
  scrollbar-width: thin;
  scrollbar-color: var(--wb-stroke-strong) transparent;
}
.reasoning-block__scroll::-webkit-scrollbar {
  width: 6px;
}
.reasoning-block__scroll::-webkit-scrollbar-thumb {
  background: var(--wb-stroke-strong);
  border-radius: 3px;
}

/* streaming 标题流光(waa shimmer 的 CSS 变量重写版) */
.reasoning-block__shimmer {
  background: linear-gradient(
    90deg,
    var(--wb-text-2) 25%,
    var(--wb-accent) 50%,
    var(--wb-text-2) 75%
  );
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  animation: reasoning-shimmer 1.6s linear infinite;
}
@keyframes reasoning-shimmer {
  from {
    background-position: 200% 0;
  }
  to {
    background-position: -200% 0;
  }
}
</style>
