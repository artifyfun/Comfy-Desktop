# Workbench 验收（agent-browser 浏览器 E2E）

验收 `artifylab-v2` AI 工作台（独立工作台模式）的核心 AG-UI 桥路径与八条交互流：P1-B3 任务进度卡、B1 工具审批模式（含 edit 参数）、E1 推理强度透传、W4 产物卡、W5 错误气泡、W6 历史回放、W7 流截断兜底。复用 batch-queue / canvas 的 "serve + stub + agent-browser" 方法学，但 stub 复杂度居中（要可注入 SSE 流模拟后端决策，事件形状严格对齐 `src/main/artifylab/agui/types.ts` 21 种 AGUIEvent）。

## 目录结构

```
acceptance/workbench/
├── serve.mjs          # 静态服务器（端口 5175；前端构建产物 + stub 注入）
├── stub.js            # 页面内 IIFE：electronAPI mock + AG-UI SSE 模拟 + 会话/REST
│                      # 拦截 + window.__wbCtl 句柄（含 log 缓冲）
├── screenshots/       # W1–W8 + B1/E1 验收截图
└── README.md
```

## 复跑

```bash
# 1. 构建前端（产物落到 src/main/artifylab/public/frontend，与 canvas/batch 同源）
cd /d/artifyfun/Comfy-Desktop && pnpm run build:frontend

# 2. 启动验收服务器（端口 5175）
node acceptance/workbench/serve.mjs 5175

# 3. 浏览器打开 /workbench
agent-browser open http://127.0.0.1:5175/workbench
```

**自动复跑（推荐，无头、与用户 Chrome 隔离、跑完即退）**：

```bash
node scripts/wb-preview-ui-verify.mjs            # 默认验 W9 预览渲染，失败退出码 1
WB_MSG="规划一个验收任务，包含 todo 步骤" WB_EXPECT=0 \
  WB_SHOT=w1-regression node scripts/wb-preview-ui-verify.mjs   # 换消息当通用场景回归
```

