<template>
  <div class="page-container bg-tech-dark flex flex-col h-screen overflow-hidden">
    <!-- 首导航用默认「应用中心」（/）；应用市场入口只在应用中心页自显示 -->
    <AppHeader class="shrink-0" />
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
        class="relative flex-1 min-w-0 overflow-hidden rounded-xl border border-[var(--wb-stroke)] select-none"
        :class="dragOver ? 'ring-2 ring-[var(--wb-accent)]' : ''"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
        @contextmenu.prevent="onWrapContext"
        @mouseleave="scheduleHoverHide(0)"
      >
        <!-- 网格背景（随视口平移/缩放，纯 CSS） -->
        <div class="absolute inset-0 pointer-events-none" :style="gridStyle"></div>
        <!-- 图层面板（P1：画布右侧，参考 side-panel Canvas tab；宽 232px 可浮层收起） -->
        <div
          v-if="layersOpen"
          class="absolute right-3 top-3 z-20 w-[232px] max-h-[calc(100%-24px)] rounded-xl border border-[var(--wb-stroke)] shadow-xl overflow-hidden"
        >
          <CanvasSidePanel
            :objects="objects"
            :selection="selection"
            :groups="groups"
            :hover-node-id="hoverNodeId"
            @focus="focusObject"
            @hover="(id) => (hoverFromPanel = id)"
            @close="layersOpen = false"
          />
        </div>
        <!-- 素材库面板（P2）：左下浮动，点击/拖入画布 -->
        <div
          v-if="assetsOpen"
          class="absolute bottom-3 left-3 z-20 w-[232px] max-h-[calc(100%-24px)] rounded-xl border border-[var(--wb-stroke)] shadow-xl overflow-hidden"
        >
          <CanvasAssetsPanel
            ref="assetsPanelEl"
            :assets="assets"
            @insert="(a) => insertAsset(a, centerWorld().x, centerWorld().y)"
            @added="assetAdded"
            @remove="assetRemoved"
            @close="assetsOpen = false"
          />
        </div>
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
                  opacity: reconnectDrag.active && reconnectDrag.linkId === seg.id ? 0.25 : 1,
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
            <!-- 重连预览（选中连线拖锚点时：原线淡显 + 动端虚线跟随） -->
            <v-path
              v-if="reconnectDrag.seg"
              :config="{
                data: bezierLinkPath(
                  reconnectDrag.seg.x1,
                  reconnectDrag.seg.y1,
                  reconnectDrag.seg.x2,
                  reconnectDrag.seg.y2,
                ),
                stroke: '#fafaf9',
                strokeWidth: 2.5 / viewport.scale,
                dash: [5 / viewport.scale, 5 / viewport.scale],
                listening: false,
              }"
            />
          </v-layer>
          <v-layer>
            <!-- 对齐参考线 -->
            <v-line v-for="(g, i) in guides.v" :key="'gv' + i" :config="guideConfig(g, 'v')" />
            <v-line v-for="(g, i) in guides.h" :key="'gh' + i" :config="guideConfig(g, 'h')" />
            <!-- Frame 分区（背景容器：可点选/拖拽/重命名/删除；成员物件自由进出） -->
            <v-group
              v-for="o in frameObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="true"
              :listening="true"
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
            <!-- 媒体物件（video/audio）：Konva 占位框（拖拽/选中/连线热区），播放器是 HTML overlay -->
            <v-group
              v-for="o in mediaObjects"
              :key="o.id"
              :config="groupConfig(o)"
              :draggable="true"
            >
              <v-rect :config="mediaRectConfig(o)" />
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
            <v-group
              v-for="o in culledObjects"
              :key="'hd' + o.id"
              :config="{ x: o.x, y: o.y, visible: lodHandlesVisible }"
            >
              <v-circle
                :config="handleConfig(o, 'target')"
                @mousedown="onConnectStart(o.id, 'target', $event)"
              />
              <v-circle
                :config="handleConfig(o, 'source')"
                @mousedown="onConnectStart(o.id, 'source', $event)"
              />
            </v-group>
            <!-- 选中连线的重连锚点：两端圆点拖到其它物件即改接。
                 常驻渲染 + hitFunc 动态热区（同句柄模式，避免 v-if 破坏 hit graph） -->
            <v-group v-for="seg in linkSegs" :key="'la' + seg.id">
              <v-circle
                :config="linkAnchorConfig(seg, 'from')"
                @mousedown="onAnchorDown(seg.id, 'from', $event)"
              />
              <v-circle
                :config="linkAnchorConfig(seg, 'to')"
                @mousedown="onAnchorDown(seg.id, 'to', $event)"
              />
            </v-group>
            <!-- 选中对象四角缩放手柄（拖角实时改尺寸写回数据；同句柄常驻渲染 +
                 hitFunc 动态热区，避免 v-if 破坏 hit graph） -->
            <v-group v-for="o in resizeTargets" :key="'rz' + o.id" :config="{ x: o.x, y: o.y }">
              <v-circle
                :config="resizeAnchorConfig(o, 'nw')"
                @mousedown="onResizeStart(o.id, 'nw', $event)"
              />
              <v-circle
                :config="resizeAnchorConfig(o, 'ne')"
                @mousedown="onResizeStart(o.id, 'ne', $event)"
              />
              <v-circle
                :config="resizeAnchorConfig(o, 'sw')"
                @mousedown="onResizeStart(o.id, 'sw', $event)"
              />
              <v-circle
                :config="resizeAnchorConfig(o, 'se')"
                @mousedown="onResizeStart(o.id, 'se', $event)"
              />
            </v-group>
            <!-- 框选橡皮筋（fix: 此前绑定函数引用而非调用，config 里 width 等
                 全是 undefined → rect 宽高 0，橡皮筋拖拽全程不可见） -->
            <v-rect v-if="rubber" :config="rubberConfig()" />
            <!-- 圈选裁剪橡皮筋（同上） -->
            <v-rect v-if="cropRect" :config="cropRectConfig()" />
          </v-layer>
        </v-stage>

        <!-- 项目栏（左上：标题编辑 + 画布列表下拉，参考 canvas-top-bar） -->
        <div
          data-project-bar
          class="absolute top-3 left-3 z-10 flex items-center gap-1.5"
          @mousedown.stop
        >
          <button
            class="w-9 h-9 rounded-lg bg-[var(--wb-surface)] border border-[var(--wb-stroke)] text-[var(--wb-text-1)] hover:border-[var(--wb-accent)] transition flex items-center justify-center"
            :title="t('canvasProjectsMenu')"
            @click="projectMenuOpen = !projectMenuOpen"
          >
            <i class="fas fa-layer-group"></i>
          </button>
          <div
            v-if="activeProject"
            class="h-9 px-3 rounded-lg bg-[var(--wb-surface)] border border-[var(--wb-stroke)] flex items-center min-w-0 max-w-[260px]"
            @dblclick="startProjectTitleEdit"
            :title="t('canvasProjectRenameHint')"
          >
            <input
              v-if="projectTitleEditing"
              ref="projectTitleInput"
              v-model="projectTitleDraft"
              class="bg-transparent outline-none text-sm text-[var(--wb-text-1)] w-[180px]"
              @blur="finishProjectTitleEdit"
              @keydown.enter.prevent="finishProjectTitleEdit"
              @keydown.esc.prevent="projectTitleEditing = false"
            />
            <span v-else class="text-sm font-medium text-[var(--wb-text-1)] truncate">{{
              activeProject.title
            }}</span>
          </div>
          <!-- E4 画布列表下拉：卡片网格（统计/hover 操作/内联重命名/批量删除） -->
          <div
            v-if="projectMenuOpen"
            class="absolute top-12 left-0 w-[420px] rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl overflow-hidden z-20"
            @mousedown.stop
          >
            <div
              class="flex items-center justify-between px-3 py-2 border-b border-[var(--wb-stroke)]"
            >
              <span class="text-xs font-medium text-[var(--wb-text-2)]">{{
                t('canvasPrjCards') + ' · ' + projectStore.projects.length
              }}</span>
              <div class="flex items-center gap-1">
                <button
                  v-if="!prjBatchMode"
                  class="rounded px-2 py-1 text-[11px] text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)]"
                  @click="prjBatchMode = true"
                >
                  <i class="fas fa-list-check mr-1"></i>{{ t('canvasPrjBatchMode') }}
                </button>
                <template v-else>
                  <button
                    class="rounded px-2 py-1 text-[11px] text-red-400 hover:bg-red-400/10 disabled:opacity-40"
                    :disabled="!prjChecked.size"
                    @click="deleteCheckedProjects"
                  >
                    <i class="fas fa-trash mr-1"></i>{{ t('canvasPrjBatchDel') }}（{{
                      prjChecked.size
                    }}）
                  </button>
                  <button
                    class="rounded px-2 py-1 text-[11px] text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)]"
                    @click="exitPrjBatch"
                  >
                    {{ t('canvasPrjCancel') }}
                  </button>
                </template>
              </div>
            </div>
            <div class="max-h-[360px] overflow-y-auto p-2 grid grid-cols-2 gap-2">
              <div
                v-for="pr in projectStore.projects"
                :key="pr.id"
                tabindex="0"
                class="group relative rounded-lg border p-2 transition cursor-pointer focus:outline-none focus:border-[var(--wb-accent)]"
                :class="
                  pr.id === projectStore.activeId
                    ? 'border-[var(--wb-accent)] bg-[var(--wb-accent)]/10'
                    : 'border-[var(--wb-stroke)] hover:border-[var(--wb-accent)]/60'
                "
                @click="prjBatchMode ? togglePrjCheck(pr.id) : openProjectById(pr.id)"
              >
                <div v-if="prjBatchMode" class="absolute left-1.5 top-1.5 z-10">
                  <input
                    type="checkbox"
                    class="size-3.5 accent-[var(--wb-accent)]"
                    :checked="prjChecked.has(pr.id)"
                    @click.stop="togglePrjCheck(pr.id)"
                  />
                </div>
                <div class="flex items-center gap-1 min-w-0" :class="prjBatchMode ? 'pl-5' : ''">
                  <i
                    class="fas fa-layer-group text-[10px] shrink-0"
                    :class="
                      pr.id === projectStore.activeId
                        ? 'text-[var(--wb-accent)]'
                        : 'text-[var(--wb-text-3)]'
                    "
                  ></i>
                  <input
                    v-if="prjRenameId === pr.id"
                    ref="prjRenameInput"
                    :value="pr.title"
                    class="bg-transparent outline-none text-xs font-medium text-[var(--wb-text-1)] w-full min-w-0 border-b border-[var(--wb-accent)]"
                    @click.stop
                    @mousedown.stop
                    @blur="commitPrjRename"
                    @keydown.enter.prevent="commitPrjRename"
                    @keydown.esc.stop.prevent="prjRenameId = null"
                  />
                  <span v-else class="truncate text-xs font-medium text-[var(--wb-text-1)]">{{
                    pr.title
                  }}</span>
                </div>
                <div
                  class="mt-1.5 flex items-center gap-2 text-[10px] text-[var(--wb-text-3)]"
                  :class="prjBatchMode ? 'pl-5' : ''"
                >
                  <span
                    ><i class="fas fa-shapes mr-0.5"></i
                    >{{ t('canvasPrjObjects').replace('{n}', String(prjStats(pr).objects)) }}</span
                  >
                  <span
                    ><i class="fas fa-link mr-0.5"></i
                    >{{ t('canvasPrjLinks').replace('{n}', String(prjStats(pr).links)) }}</span
                  >
                </div>
                <div
                  class="mt-0.5 text-[10px] text-[var(--wb-text-3)]"
                  :class="prjBatchMode ? 'pl-5' : ''"
                >
                  {{ prjRelTime(pr) }}
                </div>
                <div
                  v-if="!prjBatchMode"
                  class="absolute right-1 top-1 gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100"
                >
                  <button
                    class="grid size-5 place-items-center rounded text-[9px] text-[var(--wb-text-2)] hover:bg-[var(--wb-accent)]/20 hover:text-[var(--wb-accent)]"
                    :title="t('canvasPrjRename')"
                    @click.stop="startPrjRename(pr.id)"
                  >
                    <i class="fas fa-pen"></i>
                  </button>
                  <button
                    class="grid size-5 place-items-center rounded text-[9px] text-[var(--wb-text-2)] hover:bg-[var(--wb-accent)]/20 hover:text-[var(--wb-accent)]"
                    :title="t('canvasPrjExport')"
                    @click.stop="exportProjectById(pr.id)"
                  >
                    <i class="fas fa-file-export"></i>
                  </button>
                  <button
                    class="grid size-5 place-items-center rounded text-[9px] text-[var(--wb-text-2)] hover:bg-red-400/20 hover:text-red-400"
                    :title="t('canvasProjectDelete')"
                    @click.stop="deleteProjectById(pr.id)"
                  >
                    <i class="fas fa-trash"></i>
                  </button>
                </div>
              </div>
            </div>
            <div class="border-t border-[var(--wb-stroke)]">
              <button
                class="w-full text-left px-3 py-2 text-sm text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
                @click="createNewProject"
              >
                <i class="fas fa-plus w-4"></i>{{ t('canvasProjectNew') }}
              </button>
            </div>
          </div>
        </div>

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

        <!-- C：拖线落空 → 创建节点菜单（参考 ConnectionCreateMenu） -->
        <div
          v-if="connectCreate.open"
          id="connect-create-menu"
          class="absolute z-30 min-w-[170px] py-1 rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl text-xs"
          :style="{ left: connectCreate.x + 'px', top: connectCreate.y + 'px' }"
          @contextmenu.prevent
          @mousedown.stop
        >
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('canvasCreateMenuTitle') }}
          </div>
          <button
            v-for="opt in [
              { k: 'note', icon: 'fa-note-sticky', label: t('canvasCreateMenuNote') },
              { k: 'image', icon: 'fa-image', label: t('canvasCreateMenuImage') },
              { k: 'video', icon: 'fa-film', label: t('canvasCreateMenuVideo') },
              { k: 'audio', icon: 'fa-volume-high', label: t('canvasCreateMenuAudio') },
              { k: 'app', icon: 'fa-cube', label: t('canvasCreateMenuApp') },
            ]"
            :key="opt.k"
            class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
            @click="createNodeFromConnect(opt.k)"
          >
            <i class="fas w-4 text-center text-slate-400" :class="opt.icon"></i>{{ opt.label }}
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
            <template v-for="m in ctxItems" :key="m.key">
              <div v-if="m.sep" class="my-1 h-px bg-slate-600/60"></div>
              <div v-else-if="m.children" class="group/ctx relative">
                <button
                  class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
                >
                  <i class="fas w-4 text-center text-slate-400" :class="m.icon"></i>{{ m.label }}
                  <i class="fas fa-chevron-right ml-auto text-[9px] text-slate-500"></i>
                </button>
                <div
                  class="absolute left-full top-0 -ml-1 hidden min-w-[170px] rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface)] py-1 shadow-xl group-hover/ctx:block"
                >
                  <button
                    v-for="c in m.children"
                    :key="c.key"
                    class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2 whitespace-nowrap"
                    @click="c.run()"
                  >
                    <i class="fas w-4 text-center text-slate-400" :class="c.icon"></i>{{ c.label }}
                  </button>
                </div>
              </div>
              <button
                v-else
                class="w-full text-left px-3 py-1.5 hover:bg-[var(--wb-accent)]/15 flex items-center gap-2"
                @click="m.run()"
              >
                <i class="fas w-4 text-center text-slate-400" :class="m.icon"></i>{{ m.label }}
              </button>
            </template>
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
        <!-- 提示词库面板（S6b）：内置分词 + 自定义 + JSON 导入 -->
        <div
          v-if="promptLib.open"
          class="absolute z-30 left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[560px] max-h-[70vh] flex flex-col rounded-2xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-2xl"
          @mousedown.stop
          @pointerdown.stop
        >
          <div class="flex items-center gap-2 px-4 pt-3 pb-2">
            <i class="fas fa-book-open text-[var(--wb-accent)]"></i>
            <span class="text-sm font-medium text-[var(--wb-text-1)]">{{
              t('canvasPromptLibTitle')
            }}</span>
            <span
              v-if="promptTarget"
              class="text-xs px-2 py-0.5 rounded-full bg-[var(--wb-accent)]/15 text-[var(--wb-accent)]"
            >
              {{
                promptTarget.kind === 'rewrite'
                  ? t('canvasPromptTargetRewrite')
                  : promptTarget.kind === 'gen'
                    ? t('canvasPromptTargetGen')
                    : t('canvasPromptTargetNote')
              }}
            </span>
            <span
              v-else
              class="text-xs px-2 py-0.5 rounded-full bg-[var(--wb-stroke)] text-[var(--wb-text-2)]"
              :title="t('canvasPromptNoTargetHint')"
            >
              {{ t('canvasPromptNoTargetHint') }}
            </span>
            <div class="flex-1"></div>
            <button
              class="w-7 h-7 rounded-lg text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] transition"
              @click="promptLib.open = false"
            >
              <i class="fas fa-xmark"></i>
            </button>
          </div>
          <div class="flex items-center gap-2 px-4 pb-2">
            <button
              v-for="tb in ['builtin', 'custom']"
              :key="tb"
              class="h-7 px-3 rounded-lg text-xs transition"
              :class="
                promptLib.tab === tb
                  ? 'text-white bg-[var(--wb-accent)]'
                  : 'text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] border border-[var(--wb-stroke)]'
              "
              @click="promptLib.tab = tb"
            >
              {{ tb === 'builtin' ? t('canvasPromptBuiltinTab') : t('canvasPromptCustomTab') }}
            </button>
            <div class="flex-1"></div>
            <input
              v-model="promptLib.q"
              class="w-44 bg-transparent outline-none text-sm text-[var(--wb-text-1)] border border-[var(--wb-stroke)] rounded-lg px-2 py-1"
              :placeholder="t('canvasPromptSearch')"
            />
            <button
              v-if="promptLib.tab === 'custom'"
              class="h-7 px-2.5 rounded-lg text-xs text-[var(--wb-accent)] border border-[var(--wb-accent)]/40 hover:bg-[var(--wb-accent)]/10 transition"
              @click="importPromptsFile"
            >
              <i class="fas fa-file-import mr-1"></i>{{ t('canvasPromptImport') }}
            </button>
          </div>
          <div class="flex-1 overflow-y-auto px-4 pb-4 space-y-3">
            <div v-for="cat in promptLibView" :key="cat.category">
              <div
                class="text-xs text-[var(--wb-text-2)] mb-1.5 sticky top-0 bg-[var(--wb-surface)] py-1"
              >
                {{ cat.category }}
              </div>
              <div class="flex flex-wrap gap-1.5">
                <button
                  v-for="it in cat.items"
                  :key="it.text"
                  class="group max-w-full flex items-center gap-1.5 h-8 px-2.5 rounded-lg border border-[var(--wb-stroke)] hover:border-[var(--wb-accent)] text-xs text-[var(--wb-text-1)] transition"
                  :title="it.hint || it.text"
                  @click="applyPrompt(it.text)"
                >
                  <span class="truncate max-w-[280px]">{{ it.text }}</span>
                  <i
                    v-if="promptLib.tab === 'custom'"
                    class="fas fa-xmark opacity-0 group-hover:opacity-60 hover:!opacity-100 text-[var(--wb-text-2)]"
                    @click.stop="removeCustomPrompt(it.text)"
                  ></i>
                </button>
              </div>
            </div>
            <div
              v-if="promptLib.tab === 'custom' && !customPrompts.length"
              class="text-xs text-[var(--wb-text-2)] py-6 text-center"
            >
              {{ t('canvasPromptEmptyHint') }}
            </div>
          </div>
        </div>

        <!-- 角度/翻转对话框（A2）：滑杆 + 翻转开关 -->
        <div
          v-if="angleDlg.open"
          class="absolute z-30 flex flex-col gap-3 w-[300px] p-4 rounded-2xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-2xl"
          :style="{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <div class="text-sm font-medium text-[var(--wb-text-1)]">{{ t('canvasAngleTitle') }}</div>
          <div class="flex items-center gap-2">
            <input
              :value="angleDlg.deg"
              type="range"
              min="-45"
              max="45"
              step="1"
              class="flex-1"
              @input="angleDlg.deg = Number($event.target.value)"
            />
            <span class="w-12 text-right text-xs text-[var(--wb-text-2)]">{{ angleDlg.deg }}°</span>
          </div>
          <div class="flex gap-2">
            <button
              v-for="fl in [
                { k: 'flipH', label: t('canvasAngleFlipH') },
                { k: 'flipV', label: t('canvasAngleFlipV') },
              ]"
              :key="fl.k"
              class="flex-1 h-8 rounded-lg text-xs border transition"
              :class="
                angleDlg[fl.k]
                  ? 'text-white bg-[var(--wb-accent)] border-transparent'
                  : 'text-[var(--wb-text-2)] border-[var(--wb-stroke)] hover:text-[var(--wb-text-1)]'
              "
              @click="angleDlg[fl.k] = !angleDlg[fl.k]"
            >
              {{ fl.label }}
            </button>
          </div>
          <div class="flex gap-2 justify-end">
            <button
              class="h-8 px-3 rounded-lg text-xs text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] border border-[var(--wb-stroke)] transition"
              @click="angleDlg.open = false"
            >
              {{ t('canvasDlgCancel') }}
            </button>
            <button
              class="h-8 px-3 rounded-lg text-xs text-white bg-[var(--wb-accent)] transition"
              @click="applyAngle"
            >
              {{ t('canvasAngleApply') }}
            </button>
          </div>
        </div>

        <!-- 放大对话框（A3）：目标长边 + 算法 -->
        <div
          v-if="upscaleDlg.open"
          class="absolute z-30 flex flex-col gap-3 w-[300px] p-4 rounded-2xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-2xl"
          :style="{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <div class="text-sm font-medium text-[var(--wb-text-1)]">
            {{ t('canvasUpscaleTitle') }}
          </div>
          <div class="flex gap-1.5">
            <button
              v-for="tp in [1024, 2048, 4096]"
              :key="tp"
              class="flex-1 h-8 rounded-lg text-xs border transition"
              :class="
                upscaleDlg.target === tp
                  ? 'text-white bg-[var(--wb-accent)] border-transparent'
                  : 'text-[var(--wb-text-2)] border-[var(--wb-stroke)] hover:text-[var(--wb-text-1)]'
              "
              @click="upscaleDlg.target = tp"
            >
              {{ tp }}px
            </button>
          </div>
          <div class="flex gap-2 justify-end">
            <button
              class="h-8 px-3 rounded-lg text-xs text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] border border-[var(--wb-stroke)] transition"
              @click="upscaleDlg.open = false"
            >
              {{ t('canvasDlgCancel') }}
            </button>
            <button
              class="h-8 px-3 rounded-lg text-xs text-white bg-[var(--wb-accent)] transition"
              @click="applyUpscale"
            >
              {{ t('canvasUpscaleApply') }}
            </button>
          </div>
        </div>

        <!-- D1a 蒙版编辑对话框：笔刷涂抹局部重绘区（对齐参考 mask-edit-dialog） -->
        <div
          v-if="maskDlg.open"
          class="fixed inset-0 z-[80] flex items-center justify-center bg-black/60"
          @mousedown.self="maskDlg.open = false"
        >
          <div
            class="flex max-h-[92vh] w-[min(1080px,94vw)] gap-5 rounded-2xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] p-5 shadow-2xl"
            @keydown="onMaskKeydown"
            @keyup="onMaskKeyup"
          >
            <!-- 左：图 + 蒙版叠加（E1 视口：滚轮缩放/空格中键平移/适配） -->
            <div class="relative flex-1">
              <div
                ref="maskViewportEl"
                class="relative h-full overflow-auto rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-bg)]"
                :class="maskDlg.panning ? 'cursor-grabbing' : ''"
                @wheel.prevent="onMaskWheel"
                @pointerdown.capture="onMaskPanDown"
                @pointermove.capture="onMaskPanMove"
                @pointerup.capture="onMaskPanUp"
                @pointercancel.capture="onMaskPanUp"
                @auxclick.prevent
              >
                <div
                  class="relative flex min-h-full min-w-full items-center justify-center p-6"
                  style="transform: translateZ(0)"
                >
                  <div
                    class="relative"
                    :style="{ width: maskStageSize.w + 'px', height: maskStageSize.h + 'px' }"
                  >
                    <img
                      :src="(objects.find((o) => o.id === maskDlg.id) || {}).src"
                      class="absolute inset-0 h-full w-full object-contain"
                      draggable="false"
                    />
                    <canvas ref="maskCanvasEl" class="hidden"></canvas>
                    <canvas
                      ref="maskPreviewEl"
                      class="absolute inset-0 h-full w-full cursor-none touch-none"
                      @pointerdown.prevent="onMaskPointerDown"
                      @pointermove.prevent="onMaskPointerMove"
                      @pointerup="onMaskPointerUp"
                      @pointercancel="onMaskPointerUp"
                      @pointerleave="maskDlg.cursor = null"
                      @contextmenu.prevent
                    ></canvas>
                    <!-- 笔刷预览圆 -->
                    <div
                      v-if="maskDlg.cursor && !maskDlg.brushAdjust"
                      class="pointer-events-none absolute rounded-full border-2 border-white/90 shadow-[0_0_0_1px_rgba(0,0,0,.8)]"
                      :style="{
                        left: maskDlg.cursor.x + 'px',
                        top: maskDlg.cursor.y + 'px',
                        width: maskDlg.brush * maskImageScale + 'px',
                        aspectRatio: '1',
                        transform: 'translate(-50%, -50%)',
                      }"
                    ></div>
                    <div
                      v-if="maskDlg.cursor && maskDlg.brushAdjust"
                      class="pointer-events-none absolute rounded-full border-2 border-amber-400 bg-black/10 shadow-[0_0_0_1px_rgba(0,0,0,.8)]"
                      :style="{
                        left: maskDlg.cursor.x + 'px',
                        top: maskDlg.cursor.y + 'px',
                        width: maskDlg.brush * maskImageScale + 'px',
                        aspectRatio: '1',
                        transform: 'translate(-50%, -50%)',
                      }"
                    >
                      <span
                        class="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded bg-black/75 px-1.5 py-0.5 text-xs font-semibold text-white"
                        >{{ maskDlg.brush }}px</span
                      >
                    </div>
                  </div>
                </div>
              </div>
            </div>
            <!-- 右：工具面板 -->
            <div class="flex w-[300px] flex-col gap-4">
              <div>
                <div class="text-lg font-semibold text-[var(--wb-text-1)]">
                  {{ t('canvasMaskTitle') }}
                </div>
                <div class="mt-1 text-xs text-[var(--wb-text-2)]">
                  {{ maskDlg.imgW }} × {{ maskDlg.imgH }}px · {{ t('canvasMaskHint') }}
                </div>
                <!-- E1 视口缩放控件：缩小/放大/适配/百分比（滚轮+空格平移提示） -->
                <div class="mt-2 flex items-center gap-1">
                  <button
                    class="h-7 w-7 rounded-lg border border-[var(--wb-stroke)] text-xs text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] disabled:opacity-30"
                    :disabled="maskDlg.view <= 1.001"
                    @click="maskZoom(-1)"
                  >
                    <i class="fas fa-magnifying-glass-minus"></i>
                  </button>
                  <button
                    class="h-7 w-7 rounded-lg border border-[var(--wb-stroke)] text-xs text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] disabled:opacity-30"
                    :disabled="maskDlg.view >= 3.999"
                    @click="maskZoom(1)"
                  >
                    <i class="fas fa-magnifying-glass-plus"></i>
                  </button>
                  <button
                    class="h-7 rounded-lg border border-[var(--wb-stroke)] px-2 text-xs text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)]"
                    @click="maskFitViewport"
                  >
                    <i class="fas fa-expand mr-1"></i>{{ t('canvasMaskFit') }}
                  </button>
                  <span class="ml-1 text-xs font-medium text-[var(--wb-text-2)]">{{
                    Math.round(maskDlg.view * maskDlg.fitScale * 100) + '%'
                  }}</span>
                </div>
                <div class="mt-1 text-[11px] leading-relaxed text-[var(--wb-text-3)]">
                  {{ t('canvasMaskViewportHint') }}
                </div>
              </div>
              <div class="grid grid-cols-2 gap-2">
                <button
                  class="rounded-lg border px-3 py-1.5 text-xs"
                  :class="
                    maskDlg.mode === 'paint'
                      ? 'border-[var(--wb-accent)] bg-[var(--wb-accent)]/15 text-[var(--wb-text-1)]'
                      : 'border-[var(--wb-stroke)] text-[var(--wb-text-2)]'
                  "
                  @click="maskDlg.mode = 'paint'"
                >
                  <i class="fas fa-brush mr-1"></i>{{ t('canvasMaskBrush') }}
                </button>
                <button
                  class="rounded-lg border px-3 py-1.5 text-xs"
                  :class="
                    maskDlg.mode === 'erase'
                      ? 'border-[var(--wb-accent)] bg-[var(--wb-accent)]/15 text-[var(--wb-text-1)]'
                      : 'border-[var(--wb-stroke)] text-[var(--wb-text-2)]'
                  "
                  @click="maskDlg.mode = 'erase'"
                >
                  <i class="fas fa-eraser mr-1"></i>{{ t('canvasMaskErase') }}
                </button>
              </div>
              <div
                class="flex items-center justify-between rounded-lg border border-[var(--wb-stroke)] px-2 py-1 text-xs"
              >
                <button
                  class="rounded px-2 py-1 text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] disabled:opacity-30"
                  :disabled="!maskDlg.strokes.length"
                  @click="undoMaskStroke"
                >
                  <i class="fas fa-rotate-left"></i>
                </button>
                <button
                  class="rounded px-2 py-1 text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] disabled:opacity-30"
                  :disabled="!maskDlg.redoStack.length"
                  @click="redoMaskStroke"
                >
                  <i class="fas fa-rotate-right"></i>
                </button>
                <span class="text-[var(--wb-text-2)]">{{ t('canvasMaskBrushSize') }}</span>
                <span class="font-semibold text-[var(--wb-text-1)]">{{ maskDlg.brush }}px</span>
              </div>
              <input
                :value="maskDlg.brush"
                type="range"
                min="8"
                max="160"
                step="2"
                class="w-full"
                @input="maskDlg.brush = clampBrushSize(Number($event.target.value))"
              />
              <div class="flex flex-col gap-1">
                <span class="text-xs font-medium text-[var(--wb-text-2)]">{{
                  t('canvasMaskPromptLabel')
                }}</span>
                <textarea
                  v-model="maskDlg.prompt"
                  rows="5"
                  class="w-full resize-none rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-bg)] px-2 py-1.5 text-xs text-[var(--wb-text-1)]"
                  :placeholder="t('canvasMaskPromptPlaceholder')"
                ></textarea>
              </div>
              <div v-if="maskDlg.error" class="text-xs font-medium text-red-500">
                {{ maskDlg.error }}
              </div>
              <div class="mt-auto flex items-center justify-between gap-2">
                <button
                  class="rounded-lg border border-[var(--wb-stroke)] px-3 py-1.5 text-xs text-[var(--wb-text-2)]"
                  @click="resetMaskDialog"
                >
                  <i class="fas fa-arrows-rotate mr-1"></i>{{ t('canvasMaskReset') }}
                </button>
                <div class="flex gap-2">
                  <button
                    class="rounded-lg border border-[var(--wb-stroke)] px-3 py-1.5 text-xs text-[var(--wb-text-2)]"
                    @click="maskDlg.open = false"
                  >
                    {{ t('canvasDlgCancel') }}
                  </button>
                  <button
                    class="rounded-lg bg-[var(--wb-accent)] px-3 py-1.5 text-xs font-medium text-white"
                    @click="submitMaskDialog"
                  >
                    <i class="fas fa-wand-magic-sparkles mr-1"></i>{{ t('canvasMaskSubmit') }}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        <!-- 切分对话框（S6a）：横/竖切 N 片 -->
        <div
          v-if="splitDlg.open"
          class="absolute z-30 flex items-center gap-2 h-11 px-3 rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl"
          :style="{ left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <span class="text-sm text-[var(--wb-text-1)]">{{ t('canvasSplitDlgTitle') }}</span>
          <select
            v-model="splitDlg.dir"
            class="bg-[var(--wb-bg-base)] text-sm text-[var(--wb-text-1)] rounded-lg px-2 py-1 border border-[var(--wb-stroke)]"
          >
            <option value="h">{{ t('canvasSplitDirH') }}</option>
            <option value="v">{{ t('canvasSplitDirV') }}</option>
          </select>
          <input
            :value="splitDlg.n"
            type="number"
            min="2"
            max="6"
            class="w-16 bg-transparent outline-none text-sm text-[var(--wb-text-1)] border border-[var(--wb-stroke)] rounded-lg px-2 py-1"
            @input="splitDlg.n = Math.min(6, Math.max(2, Number($event.target.value) || 2))"
          />
          <button
            class="h-7 px-3 rounded-lg text-xs text-white bg-[var(--wb-accent)] transition"
            @click="applySplit"
          >
            {{ t('canvasSplitGo') }}
          </button>
          <button
            class="w-7 h-7 rounded-lg text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] transition"
            @click="splitDlg.open = false"
          >
            <i class="fas fa-xmark"></i>
          </button>
        </div>

        <!-- note AI 改写输入条（S5b）：note 下方，指令 + 发送 -->
        <div
          v-if="noteRewrite.noteId"
          class="absolute z-20 w-[360px] rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl p-2.5 flex items-center gap-2"
          :style="{ left: noteRewritePos.x + 'px', top: noteRewritePos.y + 'px' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <input
            ref="noteRewriteInput"
            v-model="noteRewrite.instruction"
            class="flex-1 bg-transparent outline-none text-sm text-[var(--wb-text-1)] placeholder:text-[var(--wb-text-2)]"
            :placeholder="t('canvasRewritePlaceholder')"
            :disabled="noteRewrite.running"
            @keydown.enter.prevent="runNoteRewrite"
            @keydown.esc.prevent="noteRewrite.noteId = null"
          />
          <button
            class="h-7 px-2.5 rounded-lg text-xs text-white bg-[var(--wb-accent)] disabled:opacity-50 transition"
            :disabled="noteRewrite.running || !noteRewrite.instruction.trim()"
            @click="runNoteRewrite"
          >
            <i v-if="noteRewrite.running" class="fas fa-spinner fa-spin mr-1"></i
            >{{ noteRewrite.running ? t('canvasRewriteRunning') : t('canvasRewriteSend') }}
          </button>
          <button
            class="w-7 h-7 rounded-lg text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)] transition"
            @click="noteRewrite.noteId = null"
          >
            <i class="fas fa-xmark"></i>
          </button>
        </div>

        <!-- 媒体节点播放器 overlay（S4b）：跟随视口变换定位 -->
        <template v-for="o in mediaObjects" :key="'media-' + o.id">
          <div
            class="absolute z-[15]"
            :data-media-overlay="o.id"
            :style="{
              left: mediaPosOf(o).x + 'px',
              top: mediaPosOf(o).y + 'px',
              width: mediaPosOf(o).w + 'px',
              height: mediaPosOf(o).h + 'px',
            }"
          >
            <MediaNodeCard :node="o" :pos="mediaPosOf(o)" @upload="uploadMediaFor" />
          </div>
        </template>

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

        <!-- 软件渲染降级提示（Win11 GPU黑名单机）：一次性告知 -->
        <div
          v-if="softRenderTip"
          class="absolute z-20 left-1/2 top-3 -translate-x-1/2 flex items-center gap-2 px-3 py-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 text-xs text-amber-300"
        >
          <i class="fas fa-triangle-exclamation"></i>{{ t('canvasSoftRenderTip') }}
          <button class="ml-1 text-amber-300/70 hover:text-amber-300" @click="dismissSoftRenderTip">
            <i class="fas fa-xmark"></i>
          </button>
        </div>
        <!-- E2 节点参考条（参考 canvas-node-reference-bar）：上游引用缩略图横排 -->
        <div
          v-if="nodeRefBar"
          class="node-ref-bar absolute z-20 flex h-[54px] items-center gap-1.5 rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] px-1.5 shadow-xl"
          :style="{ left: nodeRefBar.x + 'px', top: nodeRefBar.y + 'px' }"
          @pointerenter.stop
          @pointerleave="refBarLeave"
          @mousedown.stop
          @wheel.stop
        >
          <div
            v-for="r in nodeRefBar.refs"
            :key="r.linkId"
            class="group relative grid size-11 shrink-0 cursor-pointer place-items-center overflow-hidden rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-bg)]"
            :title="r.label"
            @pointerenter="refBarEnter(r, $event)"
            @pointerleave="refBarPreview.id = null"
            @click.stop="selection = [r.fromId]"
          >
            <img v-if="r.kind === 'image'" :src="r.src" class="size-full object-cover" alt="" />
            <video
              v-else-if="r.kind === 'video'"
              :src="r.src"
              class="size-full object-cover"
              muted
            ></video>
            <i
              v-else
              class="fas text-sm text-[var(--wb-text-2)]"
              :class="
                r.kind === 'note'
                  ? 'fa-file-lines'
                  : r.kind === 'app'
                    ? 'fa-cube'
                    : 'fa-puzzle-piece'
              "
            ></i>
            <button
              class="absolute right-0 top-0 grid size-4 place-items-center rounded-full border border-[var(--wb-stroke)] bg-[var(--wb-surface)] text-[9px] text-[var(--wb-text-2)] opacity-0 shadow transition-opacity group-hover:opacity-100"
              :title="t('canvasRefBarDisconnect')"
              @mousedown.stop
              @click.stop="refBarDisconnect(r.linkId)"
            >
              <i class="fas fa-xmark"></i>
            </button>
          </div>
          <button
            class="grid size-11 shrink-0 place-items-center rounded-lg border border-dashed border-[var(--wb-stroke)] text-[var(--wb-text-2)] transition hover:border-[var(--wb-accent)] hover:text-[var(--wb-accent)]"
            :title="t('canvasRefBarAdd')"
            @mousedown.stop
            @click.stop="refBarStartLink(nodeRefBar.id, $event)"
          >
            <i class="fas fa-plus text-xs"></i>
          </button>
        </div>
        <!-- E2 引用大图预览浮层 -->
        <div
          v-if="refBarPreview.id && refBarPreviewObj"
          class="pointer-events-none absolute z-30 w-72 rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] p-1.5 shadow-2xl"
          :style="{ left: refBarPreview.x + 'px', top: refBarPreview.y + 'px' }"
        >
          <img
            v-if="refBarPreviewObj.kind === 'image'"
            :src="refBarPreviewObj.src"
            class="max-h-52 w-full rounded-lg object-contain"
            alt=""
          />
          <video
            v-else-if="refBarPreviewObj.kind === 'video'"
            :src="refBarPreviewObj.src"
            class="max-h-52 w-full rounded-lg"
            muted
            controls
          ></video>
          <div
            v-else
            class="max-h-52 w-full overflow-auto whitespace-pre-wrap rounded-lg p-2 text-xs text-[var(--wb-text-2)]"
          >
            {{ refBarPreviewObj.text || refBarPreviewObj.label }}
          </div>
        </div>

        <!-- 节点悬浮工具栏（参考 canvas-node-hover-toolbar）：悬停物件上方 HTML overlay -->
        <div
          v-if="hoverToolbar.items.length"
          class="node-hover-toolbar absolute z-20 flex h-9 -translate-x-1/2 items-center rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-xl"
          :class="hoverToolbar.below ? 'is-below' : '-translate-y-full'"
          :style="{ left: hoverToolbar.x + 'px', top: hoverToolbar.y + 'px' }"
          @mousedown.stop
          @pointerdown.stop
          @dblclick.stop
          @mouseenter="keepToolbar(true)"
          @mouseleave="keepToolbar(false)"
        >
          <template v-for="b in hoverToolbar.items" :key="b.icon + (b.title || '')">
            <span
              v-if="b.sep"
              class="mx-0.5 h-5 w-px self-center bg-[var(--wb-stroke)]"
              aria-hidden="true"
            ></span>
            <button
              v-else
              :title="b.title"
              class="h-9 px-2 rounded-lg text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/15 transition flex items-center justify-center"
              :class="b.danger ? 'text-red-400' : ''"
              @click="b.action"
            >
              <i :class="b.icon" class="text-sm pointer-events-none"></i>
            </button>
          </template>
          <!-- 桥接热区：填住工具栏底边与节点顶边之间的 10px 间隙 -->
          <span class="tb-bridge" aria-hidden="true"></span>
        </div>

        <!-- 工具栏显隐设置浮层（P1：「…」按钮展开，勾选即时生效） -->
        <div
          v-if="tbSettings.open"
          data-tb-settings
          class="absolute z-30 w-52 rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] p-2 shadow-xl"
          :style="{ left: tbSettings.x + 'px', top: tbSettings.y + 'px' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <div class="mb-1 px-1 text-[10px] font-medium text-[var(--wb-text-2)]">
            {{ t('canvasTbSettingsTitle') }}
          </div>
          <div class="max-h-56 overflow-y-auto">
            <label
              v-for="c in tbSettings.items"
              :key="c.title"
              class="flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1 text-xs text-[var(--wb-text-1)] hover:bg-black/15"
            >
              <input
                type="checkbox"
                class="accent-[var(--wb-accent)]"
                :checked="!tbHidden.has(c.title)"
                @change="tbToggleHidden(c.title)"
              />
              <i :class="c.icon" class="w-3.5 text-center text-[10px] text-[var(--wb-text-2)]"></i>
              <span class="truncate">{{ c.title }}</span>
            </label>
          </div>
          <button
            class="mt-1 w-full rounded-md px-2 py-1 text-[10px] text-[var(--wb-text-2)] hover:bg-black/15 hover:text-[var(--wb-text-1)]"
            @click="tbResetHidden"
          >
            {{ t('canvasTbReset') }}
          </button>
        </div>

        <!-- note 调色板（悬浮工具栏的调色按钮展开，位于工具栏下方） -->
        <div
          v-if="notePalette.open"
          class="absolute z-30 flex h-10 -translate-x-1/2 items-center gap-1.5 rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] px-2 shadow-xl"
          :style="{ left: notePalette.x + 'px', top: notePalette.y + 'px' }"
          @mousedown.stop
          @pointerdown.stop
          @dblclick.stop
          @mouseenter="keepToolbar(true)"
          @mouseleave="keepToolbar(false)"
        >
          <button
            v-for="c in NOTE_COLORS"
            :key="c"
            class="w-6 h-6 rounded-full transition hover:scale-110"
            :class="
              notePaletteColor === c
                ? 'border border-[var(--wb-accent)] ring-2 ring-[var(--wb-accent)]/40'
                : 'border border-black/20'
            "
            :style="{ background: c }"
            :title="c"
            @click="setNoteColor(c)"
          ></button>
        </div>

        <!-- E3 编辑态提及高亮：textarea 底下的 mirror 层（@[名]{id} 染 chip 色） -->
        <div
          v-if="noteEditPos"
          class="note-editor note-editor-mirror absolute z-[19] overflow-hidden rounded-lg border-2 border-transparent pointer-events-none whitespace-pre-wrap break-words"
          :style="noteEditPos"
          aria-hidden="true"
        >
          <template v-for="(seg, i) in noteMentionSegments" :key="i">
            <span
              v-if="seg.mark"
              class="rounded bg-[var(--wb-accent)]/25 text-[var(--wb-accent)]"
              >{{ seg.raw }}</span
            >
            <span v-else>{{ seg.text }}</span>
          </template>
        </div>
        <!-- note 就地编辑：同位置 HTML textarea 接管（Konva v-text 不可编辑） -->
        <textarea
          v-if="noteEditPos"
          ref="noteEditArea"
          v-model="noteEdit.text"
          class="note-editor absolute z-20 resize-none rounded-lg border-2 border-[var(--wb-accent)] bg-transparent outline-none"
          :style="noteEditPos"
          :placeholder="t('canvasNoteEditPh')"
          @mousedown.stop
          @pointerdown.stop
          @dblclick.stop
          @wheel.stop
          @input="onNoteInput"
          @keydown="onNoteKeydown"
          @keydown.esc.stop.prevent="onNoteEsc"
          @keydown.enter.ctrl.prevent="commitNoteEdit"
          @blur="onNoteBlur"
        ></textarea>

        <!-- D1d @ 提及候选浮层 -->
        <div
          v-if="noteMention.open && mentionCandidates.length"
          class="absolute z-40 max-h-[200px] w-[230px] overflow-auto rounded-lg border border-[var(--wb-stroke)] bg-[var(--wb-surface)] py-1 text-xs shadow-xl"
          :style="{ left: noteMention.x + 'px', top: noteMention.y + 'px' }"
          @mousedown.stop
          @pointerdown.stop
        >
          <div class="px-3 py-1 text-[10px] uppercase tracking-wide text-slate-500">
            {{ t('canvasMentionTitle') }}
          </div>
          <button
            v-for="(c, i) in mentionCandidates"
            :key="c.id"
            class="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--wb-accent)]/15"
            :class="i === noteMention.pick ? 'bg-[var(--wb-accent)]/15' : ''"
            @click="pickMention(c)"
          >
            <i
              class="fas w-4 text-center text-slate-400"
              :class="
                c.kind === 'img' ? 'fa-image' : c.kind === 'app' ? 'fa-cube' : 'fa-note-sticky'
              "
            ></i>
            <span class="truncate text-[var(--wb-text-1)]">{{ c.label }}</span>
          </button>
        </div>

        <!-- frame 名称就地重命名：单行 input 覆盖在分区标签（分区顶上方）位置 -->
        <input
          v-if="frameEditPos"
          ref="frameEditArea"
          v-model="frameEdit.text"
          class="frame-editor absolute z-20 rounded-lg border-2 border-[var(--wb-accent)] outline-none px-1.5"
          :style="frameEditPos"
          :placeholder="t('canvasFrameNamePh')"
          @mousedown.stop
          @pointerdown.stop
          @dblclick.stop
          @wheel.stop
          @keydown.esc.stop.prevent="cancelFrameRename"
          @keydown.enter.prevent="commitFrameRename"
          @blur="commitFrameRename"
        />

        <!-- 缩放控件条（左下，参考 canvas-zoom-controls）：小地图开关/复位/滑杆/百分比/适应/快捷键 -->
        <div
          class="absolute bottom-3 left-3 z-10 flex items-center gap-1 h-11 px-2 rounded-xl bg-[var(--wb-surface)] border border-[var(--wb-stroke)] shadow-lg"
          @pointerdown.stop
          @mousedown.stop
          @dblclick.stop
        >
          <button
            class="w-8 h-8 rounded-lg text-sm transition flex items-center justify-center"
            :class="
              miniOpen
                ? 'text-[var(--wb-accent)] bg-[var(--wb-accent)]/10'
                : 'text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/10'
            "
            :title="t('canvasMiniMapToggle')"
            @click="miniOpen = !miniOpen"
          >
            <i class="fas fa-compass"></i>
          </button>
          <button
            class="w-8 h-8 rounded-lg text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/10 transition flex items-center justify-center"
            :title="t('canvasResetView')"
            @click="resetView"
          >
            <i class="fas fa-crosshairs"></i>
          </button>
          <button
            class="w-8 h-8 rounded-lg text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/10 transition flex items-center justify-center"
            :title="t('canvasFitAll')"
            @click="fitAll"
          >
            <i class="fas fa-expand"></i>
          </button>
          <input
            type="range"
            min="10"
            max="400"
            step="5"
            :value="Math.round(viewport.scale * 100)"
            class="w-24 accent-[var(--wb-accent)]"
            :title="t('canvasZoomSlider')"
            @input="onZoomSlider"
          />
          <span class="w-11 text-right text-xs tabular-nums text-[var(--wb-text-2)] select-none"
            >{{ Math.round(viewport.scale * 100) }}%</span
          >
          <button
            class="w-8 h-8 rounded-lg text-[var(--wb-text-1)] hover:bg-[var(--wb-accent)]/10 transition flex items-center justify-center"
            :title="t('canvasShortcuts')"
            @click="shortcutsOpen = true"
          >
            <i class="fas fa-circle-question"></i>
          </button>
        </div>

        <!-- 快捷键面板 -->
        <div
          v-if="shortcutsOpen"
          class="absolute inset-0 z-30 flex items-center justify-center bg-black/40"
          @mousedown.self="shortcutsOpen = false"
        >
          <div
            class="w-[420px] max-w-[90vw] rounded-xl border border-[var(--wb-stroke)] bg-[var(--wb-surface)] shadow-2xl p-5"
          >
            <div class="flex items-center justify-between mb-4">
              <span class="text-base font-semibold text-[var(--wb-text-1)]">{{
                t('canvasShortcuts')
              }}</span>
              <button
                class="text-[var(--wb-text-2)] hover:text-[var(--wb-text-1)]"
                @click="shortcutsOpen = false"
              >
                <i class="fas fa-xmark"></i>
              </button>
            </div>
            <div class="space-y-2.5 text-sm">
              <div
                v-for="sc in shortcutList"
                :key="sc.label"
                class="flex items-center justify-between gap-4"
              >
                <span class="font-medium text-[var(--wb-text-1)]">{{ sc.label }}</span>
                <span class="text-[var(--wb-text-2)]">{{ sc.desc }}</span>
              </div>
            </div>
          </div>
        </div>

        <!-- minimap：全景小窗（点击/拖动跳转视口） -->
        <div
          v-if="miniOpen && objects.length"
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
import { ref, computed, reactive, nextTick, onMounted, onBeforeUnmount, watch, h } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from '@/utils/i18n'
import { useAppStore } from '@/stores/appStore'
import { drainFiles, pushAttachments } from '@/utils/canvasBridge'
import { useCanvasMode } from '@/utils/canvasMode'
import { message, Modal } from 'ant-design-vue'
import Workbench from '../workbench/index.vue'
import AppHeader from '../apps/components/AppHeader.vue'
import AppNodeCard from './AppNodeCard.vue'
import CanvasSidePanel from './CanvasSidePanel.vue'
import CanvasAssetsPanel from './CanvasAssetsPanel.vue'
import MediaNodeCard from './MediaNodeCard.vue'
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
  splitRects,
  rotatedSize,
  videoFrameTime,
  upscaleSize,
  clampBrushSize,
  maskCanvasPoint,
  maskHasPaint,
  buildInpaintMask,
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
  stripMentionMarks,
  alignObjects,
  distributeObjects,
  zShiftObjects,
  gridArrangeImages,
  visibleIds,
  lodTextVisible,
  lodNoteRectStyle,
  lodImageVisible,
  freeResizeRect,
  ratioResizeRect,
} from './engine'

