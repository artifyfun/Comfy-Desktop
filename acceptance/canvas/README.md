# Canvas 验收（agent-browser 浏览器 E2E）

验收 `artifylab-v2` 最近一批 canvas + 部分 workbench 前端功能实现。复用 batch-queue 验收的"serve + stub + agent-browser"方法学：纯前端 + localStorage 持久化场景下 stub 仅做 seed，不需 mock 队列引擎。

## 目录结构

```
acceptance/canvas/
├── serve.mjs          # 静态服务器（托管前端构建产物 + SPA fallback + stub 注入）
├── stub.js            # 页面内 IIFE：localStorage seed + electronAPI mock + __canvasCtl 句柄
├── screenshots/       # C0–C6 验收截图
└── README.md
```

## 复跑

```bash
# 1. 构建前端（build:frontend 输出到 src/main/artifylab/public/frontend）
cd /d/artifyfun/Comfy-Desktop && pnpm run build:frontend

# 2. 启动验收服务器（端口 5174）
cd acceptance/canvas && node serve.mjs 5174

# 3. 浏览器打开 /canvas（独立 session 避免污染）
AGENT_BROWSER_SESSION=canvas-verify agent-browser open http://127.0.0.1:5174/canvas
```

> 复跑前若希望回到 seed 默认态：`eval window.__canvasCtl.reset()`（页面会 reload）。

## 验收矩阵（7 场景全绿）

| # | 验收点 | 提交 | 截图 |
|---|---|---|---|
| C0 | boot + seed 渲染：4 节点 / 2 图 / 2 便签 / 3 连线 / 网格背景 / 小地图 / 图层面板 / 工具栏分组（E5） | many | c0-boot.png |
| C1 | **E2 参考条** 选中 note1 → 上游 2 缩略图（imgA 红、imgB 蓝）+ +加引用按钮 | b4a78e06 / 869fb8de | c1-ref-bar-note1.png |
| C2 | **E2 参考条** 选中 imgB → 上游 1 缩略图（imgA） | b2567dc1 | (C1 同图) |
| C3 | **E2 X 断开引用** → localStorage links 3→2，参考条仍显示（仅 +） | b4a78e06 | (断言) |
| C4 | **E4 项目网格** → 顶部"层组"按钮 → 3 卡统计（4 物件/2 连线 实时反映）+ 激活态高亮 + 批量管理 + 新建画布 | 96124ff7 | c4-projects-menu.png |
| C5 | **E3 双击 note 编辑态** → textarea 出现，@提及标记文本保留 | b275271d | c5-note-edit.png |
| C6 | **D1a 蒙版编辑对话框** → image 右键 → "局部重绘（发工作台）" → 笔刷/橡皮/笔刷 28px/重绘指令/清空/取消/AI 重绘 | 8adea2d5 | c6-mask-dialog.png |

**bonus**：ctxMenu 14 项齐全（复制/发送参考/以此生成/圈选裁剪/局部重绘/**AI 处理**/反推提示词/放大增强/扩图/图生视频/角色资产/风格资产/移到最前/删除）—— 印证 cd36f206 E5 UI 打磨"右键菜单 AI 子菜单收纳"成果。

## stub 设计要点

- **electronAPI mock**（必要）：canvas 页 boot 走 `isElectron = !!window.electronAPI` → `initConfig` → `getElectronConfig().server_origin`。无 mock 时走 web config 拿不到 server，路由守卫兜底重定向 `/about`（batch 验收时遇到的同一现象）。mock 仅 8 行：`server_origin = location.origin`，因为 canvas 实际不依赖后端（纯前端 + localStorage），stub 不需要拦截任何 fetch。
- **localStorage seed**：项目 store key `artify.canvas.projects.v1`（projectStore.js 定义），结构见同文件 makeProject/emptyStore/normalizeStore。seed 3 项目（主画布 + 便签项目 + 空画布）满足 E4 网格多卡场景；主画布含 2 note + 2 image + 3 links，让 E2 参考条、E3 @提及、D1a 蒙版均可验。
- **图片 data URL**：stub.js > svgDataUrl(hex, label, w, h) 用 inline SVG 转 `data:image/svg+xml;charset=utf-8,...`。Konva imgCache.loadImage(o.src) 可加载（避免外链 404 与 localStorage 体积爆）。
- **`__canvasCtl` 句柄**：暴露 KEY / projects(getter) / reset() / addNote(text)，方便验收脚本在 UI 改造 store 后回滚或扩展。