脚本可参数化：`WB_MSG` 换触发消息、`WB_EXPECT=0` 只观测不断言、`WB_SHOT` 换截图基名。
它同时会打印「被 SPA fallback 兜成 HTML 的 /api/* 请求」——stub 缺端点时会立刻显形。

**W10 画布 ops 的 DOM 级验收（打开的是 `/canvas`，不是 `/workbench`）**：

```bash
node acceptance/workbench/serve.mjs 5177
node scripts/wb-canvas-ops-ui-verify.mjs 5177   # 失败退出码 1；截图落 acceptance/workbench/screenshots/w10-*
```

之所以复用本 harness 却能跑画布：画布页内联渲染了 `<Workbench :canvas-embedded="true" />`
侧栏（`canvas/index.vue:11`，`wbOpen` 默认 true），所以 stub 的 SSE 一推
CUSTOM `wb_canvas_ops`，整条 embed 链路（桥 → poller → canvasMode 总线 → 画布页确认卡 →
人审 → 落布）就在一次浏览器里跑通。**必须带 `?session=`**（与 `wb-headless-verify.mjs` 同款开法），
否则内嵌侧栏挂不起来。断言读的是 `artify.canvas.projects.v1`（画布是 Konva 渲染，
数 DOM 拿不到节点/连线）。

> 默认 seed 1 个会话 `s-seed-1 / 验收会话`（含 1 条种子用户消息），并通过 localStorage `wb-stub-persist-v2` 持久化 sessions / eventsHistory（reload 后能模拟服务端 eventStore 回放）。`window.__wbCtl.reset()` 可重载回到 seed（如需清空持久化：`localStorage.removeItem('wb-stub-persist-v2')` 再 reload）。

## 验收矩阵（8 场景全绿）

| # | 验收点 | 截图 |
|---|---|---|
| W1 | **P1-B3 todo_list 进度卡** — 发"规划一个验收任务，包含 todo 步骤"→ 4 行 todo 全显示文本、计数 4/4、对勾终态、流干净收尾（无"对话流中断"红字） | w1-todo-done.png |
| W2 | **B1 工具审批 HITL 卡** — 发"请审批执行这个任务"→ tool_approval_required CUSTOM → 等待审批卡 + 倒计时 + 批准/拒绝/修改参数按钮；点击"批准"→ interaction-response → tool_approval_resolved CUSTOM → 卡翻"已批准 执行模板" + 收尾文本 | w2-approval-pending.png / w2-approval-resolved.png |
| W3 | **E1 推理强度透传 + reasoning 行渲染** — 发"请用推理分析这个任务"→ REASONING_MESSAGE_* 三帧 → 🧠 行展示脑图 + reasoning 文本 | w3-reasoning.png |
| B1+E1 | **approvalMode=conservative / reasoningEffort=high 透传** — localStorage 设 `wb.approvalMode=conservative` + `wb.reasoningEffort=high` → reload 后 footer 显示「保守 / 高」→ 发"请审批推理这个任务"→ stub 控制台打出 `run request {approvalMode:"conservative", reasoningEffort:"high", ...}` 完整透传 | w3-b1-e1-conservative-high.png |
| W4 | **wb_artifact 产物卡** — 发"生成产物图"→ CUSTOM wb_artifact{outputFiles} → applyExecutionSideEffect 'artifact' → 主区右侧栏渲染 2 张缩略图（`/view?filename=&type=output` 占位 PNG） | w4-artifacts.png |
| W5 | **wb_error 错误气泡** — 发"故意出错测试"→ CUSTOM wb_error{message} → applyCustom 'wb_error' → 主区红色错误气泡"执行失败：模型推理超时（stub 演示）" | w5-error.png |
| W6 | **历史回放** — 发"历史回放：规划任务清单"（触发 todos）→ reload → 自动恢复 `s-seed-1` → selectSession → loadHistoryIntoPage 拉 records → 用户气泡按 createdAt 归并 + agent 文本 + todo 卡 4/4 重建 | w6-history-replay.png |
| W7 | **流截断兜底** — 发"测试断流"→ stub truncateAfterFlush=true（不发 RUN_FINISHED）→ flushThread 队列空后 close → 前端 readAguiStream EOF → `!sawRunFinish` 触发 `workbenchStreamInterrupted` 红色错误气泡"对话流中断，本轮未收到完成信号" | w7-stream-interrupted.png |
| W8 | **审批 edit-args** — 发"修改参数执行这个任务"→ tool_approval_required 带 args `{templateId,count,seed,customParam}` → 点击「修改参数」→ textarea 预填美化 JSON → 改 count 4→6 → 保存 → interaction-response action='edit' echoArgs.count=6 / originalArgs.count=4 → tool_approval_resolved 带 finalAction='edit' + finalArgs → 收尾文本"参数已编辑，按新参数放行。" | w8-approval-edit.png |
| W9 | **生成过程直通预览（编排路径）** — 发"我要看实时预览"→ TOOL_CALL_START/ARGS/END 占出工具卡 → 3 帧 CUSTOM `preview_frame{dataUrl}` → 工具卡内渲染 `<img data-testid="exec-preview">`。断言：图在、**真的解码成功**（naturalWidth 128 / naturalHeight 80）、src 是 `data:image/*`、无页面级报错 | w9-preview.png |
| W10 | **画布 ops 全链 + DOM 级确认卡** — 在 **`/canvas`** 发"帮我把模板铺画布搭成工作流"→ stub 推 CUSTOM `wb_canvas_ops{ops,source}`（ops 为 canvasTools 真实形状：`appId` 是模板 id、节点引用走本批 `nodeId`）→ 画布页 `.agent-ops-card` 渲染出「新建应用节点：E2E 文生图 / 图生视频 · 连线 E2E 文生图 → E2E 图生视频 · 选中 2 个物件」。断言：卡文案含节点名且**不暴露内部 nodeId**、确认前节点未落布（人审门有效）→ 点「执行」→ `artify.canvas.projects.v1` 出现 **2 个节点（id 恰为 AI 侧 nodeId）+ 1 条连线** | w10-canvas-ops-card.png / w10-canvas-ops-applied.png |
| W11 | **两个用户报障的回归 + 视图按钮口径**（`scripts/wb-ui-regress-verify.mjs`）— ① 点侧栏「创作资产库」→ 弹窗**当次**可见、点关闭**能关**、点「技能库」**不再连带**弹出资产库；② `/canvas` 点「添加 App 节点」→ 拾取器弹出且**只列带工作流的应用**（空 `template` 被过滤）→ 点一项 → `artify.canvas.projects.v1` 的 `project.doc.objects` 出现 1 个 `type:'app'`、`appId` 正确的节点；③ 枚举四个视图入口断言 **icon↔行为口径一致**（准星=全部适配视图 / expand=重置视图，两栏都是），随后累计平移 4 次把内容推到远处负坐标、新建节点 → 缩放滑杆降到 40% → 点「重置视图」→ 断言 100%、**视口中心世界坐标不变**、正在看的节点仍在画面内 | w11-assetlib-open.png / w11-apppicker.png / w11-canvas-node-added.png / w11-reset-before.png / w11-reset-after.png |
| W12 | **提示词库重写后的渲染与回填**（`scripts/wb-promptlib-ui-verify.mjs`，打开 `/canvas`）— ① 点工具栏「提示词库」→ 面板按**工作流分类**渲染：断言分类数 ≥14、含「模型分档 / 文生图 / 文生视频 / 图生视频 / 图生图 / 图像编辑」、条目 ≥100、**每条都有 hint**；② 搜索「Krea2」→ 条目数从 136 降到 10（验证搜索能命中 hint 里的模型名）；③ 添加便签（自动选中）→ 点「先锁不变项」那条词条 → `project.doc.objects` 里 note.text 追加成功、面板自动关闭 | w12-promptlib-open.png / w12-promptlib-applied.png |

| W13 | **header 弹窗层级（stacking context）**（`scripts/wb-modal-zindex-verify.mjs`，打开 `/canvas`）— ① 画布内开 z-30 浮层（提示词库面板）→ 点 header「关于」→ 断言弹窗遮罩的 **SC 祖先链里没有 header** + 重叠点 `elementsFromPoint` 最上层属于弹窗子树；② 「设置」弹窗同断言 | w13-about-above-canvas.png / w13-config-above-canvas.png |

| W14 | **画布指南弹窗（`scripts/wb-canvas-guide-verify.mjs`，打开 `/canvas`）** — ① 点缩放条罗盘 `[data-testid="canvas-guide-btn"]` → 弹窗 `[data-testid="canvas-guide-modal"]` 出现：侧栏 **2 组 / 12 篇**、正文标题 + 内嵌 SVG 示意图（元素数 > 5）；② 侧栏点「文生图」→ 正文标题随之切换、步骤列表非空、`active` 跟随；③④⑤ **三种关闭口径**各断言残留 = 0：Esc 一次 / `.guide-close` 按钮 / 点遮罩空白区；⑥ 空画布 `[data-testid="canvas-empty-guide-btn"]` → 打开 → Esc 关闭；⑦ 两段加载各自「无新增页面错误」（分段基线对比） | w14-guide-open.png / w14-guide-page-switch.png / w14-guide-closed.png / w14-empty-cta.png / w14-empty-cta-closed.png |
| W16 | **C 模式桥的成功路径（`scripts/wb-cmode-bridge-verify.mjs`，假宿主帧 + iframe `?embed=1`，9/9）** — W15 只验了非嵌入态的降级；`isEmbed` 判定是 `embed=1 \|\| window.parent !== window`（`workbench/index.vue:1498`），**同窗口不算嵌入**，所以真嵌入态只能用 iframe 建。父页当假注入桥（`callBridge` 只按 `type+requestId` 关联 ack，不校验 origin）→ 断言：① `wb_sync{ensureTab:true}` → 宿主收到 `artify:canvas-ops`，`ops[0]={type:'loadWorkflow',newTab:true,name,workflow:{nodes:2,links}}`、`reason:'workbench-sync-template'`，ack ok 后**零错误气泡**；② 无 `ensureTab` → `newTab` 缺省；③ 宿主回 `{ok:false,error}` → 两条事件分别弹「同步到画布失败: 宿主拒绝（测试）」/「执行画布工作流失败: 宿主拒绝（测试）」（**透传宿主错误原文**）；④ 宿主 ack `{ok:true,promptId}` → 推「提交执行…」+「画布工作流已提交执行」 | w16-sync-success.png / w16-bridge-reject.png / w16-canvas-exec-success.png |

| W15 | **执行副作用 CUSTOM 的降级语义（`scripts/wb-custom-sideeffects-verify.mjs`，打开 `/workbench`）** — `wb_sync` / `wb_canvas_exec` 此前零覆盖。三条独立触发词各自隔离：①「同步画布兜底」→ `wb_sync{ensureTab:true}` 在非嵌入态应**静默 skipped**（零错误气泡、本轮正常收尾 —— "执行前自动加载画布"失败不许打断生成流程）；②「同步画布显式」→ 无 `ensureTab` 应 reject → 错误气泡「同步到画布失败」；③「跑一下画布」→ `wb_canvas_exec` 应 reject → 错误气泡「执行画布工作流失败」；④ 三段无新增页面错误 | w15-sync-fallback.png / w15-sync-explicit.png / w15-canvas-exec.png |

> **W14 的两个坑**：① **stub 每次加载都会重写 localStorage**（`stub.js` 在 boot 时无条件 `setItem`，`activeId` 恒回 `p-main`）——想把 activeId 切到 `p-empty`（空画布）不能靠 `page.evaluate` 改 key 再 `reload`，会被 stub 覆盖。解法：`context.route('**/__canvas_stub.js')` 取原始响应体后**在末尾追加**一段切项目的脚本再 fulfill，**不改动 acceptance/canvas/stub.js**（其他用例仍要默认 seed）。② 页面错误要**分段记账**：stub 未 mock 的 8 个 `/api` 端点（`POST /api/config`、`GET /api/batch/queue`、`GET /api/workbench/{sessions,presets,templates,runtime}`、`POST /api/workbench/sessions/create`、`POST /api/canvas/snapshot`）每次 boot 都会因 SPA fallback 返回 HTML 而抛 `Unexpected token '<'`，属既有噪音 → 每段 `reload` 后重置基线，只断言「指南交互本身不新增错误」。
> **W15 的坑**：stub 场景的**触发词不能撞已有正则**。`withApproval` 用 `/审批|执行/` 匹配，
> 所以那条用于触发画布执行的测试消息里**连「审批」「执行」这两个词都不能出现** ——
> 我先写成「执行画布工作流：…」→ 命中审批 → 审批分支 `return` 停在人审卡，6e 帧永远发不出来；
> 第二次改成「跑一下画布上的工作流（不要走审批）」**仍然命中**（「审批」两字在消息里）。
> 另注：`node serve.mjs <port> &` 这种后台起法会被回收，起 harness 要用后台任务方式（或复用已在跑的端口）。

