<template>
  <div class="page-container bg-tech-dark">
    <AppHeader
      :first-nav-to="'/market'"
      :first-nav-label="t('market')"
      first-nav-icon="mr-2 fas fa-store"
    />
    <div
      ref="wrapEl"
      class="relative h-[calc(100vh-120px)] overflow-hidden rounded-xl mx-4 mt-2 border border-[var(--wb-stroke)]"
      :class="dragOver ? 'ring-2 ring-[var(--wb-accent)]' : ''"
      @dragover.prevent="dragOver = true"
      @dragleave.prevent="dragOver = false"
      @drop.prevent="onDrop"
    >
      <!-- 网格背景（随视口平移/缩放，纯 CSS） -->
      <div class="absolute inset-0 pointer-events-none" :style="gridStyle"></div>
      <v-stage
        ref="stageEl"
        :config="stageConfig"
        @mousedown="onMouseDown"
        @mousemove="onMouseMove"
        @mouseup="onMouseUp"
        @wheel="onWheel"
      >
        <v-layer>
          <!-- 对齐参考线 -->
          <v-line
            v-for="(g, i) in guides.v"
            :key="'gv' + i"
            :config="guideConfig(g, 'v')"
          />
          <v-line
            v-for="(g, i) in guides.h"
            :key="'gh' + i"
            :config="guideConfig(g, 'h')"
          />
          <!-- 图片物件（事件统一由 bindNodeEvents 手动绑定，见 onMounted 后 watch） -->
          <v-group
            v-for="o in imageObjects"
            :key="o.id"
            :config="groupConfig(o)"
            :draggable="true"
          >
            <v-image :config="imageConfig(o)" />
            <v-text
              v-if="o.name"
              :config="{
                text: o.name,
                y: o.height + 4,
                width: o.width,
                align: 'center',
                fontSize: 12,
                fill: '#94a3b8',
              }"
            />
          </v-group>
          <!-- 便签物件 -->
          <v-group v-for="o in noteObjects" :key="o.id" :config="groupConfig(o)" :draggable="true">
            <v-rect :config="noteRectConfig(o)" />
            <v-text :config="noteTextConfig(o)" />
          </v-group>
          <!-- 框选橡皮筋 -->
          <v-rect v-if="rubber" :config="rubberConfig" />
        </v-layer>
      </v-stage>

      <!-- 悬浮工具条 -->
      <div class="absolute top-3 right-3 flex gap-1.5">
        <button
          v-for="b in tools"
          :key="b.icon"
          :title="b.title"
          class="w-9 h-9 rounded-lg bg-[var(--wb-surface)] border border-[var(--wb-stroke)] text-[var(--wb-text-1)] hover:border-[var(--wb-accent)] transition flex items-center justify-center"
          @click="b.action"
        >
          <i :class="b.icon"></i>
        </button>
      </div>

      <!-- 缩放指示 -->
      <div class="absolute bottom-3 left-3 px-2 py-1 rounded bg-black/40 text-xs text-slate-300 font-mono">
        {{ Math.round(viewport.scale * 100) }}%
      </div>

      <!-- minimap：全景小窗（点击/拖动跳转视口） -->
      <div
        v-if="objects.length"
        class="absolute bottom-3 right-3 w-[160px] h-[110px] rounded-lg bg-black/50 border border-[var(--wb-stroke)] overflow-hidden cursor-pointer"
        @pointerdown="miniJump"
      >
        <div
          v-for="m in miniItems"
          :key="m.id"
          class="absolute rounded-sm"
          :class="m.type === 'image' ? 'bg-sky-400/70' : 'bg-slate-400/70'"
          :style="{ left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' }"
        ></div>
        <!-- 当前视口框 -->
        <div
          class="absolute border border-[var(--wb-accent)] pointer-events-none"
          :style="{ left: miniView.x + 'px', top: miniView.y + 'px', width: miniView.w + 'px', height: miniView.h + 'px' }"
        ></div>
      </div>

      <!-- 空状态 -->
      <div
        v-if="!objects.length && !dragOver"
        class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-2"
      >
        <i class="fas fa-shapes text-4xl opacity-30"></i>
        <p class="text-sm opacity-50">{{ t('canvasEmptyHint') }}</p>
      </div>
      <!-- 拖放提示 -->
      <div
        v-if="dragOver"
        class="absolute inset-0 flex flex-col items-center justify-center pointer-events-none gap-2 bg-[var(--wb-accent)]/5"
      >
        <i class="fas fa-image text-4xl text-[var(--wb-accent)] opacity-70"></i>
        <p class="text-sm text-[var(--wb-accent)]">{{ t('canvasDropImage') }}</p>
      </div>
    </div>
  </div>
