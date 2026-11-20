/**
 * 连线手势（useLinkGestures）——canvas/index.vue 手势层抽取（A2）。
 *
 * 覆盖两类手势（原 index.vue 内联 3044-3190，~150 行）：
 * - 句柄拖拽建线：onConnectStart/Move/End；松手落空 → 弹「创建节点」菜单
 *   （经 openConnectCreate 回调注入，菜单状态仍归 index.vue）
 * - 锚点拖拽重连：onAnchorDown/onReconnectMove/End；命中去重、拖回取消、
 *   冗余线并入既有线
 *
 * 依赖注入（canvasCtx）：objects/links/viewport/size/drag（共享响应式源）、
 * beforeChange/saveSoon（undo+持久化）、stageEl、linkSegs、selectedLinkId、
 * connectDrag/reconnectDrag（本模块持有）、openConnectCreate。
 * 纯手势状态机在自身 interface 内可单测（fake ctx 驱动）。
 */
import { reactive } from 'vue'
import { screenToWorld, worldToScreen, hitTest } from './engine'

export function useLinkGestures(canvasCtx) {
  const {
    objects,
    links,
    viewport,
    size,
    drag,
    stageEl,
    linkSegs,
    selectedLinkId,
    beforeChange,
    saveSoon,
    openConnectCreate,
  } = canvasCtx

  const connectDrag = reactive({
    active: false,
    nodeId: null,
    handleType: null,
    targetId: null,
    seg: null,
  })
  const reconnectDrag = reactive({
    active: false,
    linkId: null,
    side: null,
    fixedId: null,
    targetId: null,
    seg: null,
  })

  /** Konva 事件对象无 preventDefault/stopPropagation，Vue .prevent/.stop 修饰符会抛错；
   *  统一在此代理到原生 evt（kev.evt 为浏览器原生事件）。
   *  ⚠️ 2026-09-18 修复：原写法 `kev?.cancelBubble && (kev.cancelBubble = true)` 是**短路无效**——
   *  Konva 事件初始化时 cancelBubble 就是 false，条件为假 → 永远置不上 true，冒泡根本没被阻断。
   *  后果：句柄/锚点/角柄按下会一路冒泡到 `st.find('Group').on('mousedown.wb')` 的全局绑定，
   *  以 `g.id()` 反查物件的 `onItemDown(idx())`：无 id 的 Group（句柄组/锚点组）idx=-1 →
   *  `objects.value[-1].id` 抛 TypeError（C-H9 实测，拖句柄建线每次都抛）；有 id 的 Group 则
   *  **误把该手势当成“按在物件上”**（drag.mode='item'、改 selection），与缩放/建线抢状态。 */
  function stopKonvaEvent(kev) {
    if (kev) kev.cancelBubble = true // Konva 冒泡阻断（必须无条件置真）
    kev?.evt?.preventDefault?.()
    kev?.evt?.stopPropagation?.()
  }

  /** 句柄 mousedown：进入 connect 拖拽（source=右句柄建 from→to；target=左句柄建 to←from） */
  function onConnectStart(nodeId, handleType, kev) {
    stopKonvaEvent(kev)
    connectDrag.active = true
    connectDrag.nodeId = nodeId
    connectDrag.handleType = handleType
    connectDrag.targetId = null
    const o = objects.value.find((x) => x.id === nodeId)
    if (!o) return
    // 起点固定在句柄一侧边缘中点
    connectDrag.seg =
      handleType === 'source'
        ? { x1: o.x + o.width, y1: o.y + o.height / 2, x2: o.x + o.width, y2: o.y + o.height / 2 }
        : { x1: o.x, y1: o.y + o.height / 2, x2: o.x, y2: o.y + o.height / 2 }
    drag.mode = 'connect' // 占住拖拽态：阻止平移/物件拖动
  }

  /** connect 拖拽中：预览端点跟随鼠标，命中物件则吸附到其边缘 */
  function onConnectMove() {
    if (!connectDrag.active || !connectDrag.seg) return
    const st = stageEl.value.getStage()
    const p = st.getPointerPosition()
    if (!p) return
    const w = screenToWorld(viewport.value, p.x, p.y)
    const start = { x: connectDrag.seg.x1, y: connectDrag.seg.y1 }
    const hit = hitTest(objects.value, w.x, w.y)
    const hoverObj = hit >= 0 ? objects.value[hit] : null
    const target = hoverObj && hoverObj.id !== connectDrag.nodeId ? hoverObj : null
    connectDrag.targetId = target ? target.id : null
    const end = target
      ? connectDrag.handleType === 'source'
        ? { x: target.x, y: target.y + target.height / 2 }
        : { x: target.x + target.width, y: target.y + target.height / 2 }
      : { x: w.x, y: w.y }
    connectDrag.seg = { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
  }

  function onConnectEnd() {
    if (!connectDrag.active) return
    const { nodeId, handleType, targetId, seg } = connectDrag
    connectDrag.active = false
    connectDrag.seg = null
    connectDrag.targetId = null
    // C：松手落空 → 在端点弹「创建节点」菜单，创建后自动连线
    if (!targetId && seg) {
      const endScreen = worldToScreen(viewport.value, seg.x2, seg.y2)
      openConnectCreate({
        screenX: endScreen.x + 8,
        screenY: endScreen.y + 8,
        wx: seg.x2,
        wy: seg.y2,
        from: handleType === 'source' ? nodeId : null,
        to: handleType === 'target' ? nodeId : null,
      })
      return
    }
    if (!targetId || targetId === nodeId) return
    const from = handleType === 'source' ? nodeId : targetId
    const to = handleType === 'source' ? targetId : nodeId
    const exists = links.value.some((l) => l.from === from && l.to === to)
    if (!exists) {
      beforeChange()
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
        from,
        to,
      })
      saveSoon()
    }
  }

  /** 重连锚点 mousedown：拆一端进入重连拖拽。side='from' 拖源端 → 改接新源（贴其右缘）；
   *  side='to' 拖目标端 → 改接新目标（贴其左缘）。不动端坐标保持。 */
  function onAnchorDown(linkId, side, kev) {
    stopKonvaEvent(kev)
    const l = links.value.find((x) => x.id === linkId)
    const seg = linkSegs.value.find((s) => s.id === linkId)
    if (!l || !seg) return
    selectedLinkId.value = linkId
    reconnectDrag.active = true
    reconnectDrag.linkId = linkId
    reconnectDrag.side = side
    reconnectDrag.fixedId = side === 'from' ? l.to : l.from
    reconnectDrag.targetId = null
    reconnectDrag.seg = { x1: seg.x1, y1: seg.y1, x2: seg.x2, y2: seg.y2 }
    drag.mode = 'reconnect' // 占住拖拽态：阻止平移/物件拖动
    drag.last = null
  }

  /** 重连拖拽中：预览动端跟随指针，命中物件则吸附到其对应侧边缘中点 */
  function onReconnectMove() {
    if (!reconnectDrag.active || !reconnectDrag.seg) return
    const st = stageEl.value.getStage()
    const p = st.getPointerPosition()
    if (!p) return
    const w = screenToWorld(viewport.value, p.x, p.y)
    const seg = reconnectDrag.seg
    const fixed =
      reconnectDrag.side === 'from' ? { x: seg.x2, y: seg.y2 } : { x: seg.x1, y: seg.y1 }
    const hit = hitTest(objects.value, w.x, w.y)
    const hoverObj = hit >= 0 ? objects.value[hit] : null
    const target = hoverObj && hoverObj.id !== reconnectDrag.fixedId ? hoverObj : null
    reconnectDrag.targetId = target ? target.id : null
    const end = target
      ? reconnectDrag.side === 'from'
        ? { x: target.x + target.width, y: target.y + target.height / 2 }
        : { x: target.x, y: target.y + target.height / 2 }
      : { x: w.x, y: w.y }
    reconnectDrag.seg =
      reconnectDrag.side === 'from'
        ? { x1: end.x, y1: end.y, x2: fixed.x, y2: fixed.y }
        : { x1: fixed.x, y1: fixed.y, x2: end.x, y2: end.y }
  }

  /** 重连松手：命中其它物件且非自环 → 更新连线端点；落空/拖回原端 → 取消 */
  function onReconnectEnd() {
    if (!reconnectDrag.active) return
    const { linkId, side, targetId, fixedId } = reconnectDrag
    reconnectDrag.active = false
    reconnectDrag.linkId = null
    reconnectDrag.side = null
    reconnectDrag.fixedId = null
    reconnectDrag.targetId = null
    reconnectDrag.seg = null
    if (!linkId || !targetId || targetId === fixedId) return
    const l = links.value.find((x) => x.id === linkId)
    if (!l) return
    const nextFrom = side === 'from' ? targetId : l.from
    const nextTo = side === 'to' ? targetId : l.to
    if (nextFrom === l.from && nextTo === l.to) return
    const dup = links.value.some((x) => x.id !== linkId && x.from === nextFrom && x.to === nextTo)
    if (dup) {
      // 目标关系已存在 → 被拖线成为冗余，移除（等效并入既有线）
      beforeChange()
      links.value = links.value.filter((x) => x.id !== linkId)
      selectedLinkId.value = null
    } else {
      beforeChange()
      l.from = nextFrom
      l.to = nextTo
    }
    saveSoon()
  }

  return {
    connectDrag,
    reconnectDrag,
    stopKonvaEvent,
    onConnectStart,
    onConnectMove,
    onConnectEnd,
    onAnchorDown,
    onReconnectMove,
    onReconnectEnd,
  }
}
