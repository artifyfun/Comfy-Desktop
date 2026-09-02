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
        @contextmenu.prevent="onWrapContext"
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
          <!-- 连线层（参考 infinite-canvas：SVG 层 zIndex 0，位于节点之下；
               16px 命中层不可压住节点交互） -->
          <v-layer>
            <v-group v-for="seg in linkSegs" :key="'lk' + seg.id">
              <v-path
                :config="{
                  id: seg.id,
                  data: bezierLinkPath(seg.x1, seg.y1, seg.x2, seg.y2),
                  stroke: 'transparent',
                  strokeWidth: 16 / viewport.scale,
                  hitStrokeWidth: 16 / viewport.scale,
                  cursor: 'pointer',
                }"
                @mousedown="onLinkDown"
                @contextmenu="onLinkContextMenu($event, seg.id)"
              />
              <v-path
                :config="{
                  data: bezierLinkPath(seg.x1, seg.y1, seg.x2, seg.y2),
                  stroke: selectedLinkId === seg.id ? '#fafaf9' : 'rgba(214,211,206,0.82)',
                  strokeWidth: (selectedLinkId === seg.id ? 3 : 2) / viewport.scale,
                  listening: false,
                }"
              />
            </v-group>
            <!-- 拖拽建线预览（虚线贝塞尔，参考 ActiveConnectionPath） -->
            <v-path
              v-if="connectDrag.seg"
              :config="{
                data: bezierLinkPath(
                  connectDrag.seg.x1,
                  connectDrag.seg.y1,
                  connectDrag.seg.x2,
                  connectDrag.seg.y2,
                ),
                stroke: '#fafaf9',
                strokeWidth: 2 / viewport.scale,
                dash: [5 / viewport.scale, 5 / viewport.scale],
                listening: false,
              }"
            />
          </v-layer>
          <v-layer>
            <!-- 对齐参考线 -->
            <v-line v-for="(g, i) in guides.v" :key="'gv' + i" :config="guideConfig(g, 'v')" />
            <v-line v-for="(g, i) in guides.h" :key="'gh' + i" :config="guideConfig(g, 'h')" />
            <!-- Frame 分区（纯背景容器：不响应鼠标，成员物件自由进出；管理走右键/大纲） -->
            <v-group
              v-for="o in frameObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="false"
              :listening="false"
            >
              <v-rect :config="frameConfig(o)" />
              <v-text :config="frameLabelConfig(o)" />
            </v-group>
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
            <v-group
              v-for="o in noteObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="true"
            >
              <v-rect :config="noteRectConfig(o)" />
              <v-text :config="noteTextConfig(o)" />
            </v-group>
            <!-- App 节点卡（A 画布应用实例：双击/按钮展开参数面板，▶ 随时运行） -->
            <v-group
              v-for="o in appNodeObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="true"
            >
              <v-rect :config="appNodeRectConfig(o)" />
              <v-text :config="appNodeTitleConfig(o)" />
              <v-text :config="appNodeSubConfig(o)" />
              <v-circle :config="appNodeStatusConfig(o)" />
              <v-text
                :config="appNodeRunBtnConfig(o)"
                @mousedown="runAppNodeFromKonva(o.id, $event)"
              />
              <v-text
                :config="appNodeExpandBtnConfig(o)"
                @mousedown="openAppNodePanelFromKonva(o.id, $event)"
              />
            </v-group>
            <!-- 分镜帧卡（N5：镜号+画面+描述） -->
            <v-group
              v-for="o in shotObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="true"
            >
              <v-rect :config="shotRectConfig(o)" />
              <v-text :config="shotSeqConfig(o)" />
              <v-text :config="shotTextConfig(o)" />
            </v-group>
            <!-- 连接句柄（参考 infinite-canvas ConnectionHandleDot：悬停/选中/连线中显现，
                 48px 热区 12px 圆点，hover 放大；左=target 右=source。
                 Konva 约束：v-if/动态 listening 会导致 hit graph 不刷新，故常驻渲染 +
                 opacity 控制可见 + hitFunc 动态开闭热区） -->
            <v-group v-for="o in objects" :key="'hd' + o.id" :config="{ x: o.x, y: o.y }">
              <v-circle
                :config="handleConfig(o, 'target')"
                @mousedown="onConnectStart(o.id, 'target', $event)"
              />
              <v-circle
                :config="handleConfig(o, 'source')"
                @mousedown="onConnectStart(o.id, 'source', $event)"
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
            :class="
              b.active
                ? 'border-[var(--wb-accent)] text-[var(--wb-accent)] bg-[var(--wb-accent)]/10'
                : 'border-[var(--wb-stroke)] hover:border-[var(--wb-accent)]'
            "
            @click="b.action"
          >
            <i :class="b.icon"></i>
          </button>
        </div>

        <!-- 模式提示条（裁剪工具激活时） -->
        <div
          v-if="tool"
          class="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-lg bg-black/60 backdrop-blur text-xs text-slate-200 flex items-center gap-2 z-10"
        >
          <i class="fas fa-vector-square text-sky-400"></i>
          <span>{{ t('canvasCropHint') }}</span>
          <button
            class="text-slate-400 hover:text-white"
            :title="t('canvasToolCancel')"
            @click.stop="setTool(null)"
          >
            <i class="fas fa-times"></i>
          </button>
        </div>

        <!-- 右键上下文菜单（物件/空地两态） -->
        <div
          v-if="ctxMenu"
          id="canvas-ctx-menu"
          class="absolute z-30 min-w-[170px] py-1 rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl text-xs"
          :style="{ left: ctxMenu.x + 'px', top: ctxMenu.y + 'px' }"
          @contextmenu.prevent
          @mousedown.stop
        >
          <template v-if="ctxMenu.kind === 'link'">
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="
                () => {
                  ctxMenu = null
                  deleteSelectedLink()
                }
              "
            >
              <i class="fas fa-link-slash w-4 text-center text-slate-400"></i
              >{{ t('canvasMenuDeleteLink') }}
            </button>
          </template>
          <template v-else-if="ctxMenu.targetIds.length">
            <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500">
              {{ ctxMenu.targetIds.length }} {{ t('canvasMenuItems') }}
            </div>
            <button
              v-for="m in ctxItems"
              :key="m.key"
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="m.run()"
            >
              <i class="fas w-4 text-center text-slate-400" :class="m.icon"></i>{{ m.label }}
            </button>
          </template>
          <template v-else>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="pasteAt(ctxMenu.wx, ctxMenu.wy)"
            >
              <i class="fas fa-paste w-4 text-center text-slate-400"></i>{{ t('canvasMenuPaste') }}
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="addNoteAt(ctxMenu.wx, ctxMenu.wy)"
            >
              <i class="fas fa-sticky-note w-4 text-center text-slate-400"></i
              >{{ t('canvasMenuNote') }}
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="addFrameAt(ctxMenu.wx, ctxMenu.wy)"
            >
              <i class="fas fa-object-ungroup w-4 text-center text-slate-400"></i
              >{{ t('canvasMenuFrame') }}
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="openAppPickerAtCtx()"
            >
              <i class="fas fa-cube w-4 text-center text-slate-400"></i>{{ t('canvasMenuAppNode') }}
            </button>
            <button
              class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
              @click="fitAll()"
            >
              <i class="fas fa-expand w-4 text-center text-slate-400"></i>{{ t('canvasMenuFit') }}
            </button>
          </template>
        </div>

        <!-- 选区快捷指令条（A14：框选后浮出，回车/▶ 直接生成） -->
        <div
          v-if="selPrompt"
          id="canvas-sel-prompt"
          class="absolute z-20 flex items-center gap-2 px-2 py-1.5 rounded-xl border border-[var(--wb-accent)]/50 bg-[var(--wb-surface)] shadow-lg"
          :style="{ left: selPrompt.x + 'px', top: selPrompt.y + 'px' }"
          @mousedown.stop
        >
          <i class="fas fa-wand-magic-sparkles text-[var(--wb-accent)] text-xs"></i>
          <input
            v-model="selPrompt.text"
            class="w-64 bg-transparent text-xs outline-none text-[var(--wb-text-1)]"
            :placeholder="t('canvasSelPromptPh')"
            @keydown.enter.stop="runSelPrompt()"
            @keydown.esc.stop="selPrompt = null"
          />
          <button
            class="w-7 h-7 rounded-lg bg-[var(--wb-accent)]/20 text-[var(--wb-accent)]"
            :title="t('canvasSelPromptRun')"
            @click="runSelPrompt()"
          >
            <i class="fas fa-paper-plane text-xs"></i>
          </button>
          <button
            class="w-7 h-7 rounded-lg text-slate-400 hover:text-white"
            :title="t('canvasMenuCompose')"
            @click="composeSelection()"
          >
            <i class="fas fa-layer-group text-xs"></i>
          </button>
        </div>

        <!-- 生成节点参数弹窗（N3：prompt 卡 → 执行 → 产物落布） -->
        <div
          v-if="genNode"
          class="absolute z-30 w-[320px] rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-2xl p-3 text-xs"
          :style="{ left: genNode.x + 'px', top: genNode.y + 'px' }"
          @mousedown.stop
        >
          <div class="flex items-center justify-between mb-2">
            <span class="font-medium text-[var(--wb-text-1)]"
              ><i class="fas fa-wand-magic-sparkles text-[var(--wb-accent)] mr-1"></i
              >{{ t('canvasGenNode') }}</span
            >
            <button class="text-slate-400 hover:text-white" @click="genNode = null">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <textarea
            v-model="genNode.prompt"
            rows="3"
            class="w-full rounded-lg bg-black/20 border border-[var(--wb-stroke)] px-2 py-1.5 outline-none text-[var(--wb-text-1)] resize-none"
            :placeholder="t('canvasGenPromptPh')"
          ></textarea>
          <div class="flex items-center gap-2 mt-2">
            <span class="text-slate-500"
              >{{ t('canvasGenRefs') }}: {{ genNode.refs.length || '0' }}</span
            >
            <button
              class="ml-auto px-3 py-1.5 rounded-lg bg-[var(--wb-accent)] text-white disabled:opacity-40"
              :disabled="genNode.running || !genNode.prompt.trim()"
              @click="runGenNode()"
            >
              <i class="fas" :class="genNode.running ? 'fa-spinner fa-spin' : 'fa-play'"></i>
              {{ genNode.running ? t('canvasGenRunning') : t('canvasGenRun') }}
            </button>
          </div>
        </div>

        <!-- App 节点展开参数面板（HTML overlay，锚定节点屏幕坐标） -->
        <AppNodeCard
          v-if="appPanel.node"
          :node="appPanel.node"
          :app="appPanelApp"
          :pos="appPanelPos"
          :fed-lines="appPanelFed"
          @close="appPanel.id = null"
          @run="runAppNode(appPanel.node.id)"
          @pick-canvas="pickCanvasImageFor"
          @open-full="openFullApp(appPanel.node)"
          @update-param="onPanelParamUpdate"
        />

        <!-- 应用拾取器（新建 App 节点） -->
        <AppPickerModal v-if="appPicker.open" @close="appPicker.open = false" @pick="onAppPicked" />

        <!-- AI 节点指令确认卡（P3：侧栏工作台 wb_canvas_ops → 人审 → 执行） -->
        <div v-if="pendingAgentOps" class="agent-ops-card" @mousedown.stop>
          <div class="flex items-center justify-between mb-1.5">
            <span class="text-xs font-medium text-[var(--wb-text-1)]">
              <i class="fas fa-robot text-[var(--wb-accent)] mr-1"></i
              >{{ t('canvasAgentOpsTitle') }}
            </span>
            <button class="text-slate-400 hover:text-white" @click="pendingAgentOps = null">
              <i class="fas fa-times"></i>
            </button>
          </div>
          <div class="ops-lines">
            <div v-for="(line, i) in agentOpsDiffLines" :key="i" class="ops-line">{{ line }}</div>
          </div>
          <div class="flex gap-2 mt-2">
            <button
              class="flex-1 py-1.5 rounded-lg bg-[var(--wb-accent)] text-white text-xs"
              @click="confirmAgentOps"
            >
              {{ t('canvasAgentOpsConfirm') }}
            </button>
            <button
              class="flex-1 py-1.5 rounded-lg border border-[var(--wb-stroke)] text-[var(--wb-text-2)] text-xs"
              @click="pendingAgentOps = null"
            >
              {{ t('canvasAgentOpsReject') }}
            </button>
          </div>
        </div>

        <!-- 缩放指示 -->
        <div
          class="absolute bottom-3 left-3 px-2 py-1 rounded bg-black/40 text-xs text-slate-300 font-mono"
        >
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
            :class="
              m.type === 'image'
                ? 'bg-sky-400/70'
                : m.type === 'app'
                  ? m.status === 'running'
                    ? 'bg-cyan-300 animate-pulse'
                    : 'bg-indigo-400/80'
                  : 'bg-slate-400/70'
            "
            :style="{ left: m.x + 'px', top: m.y + 'px', width: m.w + 'px', height: m.h + 'px' }"
          ></div>
          <!-- 当前视口框 -->
          <div
            class="absolute border border-[var(--wb-accent)] pointer-events-none"
            :style="{
              left: miniView.x + 'px',
              top: miniView.y + 'px',
              width: miniView.w + 'px',
              height: miniView.h + 'px',
            }"
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
import { useRouter } from 'vue-router'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import { drainFiles, pushAttachments } from '@/utils/canvasBridge'
import { useCanvasMode } from '@/utils/canvasMode'
import { message } from 'ant-design-vue'
import Workbench from '../workbench/index.vue'
import AppHeader from '../apps/components/AppHeader.vue'
import AppNodeCard from './AppNodeCard.vue'
import AppPickerModal from './AppPickerModal.vue'
import {
  makeAppNode,
  collectUpstream,
  buildNodeOverrides,
  paramFieldsFromTemplate,
  artifactLayout,
  appNodesDigest,
  imageObjectRef,
} from './appNode'
import {
  makeViewport,
  screenToWorld,
  worldToScreen,
  zoomAtPoint,
  hitTest,
  hitTestRect,
  snapDelta,
  snapGuides,
  bboxOf,
  serializeDoc,
  parseDoc,
  linkEndpoints,
  bezierLinkPath,
  distToSegment,
  cropRectFor,
  createHistory,
  pushHistory,
  undo as engineUndo,
  redo as engineRedo,
  canUndo as engineCanUndo,
  canRedo as engineCanRedo,
  objectInFrame,
  objectsInFrame,
  gridLayout,
  subtreeOf,
} from './engine'