</template>

<script setup>
/**
 * A 界面无限画布（Konva 渲染层）
 * 引擎逻辑在 engine.js（纯函数）；这里只做事件转发、渲染配置、持久化调度。
 */
import { ref, computed, reactive, nextTick, onMounted, onBeforeUnmount, watch } from 'vue'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import { drainFiles } from '@/utils/canvasBridge'
import AppHeader from '../apps/components/AppHeader.vue'
import {
  makeViewport,
  screenToWorld,
  zoomAtPoint,
  hitTest,
  hitTestRect,
  snapDelta,
  snapGuides,
  bboxOf,
  serializeDoc,
  parseDoc,
} from './engine'

const { t } = useI18n()
const appStore = useAppStore()

const STORAGE_KEY = 'artify.canvas.doc.v1'
const MIN_SCALE = 0.1
const MAX_SCALE = 4
const SNAP_THRESHOLD = 8

const wrapEl = ref(null)
const stageEl = ref(null)
const size = reactive({ w: 800, h: 600 })
const viewport = ref(makeViewport())
const objects = ref([])
const selection = ref([]) // 选中的 object id 列表
const guides = reactive({ v: [], h: [] })
const rubber = ref(null) // {x,y,w,h} 世界坐标
const drag = reactive({ mode: null, item: -1, last: null, moved: false })

// stage 不整体 draggable——空地平移由容器级 mousedown 自实现（bg 矩形会抢物件命中）
const stageConfig = computed(() => ({ width: size.w, height: size.h }))
// 网格背景（纯 CSS，绘制在 stage 容器下面，随视口平移）
const gridStyle = computed(() => {
  const s = 40 * viewport.value.scale
  const x = viewport.value.x % s
  const y = viewport.value.y % s
  return {
    backgroundImage:
      'linear-gradient(to right, rgba(148,163,184,0.08) 1px, transparent 1px), linear-gradient(to bottom, rgba(148,163,184,0.08) 1px, transparent 1px)',
    backgroundSize: `${s}px ${s}px`,
    backgroundPosition: `${x}px ${y}px`,
  }
})

const imageObjects = computed(() => objects.value.filter((o) => o.type === 'image'))
const noteObjects = computed(() => objects.value.filter((o) => o.type === 'note'))

// Konva 图片缓存
const imgCache = new Map()
function loadImage(src) {
  if (imgCache.has(src)) return imgCache.get(src)
  const img = new Image()
  img.onload = () => layerRefresh()
  img.src = src
  imgCache.set(src, img)
  return img
}
function layerRefresh() {
  const layer = stageEl.value?.getStage?.()?.getLayers?.()[0]
  if (layer) layer.batchDraw()
}

function groupConfig(o) {
  return { id: o.id, x: o.x, y: o.y, width: o.width, height: o.height, draggable: true }
}
function imageConfig(o) {
  return {
    image: loadImage(o.src),
    width: o.width,
    height: o.height,
    stroke: selection.value.includes(o.id) ? 'var(--wb-accent)' : 'rgba(148,163,184,0.35)',
    strokeWidth: selection.value.includes(o.id) ? 2 : 1,
    cornerRadius: 6,
  }
}
function noteRectConfig(o) {
  return {
    width: o.width,
    height: o.height,
    fill: '#475569',
    opacity: 0.9,
    cornerRadius: 8,
    stroke: selection.value.includes(o.id) ? '#38bdf8' : 'rgba(148,163,184,0.4)',
    strokeWidth: selection.value.includes(o.id) ? 2 : 1,
  }
}
function noteTextConfig(o) {
  return {
    text: o.text || '',
    width: o.width,
    height: o.height,
    padding: 10,
    fontSize: 13,
    lineHeight: 1.4,
    fill: '#e2e8f0',
    align: 'left',
  }
}
function rubberConfig() {
  return {
    x: Math.min(rubber.value.x, rubber.value.x + rubber.value.w),
    y: Math.min(rubber.value.y, rubber.value.y + rubber.value.h),
    width: Math.abs(rubber.value.w),
    height: Math.abs(rubber.value.h),
    fill: 'rgba(56,189,248,0.12)',
    stroke: 'rgba(56,189,248,0.5)',
    strokeWidth: 1,
  }
}
function guideConfig(v, axis) {
  const s = 4000
  return axis === 'v'
    ? { points: [v, -s / 2, v, s / 2], stroke: '#38bdf8', strokeWidth: 1 / viewport.value.scale, dash: [4, 4], listening: false }
    : { points: [-s / 2, v, s / 2, v], stroke: '#38bdf8', strokeWidth: 1 / viewport.value.scale, dash: [4, 4], listening: false }
}