> **W16 的坑（写用例时最花时间的两条）**：① **顺序即正确性** —— canvas-exec 成功会进「执行中」轮询态，
> 之后发送控件被 `!sessionId || busy` 挡住 → 后面的消息**根本发不出去**（首轮把它误判成"桥没回 ack"）。
> 修法：把负路径排在成功执行之前，**不要**靠重新 `setContent` 拿干净 iframe —— stub 会把会话历史还原回来，状态更脏。
> ② **假宿主脚本必须包 IIFE** —— `setContent` 会被调用多次，顶层 `const ACK` 第二次执行直接
> `SyntaxError: Identifier 'ACK' has already been declared` → 宿主监听没装上 → 症状是 `bridge timeout`
> （而不是"脚本报错"，page error 里才有真相）。

> 另注：罗盘按钮在**底部缩放条**（不是被 z-20 提示条压住的顶部工具栏），所以这里 `locator.click()` 可用，不必像 W11 那样强制 `evaluate(el => el.click())`。

> **W14 可跑两条链路**（同一套断言，验证产物与 dev 两条渲染路径）：
> - 产物（默认）：`pnpm run build:frontend` → `node acceptance/canvas/serve.mjs 5174` → `node scripts/wb-canvas-guide-verify.mjs 5174`
> - dev server：`pnpm dev`（面板 vite 在 **5100**）→ `node scripts/wb-canvas-guide-verify.mjs --base http://127.0.0.1:5100 --inject-stub`（截图前缀变 `w14-dev-`）
>
> dev 模式要点：dev server 不注入 stub，故用 `context.addInitScript({ path: acceptance/canvas/stub.js })` 在页面上下文直接跑它；「切空画布」也改成再追加一个 `addInitScript`（**注册顺序 = 执行顺序**，所以在 stub 之后）。另外 **dev 下 `/canvas` 用普通浏览器直接打开会被重定向到 `/about`**（没有 `window.electronAPI` → 走 web config 拿不到 server）——手动走查请开 acceptance 服务器那份。

> **W13 的坑（stacking context 陷阱）**：弹窗 z-index 数字再大也可能输——AppHeader 根元素 `relative z-20` 建立了 stacking context，挂在 header **内部**的弹窗对外只等效 z=20，画布页的 z-30/z-40/z-[80] 浮层全部盖住它。修法是弹窗 `<Teleport to="body">`（与 antd modal 同思路）。诊断时别只读 computed z-index，要看**祖先链上谁建立了 SC**（`elementsFromPoint` 是最可靠的最终判据）。变异验证：去掉 Teleport → 脚本立刻报「弹窗仍挂在 header 的 stacking context 里」。

