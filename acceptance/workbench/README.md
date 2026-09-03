# Workbench 验收（agent-browser 浏览器 E2E）

验收 `artifylab-v2` AI 工作台（独立工作台模式）的核心 AG-UI 桥路径与三条交互流：P1-B3 任务进度卡、B1 工具审批模式、E1 推理强度透传。复用 batch-queue / canvas 的 "serve + stub + agent-browser" 方法学，但 stub 复杂度居中（要可注入 SSE 流模拟后端决策，事件形状严格对齐 `src/main/artifylab/agui/types.ts` 21 种 AGUIEvent）。

## 目录结构

```
acceptance/workbench/
├── serve.mjs          # 静态服务器（端口 5175；前端构建产物 + stub 注入）
├── stub.js            # 页面内 IIFE：electronAPI mock + AG-UI SSE 模拟 + 会话/REST
│                      # 拦截 + window.__wbCtl 句柄（含 log 缓冲）
├── screenshots/       # W1–W3 + B1/E1 验收截图
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

> 默认 seed 1 个会话 `s-seed-1 / 验收会话`。`window.__wbCtl.reset()` 可重载回到 seed。

## 验收矩阵（5 场景全绿）

| # | 验收点 | 截图 |
|---|---|---|
| W1 | **P1-B3 todo_list 进度卡** — 发"规划一个验收任务，包含 todo 步骤"→ 4 行 todo 全显示文本、计数 4/4、对勾终态、流干净收尾（无"对话流中断"红字） | w1-todo-done.png |
| W2 | **B1 工具审批 HITL 卡** — 发"请审批执行这个任务"→ tool_approval_required CUSTOM → 等待审批卡 + 倒计时 + 批准/拒绝/修改参数按钮；点击"批准"→ interaction-response → tool_approval_resolved CUSTOM → 卡翻"已批准 执行模板" + 收尾文本 | w2-approval-pending.png / w2-approval-resolved.png |
| W3 | **E1 推理强度透传 + reasoning 行渲染** — 发"请用推理分析这个任务"→ REASONING_MESSAGE_* 三帧 → 🧠 行展示脑图 + reasoning 文本 | w3-reasoning.png |
| B1+E1 | **approvalMode=conservative / reasoningEffort=high 透传** — localStorage 设 `wb.approvalMode=conservative` + `wb.reasoningEffort=high` → reload 后 footer 显示「保守 / 高」→ 发"请审批推理这个任务"→ stub 控制台打出 `run request {approvalMode:"conservative", reasoningEffort:"high", ...}` 完整透传 | w3-b1-e1-conservative-high.png |

### 控制台透传证据（B1/E1 验收关键）

```bash
agent-browser eval 'window.__stubLogs.find(l=>/run request/.test(l))'
# → [workbench-stub] run request {"runId":"ng-...","threadId":"t-stub",
#    "approvalMode":"conservative","reasoningEffort":"high",
#    "inputPreview":"请审批推理这个任务"}
```

每帧 AG-UI 事件亦同步入日志：`[workbench-stub] emit RUN_STARTED ...` / `REASONING_MESSAGE_START ...` / `CUSTOM ...`（详见 stub.js `console.log('[workbench-stub] emit', ...)`，便于核对后端帧序列与重放对账）。

## 协议契约要点（前端解析依据 = 后端 stub 必须遵循）

**帧格式（types.ts:278 encodeSseFrame）**：`data: {"type":"...","timestamp":...}\n\n` —— 不发 `event:` 行，类型在 JSON type 字段内。

**类型命名（registry）：`SCREAMING_SNAKE_CASE` 全集 21 种**（types.ts AGUI_EVENT_TYPES）。前端 handlers.js dispatch 只识别大写；`run:start`/`text:delta` 等小写冒号式会被静默忽略（**这是初版 stub todo 卡显示但行文本空白的根因**——事件全被丢弃，仅 CUSTOM 名旁路映射漏出导致 0/4 计数而非真正识别）。

**todos item 形状**：每条 `{ text: string, completed: boolean }`（codexMapper.test.ts L365：`items: [{ text: '收尾', completed: true }]`；ProgressCard.vue L192/193 `isTodoDone`/`todoText` 双字段读取）。初版 stub 用 `{ id, content, status, activeForm }` 导致行文本空白 + 计数恒 0。

**列表端点响应包 `{ data: [...] }`**（index.vue L1363/1376/1384/3088/3344：`json?.data ?? []`）。sessions / presets / skills / templates 均此形状。初版返回裸数组会致会话列表恒空（与 canvas README "前端 API 路径前缀" 同根问题——契约文档化必要性）。

## stub 设计要点

- **electronAPI mock**：8 行，`server_origin = location.origin`，保证 workbench 路由守卫不兜底跳 `/about`（与 canvas/batch 同模式）。
- **会话/REST seed**：1 个 seed 会话 + 4 个 list 端点（sessions / presets / skills / templates）均返回 `{ data: [...] }`；archive 过滤对齐 `?archived=true`。
- **AG-UI SSE 模拟器**（核心）：每个 `threadId` 一个常驻 `ReadableStream` controller + 帧队列 + flush 定时器（70ms / 帧）。
  - 主轮：调用 `script(threadId, runId, input)` 根据输入 regex 触发 todos/reasoning/approval 三类事件序列。
  - 持久流的关键设计：`interaction-response` 端点向**同一 threadId 的常驻流**追推 `tool_approval_resolved` + 收尾帧（不重开连接），对齐真实后端 `approvalGate.onResolved → emit → sendFrame` 同流回路。
  - RUN_FINISHED 后 flush 队列清空即 close（`doneEnqueued` 标志防早关）。
- **窗口持久化**：`window.__wbCtl = { sessions, pendingApprovals, threads, logs, clearLogs, reset }`；`logs` getter 返回 `window.__stubLogs`（IIFE 内 `console.log/warn` 已 patch，捕获所有 stub 帧日志便于 agent-browser eval 抓取）。
- **场景触发正则**：
  - `withTodos`: `/规划|任务|验收|todo/i` → CUSTOM todos 多帧（initial 0/4 + done 4/4，触发 ProgressCard 原位 upsert）。
  - `withReasoning`: `/思考|推理|reasoning|thinking/i` → REASONING_MESSAGE_START/CONTENT/END。
  - `withApproval`: `/审批|执行|approval/i` → CUSTOM tool_approval_required，RUN_FINISHED 推迟到 interaction-response 之后。
  - 命中多个独立叠加（W3 演示场景："请审批推理这个任务" 命中 reasoning + approval + 隐式 todos）。

## 与 canvas/batch 验收方法学的差异

| 维度 | batch-queue | canvas | workbench |
|---|---|---|---|
| 后端契约 | batchRunner 队列状态机 | 无（纯前端 localStorage） | AG-UI SSE 21 种事件类型 + REST `{data:[]}` |
| stub 复杂度 | 高（14 路由 + 状态机） | 低（seed 一次性） | 中（常驻 SSE + 同流 late-enqueue） |
| 关键修复 | 路径前缀 `/batch` 漏配 | electronAPI mock 缺失 | type 命名小写 vs registry 大写 + todos item 字段错 + list 端点包 `{data}` |
| 验收矩阵 | T1–T7 队列 | C0–C6 画布 | W1–W3 + B1 + E1 |

## agent-browser Windows 经验（workbench 专属）

- **send 按钮 ref 会变**：每次 reload 后 ref 重排（W1 中 e30 → 重载后 e30，第二次 reload 后又变），发消息前必须先 `snapshot -i` 取最新 ref，否则 `Unknown ref`。
- **input 重置时机**：submit 后 Vue 自动清空 textarea；若 `click e25` 紧接着 `type`，文本可能丢焦点；click 后加 `sleep 0.3` 再 type 较稳。
- **stub IIFE 仅 load 时执行**：stub 改完后必须 `agent-browser reload`（不是 `eval`）才能生效；reload 后所有 ref 重排。
- **日志抓取**：stub IIFE 末尾 `console.log/warn` 已 patch 到 `window.__stubLogs`；`__wbCtl.clearLogs()` 用 splice（**勿直接赋 `__stubLogs = []`，会断开 patchLogs 闭包引用**）。

## 已知遗留 / 未覆盖

- **stream 截断兜底未跑**：`run:end` 不发 → aguiBridge finally 推 `workbenchStreamInterrupted` 红字错误气泡的回归路径（已通过 RUN_FINISHED 收口规避，未针对性破坏测试）。
- **多轮切换 / 历史回放**：`loadHistoryIntoPage` 路径未验（stub `agent/threads/messages` 返回空 records）。
- **attachment rail**：composer 的 draftAttachments 流程未触发。
- **artifacts / wb_sync / wb_canvas_exec / wb_canvas_ops** 等执行副作用 CUSTOM 未覆盖。
- **wb_invalid / wb_error**：错误气泡路径未触发。
- **approval "edit / 修改参数"** 按钮：stub 的 `args` 参数没真处理（仅记录 action）。

## 复跑验收脚本（可粘贴）

```bash
# 启动
node acceptance/workbench/serve.mjs 5175 &
sleep 1
agent-browser open http://127.0.0.1:5175/workbench
sleep 4