// —— 视口变换：stage 容器上平移由 draggable 提供（Konva 拖 stage 改 x/y），
// 这里在 stage dragmove 中同步到 viewport —— 
function syncFromStage() {
  const st = stageEl.value?.getStage?.()
  if (!st) return
  // stage 自身位移即 viewport 平移（scale 由 wheel 改）
  if (drag.mode === null) {
    viewport.value = { scale: viewport.value.scale, x: st.x(), y: st.y() }
  }
}

function onWheel(e) {
  e.evt.preventDefault()
  const st = stageEl.value.getStage()
  const pointer = st.getPointerPosition()
  const factor = e.evt.deltaY < 0 ? 1.1 : 1 / 1.1
  viewport.value = zoomAtPoint(viewport.value, factor, pointer.x, pointer.y, MIN_SCALE, MAX_SCALE)
  st.scale({ x: viewport.value.scale, y: viewport.value.scale })
  st.position({ x: viewport.value.x, y: viewport.value.y })
  st.batchDraw()
}

function onItemDown(i, e) {
  // 物件按下：记录待拖，交给 Konva 的节点拖拽；框选模式空地按下走 onMouseDown
  drag.mode = 'item'
  drag.item = i
  drag.moved = false
  const id = objects.value[i].id
  if (!selection.value.includes(id)) {
    selection.value = e.evt.shiftKey ? [...selection.value, id] : [id]
  }
}

function onMouseDown(e) {
  // 空地（没点到任何 shape）按下：
  //   普通拖 = 平移画布；Shift/中键 拖 = 框选
  // 物件按下（onItemDown 先触发，drag.mode='item'）时 stage 级事件直接跳过
  if (drag.mode === 'item') return
  const st = stageEl.value.getStage()
  if (e.target !== st) return // 物件由节点拖拽处理
  const p = st.getPointerPosition()
  const w = screenToWorld(viewport.value, p.x, p.y)
  if (e.evt.button === 1 || e.evt.shiftKey) {
    drag.mode = 'rubber'
    drag.last = { x: p.x, y: p.y }
    rubber.value = { x: w.x, y: w.y, w: 0, h: 0 }
  } else {
    drag.mode = 'pan'
    drag.last = { x: p.x, y: p.y }
    selection.value = []
  }
}

function onMouseMove(e) {
  const st = stageEl.value.getStage()
  const p = st.getPointerPosition()
  if (!p) return
  if (drag.mode === 'pan' && drag.last) {
    viewport.value = {
      scale: viewport.value.scale,
      x: viewport.value.x + (p.x - drag.last.x),
      y: viewport.value.y + (p.y - drag.last.y),
    }
    drag.last = { x: p.x, y: p.y }
    applyViewport()
  } else if (drag.mode === 'rubber' && rubber.value) {
    const w = screenToWorld(viewport.value, p.x, p.y)
    rubber.value = { ...rubber.value, w: w.x - rubber.value.x, h: w.y - rubber.value.y }
  }
}

function onMouseUp() {
  if (drag.mode === 'rubber' && rubber.value) {
    const r = rubber.value
    if (Math.abs(r.w) > 4 || Math.abs(r.h) > 4) {
      const hits = hitTestRect(objects.value, r.x, r.y, r.w, r.h)
      selection.value = hits.map((i) => objects.value[i].id)
    }
    rubber.value = null
  }
  drag.mode = null
  drag.last = null
  saveSoon()
}

function onNodeDrag(e) {
  // 物件拖拽中的吸附（e 为 Konva 原生事件对象）
  const node = e.target
  const idx = objects.value.findIndex((o) => o.id === node.id())
  if (idx < 0) return
  const o = objects.value[idx]
  const others = objects.value.filter((_, i) => i !== idx)
  if (!others.length) return
  const moving = { x: node.x(), y: node.y(), width: o.width, height: o.height }
  const delta = snapDelta(moving, others, SNAP_THRESHOLD)
  guides.v = snapGuides(moving, others, SNAP_THRESHOLD).v
  guides.h = snapGuides(moving, others, SNAP_THRESHOLD).h
  if (delta.dx || delta.dy) {
    node.x(node.x() + delta.dx)
    node.y(node.y() + delta.dy)
  }
}