> **W12 的坑**：工具栏「提示词库」按钮是**开关**（`promptLib.open = !promptLib.open`）——面板已开时再点会关掉。脚本里必须先判断面板是否已开再决定点不点（本轮就因此误判过一次"找不到词条"）。

> W10 补的是**渲染层**：单元/契约测试已钉住载荷与语义（`routes/agui.test.ts` / `__tests__/aguiBridge.test.js` / `__tests__/useExecutionPolling.test.js` / `canvas/composables.test.js`），但「画布页真的弹出卡、确认后**连线真的建出来**」需要浏览器证据。变异验证：把 stub 的 CUSTOM 帧改名 → 脚本立刻报「未出现确认卡」。

> **W11 的两个坑（照抄别踩）**：① 首屏会自动弹「使用指南」（`GUIDE_SEEN_KEY` localStorage 标记），遮罩会拦住所有点击 → 每次 `goto` 后先点掉 `.ant-modal-close`；② 画布顶部提示条（z-20，如"检测到软件渲染已降级"）会压住工具栏 → 工具栏按钮用 `evaluate(el => el.click())` 直接分发，别用 `locator.click()`（会一直等 actionability 超时）。③ 读画布状态必须走 **`project.doc.objects`**（不是 `project.objects`）——形状按 `projectStore.js` 来，猜形状会读出一片空、把产品 bug 误判成"没落节点"（本轮就自摆了一次）。
> 变异验证：删掉 `assetLibOpen` 声明（还原原始缺陷）→ 脚本立刻报「点『创作资产库』当次没弹出」。
> **W11 ③ 的测量要点**：视图状态有「实时（响应式 `viewport`）」与「落盘（`project.doc.viewport`）」两份，读错那一份会得出相反结论——
> - 状态栏的 `NN%` 读数是**实时**缩放的可靠探针（`readZoomPct`）；落盘值只在 `saveSoon`（500ms 防抖）之后才更新
> - 平移/缩放不落盘、而 `resetView`/`fitAll` 现在会调 `saveSoon` → 断言「重置后落盘视口 = 新值」本身就是**持久化生效**的验证
> - 造「内容远离原点」必须**累计平移**（单次拖拽受窗口边界限制，最多几百像素）；判据用「视口中心世界坐标不变 + 正在看的节点仍在画面内」，不要用「内容包围盒中心可见」——内容散布很开时包围盒中心恰是空白区，那条判据会放过一个看起来仍然是空画布的坏实现
> 变异验证：把 `resetView` 还原成 `makeViewport()`（`{1,0,0}`）→ 脚本报「重置视图移动了视口中心」，节点屏幕位置 (-2691,-1756) 在画面外。

> W9 与 `scripts/wb-preview-verify.mjs` 互补：后者验**真机 ComfyUI**的协议与帧解码（能力协商 / 8 字节头剥离），W9 验**前端渲染链路**（AG-UI → aguiBridge → 消息 → 工具卡 `<img>`）。两段合起来才是 #5 的完整证据。

### 控制台透传证据（B1/E1 / W8 验收关键）

```bash
# B1/E1：run request 透传 approvalMode + reasoningEffort
agent-browser eval 'window.__stubLogs.find(l=>/run request/.test(l))'
# → [workbench-stub] run request {"runId":"ng-...","threadId":"t-stub",
#    "approvalMode":"conservative","reasoningEffort":"high",
#    "inputPreview":"请审批推理这个任务"}

# W8：interaction-response 透传 edit args + 回带 originalArgs
agent-browser eval 'window.__stubLogs.find(l=>/interaction-response/.test(l))'
# → [workbench-stub] interaction-response {"requestId":"req-...","action":"edit",
#    "echoArgs":{"templateId":"portrait_lora","count":6,"seed":42,"customParam":"可编辑"},
#    "originalArgs":{"templateId":"portrait_lora","count":4,"seed":42,"customParam":"可编辑"}}
```

每帧 AG-UI 事件亦同步入日志：`[workbench-stub] emit RUN_STARTED ...` / `REASONING_MESSAGE_START ...` / `CUSTOM ...`（详见 stub.js `console.log('[workbench-stub] emit', ...)`，便于核对后端帧序列与重放对账）。

## 协议契约要点（前端解析依据 = 后端 stub 必须遵循）

**帧格式（types.ts:278 encodeSseFrame）**：`data: {"type":"...","timestamp":...}\n\n` —— 不发 `event:` 行，类型在 JSON type 字段内。

**类型命名（registry）：`SCREAMING_SNAKE_CASE` 全集 21 种**（types.ts AGUI_EVENT_TYPES）。前端 handlers.js dispatch 只识别大写；`run:start`/`text:delta` 等小写冒号式会被静默忽略（**这是初版 stub todo 卡显示但行文本空白的根因**——事件全被丢弃，仅 CUSTOM 名旁路映射漏出导致 0/4 计数而非真正识别）。

**todos item 形状**：每条 `{ text: string, completed: boolean }`（codexMapper.test.ts L365：`items: [{ text: '收尾', completed: true }]`；ProgressCard.vue L192/193 `isTodoDone`/`todoText` 双字段读取）。初版 stub 用 `{ id, content, status, activeForm }` 导致行文本空白 + 计数恒 0。

**列表端点响应包 `{ data: [...] }`**（index.vue L1363/1376/1384/3088/3344：`json?.data ?? []`）。sessions / presets / skills / templates 均此形状。初版返回裸数组会致会话列表恒空（与 canvas README "前端 API 路径前缀" 同根问题——契约文档化必要性）。

**会话详情端点返回 OkEnvelope `{ success: true, data: session }`**（index.vue L1396-1402：`if (!res.ok || !json?.success) return; const session = json.data`）。初版 stub 直接返回裸 session 对象导致 selectSession 提前 return、消息区空白。