## 与 batch-queue 验收方法学的关系

| 维度 | batch-queue | canvas |
|---|---|---|
| 后端依赖 | 主进程 batchRunner（队列引擎） | 无（纯前端） |
| stub 复杂度 | 高（14 条路由 + electronAPI mock + 队列状态机） | 低（仅 localStorage seed + electronAPI mock） |
| 自动 seed | seedRunningJob(45) / seedPausedQueue(n) 等 | 一次性写入 store；UI 改造后需 __canvasCtl.reset() 回滚 |
| 关键修复 | 前端 API 路径前缀 /batch 导致 stub 路由不命中 | electronAPI mock 缺失导致 boot 跳 /about |
| 验收矩阵 | T1–T7（向导/暂停/重跑/重启 banner/配置/管理/全局浮层） | C0–C6（boot/参考条/断开/网格/编辑态/蒙版） |

## agent-browser Windows 经验（与 batch 共用）

- 截图必须用 `D:/...` 路径（`/d/...` 会报 os error 3）
- ant-design 按钮文本可能含不可见空格（如"置 顶"、"删 除"），过滤用正则 `/置\s*顶/`
- 单击 `b.click()` 不一定触发 vue @click，优先 `dispatchEvent(new MouseEvent('click', {bubbles:true}))`
- stub 是 IIFE 仅 load 时执行，改 stub.js 必须 `agent-browser open` 重载
- Konva 不全局暴露，无法用 `Konva.stages[0]`；vue-konva 通过 canvas 元素 DOM 派 PointerEvent + MouseEvent 序列（pointerdown/mousedown + pointerup/mouseup）可模拟选中：先找 stage div rect，世界坐标 (x,y) 映射到屏坐标 = (rect.left + x*scale + viewport.x, rect.top + y*scale + viewport.y)，派发到 v-stage 对应 canvas 元素

## 已知遗留 / 未覆盖

**2026-09-18 复核新增（S11 已闭环一条，其余待排）**

- ✅ **D2 digest → wb_canvas_ops 链路**（原写"需 agent 后端"）—— 已由 **S11**（`scripts/wb-platform-canvas-e2e-verify.mjs`，8/8）用真 LLM + 真 ComfyUI 覆盖：真会话发指令 → 批准 → 真出图 → canvas ops 确认卡 → 落布 app 节点。
- ✅ **手动连线手势** —— 已由 **C-H9**（`scripts/wb-canvas-gaps-verify.mjs`，12/12）覆盖：真鼠标拖句柄建线 / 点线删除 / 拖锚点重连。**过程里挖出真 bug**（见 C-H9 章「根因」）
- ✅ **选区快捷指令条（A14）** —— 已由 **C-H9** 覆盖：框选浮出 `#canvas-sel-prompt` → 回车真送达 agent → agent 只聊天不出图
- ✅ **图片入画布路径** —— 已由 **C-H9** 覆盖三条路（文件拖入 / 剪贴板粘贴 / 素材库拖出），且校验按真实比例缩放
- ✅ **多选拖动 / 分组（groups） / 对齐与自动布局** —— 已由 **C-H10**（`scripts/wb-canvas-selection-verify.mjs`，14/14）覆盖：
  框选/Shift+点选多选、选择栏与右键菜单两组对齐入口、等距分布、组合/解组、组内拖动联动；
  **过程里量出一处遮挡缺陷**（软渲染提示横幅压住右上工具条，已修，见 C-H10 章）。
  ⚠️ 现状记录：**未组合的多选拖动只移动被拖的那一个**（要整体移动需先「组合」）；
  组合成员拖角柄不缩放（`onResizeStart` 里 `groupOf(id) → return`，设计如此）；二者已写成断言固化。
