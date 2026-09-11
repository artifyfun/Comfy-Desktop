<!--
  PlanProposalCard.vue — C-H4 计划步骤卡（对标建议 #3：计划展示 + 中途拍板）

  消费后端 wb_propose_plan 的 CUSTOM { name:'plan_proposed' } 事件 value：
    { title, steps: [{index, title, detail?}], options?: [{optionId, label, description?}], sessionId }

  契约（纯 props 驱动，组件零 fetch；父级负责 POST interaction-response）：
    plan      Object  必填，上述 value 形状。
    status    'pending'|'done'  缺省 'done'（无拍板项的历史卡为 done 纯展示）。
    requestId String  有 options 时必填（拍板回传定位挂起）。

  emits:
    choose({ optionId })  用户点选某方案（pending 且有 options 时）。
-->
<template>
  <div
    data-testid="plan-card"
    class="plan-card rounded-md border text-xs"
    :class="
      isPending
        ? 'border-[var(--wb-accent)]/40 bg-[var(--wb-accent)]/5'
        : 'border-[var(--wb-stroke)] bg-[var(--wb-surface)]'
    "
  >
    <header class="flex items-center gap-2 px-2 py-1.5">
      <span
        class="inline-flex h-2 w-2 shrink-0 rounded-full"
        :class="isPending ? 'bg-[var(--wb-accent)] animate-pulse' : 'bg-[var(--wb-text-3)]'"
        aria-hidden="true"
      ></span>
      <span class="shrink-0 text-[var(--wb-text-1)]">{{ plan.title || '执行计划' }}</span>
      <span class="flex-1"></span>
      <span class="shrink-0 text-[11px] text-[var(--wb-text-2)]">
        {{ isPending ? '等待你的选择' : '已确认' }}
      </span>
    </header>

    <!-- 步骤树 -->
    <ol class="space-y-1 px-3 pb-1.5">
      <li v-for="step in plan.steps" :key="step.index" class="flex items-start gap-2">
        <span
          class="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full border border-[var(--wb-stroke)] text-[10px] text-[var(--wb-text-2)]"
          >{{ step.index }}</span
        >
        <span class="text-[var(--wb-text-1)]">
          {{ step.title }}
          <span v-if="step.detail" class="text-[var(--wb-text-2)]">— {{ step.detail }}</span>
        </span>
      </li>
    </ol>

    <!-- 拍板选项（pending 且有 options） -->
    <div
      v-if="isPending && options.length"
      class="space-y-1 border-t border-[var(--wb-stroke)] px-3 py-2"
    >
      <div class="mb-1 text-[11px] text-[var(--wb-text-2)]">选择一个方案继续：</div>
      <button
        v-for="opt in options"
        :key="opt.optionId"
        data-testid="plan-option"
        class="w-full rounded-md border border-[var(--wb-stroke)] px-2 py-1.5 text-left transition hover:border-[var(--wb-accent)] hover:bg-[var(--wb-accent)]/10"
        @click="$emit('choose', { optionId: opt.optionId })"
      >
        <div class="font-medium text-[var(--wb-text-1)]">{{ opt.label }}</div>
        <div v-if="opt.description" class="text-[11px] text-[var(--wb-text-2)]">
          {{ opt.description }}
        </div>
      </button>
    </div>
  </div>
</template>

<script>
export default {
  name: 'PlanProposalCard',
  props: {
    plan: { type: Object, required: true },
    status: { type: String, default: 'done' },
    requestId: { type: String, default: '' },
  },
  computed: {
    isPending() {
      return this.status === 'pending'
    },
    options() {
      return Array.isArray(this.plan.options) ? this.plan.options : []
    },
  },
}
</script>