**审批 CUSTOM value 字段名是 `args`（C15 契约），不是 `arguments`**（approvalGate.ts L121-141 `toolApprovalRequiredValue`：`args: request.args`，前端 InteractionApprovalCard.vue L7 props 读 `approval.args`；L282 `editText.value = prettify(props.approval && props.approval.args)`）。初版 stub 用 `arguments: args` 导致 textarea 预填永远 `{}`、edit 提交链条断裂——W8 验收发现并修复。

**wb_artifact 形状**：`{ promptId, name, outputs:[filename], outputFiles:[{filename,subfolder,type}] }`（applyExecutionSideEffect 'artifact' 直接消费；`/view?filename=&subfolder=&type=` 走占位 PNG，stub 提供 1x1 base64 防 404）。

**wb_error 形状**：`{ itemId, message }` → applyCustom 'wb_error' → pushMsg `{ kind:'error', text: message }` 红色气泡。

**成功信封是 `{ ok:true, success:true, code:200, data }`**（`createSuccessResponse`，`src/main/artifylab/utils/errorHandler.ts:93`）。**只给 `{data}` 会踩坑**：`appStore.initConfig` 判 `if (response.ok && response.data)`，缺 `ok` 就 `throw new Error('配置加载失败')`。注意各消费方读法不一——列表端点读 `json.data`（`listResp` 只给 `{data}` 够用），`/api/config` 必须带 `ok`。

**工具调用三帧（W9 引入）**：`TOOL_CALL_START{toolCallId,toolCallName}` → `TOOL_CALL_ARGS{toolCallId,delta}`（可多次累积）→ `TOOL_CALL_END{toolCallId}`。`utils/agui/handlers.js:20-22` 映射为桥内键 `tool:start{name}` / `tool:args{args}`（**END 时才一次性派发累积值**）/ `tool:result{content}`。缺这三帧就没有带 `toolItem` 的消息，后续 `preview_frame` 无处可挂——**顺序不能反**。

**preview_frame 形状**：`{ promptId, dataUrl, at }` → applyCustom 'preview_frame' → 挂到**最近一条带 `toolItem` 的消息**（`aguiBridge.js:313-326`）→ 工具卡渲染 `<img data-testid="exec-preview">`。这是"编排路径下能看到在画什么"的前端落点；快路径的轮询预览走 progress 消息（`useExecutionPolling`），两条互不干扰。

**wb_canvas_ops 形状**：`{ ops, source }` → applyCustom 'wb_canvas_ops' → `pageApi.applyExecutionSideEffect('canvas-ops', value)`（`sideEffect` 来自 **pageApi**，`aguiBridge.js:308`，不是桥的独立参数）→ `useExecutionPolling` 分支：**仅 `isCanvasEmbedded` 才 `emitOps`**（`utils/canvasMode` 的**页内总线**，不是 postMessage），否则推「无宿主画布」错误气泡。`ops` 元素形状见 `workbench/plan.ts` 的 `CanvasAgentOp`——关键：`add_app_node.nodeId` 是 AI 侧引用名，`connect_nodes.from/to` 与 `select_nodes.ids` 引用**同批 nodeId**（画布对象 id 由前端 `makeAppNode` 生成，AI 侧拿不到）。

**`POST /api/apps/detail` 必须 mock**（W10 需要）：画布 App 节点挂载时拉详情，id 是**模板 id**（`app:<uuid>`）。真实路由在应用中心查不到时会**回退模板库**（`routes/apps.ts:56-70`，注释写明专为 `wb_build_workflow` 铺出的节点而加）——stub 不 mock 的话这条路会落到 SPA fallback 拿到 HTML，前端弹**两条红色「获取应用失败」**，验收截图看起来像产品故障（其实是 harness 缺口）。

**W11 新增的三个端点**（形状照真实路由，别自造）：
- `POST /api/apps` → `okResp([...])`：应用列表，`appStore.loadApps` 读 `json.data`。画布拾取器**只列带工作流的应用**（`template.prompt` 非空）——stub 里故意放一个空 `template` 的项，用来断言过滤生效。
- `GET /api/workbench/assets` → `okResp({ total, assets })`：创作资产库内容（`AssetLibrary` 读 `json.data` → `.assets`）。
- `GET /api/workbench/skills` → `okResp([...])`：技能库内容（`SkillManager` 读 `json.data`）。

## stub 设计要点

- **electronAPI mock**：8 行，`server_origin = location.origin`，保证 workbench 路由守卫不兜底跳 `/about`（与 canvas/batch 同模式）。
- **会话/REST seed**：1 个 seed 会话（s-seed-1 含 1 条种子用户消息「回放测试：规划任务并生成产物」）+ 4 个 list 端点（sessions / presets / skills / templates）均返回 `{ data: [...] }`；archive 过滤对齐 `?archived=true`；session GET 返回 OkEnvelope。
- **持久化（localStorage v2）**：sessions / nextId / eventsHistory → JSON 序列化写入 `wb-stub-persist-v2`，stub 装载时优先 restore，模拟真实后端 eventStore 持久化（reload 后 eventsHistory 不丢，配合 loadHistoryIntoPage 完成 W6 历史回放）。recordEvent 高频调用直接同步 persist（每帧记录后全量写，records 总量 ~几十条可接受）。
- **AG-UI SSE 模拟器**（核心）：每个 `threadId` 一个常驻 `ReadableStream` controller + 帧队列 + flush 定时器（70ms / 帧）。
  - 主轮：调用 `script(threadId, runId, input)` 根据输入 regex 触发 todos/reasoning/approval/edit-args/artifact/error/truncate 七类事件序列。
  - 持久流的关键设计：`interaction-response` 端点向**同一 threadId 的常驻流**追推 `tool_approval_resolved` + 收尾帧（不重开连接），对齐真实后端 `approvalGate.onResolved → emit → sendFrame` 同流回路。
  - RUN_FINISHED 或 truncateAfterFlush 置 true 后 flush 队列清空即 close（**两处检查**：flushThread 首次入场的 empty 分支 + tick 收尾的 empty 分支——初版漏了后者导致 W7 断流场景流永远不关）。
  - eventsHistory 同步：每帧 pushFrame → recordEvent → persist，content 字段是 AG-UI 事件 JSON 原文（historyReassembler.parseEvent 直接消费）。
