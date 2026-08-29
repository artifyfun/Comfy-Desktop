<template>
  <div class="page-container bg-tech-dark flex flex-col h-screen overflow-hidden">
    <AppHeader
      class="shrink-0"
      :first-nav-to="'/market'"
      :first-nav-label="t('market')"
      first-nav-icon="mr-2 fas fa-store"
    />
    <!-- 工作台侧边栏（左侧，可收起） + 画布 布局（flex 撑满视口剩余高度） -->
    <div class="flex flex-1 min-h-0 mx-4 mt-2 mb-2 gap-2">
      <aside
        v-if="wbOpen"
        class="w-[400px] shrink-0 flex flex-col rounded-xl border border-[var(--wb-stroke)] overflow-hidden bg-[var(--wb-bg-base)]"
      >
        <Workbench class="flex-1 min-h-0" :canvas-embedded="true" />
      </aside>
      <div
        ref="wrapEl"
        class="relative flex-1 min-w-0 overflow-hidden rounded-xl border border-[var(--wb-stroke)]"
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
          <!-- 连线（箭头指向 to 端；线体不抢物件命中，点中点圆点删线） -->
          <v-group v-for="seg in linkSegs" :key="'lk' + seg.id">
            <v-line
              :config="{
                points: [seg.x1, seg.y1, seg.x2, seg.y2],
                stroke: 'rgba(56,189,248,0.75)',
                strokeWidth: 2 / viewport.scale,
                pointerLength: 10 / viewport.scale,
                pointerWidth: 8 / viewport.scale,
                lineCap: 'round',
                listening: false,
              }"
            />
            <v-circle
              :config="{
                id: seg.id,
                x: (seg.x1 + seg.x2) / 2,
                y: (seg.y1 + seg.y2) / 2,
                radius: 7 / viewport.scale,
                fill: '#0ea5e9',
                opacity: 0.45,
                cursor: 'pointer',
              }"
              @mousedown="deleteLinkAt"
            />
          </v-group>
          <!-- 框选橡皮筋 -->
          <v-rect v-if="rubber" :config="rubberConfig" />
          <!-- 圈选裁剪橡皮筋 -->
          <v-rect v-if="cropRect" :config="cropRectConfig" />
        </v-layer>
      </v-stage>

      <!-- 悬浮工具条 -->
      <div class="absolute top-3 right-3 flex gap-1.5">
        <button
          v-for="b in tools"
          :key="b.icon"
          :title="b.title"
          :disabled="b.disabled"
          class="w-9 h-9 rounded-lg bg-[var(--wb-surface)] border text-[var(--wb-text-1)] transition flex items-center justify-center disabled:opacity-40 disabled:pointer-events-none"
          :class="b.active ? 'border-[var(--wb-accent)] text-[var(--wb-accent)] bg-[var(--wb-accent)]/10' : 'border-[var(--wb-stroke)] hover:border-[var(--wb-accent)]'"
          @click="b.action"
        >
          <i :class="b.icon"></i>
        </button>
      </div>

      <!-- 模式提示条（连线/裁剪工具激活时） -->
      <div
        v-if="tool"
        class="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-black/60 backdrop-blur text-xs text-slate-200 flex items-center gap-2 z-10"
      >
        <i class="fas" :class="tool === 'link' ? 'fa-bezier-curve text-sky-400' : 'fa-vector-square text-sky-400'"></i>
        <span>{{ tool === 'link' ? (linkDraft ? t('canvasLinkPickSecond') : t('canvasLinkPickFirst')) : t('canvasCropHint') }}</span>
        <button class="text-slate-400 hover:text-white" :title="t('canvasToolCancel')" @click.stop="setTool(null)">
          <i class="fas fa-times"></i>
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

    <!-- 工作台开合按钮（画布区左上角外沿，随侧栏在左） -->
    <button
      class="fixed z-40 top-[76px] w-7 h-9 rounded-r-md bg-[var(--wb-surface)] border border-[var(--wb-stroke)] border-l-0 text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] transition flex items-center justify-center"
      :style="wbOpen ? 'left: 416px' : 'left: 16px'"
      :title="wbOpen ? t('canvasCloseWb') : t('canvasOpenWb')"
      @click="wbOpen = !wbOpen"
    >
      <i class="fas text-xs" :class="wbOpen ? 'fa-chevron-left' : 'fa-chevron-right'"></i>
    </button>
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
import { drainFiles, pushAttachments } from '@/utils/canvasBridge'
import { useCanvasMode } from '@/utils/canvasMode'
import { message } from 'ant-design-vue'
import Workbench from '../workbench/index.vue'
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
  linkEndpoints,
  distToSegment,
  cropRectFor,
} from './engine'

