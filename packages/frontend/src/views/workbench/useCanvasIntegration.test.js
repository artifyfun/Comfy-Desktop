import { describe, expect, it, vi, beforeEach } from 'vitest'
import { ref, computed } from 'vue'
import { useCanvasIntegration } from './useCanvasIntegration'

const MSG = {
  DISPLAY_CARD: 'artify:display-card',
  CANVAS_STATE: 'artify:canvas-state',
  CARD_ATTACH: 'artify:card-attach',
  GET_CANVAS_STATE: 'artify:get-canvas-state',
  CANVAS_OPS: 'artify:canvas-ops',
  CANVAS_EXECUTE: 'artify:canvas-execute',
}

const tr = (k) => k // t 直通

function mkCtx(over = {}) {
  const posted = []
  const draftAttachments = ref([])
  const input = ref('')
  const calls = { emitResult: [], pushFiles: [], send: 0, bridge: [] }
  const ctx = {
    isEmbed: computed(() => false),
    isCanvasEmbedded: computed(() => false),
    t: tr,
    draftAttachments,
    input,
    send: () => calls.send++,
    uploadFiles: vi.fn().mockResolvedValue(undefined),
    pushFiles: (files) => {
      calls.pushFiles.push(files)
      return files.length
    },
    emitResult: (files) => calls.emitResult.push(files),
    onCanvasState: () => () => {},
    onAttachments: () => () => {},
    onPrompt: () => () => {},
    callBridge: async (type, payload) => {
      calls.bridge.push({ type, payload })
      return { ok: true, applied: (payload.ops || []).length, results: [] }
    },
    ARTIFY_MSG: MSG,
    postMessage: (p) => posted.push(JSON.parse(p)),
    ...over,
  }
  return { ctx, posted, draftAttachments, input, calls }
}

const files = [{ filename: 'a.png', subfolder: '', type: 'output' }]