function onNodeDragEnd(e) {
  guides.v = []
  guides.h = []
  const o = objects.value.find((x) => x.id === e.target.id())
  if (o) {
    o.x = e.target.x()
    o.y = e.target.y()
  }
  saveSoon()
}

// —— 工具条 —— 
const tools = computed(() => [
  { icon: 'fas fa-plus', title: t('canvasAddNote'), action: addNote },
  { icon: 'fas fa-crosshairs', title: t('canvasFitAll'), action: fitAll },
  { icon: 'fas fa-expand', title: t('canvasResetView'), action: resetView },
  { icon: 'fas fa-trash', title: t('canvasDeleteSelected'), action: deleteSelected },
])

function addNote() {
  const c = screenToWorld(viewport.value, size.w / 2, size.h / 2)
  objects.value.push({
    id: 'n' + Date.now(),
    type: 'note',
    x: c.x - 90,
    y: c.y - 60,
    width: 180,
    height: 120,
    text: '',
  })
  saveSoon()
}

function fitAll() {
  if (!objects.value.length) return resetView()
  const b = bboxOf(objects.value)
  const pad = 60
  const scale = clamp(Math.min((size.w - pad * 2) / b.width, (size.h - pad * 2) / b.height), MIN_SCALE, MAX_SCALE)
  viewport.value = {
    scale,
    x: size.w / 2 - (b.x + b.width / 2) * scale,
    y: size.h / 2 - (b.y + b.height / 2) * scale,
  }
  applyViewport()
}

function resetView() {
  viewport.value = makeViewport()
  applyViewport()
}

function applyViewport() {
  const st = stageEl.value?.getStage?.()
  if (!st) return
  st.scale({ x: viewport.value.scale, y: viewport.value.scale })
  st.position({ x: viewport.value.x, y: viewport.value.y })
  st.batchDraw()
}

function deleteSelected() {
  if (!selection.value.length) return
  objects.value = objects.value.filter((o) => !selection.value.includes(o.id))
  selection.value = []
  saveSoon()
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v))
}

// —— minimap：全景（物件 bbox ∪ 视口框，等比缩到 160x110 内）—— 
const MINI_W = 160
const MINI_H = 110
const MINI_PAD = 10
const mini = computed(() => {
  const b = bboxOf(objects.value)
  let x0 = b.x, y0 = b.y, x1 = b.x + b.width, y1 = b.y + b.height
  // 把当前视口也纳入范围
  const vw = size.w / viewport.value.scale
  const vh = size.h / viewport.value.scale
  const vx0 = -viewport.value.x / viewport.value.scale
  const vy0 = -viewport.value.y / viewport.value.scale
  x0 = Math.min(x0, vx0); y0 = Math.min(y0, vy0)
  x1 = Math.max(x1, vx0 + vw); y1 = Math.max(y1, vy0 + vh)
  const s = Math.min((MINI_W - MINI_PAD * 2) / (x1 - x0), (MINI_H - MINI_PAD * 2) / (y1 - y0))
  return { x0, y0, s }
})
const miniItems = computed(() =>
  objects.value.map((o) => ({
    id: o.id,
    type: o.type,
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
  const r = e.currentTarget.getBoundingClientRect()
  // 小窗坐标 → 世界坐标 → 居中该点
  const wx = mini.value.x0 + (e.clientX - r.left - MINI_PAD) / mini.value.s
  const wy = mini.value.y0 + (e.clientY - r.top - MINI_PAD) / mini.value.s
  viewport.value = {
    scale: viewport.value.scale,
    x: size.w / 2 - wx * viewport.value.scale,
    y: size.h / 2 - wy * viewport.value.scale,
  }
  applyViewport()
  saveSoon()
}

// —— 持久化（localStorage 防抖 500ms）—— 
let saveTimer = null
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 500)
}
function saveNow() {
  try {
    localStorage.setItem(STORAGE_KEY, serializeDoc(objects.value, viewport.value, 'Untitled'))
  } catch {
    /* 容量满时静默，画布仍可用 */
  }
}
function loadNow() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  const doc = parseDoc(raw)
  objects.value = doc.objects
  viewport.value = doc.viewport
}