- ✅ **画布项目切换 / 重命名 / 删除** —— 已由 **C-H14**（`scripts/wb-canvas-projects-verify.mjs`，11/11）覆盖：
  标题双击重命名、卡片切换（**画布真的重装载**）、刷新持久化、卡片内联重命名、单卡删除（取消/确认两路）、
  批量管理、删唯一项目自动补空并清空画布。数据层语义早已由 `projectStore.test.js`(20+ 条) 覆盖，本脚本只验 UI 路径。
  过程里修掉**同一横幅的第二处遮挡**（压住项目下拉表头）→ 提示层改为 `pointer-events-none`。
- ✅ **图片落点语义** —— 已修（见 C-H9 章末）：落点改取拖放事件坐标，三条路统一为「落点 = 节点中心」，
  单测 `dropPlacement.test.js` + C-H9.8b/9b/10b 双保险。
  ⚠️ 仍**未实证**：真实原生拖放（从 Explorer 拖文件进来）的端到端效果 —— 无头里构造不了浏览器级拖放
  （CDP `Input.dispatchDragEvent` 的载荷进不了 `dataTransfer.files`／自定义 mime，两组零对象），
  理论依据是"原生拖拽期间不派发 pointermove"（这也是修它的理由），需要人手拖一次确认。
- ✅ **快照 / 历史回滚** —— 已由 **C-H12**（`scripts/wb-canvas-snapshot-verify.mjs`，11/11）覆盖 + 存储层单测（`aiSnapshots.test.js`，9 条）。
  撤销/重做（含 redo 截断、栈底栈顶边界）与 AI 快照面板（渲染 / 一键恢复 / 回滚可撤销 / 删除）双路验完。
  ⚠️ 埋了一个坑：快照按**真实 `activeAppId`** 分组，不是 `'default'`（脚本从应用配置读 pid）。

**更早遗留**

- **E3 chip 渲染**截图中文本 `@[图A]` 仍以原语法显示，未观察到 chip 高亮染色（可能 chip 仅在编辑态 mirror 层呈现）
- **D1a 笔刷涂抹交互**未实测（拖动涂抹 stroke 路径）；打开对话框 + UI 完整呈现已确认
- **A1 引用注入 / A3 IME 守卫 / A4 粘贴图 / B1 审批模式 / E1 推理强度** 等 workbench 内嵌功能依赖 Workbench 侧栏会话，未在 canvas stub 中桩（需在 workbench 单独验收环境跑）
- **批量管理复选/批量删除**未操作（项目数 3 < E4 批量场景典型阈值）

## 复跑验收脚本（可粘贴）

```bash
# 启动
cd /d/artifyfun/Comfy-Desktop/acceptance/canvas && node serve.mjs 5174 &
sleep 1
agent-browser open http://127.0.0.1:5174/canvas
sleep 6

# C0 boot 状态
agent-browser eval "(() => ({n: document.querySelectorAll('canvas').length, title: document.body.innerText.includes('验收主画布')}))()"

# C1 选中 note1（屏坐标 = 425+230, 65.4+130）
agent-browser eval "(() => { const c=[...document.querySelectorAll('canvas')].slice(-1)[0]; const cx=655,cy=195.4; const o={clientX:cx,clientY:cy,button:0,bubbles:true,cancelable:true,view:window}; c.dispatchEvent(new PointerEvent('pointerdown',{...o,pointerType:'mouse',pointerId:1})); c.dispatchEvent(new MouseEvent('mousedown',o)); c.dispatchEvent(new PointerEvent('pointerup',{...o,pointerType:'mouse',pointerId:1})); c.dispatchEvent(new MouseEvent('mouseup',o)); return 'ok'; })()"

# C2 选中 imgB
agent-browser eval "(() => { const c=[...document.querySelectorAll('canvas')].slice(-1)[0]; const cx=1105,cy=449.4; const o={clientX:cx,clientY:cy,button:0,bubbles:true,cancelable:true,view:window}; c.dispatchEvent(new PointerEvent('pointerdown',{...o,pointerType:'mouse',pointerId:1})); c.dispatchEvent(new MouseEvent('mousedown',o)); c.dispatchEvent(new PointerEvent('pointerup',{...o,pointerType:'mouse',pointerId:1})); c.dispatchEvent(new MouseEvent('mouseup',o)); return 'ok'; })()"

# C4 打开项目网格
agent-browser eval "(() => { const b=[...document.querySelectorAll('button')].find(x=>x.querySelector('i.fa-layer-group')); b?.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); return 'ok'; })()"

# 重置
agent-browser eval "window.__canvasCtl.reset()"
```