# W1 todo — 在输入框输入触发语后点 send（send ref 取自 snapshot）
agent-browser eval 'window.__wbCtl.clearLogs()'
# click textarea (e25), type, click send (e30) 三步
agent-browser click e25; sleep 0.3
agent-browser type e25 "规划一个验收任务，包含 todo 步骤"; sleep 0.3
agent-browser click e30; sleep 3
# 断言 4 行 todo + 4/4 + 无 stream interrupted
agent-browser eval 'JSON.stringify({rows:document.querySelectorAll(".progress-card--todo [data-testid=progress-row]").length, header:document.querySelector(".progress-card--todo [data-testid=progress-count]")?.innerText, ok:!document.body.innerText.includes("对话流中断")})'

# W2 approval — 触发审批卡 + 点击批准
agent-browser click e25; sleep 0.3
agent-browser type e25 "请审批执行这个任务"; sleep 0.3
agent-browser click e30; sleep 1.5
# 找到「批准」按钮点击
agent-browser eval 'document.querySelectorAll("button").forEach(b=>{if(b.innerText.trim()==="批准")b.click()})'; sleep 2
# 断言：审批卡翻"已批准"
agent-browser eval 'JSON.stringify({approved:document.body.innerText.includes("已批准")})'

# W3 reasoning — 触发 reasoning 行
agent-browser click e25; sleep 0.3
agent-browser type e25 "请用推理分析这个任务"; sleep 0.3
agent-browser click e30; sleep 3
# 断言 brain 图标 + reasoning 文本
agent-browser eval 'JSON.stringify({brain:[...document.querySelectorAll(".fa-brain")].length, snap:!!document.body.innerText.match(/正在规划任务步骤/)})'

# B1/E1 透传 — localStorage 设保守/高 → reload → 发 → 读 run request 日志
agent-browser eval 'localStorage.setItem("wb.approvalMode","conservative");localStorage.setItem("wb.reasoningEffort","high")'
agent-browser reload; sleep 1.5
agent-browser eval 'window.__wbCtl.clearLogs()'
agent-browser click e25; sleep 0.3
agent-browser type e25 "请审批推理这个任务"; sleep 0.3
agent-browser click e30; sleep 3
agent-browser eval 'window.__stubLogs.find(l=>/run request/.test(l))'

# 重置
agent-browser close
```