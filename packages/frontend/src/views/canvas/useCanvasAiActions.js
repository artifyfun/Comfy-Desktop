/**
 * 画布 AI 指令编排（useCanvasAiActions）——A2 第三块抽取。
 *
 * 原 index.vue 内联 3754-4121（~368 行）的六簇编排：
 * - 选区指令条（selPrompt / runSelPrompt / composeSelection）
 * - note→生图自动编排（genFromNote / startGenerateFromNote / maybeRunGenFromNote）
 * - note AI 改写（noteRewrite 状态 + runNoteRewrite——含唯一外呼
 *   POST /api/optimize-prompt，经 optimizePromptFn 注入收口）
 * - 图→提示词溯源（copyImagePrompt / showImageGenInfo）
 * - 视频截帧（captureVideoFrameAt）
 * - 任意角度旋转 / 无损放大（applyAngle / applyUpscale）
 *
 * 依赖注入（ctx）：objects/links/selection/viewport 等共享响应式源 +
 * beforeChange/saveSoon/persistImage/emitPrompt/runAppNode/appPicker/refOf。
 * 纯编排逻辑（发什么指令、建什么节点、连什么线）在本模块 interface 内，
 * DOM/canvas/fetch 副作用经参数或注入函数隔离。
 */
import { ref, reactive, computed, watch, nextTick } from 'vue'
import { message, Modal } from 'ant-design-vue'
import { h } from 'vue'
import { worldToScreen, screenToWorld } from './engine'

