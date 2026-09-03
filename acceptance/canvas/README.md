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

- **E3 chip 渲染**截图中文本 `@[图A]` 仍以原语法显示，未观察到 chip 高亮染色（可能 chip 仅在编辑态 mirror 层呈现）
- **D1a 笔刷涂抹交互**未实测（拖动涂抹 stroke 路径）；打开对话框 + UI 完整呈现已确认
- **A1 引用注入 / A3 IME 守卫 / A4 粘贴图 / B1 审批模式 / E1 推理强度** 等 workbench 内嵌功能依赖 Workbench 侧栏会话，未在 canvas stub 中桩（需在 workbench 单独验收环境跑）
- **D2 digest → wb_canvas_ops 链路**需 agent 后端，未在本环境验证
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