const { t } = useI18n()
const appStore = useAppStore()
const { onResult, emitAttachments, emitCanvasState } = useCanvasMode()
const wbOpen = ref(true) // 工作台侧边栏开合

const STORAGE_KEY = 'artify.canvas.doc.v1'
const MIN_SCALE = 0.1
const MAX_SCALE = 4
const SNAP_THRESHOLD = 8

const wrapEl = ref(null)
const stageEl = ref(null)
const size = reactive({ w: 800, h: 600 })
const viewport = ref(makeViewport())
const objects = ref([])
const links = ref([]) // {id, from, to} 物件 id；渲染为箭头，级联删除
const groups = ref([]) // {id, members:[objectId]} 组合；成员联动拖动/选择/删除
const selection = ref([]) // 选中的 object id 列表
const guides = reactive({ v: [], h: [] })
const rubber = ref(null) // {x,y,w,h} 世界坐标
const drag = reactive({ mode: null, item: -1, last: null, moved: false })
// 交互工具模式：null=选择 | 'link'=点两个物件连线 | 'crop'=圈图裁剪
const tool = ref(null)
const linkDraft = ref(null) // 'link' 模式：已点第一个物件 id
const spaceDown = ref(false) // 空格按住 = 强制平移
const cropRect = ref(null) // 'crop' 模式拖出的世界矩形

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

