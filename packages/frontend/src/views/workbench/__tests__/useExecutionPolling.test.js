// @vitest-environment node
/**
 * useExecutionPolling.applyExecutionSideEffect('canvas-ops') 测试（2026-09-15）。
 *
 * 传输层的最后一环：桥把 CUSTOM `wb_canvas_ops` 交到这里，本分支决定 ops 能否到达
 * 画布页（`emitOps` 走 utils/canvasMode 的页内总线 → 画布页 onOps → 确认卡）。
 * 关键门控：**仅 isCanvasEmbedded 时才 emitOps**；否则明确提示「无宿主画布」，
 * 而不是静默丢弃（静默丢弃正是这次画布连线 bug 的形态）。
 *
 * 链路全景与各环节测试归属：
 *   工具 → CUSTOM wb_canvas_ops 帧            …… src/main/artifylab/routes/agui.test.ts
 *   CUSTOM → sideEffect('canvas-ops')         …… views/workbench/__tests__/aguiBridge.test.js
 *   sideEffect → emitOps / 无宿主提示          …… 本文件
 *   emitOps → 画布页 pendingAgentOps → confirm → 落地
 *                                             …… views/canvas/composables.test.js（工具形状批次）
 */
import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'
import { useExecutionPolling } from '../useExecutionPolling'

const T = {
  workbenchCanvasOpsSent: 'ops-sent:{n}',
  workbenchCanvasOpsNoHost: 'no-host',
}
const t = (k) => T[k] ?? k

function setup({ embedded = true } = {}) {
  const pushed = []
  const emitOps = vi.fn()
  const c = useExecutionPolling({
    artifacts: ref([]),
    sessionId: ref('s1'),
    executingCount: ref(0),
    execProgressIndex: ref(0),
    pollTimers: new Map(),
    t,
    pushMsg: (m) => {
      pushed.push(m)
      return { ...m, _key: 'k' + pushed.length }
    },
    scrollToBottom: vi.fn(),
    loadSessions: vi.fn(),
    sessions: ref([]),
    autoRecover: vi.fn(),
    diagnoseArtifact: vi.fn(),
    pushCardsToCanvas: vi.fn(),
    messages: ref([]),
    isCanvasEmbedded: ref(embedded),
    emitOps,
  })
  return { c, pushed, emitOps }
}

/** 工具产出的 ops 形状（nodeId 引用；与 canvasTools 一致） */
const OPS = [
  { type: 'add_app_node', appId: 'app:aaa', name: '文生图', nodeId: 'wf-m-0-a1' },
  { type: 'add_app_node', appId: 'app:bbb', name: '图生视频', nodeId: 'wf-m-1-b2' },
  { type: 'connect_nodes', from: 'wf-m-0-a1', to: 'wf-m-1-b2' },
  { type: 'select_nodes', ids: ['wf-m-0-a1', 'wf-m-1-b2'] },
]

describe('applyExecutionSideEffect · canvas-ops（传输层最后一环）', () => {
  it('embed 模式：ops 原样经 emitOps 送给宿主画布，并推一条已发送提示', () => {
    const { c, pushed, emitOps } = setup({ embedded: true })

    c.applyExecutionSideEffect('canvas-ops', { ops: OPS, source: 'wb_build_workflow' })

    expect(emitOps).toHaveBeenCalledTimes(1)
    expect(emitOps).toHaveBeenCalledWith(OPS)
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ role: 'agent', kind: 'chat', text: 'ops-sent:4' })
  })

  it('非 embed（独立工作台/无宿主画布）：不发 ops，明确提示而不是静默丢弃', () => {
    const { c, pushed, emitOps } = setup({ embedded: false })

    c.applyExecutionSideEffect('canvas-ops', { ops: OPS, source: 'wb_build_workflow' })

    expect(emitOps).not.toHaveBeenCalled()
    expect(pushed).toHaveLength(1)
    expect(pushed[0]).toMatchObject({ role: 'agent', kind: 'error', text: 'no-host' })
  })

  it('空 ops / 非数组 ops：直接忽略，不推任何消息也不调 emitOps', () => {
    const { c, pushed, emitOps } = setup({ embedded: true })

    c.applyExecutionSideEffect('canvas-ops', { ops: [] })
    c.applyExecutionSideEffect('canvas-ops', {})
    c.applyExecutionSideEffect('canvas-ops', { ops: 'nope' })

    expect(emitOps).not.toHaveBeenCalled()
    expect(pushed).toHaveLength(0)
  })
})