- **窗口持久化**：`window.__wbCtl = { reset, sessions, pendingApprovals, threads, eventsHistory, logs, clearLogs }`；`logs` getter 返回 `window.__stubLogs`（IIFE 内 `console.log/warn` 已 patch，捕获所有 stub 帧日志便于 agent-browser eval 抓取）。
- **场景触发正则**：
  - `withTodos`: `/规划|任务|验收|todo/i` → CUSTOM todos 多帧（initial 0/4 + done 4/4，触发 ProgressCard 原位 upsert）。
  - `withReasoning`: `/思考|推理|reasoning|thinking/i` → REASONING_MESSAGE_START/CONTENT/END。
  - `withApproval`: `/审批|执行|approval/i` → CUSTOM tool_approval_required，RUN_FINISHED 推迟到 interaction-response 之后。
  - `withEditArgs`: `/修改参数|edit args/i` → 同 approval 分支但 args 含可编辑字段（templateId/count/seed/customParam），interaction-response action='edit' 时 echoArgs + originalArgs 双打日志供断言。
  - `withArtifacts`: `/产物|artifacts|生成图/i` → CUSTOM wb_artifact{outputFiles}（2 个 1x1 占位图）。
  - `withError`: `/错误|wb_error|fail|出错/i` → CUSTOM wb_error{message}。
  - `withTruncate`: `/断流|truncate/i` → truncateAfterFlush=true、不发 RUN_FINISHED，触发前端 workbenchStreamInterrupted 兜底。
  - 命中多个独立叠加（W3 演示场景："请审批推理这个任务" 命中 reasoning + approval + 隐式 todos）。

## 与 canvas/batch 验收方法学的差异

| 维度 | batch-queue | canvas | workbench |
|---|---|---|---|
| 后端契约 | batchRunner 队列状态机 | 无（纯前端 localStorage） | AG-UI SSE 21 种事件类型 + REST `{data:[]}` + OkEnvelope + localStorage 持久化 |
| stub 复杂度 | 高（14 路由 + 状态机） | 低（seed 一次性） | 中（常驻 SSE + 同流 late-enqueue + 持久化 + 占位 /view 路由） |
| 关键修复 | 路径前缀 `/batch` 漏配 | electronAPI mock 缺失 | type 命名小写 vs registry 大写 + todos item 字段错 + list 端点包 `{data}` + session GET 信封 + approval value.字段名（args vs arguments）+ flushThread 截断 close 分支遗漏 + 引导期端点未 mock（SPA fallback 返 HTML → JSON.parse 炸）+ TOOL_CALL 三帧缺失致 preview_frame 无落点 |
| 验收矩阵 | T1–T7 队列 | C0–C6 画布 | W1–W8 + B1 + E1 |

## agent-browser Windows 经验（workbench 专属）

- **send 按钮 ref 会变**：每次 reload 后 ref 重排，发消息前必须先 `snapshot -i` 取最新 ref。Composer 按钮无 data-testid，用 title/类选择器定位最稳：`[...document.querySelectorAll('button')].find(b => b.title === '发送' || b.querySelector('.fa-arrow-up'))`。
- **按钮被覆盖点击失败**：InteractionApprovalCard 的「确认修改」「批准」/「拒绝」/「修改参数」按钮位于 textarea / card 内部，agent-browser `click` 的覆盖检测经常误判 textarea 遮挡（agent-browser click 中心点检测保守）。规避：用 `agent-browser eval` 直接 DOM `.click()`：`document.querySelector('[data-testid=approval-edit-submit]').click()`。
- **input 重置时机**：submit 后 Vue 自动清空 textarea；若 `click` 紧接着 `type`，文本可能丢焦点；click 后加 `sleep 0.3` 再 type 较稳。
- **stub IIFE 仅 load 时执行**：stub 改完后必须 `agent-browser reload`（不是 `eval`）才能生效；reload 后所有 ref 重排。
- **日志抓取**：stub IIFE 末尾 `console.log/warn` 已 patch 到 `window.__stubLogs`；`__wbCtl.clearLogs()` 用 splice（**勿直接赋 `__stubLogs = []`，会断开 patchLogs 闭包引用**）。
- **输入框 text 残留**：reload 后 session 输入框会保留旧值（Vue 未 mount 完整清空）；agent-browser type 前不需要主动清空（type 会覆盖），但若想 reload 后空态发送，**先 eval 清空 + dispatch input 事件**：input.value=''; input.dispatchEvent(new Event('input', {bubbles:true}))。

## 已知遗留 / 未覆盖

- **附件流程**：composer 的 draftAttachments 流程未触发（stub 不模拟附件 → 后端 decide 路径）。
- ✅ **wb_canvas_ops** 已由 **W10** 覆盖；**wb_sync / wb_canvas_exec** 的非嵌入降级语义由 **W15**（5/5）、
  **C 模式（iframe `?embed=1` + 注入桥）的成功路径**由 **W16**（`scripts/wb-cmode-bridge-verify.mjs`，9/9）覆盖。
  ⬜ 仍未覆盖：真 **注入桥**（`inject/card_bridge.js` 在真 ComfyUI 页面里跑 `applyCanvasOps` / `graphToPrompt`
  → 真服务端提交）—— W16 用假宿主帧验的是**工作台这一侧**的协议形状与错误透传；桥那一侧的落布/执行需真宿主页面。
  另注：`/canvas` 侧栏那种**同窗口**内嵌**不算** `isEmbed`（判定见 `workbench/index.vue:1498`），
  那条路由 `wb_canvas_ops` + 页内总线走（W10/S11 已覆盖）。