---

## C-H8 交互回归（playwright 无头，可复跑）

两条脚本都走**真鼠标/真键盘**，断言以 `artify.canvas.projects.v1`（落盘态）与 Konva stage（实时态）
双源互证。本机 `agent-browser` 不可用，改走仓库自带 playwright 无头实例。

```bash
cd /d/artifyfun/Comfy-Desktop && pnpm run build:frontend
cd acceptance/canvas && node serve.mjs 3008 &
cd /d/artifyfun/Comfy-Desktop
node scripts/wb-canvas-interaction-verify.mjs 3008   # 15 断言
node scripts/wb-canvas-w2.mjs 3008                   # 6 断言
```

| 脚本 | 覆盖 | 截图 |
|---|---|---|
| `wb-canvas-interaction-verify.mjs` | seed 双源互证 → 拖拽节点（+落盘）→ 单点选中/删除/撤销 → **Shift+拖框选**（选择栏 ≥2 + 一次删除全部 + 撤销全恢复）→ 滚轮缩放（+落盘）→ 空格+拖平移（+落盘）→ 交互段无新增 JS 异常 | ch8-drag-node / ch8-box-select / ch8-zoom-pan |
| `wb-canvas-w2.mjs` | 空格+拖平移 → 拖节点 → 选中+删除 → 撤销 → 新建画布项目 → 交互段无新增 JS 异常 | canvas-w2-final |

### 六个坑（照抄别踩）

1. **seed 必须活过 stub 的重写**：`stub.js` 每次 boot 都无条件 `setItem`，页内 `evaluate` 改 store 再
   `reload` 会被覆盖（旧版脚本据此误判成「未找到 a1」）。解法：`context.route('**/__canvas_stub.js')`
   取原始响应体，**在末尾追加** seed 脚本再 fulfill —— 不改 `stub.js`。
2. **普通拖 = 平移画布，框选要按住 Shift / Ctrl / 中键**（`onMouseDown` 里 `drag.mode='rubber'` 的条件）。
3. **框选起止点都要留在画布容器内**：起手判定是 `if (e.target !== st) return`，点在节点上或画布顶部
   DOM 工具条上都不会进框选分支；终点跑出容器则 rubber 不结算，**还会把随后的「空格+拖 平移」一起吞掉**
   （表现为 stage 位移 0，极易误读成平移坏了）。
4. **选择栏只在多选（≥2）时出现**（`selBar` computed：`ids.length < 2 → null`）——单选断言要用
   「删掉一个 + 撤销回来」的功能证据，不能看选择栏。
5. **拖拽类断言必须排在做缩放/平移之前**：脚本会真的把画布平移到负坐标，之后按屏幕坐标点节点全落空。
6. **视口有实时/落盘两份**，落盘走 `saveSoon` 500ms 防抖 → 断言前等 ≥1.2s。

---

## C-H9 画布盲区补测（playwright 无头 + 真 agent，17/17）

补掉上面「已知遗留」里的三条：手动连线手势 / 选区快捷指令条 / 图片入画布；
另加 ④ 段反向确认**修复没有连坏邻近手势**（角柄缩放，同属"无 id 的 v-group"病灶）；
③ 段补三条**落点语义**断言（见下方「落点」小节）。
搭法同 S11：**直接从应用自身打开 `/canvas`**（`:3008` 同源伺服 SPA，SSE 才原生流式），
`electronAPI` shim + 画布种子走 `addInitScript` 注入。

```bash
# 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
cd /d/artifyfun/Comfy-Desktop && node scripts/wb-canvas-gaps-verify.mjs
```

