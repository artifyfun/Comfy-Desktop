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
| 关键修复 | 路径前缀 `/batch` 漏配 | electronAPI mock 缺失 | type 命名小写 vs registry 大写 + todos item 字段错 + list 端点包 `{data}` + session GET 信封 + approval value.字段名（args vs arguments）+ flushThread 截断 close 分支遗漏 |
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
- **wb_sync / wb_canvas_exec / wb_canvas_ops** 等执行副作用 CUSTOM 未覆盖。
- **approval 超时倒计时**：InteractionApprovalCard 倒计时 UI 已渲染但 stub 不模拟超时分支（需后端 emit 倒计时归零 reject 兜底才能验证）。
- **多窗口审批 race**：同 threadId 两窗口同时打开、互相 approve 的 race 未验（需要 stub 支持并发流）。

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