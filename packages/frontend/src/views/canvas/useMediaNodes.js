/**
 * 媒体节点（S4b video/audio composable）——拖入/上传 + overlay 播放器 + 存档。
 * 外部依赖经 deps 注入；从 canvas/index.vue 逐字搬移（第五批）。
 */
import { reactive, ref, computed } from 'vue'

export function useMediaNodes(deps) {
  const { objects, viewport, size, worldToScreen, saveSoon, beforeChange, message, t } = deps

  // —— 媒体节点（S4b video/audio）：拖入/上传 + overlay 播放器 + 存档 ——
  const mediaObjects = computed(() => withCull((o) => o.type === 'video' || o.type === 'audio'))
  /** 媒体节点屏幕矩形（overlay 定位） */
  function mediaPosOf(o) {
    const tl = worldToScreen(viewport.value, o.x, o.y)
    return {
      x: tl.x,
      y: tl.y,
      w: o.width * viewport.value.scale,
      h: o.height * viewport.value.scale,
    }
  }
  /** 从文件建媒体节点；视频取首帧定尺寸，音频固定 280x96 */
  function addMediaFromFile(f, wx, wy, onSized) {
    const isVideo = f.type.startsWith('video/')
    const url = URL.createObjectURL(f)
    const o = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
      type: isVideo ? 'video' : 'audio',
      x: wx,
      y: wy,
      width: isVideo ? 320 : 280,
      height: isVideo ? 180 : 96,
      src: url,
      persist: null,
      name: f.name,
    }
    objects.value.push(o)
    saveSoon()
    if (isVideo) {
      // 视频元信息定尺寸（最大 320 宽，16:9 兜底）
      const probe = document.createElement('video')
      probe.preload = 'metadata'
      probe.onloadedmetadata = () => {
        const ratio = probe.videoHeight / probe.videoWidth || 0.5625
        o.width = Math.min(320, Math.max(160, probe.videoWidth))
        o.height = Math.round(o.width * ratio)
        onSized?.(o.height)
        saveSoon()
      }
      probe.src = url
    } else {
      onSized?.(o.height)
    }
    // 存档：小文件 dataURL 内嵌；大文件只留会话（toast 告知刷新丢失）
    if (f.size <= 4 * 1024 * 1024) {
      const rd = new FileReader()
      rd.onload = () => {
        o.persist = rd.result
        saveSoon()
      }
      rd.readAsDataURL(f)
    } else {
      message.warning(t('canvasMediaTooBig'))
    }
  }
  /** 工具栏/占位点击上传媒体（替换或新建；D1b 图片同支持） */
  function uploadMediaFor(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o) return
    const isImage = o.type === 'image'
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = o.type === 'video' ? 'video/*' : o.type === 'audio' ? 'audio/*' : 'image/*'
    input.onchange = () => {
      const f = input.files?.[0]
      if (!f) return
      const url = URL.createObjectURL(f)
      beforeChange()
      o.src = url
      o.name = f.name
      o.persist = null
      // D1b：替换图片时清掉旧产物的生成元数据（mask/prompt 已不代表新图）
      if (isImage) o.meta = undefined
      if (isImage) {
        // 尺寸自适应：保持显示宽度，按新图比例调整高度（对齐拖入图片的 260 上限）
        const probe = new Image()
        probe.onload = () => {
          const scale = Math.min(1, 260 / probe.naturalWidth)
          const w = Math.round(probe.naturalWidth * scale)
          const h = Math.round(probe.naturalHeight * scale)
          // 中心不动：x/y 按新尺寸微调，视觉上图片中心保持
          const cx = o.x + o.width / 2
          const cy = o.y + o.height / 2
          o.width = w
          o.height = h
          o.x = Math.round(cx - w / 2)
          o.y = Math.round(cy - h / 2)
          persistImage(o)
          saveSoon()
        }
        probe.src = url
        return
      }
      if (f.size <= 4 * 1024 * 1024) {
        const rd = new FileReader()
        rd.onload = () => {
          o.persist = rd.result
          saveSoon()
        }
        rd.readAsDataURL(f)
      }
      saveSoon()
    }
    input.click()
  }
  /** 载入时恢复媒体 src（persist dataURL → src） */
  watch(mediaObjects, (list) => {
    for (const o of list) {
      if (!o.src && o.persist) o.src = o.persist
    }
  })

  return {
    mediaObjects,
    mediaPosOf,
    addMediaFromFile,
    uploadMediaFor,
  }
}