// Konva 图片缓存（记 naturalWidth/Height 供裁剪换算）
const imgCache = new Map()
function loadImage(src) {
  if (imgCache.has(src)) return imgCache.get(src)
  const img = new Image()
  img.onload = () => layerRefresh()
  img.src = src
  imgCache.set(src, img)
  return img
}
function naturalOf(o) {
  if (o.naturalWidth && o.naturalHeight) return o
  const img = imgCache.get(o.src)
  const nw = o.naturalWidth || img?.naturalWidth || o.width
  const nh = o.naturalHeight || img?.naturalHeight || o.height
  return { ...o, naturalWidth: nw, naturalHeight: nh }
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
// 连线几何（物件移动后端点跟随——由 computed 每帧重算）
const linkSegs = computed(() => linkEndpoints(links.value, objects.value).filter(Boolean))
function cropRectConfig() {
  return {
    x: Math.min(cropRect.value.x, cropRect.value.x + cropRect.value.w),
    y: Math.min(cropRect.value.y, cropRect.value.y + cropRect.value.h),
    width: Math.abs(cropRect.value.w),
    height: Math.abs(cropRect.value.h),
    fill: 'rgba(16,185,129,0.10)',
    stroke: 'rgba(16,185,129,0.7)',
    strokeWidth: 1,
    dash: [6, 4],
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
  if (tool.value === 'link') {
    // 连线模式：点第一个物件记起点，点第二个建连线
    const id = objects.value[i].id
    if (!linkDraft.value) {
      linkDraft.value = id
      message.info(t('canvasLinkPickSecond'))
    } else if (linkDraft.value !== id) {
      const exists = links.value.some(
        (l) => (l.from === linkDraft.value && l.to === id) || (l.from === id && l.to === linkDraft.value),
      )
      if (!exists) {
        links.value.push({ id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5), from: linkDraft.value, to: id })
        saveSoon()
      }
      linkDraft.value = null
      tool.value = null
      syncDraggables()
    }
    drag.mode = 'link-wait'
    return
  }
  if (tool.value === 'crop') {
    // 圈选裁剪：允许从图片上起圈（拖拽交给 stage 级 mousemove/mouseup 完成）
    const st = stageEl.value.getStage()
    const p = st.getPointerPosition()
    const w = screenToWorld(viewport.value, p.x, p.y)
    drag.mode = 'crop'
    drag.last = { x: p.x, y: p.y }
    cropRect.value = { x: w.x, y: w.y, w: 0, h: 0 }
    return
  }
  drag.mode = 'item'
  drag.item = i
  drag.moved = false
  const id = objects.value[i].id
  if (!selection.value.includes(id)) {
    selection.value = e.evt.shiftKey ? [...selection.value, id] : [id]
  }
  // 组：整组选中高亮（成员各自渲染 stroke）
}

function onMouseDown(e) {
  // 空地（没点到任何 shape）按下：
  //   普通拖 = 平移画布；Shift/中键 拖 = 框选；crop 工具 = 圈选裁剪
  // 物件按下（onItemDown 先触发，drag.mode='item'）时 stage 级事件直接跳过
  if (drag.mode === 'item' || drag.mode === 'link-wait') return
  const st = stageEl.value.getStage()
  if (e.target !== st) return // 物件由节点拖拽处理
  const p = st.getPointerPosition()
  const w = screenToWorld(viewport.value, p.x, p.y)
  if (tool.value === 'crop') {
    drag.mode = 'crop'
    drag.last = { x: p.x, y: p.y }
    cropRect.value = { x: w.x, y: w.y, w: 0, h: 0 }
    return
  }
  if (e.evt.button === 1 || e.evt.shiftKey) {
    drag.mode = 'rubber'
    drag.last = { x: p.x, y: p.y }
    rubber.value = { x: w.x, y: w.y, w: 0, h: 0 }
  } else {
    drag.mode = 'pan'
    drag.last = { x: p.x, y: p.y }
    if (!spaceDown.value) selection.value = []
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
  } else if (drag.mode === 'crop' && cropRect.value) {
    const w = screenToWorld(viewport.value, p.x, p.y)
    cropRect.value = { ...cropRect.value, w: w.x - cropRect.value.x, h: w.y - cropRect.value.y }
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
  } else if (drag.mode === 'crop' && cropRect.value) {
    const r = cropRect.value
    if (Math.abs(r.w) > 8 && Math.abs(r.h) > 8) cropAndSend(r)
    cropRect.value = null
    tool.value = null
    syncDraggables()
  }
  if (drag.mode !== 'link-wait') {
    drag.mode = null
    drag.last = null
  }
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
    // 组联动：以拖拽物数据旧值为基准算增量，同步同组成员（数据 + Konva 节点双写）
    const g = groups.value.find((gr) => gr.members.includes(o.id))
    const oldX = o.x
    const oldY = o.y
    o.x = e.target.x()
    o.y = e.target.y()
    if (g) {
      const ddx = o.x - oldX
      const ddy = o.y - oldY
      if (ddx || ddy) {
        for (const m of g.members) {
          if (m === o.id) continue
          const mo = objects.value.find((x) => x.id === m)
          if (!mo) continue
          mo.x += ddx
          mo.y += ddy
          const node = stageEl.value?.getStage?.()?.findOne('#' + CSS.escape(m))
          if (node) {
            node.x(mo.x)
            node.y(mo.y)
          }
        }
      }
    }
  }
  saveSoon()
}

// —— 工具条 —— 
const tools = computed(() => [
  { icon: 'fas fa-plus', title: t('canvasAddNote'), action: addNote },
  {
    icon: 'fas fa-vector-square',
    title: t('canvasCropTool'),
    action: () => setTool('crop'),
    active: tool.value === 'crop',
  },
  {
    icon: 'fas fa-bezier-curve',
    title: t('canvasLinkTool'),
    action: () => setTool('link'),
    active: tool.value === 'link',
  },
  {
    icon: 'fas fa-object-group',
    title: t('canvasGroupSel'),
    action: groupSelected,
    disabled: selection.value.length < 2,
  },
  {
    icon: 'fas fa-object-ungroup',
    title: t('canvasUngroupSel'),
    action: ungroupSelection,
    disabled: !selection.value.some((id) => groupOf(id)),
  },
  { icon: 'fas fa-crosshairs', title: t('canvasFitAll'), action: fitAll },
  { icon: 'fas fa-expand', title: t('canvasResetView'), action: resetView },
  {
    icon: 'fas fa-paper-plane',
    title: t('canvasSendToWorkbench'),
    action: sendSelectionToWorkbench,
    disabled: !selection.value.some((id) => refOf(id)),
  },
  { icon: 'fas fa-trash', title: t('canvasDeleteSelected'), action: deleteSelected },
])
// 工具模式下禁用物件拖拽（否则 Konva dragstart 会吞掉 crop/link 的 mousedown 语义）
function syncDraggables() {
  const st = stageEl.value?.getStage?.()
  if (st) st.find('Group').forEach((g) => g.draggable(tool.value === null))
}
function setTool(m) {
  tool.value = tool.value === m ? null : m
  linkDraft.value = null
  if (m) selection.value = []
  syncDraggables()
}

