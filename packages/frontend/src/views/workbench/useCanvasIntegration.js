/**
 * 画布集成 seam（useCanvasIntegration）——A4 抽取。
 *
 * 原 workbench/index.vue 内联 2282-2595（~310 行）的全部画布联动：
 * - 产物落布三路分岔：pushCardsToCanvas（侧栏 canvasMode 总线 / 独立页
 *   canvasBridge 队列 / embed postMessage DISPLAY_CARD）→ 收口为
 *   deliverArtifact(files) 单入口
 * - 画布状态感知（embed CANVAS_STATE 推送 + 侧栏 onCanvasState）
 * - 画布→工作台回填（CARD_ATTACH / onAttachments / onPrompt 下发）
 * - 写回 diff 人审（proposeCanvasOps / confirmApplyOps，callBridge 注入）
 * - 模板同步与执行（syncWorkflowToCanvas / runCanvasOnHost）
 *
 * 形态判定（isEmbed/isCanvasEmbedded）作为依赖注入——本模块不含路由知识。
 * postMessage/callBridge/window 总线全部经参数注入，测试可全 fake。
 */
import { ref, computed } from 'vue'
import { message } from 'ant-design-vue'

export function useCanvasIntegration(ctx) {
  const {
    isEmbed, // ComputedRef<boolean>
    isCanvasEmbedded, // ComputedRef<boolean>（画布侧栏形态）
    t,
    draftAttachments, // Ref<attachment[]>
    input, // Ref<string>（onPrompt 回填）
    send, // () => void（onPrompt autoSend）
    uploadFiles, // (files, opts) => Promise
    pushFiles, // canvasBridge 队列 push
    emitResult, // canvasMode 总线
    onCanvasState, // canvasMode 订阅
    onAttachments, // canvasMode 订阅
    onPrompt, // canvasMode 订阅
    callBridge, // (type, payload, opts?) => Promise<reply>
    ARTIFY_MSG, // { DISPLAY_CARD, CANVAS_STATE, CARD_ATTACH, GET_CANVAS_STATE, CANVAS_OPS, CANVAS_EXECUTE }
    postMessage, // (payload) => void（默认 window.parent.postMessage）
  } = ctx

  const send_ = (payload) => {
    try {
      ;(postMessage || ((p) => window.parent.postMessage(p, '*')))(JSON.stringify(payload))
    } catch (e) {
      console.warn('[workbench] postMessage failed:', e)
    }
  }

  // ---------------- 产物落布（三路分岔收口） ----------------

  /** 把产物文件送到画布：侧栏总线 / 独立页队列 / embed postMessage 单入口 */
  function deliverArtifact(files) {
    if (!files?.length) return
    if (isCanvasEmbedded.value) {
      emitResult(files)
      return
    }
    if (!isEmbed.value) {
      const n = pushFiles(files)
      message.success(t('workbenchPinnedToCanvas').replace('{n}', String(n)))
      return
    }
    send_({ type: ARTIFY_MSG.DISPLAY_CARD, files })
  }

  // ---------------- 画布状态感知 ----------------

  const canvasState = ref(null)
  function applyCanvasState(data) {
    if (!data || typeof data.seq !== 'number') return
    // 防乱序：旧序号不覆盖新序号
    if (canvasState.value && data.seq <= canvasState.value.seq) return
    canvasState.value = data
  }

  // ---------------- 画布→工作台回填 ----------------

  const canvasAttachNotice = ref('')

  function attachFiles(files, { viaWindow = false } = {}) {
    if (!Array.isArray(files) || !files.length) return
    canvasAttachNotice.value = t('workbenchCardAttached').replace('{n}', String(files.length))
    setTimeout(() => (canvasAttachNotice.value = ''), 4000)
    for (const f of files) {
      // 裁剪图等内存文件（仅侧栏活通道）：走上传通道落地成可执行附件
      if (!viaWindow && f.file instanceof File) {
        uploadFiles([f.file], { silent: true }).catch(() => {})
        const probe = new FileReader()
        probe.onload = () => {
          if (!draftAttachments.value.some((a) => a.filename === f.filename)) {
            draftAttachments.value.push({
              kind: 'image',
              filename: f.filename,
              mime: 'image/png',
              uploading: false,
              fromCanvas: true,
              _preview: probe.result,
            })
          }
        }
        probe.readAsDataURL(f.file)
        continue
      }
      draftAttachments.value.push({
        kind: /\.(mp4|webm|mov|gif)$/i.test(f.filename || '')
          ? 'video'
          : /\.(mp3|wav|ogg|flac|m4a)$/i.test(f.filename || '')
            ? 'audio'
            : 'image',
        name: f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename,
        filename: f.filename,
        subfolder: f.subfolder ?? '',
        type: f.type ?? 'output',
        mime: '',
        uploading: false,
        fromCanvas: true,
        // A1: 画布卡片身份（选区发送经 refOf 携带），send 注入引用清单用
        cardId: f.cardId || '',
        cardTitle: f.cardTitle || '',
      })
    }
  }

  /** embed 形态的 window message 分发（CANVAS_STATE / CARD_ATTACH） */
  function onWindowMessage(event) {
    let data = event.data
    if (typeof data === 'string') {
      try {
        data = JSON.parse(data)
      } catch {
        return
      }
    }
    if (data && data.type === ARTIFY_MSG.CANVAS_STATE) {
      applyCanvasState(data.state)
      return
    }
    if (!data || data.type !== ARTIFY_MSG.CARD_ATTACH) return
    attachFiles(Array.isArray(data.files) ? data.files : [], { viaWindow: true })
  }

  /** 装配订阅（index.vue 在 setup 末尾调用一次；返回清理函数） */
  function attachHostListeners() {
    const cleanups = []
    const hasWindow = typeof window !== 'undefined'
    if (isEmbed.value) {
      if (hasWindow) {
        window.addEventListener('message', onWindowMessage)
        cleanups.push(() => window.removeEventListener('message', onWindowMessage))
      }
      // embed 首屏：主动要一份当前画布摘要（注入桥可能早于 iframe 就绪推过）
      setTimeout(() => send_({ type: ARTIFY_MSG.GET_CANVAS_STATE }), 400)
    }
    if (isCanvasEmbedded.value) {
      const off = onCanvasState(applyCanvasState)
      if (typeof off === 'function') cleanups.push(off)
      const offA = onAttachments((files) => attachFiles(files))
      if (typeof offA === 'function') cleanups.push(offA)
      const offP = onPrompt(({ text, autoSend, attachments }) => {
        if (Array.isArray(attachments) && attachments.length) attachFiles(attachments)
        if (typeof text === 'string' && text.trim()) input.value = text.trim()
        if (autoSend) setTimeout(() => send(), 0)
      })
      if (typeof offP === 'function') cleanups.push(offP)
    }
    return () => cleanups.forEach((c) => c?.())
  }

  // ---------------- 写回 diff 人审（M2） ----------------

  const pendingOps = ref(null)
  const opsApplying = ref(false)
  const opsResultMsg = ref('')
  const opsResultOk = ref(false)

  const opsDiffLines = computed(() => {
    const ops = pendingOps.value || []
    return ops.map((op) => {
      switch (op.type) {
        case 'setWidget': {
          const v = typeof op.value === 'object' ? JSON.stringify(op.value) : String(op.value)
          return t('workbenchOpsSetWidget')
            .replace('{node}', String(op.nodeId))
            .replace('{widget}', String(op.widget))
            .replace('{value}', v)
        }
        case 'addNode':
          return t('workbenchOpsAddNode').replace('{type}', String(op.nodeType))
        case 'removeNode':
          return t('workbenchOpsRemoveNode').replace('{node}', String(op.nodeId))
        case 'relink':
          return t('workbenchOpsRelink')
            .replace('{from}', String(op.fromNodeId))
            .replace('{to}', String(op.toNodeId))
        case 'loadWorkflow':
          return t('workbenchOpsLoad')
        case 'align':
          return t('workbenchOpsAlign').replace('{mode}', String(op.mode || 'left'))
        case 'autoLayout':
          return t('workbenchOpsAutoLayout').replace(
            '{dir}',
            op.direction === 'reverse' ? t('workbenchOpsReverse') : t('workbenchOpsForward'),
          )
        default:
          return `${op.type}`
      }
    })
  })

  /** 供对话流调用：AI 产出 ops 后进入人审（不直接执行） */
  function proposeCanvasOps(ops) {
    if (!isEmbed.value || !Array.isArray(ops) || !ops.length) return false
    opsResultMsg.value = ''
    pendingOps.value = ops
    return true
  }

  function discardPendingOps() {
    pendingOps.value = null
    opsResultMsg.value = ''
  }

  async function confirmApplyOps() {
    const ops = pendingOps.value
    if (!ops?.length || opsApplying.value) return
    opsApplying.value = true
    opsResultMsg.value = ''
    const reply = await callBridge(ARTIFY_MSG.CANVAS_OPS, { ops, reason: 'workbench-confirm' })
    opsApplying.value = false
    opsResultOk.value = !!reply.ok
    const applied = Number(reply.applied) || 0
    const failed = Array.isArray(reply.results)
      ? reply.results.filter((r) => r && r.ok === false)
      : []
    opsResultMsg.value = reply.ok
      ? t('workbenchOpsDone').replace('{n}', String(applied))
      : t('workbenchOpsFailed') + (reply.error ? `: ${reply.error}` : '')
    if (reply.ok && failed.length) {
      opsResultMsg.value += ` (${failed.length} failed)`
    }
    // 应用成功 3s 后收卡
    if (reply.ok) {
      setTimeout(() => {
        if (opsResultOk.value) {
          pendingOps.value = null
          opsResultMsg.value = ''
        }
      }, 3000)
    }
  }

  // ---------------- 模板同步与执行 ----------------

  /** 模板工作流 → 宿主画布（loadWorkflow 整图替换）；对外维持 throw 语义 */
  function syncWorkflowToCanvas({ name, workflow, ensureTab }) {
    if (!isEmbed.value) {
      if (ensureTab) return Promise.resolve({ ok: true, mode: 'skipped' })
      return Promise.reject(new Error(t('workbenchSyncNotEmbed')))
    }
    if (!workflow || !Array.isArray(workflow.nodes))
      return Promise.reject(new Error(t('workbenchSyncNoWorkflow')))
    return callBridge(ARTIFY_MSG.CANVAS_OPS, {
      ops: [{ type: 'loadWorkflow', workflow, newTab: ensureTab || undefined, name }],
      reason: 'workbench-sync-template',
    }).then((data) => (data.ok ? data : Promise.reject(new Error(data.error || 'unknown'))))
  }

  /** 执行画布当前工作流（graphToPrompt → /api/canvas/execute） */
  function runCanvasOnHost({ nodeOverrides, name, sessionId, batch }) {
    if (!isEmbed.value) return Promise.reject(new Error(t('workbenchSyncNotEmbed')))
    return callBridge(
      ARTIFY_MSG.CANVAS_EXECUTE,
      { nodeOverrides, name, sessionId, batch },
      { timeout: 10000 },
    ).then((data) => (data.ok ? data : Promise.reject(new Error(data.error || 'unknown'))))
  }

  return {
    deliverArtifact,
    canvasState,
    canvasAttachNotice,
    onWindowMessage,
    attachHostListeners,
    attachFiles,
    pendingOps,
    opsApplying,
    opsResultMsg,
    opsResultOk,
    opsDiffLines,
    proposeCanvasOps,
    discardPendingOps,
    confirmApplyOps,
    syncWorkflowToCanvas,
    runCanvasOnHost,
  }
}

/** 视频扩展名判定（lightbox/附件分类共用） */
export function isVideoFile(f) {
  return /\.(mp4|webm|mov|gif)$/i.test(f?.filename ?? '')
}