| 断言 | 覆盖 |
|---|---|
| C-H9.0 | 画布页 + 内嵌工作台就位（真会话） |
| C-H9.1–3 | ① 拖右句柄建线 → 点线选中 + Delete 删除 → 拖 `to` 端锚点重连到另一节点（links 落盘态互证） |
| C-H9.4–7 | ② 框选浮出 `#canvas-sel-prompt` → 再框选输入重置 → 回车真发送 → **agent 回复（chat 类，不触发生图）** |
| C-H9.8–10 | ③ 文件拖入（DataTransfer+File）/ 剪贴板粘贴（ClipboardEvent）/ 素材库拖出（`application/x-artify-asset-url`）+ 按真实比例缩放 |
| C-H9.8b / 9b / 10b | ③ **落点语义**：文件拖入与素材库拖出的落点 = 拖放事件坐标（节点中心）；粘贴无坐标 → 落点贴真实指针 |
| C-H9.12–13 | ④ **角柄缩放**：拖 `se` 角柄真改尺寸（160x100 → 290x190 落盘）+ **x/y 不动**（状态归属正确——修复前该手势会被全局绑定误判成"按在物件上"而整体拖动） |
| C-H9.11 | 全程无新增页面错误 |

截图：`ch9-link-created` / `ch9-link-reconnect` / `ch9-sel-prompt` / `ch9-sel-prompt-sent` / `ch9-image-drop` / `ch9-resize`。

> ⚠️ **看图别误判**：C-H9 ③ 段的粘贴测试用例是**纯色 `#1c8` 绿**的合成 SVG（纯色便于断言），
> 所以 `ch9-image-drop` / `ch9-resize` 截图里那块**纯绿矩形 = 粘贴进来的测试图，不是坏节点**
> （它没有虚线框/破损图标）；同时文件拖入的渐变图与它**落在同一坐标**且尺寸更小，被它整块盖住看不见。
> 右下角那个深色带蓝框的小面板是 **minimap（全景小窗）**，也不是坏节点。对照见 `ch9-green-probe.png`
> （空画布只跑三条图片路径：模糊大图=素材库拖出，绿块=粘贴）。

### 落点：不看拖放事件坐标（已修）+ 统一为「落点 = 节点中心」

**病灶**（2026-09-18 修）：`onDrop` / `onPaste` 三处都用 `st.getPointerPosition()` 定位，
**完全忽略拖放事件自带的 `clientX/clientY`**；模板里的 `@dragover.prevent="dragOver = true"`
也只置高亮、丢弃坐标。而 Konva 的 `pointerPos` **只由 pointermove/pointerdown 更新**，
拖放事件不参与。实测（合成 drop，走应用真实 handler）：

| 组 | 真指针在世界坐标 | drop 事件里的坐标 | 修复前落点 |
|---|---|---|---|
| A | 200,200 | 900,600 | **200,199.6**（= 真指针，事件坐标被忽略） |
| B | 900,600 | 900,600 | 900,599.6 |
| C | 从不移动 | 900,600 | 757,73.6（**上一次真实点击遗留的陈旧指针**） |

原生拖拽期间浏览器不派发 pointermove，所以只读指针位置会把图放到**"拖动开始前指针所在的位置"**。

**修法**：新增 `dropWorld(e)`，坐标优先级 = **拖放事件坐标 → Konva 指针 → 画布中心**，
`onDrop` 三个分支与 `onPaste` 统一走它（`clientX/clientY` 双 0 视为事件没带坐标 → 回落指针，
这样 `ClipboardEvent` 与无参合成事件天然走指针分支）。同时把三条路的锚点统一为
**「落点 = 节点中心」**：居中在 probe 拿到真实尺寸后才算（`insertAsset` / `filesToObjects` /
`addMediaFromFile` 内部完成），此前素材库路径靠调用方硬编码 `x-130, y-90`（非 260x180 的
素材会偏，方形素材偏 40px），文件路径则把落点当左上角。

回归：单测 `src/views/canvas/dropPlacement.test.js`（5 条，含方形/横图/音频/视频回正）+
C-H9.8b / 9b / 10b 三条浏览器断言（实测 `中心 (1100, 319.5) vs 拖放点 (1100, 320)`）。

### 根因：`stopKonvaEvent` 的短路写法让「阻断冒泡」从未生效（已修）

```js
// ✗ 原写法：cancelBubble 初始化就是 false → 条件为假 → 永远置不上 true
kev?.cancelBubble && (kev.cancelBubble = true)
// ✓ 修后
if (kev) kev.cancelBubble = true
```