const { t } = useI18n()
const appStore = useAppStore()
const router = useRouter()
const { onResult, emitAttachments, emitCanvasState, emitPrompt, onOps } = useCanvasMode()
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
// 交互工具模式：null=选择 | 'crop'=圈图裁剪（连线走句柄拖拽）
const tool = ref(null)
const spaceDown = ref(false) // 空格按住 = 强制平移
const cropRect = ref(null) // 'crop' 模式拖出的世界矩形
// —— 连线（参考 infinite-canvas）：句柄拖拽建线 + 连线点选 ——
const connectDrag = reactive({
  active: false,
  nodeId: null, // 起始物件 id
  handleType: null, // 'source'（右句柄，from）| 'target'（左句柄，to）
  seg: null, // 预览贝塞尔端点 {x1,y1,x2,y2}
  targetId: null, // 悬停吸附的目标物件 id
})
const selectedLinkId = ref(null) // 选中的连线 id（参考 selectedConnectionId）
const hoverNodeId = ref(null) // 悬停物件 id（句柄显现条件，参考 hovered || isSelected || isConnecting）
/** 物件是否显示连接句柄：悬停/选中/连线拖拽中（起点与悬停目标，参考 isConnecting 全显） */
function showHandles(o) {
  return (
    hoverNodeId.value === o.id ||
    selection.value.includes(o.id) ||
    (connectDrag.active && (connectDrag.nodeId === o.id || connectDrag.targetId === o.id))
  )
}
/** 句柄显隐切换后 Konva 不会自动重绘 hit graph（hitFunc 结果变化），手动补绘 */
function redrawHandleHits() {
  nextTick(() => {
    const st = stageEl.value?.getStage?.()
    st?.getLayers().forEach((l) => l.drawHit())
  })
}
watch(
  [hoverNodeId, selectedLinkId, () => [connectDrag.active, connectDrag.targetId]],
  redrawHandleHits,
  {
    deep: false,
  },
)
watch(
  () => selection.value.length,
  () => redrawHandleHits(),
)
/**
 * 句柄 circle 配置（参考 ConnectionHandleDot：12px 圆点 / 48px 热区 / hover 放大）。
 * 常驻渲染（opacity 控制可见）避免 Konva v-if 的 hit graph 不刷新问题；
 * hitFunc 仅在 showHandles 时提供热区，平时不拦截物件交互。
 */