- **approval 超时倒计时**：InteractionApprovalCard 倒计时 UI 已渲染但 stub 不模拟超时分支（需后端 emit 倒计时归零 reject 兜底才能验证）。
- **多窗口审批 race**：同 threadId 两窗口同时打开、互相 approve 的 race 未验（需要 stub 支持并发流）。

> 2026-09-15 补齐（两批）：① `/api/config`、`/api/batch/queue`、`/api/workbench/runtime` 三个引导期端点此前未 mock，fetch 落到 SPA fallback 拿到 index.html，前端 `JSON.parse` 抛 `Unexpected token '<'`。该报错与场景无关（对照实验：发一条不命中任何场景的消息同样出现），但会淹没真实回归信号——现已补上。② `POST /api/apps/detail`（W10 需要）同上，不补会让画布节点弹两条红色「获取应用失败」。

## 复跑验收脚本（可粘贴）

```bash
# 启动
node acceptance/workbench/serve.mjs 5175 &
sleep 1
agent-browser open http://127.0.0.1:5175/workbench
sleep 4

# —— 通用：输入并发送（send 按钮无 testid，用 DOM 选择器）——
# agent-browser eval 必须每次取最新 ref；ref 仅在本示例内有效
SEND() {
  local msg="$1"
  local ti=$2  # textarea ref
  local si=$3  # send ref
  agent-browser click $ti; sleep 0.3
  agent-browser type $ti "$msg"; sleep 0.3
  agent-browser eval "(()=>{const b=[...document.querySelectorAll('button')].find(x=>x.title==='发送'||x.querySelector('.fa-arrow-up'));if(!b)return'NO BTN';b.click();return'CLICKED';})()"
}

# W1 todo
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "规划一个验收任务，包含 todo 步骤" e25 e30
sleep 3
# 断言：4 行 todo + 4/4 + 无 stream interrupted
agent-browser eval 'JSON.stringify({rows:document.querySelectorAll(".progress-card--todo [data-testid=progress-row]").length, header:document.querySelector(".progress-card--todo [data-testid=progress-count]")?.innerText, ok:!document.body.innerText.includes("对话流中断")})'

# W2 approval — 触发审批卡 + 点击批准
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "请审批执行这个任务" e25 e30
sleep 2
agent-browser eval 'document.querySelectorAll("button").forEach(b=>{if(b.innerText.trim()==="批准")b.click()})'; sleep 2
agent-browser eval 'JSON.stringify({approved:document.body.innerText.includes("已批准")})'

# W3 reasoning
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "请用推理分析这个任务" e25 e30
sleep 3
agent-browser eval 'JSON.stringify({brain:[...document.querySelectorAll(".fa-brain")].length, snap:!!document.body.innerText.match(/正在规划任务步骤/)})'

# W4 wb_artifact 产物卡
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "生成产物图" e25 e30
sleep 3
agent-browser eval 'JSON.stringify({thumbs:[...document.querySelectorAll(".composer .image-grid img, [data-testid=artifact-thumb]")].length})'

# W5 wb_error 错误气泡
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "故意出错测试" e25 e30
sleep 3
agent-browser eval 'JSON.stringify({errText:document.body.innerText.includes("执行失败：模型推理超时（stub 演示）")})'

# W6 历史回放
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "历史回放：规划任务清单" e25 e30
sleep 3  # 等 RUN_FINISHED 入库 + persist
agent-browser reload; sleep 3
agent-browser eval 'JSON.stringify({userMsg:document.body.innerText.includes("历史回放：规划任务清单"), agentText:document.body.innerText.includes("任务规划如下"), todo4:document.body.innerText.includes("4/4")})'

# W7 stream 截断兜底
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "测试断流" e25 e30
sleep 6
agent-browser eval 'JSON.stringify({interrupt:document.body.innerText.includes("对话流中断，本轮未收到完成信号")})'

# W8 approval edit-args
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "修改参数执行这个任务" e25 e30
sleep 3
# 进入编辑面板（按钮 ref 每次 reload 后变，用 DOM 直点最稳）
agent-browser eval '(()=>{const b=[...document.querySelectorAll("button")].find(x=>x.innerText.trim()==="修改参数");if(!b)return"NO EDIT BTN";b.click();return"EDIT_OPENED";})()'
sleep 1
# 改 count 4→6 + 触发 v-model input 事件
agent-browser eval '(()=>{const t=document.querySelector("[data-testid=approval-edit-textarea]");t.value=t.value.replace("\"count\": 4","\"count\": 6");t.dispatchEvent(new Event("input",{bubbles:true}));return"VAL="+t.value;})()'
# 提交（按钮常被 textarea 覆盖，用 eval 直点）
agent-browser eval 'document.querySelector("[data-testid=approval-edit-submit]").click()'
sleep 2.5
# 断言终态 + 透传证据
agent-browser eval 'JSON.stringify({finalText:document.body.innerText.includes("参数已编辑"), approved:document.body.innerText.includes("已批准"), log:window.__stubLogs.find(l=>/interaction-response/.test(l))})'

# B1/E1 透传
agent-browser eval 'localStorage.setItem("wb.approvalMode","conservative");localStorage.setItem("wb.reasoningEffort","high")'
agent-browser reload; sleep 1.5
agent-browser eval 'window.__wbCtl.clearLogs()'
SEND "请审批推理这个任务" e25 e30
sleep 3
agent-browser eval 'window.__stubLogs.find(l=>/run request/.test(l))'

# 收尾
agent-browser close
```
---

## 平台生成能力验证（S 矩阵）—— 真应用 + 真 ComfyUI，不走 stub