export function useCanvasAiActions(ctx) {
  const {
    objects,
    links,
    selection,
    viewport,
    size,
    refOf,
    t,
    beforeChange,
    saveSoon,
    persistImage,
    emitPrompt,
    runAppNode,
    appPicker,
    serverOrigin,
    appStore,
    closeCtxMenu,
    fetchImageForCrop,
    videoFrameTime,
    upscaleSize,
    optimizePromptFn,
  } = ctx

  // ---------------- 选区指令条 ----------------
  const selPrompt = ref(null)
  let lastSourceIds = []

  function runSelPrompt() {
    const text = (selPrompt.value?.text || '').trim()
    if (!text) return
    const refs = selection.value.map(refOf).filter(Boolean)
    lastSourceIds = [...selection.value]
    emitPrompt(text, { autoSend: true, attachments: refs })
    selPrompt.value = null
    message.success(t('canvasSelPromptSent'))
  }

  // —— A3 参考图合成（多选 → 工作台合成指令） ——
  function composeSelection() {
    const imgs = selection.value.filter(
      (id) => (objects.value.find((o) => o.id === id) || {}).type === 'image',
    )
    if (imgs.length < 2) return
    const refs = imgs.map(refOf).filter(Boolean)
    lastSourceIds = [...imgs]
    emitPrompt(t('canvasComposePrompt'), { autoSend: true, attachments: refs })
    selPrompt.value = null
    closeCtxMenu?.()
    message.success(t('canvasSelPromptSent'))
  }

  // ---------------- N3 生成节点（prompt 卡弹窗） ----------------
  const genNode = ref(null)

  // ---------------- S5a note→生图自动编排 ----------------
  const genFromNote = ref(null)
  function startGenerateFromNote(noteId) {
    const note = objects.value.find((o) => o.id === noteId)
    if (!note || note.type !== 'note') return
    if (!String(note.text || '').trim()) {
      message.warning(t('canvasGenNeedText'))
      return
    }
    genFromNote.value = { noteId }
    const wx = note.x + note.width + 80
    const wy = note.y
    appPicker.wx = wx
    appPicker.wy = wy
    appPicker.open = true
  }

  /** picker 选中后：建连线 + 立即运行（collectUpstream 沿新连线吃到 note 文本） */
  function maybeRunGenFromNote(node) {
    const req = genFromNote.value
    genFromNote.value = null
    if (!req) return
    const note = objects.value.find((o) => o.id === req.noteId)
    if (!note) return
    beforeChange()
    links.value.push({
      id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6),
      from: note.id,
      to: node.id,
    })
    saveSoon()
    message.info(t('canvasGenFlowStarted'))
    nextTick(() => runAppNode(node.id))
  }

  // ---------------- S5b note AI 改写 ----------------
  const noteRewriteInput = ref(null)
  const noteRewrite = reactive({ noteId: null, instruction: '', running: false })
  watch(
    () => noteRewrite.noteId,
    (v) => {
      if (v) nextTick(() => noteRewriteInput.value?.focus?.())
    },
  )

  function startNoteRewrite(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'note') return
    noteRewrite.noteId = noteRewrite.noteId === id ? null : id
    noteRewrite.instruction = ''
  }

  const noteRewritePos = computed(() => {
    const o = objects.value.find((x) => x.id === noteRewrite.noteId)
    if (!o) return { x: 0, y: 0 }
    const tl = worldToScreen(viewport.value, o.x, o.y)
    return {
      x: clampNum(tl.x, 8, Math.max(8, size.w - 380)),
      y: clampNum(tl.y + o.height * viewport.value.scale + 8, 8, size.h - 60),
    }
  })

  async function runNoteRewrite() {
    const src = objects.value.find((x) => x.id === noteRewrite.noteId)
    const instruction = noteRewrite.instruction.trim()
    if (!src || noteRewrite.running || !instruction || !String(src.text || '').trim()) return
    noteRewrite.running = true
    try {
      const composed = `${t('canvasRewriteCompose').replace('{i}', instruction)}\n\n${src.text}`
      const j = await optimizePromptFn(composed)
      const out = j?.data?.optimizedPrompt || j?.optimizedPrompt || ''
      if (!out) throw new Error(j?.message || 'empty result')
      beforeChange()
      const nn = {
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'note',
        x: src.x + src.width + 80,
        y: src.y,
        width: src.width,
        height: src.height,
        text: out,
        fontSize: src.fontSize || 13,
      }
      objects.value.push(nn)
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6),
        from: src.id,
        to: nn.id,
      })
      selection.value = [nn.id]
      saveSoon()
      noteRewrite.noteId = null
      message.success(t('canvasRewriteDone'))
    } catch (e) {
      message.error(t('canvasRewriteFailed') + ': ' + String(e?.message || e).slice(0, 80))
    } finally {
      noteRewrite.running = false
    }
  }

  // ---------------- B2 图→提示词溯源 ----------------
  async function copyImagePrompt(id) {
    const o = objects.value.find((x) => x.id === id)
    const prompt = o?.meta?.prompt
    if (!prompt) {
      message.warning(t('canvasNoPromptMeta'))
      return
    }
    try {
      await navigator.clipboard.writeText(prompt)
      message.success(t('canvasPromptCopied'))
    } catch {
      const div = document.createElement('textarea')
      div.value = prompt
      document.body.appendChild(div)
      div.select()
      try {
        document.execCommand('copy')
        message.success(t('canvasPromptCopied'))
      } catch {
        message.error(t('canvasCopyFailed'))
      }
      div.remove()
    }
  }

  function showImageGenInfo(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o?.meta) {
      message.warning(t('canvasNoPromptMeta'))
      return
    }
    const lines = [
      o.meta.app ? t('canvasGenInfoApp') + ': ' + o.meta.app : null,
      o.meta.prompt ? t('canvasGenInfoPrompt') + ': ' + o.meta.prompt : null,
      o.meta.at ? t('canvasGenInfoAt') + ': ' + new Date(o.meta.at).toLocaleString() : null,
    ].filter(Boolean)
    Modal.info({
      title: t('canvasGenInfoTitle'),
      content: h(
        'div',
        { style: 'max-height:260px;overflow:auto;white-space:pre-wrap;font-size:12px' },
        lines.join('\n'),
      ),
    })
  }

  // ---------------- A1 视频截帧 ----------------
  async function captureVideoFrameAt(id, position) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'video' || !o.src) return
    const el = document.querySelector(`[data-media-node="${id}"]`)
    const ct = el && el.tagName === 'VIDEO' ? el.currentTime : 0
    const video = document.createElement('video')
    video.muted = true
    video.playsInline = true
    video.preload = 'auto'
    video.crossOrigin = 'anonymous'
    const waitEvent = (ev) =>
      new Promise((resolve, reject) => {
        const done = () => {
          video.removeEventListener(ev, done)
          video.removeEventListener('error', fail)
          resolve()
        }
        const fail = () => {
          video.removeEventListener(ev, done)
          video.removeEventListener('error', fail)
          reject(new Error('video load failed'))
        }
        video.addEventListener(ev, done)
        video.addEventListener('error', fail)
      })
    try {
      const meta = waitEvent('loadedmetadata')
      video.src = o.src
      video.load()
      await meta
      const time = videoFrameTime(position, video.duration, ct)
      if (time > 0) {
        const seeked = waitEvent('seeked')
        video.currentTime = time
        await seeked
      } else if (video.readyState < 2) {
        await waitEvent('loadeddata')
      }
      const cv = document.createElement('canvas')
      cv.width = video.videoWidth
      cv.height = video.videoHeight
      cv.getContext('2d').drawImage(video, 0, 0)
      const blob = await new Promise((r) => cv.toBlob(r, 'image/png'))
      if (!blob) throw new Error('toBlob null')
      const url = URL.createObjectURL(blob)
      const ratio = Math.min(1, 240 / cv.width)
      beforeChange()
      const node = {
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: o.x + o.width + 60,
        y: o.y,
        width: Math.max(20, Math.round(cv.width * ratio)),
        height: Math.max(20, Math.round(cv.height * ratio)),
        src: url,
        persist: null,
      }
      objects.value.push(node)
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6),
        from: o.id,
        to: node.id,
      })
      persistImage(node)
      selection.value = [node.id]
      saveSoon()
    } catch (e) {
      message.error(t('canvasFrameFailed') + ': ' + String(e?.message || e).slice(0, 60))
    } finally {
      video.removeAttribute('src')
      video.load()
    }
  }

  // ---------------- A2 任意角度旋转 ----------------
  const angleDlg = reactive({ open: false, id: null, deg: 0, flipH: false, flipV: false })
  async function applyAngle() {
    const o = objects.value.find((x) => x.id === angleDlg.id)
    const { deg, flipH, flipV } = angleDlg
    if (!o || o.type !== 'image' || !o.src) return
    angleDlg.open = false
    let img
    try {
      img = await fetchImageForCrop(o.src)
    } catch {
      message.warning(t('canvasCropNoImage'))
      return
    }
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const pad = Math.round(Math.max(iw, ih) * 0.18)
    const cv = document.createElement('canvas')
    cv.width = iw + pad * 2
    cv.height = ih + pad * 2
    const c = cv.getContext('2d')
    c.translate(cv.width / 2, cv.height / 2)
    c.rotate((Number(deg) * Math.PI) / 180)
    c.scale(flipH ? -1 : 1, flipV ? -1 : 1)
    c.drawImage(img, -iw / 2, -ih / 2)
    cv.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      beforeChange()
      const k = (o.width || 1) / (iw || 1)
      o.src = url
      o.width = Math.max(20, Math.round(cv.width * k))
      o.height = Math.max(20, Math.round(cv.height * k))
      persistImage(o)
      saveSoon()
    }, 'image/png')
  }

  // ---------------- A3 无损放大 ----------------
  const upscaleDlg = reactive({ open: false, id: null, target: 2048, algo: 'high' })
  async function applyUpscale() {
    const o = objects.value.find((x) => x.id === upscaleDlg.id)
    if (!o || o.type !== 'image' || !o.src) return
    upscaleDlg.open = false
    let img
    try {
      img = await fetchImageForCrop(o.src)
    } catch {
      message.warning(t('canvasCropNoImage'))
      return
    }
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const sz = upscaleSize(iw, ih, upscaleDlg.target)
    if (sz.width <= iw && sz.height <= ih) {
      message.warning(t('canvasUpscaleSkip'))
      return
    }
    let src = img
    let sw = iw
    let sh = ih
    const steps = []
    while (sw * 2 < sz.width && sh * 2 < sz.height) {
      steps.push({ w: sw * 2, h: sh * 2 })
      sw *= 2
      sh *= 2
    }
    steps.push({ w: sz.width, h: sz.height })
    for (const st of steps) {
      const cv = document.createElement('canvas')
      cv.width = st.w
      cv.height = st.h
      const c2 = cv.getContext('2d')
      c2.imageSmoothingEnabled = true
      c2.imageSmoothingQuality = 'high'
      c2.drawImage(src, 0, 0, cv.width, cv.height)
      src = cv
    }
    const out = src
    out.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      beforeChange()
      o.src = url
      persistImage(o)
      saveSoon()
      message.success(
        t('canvasUpscaleDone').replace('{w}', String(sz.width)).replace('{h}', String(sz.height)),
      )
    }, 'image/png')
  }

  return {
    selPrompt,
    runSelPrompt,
    composeSelection,
    genNode,
    genFromNote,
    startGenerateFromNote,
    maybeRunGenFromNote,
    noteRewriteInput,
    noteRewrite,
    noteRewritePos,
    startNoteRewrite,
    runNoteRewrite,
    copyImagePrompt,
    showImageGenInfo,
    captureVideoFrameAt,
    angleDlg,
    applyAngle,
    upscaleDlg,
    applyUpscale,
    lastSourceIds: () => lastSourceIds,
  }
}

/** 本地 clamp（避免循环依赖 engine 的具名导入集合变化） */
function clampNum(v, min, max) {
  return Math.min(max, Math.max(min, v))
}
