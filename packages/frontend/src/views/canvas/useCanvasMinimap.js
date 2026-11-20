/**
 * 画布 minimap（composable）——canvas/index.vue 深拆（第四批③）。
 *
 * 全景投影（物件 bbox ∪ 视口框等比缩到 160×110）+ 点击/拖动巡视
 * （小窗坐标 → 世界坐标 → 居中平移，缩放不变）。只读 objects/viewport，
 * 依赖经 deps 注入，可独立单测。
 */
import { computed } from 'vue'

const MINI_W = 160
const MINI_H = 110
const MINI_PAD = 10

/**
 * @param deps { objects, viewport, size, applyViewport, saveSoon }
 */
export function useCanvasMinimap(deps) {
  const { objects, viewport, size, applyViewport, saveSoon } = deps

  const mini = computed(() => {
    const b = bboxOf(objects.value)
    let x0 = b.x,
      y0 = b.y,
      x1 = b.x + b.width,
      y1 = b.y + b.height
    // 把当前视口也纳入范围
    const vw = size.w / viewport.value.scale
    const vh = size.h / viewport.value.scale
    const vx0 = -viewport.value.x / viewport.value.scale
    const vy0 = -viewport.value.y / viewport.value.scale
    x0 = Math.min(x0, vx0)
    y0 = Math.min(y0, vy0)
    x1 = Math.max(x1, vx0 + vw)
    y1 = Math.max(y1, vy0 + vh)
    const s = Math.min((MINI_W - MINI_PAD * 2) / (x1 - x0), (MINI_H - MINI_PAD * 2) / (y1 - y0))
    return { x0, y0, s }
  })

  const miniItems = computed(() =>
    objects.value.map((o) => ({
      id: o.id,
      type: o.type,
      status: o.status,
      x: MINI_PAD + (o.x - mini.value.x0) * mini.value.s,
      y: MINI_PAD + (o.y - mini.value.y0) * mini.value.s,
      w: Math.max(4, o.width * mini.value.s),
      h: Math.max(3, o.height * mini.value.s),
    })),
  )

  const miniView = computed(() => {
    const vx0 = -viewport.value.x / viewport.value.scale
    const vy0 = -viewport.value.y / viewport.value.scale
    return {
      x: MINI_PAD + (vx0 - mini.value.x0) * mini.value.s,
      y: MINI_PAD + (vy0 - mini.value.y0) * mini.value.s,
      w: (size.w / viewport.value.scale) * mini.value.s,
      h: (size.h / viewport.value.scale) * mini.value.s,
    }
  })

  function miniJump(e) {
    const el = e.currentTarget
    const r = el.getBoundingClientRect()
    // 小窗坐标 → 世界坐标 → 居中该点
    const moveTo = (cx, cy) => {
      const wx = mini.value.x0 + (cx - r.left - MINI_PAD) / mini.value.s
      const wy = mini.value.y0 + (cy - r.top - MINI_PAD) / mini.value.s
      viewport.value = {
        scale: viewport.value.scale,
        x: size.w / 2 - wx * viewport.value.scale,
        y: size.h / 2 - wy * viewport.value.scale,
      }
      applyViewport()
    }
    moveTo(e.clientX, e.clientY)
    // 拖动巡视：指针捕获后跟随 move，仅 x/y 平移（同参考实现，缩放不变）
    el.setPointerCapture?.(e.pointerId)
    const onMove = (ev) => moveTo(ev.clientX, ev.clientY)
    const onUp = () => {
      el.removeEventListener('pointermove', onMove)
      el.removeEventListener('pointerup', onUp)
      el.removeEventListener('pointercancel', onUp)
      saveSoon()
    }
    el.addEventListener('pointermove', onMove)
    el.addEventListener('pointerup', onUp)
    el.addEventListener('pointercancel', onUp)
  }

  return { mini, miniItems, miniView, miniJump }
}

/** 与 engine.bboxOf 同构的最小实现（避免 composable 反向依赖页面装配顺序） */
function bboxOf(objects) {
  if (!objects.length) return { x: 0, y: 0, width: 0, height: 0 }
  let x0 = Infinity
  let y0 = Infinity
  let x1 = -Infinity
  let y1 = -Infinity
  for (const o of objects) {
    x0 = Math.min(x0, o.x)
    y0 = Math.min(y0, o.y)
    x1 = Math.max(x1, o.x + (o.width || 0))
    y1 = Math.max(y1, o.y + (o.height || 0))
  }
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 }
}