`index.vue` 里对所有 Group 做了全局绑定 `st.find('Group').forEach(g => g.on('mousedown.wb', e => onItemDown(idx(), e)))`，
而 `idx()` 用 `g.id()` 反查物件索引。冒泡没被阻断 → **句柄组/锚点组（无 id）传 idx=-1 进来 → `objects.value[-1].id` 抛 TypeError**；
更隐蔽的是**有 id 的 Group** 会误把缩放/建线手势当成「按在物件上」（`drag.mode='item'`、改 selection），与手势抢状态。
这 5 个调用点（句柄建线、锚点重连、角柄缩放、app 节点两处）**全都**受影响。

加固两处：① `stopKonvaEvent` 无条件置 `cancelBubble = true`；② `onItemDown` 取物件前兜空（`if (!obj) return`），
任何新增 Group 都不再能用同类方式崩掉画布。回归单测：`useLinkGestures.test.js` 新增 3 条（cancelBubble 初始 false 也要置真 / 锚点重连路径 / 缺 `evt` 不抛）。

**改完必须反向确认邻近手势没被连坏**：`stopKonvaEvent` 有 5 个调用点（句柄建线 ✓ / 锚点重连 ✓ /
**角柄缩放** / app 节点 ⚙ 面板 / app 节点 ▶ 运行），①②③ 段只覆盖了前两个 —— 于是补 ④ 段。
角柄的 `v-group` 同样**没有 id**，修复前它按下的 mousedown 一样会冒泡到 `onItemDown(-1)`（同一崩溃路径）；
修复后必须既"不崩"又"照常能缩放"，且**不能把节点整体拖走**。

### 四个坑（新增）

7. **源码级栈要用 dev（:5100）跑**：打包产物栈只有混淆后的行号，定位 `onItemDown` 这种函数还得靠 `pnpm dev`
   直出源码。手势复现脚本按步骤 wrap（每步前后比 `pageErrors.length`），一眼看出是哪一步抛。
8. **别用 heredoc + Python 字符串做补丁**：往 `python - <<'PY'` 里写含 `\n` 的替换串时，是 **Python 在解析
   自己的字符串字面量**时把 `\n` 变成真换行（bash 的 quoted heredoc 本身不转义），落盘后 JS 语法就错了——
   连踩两次。**而且 `str.replace` 不命中时是静默的**（C-H12 里 3 处替换只中 2 处，白跑一轮才知道），
   每一处替换都必须 `assert old in s`。凡是要落含转义序列的代码，**一律用 Write/Edit 工具直接改文件**。
9. **框选 ≠ 单选**：`openSelPrompt` 只在 `rubber`（框选）分支调用 —— C-H9 初版断言「单选点击浮出指令条」是**断言写错**，
   不是产品 bug；写断言前先读触发条件。
10. **重复函数声明 `typecheck:web` 不报，只有 `vite build` 报**：往 `.vue` 的 `<script setup>` 里
    插函数时插重了，`vue-tsc --noEmit` 静默通过、单测也全绿，`pnpm run build:frontend` 才以
    `Identifier 'x' has already been declared` 失败。**改完脚本段必须跑一次真实构建**，别只信 typecheck。

---

## C-H10 多选 / 组合 / 对齐与分布（playwright 无头，14/14）

```bash
# 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
cd /d/artifyfun/Comfy-Desktop && node scripts/wb-canvas-selection-verify.mjs
```

| 断言 | 覆盖 |
|---|---|
| C-H10.0 / 0b | 四张便签落盘就位；**软渲染提示横幅不遮挡右上悬浮工具条**（量 box model + elementFromPoint） |
| C-H10.1 / 2 | Shift 框选 3 个 → 选择栏计数 3；右键菜单「水平等距分布」→ 等距且首尾不动 |
| C-H10.2b / 3 | Shift+点选累加收敛到 2 个；右键「右对齐」（多选整组生效）→ 右缘齐平 |
| C-H10.4 / 5 | 选择栏「水平居中」（中心 = 选区包围盒中心）/「左对齐」（左缘齐平） |
| C-H10.6 / 7 | 选择栏「组合」→ `doc.groups` 成员正确；**组合成员拖角柄不缩放**（设计如此） |
| C-H10.8 | 拖动组内成员 → **整组同步位移**（ΔA 与 ΔB 必须一致）+ 组外物件不动 |
| C-H10.9 | 工具栏「解组」→ `groups` 清空 |
| C-H10.10 | 未组合的多选拖动：**仅被拖者移动**（现状记录，见下） |
| C-H10.11 | 全程无新增页面错误 |

