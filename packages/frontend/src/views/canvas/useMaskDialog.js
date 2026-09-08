/**
 * 蒙版编辑对话框（D1a composable）——canvas/index.vue 深拆（第五批）。
 *
 * 双 canvas：隐藏 mask（黑笔触，序列化用）+ 预览叠加（蓝半透明）。笔触历史
 * 数组支撑 undo/redo（重放）。Alt+水平拖 = 调笔刷。提交 = prompt + mask
 * 附件发工作台。E1：编辑视口缩放/平移（滚轮/空格/中键）。
 * 外部依赖（objects/selection/emitPrompt 等 11 个）经 deps 注入。
 */
import { reactive, ref, computed, nextTick } from 'vue'
import {
  buildInpaintMask,
  clampBrushSize,
  maskCanvasPoint,
  maskHasPaint,
  hitTest,
} from './engine'

const MASK_PREVIEW_COLOR = 'rgba(59,130,246,0.45)'

export function useMaskDialog(deps) {
  const {
    objects,
    selection,
    viewport,
    size,
    saveSoon,
    emitPrompt,
    message,
    ctxMenu,
    t,
    screenToWorld,
    clamp,
    refOf,
  } = deps

  // —— D1a 蒙版编辑对话框（对齐参考 canvas-node-mask-edit-dialog）——
  // 双 canvas：隐藏 mask（黑笔触，序列化用）+ 预览叠加（蓝半透明）。笔触历史数组
  // 支撑 undo/redo（重放）。Alt+水平拖 = 调笔刷。提交 = prompt + mask 附件发工作台。
  const maskDlg = reactive({
    open: false,
    id: null,
    imgW: 0,
    imgH: 0,
    prompt: '',
    brush: 100,
    mode: 'paint', // paint | erase
    drawing: false,
    brushAdjust: null, // {startX, startSize}
    strokes: [], // {mode,size,points:[]}
    redoStack: [],
    cursor: null, // {x,y} 预览圆（stage 坐标）
    error: '',
    view: 1, // E1：编辑视口缩放（1..4，滚轮/按钮，指针锚定）
    fitScale: 1, // E1：图适配视口的基准比例（stage 内容 = 原图 * fitScale * view）
    panning: false, // E1：空格/中键平移中
    spaceDown: false, // E1：空格按住（平移模式）
  })
  /** E1：蒙版编辑 stage 尺寸（适配 × 缩放） */
  const maskStageSize = computed(() => ({
    w: Math.round(maskDlg.imgW * maskDlg.fitScale * maskDlg.view),
    h: Math.round(maskDlg.imgH * maskDlg.fitScale * maskDlg.view),
  }))
  /** E1：stage 1px = 原图多少像素（笔刷/坐标换算） */
  const maskImageScale = computed(
    () => (maskDlg.imgW ? maskStageSize.value.w / maskDlg.imgW : 1) || 1,
  )
  const maskCanvasEl = ref(null) // 隐藏 mask
  const maskPreviewEl = ref(null) // 预览叠加
  const MASK_PREVIEW_COLOR = 'rgba(37, 99, 235, .38)'
  function openMaskDialog(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'image') return
    const img = new Image()
    img.onload = () => {
      maskDlg.id = id
      maskDlg.imgW = img.naturalWidth || img.width
      maskDlg.imgH = img.naturalHeight || img.height
      maskDlg.prompt = ''
      maskDlg.brush = Math.round(clampBrushSize(Math.max(maskDlg.imgW, maskDlg.imgH) * 0.12))
      maskDlg.mode = 'paint'
      maskDlg.drawing = false
      maskDlg.brushAdjust = null
      maskDlg.strokes = []
      maskDlg.redoStack = []
      maskDlg.cursor = null
      maskDlg.error = ''
      maskDlg.view = 1
      maskDlg.panning = false
      maskDlg.spaceDown = false
      maskDlg.open = true
      // src 落位后清画布 + 适配视口
      nextTick(() => {
        for (const el of [maskCanvasEl.value, maskPreviewEl.value]) {
          if (!el) continue
          el.width = maskDlg.imgW
          el.height = maskDlg.imgH
          el.getContext('2d')?.clearRect(0, 0, el.width, el.height)
        }
        maskFitViewport()
      })
    }
    img.onerror = () => message.error(t('canvasCropNoImage'))
    img.src = o.src
  }
  function maskStrokeCtx(ctx, stroke) {
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
    ctx.lineWidth = stroke.size
    ctx.globalCompositeOperation = stroke.mode === 'paint' ? 'source-over' : 'destination-out'
  }
  function drawMaskSeg(ctx, from, to, size) {
    if (from.x === to.x && from.y === to.y) {
      ctx.beginPath()
      ctx.arc(to.x, to.y, size / 2, 0, Math.PI * 2)
      ctx.fill()
      return
    }
    ctx.beginPath()
    ctx.moveTo(from.x, from.y)
    ctx.lineTo(to.x, to.y)
    ctx.stroke()
  }
  function replayMaskStrokes() {
    const mc = maskCanvasEl.value
    const pc = maskPreviewEl.value
    if (!mc || !pc) return
    const mctx = mc.getContext('2d', { willReadFrequently: true })
    const pctx = pc.getContext('2d')
    if (!mctx || !pctx) return
    mctx.clearRect(0, 0, mc.width, mc.height)
    pctx.clearRect(0, 0, pc.width, pc.height)
    for (const st of maskDlg.strokes) {
      maskStrokeCtx(mctx, st)
      mctx.strokeStyle = '#000'
      mctx.fillStyle = '#000'
      maskStrokeCtx(pctx, st)
      pctx.strokeStyle = MASK_PREVIEW_COLOR
      pctx.fillStyle = MASK_PREVIEW_COLOR
      st.points.forEach((pt, i) => {
        const prev = st.points[i - 1] || pt
        drawMaskSeg(mctx, prev, pt, st.size)
        drawMaskSeg(pctx, prev, pt, st.size)
      })
    }
  }
  /** E1：适配视口 —— 图等比缩到可视区内（padding 24），记基准比例 */
  function maskFitViewport() {
    const vp = maskViewportEl.value
    if (!vp || !maskDlg.imgW) return
    const availW = Math.max(1, vp.clientWidth - 48)
    const availH = Math.max(1, vp.clientHeight - 48)
    const sc = Math.min(availW / maskDlg.imgW, availH / maskDlg.imgH, 1)
    maskDlg.fitScale = sc > 0 ? sc : 1
    maskDlg.view = 1
    nextTick(() => {
      vp.scrollLeft = (vp.scrollWidth - vp.clientWidth) / 2
      vp.scrollTop = (vp.scrollHeight - vp.clientHeight) / 2
    })
  }
  /** E1：滚轮缩放（指针锚定：缩放后保持指针下的图像点不动） */
  function onMaskWheel(e) {
    e.preventDefault()
    const vp = maskViewportEl.value
    if (!vp) return
    const next = clamp(maskDlg.view * (e.deltaY < 0 ? 1.2 : 1 / 1.2), 1, 4)
    if (Math.abs(next - maskDlg.view) < 0.001) return
    // 指针在 stage 内的相对比例
    const rect = maskPreviewEl.value?.getBoundingClientRect()
    const anchor = rect
      ? {
          rx: clamp((e.clientX - rect.left) / Math.max(1, rect.width), 0, 1),
          ry: clamp((e.clientY - rect.top) / Math.max(1, rect.height), 0, 1),
          vx: e.clientX - vp.getBoundingClientRect().left,
          vy: e.clientY - vp.getBoundingClientRect().top,
        }
      : null
    maskDlg.view = next
    if (!anchor) return
    nextTick(() => {
      // stage 新尺寸下把锚点拉回指针位置
      const st = maskStageSize.value
      vp.scrollLeft =
        Math.max(0, (Math.max(vp.clientWidth, st.w) - st.w) / 2) + anchor.rx * st.w - anchor.vx
      vp.scrollTop =
        Math.max(0, (Math.max(vp.clientHeight, st.h) - st.h) / 2) + anchor.ry * st.h - anchor.vy
    })
  }
  /** E1：缩放按钮（中心锚定） */
  function maskZoom(dir) {
    const vp = maskViewportEl.value
    if (!vp) return
    const next = clamp(maskDlg.view * (dir > 0 ? 1.2 : 1 / 1.2), 1, 4)
    if (Math.abs(next - maskDlg.view) < 0.001) return
    const r = vp.getBoundingClientRect()
    onMaskWheel({
      preventDefault() {},
      deltaY: dir > 0 ? -1 : 1,
      clientX: r.left + r.width / 2,
      clientY: r.top + r.height / 2,
    })
  }
  /** E1：空格/中键平移（viewport 捕获指针，写 scrollLeft/Top） */
  function onMaskPanDown(e) {
    if (!(e.button === 1 || (e.button === 0 && maskDlg.spaceDown))) return
    const vp = e.currentTarget
    // 合成事件/已释放指针会抛 InvalidPointerId —— 捕获失败不影响拖拽本身
    try {
      vp.setPointerCapture?.(e.pointerId)
    } catch {
      /* 指针不存在（测试合成事件）：跳过捕获 */
    }
    maskPan.pt = { x: e.clientX, y: e.clientY, l: vp.scrollLeft, t: vp.scrollTop, id: e.pointerId }
    maskDlg.panning = true
    e.preventDefault()
    e.stopPropagation()
  }
  function onMaskPanMove(e) {
    const p = maskPan.pt
    if (!p || e.pointerId !== p.id) return
    const vp = maskViewportEl.value
    if (!vp) return
    vp.scrollLeft = p.l - (e.clientX - p.x)
    vp.scrollTop = p.t - (e.clientY - p.y)
    e.preventDefault()
    e.stopPropagation()
  }
  function onMaskPanUp(e) {
    const p = maskPan.pt
    if (!p || e.pointerId !== p.id) return
    maskPan.pt = null
    maskDlg.panning = false
  }
  const maskPan = reactive({ pt: null })
  const maskViewportEl = ref(null)
  /** E1：对话框空格键态（window 级，编辑器打开期间生效） */
  function onMaskKeydown(e) {
    if (e.code === 'Space' && !e.repeat) {
      const t = e.target
      if (t && t.closest && t.closest("input,textarea,[contenteditable='true']")) return
      e.preventDefault()
      maskDlg.spaceDown = true
    }
  }
  function onMaskKeyup(e) {
    if (e.code === 'Space') {
      e.preventDefault()
      maskDlg.spaceDown = false
    }
  }

  function onMaskPointerDown(e) {
    // E1：空格/中键平移由容器捕获处理，这里不抢
    if (maskDlg.panning || maskDlg.spaceDown) return
    if (e.button !== 0 && !e.altKey) return
    const el = e.currentTarget
    el.setPointerCapture?.(e.pointerId)
    // Alt+拖 = 调笔刷（参考 brushAdjust）
    if (e.altKey) {
      maskDlg.brushAdjust = { startX: e.clientX, startSize: maskDlg.brush }
      return
    }
    if (e.button !== 0) return
    maskDlg.drawing = true
    maskDlg.redoStack = []
    const st = { mode: maskDlg.mode, size: maskDlg.brush, points: [] }
    maskDlg.strokes.push(st)
    onMaskPointerMove(e)
  }
  function onMaskPointerMove(e) {
    const el = maskPreviewEl.value
    if (!el) return
    const rect = el.getBoundingClientRect()
    maskDlg.cursor = {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    }
    if (maskDlg.brushAdjust) {
      // E1：屏幕位移按视口缩放还原为图像像素
      maskDlg.brush = clampBrushSize(
        maskDlg.brushAdjust.startSize +
          (e.clientX - maskDlg.brushAdjust.startX) / maskImageScale.value,
      )
      return
    }
    if (!maskDlg.drawing) return
    const st = maskDlg.strokes[maskDlg.strokes.length - 1]
    if (!st) return
    const pt = maskCanvasPoint(el, e.clientX, e.clientY)
    const mctx = maskCanvasEl.value?.getContext('2d', { willReadFrequently: true })
    const pctx = el.getContext('2d')
    if (!mctx || !pctx) return
    maskStrokeCtx(mctx, st)
    mctx.strokeStyle = '#000'
    mctx.fillStyle = '#000'
    maskStrokeCtx(pctx, st)
    pctx.strokeStyle = MASK_PREVIEW_COLOR
    pctx.fillStyle = MASK_PREVIEW_COLOR
    const prev = st.points[st.points.length - 1] || pt
    drawMaskSeg(mctx, prev, pt, st.size)
    drawMaskSeg(pctx, prev, pt, st.size)
    st.points.push(pt)
  }
  function onMaskPointerUp() {
    if (maskDlg.brushAdjust) maskDlg.brushAdjust = null
    if (!maskDlg.drawing) return
    maskDlg.drawing = false
  }
  function undoMaskStroke() {
    if (maskDlg.drawing || !maskDlg.strokes.length) return
    maskDlg.redoStack.push(maskDlg.strokes.pop())
    replayMaskStrokes()
  }
  function redoMaskStroke() {
    if (maskDlg.drawing || !maskDlg.redoStack.length) return
    maskDlg.strokes.push(maskDlg.redoStack.pop())
    replayMaskStrokes()
  }
  function resetMaskDialog() {
    maskDlg.strokes = []
    maskDlg.redoStack = []
    replayMaskStrokes()
  }
  /** 提交蒙版编辑：mask 附件 + 原图引用 → 工作台局部重绘 */
  async function submitMaskDialog() {
    const prompt = maskDlg.prompt.trim()
    const mc = maskCanvasEl.value
    if (!prompt) {
      maskDlg.error = t('canvasMaskPromptRequired')
      return
    }
    if (!mc || !maskHasPaint(mc)) {
      maskDlg.error = t('canvasMaskRequired')
      return
    }
    const objId = maskDlg.id
    maskDlg.open = false
    // mask 序列化 → File（ComfyUI inpaint 兼容：白=保留 透=重绘）
    const dataUrl = buildInpaintMask(mc)
    const blob = await (await fetch(dataUrl)).blob()
    const maskFile = new File([blob], 'mask-' + Date.now() + '.png', { type: 'image/png' })
    // 原图引用（/view 直附；blob/dataURL 时转 File 附）
    const refs = [refOf(objId)].filter(Boolean)
    const o = objects.value.find((x) => x.id === objId)
    if (!refs.length && o?.src) {
      try {
        const b2 = await (await fetch(o.src)).blob()
        refs.push({
          filename: 'source-' + Date.now() + '.png',
          file: new File([b2], 'source-' + Date.now() + '.png', { type: b2.type || 'image/png' }),
        })
      } catch {
        /* 拿不到就只发 mask */
      }
    }
    refs.push({ filename: maskFile.name, file: maskFile })
    lastSourceIds = [objId]
    emitPrompt(prompt, { autoSend: true, attachments: refs })
    message.success(t('canvasAiQueued'))
  }

  // （D1a 起局部重绘改走 openMaskDialog 蒙版编辑器，旧的直发工作台路径已删）
  function startOutpaint(objId) {
    lastSourceIds = [objId]
    emitPrompt(t('canvasOutpaintPrompt'), {
      autoSend: true,
      attachments: [refOf(objId)].filter(Boolean),
    })
    message.info(t('canvasAiQueued'))
  }
  async function enhanceImage(objId) {
    const o = objects.value.find((x) => x.id === objId)
    if (!o) return
    lastSourceIds = [objId]
    emitPrompt(t('canvasEnhancePrompt'), {
      autoSend: true,
      attachments: [refOf(objId)].filter(Boolean),
    })
    message.info(t('canvasAiQueued'))
  }
  async function reversePrompt(objId) {
    lastSourceIds = [objId]
    emitPrompt(t('canvasReversePrompt'), {
      autoSend: true,
      attachments: [refOf(objId)].filter(Boolean),
    })
    message.info(t('canvasAiQueued'))
  }
  function imageToVideo(objId) {
    lastSourceIds = [objId]
    emitPrompt(t('canvasVideoPrompt'), {
      autoSend: true,
      attachments: [refOf(objId)].filter(Boolean),
    })
    message.info(t('canvasAiQueued'))
  }
  function setConsistencyAsset(objId, kind) {
    const o = objects.value.find((x) => x.id === objId)
    if (!o) return
    o.assetKind = kind // character | style：一致性标记，序列化随 doc 持久化
    saveSoon()
    message.success(
      (kind === 'character' ? t('canvasCharSet') : t('canvasStyleSet')).replace(
        '{name}',
        o.name || o.id.slice(-4),
      ),
    )
  }
  // 画布右键菜单（容器级 DOM 事件：Konva 层与空白统一在此处理）
  function onWrapContext(e) {
    const r = wrapEl.value.getBoundingClientRect()
    const sx = e.clientX - r.left
    const sy = e.clientY - r.top
    const w = screenToWorld(viewport.value, sx, sy)
    // hitTest 返回单个索引（-1 = 空地）；命中时若已选集合含该物件则整组操作
    const hit = hitTest(objects.value, w.x, w.y)
    const hitId = hit >= 0 ? objects.value[hit].id : null
    const targetIds =
      hitId && selection.value.length && selection.value.includes(hitId)
        ? selection.value
        : hitId
          ? [hitId]
          : []
    if (targetIds.length) selection.value = targetIds
    ctxMenu.value = { x: sx + 8, y: sy + 8, wx: w.x, wy: w.y, targetIds }
  }

  return {
    maskDlg,
    maskStageSize,
    maskImageScale,
    maskCanvasEl,
    maskPreviewEl,
    openMaskDialog,
    maskFitViewport,
    onMaskWheel,
    maskZoom,
    onMaskPanDown,
    onMaskPanMove,
    onMaskPanUp,
    onMaskKeydown,
    onMaskKeyup,
    onMaskPointerDown,
    onMaskPointerMove,
    onMaskPointerUp,
    undoMaskStroke,
    redoMaskStroke,
    resetMaskDialog,
    startOutpaint,
    imageToVideo,
    setConsistencyAsset,
    // 反推提示词 / 画质增强：右键菜单 runners 需要（原在 index.vue，随第五批出仓搬来）
    reversePrompt,
    enhanceImage,
    onWrapContext,
  }
}