// 选中物件 → 工作台参考图附件（仅 image 物件可反解出 /view 引用）
function refOf(id) {
  const o = objects.value.find((x) => x.id === id)
  if (!o || o.type !== 'image' || !o.src) return null
  try {
    const u = new URL(o.src)
    if (!u.pathname.endsWith('/view')) return null
    return {
      filename: u.searchParams.get('filename') || '',
      subfolder: u.searchParams.get('subfolder') || '',
      type: u.searchParams.get('type') || 'output',
    }
  } catch {
    return null // blob:/data: 等（拖入/粘贴图），无 /view 引用
  }
}
function sendSelectionToWorkbench() {
  const refs = selection.value.map(refOf).filter(Boolean)
  if (!refs.length) return
  lastSourceIds = [...selection.value] // 溯源：产物落布时自动连线
  if (wbOpen.value) {
    // 侧边栏工作台常驻：走活通道，附件立即可见
    emitAttachments(refs)
    message.success(t('workbenchCardAttached').replace('{n}', String(refs.length)))
  } else {
    // 侧栏收起：入跨路由队列，下次工作台挂载时取走
    pushAttachments(refs)
    message.success(t('workbenchCardAttached').replace('{n}', String(refs.length)))
  }
  selection.value = []
}


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
  const gone = new Set(selection.value)
  objects.value = objects.value.filter((o) => !gone.has(o.id))
  // 级联：删除物件上的连线、所在组
  links.value = links.value.filter((l) => !gone.has(l.from) && !gone.has(l.to))
  groups.value = groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => !gone.has(m)) }))
    .filter((g) => g.members.length > 1)
  selection.value = []
  saveSoon()
}

// —— 组合与解组 ——
function groupSelected() {
  if (selection.value.length < 2) return
  const members = [...selection.value]
  // 已在其他组的成员先从原组移除
  groups.value = groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => !members.includes(m)) }))
    .filter((g) => g.members.length > 1)
  groups.value.push({ id: 'g' + Date.now(), members })
  message.success(t('canvasGrouped').replace('{n}', String(members.length)))
  saveSoon()
}
function ungroupSelection() {
  const sel = new Set(selection.value)
  const before = groups.value.length
  groups.value = groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => !sel.has(m)) }))
    .filter((g) => g.members.length > 1)
  if (groups.value.length < before) {
    message.success(t('canvasUngrouped'))
    saveSoon()
  }
}
function groupOf(id) {
  return groups.value.find((g) => g.members.includes(id))
}

// —— 连线删除：点击箭头本体（渲染层 line 绑定 mousedown）——
function deleteLinkAt(e) {
  const id = e.target.id()
  links.value = links.value.filter((l) => l.id !== id)
  saveSoon()
}

// —— 圈选裁剪：把 crop 矩形与所压图片的交集裁下来，作为新图发工作台 ——
// 取图走同源 /view 代理（express GET 代理 / vite dev proxy）：直接用 ComfyUI
// 绝对 URL 画 canvas 会被污染（ComfyUI 不带 CORS 头）→ toBlob 抛 SecurityError。
async function fetchImageForCrop(src) {
  const qIndex = src.indexOf('?')
  const query = qIndex >= 0 ? src.slice(qIndex + 1) : ''
  const candidates = []
  if (query && !/^(data|blob):/.test(src)) candidates.push('/view?' + query)
  if (!/^(data|blob):/.test(src)) candidates.push(src)
  for (const url of candidates) {
    try {
      const res = await fetch(url, { mode: 'cors' })
      if (!res.ok) continue
      const blob = await res.blob()
      if (!blob.type.startsWith('image/')) continue
      return await createImageBitmap(blob)
    } catch (e) {
      /* 试下一个候选 */
    }
  }
  return loadImage(src)
}