截图：`ch10-multiselect.png`。注意脚本注释里的 `C-H13 多选浮动操作栏` 是**功能实现**编号，与验收脚本编号不是一套。

### 量出一处遮挡缺陷（已修）：软渲染提示横幅压住右上工具条

`.ant-modal-*` 之类的开机遮罩会盖住全屏，测遮挡前必须先把开机弹窗关掉（否则量到的是它，不是真凶）。
去掉遮罩后定位到真凶：**「软件渲染降级提示」横幅与右上悬浮工具条同在 `top-3`** ——

| 指标 | 修复前 | 修复后 |
|---|---|---|
| 横幅 ∩ 工具条 重叠面积 | **20034 px²** | **0 px²** |
| 被遮挡的可用按钮 | **14 / 20**（撤销 / 重做 / 添加便签 / 添加 App 节点 / 运行选中 …） | **0 / 20** |

修法：横幅从 `top-3` 下移到 `top-16`（工具条行高 36px、底部约 48px，下移后不再相交）。

⚠️ **口径坑**：统计"被遮挡"必须**跳过禁用按钮** —— 禁用按钮带 `disabled:pointer-events-none`，
`elementFromPoint` 到它们的坐标会返回**容器**（不是按钮），于是"禁用"被误报成"被遮挡"
（本轮就误报了 6 个：撤销/重做/运行选中/组合/解组/送参考图 —— 全是当下本就该禁用的）。

### 现状记录（不是缺陷，但已固化成断言，改动时会变红）

- **未组合的多选拖动只移动被拖的那一个**：多选 + 拖动 ≠ 整体移动；整体移动的唯一路径是
  「组合 → 拖成员」（`onNodeDragEnd` 里只按 `groups` 成员联动）。要做 Figma 式"多选拖动整体走"，
  需在 `onNodeDrag` 里对 `selection` 做同样处理。
- **组合成员不可单独缩放**：`onResizeStart` 对 `groupOf(id)` 直接 return。

---

## C-H12 撤销/重做 + AI 快照回滚（playwright 无头 11/11 + 单测 9 条）

数据安全网两条腿：**撤销栈**（会话内、上限 60、混合所有操作）与 **AI 快照**（`aiSnapshots.js`，
按项目分组、单项目上限 10、AI 批量改画布前自动打的命名检查点，`docs/research-canvas-agent-benchmark.md` 建议 #6）。

```bash
# 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
cd /d/artifyfun/Comfy-Desktop && node scripts/wb-canvas-snapshot-verify.mjs
cd packages/frontend && npx vitest run src/views/canvas/aiSnapshots.test.js
```

| 断言 | 覆盖 |
|---|---|
| C-H12.0 | 画布就位 + AI 快照预置 1 条（种在**真实 pid** 下） |
| C-H12.1 / 2 | 对齐 → Ctrl+Z 回到对齐前（落盘）→ Ctrl+Shift+Z 重做回对齐后（落盘） |
| C-H12.3 | **撤销后做新动作 → redo 栈被截断**（`pushHistory` 清 future；新动作不被"重做"吃掉） |
| C-H12.4 / 5 | 连按 Ctrl+Z ×14 / Ctrl+Shift+Z ×20 到底到顶 → 不崩、文档仍合法 |
| C-H12.6 | AI 快照面板渲染（1 条 = 1 行） |
| C-H12.7 | 点「恢复此快照」→ 文档回到快照态（4 → 2 物件，id 级断言） |
| C-H12.8 | **回滚本身可撤销**（`restoreAiSnapshot` 内有 `beforeChange()`） |
| C-H12.9 | 删除快照 → 存储该项目清空 + 面板消失 |
| C-H12.10 | 全程无新增页面错误 |

单测（`aiSnapshots.test.js`，纯函数 + 注入 storage）钉住容量语义：单项目 FIFO 上限 10、
全局上限 40（整段淘汰最旧项目）、label 兜底与截断 80、坏 JSON 静默归零、删除命中/未命中。