与上面 W/C 编号的**浏览器验收**是两套东西：S 矩阵打的是**真应用（:3008）+ 真 ComfyUI（:8188）**，
断言落在「ComfyUI history 入参 / 落盘产物 / ffprobe 规格」上，因此**没有截图**，证据是 JSON 与产物文件本身。

**总入口（推荐）**：

```bash
cd /d/artifyfun/Comfy-Desktop
node scripts/wb-platform-verify-all.mjs                 # core：S1 + S6
node scripts/wb-platform-verify-all.mjs --group agent   # S2 / S3 / S5
node scripts/wb-platform-verify-all.mjs --group video   # S1v / S4b（耗时，走 H3）
node scripts/wb-platform-verify-all.mjs --group batch   # S9 批量队列真跑
node scripts/wb-platform-verify-all.mjs --group all     # 全部
node scripts/wb-platform-verify-all.mjs --only s1,s6    # 指定场景
```

**前置**：应用在跑 + ComfyUI 就绪。本机 shell 带 `ELECTRON_RUN_AS_NODE=1`，必须去掉它再启动，
否则 Electron 会被当纯 Node 跑（表现为「启动即退出、无进程、不写 app.log」）：

```bash
env -u ELECTRON_RUN_AS_NODE pnpm dev     # dev 与打包版抢 3008，先停另一个
```

| 场景 | 脚本 | 断言 | 状态 |
|---|---|---|---|
| **S0** 前置自检 | `wb-platform-generation-verify.mjs`（随 S1 一起跑） | 应用/ComfyUI/GPU/模板 id 口径/LLM 供应商 | ✅ 5/5 |
| **S1** 直连生图 | 同上（`--template <app>`） | L1 入参真透传 → L2 执行成功 → L3 **正式保存产物**（只有 temp 预览=不通过）+ 解码取样防纯色 | ✅ |
| **S1v** 直连生视频 768p | 同上（`--params` + `--expect-video-size`） | L1/L2/L3 + **ffprobe 规格** + **抽帧算相邻帧像素差**（判画面真在动） | ✅ 14/14 |
| **S2** 自然语言 → agent 跑既有 app | `wb-platform-agent-verify.mjs --scenario s2` | 抓 agent 真实工具调用 + plan 分派，回会话/history/磁盘三层核对 | ✅ |
| **S3** 工作台新建生图 app | 同上 `--scenario s3` | agent `validate → publish → execute → get_outputs` 全链，产物落 `output/` | ✅ 10/10 |
| **S4b** 新建视频 app（有界迭代） | 同上 `--scenario s4b` | 同上 + 视频规格；指令写死 `validate ≤3 / publish ≤1` | ✅ 11/11 |
| **S5** 版本化迭代 | 同上 `--scenario s5` | `app_versions` 新增快照且最大快照号 +1（生效版本 = 最大 +1）、新尺寸真出图 | ✅ 12/12 |
| **S6** 异常路径 | `wb-platform-negative-verify.mjs` | 不存在的 id/模型、越界尺寸、空输入、**取消链路**；每步查「无脏 job / 无产物误登记」 | ✅ 14/14 |
| **S8** 真实上传路径 | `wb-platform-upload-verify.mjs` | multipart 上传 → 201+meta → 落 ComfyUI input → 会话登记附件 → **裸文件名透传执行**（L1 history 命中）→ L2 → L3 产物 ≠ 上传源 | ✅ 9/9 |
| **S9** 批量队列真跑 | `wb-platform-batch-verify.mjs` | start→running→**pause**（在跑条计 failed）→**job-resume** 续跑→completed→产物落盘解码→rerun→**cancel 排队任务=移出队列**→清理无脏 job；**全程不设 autoShutdown/notifyUrl** | ✅ 11/11 |
| **S10** 工作台新建图生视频 app（I2V） | `wb-platform-agent-verify.mjs --scenario s10` | 预上传首帧图（真实 upload 端点）→ agent 基于 T2V 建 I2V app（**必须走 `MiniMaxH3AddGuide` VAE 引导帧**，`MiniMaxH3ImageToVideo` 会走文本编码器视觉塔、在 int8_convrot 编码器上抛 `dequantize_int8_embedding` NoCapableBackendError）→ 真跑 → ffprobe + **首帧 Pearson r≥0.4 对上传源图** | ✅ 15/15（r=0.971） |
| **S11** 画布 AI 真实生成→产物回画布 | `wb-platform-canvas-e2e-verify.mjs`（**前置：画布 harness 5174**） | **从应用自身打开 `/canvas`**（同源真 SSE；⚠️ 别用 playwright route 代理 /api——route.fulfill 缓冲 SSE，客户端断开后端即取消整轮）→ 真会话 + 真指令 → **自动批准工具人审卡**（`approval-approve`；wb_execute_template 默认要人审）→ `.agent-ops-card` → 点执行 → doc 落 app 节点 + 会话 success + 产物落盘 | ✅ 8/8 |

**辅助脚本**：`wb-template-health.mjs`（只读）用本机 `/object_info` 静态对照每个 app 模板的 prompt，
找两类**节点版本漂移** —— `required_missing`（必填输入没给）与 `input_not_in_node`（连了本机不存在的输入口）。
⚠️ `input_not_in_node` 只是**静态标红、不等于坏**：是否影响执行取决于该节点是否在输出路径上，需实测。

**结论与遗留**：见 `docs/workbench-generation-verify-report.md`（S0–S6 全部场景已封闭）。

**已知失效脚本（别照着跑）**：`scripts/wb-headless-verify.mjs` 等的是 `[data-testid="plan-option"]`，
而 `acceptance/workbench/stub.js` **没有 plan 场景**（正确的帧名是 `CUSTOM plan_proposed`，见 `aguiBridge.js`），
所以它必然 200s 超时失败。**plan 分派这条路径现在由 S2 / S3 / S4b 用真应用覆盖**（那三条都会走 plan 或工具链），
所以此脚本建议按「退役」处理；若仍要保留，需要先给 stub 补 plan 场景。