// 键盘：Delete 删除选中
function onKey(e) {
  if ((e.key === 'Delete' || e.key === 'Backspace') && selection.value.length) {
    const tag = document.activeElement?.tagName
    if (tag === 'INPUT' || tag === 'TEXTAREA') return
    deleteSelected()
  }
}

// —— 图片落画布：文件拖入 + 剪贴板粘贴 —— 
const dragOver = ref(false)
function filesToObjects(files, world) {
  const made = []
  let cursorY = world.y
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue
    const url = URL.createObjectURL(f)
    const probe = new Image()
    probe.onload = () => {
      const scale = Math.min(1, 260 / probe.naturalWidth)
      const w = Math.round(probe.naturalWidth * scale)
      const h = Math.round(probe.naturalHeight * scale)
      objects.value.push({
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: world.x,
        y: cursorY,
        width: w,
        height: h,
        src: url,
      })
      cursorY += h + 16
      saveSoon()
    }
    probe.src = url
    made.push(f.name)
  }
  return made
}
function onDrop(e) {
  dragOver.value = false
  const files = [...(e.dataTransfer?.files || [])]
  if (!files.length) return
  const st = stageEl.value?.getStage?.()
  const p = st.getPointerPosition() || { x: size.w / 2, y: size.h / 2 }
  const w = screenToWorld(viewport.value, p.x, p.y)
  filesToObjects(files, w)
}
function onPaste(e) {
  const items = [...(e.clipboardData?.items || [])]
  const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean)
  if (!files.length) return
  const st = stageEl.value?.getStage?.()
  const p = st?.getPointerPosition() || { x: size.w / 2, y: size.h / 2 }
  const w = screenToWorld(viewport.value, p.x, p.y)
  filesToObjects(files, w)
}

// —— 工作台产物「贴到画布」：取 canvasBridge 队列落布 —— 
// 文件引用是 ComfyUI /view 参数（filename/subfolder/type），URL 直出常驻。
function drainPinned() {
  const files = drainFiles()
  if (!files.length) return
  const origin = appStore.config?.comfyHost || 'http://127.0.0.1:8188'
  let cursorX = viewportCursor().x
  const at = viewportCursor().y
  let failed = 0
  for (const f of files) {
    const url = `${origin}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`
    const probe = new Image()
    probe.onload = () => {
      const scale = Math.min(1, 260 / probe.naturalWidth)
      objects.value.push({
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: cursorX,
        y: at,
        width: Math.round(probe.naturalWidth * scale),
        height: Math.round(probe.naturalHeight * scale),
        src: url,
      })
      cursorX += Math.round(probe.naturalWidth * scale) + 16
      saveSoon()
    }
    probe.onerror = () => {
      // 产物已被清理/实例换目录：跳过，不落破图
      failed++
    }
    probe.src = url
  }
}
function viewportCursor() {
  const st = stageEl.value?.getStage?.()
  const p = st?.getPointerPosition() || { x: size.w / 2, y: size.h / 2 }
  return screenToWorld(viewport.value, p.x, p.y)
}

let ro = null
// vue-konva 3.4 的 template @事件 绑定在小组件初始化时序下不稳（监听偶发丢失）
// ——所有 Konva 节点事件统一在这里手动绑定，可靠：
function bindNodeEvents() {
  const st = stageEl.value?.getStage?.()
  if (!st) return
  st.find('Group').forEach((g) => {
    if (g._boundWb) return
    g._boundWb = true
    const idx = () => objects.value.findIndex((o) => o.id === g.id())
    g.on('mousedown.wb', (e) => onItemDown(idx(), e))
    g.on('dragmove.wb', onNodeDrag)
    g.on('dragend.wb', onNodeDragEnd)
  })
}
onMounted(() => {
  loadNow()
  // 工作台「贴到画布」的排队产物落布（SPA 内跨路由）
  nextTick(drainPinned)
  const el = wrapEl.value
  const measure = () => {
    size.w = el.clientWidth
    size.h = el.clientHeight
  }
  measure()
  ro = new ResizeObserver(measure)
  ro.observe(el)
  window.addEventListener('keydown', onKey)
  window.addEventListener('paste', onPaste)
  // stage 初始变换
  requestAnimationFrame(applyViewport)
})
watch(
  () => objects.value.map((o) => o.id).join(','),
  () => nextTick(bindNodeEvents),
  { immediate: true },
)
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('paste', onPaste)
  clearTimeout(saveTimer)
})
</script>