### 坑：快照按**真实 `activeAppId`** 分组，不是 `'default'`

`useAppNodes` 用 `appStore.config.activeAppId || 'default'` 当分组键。真机上它是真实 app uuid
（本机 `73cf9668-…`），所以种快照必须种到那个键下 —— 首轮种 `'default'` 面板死活不渲染，
诊断打印 `projects` 键才发现。脚本改为从 `<APPDATA>/artify-desktop/artify-apps.json` 的
`config.activeAppId` 读 pid（可用 `--pid` 覆盖）。

### 编号说明

验收脚本用自己的序列（C-H8 / C-H9 / C-H10 / C-H12 …），**与代码注释里的功能实现编号
（C-H11 步级重跑、C-H13 多选浮动操作栏、C-H15~C-H19 …）不是一套**；两者同号时以文件名区分。

---

## C-H14 画布项目 切换 / 重命名 / 删除（playwright 无头，11/11）

```bash
# 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
cd /d/artifyfun/Comfy-Desktop && node scripts/wb-canvas-projects-verify.mjs
```

| 断言 | 覆盖 |
|---|---|
| C-H14.0 | 项目栏就位（3 个项目 / 激活项 / 标题） |
| C-H14.1 | 双击标题内联重命名 → store 的 `title` 与 `doc.name` 同步、`activeId` 不变 |
| C-H14.2 | 点卡片切换 → `activeId` 变 **且画布重装载**（Konva 上只剩新项目的物件 id，旧物件消失） |
| C-H14.3 | 刷新后仍是切换后的项目（持久化 + 重装载） |
| C-H14.4 | 卡片 hover 操作区「笔」→ 内联重命名生效（E4） |
| C-H14.5 | 单卡删除走 `Modal.confirm`：**点取消不删** |
| C-H14.6 | 确认删除 → 项目数 −1 且列表不再有它 |
| C-H14.7 | 软渲染提示横幅不拦截指针（`pointer-events:none`，不挡下拉菜单表头） |
| C-H14.8 | 批量管理：勾选计入按钮文案（`删除所选（n）`）→ 确认 → 批量删除（删到空自动补 1 个） |
| C-H14.9 | 删唯一项目 → 自动补「未命名画布」且**画布清空**（旧节点不残留） |
| C-H14.10 | 全程无新增页面错误 |

截图：`ch14-projects.png`。

### 分层：数据层早已验过，浏览器只验 UI

`projectStore.js` 是纯函数（`addProject/renameProject/deleteProject/switchProject/normalizeStore/
projectCardStats/bootProjectStore`），`projectStore.test.js` 20+ 条 + `composables.test.js`
的 `useCanvasProjects` 段已覆盖容量/边界/迁移/I-O 适配。所以本脚本**不重复**那些断言，
只验浏览器才能证明的：**切换是否真的把画布内容整批换掉**、删除确认的两条路径、批量选择计数。

### 又一处遮挡（同一横幅，已修根因）

`C-H14.8` 第一次跑就撞上「软渲染降级提示」横幅拦截项目下拉菜单表头的按钮（playwright 报
`... intercepts pointer events`）。它与 C-H10.0b 那次（压住右上工具条）是**同一个横幅的两种遮挡**。
上一轮只是把它从 `top-3` 挪到 `top-16`，仍会盖住新出现的浮层 —— 这次改**根因**：
提示横幅整体 `pointer-events-none`，只给关闭按钮 `pointer-events-auto`。
**提示层不是交互层，不该拦截指针**；C-H14.7 把它写成几何+计算样式双断言，避免回归。

### 坑：hover 操作区的按文本定位会"自杀"

卡片内联重命名的输入框是 `v-if="prjRenameId === pr.id"`，进入重命名态后**标题文本进了
`<input value>`**（`innerText` 看不到）→ 用 `hasText: '丙画布'` 过滤出来的 locator **当场失配**，
表现为"点了笔却没出现输入框"（实际是选择器找不到那张卡了）。
正解：**进入重命名态前先记下卡片索引，之后用 `nth(idx)` 按位置定位**。