function handleConfig(o, side) {
  const hovered = hoverNodeId.value === o.id
  return {
    x: side === 'target' ? 0 : o.width,
    y: o.height / 2,
    radius: (hovered ? 7.5 : 6) / viewport.value.scale,
    fill: '#1f1d1a',
    stroke: '#d6d3d1',
    strokeWidth: 2 / viewport.value.scale,
    opacity: showHandles(o) ? 1 : 0,
    cursor: 'crosshair',
    // hitFunc 读实时状态（不闭包 on）：hit graph 重绘时按当下显隐提供热区。
    // ctx 已变换到 shape 本地坐标系，圆心取 (0,0)；24px 热区半径（参考 size-12 = 48px 热区）
    hitFunc(ctx, shape) {
      if (!showHandles(o)) return
      const r = 24 / viewport.value.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}

// —— 撤销/重做（有界快照栈；快照 = objects+links+groups 序列化） ——
const history = ref(createHistory(60))
let historyPaused = false // 拖拽等连续操作期间暂停记录
function docSnapshot() {
  return serializeDoc(objects.value, viewport.value, 'canvas', links.value, groups.value)
}
/** 变更前调用：把当前状态压栈，使 undo 能回到此刻（historyPaused 期间跳过） */
function beforeChange() {
  if (historyPaused) return
  history.value = pushHistory(history.value, docSnapshot())
}
function undoLast() {
  const r = engineUndo(history.value, docSnapshot())
  if (!r.snapshot) return
  historyPaused = true
  applyDoc(r.snapshot)
  history.value = r.history
  nextTick(() => (historyPaused = false))
}
function redoLast() {
  const r = engineRedo(history.value, docSnapshot())
  if (!r.snapshot) return
  historyPaused = true
  applyDoc(r.snapshot)
  history.value = r.history
  nextTick(() => (historyPaused = false))
}
/** 应用文档快照（undo/redo/load 共用） */
function applyDoc(snapshot) {
  const d = parseDoc(snapshot)
  objects.value = d.objects
  links.value = d.links
  groups.value = d.groups
  selection.value = selection.value.filter((id) => objects.value.some((o) => o.id === id))
  layerRefresh()
  saveSoon()
}

// stage 不整体 draggable——空地平移由容器级 mousedown 自实现（bg 矩形会抢物件命中）
// 视口直接绑定 stage config（vue-konva 自动同步，避免 rAF 时机竞态导致 reload 视口丢失）
const stageConfig = computed(() => ({
  width: size.w,
  height: size.h,
  scaleX: viewport.value.scale,
  scaleY: viewport.value.scale,
  x: viewport.value.x,
  y: viewport.value.y,
}))
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
    ? {
        points: [v, -s / 2, v, s / 2],
        stroke: '#38bdf8',
        strokeWidth: 1 / viewport.value.scale,
        dash: [4, 4],
        listening: false,
      }
    : {
        points: [-s / 2, v, s / 2, v],
        stroke: '#38bdf8',
        strokeWidth: 1 / viewport.value.scale,
        dash: [4, 4],
        listening: false,
      }
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
  hoverNodeId.value = objects.value[i].id
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

// —— 连接句柄拖拽建线（参考 infinite-canvas onConnectStart/handleConnectMove）——
/** Konva 事件对象无 preventDefault/stopPropagation，Vue .prevent/.stop 修饰符会抛错；
 *  统一在此代理到原生 evt（kev.evt 为浏览器原生事件） */
function stopKonvaEvent(kev) {
  kev?.cancelBubble && (kev.cancelBubble = true) // Konva 冒泡阻断
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
/** connect 拖拽中：预览端点跟随鼠标，命中物件则吸附到其边缘（参考 ActiveConnectionPath snapped*） */
function onConnectMove() {
  if (!connectDrag.active || !connectDrag.seg) return
  const st = stageEl.value.getStage()
  const p = st.getPointerPosition()
  if (!p) return
  const w = screenToWorld(viewport.value, p.x, p.y)
  const start = { x: connectDrag.seg.x1, y: connectDrag.seg.y1 }
  // 悬停吸附：找指针下物件（非起点、有内容物件），端点贴其近侧边缘中点
  const hit = hitTest(objects.value, w.x, w.y)
  const hoverObj = hit >= 0 ? objects.value[hit] : null
  const target = hoverObj && hoverObj.id !== connectDrag.nodeId ? hoverObj : null
  connectDrag.targetId = target ? target.id : null
  const end = target
    ? connectDrag.handleType === 'source'
      ? { x: target.x, y: target.y + target.height / 2 }
      : { x: target.x + target.width, y: target.y + target.height / 2 }
    : { x: w.x, y: w.y }
  connectDrag.seg = { ...start, ...end }
}
/** connect 松手：落在物件上且非起点/无重复 → 建线（参考 handleConnectEnd） */
function onConnectEnd() {
  if (!connectDrag.active) return
  const { nodeId, handleType, targetId } = connectDrag
  connectDrag.active = false
  connectDrag.seg = null
  connectDrag.targetId = null
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

function onMouseDown(e) {
  // 空地（没点到任何 shape）按下：
  //   普通拖 = 平移画布；Shift/中键 拖 = 框选；crop 工具 = 圈选裁剪
  // 物件按下（onItemDown 先触发，drag.mode='item'）时 stage 级事件直接跳过
  if (drag.mode === 'item' || drag.mode === 'connect') return
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
    selectedLinkId.value = null // 空地点击清除连线选中（参考选中互斥）
  }
  if (ctxMenu.value) ctxMenu.value = null
}

function onMouseMove(e) {
  const st = stageEl.value.getStage()
  const p = st.getPointerPosition()
  if (!p) return
  // 悬停追踪（参考 onHoverStart/End）：句柄显现 + 圆点放大
  if (!drag.mode || drag.mode === 'pan') {
    const w = screenToWorld(viewport.value, p.x, p.y)
    const hit = hitTest(objects.value, w.x, w.y)
    const id = hit >= 0 ? objects.value[hit].id : null
    if (id !== hoverNodeId.value) hoverNodeId.value = id
  }
  if (drag.mode === 'connect') {
    onConnectMove()
    return
  }
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
  if (drag.mode === 'connect') {
    onConnectEnd()
    drag.mode = null
    drag.last = null
    return
  }
  if (drag.mode === 'rubber' && rubber.value) {
    const r = rubber.value
    if (Math.abs(r.w) > 4 || Math.abs(r.h) > 4) {
      const hits = hitTestRect(objects.value, r.x, r.y, r.w, r.h)
      selection.value = hits.map((i) => objects.value[i].id)
      if (selection.value.length) openSelPrompt()
    } else {
      selPrompt.value = null
    }
    rubber.value = null
  } else if (drag.mode === 'crop' && cropRect.value) {
    const r = cropRect.value
    if (Math.abs(r.w) > 8 && Math.abs(r.h) > 8) cropAndSend(r)
    cropRect.value = null
    tool.value = null
    syncDraggables()
  }
  drag.mode = null
  drag.last = null
  saveSoon()
}

let dragRecorded = false // 本次拖拽是否已压历史栈
function onNodeDrag(e) {
  // 物件拖拽中的吸附（e 为 Konva 原生事件对象）
  const node = e.target
  if (!dragRecorded) {
    beforeChange()
    dragRecorded = true
  }
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
  dragRecorded = false
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
  {
    icon: 'fas fa-rotate-left',
    title: t('canvasUndo'),
    action: undoLast,
    disabled: !engineCanUndo(history.value),
  },
  {
    icon: 'fas fa-rotate-right',
    title: t('canvasRedo'),
    action: redoLast,
    disabled: !engineCanRedo(history.value),
  },
  { icon: 'fas fa-plus', title: t('canvasAddNote'), action: addNote },
  {
    icon: 'fas fa-cube',
    title: t('canvasAddAppNode'),
    action: () => {
      const c = screenToWorld(viewport.value, size.w / 2, size.h / 2)
      openAppPicker(c.x, c.y)
    },
  },
  {
    icon: 'fas fa-play',
    title: t('canvasRunAppNodes'),
    action: () => runAppNodes(selection.value),
    disabled: !selection.value.some((id) => objects.value.find((o) => o.id === id)?.type === 'app'),
  },
  {
    icon: 'fas fa-border-none',
    title: t('canvasFrameBtn'),
    action: () => {
      const c = screenToWorld(viewport.value, size.w / 2, size.h / 2)
      addFrameAt(c.x, c.y)
    },
  },
  {
    icon: 'fas fa-film',
    title: t('canvasShotsBtn'),
    action: () => {
      const c = screenToWorld(viewport.value, size.w / 2, size.h / 2)
      addShotAt(c.x, c.y)
    },
  },
  {
    icon: 'fas fa-wand-magic-sparkles',
    title: t('canvasGenNode'),
    action: () => openGenNode(selection.value),
  },
  {
    icon: 'fas fa-vector-square',
    title: t('canvasCropTool'),
    action: () => setTool('crop'),
    active: tool.value === 'crop',
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
  beforeChange()
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

// —— I2 右键上下文菜单 ——
const ctxMenu = ref(null) // {x,y(屏幕), wx,wy(世界), targetIds:[]}
function closeCtxMenu() {
  ctxMenu.value = null
}
const ctxItems = computed(() => {
  if (!ctxMenu.value) return []
  const ids = ctxMenu.value.targetIds
  const hasImg = ids.some((id) => (objects.value.find((o) => o.id === id) || {}).type === 'image')
  const appIds = ids.filter((id) => (objects.value.find((o) => o.id === id) || {}).type === 'app')
  const items = [
    {
      key: 'copy',
      icon: 'fa-copy',
      label: t('canvasMenuCopy'),
      run: () => {
        copySelection()
        closeCtxMenu()
      },
    },
  ]
  if (appIds.length) {
    items.push(
      {
        key: 'app-run',
        icon: 'fa-play',
        label: t('canvasCtxRunApp'),
        run: () => {
          runAppNodes(appIds)
          closeCtxMenu()
        },
      },
      {
        key: 'app-panel',
        icon: 'fa-gear',
        label: t('canvasCtxAppPanel'),
        run: () => {
          openAppNodePanel(appIds[0])
          closeCtxMenu()
        },
      },
      {
        key: 'app-full',
        icon: 'fa-up-right-from-square',
        label: t('canvasCtxAppFull'),
        run: () => {
          openFullApp(objects.value.find((o) => o.id === appIds[0]))
          closeCtxMenu()
        },
      },
    )
  }
  if (hasImg) {
    items.push(
      {
        key: 'ref',
        icon: 'fa-paper-plane',
        label: t('canvasMenuSendWb'),
        run: () => {
          sendSelectionToWorkbench()
          closeCtxMenu()
        },
      },
      {
        key: 'gen',
        icon: 'fa-wand-magic-sparkles',
        label: t('canvasMenuGen'),
        run: () => {
          openGenNode(ids)
          closeCtxMenu()
        },
      },
      {
        key: 'crop',
        icon: 'fa-crop',
        label: t('canvasCropTool'),
        run: () => {
          setTool('crop')
          closeCtxMenu()
        },
      },
      {
        key: 'inpaint',
        icon: 'fa-paint-brush',
        label: t('canvasMenuInpaint'),
        run: () => {
          startInpaint(ids[0])
          closeCtxMenu()
        },
      },
      {
        key: 'reverse',
        icon: 'fa-comment-dots',
        label: t('canvasMenuReverse'),
        run: () => {
          reversePrompt(ids[0])
          closeCtxMenu()
        },
      },
      {
        key: 'enhance',
        icon: 'fa-up-right-and-down-left-from-center',
        label: t('canvasMenuEnhance'),
        run: () => {
          enhanceImage(ids[0])
          closeCtxMenu()
        },
      },
      {
        key: 'outpaint',
        icon: 'fa-expand-arrows-alt',
        label: t('canvasMenuOutpaint'),
        run: () => {
          startOutpaint(ids[0])
          closeCtxMenu()
        },
      },
      {
        key: 'video',
        icon: 'fa-film',
        label: t('canvasMenuVideo'),
        run: () => {
          imageToVideo(ids[0])
          closeCtxMenu()
        },
      },
      {
        key: 'char',
        icon: 'fa-user-tag',
        label: t('canvasMenuSetChar'),
        run: () => {
          setConsistencyAsset(ids[0], 'character')
          closeCtxMenu()
        },
      },
      {
        key: 'style',
        icon: 'fa-palette',
        label: t('canvasMenuSetStyle'),
        run: () => {
          setConsistencyAsset(ids[0], 'style')
          closeCtxMenu()
        },
      },
    )
  }
  if (ids.length >= 2) {
    items.push(
      {
        key: 'compose',
        icon: 'fa-layer-group',
        label: t('canvasMenuCompose'),
        run: () => {
          composeSelection()
          closeCtxMenu()
        },
      },
      {
        key: 'group',
        icon: 'fa-object-group',
        label: t('canvasGroupSel'),
        run: () => {
          groupSelected()
          closeCtxMenu()
        },
      },
    )
  }
  items.push(
    {
      key: 'front',
      icon: 'fa-arrow-up',
      label: t('canvasMenuFront'),
      run: () => {
        bringToFront(ids)
        closeCtxMenu()
      },
    },
    {
      key: 'del',
      icon: 'fa-trash',
      label: t('canvasMenuDelete'),
      run: () => {
        deleteSelected()
        closeCtxMenu()
      },
    },
  )
  return items
})
function bringToFront(ids) {
  const set = new Set(ids)
  beforeChange()
  const picked = objects.value.filter((o) => set.has(o.id))
  objects.value = [...objects.value.filter((o) => !set.has(o.id)), ...picked]
  saveSoon()
}
function pasteAt(wx, wy) {
  if (!clipboard.value.length) return
  const cur = clipboard.value
  const b = bboxOf(cur)
  const dx = wx - (b.x + b.width / 2)
  const dy = wy - (b.y + b.height / 2)
  const idMap = new Map()
  const fresh = cur.map((o) => {
    const nid = 'n' + Date.now() + Math.random().toString(36).slice(2, 6)
    idMap.set(o.id, nid)
    return { ...JSON.parse(JSON.stringify(o)), id: nid, x: o.x + dx, y: o.y + dy }
  })
  beforeChange()
  objects.value.push(...fresh)
  selection.value = fresh.map((o) => o.id)
  for (const l of links.value) {
    if (idMap.has(l.from) && idMap.has(l.to)) {
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
        from: idMap.get(l.from),
        to: idMap.get(l.to),
      })
    }
  }
  closeCtxMenu()
  saveSoon()
}
function addNoteAt(wx, wy) {
  beforeChange()
  objects.value.push({
    id: 'n' + Date.now(),
    type: 'note',
    x: wx - 90,
    y: wy - 60,
    width: 180,
    height: 120,
    text: '',
  })
  closeCtxMenu()
  saveSoon()
}

// —— A14 选区快捷指令条 ——
const selPrompt = ref(null) // {x,y,text}
function openSelPrompt() {
  if (!selection.value.length) return
  const b = bboxOf(objects.value.filter((o) => selection.value.includes(o.id)))
  const tl = worldToScreen(viewport.value, b.x, b.y)
  selPrompt.value = {
    x: clamp(tl.x, 8, size.w - 380),
    y: clamp(tl.y - 52, 8, size.h - 60),
    text: '',
  }
}
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
  closeCtxMenu()
  message.success(t('canvasSelPromptSent'))
}

// —— N3 生成节点（prompt 卡弹窗；产物落布+溯源） ——
const genNode = ref(null) // {x,y,prompt,refs:[],running}
function openGenNode(ids = []) {
  const imgs = ids.filter((id) => (objects.value.find((o) => o.id === id) || {}).type === 'image')
  const refs = imgs.map(refOf).filter(Boolean)
  const c = screenToWorld(viewport.value, size.w / 2, size.h / 2)
  const s = worldToScreen(viewport.value, c.x, c.y)
  genNode.value = {
    x: clamp(s.x - 160, 8, size.w - 330),
    y: clamp(s.y - 90, 8, size.h - 200),
    prompt: '',
    refs,
    running: false,
  }
}
async function runGenNode() {
  const g = genNode.value
  if (!g || g.running || !g.prompt.trim()) return
  g.running = true
  lastSourceIds = [...g.refs.map((r) => r.__id || '')].filter(Boolean)
  // refs 是附件形态 {filename,...}；按物件 id 反查溯源
  emitPrompt(g.prompt, { autoSend: true, attachments: g.refs })
  genNode.value = null
  message.success(t('canvasSelPromptSent'))
}

// —— A1 画布内 inpaint / A2 扩图 / A9 增强 / A7 反推 / A4 视频 / A10 一致性 ——
// 这些动作都收敛为「把指令+目标附件发工作台执行」，产物经 onResult 自动落布+溯源。
const inpaintMask = ref(null) // {objId, points:[]} 简化：暂以选区矩形为蒙版
function startInpaint(objId) {
  const o = objects.value.find((x) => x.id === objId)
  if (!o) return
  lastSourceIds = [objId]
  emitPrompt(t('canvasInpaintPrompt'), {
    autoSend: true,
    attachments: [refOf(objId)].filter(Boolean),
  })
  message.info(t('canvasAiQueued'))
}
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
  const ids = hitTest(objects.value, w.x, w.y)
  const targetIds = ids.length
    ? selection.value.length && ids.some((id) => selection.value.includes(id))
      ? selection.value
      : [ids[0]]
    : []
  if (targetIds.length) selection.value = targetIds
  ctxMenu.value = { x: sx + 8, y: sy + 8, wx: w.x, wy: w.y, targetIds }
}

// —— N10 Frame 分区 ——
function addFrameAt(wx, wy) {
  beforeChange()
  objects.value.push({
    id: 'f' + Date.now(),
    type: 'frame',
    x: wx - 200,
    y: wy - 140,
    width: 400,
    height: 280,
    name: t('canvasFrameDefault'),
  })
  closeCtxMenu()
  saveSoon()
}
const frameObjects = computed(() => objects.value.filter((o) => o.type === 'frame'))
function frameConfig(o) {
  return {
    id: o.id,
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    fill: 'rgba(99,102,241,0.05)',
    stroke: 'rgba(129,140,248,0.5)',
    strokeWidth: 1.5,
    dash: [8, 6],
    cornerRadius: 10,
  }
}
function frameLabelConfig(o) {
  return {
    text: o.name || 'Frame',
    x: o.x,
    y: o.y - 20,
    width: o.width,
    fontSize: 13,
    fill: '#818cf8',
    align: 'left',
  }
}
function shotRectConfig(o) {
  return {
    x: o.x,
    y: o.y,
    width: o.width,
    height: o.height,
    fill: 'rgba(20,184,166,0.08)',
    stroke: o.src ? 'rgba(45,212,191,0.7)' : 'rgba(20,184,166,0.45)',
    strokeWidth: 1.5,
    cornerRadius: 8,
  }
}
function shotSeqConfig(o) {
  return {
    text: `#${o.seq || 1}`,
    x: o.x + 8,
    y: o.y + 6,
    fontSize: 12,
    fontStyle: 'bold',
    fill: '#2dd4bf',
    listening: false,
  }
}
function shotTextConfig(o) {
  return {
    text: o.text || '',
    x: o.x + 8,
    y: o.y + 24,
    width: o.width - 16,
    height: o.height - 32,
    fontSize: 11,
    fill: '#94a3b8',
    listening: false,
  }
}

// —— N5 分镜帧（storyboard shot 卡：镜号+画面+描述；A5 批量生成） ——
function addShotAt(wx, wy) {
  beforeChange()
  objects.value.push({
    id: 's' + Date.now(),
    type: 'shot',
    x: wx - 110,
    y: wy - 80,
    width: 220,
    height: 160,
    seq: shotSeqNext(),
    text: '',
    src: '',
  })
  closeCtxMenu()
  saveSoon()
}
function shotSeqNext() {
  return objects.value.filter((o) => o.type === 'shot').length + 1
}
const shotObjects = computed(() =>
  objects.value.filter((o) => o.type === 'shot').sort((a, b) => (a.seq || 0) - (b.seq || 0)),
)

// —— A5 分镜批量：把 shot 的 text 逐条发工作台，产物按列网格落布 ——
function batchShots() {
  const shots = shotObjects.value.filter((s) => (s.text || '').trim())
  if (!shots.length) return
  const seqs = shots.map((s) => s.seq)
  emitPrompt(
    t('canvasBatchShotsPrompt').replace('{n}', String(shots.length)) +
      '\n' +
      shots.map((s) => `#${s.seq}: ${s.text.trim()}`).join('\n'),
    { autoSend: true, attachments: [] },
  )
  message.info(t('canvasBatchShotsQueued').replace('{n}', String(shots.length)))
}

function fitAll() {
  if (!objects.value.length) return resetView()
  const b = bboxOf(objects.value)
  const pad = 60
  const scale = clamp(
    Math.min((size.w - pad * 2) / b.width, (size.h - pad * 2) / b.height),
    MIN_SCALE,
    MAX_SCALE,
  )
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
  beforeChange()
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
  beforeChange()
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
  beforeChange()
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

// —— 连线点选/右键（参考 infinite-canvas ConnectionPath onSelect/onContextMenu）——
function onLinkDown(e) {
  const id = e.target.id()
  // 仅左键选中；e.evt.button === 2 右键走 contextmenu
  if (e.evt && e.evt.button !== undefined && e.evt.button !== 0) return
  selectedLinkId.value = id
  selection.value = [] // 连线与物件互斥选中（参考 setSelectedConnectionId + setSelectedNodeIds(new Set())）
}
function onLinkContextMenu(evt, id) {
  selectedLinkId.value = id
  // Konva 事件对象不兼容 Vue .prevent 修饰符，代理到原生 evt
  const native = evt?.evt || evt
  native?.preventDefault?.()
  native?.stopPropagation?.()
  ctxMenu.value = {
    kind: 'link',
    id,
    x: (native.clientX ?? 0) + 2,
    y: (native.clientY ?? 0) + 2,
    wx: 0,
    wy: 0,
    targetIds: [],
  }
}
function deleteSelectedLink() {
  if (!selectedLinkId.value) return
  beforeChange()
  links.value = links.value.filter((l) => l.id !== selectedLinkId.value)
  selectedLinkId.value = null
  saveSoon()
}

// —— 复制/粘贴（Ctrl+C/V；剪贴板 = 序列化物件数组，粘贴时重生成 id + 偏移 24px） ——
const clipboard = ref([]) // 深拷贝的物件数组
function copySelection() {
  if (!selection.value.length) return
  clipboard.value = selection.value
    .map((id) => objects.value.find((o) => o.id === id))
    .filter(Boolean)
    .map((o) => JSON.parse(JSON.stringify(o)))
  if (clipboard.value.length)
    message.info(t('canvasCopied').replace('{n}', String(clipboard.value.length)))
}
function pasteClipboard() {
  if (!clipboard.value.length) return
  beforeChange()
  const idMap = new Map()
  const fresh = clipboard.value.map((o) => {
    const nid = 'n' + Date.now() + Math.random().toString(36).slice(2, 6)
    idMap.set(o.id, nid)
    return { ...JSON.parse(JSON.stringify(o)), id: nid, x: o.x + 24, y: o.y + 24 }
  })
  objects.value.push(...fresh)
  selection.value = fresh.map((o) => o.id)
  // 物件内部的连线一并复制（两端都在剪贴板内的）
  const innerLinks = links.value.filter((l) => idMap.has(l.from) && idMap.has(l.to))
  for (const l of innerLinks) {
    links.value.push({
      id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
      from: idMap.get(l.from),
      to: idMap.get(l.to),
    })
  }
  saveSoon()
}
// Alt+拖拽克隆（节点 dragstart 时按住 Alt 则复制一份再拖副本）
function cloneOnDrag(i) {
  const src = objects.value[i]
  const nid = 'n' + Date.now() + Math.random().toString(36).slice(2, 6)
  const copy = { ...JSON.parse(JSON.stringify(src)), id: nid }
  objects.value.push(copy)
  return objects.value.length - 1
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
  beforeChange()
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

// —— App 节点（P1/P2：画布上的 A 应用实例，可随时运行） ——
const appNodeObjects = computed(() => objects.value.filter((o) => o.type === 'app'))

// app 详情缓存：appId → 完整 app（含 template；picker 拾取/详情接口回填）
// cacheVer 是响应式触发器：Map.set 不触发 computed，靠版本号驱动面板刷新
const appCache = new Map()
const appCacheVer = ref(0)
async function ensureAppDetail(appId) {
  if (appCache.has(appId)) return appCache.get(appId)
  try {
    const app = await appStore.getAppById(appId)
    if (app) {
      appCache.set(appId, app)
      appCacheVer.value++
    }
    return app || null
  } catch {
    return null
  }
}

const appPicker = reactive({ open: false, wx: 0, wy: 0 })
function openAppPicker(wx, wy) {
  appPicker.wx = wx
  appPicker.wy = wy
  appPicker.open = true
}
function onAppPicked(app) {
  appPicker.open = false
  if (!app?.id) return
  // picker 的 app 已带完整 template —— 立即入缓存（面板字段即时渲染）
  appCache.set(app.id, app)
  appCacheVer.value++
  beforeChange()
  const node = makeAppNode(app.id, app.name, appPicker.wx, appPicker.wy)
  objects.value.push(node)
  selection.value = [node.id]
  saveSoon()
  // 拾取即展开参数面板
  nextTick(() => openAppNodePanel(node.id))
}

/** 右键菜单位置开拾取器（点选后关闭菜单） */
function openAppPickerAtCtx() {
  openAppPicker(ctxMenu.value?.wx ?? 0, ctxMenu.value?.wy ?? 0)
  closeCtxMenu()
}

// 展开面板状态：{ id } —— node/pos/fed 全部由 computed 派生（视口/节点变化自动跟随）
const appPanel = reactive({ id: null })
const appPanelNode = computed(() => objects.value.find((o) => o.id === appPanel.id) || null)
// 兼容旧引用：模板里直接用 appPanel.node（computed 语义）
Object.defineProperty(appPanel, 'node', {
  get: () => appPanelNode.value,
  enumerable: true,
})
const appPanelApp = computed(() => {
  appCacheVer.value // 依赖缓存版本（Map.set 本身不触发）
  return appPanelNode.value ? appCache.get(appPanelNode.value.appId) || null : null
})
const appPanelPos = computed(() => {
  const n = appPanelNode.value
  if (!n) return { x: 0, y: 0 }
  const tl = worldToScreen(viewport.value, n.x + n.width, n.y)
  return {
    x: clamp(tl.x + 12, 8, Math.max(8, size.w - 336)),
    y: clamp(tl.y, 8, Math.max(8, size.h - 120)),
  }
})
const appPanelFed = ref([])
function openAppNodePanel(id) {
  const node = objects.value.find((o) => o.id === id)
  if (!node || node.type !== 'app') return
  appPanel.id = id
  // 异步补 app 详情 + 刷新喂养提示
  void ensureAppDetail(node.appId).then(refreshFed)
}
/** Konva 卡上 ⚙ 按钮（Konva 事件对象不兼容 Vue .prevent/.stop 修饰符，代理进 handler） */
function openAppNodePanelFromKonva(id, kev) {
  stopKonvaEvent(kev)
  openAppNodePanel(id)
}
/** Konva 卡上 ▶ 按钮 */
function runAppNodeFromKonva(id, kev) {
  stopKonvaEvent(kev)
  runAppNode(id)
}
function refreshFed() {
  const node = appPanelNode.value
  const app = appPanelApp.value
  if (!node || !app) {
    appPanelFed.value = []
    return
  }
  const up = collectUpstream(node.id, objects.value, links.value)
  const { fedFields } = buildNodeOverrides(node, paramFieldsFromTemplate(app), up)
  appPanelFed.value = fedFields
}

// 参数面板打开时：文档/视口/连线/app 缓存变化刷新喂养提示
// （appCacheVer：Map.set 不触发响应，靠版本号驱动 detail 到达后的重算）
watch(
  () => [
    appPanel.id,
    links.value.length,
    objects.value.length,
    Math.round(viewport.value.scale * 4),
    appCacheVer.value,
  ],
  () => {
    if (appPanel.id) refreshFed()
  },
)

/** 参数面板写回（AppNodeCard update-param 事件：子组件不改 prop，由宿主落） */
function onPanelParamUpdate({ nodeId, key, value }) {
  const node = appPanelNode.value
  if (!node) return
  if (!node.params) node.params = {}
  if (!node.params[nodeId]) node.params[nodeId] = {}
  node.params[nodeId][key] = value
  saveSoon()
}

/** 画布拾取一张图喂给参数槽（pick-canvas 事件：选图片物件或直接手填） */
function pickCanvasImageFor(field) {
  const imgs = objects.value.filter((o) => o.type === 'image')
  if (!imgs.length) {
    message.info(t('canvasAppNodeNoImages'))
    return
  }
  // 无 UI 树的轻量选择：按离节点最近的一张
  const node = appPanelNode.value
  let best = imgs[0]
  if (node) {
    let bestD = Infinity
    for (const img of imgs) {
      const d = (img.x - node.x) ** 2 + (img.y - node.y) ** 2
      if (d < bestD) {
        bestD = d
        best = img
      }
    }
  }
  const ref = imageObjectRef(best)
  if (!ref?.filename) {
    message.info(t('canvasAppNodeNoViewRef'))
    return
  }
  if (!appPanelNode.value.params) appPanelNode.value.params = {}
  if (!appPanelNode.value.params[field.nodeId]) appPanelNode.value.params[field.nodeId] = {}
  appPanelNode.value.params[field.nodeId][field.key] = ref.filename
  message.success(t('canvasAppNodeFed').replace('{f}', field.label).replace('{n}', ref.filename))
}

/** 弹窗打开完整应用（genHtml iframe 预览，复杂交互兜底） */
async function openFullApp(node) {
  const app = await ensureAppDetail(node.appId)
  if (!app) {
    message.warning(t('canvasAppNodeAppMissing'))
    return
  }
  await appStore.updateConfig({ activeAppId: node.appId })
  router.push({ path: '/web' })
}

// —— P2 运行链路 ——
const POLL_INTERVAL = 2500
const nodePolls = new Map() // nodeId → interval id
const serverOrigin = computed(() => appStore.config?.serverHost || window.location.origin)

/** 运行一个 app 节点：参数聚合 → POST /api/canvas/execute → 状态机轮询 → 产物落布 */
async function runAppNode(id) {
  const node = objects.value.find((o) => o.id === id)
  if (!node || node.type !== 'app' || node.status === 'running') return
  const app = await ensureAppDetail(node.appId)
  if (!app?.template?.prompt || !Object.keys(app.template.prompt).length) {
    node.status = 'error'
    node.statusText = t('canvasAppNodeAppMissing')
    saveSoon()
    return
  }
  const fields = paramFieldsFromTemplate(app)
  const up = collectUpstream(node.id, objects.value, links.value)
  const { overrides } = buildNodeOverrides(node, fields, up)
  // nodeOverrides 形状：{ [nodeId]: { widgetOverrides: {...} } }
  const nodeOverrides = {}
  for (const [nid, widgets] of Object.entries(overrides)) {
    nodeOverrides[nid] = { widgetOverrides: widgets }
  }
  node.status = 'running'
  node.statusText = t('canvasAppNodeQueued')
  node.lastRunSourceIds = up.srcIds
  saveSoon()
  try {
    const res = await fetch(`${serverOrigin.value}/api/canvas/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: app.template.prompt,
        nodeOverrides: Object.keys(nodeOverrides).length ? nodeOverrides : undefined,
        name: node.name || node.appId,
      }),
    })
    const j = await res.json().catch(() => null)
    if (!res.ok || !j?.success) throw new Error(j?.message || j?.error || `HTTP ${res.status}`)
    const promptId = j.data.promptId
    node.lastRun = { promptId, at: Date.now() }
    node.statusText = t('canvasAppNodeRunningStatus')
    startNodePoll(node.id, promptId)
  } catch (e) {
    node.status = 'error'
    node.statusText = String(e?.message || e).slice(0, 120)
    saveSoon()
  }
}

/** 批量运行：选中多个 app 节点依次触发（服务端排队天然并行） */
function runAppNodes(ids) {
  const targets = ids.filter((id) => {
    const o = objects.value.find((x) => x.id === id)
    return o?.type === 'app' && o.status !== 'running'
  })
  for (const id of targets) void runAppNode(id)
  if (targets.length)
    message.info(t('canvasAppNodeBatchQueued').replace('{n}', String(targets.length)))
}

function startNodePoll(nodeId, promptId) {
  stopNodePoll(nodeId)
  const tick = async () => {
    const node = objects.value.find((o) => o.id === nodeId)
    if (!node) return stopNodePoll(nodeId)
    try {
      const res = await fetch(
        `${serverOrigin.value}/api/canvas/execute-status?promptId=${encodeURIComponent(promptId)}`,
      )
      const j = await res.json().catch(() => null)
      const r = j?.data
      if (!r || r.status === 'running') return
      stopNodePoll(nodeId)
      if (r.status === 'success') {
        node.status = 'success'
        node.statusText = t('canvasAppNodeDone')
        placeNodeArtifacts(node, extractStatusFiles(r))
      } else {
        node.status = 'error'
        node.statusText = String(r.error || 'error').slice(0, 120)
      }
      saveSoon()
    } catch {
      /* 下轮重试 */
    }
  }
  nodePolls.set(nodeId, setInterval(tick, POLL_INTERVAL))
  void tick()
}
function stopNodePoll(nodeId) {
  const t = nodePolls.get(nodeId)
  if (t) clearInterval(t)
  nodePolls.delete(nodeId)
}

/** 轮询结果 outputs → 文件列表（服务端已全扫为 outputs.files） */
function extractStatusFiles(r) {
  const files = Array.isArray(r?.outputs?.files) ? r.outputs.files : []
  return files
    .filter((f) => f && f.filename)
    .map((f) => ({ filename: f.filename, subfolder: f.subfolder || '', type: f.type || 'output' }))
}

/** 产物落布：节点右侧一列 + 溯源连线（app 节点 → 产物） */
function placeNodeArtifacts(node, files) {
  if (!files?.length) return
  const origin = appStore.config?.comfyHost || 'http://127.0.0.1:8188'
  // 预取尺寸定布局（artifactLayout 纯函数给列坐标；加载失败不落布）
  const urls = files.map(
    (f) =>
      `${origin}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder ?? '')}&type=${encodeURIComponent(f.type ?? 'output')}`,
  )
  Promise.all(
    urls.map(
      (u) =>
        new Promise((resolve) => {
          const probe = new Image()
          probe.onload = () => resolve({ w: probe.naturalWidth, h: probe.naturalHeight })
          probe.onerror = () => resolve(null)
          probe.src = u
        }),
    ),
  ).then((dims) => {
    const ok = urls.filter((_, i) => dims[i] && dims[i].w > 0)
    const sizes = dims.filter((d) => d && d.w > 0)
    if (!sizes.length) return
    const scaleOf = (d) => Math.min(1, 260 / d.w)
    const widths = sizes.map((d) => Math.round(d.w * scaleOf(d)))
    const heights = sizes.map((d) => Math.round(d.h * scaleOf(d)))
    const spots = artifactLayout(node, sizes.length, heights)
    beforeChange()
    spots.forEach((spot, i) => {
      const id = 'n' + Date.now() + i + Math.random().toString(36).slice(2, 5)
      objects.value.push({
        id,
        type: 'image',
        x: spot.x,
        y: spot.y,
        width: widths[i],
        height: heights[i],
        src: ok[i],
      })
      links.value.push({ id: 'l' + Date.now() + i, from: node.id, to: id })
    })
    saveSoon()
  })
}

// —— App 节点卡视觉（参考 infinite-canvas canvas-theme dark：stone 色系 + rounded-3xl + 选中近白描边）——
const APP_CARD = {
  fill: '#292524', // node.fill
  stroke: '#44403c', // node.stroke
  activeStroke: '#fafaf9', // node.activeStroke（选中）
  text: '#f5f5f4', // node.text
  muted: '#d6d3d1', // node.muted
  faint: '#78716c', // node.faint
}
function appNodeRectConfig(o) {
  const sel = selection.value.includes(o.id)
  return {
    width: o.width,
    height: o.height,
    fill: APP_CARD.fill,
    stroke: sel ? APP_CARD.activeStroke : APP_CARD.stroke,
    strokeWidth: sel ? 2 : 2,
    cornerRadius: 24, // rounded-3xl
    shadowColor: sel ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.25)',
    shadowBlur: sel ? 48 : 18, // 选中态 0 18px 48px（参考 isRelated 投影）
    shadowOffset: { x: 0, y: sel ? 18 : 6 },
    shadowOpacity: 0.6,
  }
}
function appNodeTitleConfig(o) {
  return {
    text: o.name || o.appId,
    x: 16,
    y: 14,
    width: o.width - 76,
    height: 24,
    fontSize: 14,
    fontStyle: 'bold',
    fill: APP_CARD.text,
    wrap: 'none',
    ellipsis: true,
    listening: false,
  }
}
function appNodeSubConfig(o) {
  const sub =
    o.status === 'running' ? o.statusText || '…' : o.statusText || t('canvasAppNodeSubDefault')
  return {
    text: sub,
    x: 16,
    y: o.height - 30,
    width: o.width - 32,
    height: 20,
    fontSize: 11,
    fill:
      o.status === 'error' ? '#f87171' : o.status === 'success' ? APP_CARD.muted : APP_CARD.faint,
    wrap: 'none',
    ellipsis: true,
    listening: false,
  }
}
function appNodeStatusConfig(o) {
  const running = o.status === 'running'
  return {
    x: o.width - 26,
    y: 24,
    radius: running ? 6 : 5,
    fill:
      o.status === 'success'
        ? APP_CARD.muted
        : o.status === 'running'
          ? APP_CARD.activeStroke
          : o.status === 'error'
            ? '#f87171'
            : APP_CARD.faint,
    stroke: running ? 'rgba(250,250,249,0.35)' : null,
    strokeWidth: running ? 8 : 0,
    listening: false,
  }
}
function appNodeRunBtnConfig(o) {
  return {
    text: o.status === 'running' ? '◉' : '▶',
    x: o.width - 58,
    y: o.height - 36,
    fontSize: 16,
    fill: o.status === 'running' ? APP_CARD.activeStroke : APP_CARD.muted,
    listening: true,
  }
}
function appNodeExpandBtnConfig(o) {
  return {
    text: '⚙',
    x: o.width - 32,
    y: o.height - 36,
    fontSize: 15,
    fill: appPanel.id === o.id ? APP_CARD.activeStroke : APP_CARD.faint,
    listening: true,
  }
}

// —— P3 AI 侧边栏节点指令（wb_canvas_ops → 人审确认卡 → 执行） ——
const pendingAgentOps = ref(null) // Array<op> | null
const agentOpsDiffLines = computed(() =>
  (pendingAgentOps.value || []).map((op) => {
    switch (op.type) {
      case 'run_node': {
        const n = objects.value.find((o) => o.id === op.nodeId)
        return t('canvasAgentOpsRun').replace('{n}', n?.name || op.nodeId)
      }
      case 'add_app_node':
        return t('canvasAgentOpsAdd').replace('{app}', op.name || op.appId)
      case 'update_node':
        return t('canvasAgentOpsUpdate').replace('{id}', op.id)
      case 'connect_nodes':
        return t('canvasAgentOpsConnect').replace('{f}', op.from).replace('{to}', op.to)
      case 'select_nodes':
        return t('canvasAgentOpsSelect').replace('{n}', String((op.ids || []).length))
      default:
        return String(op.type)
    }
  }),
)

function applyCanvasAgentOps(ops) {
  if (!Array.isArray(ops)) return
  beforeChange()
  for (const op of ops) {
    try {
      applyOneAgentOp(op)
    } catch (e) {
      console.warn('[canvas] agent op failed:', op, e)
    }
  }
  saveSoon()
}

function applyOneAgentOp(op) {
  if (op.type === 'run_node') {
    const node = objects.value.find((o) => o.id === op.nodeId)
    if (!node || node.type !== 'app') return
    // params 覆写：{nodeId:{widget:value}} 直写 node.params
    if (op.params && typeof op.params === 'object') {
      node.params = { ...(node.params || {}), ...op.params }
    }
    void runAppNode(node.id)
    return
  }
  if (op.type === 'add_app_node') {
    const wx = typeof op.x === 'number' ? op.x : viewportCenterWorld().x
    const wy = typeof op.y === 'number' ? op.y : viewportCenterWorld().y
    const node = makeAppNode(op.appId, op.name || op.appId, wx, wy)
    if (op.params && typeof op.params === 'object') node.params = { ...op.params }
    objects.value.push(node)
    void ensureAppDetail(op.appId)
    return
  }
  if (op.type === 'update_node') {
    const node = objects.value.find((o) => o.id === op.id)
    if (!node) return
    const patch = op.patch || {}
    if (patch.params && typeof patch.params === 'object')
      node.params = { ...(node.params || {}), ...patch.params }
    if (typeof patch.x === 'number') node.x = patch.x
    if (typeof patch.y === 'number') node.y = patch.y
    if (typeof patch.name === 'string') node.name = patch.name
    return
  }
  if (op.type === 'connect_nodes') {
    const a = objects.value.find((o) => o.id === op.from)
    const b = objects.value.find((o) => o.id === op.to)
    if (!a || !b) return
    const exists = links.value.some(
      (l) => (l.from === op.from && l.to === op.to) || (l.from === op.to && l.to === op.from),
    )
    if (!exists)
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
        from: op.from,
        to: op.to,
      })
    return
  }
  if (op.type === 'select_nodes') {
    const ids = (op.ids || []).filter((id) => objects.value.some((o) => o.id === id))
    if (ids.length) selection.value = ids
    return
  }
}

function confirmAgentOps() {
  const ops = pendingAgentOps.value
  if (!ops?.length) return
  applyCanvasAgentOps(ops)
  pendingAgentOps.value = null
  message.success(t('canvasAgentOpsApplied'))
}

// 侧栏工作台 AI ops → 人审卡（不直接执行）
const offOps = onOps((ops) => {
  if (!Array.isArray(ops) || !ops.length) return
  pendingAgentOps.value = ops
})

// —— 画布 → 侧栏工作台感知条（选区/物件摘要，与 C 宿主 embed 感知条同构）——
let canvasSeq = 0
const canvasDigest = computed(() => {
  const imgs = objects.value.filter((o) => o.type === 'image').length
  const notes = objects.value.filter((o) => o.type === 'note').length
  const apps = appNodesDigest(objects.value)
  return {
    seq: 0, // 实例序号在 emit 时自增（computed 本身无副作用）
    workflowName: t('canvasDigestName'),
    nodeCount: objects.value.length,
    models: [],
    selection: selection.value
      .map((id) => {
        const o = objects.value.find((x) => x.id === id)
        if (!o) return null
        if (o.type === 'app') return `app:${o.name || o.appId}(${o.status || 'idle'})`
        return o.type === 'image' ? `image ${o.width}×${o.height}` : 'note'
      })
      .filter(Boolean),
    counts: {
      images: imgs,
      notes,
      apps: apps.length,
      links: links.value.length,
      groups: groups.value.length,
    },
    appNodes: apps, // P3：AI 感知画布上的 app 节点（id/名称/状态/参数摘要）
    queue: { running: apps.filter((a) => a.status === 'running').length, pending: 0 },
    ts: Date.now(),
  }
})
watch(
  () => [
    selection.value.slice(),
    objects.value.length,
    links.value.length,
    groups.value.length,
    JSON.stringify(appNodesDigest(objects.value)),
  ],
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
    localStorage.setItem(
      STORAGE_KEY,
      serializeDoc(objects.value, viewport.value, 'Untitled', links.value, groups.value),
    )
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
  history.value = createHistory(60) // 载入即新基线
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
      syncDraggables()
    } else if (!inEditor) selection.value = []
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'g' || e.key === 'G')) {
    if (inEditor) return
    e.preventDefault()
    if (e.shiftKey) ungroupSelection()
    else groupSelected()
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'z' || e.key === 'Z')) {
    if (inEditor) return
    e.preventDefault()
    if (e.shiftKey) redoLast()
    else undoLast()
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'y' || e.key === 'Y')) {
    if (inEditor) return
    e.preventDefault()
    redoLast()
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
    if (inEditor) return
    copySelection()
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
    if (inEditor) return
    pasteClipboard()
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
  const files = items
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter(Boolean)
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
        links.value.push({
          id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
          from: srcId,
          to: id,
        })
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
    // App 节点双击 = 展开参数面板
    g.on('dblclick.wb', (e) => {
      const o = objects.value.find((x) => x.id === g.id())
      if (o?.type === 'app') {
        e.evt?.preventDefault?.()
        openAppNodePanel(o.id)
      }
    })
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
  // app 节点轮询清场
  for (const nodeId of [...nodePolls.keys()]) stopNodePoll(nodeId)
  // AI ops 订阅清场
  offOps?.()
})
</script>

<style scoped>
.agent-ops-card {
  position: absolute;
  z-index: 35;
  top: 52px;
  left: 50%;
  transform: translateX(-50%);
  width: 360px;
  padding: 10px;
  border-radius: 12px;
  border: 1px solid var(--wb-accent);
  background: var(--wb-surface);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
}
.ops-lines {
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow-y: auto;
}
.ops-line {
  font-size: 11px;
  color: var(--wb-text-2);
  padding: 2px 6px;
  border-radius: 6px;
  background: rgba(0, 0, 0, 0.2);
}
</style>