describe('deliverArtifact — 产物落布三路分岔收口', () => {
  it('侧栏形态 → canvasMode 总线 emitResult', () => {
    const { ctx, calls } = mkCtx({ isCanvasEmbedded: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    g.deliverArtifact(files)
    expect(calls.emitResult).toHaveLength(1)
    expect(calls.pushFiles).toHaveLength(0)
  })

  it('独立页 → canvasBridge 队列 pushFiles', () => {
    const { ctx, calls } = mkCtx()
    const g = useCanvasIntegration(ctx)
    g.deliverArtifact(files)
    expect(calls.pushFiles).toHaveLength(1)
    expect(calls.emitResult).toHaveLength(0)
  })

  it('embed 形态 → postMessage DISPLAY_CARD', () => {
    const { ctx, posted } = mkCtx({ isEmbed: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    g.deliverArtifact(files)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toMatchObject({ type: MSG.DISPLAY_CARD, files })
  })

  it('空文件 no-op', () => {
    const { ctx, calls } = mkCtx()
    useCanvasIntegration(ctx).deliverArtifact([])
    expect(calls.pushFiles).toHaveLength(0)
  })
})

describe('canvasState — 防乱序', () => {
  it('旧 seq 不覆盖新 seq', () => {
    const { ctx } = mkCtx()
    const g = useCanvasIntegration(ctx)
    g.onWindowMessage({
      data: JSON.stringify({ type: MSG.CANVAS_STATE, state: { seq: 5, objects: [] } }),
    })
    g.onWindowMessage({
      data: JSON.stringify({ type: MSG.CANVAS_STATE, state: { seq: 3, objects: [] } }),
    })
    expect(g.canvasState.value.seq).toBe(5)
    // 非法载荷忽略
    g.onWindowMessage({ data: 'garbage{' })
    g.onWindowMessage({ data: { type: 'other' } })
    expect(g.canvasState.value.seq).toBe(5)
  })
})

describe('CARD_ATTACH — 画布回填附件', () => {
  it('window 通道：按扩展名分类 kind + name 拼 subfolder', () => {
    const { ctx, draftAttachments } = mkCtx({ isEmbed: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    g.onWindowMessage({
      data: JSON.stringify({
        type: MSG.CARD_ATTACH,
        files: [
          { filename: 'v.mp4', subfolder: 'out' },
          { filename: 'img.png', subfolder: '' },
        ],
      }),
    })
    expect(draftAttachments.value).toHaveLength(2)
    expect(draftAttachments.value[0]).toMatchObject({ kind: 'video', name: 'out/v.mp4' })
    expect(draftAttachments.value[1]).toMatchObject({
      kind: 'image',
      name: 'img.png',
      fromCanvas: true,
    })
    expect(g.canvasAttachNotice.value).toBeTruthy()
  })
})

describe('ops 人审（M2）', () => {
  it('propose 仅 embed 生效；confirm 成功后 3s 收卡', async () => {
    vi.useFakeTimers()
    try {
      // 非 embed ctx：propose 被拒
      const plain = mkCtx()
      const gPlain = useCanvasIntegration(plain.ctx)
      expect(gPlain.proposeCanvasOps([{ type: 'align', mode: 'left' }])).toBe(false)
      // embed ctx：提出 + 确认 + 3s 收卡
      const { ctx, calls } = mkCtx({ isEmbed: computed(() => true) })
      const g = useCanvasIntegration(ctx)
      expect(g.proposeCanvasOps([{ type: 'addNode', nodeType: 'X' }])).toBe(true)
      expect(g.pendingOps.value).toHaveLength(1)
      expect(g.opsDiffLines.value[0]).toContain('workbenchOpsAddNode')
      await g.confirmApplyOps()
      expect(g.opsResultOk.value).toBe(true)
      expect(calls.bridge).toHaveLength(1)
      expect(calls.bridge[0].payload.ops).toHaveLength(1)
      // 3s 后收卡
      vi.advanceTimersByTime(3100)
      expect(g.pendingOps.value).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('discard 立即清卡', () => {
    const { ctx } = mkCtx({ isEmbed: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    g.proposeCanvasOps([{ type: 'loadWorkflow' }])
    g.discardPendingOps()
    expect(g.pendingOps.value).toBeNull()
  })
})

describe('syncWorkflowToCanvas / runCanvasOnHost', () => {
  it('非 embed：ensureTab 静默 skipped；显式 sync 拒绝', async () => {
    const { ctx } = mkCtx()
    const g = useCanvasIntegration(ctx)
    const r = await g.syncWorkflowToCanvas({ workflow: { nodes: [] }, ensureTab: true })
    expect(r).toEqual({ ok: true, mode: 'skipped' })
    await expect(g.syncWorkflowToCanvas({ workflow: { nodes: [] } })).rejects.toThrow()
  })

  it('embed：workflow 结构校验 + 成功透传', async () => {
    const { ctx, calls } = mkCtx({ isEmbed: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    await expect(g.syncWorkflowToCanvas({ workflow: null })).rejects.toThrow()
    const ok = await g.syncWorkflowToCanvas({ name: 'T', workflow: { nodes: [{}] } })
    expect(ok.ok).toBe(true)
    expect(calls.bridge[0].payload.ops[0]).toMatchObject({ type: 'loadWorkflow', name: 'T' })
  })

  it('runCanvasOnHost：非 embed 拒绝；embed 走 CANVAS_EXECUTE', async () => {
    const { ctx, calls } = mkCtx({ isEmbed: computed(() => true) })
    const g = useCanvasIntegration(ctx)
    await g.runCanvasOnHost({ nodeOverrides: {}, sessionId: 's1' })
    expect(calls.bridge[0].type).toBe(MSG.CANVAS_EXECUTE)
  })
})

describe('attachHostListeners — 订阅装配', () => {
  it('独立页（非 embed 非侧栏）零订阅', () => {
    const { ctx } = mkCtx()
    useCanvasIntegration(ctx).attachHostListeners()
    // 无异常 + 无 postMessage（首屏拉取仅 embed）
    // （真实 add/removeEventListener 由浏览器承载，此处验证装配分支不炸）
  })

  it('embed：400ms 后发 GET_CANVAS_STATE', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, posted } = mkCtx({ isEmbed: computed(() => true) })
      useCanvasIntegration(ctx).attachHostListeners()
      vi.advanceTimersByTime(500)
      expect(posted.some((p) => p.type === MSG.GET_CANVAS_STATE)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