async function cropAndSend(r) {
  const hits = hitTestRect(objects.value, r.x, r.y, r.w, r.h).filter(
    (i) => objects.value[i].type === 'image',
  )
  if (!hits.length) {
    message.warning(t('canvasCropNoImage'))
    return
  }
  // 按面积取最大相交图片（圈多图时取最主要的一张，避免多附件歧义）
  let best = null
  for (const i of hits) {
    const o = objects.value[i]
    const c = cropRectFor(naturalOf(o), r.x, r.y, r.w, r.h)
    if (c && (!best || c.width * c.height > best.area)) best = { o, c, area: c.width * c.height }
  }
  if (!best) return
  const o = naturalOf(best.o)
  const c = best.c
  let srcImg
  try {
    srcImg = await fetchImageForCrop(o.src)
  } catch (e) {
    message.warning(t('canvasCropNoImage'))
    return
  }
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(c.sw))
  canvas.height = Math.max(1, Math.round(c.sh))
  const ctx = canvas.getContext('2d')
  ctx.drawImage(srcImg, c.sx, c.sy, c.sw, c.sh, 0, 0, canvas.width, canvas.height)
  // toBlob 在 canvas 被污染时会同步抛 SecurityError，这里兜住降级为提示
  const blob = await new Promise((resolve) => {
    try {
      canvas.toBlob(resolve, 'image/png')
    } catch (e) {
      resolve(null)
    }
  })
  if (!blob) {
    message.warning(t('canvasCropNoImage'))
    return
  }
  const f = new File([blob], 'crop-' + Date.now() + '.png', { type: 'image/png' })
  // 裁剪图走附件通道 file 字段，工作台侧复用 uploadFiles 上传落地（可执行附件）
  if (wbOpen.value) emitAttachments([{ filename: f.name, file: f }])
  else pushAttachments([{ filename: f.name, file: f }])
  message.success(t('workbenchCardAttached').replace('{n}', '1'))
  // 同时在画布上落一个小缩略物（可删），紧贴原裁剪区右下角
  const thumb = document.createElement('canvas')
  const tw = 180
  thumb.width = tw
  thumb.height = Math.max(1, Math.round((canvas.height / canvas.width) * tw))
  thumb.getContext('2d').drawImage(canvas, 0, 0, thumb.width, thumb.height)
  thumb.toBlob((tb) => {
    if (!tb) return
    const turl = URL.createObjectURL(tb)
    const probe = new Image()
    probe.onload = () => {
      objects.value.push({
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: c.x + c.width + 12,
        y: c.y + c.height - probe.height,
        width: probe.width,
        height: probe.height,
        src: turl,
      })
      saveSoon()
    }
    probe.src = turl
  })
}

function clamp(v, a, b) {
  return Math.min(b, Math.max(a, v))
}

// —— 画布 → 侧栏工作台感知条（选区/物件摘要，与 C 宿主 embed 感知条同构）——
let canvasSeq = 0
const canvasDigest = computed(() => {
  const imgs = objects.value.filter((o) => o.type === 'image').length
  const notes = objects.value.filter((o) => o.type === 'note').length
  return {
    seq: 0, // 实例序号在 emit 时自增（computed 本身无副作用）
    workflowName: t('canvasDigestName'),
    nodeCount: objects.value.length,
    models: [],
    selection: selection.value.map((id) => {
      const o = objects.value.find((x) => x.id === id)
      if (!o) return null
      return o.type === 'image' ? `image ${o.width}×${o.height}` : 'note'
    }).filter(Boolean),
    counts: { images: imgs, notes, links: links.value.length, groups: groups.value.length },
    queue: { running: 0, pending: 0 },
    ts: Date.now(),
  }
})
watch(
  () => [selection.value.slice(), objects.value.length, links.value.length, groups.value.length],
  () => {
    if (!wbOpen.value) return
    const d = { ...canvasDigest.value, seq: ++canvasSeq }
    emitCanvasState(d)
  },
  { deep: false },
)

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
    localStorage.setItem(STORAGE_KEY, serializeDoc(objects.value, viewport.value, 'Untitled', links.value, groups.value))
  } catch {
    /* 容量满时静默，画布仍可用 */
  }
}
function loadNow() {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (!raw) return
  const doc = parseDoc(raw)
  objects.value = doc.objects
  links.value = doc.links
  groups.value = doc.groups
  viewport.value = doc.viewport
}

