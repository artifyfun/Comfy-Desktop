/**
 * 画布素材库 + 图层面板（composable）——canvas/index.vue 深拆（第四批③）。
 *
 * - 素材库（P2）：localStorage 图片资产 CRUD（超限丢弃最旧）+ 入画布
 *   （persist dataURL 建等比 ≤260px image 节点）
 * - 图层面板（P1）：悬停联动 id + 点击行 450ms easeOutCubic 动画居中
 * 依赖（objects/selection/viewport/saveSoon 等）经 deps 注入。
 */
import { ref } from 'vue'

const ASSETS_KEY = 'artify.canvas.assets.v1'

/**
 * @param deps { objects, selection, viewport, size, screenToWorld,
 *               beforeChange, saveSoon, applyViewport, selectedLinkId, ctxMenu }
 */
export function useCanvasAssets(deps) {
  const {
    objects,
    selection,
    viewport,
    size,
    screenToWorld,
    beforeChange,
    saveSoon,
    applyViewport,
  } = deps

  const assetsOpen = ref(false)
  const assets = ref(JSON.parse(localStorage.getItem(ASSETS_KEY) || '[]'))

  function saveAssets() {
    // dataURL 较大，超限（~4MB）时丢弃最旧的并提示
    try {
      localStorage.setItem(ASSETS_KEY, JSON.stringify(assets.value))
    } catch {
      if (assets.value.length > 1) {
        assets.value.shift()
        saveAssets()
      }
    }
  }

  function assetAdded(a) {
    assets.value.unshift({ id: 'a' + Date.now() + Math.random().toString(36).slice(2, 5), ...a })
    saveAssets()
  }

  function assetRemoved(id) {
    assets.value = assets.value.filter((x) => x.id !== id)
    saveAssets()
  }

  /** 视口中心的世界坐标（素材点击落点） */
  function centerWorld() {
    return screenToWorld(viewport.value, size.w / 2, size.h / 2)
  }

  /** 素材入画布：persist dataURL 直接建 image 节点（等比 ≤260px） */
  function insertAsset(a, wx, wy) {
    const probe = new Image()
    probe.onload = () => {
      const scale = Math.min(1, 260 / probe.naturalWidth)
      const o = {
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: Math.round(wx),
        y: Math.round(wy),
        width: Math.round(probe.naturalWidth * scale),
        height: Math.round(probe.naturalHeight * scale),
        src: probe.src,
        persist: probe.src,
      }
      beforeChange()
      objects.value.push(o)
      selection.value = [o.id]
      saveSoon()
    }
    probe.src = a.persist
  }

  // —— 图层面板（P1：画布侧板）——
  const hoverFromPanel = ref(null) // 面板悬停的物件 id（预留画布侧高亮联动）
  let layersFocusAnim = null // 图层定位的 rAF 句柄

  /** 图层树点击行：选中该物件并以 450ms easeOutCubic 动画居中（参考 focusNode） */
  function focusObject(id) {
    const o = objects.value.find((x) => x.id === id)
    if (!o) return
    selection.value = [id]
    deps.selectedLinkId.value = null
    if (deps.ctxMenu.value) deps.ctxMenu.value = null
    const wx = o.x + o.width / 2
    const wy = o.y + o.height / 2
    const k = Math.min(
      Math.max(Math.min((size.w * 0.6) / o.width, (size.h * 0.6) / o.height), 0.1),
      1,
    )
    const target = {
      x: size.w / 2 - wx * k,
      y: size.h / 2 - wy * k,
      scale: k,
    }
    if (layersFocusAnim) cancelAnimationFrame(layersFocusAnim)
    const start = { ...viewport.value }
    const duration = 450
    const ease = (p) => 1 - Math.pow(1 - p, 3)
    let t0 = null
    const step = (now) => {
      if (t0 === null) t0 = now
      const p = Math.min((now - t0) / duration, 1)
      const e = ease(p)
      viewport.value = {
        scale: start.scale + (target.scale - start.scale) * e,
        x: start.x + (target.x - start.x) * e,
        y: start.y + (target.y - start.y) * e,
      }
      applyViewport()
      layersFocusAnim = p < 1 ? requestAnimationFrame(step) : null
    }
    layersFocusAnim = requestAnimationFrame(step)
    saveSoon()
  }

  return {
    assetsOpen,
    assets,
    assetAdded,
    assetRemoved,
    centerWorld,
    insertAsset,
    hoverFromPanel,
    focusObject,
  }
}
