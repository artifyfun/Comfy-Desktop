/**
 * 节点级图像编辑（S6a composable）：旋转 ±90°/180°（原地）、切分（横/竖 N 片→子节点）、圈选裁剪（crop 矩形与所压图片交集 → 新图发工作台）。
 * 外部依赖经 deps 注入；从 canvas/index.vue 逐字搬移（第五批）。
 */
import { reactive, ref, computed } from 'vue'

export function useImageEdit(deps) {
  const { objects, selection, links, saveSoon, beforeChange, message, t } = deps

  // —— S6a 节点级图像编辑：旋转 ±90°/180°（原地）、切分（横/竖 N 片→子节点）、
  // 裁剪（进 crop 模式圈选，已有 canvas 级链路复用） ——
  async function imageToCanvasEl(o) {
    const img = await fetchImageForCrop(o.src)
    return img
  }
  async function rotateImageNode(id, deg) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'image' || !o.src) return
    let img
    try {
      img = await imageToCanvasEl(o)
    } catch {
      message.warning(t('canvasCropNoImage'))
      return
    }
    const d = ((Math.round(deg / 90) % 4) + 4) % 4
    // fetchImageForCrop 可能返回 ImageBitmap（width/height）或 HTMLImageElement
    // （naturalWidth/naturalHeight），两者兼容取值
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const sz = rotatedSize(iw, ih, d * 90)
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(sz.w))
    cv.height = Math.max(1, Math.round(sz.h))
    const ctx = cv.getContext('2d')
    ctx.translate(cv.width / 2, cv.height / 2)
    ctx.rotate((d * Math.PI) / 2)
    ctx.drawImage(img, -iw / 2, -ih / 2)
    cv.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      beforeChange()
      const nsz = rotatedSize(o.width, o.height, d * 90)
      o.src = url
      o.width = nsz.w
      o.height = nsz.h
      persistImage(o)
      saveSoon()
    }, 'image/png')
  }
  const splitDlg = reactive({ open: false, id: null, n: 2, dir: 'h' })
  async function splitImageNode(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'image' || !o.src) return
    splitDlg.open = true
    splitDlg.id = id
    splitDlg.n = 2
    splitDlg.dir = 'h'
  }
  async function applySplit() {
    const o = objects.value.find((x) => x.id === splitDlg.id)
    if (!o || !splitDlg.open) return
    splitDlg.open = false
    let img
    try {
      img = await imageToCanvasEl(o)
    } catch {
      message.warning(t('canvasCropNoImage'))
      return
    }
    const iw = img.naturalWidth || img.width
    const ih = img.naturalHeight || img.height
    const rects = splitRects(iw, ih, splitDlg.n, splitDlg.dir)
    const scale = o.width / iw
    beforeChange()
    rects.forEach((r, i) => {
      const cv = document.createElement('canvas')
      cv.width = Math.max(1, Math.round(r.w))
      cv.height = Math.max(1, Math.round(r.h))
      const ctx = cv.getContext('2d')
      ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, cv.width, cv.height)
      cv.toBlob((blob) => {
        if (!blob) return
        const url = URL.createObjectURL(blob)
        const node = {
          id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
          type: 'image',
          x:
            o.x +
            (splitDlg.dir === 'h' ? r.x * scale : 0) +
            (splitDlg.dir === 'v' ? o.width + 40 : 0),
          y:
            o.y +
            (splitDlg.dir === 'v' ? r.y * scale : 0) +
            (splitDlg.dir === 'h' ? o.height + 40 : 0),
          width: Math.max(20, Math.round(r.w * scale)),
          height: Math.max(20, Math.round(r.h * scale)),
          src: url,
          persist: null,
        }
        objects.value.push(node)
        persistImage(node)
        links.value.push({
          id: 'l' + Date.now() + Math.random().toString(36).slice(2, 6) + i,
          from: o.id,
          to: node.id,
        })
        saveSoon()
      }, 'image/png')
    })
    message.success(t('canvasSplitDone').replace('{n}', String(rects.length)))
  }
  /** 节点级裁剪：进 crop 模式并选中该图（圈选已有链路：cropRectFor→canvas 裁剪→新节点） */
  function cropImageNode(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o || o.type !== 'image') return
    selection.value = [id]
    setTool('crop')
  }

  return {
    splitDlg,
    imageToCanvasEl,
    rotateImageNode,
    splitImageNode,
    applySplit,
    cropImageNode,
  }
}