const { t } = useI18n()
const appStore = useAppStore()
const router = useRouter()
import {
  PROJECTS_STORAGE_KEY,
  LEGACY_STORAGE_KEY,
  migrateLegacyStore,
  normalizeStore,
  addProject as psAddProject,
  renameProject as psRenameProject,
  deleteProject as psDeleteProject,
  switchProject as psSwitchProject,
  updateProjectDoc as psUpdateProjectDoc,
  projectCardStats,
} from './projectStore'
import {
  builtinLibrary,
  loadCustomPrompts,
  saveCustomPrompts,
  parseImportedPrompts,
  mergePrompts,
  searchPrompts,
} from './promptLibrary'
import {
  buildExportPayload,
  packExportZip,
  parseImportZip,
  parseImportJson,
  buildSelectionZip,
} from './canvasExport'
import { importProject as psImportProject, cloneProject as psCloneProject } from './projectStore'
const { onResult, emitAttachments, emitCanvasState, emitPrompt, onOps } = useCanvasMode()
const wbOpen = ref(true) // 工作台侧边栏开合
const layersOpen = ref(false)
// —— 素材库（P2）：本地图片资产，点击/拖入画布复用 ——
const ASSETS_KEY = 'artify.canvas.assets.v1'
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
/** 素材入画布：persist dataURL 直接建 image 节点（等比 ≤260px） */
/** 视口中心的世界坐标（素材点击落点） */
function centerWorld() {
  return screenToWorld(viewport.value, size.w / 2, size.h / 2)
}
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
} // 图层面板开合（P1：画布侧板）
const hoverFromPanel = ref(null) // 面板悬停的物件 id（预留画布侧高亮联动）
let layersFocusAnim = null // 图层定位的 rAF 句柄