// 键盘：Delete 删除选中；空格按住=平移；Esc=退工具；Ctrl+G/Ctrl+Shift+G=组
function onKey(e) {
  const tag = document.activeElement?.tagName
  const inEditor = tag === 'INPUT' || tag === 'TEXTAREA'
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (inEditor) return
    if (selection.value.length) {
      e.preventDefault()
      deleteSelected()
    }
  } else if (e.code === 'Space' && !e.repeat) {
    spaceDown.value = true
    if (!inEditor) e.preventDefault()
  } else if (e.key === 'Escape') {
    if (tool.value) {
      tool.value = null
      linkDraft.value = null
      syncDraggables()
    } else if (!inEditor) selection.value = []
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
    if (inEditor) return
    e.preventDefault()
    if (e.shiftKey) ungroupSelection()
    else groupSelected()
  }
}
function onKeyUp(e) {
  if (e.code === 'Space') spaceDown.value = false
}

// —— 图片落画布：文件拖入 + 剪贴板粘贴 ——
const dragOver = ref(false)
// blob 图持久化：降采样到最长边 640 转 JPEG dataURL 存进文档（画布显示用原 blob
// URL 保持清晰；存档用 persist dataURL，刷新/重开仍在）。
function persistImage(o) {
  const probe = new Image()
  probe.onload = () => {
    const MAX = 640
    const s = Math.min(1, MAX / Math.max(probe.naturalWidth, probe.naturalHeight))
    const cv = document.createElement('canvas')
    cv.width = Math.max(1, Math.round(probe.naturalWidth * s))
    cv.height = Math.max(1, Math.round(probe.naturalHeight * s))
    cv.getContext('2d').drawImage(probe, 0, 0, cv.width, cv.height)
    try {
      o.persist = cv.toDataURL('image/jpeg', 0.72)
    } catch {
      return // 跨域图无法导出（/view 同源时不会发生）：只留会话内
    }
    saveSoon()
  }
  probe.src = o.src
}
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
      const o = {
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: 'image',
        x: world.x,
        y: cursorY,
        width: w,
        height: h,
        src: url,
        persist: null,
      }
      objects.value.push(o)
      persistImage(o)
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

// —— 工作台产物落画布（公共通道）——
// 文件引用是 ComfyUI /view 参数（filename/subfolder/type），URL 直出常驻。
// 起点 = 当前视野中心，横向往右排布；加载失败的文件跳过不落破图。
// 溯源：落布时与「发送参考图时记下的来源物件」自动连线。
let lastSourceIds = [] // sendSelectionToWorkbench 记录，供产物回落后连线
function placeFiles(files) {
  if (!files?.length) return
  const origin = appStore.config?.comfyHost || 'http://127.0.0.1:8188'
  const c = viewportCenterWorld()
  let cursorX = c.x - 130
  const at = c.y
  const sourceIds = lastSourceIds.filter((id) => objects.value.some((o) => o.id === id))
  for (const f of files) {
    const url = `${origin}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`
    const probe = new Image()
    probe.onload = () => {
      const scale = Math.min(1, 260 / probe.naturalWidth)
      const id = 'n' + Date.now() + Math.random().toString(36).slice(2, 6)
      objects.value.push({
        id,
        type: 'image',
        x: cursorX,
        y: at,
        width: Math.round(probe.naturalWidth * scale),
        height: Math.round(probe.naturalHeight * scale),
        src: url,
      })
      // 溯源连线：参考图 → 产物
      for (const srcId of sourceIds) {
        links.value.push({ id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5), from: srcId, to: id })
      }
      cursorX += Math.round(probe.naturalWidth * scale) + 16
      saveSoon()
    }
    probe.onerror = () => {
      // 产物已被清理/实例换目录：跳过，不落破图
    }
    probe.src = url
  }
  lastSourceIds = []
}
function viewportCenterWorld() {
  return screenToWorld(viewport.value, size.w / 2, size.h / 2)
}
function drainPinned() {
  placeFiles(drainFiles())
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
  window.addEventListener('keyup', onKeyUp)
  window.addEventListener('paste', onPaste)
  // stage 初始变换
  requestAnimationFrame(applyViewport)
  // 侧边栏工作台：产物生成 → 自动落画布（window 总线，见 canvasMode.js）
  const offResult = onResult(placeFiles)
  onBeforeUnmount(() => {
    offResult()
  })
})
watch(
  () => objects.value.map((o) => o.id).join(','),
  () => nextTick(bindNodeEvents),
  { immediate: true },
)
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('paste', onPaste)
  clearTimeout(saveTimer)
})
</script>