/** 图层树点击行：选中该物件并以 450ms easeOutCubic 动画居中（参考 focusNode） */
function focusObject(id) {
  const o = objects.value.find((x) => x.id === id)
  if (!o) return
  selection.value = [id]
  selectedLinkId.value = null
  if (ctxMenu.value) ctxMenu.value = null
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

const STORAGE_KEY = 'artify.canvas.doc.v1'

// —— 多画布项目集（S1）：artify.canvas.projects.v1，旧 artify.canvas.doc.v1 自动迁移 ——
const projectStore = reactive({ ...emptyProjectStore() })
function emptyProjectStore() {
  return { version: 1, activeId: null, projects: [] }
}
const activeProject = computed(
  () => projectStore.projects.find((p) => p.id === projectStore.activeId) || null,
)
const projectMenuOpen = ref(false)

// 启动迁移：旧单画布档升格首个项目（幂等）
;(function bootProjects() {
  const { store, migrated } = migrateLegacyStore(
    localStorage.getItem(PROJECTS_STORAGE_KEY),
    localStorage.getItem(LEGACY_STORAGE_KEY),
  )
  Object.assign(projectStore, store)
  if (migrated) persistProjects()
})()
function persistProjects() {
  try {
    localStorage.setItem(
      PROJECTS_STORAGE_KEY,
      JSON.stringify({
        version: 1,
        activeId: projectStore.activeId,
        projects: projectStore.projects,
      }),
    )
  } catch {
    /* 容量满静默 */
  }
}
/** 当前 doc → 项目集（saveNow 一并落盘） */
function syncActiveDocToStore() {
  if (!projectStore.activeId) return
  Object.assign(
    projectStore,
    psUpdateProjectDoc(normalizeStore({ ...projectStore }), projectStore.activeId, {
      version: 2,
      name: activeProject.value?.title || t('canvasUntitled'),
      viewport: { scale: viewport.value.scale, x: viewport.value.x, y: viewport.value.y },
      objects: objects.value.map((o) => ({ ...o })),
      links: links.value.map((l) => ({ ...l })),
      groups: groups.value.map((g) => ({ ...g })),
    }),
  )
}
/** 切换项目：当前内容先入库，再载入目标 */
function openProjectById(id) {
  if (id === projectStore.activeId) {
    projectMenuOpen.value = false
    return
  }
  syncActiveDocToStore()
  persistProjects()
  const target = projectStore.projects.find((p) => p.id === id)
  if (!target) return
  beforeChange()
  objects.value = target.doc.objects.map((o) => ({ ...o }))
  links.value = target.doc.links.map((l) => ({ ...l }))
  groups.value = target.doc.groups.map((g) => ({ ...g }))
  viewport.value = makeViewport(
    target.doc.viewport.scale,
    target.doc.viewport.x,
    target.doc.viewport.y,
  )
  Object.assign(projectStore, psSwitchProject({ ...projectStore }, id))
  selection.value = []
  selectedLinkId.value = null
  appPanel.id = null
  history.value = createHistory(60)
  nextTick(() => syncDraggables())
  persistProjects()
  projectMenuOpen.value = false
  message.info(t('canvasProjectSwitched').replace('{n}', target.title))
}
function createNewProject() {
  syncActiveDocToStore()
  const n = projectStore.projects.length + 1
  Object.assign(
    projectStore,
    psAddProject({ ...projectStore }, t('canvasProjectDefaultName').replace('{n}', String(n))),
  )
  loadProjectIntoCanvas()
  persistProjects()
  projectMenuOpen.value = false
}
function renameActiveProject(title) {
  if (!projectStore.activeId) return
  Object.assign(projectStore, psRenameProject({ ...projectStore }, projectStore.activeId, title))
  persistProjects()
}
// —— E4 项目卡：统计/相对时间/内联重命名/单删/导出/批量删除 ——
const prjBatchMode = ref(false)
const prjChecked = reactive(new Set())
const prjRenameId = ref(null)
const prjRenameInput = ref(null)
function prjStats(pr) {
  return projectCardStats(pr)
}
function prjRelTime(pr) {
  const st = prjStats(pr)
  const key =
    st.rel === 'justNow'
      ? 'canvasPrjJustNow'
      : st.rel === 'minutesAgo'
        ? 'canvasPrjMinutesAgo'
        : st.rel === 'hoursAgo'
          ? 'canvasPrjHoursAgo'
          : 'canvasPrjDaysAgo'
  return t(key).replace('{n}', String(st.relValue))
}
function togglePrjCheck(id) {
  if (prjChecked.has(id)) prjChecked.delete(id)
  else prjChecked.add(id)
}
function startPrjRename(id) {
  prjRenameId.value = id
  nextTick(() => {
    const el = Array.isArray(prjRenameInput.value) ? prjRenameInput.value[0] : prjRenameInput.value
    el?.focus?.()
    el?.select?.()
  })
}
function commitPrjRename(e) {
  const title = String(e.target.value || '').trim()
  const id = prjRenameId.value
  prjRenameId.value = null
  if (!id || !title) return
  Object.assign(projectStore, psRenameProject({ ...projectStore }, id, title))
  persistProjects()
}
/** E4：单项目导出（复用当前导出管线） */
/** 选中图片节点 → 纯图片 ZIP 下载（P2 节点级导出） */
function exportSelectionZip() {
  const picked = objects.value.filter((o) => selection.value.includes(o.id))
  buildSelectionZip(picked, {
    fetcher: async (url) => {
      const r = await fetch(url)
      return new Uint8Array(await r.arrayBuffer())
    },
  }).then((blob) => {
    if (!blob) {
      message.warning(t('canvasExportSelEmpty'))
      return
    }
    const u = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = u
    a.download = `canvas-selection-${new Date().toISOString().slice(0, 10)}.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(u), 5000)
  })
}
function exportProjectById(id) {
  syncActiveDocToStore()
  const clone = psCloneProject({ ...projectStore }, id)
  if (!clone) return
  const { payload, files } = buildExportPayload([clone])
  packExportZip(payload, files).then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    const pr = projectStore.projects.find((p) => p.id === id)
    a.download = `${(pr?.title || 'canvas').replace(/[\\/:*?"<>|]/g, '_')}.artify-canvas.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    message.success(t('canvasExported'))
  })
}
/** E4：卡片单删（含当前项目时切走并重载） */
function deleteProjectById(id) {
  const pr = projectStore.projects.find((p) => p.id === id)
  if (!pr) return
  Modal.confirm({
    title: t('canvasProjectDeleteTitle'),
    content: t('canvasProjectDeleteConfirm').replace('{n}', pr.title),
    okText: t('canvasProjectDeleteOk'),
    cancelText: t('cancel'),
    okButtonProps: { danger: true },
    onOk: () => {
      // fix: 删唯一项目时 psDeleteProject 兜底新建"未命名画布"（新 id），
      // 旧条件比较的是 computed 重算后的 activeProject（已指向新项目）→ 永假
      // → 画布残留旧节点，且后续 syncActiveDocToStore 把旧内容写进新项目。
      // 改为记录删除前的项目 id：变了就无条件重装载。
      const beforeId = projectStore.activeId
      Object.assign(projectStore, psDeleteProject({ ...projectStore }, id))
      if (projectStore.activeId !== beforeId) loadProjectIntoCanvas()
      persistProjects()
    },
  })
}
/** E4：批量删除（勾选集；当前项目被删则切默认并重载） */
function exitPrjBatch() {
  prjBatchMode.value = false
  prjChecked.clear()
}
function deleteCheckedProjects() {
  const ids = Array.from(prjChecked)
  if (!ids.length) return
  Modal.confirm({
    title: t('canvasPrjBatchDel'),
    content: `${ids.length} → ${ids
      .slice(0, 5)
      .map((i) => projectStore.projects.find((p) => p.id === i)?.title || i)
      .join('、')}${ids.length > 5 ? '…' : ''}`,
    okText: t('canvasProjectDeleteOk'),
    cancelText: t('cancel'),
    okButtonProps: { danger: true },
    onOk: () => {
      // fix: 同单卡删除——先记删除前 activeId，避免 computed 已重算导致漏装载
      const beforeId = projectStore.activeId
      let store = { ...projectStore }
      for (const id of ids) store = psDeleteProject(store, id)
      Object.assign(projectStore, store)
      if (!projectStore.projects.some((p) => p.id === beforeId)) loadProjectIntoCanvas()
      persistProjects()
      prjChecked.clear()
      prjBatchMode.value = false
    },
  })
}

function deleteActiveProject() {
  const cur = activeProject.value
  if (!cur) return
  Modal.confirm({
    title: t('canvasProjectDeleteTitle'),
    content: t('canvasProjectDeleteConfirm').replace('{n}', cur.title),
    okText: t('canvasProjectDeleteOk'),
    cancelText: t('cancel'),
    okButtonProps: { danger: true },
    onOk: () => {
      Object.assign(projectStore, psDeleteProject({ ...projectStore }, cur.id))
      loadProjectIntoCanvas()
      persistProjects()
    },
  })
}
// —— 导入导出（S2）：当前项目导出 ZIP（projects.json + 图片文件），导入支持 zip/json ——
function exportCurrentProject() {
  syncActiveDocToStore()
  const clone = psCloneProject({ ...projectStore }, projectStore.activeId)
  if (!clone) return
  const { payload, files } = buildExportPayload([clone])
  packExportZip(payload, files).then((blob) => {
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${(activeProject.value?.title || 'canvas').replace(/[\\/:*?"<>|]/g, '_')}.artify-canvas.zip`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 5000)
    message.success(t('canvasExported'))
  })
}
function pickImportFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.zip,.json,application/zip,application/json'
  input.onchange = () => {
    const f = input.files?.[0]
    if (f) importCanvasFile(f)
  }
  input.click()
}
async function importCanvasFile(f) {
  try {
    let projects = null
    if (f.name.endsWith('.json') || f.type === 'application/json') {
      projects = parseImportJson(await f.text()).projects
    } else {
      projects = (await parseImportZip(f)).projects
    }
    if (!projects?.length) {
      message.warning(t('canvasImportEmpty'))
      return
    }
    let lastId = null
    for (const prj of projects) {
      const { store, id } = psImportProject({ ...projectStore }, prj)
      Object.assign(projectStore, store)
      lastId = id
    }
    persistProjects()
    if (lastId) {
      openProjectById(lastId)
      message.success(t('canvasImported').replace('{n}', String(projects.length)))
    }
  } catch (e) {
    message.error(t('canvasImportFailed') + ': ' + (e?.message || 'format'))
  }
}

/** 项目集当前激活项目 → 画布状态（新建/删除后回落） */
function loadProjectIntoCanvas() {
  const p = activeProject.value
  if (!p) return
  let washed = false
  objects.value = p.doc.objects.map((o) => {
    // fix(重启后媒体死链): blob: URL 仅当前文档生命周期有效,刷新/重启必死;
    // persist 快照(dataURL)在则回退——image 节点此前无回退(直接透明),
    // video/audio 的 watch 只判空 src(死链非空不触发),一并在此统一洗。
    if (typeof o.src === 'string' && o.src.startsWith('blob:') && o.persist) {
      washed = true
      return { ...o, src: o.persist }
    }
    return { ...o }
  })
  if (washed) saveSoon() // 洗过就写回 store,死链不再反复落盘（否则每次 boot 重洗）
  links.value = p.doc.links.map((l) => ({ ...l }))
  groups.value = p.doc.groups.map((g) => ({ ...g }))
  viewport.value = makeViewport(p.doc.viewport.scale, p.doc.viewport.x, p.doc.viewport.y)
  selection.value = []
  selectedLinkId.value = null
  appPanel.id = null
  history.value = createHistory(60)
  nextTick(() => syncDraggables())
}
/** 项目标题双击编辑（inline） */
const projectTitleInput = ref(null)
const projectTitleEditing = ref(false)
const projectTitleDraft = ref('')
function startProjectTitleEdit() {
  projectTitleDraft.value = activeProject.value?.title || ''
  projectTitleEditing.value = true
}
watch(projectTitleEditing, (v) => {
  if (v) nextTick(() => projectTitleInput.value?.focus?.())
})

function finishProjectTitleEdit() {
  if (projectTitleEditing.value) {
    renameActiveProject(projectTitleDraft.value)
    projectTitleEditing.value = false
  }
}
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
// D1c：Shift/Ctrl 全局键态（Konva 事件链不透传修饰键，resize 用实时键态判定）
const shiftDown = ref(false)
const ctrlDown = ref(false)
const cropRect = ref(null) // 'crop' 模式拖出的世界矩形
// —— 连线（参考 infinite-canvas）：句柄拖拽建线 + 连线点选 ——
const connectDrag = reactive({
  active: false,
  nodeId: null, // 起始物件 id
  handleType: null, // 'source'（右句柄，from）| 'target'（左句柄，to）
  seg: null, // 预览贝塞尔端点 {x1,y1,x2,y2}
  targetId: null, // 悬停吸附的目标物件 id
})
// —— C 拖线落空 → 创建节点菜单（参考 ConnectionCreateMenu）——
// 松手在空白处时弹小菜单：便签/图片/视频/音频/App，创建后与拖线起点自动连线
const connectCreate = reactive({
  open: false,
  x: 0,
  y: 0,
  wx: 0,
  wy: 0,
  from: null, // 拖线源侧物件 id（source 句柄拖出）
  to: null, // 拖线目标侧物件 id（target 句柄拖出）
  pickLink: null, // app 分支等 picker 选完后连线
})
function closeConnectCreate() {
  connectCreate.open = false
  connectCreate.from = null
  connectCreate.to = null
  connectCreate.pickLink = null
}
// —— 选中连线的重连拖拽（参考 infinite-canvas ConnectionPath 两端锚点语义）——
// 选中连线后在两端显示可拖锚点：拖源端(from)改接新源、拖目标端(to)改接新目标。
// 复用 connect 的吸附规则：from 端贴目标右缘、to 端贴目标左缘。
const reconnectDrag = reactive({
  active: false,
  linkId: null,
  side: null, // 'from'（拖源端 x1,y1）| 'to'（拖目标端 x2,y2）
  fixedId: null, // 不动端节点 id（防止自环与重复计算）
  targetId: null, // 悬停吸附的目标物件 id
  seg: null, // 预览贝塞尔端点 {x1,y1,x2,y2}
})
function cancelReconnectDrag() {
  reconnectDrag.active = false
  reconnectDrag.linkId = null
  reconnectDrag.side = null
  reconnectDrag.fixedId = null
  reconnectDrag.targetId = null
  reconnectDrag.seg = null
}
/** 按 connect 拖线方向连接新节点（from=源侧 to=目标侧，只补缺失侧） */
function linkFromConnect(nodeId, from, to) {
  const fromId = from && from !== nodeId ? from : null
  const toId = to && to !== nodeId ? to : null
  const linksToAdd = []
  if (fromId) linksToAdd.push({ from: fromId, to: nodeId })
  if (toId) linksToAdd.push({ from: nodeId, to: toId })
  for (const l of linksToAdd) {
    if (!links.value.some((x) => x.from === l.from && x.to === l.to)) {
      links.value.push({
        id: 'l' + Date.now() + Math.random().toString(36).slice(2, 5),
        ...l,
      })
    }
  }
}
/** 在 connectCreate.wx/wy 创建 kind 节点并按拖线方向连线 */
function createNodeFromConnect(kind) {
  const { wx, wy, from, to } = connectCreate
  closeConnectCreate()
  beforeChange()
  if (kind === 'note') {
    const o = {
      id: 'n' + Date.now() + Math.random().toString(36).slice(2, 5),
      type: 'note',
      x: wx - 90,
      y: wy - 60,
      width: 180,
      height: 120,
      text: '',
    }
    objects.value.push(o)
    linkFromConnect(o.id, from, to)
    selection.value = [o.id]
    saveSoon()
    return o.id
  }
  if (kind === 'app') {
    openAppPicker(wx, wy)
    connectCreate.pickLink = { from, to }
    return null
  }
  // 图片/视频/音频：文件选择器（创建后连线）
  const accept = kind === 'image' ? 'image/*' : kind === 'video' ? 'video/*' : 'audio/*'
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = accept
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    beforeChange()
    if (kind === 'image') {
      const url = URL.createObjectURL(f)
      const probe = new Image()
      probe.onload = () => {
        const scale = Math.min(1, 260 / probe.naturalWidth)
        const w = Math.round(probe.naturalWidth * scale)
        const h = Math.round(probe.naturalHeight * scale)
        const o = {
          id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
          type: 'image',
          x: wx - Math.round(w / 2),
          y: wy - Math.round(h / 2),
          width: w,
          height: h,
          src: url,
          persist: null,
        }
        objects.value.push(o)
        persistImage(o)
        linkFromConnect(o.id, from, to)
        selection.value = [o.id]
        saveSoon()
      }
      probe.src = url
    } else {
      const isVideo = kind === 'video'
      const o = {
        id: 'n' + Date.now() + Math.random().toString(36).slice(2, 6),
        type: kind,
        x: wx - (isVideo ? 160 : 140),
        y: wy - (isVideo ? 90 : 48),
        width: isVideo ? 320 : 280,
        height: isVideo ? 180 : 96,
        src: URL.createObjectURL(f),
        persist: null,
        name: f.name,
      }
      objects.value.push(o)
      if (isVideo) {
        const probe = document.createElement('video')
        probe.preload = 'metadata'
        probe.onloadedmetadata = () => {
          const ratio = probe.videoHeight / probe.videoWidth || 0.5625
          o.height = Math.round(o.width * ratio)
          saveSoon()
        }
        probe.src = o.src
      }
      linkFromConnect(o.id, from, to)
      selection.value = [o.id]
      saveSoon()
    }
  }
  input.click()
  return null
}

const selectedLinkId = ref(null) // 选中的连线 id（参考 selectedConnectionId）
const hoverNodeId = ref(null) // 悬停物件 id（句柄显现条件，参考 hovered || isSelected || isConnecting）
/** 高亮判定（含图层面板行悬停联动）：画布悬停或面板行悬停都算 */
function isHighlightedOf(o) {
  return hoverNodeId.value === o.id || hoverFromPanel.value === o.id
}
/** 高亮描边（选中 > 高亮 > 默认）：面板行悬停时节点亮 accent 描边 */
/** CSS 变量在 canvas 2D 无效（var(--wb-accent) 会被画成黑色）——解析成实际色值 */
let accentColorCache = ''
function accentColor() {
  if (!accentColorCache) {
    accentColorCache =
      getComputedStyle(document.documentElement).getPropertyValue('--wb-accent').trim() || '#0b8ce9'
  }
  return accentColorCache
}
function highlightStroke(o, defStroke = 'rgba(148,163,184,0.4)') {
  if (selection.value.includes(o.id)) return { stroke: accentColor(), strokeWidth: 2 }
  if (isHighlightedOf(o)) return { stroke: '#38bdf8', strokeWidth: 2 }
  return { stroke: defStroke, strokeWidth: 1 }
}
/** 物件是否显示连接句柄：悬停/选中/连线拖拽中（起点与悬停目标，参考 isConnecting 全显） */
function showHandles(o) {
  // fix(拖动中桩消失): 被拖节点的句柄保持显现——此前仅 hover/选中/连线三态,
  // 拖动路径上 hover 判定不更新(220ms 后被 scheduleHoverHide 清空),若点击
  // 未建立选中(句柄热区拦截 mousedown 的时序窗口)句柄立即隐没,用户感知
  // "连线桩不跟随拖动"。
  if (drag.mode === 'item' && objects.value[drag.item]?.id === o.id) return true
  return (
    isHighlightedOf(o) ||
    selection.value.includes(o.id) ||
    (connectDrag.active && (connectDrag.nodeId === o.id || connectDrag.targetId === o.id)) ||
    (reconnectDrag.active && reconnectDrag.targetId === o.id)
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
  [
    hoverNodeId,
    hoverFromPanel,
    selectedLinkId,
    () => [connectDrag.active, connectDrag.targetId],
    () => [reconnectDrag.active, reconnectDrag.targetId],
    // fix: 被拖节点句柄显隐随 drag.mode 变化,热区开关需要同步重绘 hit graph
    () => drag.mode,
  ],
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
    // fix(热区劫持拖动): 原 24px 半径热区在 64px 级小图上盖满大半节点,
    // mousedown 全被句柄吃掉进连线模式——节点本体拖不动、桩看似"不跟随"。
    // 热区收敛到圆点视觉半径 2 倍(≈12px 屏距):句柄好点、图拖得动。
    hitFunc(ctx, shape) {
      if (!showHandles(o)) return
      const r = 12 / viewport.value.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}
/** 连线重连锚点配置（选中连线才显现）：from 端=源侧(右端 x1,y1)、to 端=目标侧(左端 x2,y2)。
 *  常驻渲染 + hitFunc 动态热区 —— 平时 opacity 0 且无热区，不拦截连线/物件交互；
 *  选中后热区开启，可拖到其它物件重连。颜色区分两端便于识别方向。 */
function linkAnchorConfig(seg, side) {
  const active = selectedLinkId.value === seg.id && !reconnectDrag.active
  return {
    x: side === 'from' ? seg.x1 : seg.x2,
    y: side === 'from' ? seg.y1 : seg.y2,
    radius: 6.5 / viewport.value.scale,
    fill: side === 'from' ? '#7dd3fc' : '#fcd34d', // 天蓝=源端 琥珀=目标端
    stroke: '#1f1d1a',
    strokeWidth: 1.5 / viewport.value.scale,
    opacity: active ? 1 : 0,
    cursor: 'grab',
    hitFunc(ctx, shape) {
      if (!active) return
      const r = 22 / viewport.value.scale
      ctx.beginPath()
      ctx.arc(0, 0, r, 0, Math.PI * 2, false)
      ctx.closePath()
      ctx.fillStrokeShape(shape)
    },
  }
}

// —— 选中对象四角缩放手柄（第 3 批 + 媒体扩展，参考 infinite-canvas resize handles）——
// 支持类型：图片/视频（默认锁宽高比，Ctrl/⌘ 按住自由）/ 便签 / Frame / 音频（恒自由）。
// 角柄画在节点四角外侧（RESIZE_ANCHOR_OFF）——媒体节点的 HTML overlay 播放器占满节点
// 矩形，角柄外置才不被遮挡；App/分镜卡（固定布局）不支持；组内成员禁止
// （组合语义由组拖动承载，防破坏成员相对位置）。
const RESIZE_TYPES = ['image', 'note', 'frame', 'video', 'audio', 'shot']
const RESIZE_MIN = 24 // 最小宽高（世界坐标）
const resizeDrag = reactive({
  active: false,
  id: null, // 被拖对象 id
  corner: null, // 'nw' | 'ne' | 'sw' | 'se'
  fixed: null, // 对角不动点 {x,y}（拖 nw → 固定 se）
  orig: null, // 起拖时 {x,y,w,h}
  ratio: 0, // >0 锁宽高比（图片原图比例）；0 = 自由拉伸
  startRatio: 0, // D1c：起拖时比例快照（拖拽中 Shift 临时锁定用，防漂移）
  pushed: false, // 首次实际位移才压 undo 快照（点住不拖不产生历史）
})
/** 单选且可缩放的对象（唯一显示角柄的目标；多选/不可缩放/crop 工具返回空） */
const resizeTargets = computed(() => {
  if (tool.value === 'crop') return [] // crop 需从图片角落起圈，角柄热区会抢命中
  if (selection.value.length !== 1) return []
  const o = objects.value.find((x) => x.id === selection.value[0])
  if (!o || !RESIZE_TYPES.includes(o.type)) return []
  if (groupOf(o.id)) return []
  return [o]
})
/** 角柄显隐/命中判定（实时状态：拖动中仅目标对象自身保留角柄并跟随其角移动） */
function resizeVisible(o) {
  const t = resizeTargets.value[0]
  if (t !== o) return false
  return !resizeDrag.active || resizeDrag.id === o.id
}
/** 角柄 circle 配置（同 linkAnchorConfig 模式：常驻渲染 + hitFunc 动态热区）。
 *  圆心外偏 10px（屏幕恒定）：媒体节点 overlay 播放器占满矩形，角柄外置才可命中；
 *  普通节点上也让角柄悬于边框外，避免盖住节点像素。 */
function resizeAnchorConfig(o, corner) {
  const off = 10 / viewport.value.scale // 屏幕 10px → 世界（随缩放）
  return {
    x: corner.endsWith('e') ? o.width + off : -off,
    y: corner.startsWith('s') ? o.height + off : -off,
    radius: 6 / viewport.value.scale,
    fill: '#fafaf9',
    stroke: '#1f1d1a',
    strokeWidth: 1.5 / viewport.value.scale,
    opacity: resizeVisible(o) ? 1 : 0,
    cursor: corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize',
    hitFunc(ctx, shape) {
      if (!resizeVisible(o)) return
      const r = 20 / viewport.value.scale
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

// —— 视口裁剪（P2 性能）：可见集 + 例外（选中/悬停/连线端点/拖拽中）
// 例外保证交互不因裁剪丢失：选中的仍要渲染（框选/对齐线）、悬停的
// 工具栏不消失、连线端点物件在场、拖拽中的物件及其组友保持
const cullIds = computed(() => {
  const ids = visibleIds(objects.value, viewport.value, size, 240)
  for (const id of selection.value) ids.add(id)
  if (hoverNodeId.value) ids.add(hoverNodeId.value)
  if (hoverFromPanel.value) ids.add(hoverFromPanel.value)
  for (const l of links.value) {
    if (ids.has(l.from)) ids.add(l.to)
    if (ids.has(l.to)) ids.add(l.from)
  }
  return ids
})
/** 类型过滤 + 裁剪（所有物件渲染 computed 统一入口） */
function withCull(typePred) {
  return objects.value.filter((o) => typePred(o) && cullIds.value.has(o.id))
}

const imageObjects = computed(() => withCull((o) => o.type === 'image'))
/** 全类型裁剪集（连接句柄层用） */
/** 句柄层 LOD：低缩放整组隐藏（全览 875 物件 1752 圆点无意义且是大头）；命中检测不受影响（hitFunc 本就仅悬停时开） */
const lodHandlesVisible = computed(() => lodTextVisible(viewport.value.scale))
const culledObjects = computed(() => withCull(() => true))
const noteObjects = computed(() => withCull((o) => o.type === 'note'))

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
  // 全层重绘：图片 onload 在节点层（第二层），只刷第一层会导致图片加载后不显示
  stageEl.value?.getStage?.()?.batchDraw()
}

function groupConfig(o) {
  return { id: o.id, x: o.x, y: o.y, width: o.width, height: o.height, draggable: true }
}
function imageConfig(o) {
  // LOD：极低缩放隐藏位图绘制（保留 rect 示意）
  if (!lodImageVisible(viewport.value.scale)) {
    return { width: o.width, height: o.height, cornerRadius: 6, fill: '#1f2937' }
  }
  return {
    image: loadImage(o.src),
    width: o.width,
    height: o.height,
    ...highlightStroke(o, 'rgba(148,163,184,0.35)'),
    cornerRadius: 6,
  }
}
/** 媒体节点占位框（overlay 播放器下的 Konva 热区/选中框） */
function mediaRectConfig(o) {
  const sel = selection.value.includes(o.id)
  // fix(视频双影): rect 位于 group 内，坐标须相对 group(0,0)——此前误带 o.x/o.y
  // 世界坐标，占位框被画到 2 倍偏移处（group.x + rect.x），与 HTML overlay
  // 播放器(世界坐标定位)分离成"两个区块"，且 hit graph 落空导致拖拽失效。
  return {
    width: o.width,
    height: o.height,
    fill: o.type === 'video' ? 'rgba(14,165,233,0.10)' : 'rgba(168,85,247,0.10)',
    stroke: sel
      ? '#38bdf8'
      : isHighlightedOf(o)
        ? '#38bdf8'
        : o.type === 'video'
          ? 'rgba(56,189,248,0.55)'
          : 'rgba(192,132,252,0.55)',
    strokeWidth: sel || isHighlightedOf(o) ? 2 : 1.5,
    cornerRadius: 12,
  }
}

// note 调色板：预设底色（前 7 个为亮色 → 深色文字；默认 slate 深色 → 浅色文字）
const NOTE_COLORS = [
  '#fef08a', // yellow
  '#f9a8d4', // pink
  '#86efac', // green
  '#7dd3fc', // sky
  '#fdba74', // orange
  '#c4b5fd', // violet
  '#fda4af', // rose
  '#475569', // slate（默认）
]
const NOTE_DEFAULT_COLOR = '#475569'
/** 按背景亮度选文字色：亮底深字 / 深底浅字（便签新配色可读性） */
function noteTextColor(bg) {
  const hex = String(bg || NOTE_DEFAULT_COLOR).replace('#', '')
  if (hex.length !== 6) return '#e2e8f0'
  const r = parseInt(hex.slice(0, 2), 16)
  const g = parseInt(hex.slice(2, 4), 16)
  const b = parseInt(hex.slice(4, 6), 16)
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return lum > 0.55 ? '#1e293b' : '#e2e8f0'
}

function noteRectConfig(o) {
  // LOD 二轮：缩略级降级样式（opacity 1 / 去圆角 / 去默认描边——
  // perfectDraw 离屏中转是千件全览 draw 大头，纯函数 lodNoteRectStyle 单测锁定）
  const lowLod = lodNoteRectStyle(viewport.value.scale)
  return {
    width: o.width,
    height: o.height,
    fill: o.color || NOTE_DEFAULT_COLOR,
    opacity: lowLod ? 1 : 0.9,
    cornerRadius: lowLod ? 0 : 8,
    ...(lowLod ? highlightStroke(o, '') : highlightStroke(o)),
  }
}
function noteTextConfig(o) {
  // LOD：缩略级视口隐藏文本排版（全览 1000 物件 Text 布局是大头）
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
  return {
    // E3：显示态净化 @ 提及标记（@[名]{id} → @名）
    text: stripMentionMarks(o.text || ''),
    width: o.width,
    height: o.height,
    padding: 10,
    fontSize: o.fontSize || 13,
    lineHeight: 1.4,
    fill: noteTextColor(o.color),
    align: 'left',
  }
}

// —— note 文本就地编辑：双击便签 / 悬浮工具栏「编辑」/ 右键菜单 ——
// Konva 的 v-text 不可编辑，故用同位置的 HTML textarea 覆盖接管（视口变化自动跟随）
const noteEdit = reactive({ id: null, text: '', skipCommit: false })
const noteEditArea = ref(null)
/** E3：编辑态文本按 @ 标记分段（mark 段渲染为 chip 样式） */
const noteMentionSegments = computed(() => {
  const text = noteEdit.text || ''
  const segs = []
  const re = /@\[([^\]]*)\]\{([^}]+)\}/g
  let last = 0
  let m
  while ((m = re.exec(text))) {
    if (m.index > last) segs.push({ text: text.slice(last, m.index) })
    segs.push({ mark: true, label: m[1] || m[2], raw: m[0] })
    last = m.index + m[0].length
  }
  if (last < text.length) segs.push({ text: text.slice(last) })
  return segs
})
const noteEditPos = computed(() => {
  const o = objects.value.find((x) => x.id === noteEdit.id && x.type === 'note')
  if (!o) return null
  const tl = worldToScreen(viewport.value, o.x, o.y)
  const s = viewport.value.scale
  return {
    left: tl.x + 'px',
    top: tl.y + 'px',
    width: o.width * s + 'px',
    height: o.height * s + 'px',
    fontSize: Math.max(10, (o.fontSize || 13) * s) + 'px',
  }
})
function startNoteEdit(id) {
  closeNotePalette() // 进入文本编辑：收起色板浮层，避免与 textarea 叠层
  const o = objects.value.find((x) => x.id === id && x.type === 'note')
  if (!o) return
  if (noteEdit.id && noteEdit.id !== id) commitNoteEdit()
  noteEdit.id = id
  noteEdit.text = o.text || ''
  noteEdit.skipCommit = false
  selection.value = [id]
  nextTick(() => {
    const el = noteEditArea.value
    if (!el) return
    el.focus()
    const end = el.value.length
    el.setSelectionRange(end, end)
  })
}
/** 提交：内容有变才记撤销点（避免空编辑污染历史） */
function commitNoteEdit() {
  const id = noteEdit.id
  if (!id) return
  if (noteEdit.skipCommit) return
  const o = objects.value.find((x) => x.id === id)
  const next = noteEdit.text
  noteEdit.id = null
  noteEdit.text = ''
  if (!o || o.type !== 'note') return
  if (next !== (o.text || '')) {
    beforeChange()
    o.text = next
    saveSoon()
  }
}
/** 取消：丢弃改动。置 skipCommit —— 元素被摘除时部分浏览器仍会补发 blur */
function cancelNoteEdit() {
  noteEdit.id = null
  noteEdit.text = ''
  noteEdit.skipCommit = true
  setTimeout(() => {
    noteEdit.skipCommit = false
  }, 0)
}

// —— note 底色（调色板挂悬浮工具栏，点色即换；参考项目 note color）——
// —— D1d 便签 @ 资源提及：textarea 内输入 @ 弹资源清单，选中插入标记 ——
// 标记语法 `@[显示名]{id}`：collectUpstream 解析为图片喂养（见 appNode.js）
const noteMention = reactive({ open: false, query: '', x: 0, y: 0, start: -1, pick: 0 })
/** 候选：画布图片（/view 引用或 blob 均可，名称可读）+ app 节点 + 其他便签（排除自身） */
const mentionCandidates = computed(() => {
  if (!noteMention.open) return []
  const q = noteMention.query.toLowerCase()
  const out = []
  for (const o of objects.value) {
    if (o.id === noteEdit.id) continue
    let label = ''
    let kind = ''
    if (o.type === 'image') {
      if (o.name) label = o.name
      else if (o.src && o.src.startsWith('http')) {
        try {
          label = new URL(o.src).searchParams.get('filename') || '图片 ' + o.id.slice(-4)
        } catch {
          label = t('canvasKindImage') + ' ' + o.id.slice(-4)
        }
      } else label = t('canvasKindImage') + ' ' + o.id.slice(-4)
      kind = 'img'
    } else if (o.type === 'app') {
      label = o.name || o.appId || 'App'
      kind = 'app'
    } else if (o.type === 'note') {
      label = (o.text || '').replace(/\s+/g, ' ').slice(0, 20) || t('canvasKindNote')
      kind = 'note'
    } else continue
    if (q && !label.toLowerCase().includes(q)) continue
    out.push({ id: o.id, label, kind })
  }
  return out.slice(0, 8)
})
function onNoteInput(e) {
  const el = e.target
  const pos = el.selectionStart ?? el.value.length
  const before = el.value.slice(0, pos)
  // 光标前最近一个未闭合的 @（其后只允许查询字符）
  const m = /(?:^|\s)@([^@\s]{0,24})$/.exec(before)
  if (m) {
    noteMention.open = true
    noteMention.query = m[1]
    noteMention.start = pos - m[1].length - 1
    noteMention.pick = 0
    const ta = noteEditArea.value
    if (ta) {
      const mirror = document.createElement('div')
      const cs = getComputedStyle(ta)
      mirror.style.cssText = `position:absolute;visibility:hidden;white-space:pre-wrap;word-wrap:break-word;width:${cs.width};font:${cs.font};line-height:${cs.lineHeight};letter-spacing:${cs.letterSpacing}`
      mirror.textContent = before
      document.body.appendChild(mirror)
      const range = document.createRange()
      const lastNode = mirror.lastChild
      if (lastNode) {
        range.selectNodeContents(lastNode)
        range.collapse(false)
      }
      const rects = range.getClientRects()
      const rect = rects.length ? rects[rects.length - 1] : mirror.getBoundingClientRect()
      const host = wrapEl.value?.getBoundingClientRect() || { left: 0, top: 0 }
      noteMention.x = clamp(rect.left - host.left, 8, Math.max(8, size.w - 240))
      noteMention.y = clamp(rect.bottom - host.top + 4, 8, Math.max(8, size.h - 220))
      mirror.remove()
    }
  } else {
    noteMention.open = false
  }
}
function pickMention(opt) {
  const el = noteEditArea.value
  if (!el || noteMention.start < 0) return closeMention()
  const pos = el.selectionStart ?? el.value.length
  const text = el.value
  const insert = `@[${opt.label}]{${opt.id}} `
  const next = text.slice(0, noteMention.start) + insert + text.slice(pos)
  noteEdit.text = next
  closeMention()
  nextTick(() => {
    const p = noteMention.start + insert.length
    el.focus()
    el.setSelectionRange(p, p)
  })
}
function onNoteEsc() {
  closeMention()
  cancelNoteEdit()
}
function onNoteBlur() {
  commitNoteEdit()
  closeMention()
}
function closeMention() {
  noteMention.open = false
  noteMention.query = ''
  noteMention.start = -1
  noteMention.pick = 0
}
function onNoteKeydown(e) {
  if (!noteMention.open || !mentionCandidates.value.length) return
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    noteMention.pick = (noteMention.pick + 1) % mentionCandidates.value.length
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    noteMention.pick =
      (noteMention.pick - 1 + mentionCandidates.value.length) % mentionCandidates.value.length
  } else if (e.key === 'Enter' || e.key === 'Tab') {
    e.preventDefault()
    pickMention(mentionCandidates.value[noteMention.pick])
  } else if (e.key === 'Escape') {
    closeMention()
  }
}

const notePalette = reactive({ id: null, x: 0, y: 0, open: false })
/** 当前色板对应便签（选中色高亮用） */
const notePaletteColor = computed(() => {
  const o = objects.value.find((x) => x.id === notePalette.id && x.type === 'note')
  return o ? o.color || NOTE_DEFAULT_COLOR : ''
})
/** 打开：以悬浮工具栏几何定位（工具栏视觉下沿，色板居中于节点中线） */
function openNotePalette(id) {
  const o = objects.value.find((x) => x.id === id && x.type === 'note')
  if (!o) return
  notePalette.id = id
  const tb = hoverToolbar.value
  // 工具栏：below=false 时整体在 y 之上（占 [y-36, y]）；below=true 时在 y 之下（占 [y, y+36]）
  notePalette.x = clamp(tb.below ? tb.x : tb.x, 132, Math.max(132, size.w - 132))
  notePalette.y = clamp(tb.y + (tb.below ? 38 : 2), 8, Math.max(8, size.h - 48))
  notePalette.open = true
}
function closeNotePalette() {
  notePalette.open = false
  notePalette.id = null
}
/** 设底色：变更前压 undo 快照，改后即时保存（对象已选/悬停态保持） */
function setNoteColor(c) {
  const o = objects.value.find((x) => x.id === notePalette.id && x.type === 'note')
  if (!o) return
  if ((o.color || NOTE_DEFAULT_COLOR) !== c) {
    beforeChange()
    o.color = c
    layerRefresh()
    saveSoon()
  }
  closeNotePalette()
}

// —— frame 名称就地重命名：单行 HTML input 覆盖在分区标签（frame.y - 20 上方）位置 ——
const frameEdit = reactive({ id: null, text: '', skipCommit: false })
const frameEditArea = ref(null)
const frameEditPos = computed(() => {
  const o = objects.value.find((x) => x.id === frameEdit.id && x.type === 'frame')
  if (!o) return null
  const tl = worldToScreen(viewport.value, o.x, o.y)
  const s = viewport.value.scale
  return {
    left: tl.x + 'px',
    top: tl.y - Math.max(22, 24 * s) + 'px',
    width: Math.max(80, o.width * s) + 'px',
    fontSize: Math.max(11, 13 * s) + 'px',
  }
})
function startFrameRename(id) {
  const o = objects.value.find((x) => x.id === id && x.type === 'frame')
  if (!o) return
  if (noteEdit.id && noteEdit.id !== id) commitNoteEdit()
  if (frameEdit.id && frameEdit.id !== id) commitFrameRename()
  frameEdit.id = id
  frameEdit.text = o.name || ''
  frameEdit.skipCommit = false
  selection.value = [id]
  nextTick(() => {
    const el = frameEditArea.value
    if (!el) return
    el.focus()
    el.select()
  })
}
function commitFrameRename() {
  const id = frameEdit.id
  if (!id) return
  if (frameEdit.skipCommit) return
  const o = objects.value.find((x) => x.id === id)
  const next = frameEdit.text.trim()
  frameEdit.id = null
  frameEdit.text = ''
  if (!o || o.type !== 'frame') return
  if (next && next !== (o.name || '')) {
    beforeChange()
    o.name = next
    saveSoon()
  }
}
function cancelFrameRename() {
  frameEdit.id = null
  frameEdit.text = ''
  frameEdit.skipCommit = true
  setTimeout(() => {
    frameEdit.skipCommit = false
  }, 0)
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

function onWheel(e) {
  e.evt.preventDefault()
  // 缩放改变屏幕坐标，浮层锚点会漂移 —— 直接收起
  if (ctxMenu.value) ctxMenu.value = null
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
  // 右键菜单/连线创建菜单：点任何物件即收起（此前只有点空地才关，点物件关不掉）
  if (ctxMenu.value) ctxMenu.value = null
  if (connectCreate.open) closeConnectCreate()
  // 平移意图（空格/中键）：即使落在物件/大 Frame 上也要平移 —— 临时关掉该节点
  // 的 Konva 拖拽防止它抢走指针，抬手后再恢复（drag.panNode 见 onMouseUp）
  if (spaceDown.value || e.evt?.button === 1) {
    if (e.target?.draggable) e.target.draggable(false)
    drag.panNode = e.target || null
    drag.mode = 'pan'
    const st = stageEl.value?.getStage?.()
    const p = st?.getPointerPosition?.()
    if (p) drag.last = { x: p.x, y: p.y }
    if (!spaceDown.value) selection.value = []
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
  // 修复：seg 必须保持 {x1,y1,x2,y2} 形状（此前 ...start/...end 合并成 {x,y}，
  // 预览虚线端点与落空建节点的端点坐标全部变 undefined）
  connectDrag.seg = { x1: start.x, y1: start.y, x2: end.x, y2: end.y }
}
/** connect 松手：落在物件上且非起点/无重复 → 建线（参考 handleConnectEnd） */
function onConnectEnd() {
  if (!connectDrag.active) return
  const { nodeId, handleType, targetId, seg } = connectDrag
  connectDrag.active = false
  connectDrag.seg = null
  connectDrag.targetId = null
  // C：松手落空 → 在端点弹「创建节点」菜单，创建后自动连线
  if (!targetId && seg) {
    const endScreen = worldToScreen(viewport.value, seg.x2, seg.y2)
    connectCreate.open = true
    connectCreate.x = clamp(endScreen.x + 8, 8, Math.max(8, size.w - 180))
    connectCreate.y = clamp(endScreen.y + 8, 8, Math.max(8, size.h - 210))
    connectCreate.wx = seg.x2
    connectCreate.wy = seg.y2
    connectCreate.from = handleType === 'source' ? nodeId : null
    connectCreate.to = handleType === 'target' ? nodeId : null
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
 *  side='to' 拖目标端 → 改接新目标（贴其左缘）。不动端坐标保持，预览从原线重合位置起拖 */
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
  drag.mode = 'reconnect' // 占住拖拽态：阻止平移/物件拖动（onMouseDown 同 connect 跳过）
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
  // 不动端（另一端）坐标保持原样
  const fixed = reconnectDrag.side === 'from' ? { x: seg.x2, y: seg.y2 } : { x: seg.x1, y: seg.y1 }
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
  if (!linkId || !targetId || targetId === fixedId) return // 落空 / 拖到不动端自身 → 取消
  const l = links.value.find((x) => x.id === linkId)
  if (!l) return
  const nextFrom = side === 'from' ? targetId : l.from
  const nextTo = side === 'to' ? targetId : l.to
  if (nextFrom === l.from && nextTo === l.to) return // 拖回原端：无变化
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

// —— 角柄缩放拖拽（stage mousemove/up 驱动；数据实时写回 → 连线/句柄/文本/overlay 同步跟随）——
function onResizeStart(id, corner, kev) {
  stopKonvaEvent(kev)
  if (tool.value === 'crop') return // 裁剪工具态不抢手势
  if (spaceDown.value || kev.evt?.button === 1) return // 平移意图交还
  const o = objects.value.find((x) => x.id === id)
  if (!o || groupOf(id)) return
  const st = stageEl.value.getStage()
  const p = st.getPointerPosition()
  if (!p) return
  resizeDrag.active = true
  resizeDrag.id = id
  resizeDrag.corner = corner
  // 对角不动点（拖 nw → 固定右下角；拖 se → 固定左上角）
  resizeDrag.fixed = {
    x: o.x + (corner.endsWith('w') ? o.width : 0),
    y: o.y + (corner.startsWith('n') ? o.height : 0),
  }
  resizeDrag.orig = { x: o.x, y: o.y, w: o.width, h: o.height }
  resizeDrag.pushed = false
  // 图片/视频默认锁宽高比（Ctrl/⌘ 按住自由）；note/frame/audio 平时自由，
  // Shift 按住临时锁定当前比例（D1c：所有类型都可通过修饰键切换锁/自由）。
  // 视频无 naturalWidth → naturalOf 回落当前 o.width/o.height，即保持起拖前比例
  const baseRatioLocked = o.type === 'image' || o.type === 'video'
  const modifierFree = kev.evt?.ctrlKey || kev.evt?.metaKey
  const modifierLock = kev.evt?.shiftKey
  const lockRatio = modifierFree ? false : baseRatioLocked || modifierLock
  const nat = naturalOf(o)
  const ar = nat.naturalWidth / nat.naturalHeight
  resizeDrag.ratio = lockRatio && isFinite(ar) && ar > 0 ? ar : 0
  // D1c：起始比例快照 —— 拖拽中 Shift 临时锁定用（note/frame 无 natural 尺寸，
  // 不能用 naturalOf 实时算：拖拽中 o.width/height 已变，比例会漂移失控）
  const startAr = isFinite(ar) && ar > 0 ? ar : o.width / o.height
  resizeDrag.startRatio = isFinite(startAr) && startAr > 0 ? startAr : 0
  drag.mode = 'resize' // 占住拖拽态：阻止平移/物件拖动（onMouseDown 同 connect 跳过）
  drag.last = null
}
/** 缩放拖拽中：以固定角为锚 + 指针位置算新矩形，实时写回对象（首次位移才压 undo） */
function onResizeMove() {
  if (!resizeDrag.active) return
  const o = objects.value.find((x) => x.id === resizeDrag.id)
  if (!o) return
  const st = stageEl.value.getStage()
  const p = st.getPointerPosition()
  if (!p) return
  const ptr = screenToWorld(viewport.value, p.x, p.y)
  // D1c：拖拽中实时跟随修饰键（Konva move 事件不透传修饰键，读全局键态）。
  // 比例一律用起拖快照（startRatio），杜绝拖拽中比例漂移
  const baseRatioLocked = o.type === 'image' || o.type === 'video'
  const liveRatio = ctrlDown.value
    ? 0
    : baseRatioLocked || shiftDown.value
      ? resizeDrag.ratio || resizeDrag.startRatio
      : 0
  const { fixed, corner } = resizeDrag
  const ratio = liveRatio
  const rect = ratio ? ratioRect(fixed, ptr, corner, ratio) : freeRect(fixed, ptr, corner)
  if (
    !resizeDrag.pushed &&
    (rect.x !== resizeDrag.orig.x ||
      rect.y !== resizeDrag.orig.y ||
      rect.w !== resizeDrag.orig.w ||
      rect.h !== resizeDrag.orig.h)
  ) {
    beforeChange() // 压栈 = 缩放前状态（仅首次真实位移）
    resizeDrag.pushed = true
  }
  if (!resizeDrag.pushed) return // 点住未拖：数据零改动
  o.x = Math.round(rect.x)
  o.y = Math.round(rect.y)
  o.width = Math.round(rect.w)
  o.height = Math.round(rect.h)
  layerRefresh()
}
/** 自由拉伸矩形（纯函数在 engine.js：南北看首字母，E5fix 修南向坍塌） */
function freeRect(fixed, ptr, corner) {
  return freeResizeRect(fixed, ptr, corner, RESIZE_MIN)
}
/** 等比矩形 / 固定角反推（纯函数在 engine.js，E5fix 南向判定修正） */
function ratioRect(fixed, ptr, corner, ratio) {
  return ratioResizeRect(fixed, ptr, corner, ratio, RESIZE_MIN)
}
/** 缩放松手：收尾（数据已实时写回；窗口外松手由 onWindowMouseUp 兜底） */
function onResizeEnd() {
  if (!resizeDrag.active) return
  resizeDrag.active = false
  resizeDrag.id = null
  resizeDrag.corner = null
  resizeDrag.fixed = null
  resizeDrag.orig = null
  resizeDrag.ratio = 0
  resizeDrag.pushed = false
  drag.mode = null
  drag.last = null
  saveSoon()
}

function onMouseDown(e) {
  if (e.evt?.preventDefault) e.evt.preventDefault() // 平移/框选起手禁文本选择
  // 空地（没点到任何 shape）按下：
  //   普通拖 = 平移画布；Shift/中键 拖 = 框选；crop 工具 = 圈选裁剪
  // 物件按下（onItemDown 先触发，drag.mode='item'）时 stage 级事件直接跳过
  if (
    drag.mode === 'item' ||
    drag.mode === 'connect' ||
    drag.mode === 'reconnect' ||
    drag.mode === 'resize'
  )
    return
  // 兜底：重连拖拽异常残留（未松手/未 Esc）时，点空白即取消
  if (reconnectDrag.active) cancelReconnectDrag()
  const st = stageEl.value.getStage()
  // fix(圈选裁剪无反馈): crop 工具语义是"在图片上圈一块"，但下方
  // `e.target !== st` 会把落在物件上的按下全部 return——图片上起圈
  // 永远走不到 crop 分支，橡皮筋建不起来，用户看不到任何交互效果。
  // crop 态判定提前：空地/物件上一律起圈（物件 Konva 拖拽已被
  // syncDraggables 关闭，不会抢手势）。
  const cropTool = tool.value === 'crop'
  if (e.target !== st && !cropTool) return // 物件由节点拖拽处理
  const p = st.getPointerPosition()
  const w = screenToWorld(viewport.value, p.x, p.y)
  if (cropTool) {
    drag.mode = 'crop'
    drag.last = { x: p.x, y: p.y }
    cropRect.value = { x: w.x, y: w.y, w: 0, h: 0 }
    return
  }
  // 中键 / Shift / Ctrl(⌘) + 拖拽 = 框选（Ctrl 对齐快捷键面板「框选 / 复制节点」文案）
  if (e.evt.button === 1 || e.evt.shiftKey || e.evt.ctrlKey || e.evt.metaKey) {
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
  if (connectCreate.open) closeConnectCreate()
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
    if (id) {
      // 命中物件：立即切换（节点间移动无延迟），撤销待收起
      cancelHoverHide()
      if (id !== hoverNodeId.value) hoverNodeId.value = id
    } else if (!toolbarKeep.value) {
      // 空白：延时收起，给鼠标移入工具栏的时间（间隙已由桥接热区兜住）
      scheduleHoverHide()
    }
  }
  if (drag.mode === 'connect') {
    onConnectMove()
    return
  }
  if (drag.mode === 'reconnect') {
    onReconnectMove()
    return
  }
  if (drag.mode === 'resize') {
    onResizeMove()
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
  // 空格/中键平移时临时禁用了落点物件的 Konva 拖拽，抬手恢复
  if (drag.panNode) {
    drag.panNode.draggable(true)
    drag.panNode = null
  }
  if (drag.mode === 'connect') {
    onConnectEnd()
    drag.mode = null
    drag.last = null
    return
  }
  if (drag.mode === 'reconnect') {
    onReconnectEnd()
    drag.mode = null
    drag.last = null
    return
  }
  if (drag.mode === 'resize') {
    onResizeEnd()
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
let dragStartPos = null // 起拖快照（dragend 组联动增量基准；数据已实时写回，不能用拖后值）
/** Ctrl/⌘/Alt+拖拽克隆手势：dragstart 时置位。记录被拖原件的 id、起拖坐标与克隆 id。
 *  视觉策略：克隆体先以同坐标落布（留在原地=原版），原 Konva 节点继续被拖走
 *  （=克隆体），dragend 时把数据身份与位置对齐（原版留起点、克隆归终点）。 */
const dragClone = reactive({ armed: false, origId: null, cloneId: null, start: { x: 0, y: 0 } })
/** dragstart 快照：记录起拖原位（Konva dragmove 首帧节点可能已大幅位移，
 *  组联动增量必须以 dragstart 位置为基准） */
function onNodeDragStartSnap(e) {
  dragStartPos = { id: e.target.id(), x: e.target.x(), y: e.target.y() }
}

function onNodeDrag(e) {
  // 物件拖拽中的吸附（e 为 Konva 原生事件对象）
  e.evt?.preventDefault?.() // 抑制拖拽中浏览器原生文本选择
  const node = e.target
  if (!dragRecorded && !dragClone.armed) {
    beforeChange()
    dragRecorded = true
  }
  const idx = objects.value.findIndex((o) => o.id === node.id())
  if (idx < 0) return
  const o = objects.value[idx]
  // 实时写回数据坐标：连线端点/句柄/锚点/HTML 浮层（工具栏、参考条）随拖
  // 拽实时跟随，而非 dragend 才更新（原实现数据 lag 一拍）
  o.x = node.x()
  o.y = node.y()
  // fix(媒体双影): video/audio 的 HTML overlay 走 Vue 调度（晚 Konva 同步
  // transform 一拍），拖动中 Konva 占位框与播放器卡错位成"两个区块"。
  // 拖动帧内直写 overlay 的 left/top，与 Konva 同帧对齐；dragend 后 Vue
  // 重渲染接管（style 绑定重算，数值一致无跳变）。
  if (o.type === 'video' || o.type === 'audio') {
    const el = wrapEl.value?.querySelector?.('[data-media-overlay="' + o.id + '"]')
    if (el) {
      const tl = worldToScreen(viewport.value, o.x, o.y)
      el.style.left = tl.x + 'px'
      el.style.top = tl.y + 'px'
    }
  }
  const others = objects.value.filter((_, i) => i !== idx)
  if (!others.length) return
  const moving = { x: node.x(), y: node.y(), width: o.width, height: o.height }
  const delta = snapDelta(moving, others, SNAP_THRESHOLD)
  guides.v = snapGuides(moving, others, SNAP_THRESHOLD).v
  guides.h = snapGuides(moving, others, SNAP_THRESHOLD).h
  if (delta.dx || delta.dy) {
    node.x(node.x() + delta.dx)
    node.y(node.y() + delta.dy)
    o.x = node.x()
    o.y = node.y()
  }
}

function onNodeDragEnd(e) {
  dragRecorded = false
  const startPos = dragStartPos
  dragStartPos = null
  guides.v = []
  guides.h = []
  const o = objects.value.find((x) => x.id === e.target.id())
  if (o) {
    // 组联动：数据已实时写回，以起拖快照为基准算增量（否则恒 0，组联动失效）
    const g = groups.value.find((gr) => gr.members.includes(o.id))
    const oldX = startPos?.id === o.id ? startPos.x : o.x
    const oldY = startPos?.id === o.id ? startPos.y : o.y
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

// —— Ctrl/⌘/Alt+拖拽克隆（dragstart 建副本，dragend 对齐身份与坐标；组合成员不支持，走普通拖拽）——
function onNodeCloneStart(e) {
  const key = e.evt?.ctrlKey || e.evt?.metaKey || e.evt?.altKey
  if (!key || dragClone.armed) return
  const i = objects.value.findIndex((o) => o.id === e.target.id())
  if (i < 0) return
  const o = objects.value[i]
  if (!o || groupOf(o.id)) return // 组拖动会整体迁移成员，克隆语义复杂，退回普通拖拽
  beforeChange() // 快照 = 克隆前状态（dragmove 因 armed 不再重复压栈）
  const nid = 'n' + Date.now() + Math.random().toString(36).slice(2, 6)
  objects.value.push({ ...JSON.parse(JSON.stringify(o)), id: nid })
  dragClone.armed = true
  dragClone.origId = o.id
  dragClone.cloneId = nid
  dragClone.start = { x: o.x, y: o.y }
}
function commitCloneDrag(e) {
  if (!dragClone.armed) return
  const { armed, origId, cloneId, start } = dragClone
  dragClone.armed = false
  dragClone.origId = null
  dragClone.cloneId = null
  const end = { x: e.target.x(), y: e.target.y() }
  const st = stageEl.value?.getStage?.()
  const orig = objects.value.find((x) => x.id === origId)
  const clone = objects.value.find((x) => x.id === cloneId)
  if (orig) {
    // 原版留在起点（onNodeDragEnd 已把数据写成终点，这里纠正回起点 + 复位 Konva 节点）
    orig.x = start.x
    orig.y = start.y
  }
  const origNode = st?.findOne('#' + CSS.escape(origId))
  if (origNode && orig) {
    origNode.position({ x: orig.x, y: orig.y })
  }
  if (clone) {
    clone.x = end.x
    clone.y = end.y
  }
  if (orig && clone) {
    selection.value = [clone.id]
    // 组联动数据可能已按拖拽增量移动过成员；克隆场景不回滚（克隆前已阻止组内触发），此处无需处理
  } else if (clone) {
    // 原版数据异常（不应发生）：克隆体落终点并选中
    selection.value = [clone.id]
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
    icon: 'fas fa-table-cells-large',
    title: t('canvasLayersBtn'),
    action: () => (layersOpen.value = !layersOpen.value),
    active: layersOpen.value,
  },
  {
    icon: 'fas fa-photo-film',
    title: t('canvasAssetsBtn'),
    action: () => (assetsOpen.value = !assetsOpen.value),
    active: assetsOpen.value,
  },
  {
    icon: 'fas fa-wand-magic-sparkles',
    title: t('canvasGenNode'),
    action: () => openGenNode(selection.value),
  },
  {
    icon: 'fas fa-vector-square',
    title: t('canvasCropToolTip'),
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
  {
    icon: 'fas fa-book-open',
    title: t('canvasPromptLibBtn'),
    action: () => (promptLib.open = !promptLib.open),
  },
  { icon: 'fas fa-file-export', title: t('canvasExportBtn'), action: exportCurrentProject },
  { icon: 'fas fa-file-import', title: t('canvasImportBtn'), action: pickImportFile },
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
    const filename = u.searchParams.get('filename') || ''
    return {
      filename,
      subfolder: u.searchParams.get('subfolder') || '',
      type: u.searchParams.get('type') || 'output',
      // A1(吸收参考项目引用注入):附件携带画布卡片身份,工作台发送时拼引用清单
      // 注入 prompt——LLM 看图即知"这是画布上哪张卡片",对话可 @cardId 指代
      cardId: id,
      cardTitle: o.name || filename || 'image',
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
  const id = 'n' + Date.now()
  objects.value.push({
    id,
    type: 'note',
    x: c.x - 90,
    y: c.y - 60,
    width: 180,
    height: 120,
    text: '',
  })
  saveSoon()
  startNoteEdit(id) // 新建即进入编辑，免去「不知道怎么输入」的困惑
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
  const imgWithMeta = ids.some((id) => (objects.value.find((o) => o.id === id) || {}).meta?.prompt)
  const appIds = ids.filter((id) => (objects.value.find((o) => o.id === id) || {}).type === 'app')
  const noteIds = ids.filter((id) => (objects.value.find((o) => o.id === id) || {}).type === 'note')
  const frameIds = ids.filter(
    (id) => (objects.value.find((o) => o.id === id) || {}).type === 'frame',
  )
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
  if (noteIds.length === 1) {
    items.push({
      key: 'note-edit',
      icon: 'fa-pen',
      label: t('canvasMenuEditNote'),
      run: () => {
        startNoteEdit(noteIds[0])
        closeCtxMenu()
      },
    })
  }
  if (frameIds.length === 1) {
    items.push({
      key: 'frame-rename',
      icon: 'fa-pen',
      label: t('canvasRenameFrame'),
      run: () => {
        startFrameRename(frameIds[0])
        closeCtxMenu()
      },
    })
  }
  if (imgWithMeta) {
    items.push({
      key: 'gen-info',
      icon: 'fa-circle-info',
      label: t('canvasGenInfoTitle'),
      run: () => {
        showImageGenInfo(ids[0])
        closeCtxMenu()
      },
    })
  }
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
          openMaskDialog(ids[0])
          closeCtxMenu()
        },
      },
      { key: 'sep-ai', sep: true },
      {
        key: 'ai-group',
        icon: 'fa-wand-magic-sparkles',
        label: t('canvasMenuAiGroup'),
        children: [
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
        ],
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
  // P2: export selection zip when images picked
  if (ids.some((id) => objects.value.find((o) => o.id === id)?.type === 'image')) {
    items.push({
      key: 'exportSel',
      icon: 'fa-file-zipper',
      label: t('canvasExportSelBtn'),
      run: () => {
        exportSelectionZip()
        closeCtxMenu()
      },
    })
  }
  // P2: grid-arrange when 2+ images picked
  const imgIds = ids.filter((id) => objects.value.find((o) => o.id === id)?.type === 'image')
  if (imgIds.length >= 2) {
    items.push({
      key: 'gridImg',
      icon: 'fa-table-cells',
      label: t('canvasGridBtn'),
      run: () => {
        gridArrangeSelected()
        closeCtxMenu()
      },
    })
  }
  if (ids.length >= 2) {
    items.push(
      {
        key: 'alignL',
        icon: 'fa-align-left',
        label: t('canvasAlignLeft'),
        run: () => {
          alignSel('left')
          closeCtxMenu()
        },
      },
      {
        key: 'alignH',
        icon: 'fa-align-center',
        label: t('canvasAlignHCenter'),
        run: () => {
          alignSel('hcenter')
          closeCtxMenu()
        },
      },
      {
        key: 'alignR',
        icon: 'fa-align-right',
        label: t('canvasAlignRight'),
        run: () => {
          alignSel('right')
          closeCtxMenu()
        },
      },
      {
        key: 'alignT',
        icon: 'fa-arrow-up-long',
        label: t('canvasAlignTop'),
        run: () => {
          alignSel('top')
          closeCtxMenu()
        },
      },
      {
        key: 'alignV',
        icon: 'fa-arrows-up-down',
        label: t('canvasAlignVCenter'),
        run: () => {
          alignSel('vcenter')
          closeCtxMenu()
        },
      },
      {
        key: 'alignB',
        icon: 'fa-arrow-down-long',
        label: t('canvasAlignBottom'),
        run: () => {
          alignSel('bottom')
          closeCtxMenu()
        },
      },
    )
  }
  if (ids.length >= 3) {
    items.push(
      {
        key: 'distH',
        icon: 'fa-arrows-left-right-to-line',
        label: t('canvasDistH'),
        run: () => {
          distributeSel('x')
          closeCtxMenu()
        },
      },
      {
        key: 'distV',
        icon: 'fa-arrows-up-down-up-down-line',
        label: t('canvasDistV'),
        run: () => {
          distributeSel('y')
          closeCtxMenu()
        },
      },
    )
  }
  items.push(
    {
      key: 'front',
      icon: 'fa-layer-group',
      label: t('canvasMenuFront'),
      run: () => {
        zShift(ids, 'front')
        closeCtxMenu()
      },
    },
    {
      key: 'forward',
      icon: 'fa-arrow-up',
      label: t('canvasMenuForward'),
      run: () => {
        zShift(ids, 'forward')
        closeCtxMenu()
      },
    },
    {
      key: 'backward',
      icon: 'fa-arrow-down',
      label: t('canvasMenuBackward'),
      run: () => {
        zShift(ids, 'backward')
        closeCtxMenu()
      },
    },
    {
      key: 'back',
      icon: 'fa-layer-group',
      label: t('canvasMenuBack'),
      run: () => {
        zShift(ids, 'back')
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
/**
 * z 层级四向（front/forward/backward/back），选中块整体移动保持内部顺序。
 * P3 undo 合并：同选中集连续同向 shift 在 800ms 窗口内合并一条历史。
 */
let zCoalesce = null // { key, dir, until }
function zShift(ids, dir) {
  const now = Date.now()
  const key = [...ids].sort().join(',')
  const canMerge =
    zCoalesce && zCoalesce.key === key && zCoalesce.dir === dir && now < zCoalesce.until
  if (!canMerge) {
    beforeChange()
    zCoalesce = { key, dir, until: now + 800 }
  } else {
    zCoalesce.until = now + 800
  }
  objects.value = zShiftObjects(objects.value, ids, dir)
  saveSoon()
}
/** 批量图片分组（P2）：选中 image 统一格宽网格重排 + 自动成组 */
function gridArrangeSelected() {
  const imgs = objects.value.filter((o) => selection.value.includes(o.id) && o.type === 'image')
  if (imgs.length < 2) {
    message.warning(t('canvasGridNeedImages'))
    return
  }
  // 落点：当前选中包围盒左上角
  const b = bboxOf(imgs)
  const moves = gridArrangeImages(
    objects.value,
    imgs.map((o) => o.id),
    {
      originX: Math.round(b.x),
      originY: Math.round(b.y),
      cellW: 260,
      cols: Math.min(3, Math.ceil(Math.sqrt(imgs.length)) || 1),
    },
  )
  if (!moves.size) return
  beforeChange()
  for (const [id, pos] of moves) {
    const o = objects.value.find((x) => x.id === id)
    if (o) Object.assign(o, pos)
  }
  // 自动成组（已在组里的先移除，再统一入新组）
  const members = imgs.map((o) => o.id)
  groups.value = groups.value
    .map((g) => ({ ...g, members: g.members.filter((m) => !members.includes(m)) }))
    .filter((g) => g.members.length > 1)
  groups.value.push({ id: 'g' + Date.now(), members })
  message.success(t('canvasGridArranged').replace('{n}', String(members.length)))
  saveSoon()
}

/** 多选对齐（左/右/上/下/水平居中/垂直居中）：应用坐标映射 */
function alignSel(mode) {
  if (selection.value.length < 2) return
  const moves = alignObjects(objects.value, selection.value, mode)
  if (!moves.size) return
  beforeChange()
  for (const [id, pos] of moves) {
    const o = objects.value.find((x) => x.id === id)
    if (o) Object.assign(o, pos)
  }
  saveSoon()
}
/** 多选等距分布（水平/垂直），≥3 个物件生效 */
function distributeSel(axis) {
  if (selection.value.length < 3) return
  const moves = distributeObjects(objects.value, selection.value, axis)
  if (!moves.size) return
  beforeChange()
  for (const [id, pos] of moves) {
    const o = objects.value.find((x) => x.id === id)
    if (o) Object.assign(o, pos)
  }
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
  const id = 'n' + Date.now()
  objects.value.push({
    id,
    type: 'note',
    x: wx - 90,
    y: wy - 60,
    width: 180,
    height: 120,
    text: '',
  })
  closeCtxMenu()
  saveSoon()
  startNoteEdit(id) // 新建即进入编辑
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
// —— S5a note→生图自动编排（参考 config-node 流）：生图按钮 → 选 app →
// 右侧建 App 节点 + note→app 连线 + 立即运行（note 文本自动填 text 槽） ——
const genFromNote = ref(null) // {noteId} 待选 app 的编排请求
function startGenerateFromNote(noteId) {
  const note = objects.value.find((o) => o.id === noteId)
  if (!note || note.type !== 'note') return
  if (!String(note.text || '').trim()) {
    message.warning(t('canvasGenNeedText'))
    return
  }
  const src = objects.value.find((o) => o.id === noteId)
  genFromNote.value = { noteId }
  // picker 定位到 note 右侧（App 节点将落的位置）
  const wx = src.x + src.width + 80
  const wy = src.y
  const sc = worldToScreen(viewport.value, wx, wy)
  appPicker.wx = wx
  appPicker.wy = wy
  appPicker.open = true
}
/** picker 选中后：若在编排流中，建节点+连线+自动运行 */
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
  // 立即运行（collectUpstream 沿新连线吃到 note 文本）
  nextTick(() => runAppNode(node.id))
}

// —— S5b note AI 改写流（参考 text-node 对话框）：有内容 note → 输入改写
// 指令 → 右侧生成新 note 并自动连线（原 note 保留） ——
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
    x: clamp(tl.x, 8, Math.max(8, size.w - 380)),
    y: clamp(tl.y + o.height * viewport.value.scale + 8, 8, size.h - 60),
  }
})
async function runNoteRewrite() {
  const src = objects.value.find((x) => x.id === noteRewrite.noteId)
  const instruction = noteRewrite.instruction.trim()
  if (!src || noteRewrite.running || !instruction || !String(src.text || '').trim()) return
  noteRewrite.running = true
  try {
    const composed = `${t('canvasRewriteCompose').replace('{i}', instruction)}\n\n${src.text}`
    const res = await fetch(`${serverOrigin.value}/api/optimize-prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: composed,
        language: 'zh',
        api_key: appStore.config?.api_key || undefined,
        base_url: appStore.config?.base_url || undefined,
        model: appStore.config?.model || undefined,
      }),
    })
    const j = await res.json().catch(() => null)
    const out = j?.data?.optimizedPrompt || j?.optimizedPrompt || ''
    if (!res.ok || !out) throw new Error(j?.message || `HTTP ${res.status}`)
    // 右侧新 note + 连线（原节点保留）
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

// —— B2 图→提示词溯源：复制生成提示词 / 查看生成信息 ——
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
    // 剪贴板被拒（如非聚焦窗口）：降级弹可复制层
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

// —— A1 视频截帧：抓首/末/当前帧 → 新图片节点 + 溯源连线 ——
async function captureVideoFrameAt(id, position) {
  const o = objects.value.find((x) => x.id === id)
  if (!o || o.type !== 'video' || !o.src) return
  // 找 overlay 里正在播的 video 元素拿 currentTime；没有则 0
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
    const t = videoFrameTime(position, video.duration, ct)
    if (t > 0) {
      const seeked = waitEvent('seeked')
      video.currentTime = t
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

// —— A2 任意角度旋转 + 翻转（angle 对话框） ——
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
  // 任意角度：pad 18% 容纳旋转后画布（参考 transformAngleDataUrl）
  const pad = Math.round(Math.max(iw, ih) * 0.18)
  const cv = document.createElement('canvas')
  cv.width = iw + pad * 2
  cv.height = ih + pad * 2
  const ctx = cv.getContext('2d')
  ctx.translate(cv.width / 2, cv.height / 2)
  ctx.rotate((Number(deg) * Math.PI) / 180)
  ctx.scale(flipH ? -1 : 1, flipV ? -1 : 1)
  ctx.drawImage(img, -iw / 2, -ih / 2)
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

// —— A3 无损放大（长边重采样，步进放大保平滑） ——
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
  // 步进放大（每步 ≤2x，参考 drawStepUpscale）防一步到位的锯齿
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
    cv.getContext('2d').imageSmoothingEnabled = true
    cv.getContext('2d').imageSmoothingQuality = 'high'
    cv.getContext('2d').drawImage(src, 0, 0, cv.width, cv.height)
    src = cv
  }
  const out = src
  out.toBlob((blob) => {
    if (!blob) return
    const url = URL.createObjectURL(blob)
    beforeChange()
    o.src = url
    // 显示尺寸维持（像素翻倍但画布上大小不变）
    persistImage(o)
    saveSoon()
    message.success(
      t('canvasUpscaleDone').replace('{w}', String(sz.width)).replace('{h}', String(sz.height)),
    )
  }, 'image/png')
}

// —— 提示词库（S6b）：内置分词 + 自定义（localStorage）+ JSON 导入 ——
const promptLib = reactive({ open: false, q: '', tab: 'builtin' }) // tab: builtin | custom
const customPrompts = ref([])
try {
  customPrompts.value = loadCustomPrompts(localStorage)
} catch {
  customPrompts.value = []
}
const promptLibView = computed(() => {
  if (promptLib.tab === 'custom') {
    return searchPrompts(
      [{ category: t('canvasPromptCustomTab'), items: customPrompts.value }],
      promptLib.q,
    )
  }
  return searchPrompts(builtinLibrary(), promptLib.q)
})
/** 选中词条 → 回填目标（note 编辑/改写指令，按当前激活输入） */
function applyPrompt(text) {
  const target = promptTarget.value
  if (target?.kind === 'note') {
    const o = objects.value.find((x) => x.id === target.id)
    if (o) {
      beforeChange()
      o.text = o.text ? o.text + '\n' + text : text
      // 正在就地编辑同一便签时，把回填同步进编辑框（否则提交会覆盖掉刚插的词条）
      if (noteEdit.id === target.id) noteEdit.text = o.text
      saveSoon()
    }
  } else if (target?.kind === 'rewrite') {
    noteRewrite.instruction = noteRewrite.instruction ? noteRewrite.instruction + '；' + text : text
  } else if (target?.kind === 'gen' && genNode.value) {
    genNode.value.prompt = genNode.value.prompt ? genNode.value.prompt + '\n' + text : text
  } else {
    // fix(静默无操作): 无回填目标时点击词条此前什么都不发生——改为复制到
    // 剪贴板 + toast，用户至少拿到词条内容（选中笔记/开生图对话框后回填）。
    try {
      navigator.clipboard.writeText(text)
      message.info(t('canvasPromptCopied'))
    } catch {
      /* 剪贴板不可用（权限/非安全上下文）——只关面板 */
    }
  }
  promptLib.open = false
}
/** 回填目标推导：生图对话框开着优先，其次改写输入条，再次选中/悬停的 note */
const promptTarget = computed(() => {
  if (genNode.value) return { kind: 'gen', id: null }
  if (noteRewrite.noteId) return { kind: 'rewrite', id: noteRewrite.noteId }
  const selNote = objects.value.find((o) => o.id === selection.value[0] && o.type === 'note')
  if (selNote) return { kind: 'note', id: selNote.id }
  const hovNote = objects.value.find((o) => o.id === hoverNodeId.value && o.type === 'note')
  if (hovNote) return { kind: 'note', id: hovNote.id }
  return null
})
function addCustomPrompt(text) {
  const t = String(text || '').trim()
  if (!t) return
  customPrompts.value = [{ text: t, hint: '' }, ...customPrompts.value]
  saveCustomPrompts(customPrompts.value, localStorage)
}
function removeCustomPrompt(text) {
  customPrompts.value = customPrompts.value.filter((x) => x.text !== text)
  saveCustomPrompts(customPrompts.value, localStorage)
}
function importPromptsFile() {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = '.json,application/json'
  input.onchange = () => {
    const f = input.files?.[0]
    if (!f) return
    f.text()
      .then(parseImportedPrompts)
      .then((list) => {
        customPrompts.value = mergePrompts(list, customPrompts.value)
        saveCustomPrompts(customPrompts.value, localStorage)
        message.success(t('canvasPromptImported').replace('{n}', String(list.length)))
      })
      .catch((e) => message.error(t('canvasPromptImportFailed') + ': ' + (e?.message || '')))
  }
  input.click()
}

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
  lastSourceIds = g.refs.map((r) => r.__id || '').filter(Boolean)
  // refs 是附件形态 {filename,...}；按物件 id 反查溯源
  emitPrompt(g.prompt, { autoSend: true, attachments: g.refs })
  genNode.value = null
  message.success(t('canvasSelPromptSent'))
}

// —— A1 画布内 inpaint / A2 扩图 / A9 增强 / A7 反推 / A4 视频 / A10 一致性 ——
// 这些动作都收敛为「把指令+目标附件发工作台执行」，产物经 onResult 自动落布+溯源。
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
const frameObjects = computed(() => withCull((o) => o.type === 'frame'))
function frameConfig(o) {
  // fix: rect 在 group 内须用相对坐标（group 已定位 o.x/o.y）；id 由 group 承载
  // （rect 再带同 id 会与 group 重复，findOne 命中 rect 而非 group）
  // fix(选中无反馈): 同 shotRectConfig——补选中态分支（accent 实线盖虚线）
  const sel = selection.value.includes(o.id)
  return {
    width: o.width,
    height: o.height,
    fill: 'rgba(99,102,241,0.05)',
    stroke: sel ? accentColor() : 'rgba(129,140,248,0.5)',
    strokeWidth: sel ? 2 : 1.5,
    ...(sel ? {} : { dash: [8, 6] }),
    cornerRadius: 10,
  }
}
function frameLabelConfig(o) {
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
  return {
    text: o.name || 'Frame',
    // 局部坐标（group 已定位在 o.x/o.y；此前误用绝对坐标 o.x/o.y-20 导致标签双重偏移）
    x: 10,
    y: -22,
    width: Math.max(40, o.width - 20),
    fontSize: 13,
    fill: '#818cf8',
    align: 'left',
    listening: false,
  }
}
function shotRectConfig(o) {
  // fix(选中无反馈): 此前无选中态分支——selection 已设置但卡片外观零变化,
  // 用户感知"点不中/只能 hover"。沿用 highlightStroke 统一模式(选中=accent 2px)。
  return {
    width: o.width,
    height: o.height,
    fill: 'rgba(20,184,166,0.08)',
    ...highlightStroke(o, o.src ? 'rgba(45,212,191,0.7)' : 'rgba(20,184,166,0.45)'),
    strokeWidth: selection.value.includes(o.id) ? 2 : 1.5,
    cornerRadius: 8,
  }
}
function shotSeqConfig(o) {
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
  return {
    text: `#${o.seq || 1}`,
    x: 8,
    y: 6,
    fontSize: 12,
    fontStyle: 'bold',
    fill: '#2dd4bf',
    listening: false,
  }
}
function shotTextConfig(o) {
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
  return {
    text: o.text || '',
    x: 8,
    y: 24,
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
  withCull((o) => o.type === 'shot').sort((a, b) => (a.seq || 0) - (b.seq || 0)),
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
  if (ctxMenu.value) ctxMenu.value = null
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
  if (reconnectDrag.active) cancelReconnectDrag()
  if (ctxMenu.value) ctxMenu.value = null
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
const appNodeObjects = computed(() => withCull((o) => o.type === 'app'))

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
  const pendingLink = connectCreate.pickLink || null
  connectCreate.pickLink = null
  // picker 的 app 已带完整 template —— 立即入缓存（面板字段即时渲染）
  appCache.set(app.id, app)
  appCacheVer.value++
  beforeChange()
  const node = makeAppNode(app.id, app.name, appPicker.wx, appPicker.wy)
  objects.value.push(node)
  if (pendingLink) linkFromConnect(node.id, pendingLink.from, pendingLink.to)
  selection.value = [node.id]
  saveSoon()
  // 拾取即展开参数面板
  nextTick(() => openAppNodePanel(node.id))
  // S5a 编排流：note 生图 → 连线 + 自动运行（不展开面板避免遮挡）
  if (genFromNote.value) {
    appPanel.id = null
    maybeRunGenFromNote(node)
  }
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
  // B1 产物溯源：记录本次运行的 resolved 文本 + app 名（产物落布时写入图元数据）
  const promptTexts = []
  for (const w of Object.values(overrides)) {
    for (const v of Object.values(w)) {
      if (typeof v === 'string' && v.trim()) promptTexts.push(v.trim())
    }
  }
  node.lastRun = {
    promptId: null,
    at: Date.now(),
    appLabel: app.name || node.name || node.appId,
    promptText: promptTexts.join('\n').slice(0, 2000) || null,
  }
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
    node.lastRun = { ...node.lastRun, promptId, at: Date.now() }
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
    const genMeta = node.lastRun
      ? {
          app: node.lastRun.appLabel || null,
          prompt: node.lastRun.promptText || null,
          at: node.lastRun.at || Date.now(),
        }
      : null
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
        meta: genMeta ? { ...genMeta } : undefined,
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
    stroke: sel || isHighlightedOf(o) ? APP_CARD.activeStroke : APP_CARD.stroke,
    strokeWidth: sel ? 2 : 2,
    cornerRadius: 24, // rounded-3xl
    shadowColor: sel ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.25)',
    shadowBlur: sel ? 48 : 18, // 选中态 0 18px 48px（参考 isRelated 投影）
    shadowOffset: { x: 0, y: sel ? 18 : 6 },
    shadowOpacity: 0.6,
  }
}
function appNodeTitleConfig(o) {
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
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
  if (!lodTextVisible(viewport.value.scale)) return { visible: false, listening: false }
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
      node.params = { ...node.params, ...op.params }
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
      node.params = { ...node.params, ...patch.params }
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
    // 选区项结构化:LLM 工具读 digest 时可寻址(后续 wb_canvas_ops/get_state
    // 接入摘要注入的前置;UI 感知条用 label 拼单行)。app 节点 status 单独
    // 通过 queue.running 展示,不重复进 label。
    selection: selection.value
      .map((id) => {
        const o = objects.value.find((x) => x.id === id)
        if (!o) return null
        const size = o.width && o.height ? `${o.width}×${o.height}` : null
        if (o.type === 'app') {
          return { id, kind: 'app', label: o.name || o.appId || 'app', status: o.status || 'idle' }
        }
        if (o.type === 'image') {
          let label = 'image'
          try {
            if (o.src) {
              const u = new URL(o.src)
              label =
                u.searchParams.get('filename') ||
                decodeURIComponent(u.pathname.split('/').pop() || '') ||
                label
            }
          } catch {
            /* blob:/data: 等 fallback 'image' */
          }
          return { id, kind: 'image', label, size }
        }
        if (o.type === 'note') {
          const t = (o.text || '').replace(/\s+/g, ' ').slice(0, 24)
          return { id, kind: 'note', label: t || 'note' }
        }
        return { id, kind: o.type, label: o.name || o.type, size }
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
    // D2：A 画布标记 + 全量物件可寻址清单（wb_canvas_ops 寻址：真实物件 id）
    surface: 'a-canvas',
    links: links.value.length,
    objects: objects.value.map((o) => {
      let label = o.name || o.type
      if (o.type === 'image') {
        // /view 引用取 filename；blob:/data: 无可读名 → 「图片 #id尾」
        label = o.name || ''
        if (!label && o.src && o.src.startsWith('http')) {
          try {
            const u = new URL(o.src)
            label =
              u.searchParams.get('filename') ||
              decodeURIComponent(u.pathname.split('/').pop() || '') ||
              ''
          } catch {
            /* 异常 URL 保持空 */
          }
        }
        if (!label) label = '图片 #' + String(o.id).slice(-4)
      } else if (o.type === 'note') {
        label = (o.text || '').replace(/\s+/g, ' ').slice(0, 24) || 'note'
      }
      const size = o.width && o.height ? `${o.width}×${o.height}` : undefined
      return { id: o.id, kind: o.type, label: label.slice(0, 40), size }
    }),
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
    // D2：digest 除总线推 UI 外，同步 POST 服务端 snapshot（AI 决策层
    // fetchCanvasState 读 /api/canvas/state —— 不落服务端 AI 看不到 A 画布）
    const d = { ...canvasDigest.value, seq: ++canvasSeq }
    emitCanvasState(d)
    pushDigestSnapshot(d)
  },
  { deep: false },
)
/** digest → 服务端（节流 2s；内容序列化一致时跳过；失败静默重试下轮） */
let digestSnapLast = ''
let digestSnapTimer = 0
// fix(404 刷屏): 旧版 server（或路由未挂）对 /api/canvas/snapshot 回 404 时，
// Chromium 每次请求都往控制台打一条黄色 Failed to load resource——digest
// 一变就 POST，控制台被 404 淹没。失败（网络错/非 2xx）后冷却 60s，
// 期间不重试；成功才恢复常态推送。
let digestSnapCooldownUntil = 0
function pushDigestSnapshot(d) {
  clearTimeout(digestSnapTimer)
  digestSnapTimer = setTimeout(() => {
    if (Date.now() < digestSnapCooldownUntil) return
    // fix(推送风暴): digest 含 ts:Date.now()，任何重算 JSON 必变——去重
    // 形同虚设，每次 watch 触发都 POST。去重时剥离 ts（服务端不需要）。
    const { ts: _ts, ...rest } = d
    const json = JSON.stringify(rest)
    if (json === digestSnapLast) return
    digestSnapLast = json
    // A 画布页无注入桥全局：主窗 3008 同源代理 API server（ComfyUI iframe
    // 侧才用 __ARTIFY_LAB_API__）；都取不到时放弃本轮（下轮重试）
    const api = window.__ARTIFY_LAB_API__ || window.location.origin
    void fetch(`${api}/api/canvas/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: json,
    })
      .then((r) => {
        if (!r.ok) digestSnapCooldownUntil = Date.now() + 60_000
      })
      .catch(() => {
        digestSnapCooldownUntil = Date.now() + 60_000
      })
  }, 2000)
}

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

// —— 持久化（localStorage 防抖 500ms）——
let saveTimer = null
function saveSoon() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(saveNow, 500)
}
function saveNow() {
  // 项目集为唯一事实源；旧 key 继续双写（迁移兼容，外部工具可读）
  syncActiveDocToStore()
  persistProjects()
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
  // S1 起以项目集为准（bootProjects 已迁移并装载 activeProject）
  if (activeProject.value) {
    loadProjectIntoCanvas()
    return
  }
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
    if (selectedLinkId.value) {
      // 连线与物件选中互斥，这里单独收（此前 Delete 对连线失效）
      e.preventDefault()
      deleteSelectedLink()
    } else if (selection.value.length) {
      e.preventDefault()
      deleteSelected()
    }
  } else if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
    // Ctrl+A 全选画布物件（编辑态保留浏览器默认全选文本）
    if (inEditor) return
    e.preventDefault()
    if (ctxMenu.value) ctxMenu.value = null
    if (connectCreate.open) closeConnectCreate()
    selection.value = objects.value.map((o) => o.id)
    selectedLinkId.value = null
  } else if (e.code === 'Space' && !e.repeat) {
    spaceDown.value = true
    if (!inEditor) e.preventDefault()
  } else if (e.key === '?' || (e.shiftKey && e.key === '/')) {
    if (inEditor) return
    shortcutsOpen.value = !shortcutsOpen.value
  } else if (e.key === 'Escape') {
    if (reconnectDrag.active) {
      // 重连拖拽中：取消本次拖拽，保留连线选中（锚点仍可再拖）
      e.preventDefault()
      cancelReconnectDrag()
      drag.mode = null
      drag.last = null
    } else if (ctxMenu.value) {
      ctxMenu.value = null
    } else if (shortcutsOpen.value) {
      shortcutsOpen.value = false
    } else if (tool.value) {
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

// —— 图片落画布：文件拖入 + 剪贴板粘贴 ——
// —— 节点悬浮工具栏（S4a）：悬停物件上方快捷动作条 ——
/** 工具栏“停留”保护：鼠标移入工具栏本身时不算离开节点（参考 onKeep/onLeave） */
const toolbarKeep = ref(false)
/**
 * 悬停收起延迟：鼠标移出节点后延时再清 hoverNodeId，途中移入工具栏可取消。
 * 原逻辑为 mousemove 命中空白即立刻清空，鼠标从节点走向工具栏必然途经
 * 10px 间隙（工具栏 y = 节点顶 - 10），工具栏先于鼠标到达而消失 —— 表现为
 * “菜单无法停留”。延迟 + 桥接热区共同解决。
 */
const HOVER_HIDE_DELAY = 220
let hoverHideTimer = null
function cancelHoverHide() {
  if (hoverHideTimer) {
    clearTimeout(hoverHideTimer)
    hoverHideTimer = null
  }
}
/** 排一次收起；delay<=0 为立即（如指针移出整个画布区）。同时复位 toolbarKeep，
 *  避免工具栏被 v-if 摘掉后 mouseleave 不触发、toolbarKeep 残留 true 卡住后续悬停 */
function scheduleHoverHide(delay = HOVER_HIDE_DELAY) {
  cancelHoverHide()
  const hide = () => {
    hoverHideTimer = null
    toolbarKeep.value = false
    hoverNodeId.value = null
  }
  if (delay > 0) hoverHideTimer = setTimeout(hide, delay)
  else hide()
}
/** 鼠标进出工具栏：进 = 钉住（取消待收起），出 = 延时收起 */
function keepToolbar(on) {
  toolbarKeep.value = on
  if (on) cancelHoverHide()
  else scheduleHoverHide()
}
/**
 * 字号微调（P3 undo 合并）：同 note 连续 bump 在 800ms 窗口内合并为一条
 * 历史——undo 一步回到连续微调前，而非每 ±1px 一条。
 * coalesce 窗口过期后新起一条。属性/对象变了也新起一条。
 */
let bumpCoalesce = null // { id, dir, until }
function nodeBumpFont(id, delta) {
  const o = objects.value.find((x) => x.id === id)
  if (!o || o.type !== 'note') return
  const now = Date.now()
  const canMerge =
    bumpCoalesce &&
    bumpCoalesce.id === id &&
    bumpCoalesce.dir === (delta > 0 ? 1 : -1) &&
    now < bumpCoalesce.until
  if (!canMerge) {
    beforeChange()
    bumpCoalesce = { id, dir: delta > 0 ? 1 : -1, until: now + 800 }
  } else {
    bumpCoalesce.until = now + 800 // 仍在窗口内：续窗
  }
  o.fontSize = clamp((o.fontSize || 13) + delta, 9, 48)
  saveSoon()
}
function nodeDownloadImage(id) {
  const o = objects.value.find((x) => x.id === id)
  if (!o) return
  const url = o.persist || o.src
  if (!url) return
  fetch(url)
    .then((r) => r.blob())
    .then((b) => {
      const u = URL.createObjectURL(b)
      const a = document.createElement('a')
      a.href = u
      a.download = `canvas-${o.id}.png`
      a.click()
      setTimeout(() => URL.revokeObjectURL(u), 5000)
    })
    .catch(() => message.error(t('canvasDownloadFailed')))
}
function nodeCopyObj(id) {
  selection.value = [id]
  copySelection()
}
function nodeDeleteObj(id) {
  selection.value = [id]
  deleteSelected()
}
/** 悬浮工具栏高度（h-9），用于贴顶时翻转到节点下方的判定 */
const TOOLBAR_H = 36
/** 悬停节点 → 工具栏屏幕坐标 + 按类型装配动作 */
/** E2：节点参考条 —— 悬停/选中节点的上游引用（缩略图横排 + 断开 + 预览 + 加引用） */
/** 软渲提示条（一次性）：window.__SOFT_RENDER__ 由 main.js 检测写入 */
const softRenderTip = ref(false)
function dismissSoftRenderTip() {
  softRenderTip.value = false
  try {
    localStorage.setItem('artify.canvas.softRenderTipDismissed', '1')
  } catch {
    /* 忽略 */
  }
}
if (window.__SOFT_RENDER__ && !localStorage.getItem('artify.canvas.softRenderTipDismissed')) {
  softRenderTip.value = true
}
const refBarPreview = reactive({ id: null, x: 0, y: 0 }) // 悬停预览大图
const refBarHover = ref(null) // 锁定显示（防缩略图 hover 抖动）
const nodeRefBar = computed(() => {
  // 优先锁定 hover 的缩略图，其次当前悬停/选中节点
  const id = refBarHover.value || hoverNodeId.value || selection.value[selection.value.length - 1]
  if (!id || selection.value.length > 1) return null
  const o = objects.value.find((x) => x.id === id)
  if (!o || o.type === 'frame') return null
  const ups = links.value
    .filter((l) => l.to === id)
    .map((l) => ({ link: l, obj: objects.value.find((x) => x.id === l.from) }))
    .filter((r) => r.obj)
  // 无上游也显示（仅 + 按钮）——否则「添加引用」入口不可达
  const tl = worldToScreen(viewport.value, o.x, o.y)
  return {
    id,
    x: tl.x,
    y: tl.y + o.height * viewport.value.scale + 6,
    refs: ups.slice(0, 12).map((r) => ({
      linkId: r.link.id,
      fromId: r.obj.id,
      kind: r.obj.type,
      label: refLabelOf(r.obj),
      src: r.obj.type === 'image' ? r.obj.src : r.obj.type === 'video' ? r.obj.src : null,
      text: r.obj.type === 'note' ? String(r.obj.text || '') : '',
    })),
  }
})
/** 引用条缩略图 label（与 digest 口径一致） */
function refLabelOf(o) {
  if (o.type === 'note')
    return (
      String(o.text || '')
        .replace(/\s+/g, ' ')
        .slice(0, 20) || t('canvasKindNote')
    )
  if (o.type === 'image' || o.type === 'video') {
    if (o.name) return o.name
    try {
      if (o.src && o.src.startsWith('http')) {
        const u = new URL(o.src)
        return (
          u.searchParams.get('filename') ||
          decodeURIComponent(u.pathname.split('/').pop() || '') ||
          t(o.type === 'image' ? 'canvasKindImage' : 'canvasKindVideo')
        )
      }
    } catch {
      /* blob:/data: */
    }
    return (
      t(o.type === 'image' ? 'canvasKindImage' : 'canvasKindVideo') + ' #' + String(o.id).slice(-4)
    )
  }
  return o.name || o.type
}
/** E2：断开引用连线（X 按钮） */
function refBarDisconnect(linkId) {
  links.value = links.value.filter((l) => l.id !== linkId)
  saveSoon()
}
/** E2：悬停缩略图 → 锁定条 + 大图预览浮层 */
function refBarEnter(item, ev) {
  refBarHover.value = nodeRefBar.value?.id ?? null
  if (!item.src) return
  const r = ev.currentTarget.getBoundingClientRect()
  refBarPreview.id = item.fromId
  refBarPreview.x = r.right + 8
  refBarPreview.y = Math.max(8, r.top - 80)
}
function refBarLeave() {
  refBarHover.value = null
  refBarPreview.id = null
}
/** E2：+ 按钮 → 以本节点为 target 发起连线拖拽（把新上游拉进来） */
function refBarStartLink(toId, ev) {
  // UX 诉求：点 + 直接弹「创建节点」菜单（选中类型即建 + 自动连线），
  // 不再进入拖线手势（原行为要求拖到目标上，落空还得再点一次才见菜单）。
  const o = objects.value.find((x) => x.id === toId)
  if (!o) return
  const src = ev?.currentTarget
  const r = src?.getBoundingClientRect?.()
  const wrap = wrapEl.value?.getBoundingClientRect?.()
  // 屏幕坐标：优先按钮下方；取不到（键盘等无事件源）则节点左下角
  const sx = r && wrap ? clamp(r.left - wrap.left, 8, Math.max(8, size.w - 180)) : 8
  const sy = r && wrap ? clamp(r.bottom - wrap.top + 4, 8, Math.max(8, size.h - 210)) : 8
  // 世界坐标：菜单里选类型后新节点落点（节点正下方一卡位）
  const wx = o.x
  const wy = o.y + o.height + 24
  connectCreate.open = true
  connectCreate.x = sx
  connectCreate.y = sy
  connectCreate.wx = wx
  connectCreate.wy = wy
  connectCreate.to = toId
  connectCreate.from = null
}

/** E2：预览浮层对应的引用源物件 */
const refBarPreviewObj = computed(() => {
  if (!refBarPreview.id) return null
  const bar = nodeRefBar.value
  return bar?.refs.find((r) => r.fromId === refBarPreview.id) ?? null
})

// —— 工具栏显隐自定义（P1：参考 image-quick-tools 设置弹窗）——
// 偏好按「工具标题 key」隐藏（跨类型共享 title 自动同步，如「删除」）。
// 存 localStorage artify.canvas.tbHidden.v1 = [title, ...]
const TB_HIDDEN_KEY = 'artify.canvas.tbHidden.v1'
const tbHidden = ref(new Set(JSON.parse(localStorage.getItem(TB_HIDDEN_KEY) || '[]')))
const tbSettings = reactive({ open: false, x: 0, y: 0 })
function tbResetHidden() {
  tbHidden.value = new Set()
  localStorage.setItem(TB_HIDDEN_KEY, '[]')
}
function tbToggleHidden(title) {
  const next = new Set(tbHidden.value)
  if (next.has(title)) next.delete(title)
  else next.add(title)
  tbHidden.value = next
  localStorage.setItem(TB_HIDDEN_KEY, JSON.stringify([...next]))
}

/** 类型化装配悬浮工具栏动作（P1 重构：供 hoverToolbar 与 tbCandidates 共用） */
function buildToolbarItems(o, id) {
  const items = []
  if (o.type === 'note') {
    items.push(
      {
        icon: 'fas fa-palette',
        title: t('canvasTbNoteColor'),
        action: () => openNotePalette(id),
      },
      { icon: 'fas fa-pen', title: t('canvasTbEditNote'), action: () => startNoteEdit(id) },
      { icon: 'fas fa-minus', title: t('canvasTbFontDown'), action: () => nodeBumpFont(id, -1) },
      { icon: 'fas fa-plus', title: t('canvasTbFontUp'), action: () => nodeBumpFont(id, 1) },
      {
        icon: 'fas fa-image',
        title: t('canvasTbGenImage'),
        action: () => startGenerateFromNote(id),
      },
      {
        icon: 'fas fa-wand-magic-sparkles',
        title: t('canvasTbRewrite'),
        action: () => startNoteRewrite(id),
      },
      {
        icon: 'fas fa-bookmark',
        title: t('canvasTbSavePrompt'),
        action: () => {
          const o = objects.value.find((x) => x.id === id)
          const text = String(o?.text || '').trim()
          if (!text) {
            message.warning(t('canvasGenNeedText'))
            return
          }
          addCustomPrompt(text)
          message.success(t('canvasPromptSaved'))
        },
      },
    )
  } else if (o.type === 'image') {
    items.push(
      {
        icon: 'fas fa-download',
        title: t('canvasTbDownload'),
        action: () => nodeDownloadImage(id),
      },
      {
        icon: 'fas fa-paper-plane',
        title: t('canvasSendToWorkbench'),
        action: () => {
          selection.value = [id]
          sendSelectionToWorkbench()
        },
      },
      { sep: true },
      {
        icon: 'fas fa-rotate-left',
        title: t('canvasTbRotL'),
        action: () => rotateImageNode(id, -90),
      },
      {
        icon: 'fas fa-rotate-right',
        title: t('canvasTbRotR'),
        action: () => rotateImageNode(id, 90),
      },
      { icon: 'fas fa-table-cells', title: t('canvasTbSplit'), action: () => splitImageNode(id) },
      { icon: 'fas fa-crop-simple', title: t('canvasTbCrop'), action: () => cropImageNode(id) },
      {
        icon: 'fas fa-camera-rotate',
        title: t('canvasTbAngle'),
        action: () => {
          angleDlg.id = id
          angleDlg.deg = 0
          angleDlg.flipH = false
          angleDlg.flipV = false
          angleDlg.open = true
        },
      },
      { sep: true },
      {
        icon: 'fas fa-magnifying-glass-plus',
        title: t('canvasTbUpscale'),
        action: () => {
          upscaleDlg.id = id
          upscaleDlg.target = 2048
          upscaleDlg.algo = 'high'
          upscaleDlg.open = true
        },
      },
      {
        icon: 'fas fa-repeat',
        title: t('canvasTbReplaceImage'),
        action: () => uploadMediaFor(id),
      },
      { sep: true },
      {
        icon: 'fas fa-quote-left',
        title: t('canvasTbCopyPrompt'),
        action: () => copyImagePrompt(id),
      },
    )
  } else if (o.type === 'video' || o.type === 'audio') {
    items.push({
      icon: 'fas fa-upload',
      title: o.src ? t('canvasMediaReplace') : t('canvasMediaUpload'),
      action: () => uploadMediaFor(id),
    })
    if (o.type === 'video' && o.src) {
      items.push(
        {
          icon: 'fas fa-backward-step',
          title: t('canvasFrameFirst'),
          action: () => captureVideoFrameAt(id, 'first'),
        },
        {
          icon: 'fas fa-forward-step',
          title: t('canvasFrameLast'),
          action: () => captureVideoFrameAt(id, 'last'),
        },
        {
          icon: 'fas fa-camera',
          title: t('canvasFrameCurrent'),
          action: () => captureVideoFrameAt(id, 'current'),
        },
      )
    }
  } else if (o.type === 'app') {
    items.push(
      { icon: 'fas fa-play', title: t('canvasRunAppNodes'), action: () => runAppNode(id) },
      {
        icon: 'fas fa-sliders',
        title: t('canvasCtxAppPanel'),
        action: () => {
          appPanel.id = appPanel.id === id ? null : id
        },
      },
    )
  } else if (o.type === 'frame') {
    items.push({
      icon: 'fas fa-pen',
      title: t('canvasRenameFrame'),
      action: () => startFrameRename(id),
    })
  }
  items.push(
    { icon: 'fas fa-copy', title: t('canvasTbCopy'), action: () => nodeCopyObj(id) },
    {
      icon: 'fas fa-trash',
      title: t('canvasTbDelete'),
      danger: true,
      action: () => nodeDeleteObj(id),
    },
  )
  return items
}

const hoverToolbar = computed(() => {
  const id = hoverNodeId.value
  if (!id) return { x: 0, y: 0, items: [], below: false }
  const o = objects.value.find((x) => x.id === id)
  if (!o) return { x: 0, y: 0, items: [], below: false }
  const tl = worldToScreen(viewport.value, o.x, o.y)
  const x = tl.x + (o.width * viewport.value.scale) / 2
  const below = tl.y - 10 < TOOLBAR_H + 12
  const y = below ? tl.y + o.height * viewport.value.scale + 34 : tl.y - 10
  const all = buildToolbarItems(o, id)
  // 用户偏好过滤（标题 key）+ 压缩多余分隔线 + 尾部「…」设置按钮
  const vis = all.filter((b) => b.sep || !tbHidden.value.has(b.title))
  const squeezed = []
  for (const b of vis) {
    if (b.sep && (squeezed.length === 0 || squeezed[squeezed.length - 1].sep)) continue
    squeezed.push(b)
  }
  while (squeezed.length && squeezed[squeezed.length - 1].sep) squeezed.pop()
  squeezed.push({
    icon: 'fas fa-ellipsis',
    title: t('canvasTbSettings'),
    action: () => {
      const el = document.querySelector('.node-hover-toolbar')
      if (el) {
        const r = el.getBoundingClientRect()
        const wrap = wrapEl.value?.getBoundingClientRect()
        tbSettings.x = r.left - (wrap?.left || 0) + r.width / 2
        tbSettings.y = r.bottom - (wrap?.top || 0) + 8
      }
      // 打开时快照候选工具（popover 显示期间鼠标离开节点会让 hoverNodeId
      // 清空，实时 computed 会变空列表）——快照保住列表
      tbSettings.items = all.filter((b) => !b.sep).map((b) => ({ title: b.title, icon: b.icon }))
      tbSettings.open = true
    },
  })
  return { x, y, items: squeezed, below }
})
/** 工具栏被摘掉（节点删除/类型无动作）时 DOM 消失，mouseleave 不再触发 —— 兜底复位 keep，
 *  否则 toolbarKeep 残留 true 会让后续悬停永远收不起来 */
watch(
  () => hoverToolbar.value.items.length,
  (n) => {
    if (!n) {
      toolbarKeep.value = false
      cancelHoverHide()
      closeNotePalette() // 工具栏消失（hover 移开/节点删除）时一并收起色板
    }
  },
)

const miniOpen = ref(true) // 小地图开关（缩放控件条内切换）
const shortcutsOpen = ref(false) // 快捷键面板
/** 滑杆缩放：以画布中心为锚（与滚轮一致的锚点语义） */
function onZoomSlider(e) {
  const target = Number(e.target.value) / 100
  const cur = viewport.value.scale
  if (!target || target === cur) return
  viewport.value = zoomAtPoint(
    viewport.value,
    target / cur,
    size.w / 2,
    size.h / 2,
    MIN_SCALE,
    MAX_SCALE,
  )
  applyViewport()
}
const shortcutList = computed(() => [
  { label: t('canvasScWheelK'), desc: t('canvasScWheel') },
  { label: t('canvasScSpaceDragK'), desc: t('canvasScSpaceDrag') },
  { label: 'Ctrl/⌘ + ' + t('canvasScDragK'), desc: t('canvasScCtrlDrag') },
  { label: 'Shift + ' + t('canvasScClickK'), desc: t('canvasScShiftClick') },
  { label: 'Ctrl/⌘ + A', desc: t('canvasScSelectAll') },
  { label: 'Ctrl/⌘ + C / V', desc: t('canvasScCopyPaste') },
  { label: 'Ctrl/⌘ + Z / ⇧Z / Y', desc: t('canvasScUndoRedo') },
  { label: 'Ctrl/⌘ + G / ⇧G', desc: t('canvasScGroup') },
  { label: 'Delete / Backspace', desc: t('canvasScDelete') },
  { label: t('canvasScDblNoteK'), desc: t('canvasScNoteEdit') },
  { label: t('canvasScDblFrameK'), desc: t('canvasScFrameRename') },
  { label: t('canvasScLinkDragK'), desc: t('canvasScLinkReconnect') },
  { label: t('canvasScHandleK'), desc: t('canvasScResize') },
  { label: 'Esc', desc: t('canvasScEscape') },
])

const dragOver = ref(false)

// 项目下拉外点关闭（capture 阶段判定；项目栏自身 mousedown.stop 不影响 document 捕获）
onMounted(() => {
  // D1c：Shift/Ctrl 全局键态追踪（resize 比例锁实时切换；capture 确保先于组件逻辑）
  window.addEventListener(
    'keydown',
    (e) => {
      if (e.key === 'Shift') shiftDown.value = true
      if (e.key === 'Control' || e.key === 'Meta') ctrlDown.value = true
    },
    { capture: true },
  )
  window.addEventListener(
    'keyup',
    (e) => {
      if (e.key === 'Shift') shiftDown.value = false
      if (e.key === 'Control' || e.key === 'Meta') ctrlDown.value = false
    },
    { capture: true },
  )
  window.addEventListener('blur', () => {
    shiftDown.value = false
    ctrlDown.value = false
  })
  document.addEventListener(
    'mousedown',
    (e) => {
      if (!projectMenuOpen.value) return
      const bar = wrapEl.value?.querySelector?.('[data-project-bar]')
      if (bar && !bar.contains(e.target)) projectMenuOpen.value = false
    },
    { capture: true },
  )
  // 工具栏显隐设置浮层：点外部关闭（浮层自身 mousedown.stop 不冒泡）
  document.addEventListener('mousedown', (e) => {
    if (!tbSettings.open) return
    const pop = wrapEl.value?.querySelector?.('[data-tb-settings]')
    if (pop && !pop.contains(e.target)) tbSettings.open = false
  })
})
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
    if (f.type.startsWith('video/') || f.type.startsWith('audio/')) {
      made.push(f.name)
      addMediaFromFile(f, world.x, cursorY, (h) => (cursorY += h + 16))
      continue
    }
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
  // 素材库拖出（P2）：优先于文件拖入
  const assetId = e.dataTransfer?.getData('application/x-artify-asset')
  if (assetId) {
    const a = assets.value.find((x) => x.id === assetId)
    if (a) {
      const st = stageEl.value?.getStage?.()
      const p = st.getPointerPosition() || { x: size.w / 2, y: size.h / 2 }
      const w = screenToWorld(viewport.value, p.x, p.y)
      insertAsset(a, w.x - 130, w.y - 90)
    }
    return
  }
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
/** 窗口级 mouseup 兜底：缩放等 stage 拖拽若指针移出画布松手，Konva mouseup 不触发，这里收尾 */
function onWindowMouseUp() {
  if (drag.mode === 'resize') onResizeEnd()
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
    // 双击：App 节点 = 展开参数面板；note = 就地编辑文本；frame = 重命名
    g.on('dblclick.wb', (e) => {
      const o = objects.value.find((x) => x.id === g.id())
      if (o?.type === 'app') {
        e.evt?.preventDefault?.()
        openAppNodePanel(o.id)
      } else if (o?.type === 'note') {
        e.evt?.preventDefault?.()
        startNoteEdit(o.id)
      } else if (o?.type === 'frame') {
        e.evt?.preventDefault?.()
        startFrameRename(o.id)
      }
    })
    // Ctrl/⌘/Alt+拖拽克隆：注册在 onNodeDragEnd 之后，保证 dragend 顺序 = 先同步数据再对齐克隆
    g.on('dragstart.wb', onNodeDragStartSnap)
    g.on('dragstart.wb', onNodeCloneStart)
    g.on('dragend.wb', commitCloneDrag)
  })
}
onMounted(() => {
  loadNow()
  // 兜底：loadNow 恢复的 id 集合若与上个会话相同，id-watch 不触发，
  // 但 Konva group 是新实例（无 _boundWb）—— 延迟一轮幂等补绑
  setTimeout(() => nextTick(bindNodeEvents), 600)
  setTimeout(() => nextTick(bindNodeEvents), 1800)
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
  window.addEventListener('mouseup', onWindowMouseUp)
  window.addEventListener('paste', onPaste)
  // stage 初始变换
  requestAnimationFrame(applyViewport)
  // 侧边栏工作台：产物生成 → 自动落画布（window 总线，见 canvasMode.js）
  const offResult = onResult(placeFiles)
  onBeforeUnmount(() => {
    if (layersFocusAnim) cancelAnimationFrame(layersFocusAnim)
    offResult()
  })
})
watch(
  // id 序列变化触发（bindNodeEvents 以 _boundWb 标记幂等，多调无副作用）。
  // 另：页面重载/路由回访后 Konva group 全量重建但 id 集合可能与上个会话相同
  // （watch 不触发）→ onMounted 里延迟兜底补绑一轮，确保新实例拿到事件。
  () => objects.value.map((o) => o.id).join(','),
  () => nextTick(bindNodeEvents),
  { immediate: true },
)
onBeforeUnmount(() => {
  ro?.disconnect()
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('keyup', onKeyUp)
  window.removeEventListener('mouseup', onWindowMouseUp)
  window.removeEventListener('paste', onPaste)
  clearTimeout(saveTimer)
  cancelHoverHide()
  // app 节点轮询清场
  for (const nodeId of [...nodePolls.keys()]) stopNodePoll(nodeId)
  // AI ops 订阅清场
  offOps?.()
})
</script>

<style scoped>
/* 拖动画布/节点/框选时避免选中界面文本：包装层整体禁选（Tailwind select-none
   已加在 wrapEl），输入类控件豁免恢复——note 就地编辑/项目名/画布重命名。 */
input,
textarea {
  user-select: text;
  -webkit-user-select: text;
}
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
/* 悬浮工具栏底部透明桥接区：工具栏定位在节点顶边上方 10px（top: tl.y - 10 + -translate-y-full），
   鼠标从节点移向工具栏必经过这段空白，那里命中 canvas 空地 → 悬停被清 → 工具栏消失。
   桥接区把这段空白（+10px 余量）纳入工具栏 DOM，鼠标中途不会“掉出”。 */
.node-hover-toolbar .tb-bridge {
  position: absolute;
  /* 两角各让 28px：桥接热区只护中段，不盖角柄热区（E5fix） */
  left: 28px;
  right: 28px;
  height: 20px;
}
.node-hover-toolbar:not(.is-below) .tb-bridge {
  top: 100%;
}
/* 翻转到节点下方时，桥接区改挂顶部（工具栏上沿 → 节点底边） */
.node-hover-toolbar.is-below .tb-bridge {
  bottom: 100%;
}
/* note 就地编辑框：与便签底色/字号对齐，仅边框高亮提示编辑中 */
.note-editor {
  padding: 10px;
  line-height: 1.4;
  background: #475569;
  color: #e2e8f0;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
.note-editor::placeholder {
  color: rgba(226, 232, 240, 0.45);
}
/* E3 提及高亮 mirror：与 textarea 同排版参数（padding/行高/字号由 inline
   style 带出），承担底色；textarea 背景透明只显光标与选区 */
.note-editor-mirror {
  background: #475569;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
}
/* frame 名称重命名框：不透明底遮住下方 Konva 标签，Enter/blur 提交、Esc 取消 */
.frame-editor {
  padding: 1px 6px;
  line-height: 1.5;
  color: var(--wb-text-1);
  background: var(--wb-surface);
  box-shadow:
    0 0 0 1px var(--wb-stroke),
    0 8px 24px rgba(0, 0, 0, 0.4);
  box-sizing: border-box;
}
.frame-editor::placeholder {
  color: var(--wb-text-2);
  opacity: 0.6;
}
</style>
