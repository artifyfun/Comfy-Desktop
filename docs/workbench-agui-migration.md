# AI 工作台 AG-UI 协议迁移 — 组件级实施计划

> 目标:把 AI 工作台聊天层从「自造 ad-hoc SSE 事件(`stage/item/plan/reply/...`)」升级为
> **标准 AG-UI 协议**(与 SNC waa 同款公开协议),获得标准化工具调用呈现、思考过程折叠、
> HITL 交互的协议地基与历史回放能力,同时**不破坏**现有 PLAN → 校验 → 执行链路。
>
> 蓝本:SHSNC waa(`web_ai_assistant` 前端 + `snc-platform-ai-agent-parent` 后端)的协议设计。
> waa 前后端**不整体迁移**(Vue2 / 42k 行 / SNC 基座强绑定),只做协议对齐 + 组件级借鉴。
>
> 核心红线:**PLAN JSON 保留为内部 IR**。`plan.ts` 校验层、wb_* 工具(`toPlan`)、
> 路由层分派深度依赖它;本计划只动协议外壳与呈现层,执行链路一行不碰。

---

## 0. 总览

| Phase | 主题 | 组件 | 后端/前端 | 预估 |
|---|---|---|---|---|
| **P1** | 后端协议层 | C1 事件类型 · C2 映射器 · C3 事件存储 · C4 流式端点 · C5 thread API · C6 旧端点回归 | main | 4-6 天 |
| **P2** | 前端协议管线 | C8 agui 管线移植 · C9 Pinia 会话 store · C10 Markdown 增量化 | frontend | 3-4 天 |
| **P3** | UI 升级 | C11 工具卡通用化 · C12 思考折叠块 · C13 多会话 UI · C7 多会话并行(后端) | frontend+main | 5-8 天 |
| **P4** | HITL + 探索 | C14 HITL 后端 · C15 HITL 卡片 · C16 正文分段流(探索) | 全栈 | 5-8 天 |

依赖关系:

```
C1 ──→ C2 ──→ C4 ──→ C8 ──→ C9 ──→ C11/C12/C13
        │      │              └────→ C15
C3 ──→ C5 ──→ C8(历史回放)
C6(回归门,与 C4 并行)
C13 ←── C7(后端并行);C7 属 P3,可独立提前,不阻塞 C8-C12
C14 ──→ C15;C16 独立探索,不阻塞任何项
```

每阶段可独立交付:P1 完成即有标准协议 + 外部客户端可复用 `/mcp` 与 wb_* 工具面;
P2/P3 每组件独立可上;P4 的 HITL 是唯一跨全栈的新增能力。

通用工程约束(全仓库 AGENTS.md + TESTING.md):
- **零 flaky 测试**:vitest,mock 依赖,无固定 sleep。
- **测试是双轨的**(实测核实):后端(main 进程,TS)走根 `pnpm test`(根 vitest include 只有
  `src/**/*.test.ts`,后端测试须落 `src/main/artifylab/**` 下);前端是**纯 JS 包**(`packages/frontend`
  无任何 .ts),走 `pnpm --filter artifylab-frontend test`(包内自带 `vitest run` 脚本,vitest 从根
  node_modules 解析)。**前端新代码用 .js/.vue + .test.js,不引入 TS**(对齐包现状,该包无 TS 工具链)。
- 前端组件测试需要 DOM 时,用文件级 pragma `// @vitest-environment happy-dom`
  (frontend 的 vite.config.js 无 test 配置段,零配置改动);纯逻辑测试默认 node 环境即可。
  store 测试可用根依赖已有的 `@pinia/testing`。
- 验证命令:后端 `pnpm test` + `pnpm run typecheck`;前端 `pnpm --filter artifylab-frontend test`
  + `pnpm build:frontend`(产物三件套守卫 `check:fresh` 会自动把关)。
- 提交前(TESTING.md 惯例):`pnpm run typecheck && pnpm run lint && pnpm run build && pnpm run test`。
- **注意**:pnpm 严格依赖隔离下,前端包内直接引用的测试工具(`@vue/test-utils`、`@pinia/testing`)
  需在 `packages/frontend/package.json` devDependencies 声明后才可在该包测试中 import
  (根 devDependencies 的包默认对子包不可见,vitest 二进制经 `.bin` 例外可用)。

---

## P1 · 后端协议层(`src/main/artifylab/`)

### C1 — AG-UI 事件类型定义

- **新建** `agui/types.ts`:21 种标准事件 + CUSTOM 的 TS 类型与 `AGUIEvent` 判别联合。
  纯类型 + 纯序列化函数(`encodeSseFrame`),零 electron / express 依赖,便于单测。
  帧格式照 AG-UI 标准:**无 `event:` 行,类型在 JSON `type` 字段内**
  (`data: {"type":"TEXT_MESSAGE_CONTENT",...}\n\n`)——注意与现有 `send()` 的具名事件帧并存但互不混用。
- **验收**:类型单测覆盖每个事件的必填字段;`encodeSseFrame` 输出可被 waa 式 parser 消费。
- **测试**:`agui/types.test.ts`(纯函数,无 IO)。

### C2 — codex ThreadEvent → AG-UI 映射器

- **新建** `agui/codexMapper.ts`:纯函数状态机,输入 `ThreadEvent` 流(`vendor/codex-sdk.d.ts:177-188`),
  输出 AG-UI 事件序列。映射表:

  | codex 事件 | AG-UI 事件 |
  |---|---|
  | `thread.started` | `RUN_STARTED {threadId, runId}` |
  | `item.started`(reasoning) | `REASONING_MESSAGE_START` |
  | `item.updated`(reasoning) | `REASONING_MESSAGE_CONTENT`(与上次快照 diff 出 delta) |
  | `item.completed`(reasoning) | `REASONING_MESSAGE_END` |
  | `item.completed`(agent_message) | `TEXT_MESSAGE_START → CONTENT(整段) → END` |
  | `item.*`(mcp_tool_call / command_execution / file_change / web_search) | `TOOL_CALL_START → ARGS → END`,`item.completed` 补 `TOOL_CALL_RESULT` |
  | `item.completed`(todo_list) | `CUSTOM {name:'todos', value:{items}}` |
  | `turn.completed` | `STATE_DELTA`(JSON-Patch:`/tokenUsage/*`)+ `RUN_FINISHED` |
  | `turn.failed` / `error` | `RUN_ERROR {message}` |
  | ——(业务层) | PLAN/校验结果/artifact/sync 走 `CUSTOM {name:'wb_plan'/'wb_invalid'/'wb_artifact'/'wb_sync'}`,`STATE_DELTA` 挂 `intentLabel` 等元数据 |

  幂等要求:同一 toolCallId 只发一次 START(waa `AgUiEventProcessor` 踩过的重放坑,直接规避)。
  item 粒度限制如实呈现:agent_message 整段到达,CONTENT 单帧大 delta 是**已知且接受**的形态
  (token 级打字机是 C16 的探索项,不阻塞本组件)。
- **测试**:`agui/codexMapper.test.ts` —— 构造 codex 事件序列 fixture(含重放、乱序、failed 轮),
  断言输出事件序列与幂等性;纯函数无 IO。

### C3 — 事件溯源存储

- **新建** `agui/eventStore.ts`:`node:sqlite`(`DatabaseSync`,照抄 `gallery/db.ts:4` 的零依赖模式)。
  表结构镜像 waa `ai_agent_message` 的事件溯源设计:

  ```sql
  CREATE TABLE agui_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id TEXT NOT NULL,        -- = workbench sessionId
    run_id    TEXT NOT NULL,        -- 每次 decide 一组
    seq       INTEGER NOT NULL,     -- run 内序号(断线重放/排序用)
    event_type TEXT NOT NULL,       -- TEXT_MESSAGE / REASONING / TOOL_CALL / CUSTOM / RUN_ERROR
    content   TEXT NOT NULL,        -- AG-UI 事件 JSON 原文
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_thread_run ON agui_event(thread_id, run_id, seq);
  ```

  写入点:C4 的 SSE 发送管线旁路(每发一个事件,同事务落一行)——**实时流与历史回放同构**,
  回放 = 按 `(thread_id, run_id, seq)` 重放事件,前端同一管线消费(waa 的核心设计)。
- **验收**:CRUD + 分页查询单测;写入失败不阻断 SSE(旁路容错,记 warn)。
- **测试**:`agui/eventStore.test.ts`(`:memory:` SQLite,无临时文件清理负担)。

### C4 — AG-UI 流式端点

- **新建** `routes/agui.ts`,注册进 `server.ts` 中间件链(位置在 `history()` 之前,与 workbench router 同层)。
  端点:
  - `POST /api/workbench/agent/run` — SSE 主入口。请求体:`{threadId, runId, messages:[{role,content}], forwardedProps?}`。
    内部复用 `workbenchService.decide()` 与既有 `getOrCreateAgentSession` harness(thread 复用/预算双闸全继承),
    `onProgress.thread_event` → C2 映射器 → SSE;decide 返回后按现有路由层同一套 `validatePlanLocal`
    → 分派(执行/回复/记忆),业务产物以 CUSTOM 事件补发。**不触碰** `PLAN → wb_* 工具 → executor` 链路。
  - `POST /api/workbench/agent/cancel` — AbortController 中断(对齐现有 `/stop` 的 `chatSettled` 语义)。
- 复用现有 SSE 基建:`X-Accel-Buffering: no`、`res.on('close') → abort`、15min 超时,全部照抄 `workbench.ts:429-436`。
- **验收**:本地端口起真实 server,fetch POST 消费 SSE,断言收到合法事件序列
  (RUN_STARTED → … → RUN_FINISHED,TOOL_CALL 四帧配对,CUSTOM 载荷可解析)。
- **测试**:`routes/agui.test.ts`(mock `workbenchService.decide` 注入脚本化事件流,真 HTTP 断言帧格式)。

### C5 — thread/历史 REST API

- **同在** `routes/agui.ts`:
  - `POST /api/workbench/agent/threads/page` — 会话分页(数据源:现有 `workbench-sessions.json` store,读侧包装)。
  - `POST /api/workbench/agent/threads/messages` — 按 runId 分组分页返回事件(数据源:C3 eventStore),
    响应形状对齐 waa `MessageVO`(eventType/seq/runId/content),前端回放直接喂管线。
- **验收**:分页边界(空 run/大 run 截断/跨 run 排序)单测覆盖。
- **测试**:`routes/agui.threads.test.ts`。

### C6 — 旧端点回归门(与 C4-C5 并行)

- **约束**:`/api/workbench/chat` 及全部既有路由**零改动**(C7 除外,C7 见下)。
  现有 `routes/workbench.{stop,l2}.test.ts`、`canvas*.test.ts` 必须全绿作为回归门;
  另补一条冒烟:旧前端(index.vue `handleSse`)在 P1 合并后仍能完整走通一轮 chat。
- **回滚策略**:agui 路由是独立文件 + 独立表, revert 单个文件即完全下线,不牵连旧链路。

### C7 — 多会话并行(拆单飞锁)

- **改动** `routes/workbench.ts` 模块级并发单例——`chatInFlight` / `chatAbort` /
  `chatStopRequested` / `chatSettled` / `settleChat` 五件套(约 `workbench.ts:43-56`,
  与 `CHAT_TIMEOUT_MS` 相邻)→ `Map<sessionId, {abort, stopRequested, settled, settle}>`;
  `/stop` 路由(await `chatSettled` 的收尾语义)同步改。
  `service.ts` 侧确认 `AgentSession` 已是会话级隔离(`getOrCreateAgentSession`,
  `service.ts` 会话级 Map),需重点排查两处进程级单例:
  1. `mcp/workbenchTools.ts:32` 的 `currentDecideSession`(wb_* 工具上下文绑定)——
     候选方案:改 `Map<sessionId, ctx>`(begin/end 签名不变);或 MCP 请求头/bearer 附加
     sessionId,`requireSession()` 从请求上下文取。**取侵入最小者,动手前先写失败测试**。
  2. `routes/workbench.ts` 的 `setCanvasSyncHandler` 全局回调(workbench chat 内 setCanvasSyncHandler
     每轮覆盖注册)——改为按会话注册,或回调携带 sessionId 过滤。
- **验收**:并发两条 decide(不同 session)互不 409;同 session 二连发仍 409;
  并发下 wb_* 工具各自看到正确会话(模板清单/执行产物不串号)。
- **测试**:`routes/workbench.parallel.test.ts`(并发 fetch + 确定性 Promise 门,无 sleep)。
- **风险**:wb_* 工具上下文串号是本项最大风险点(工具回环走 HTTP,服务端无法从调用栈区分会话);
  必须先写"并发下 tool 上下文隔离"的失败测试再动手;若单飞锁短期保留,C7 可整体推迟到 P3 末,
  不阻塞 M2/M3 的协议迁移本身。

---

## P2 · 前端协议管线(`packages/frontend/src/`)

### C8 — agui 管线移植(JS)

- **新建** `src/utils/agui/`(全部 `.js`,前端包无 TS 工具链):`parser.js`(SSE 分帧)·
  `streamReader.js`(ReadableStream 消费)·
  `handlers/`(lifecycle/textMessage/reasoning/toolCall/custom 注册表)· `historyReassembler.js`。
  蓝本:waa `src/components/AiAssistant/services/agui/` 四件套——逻辑原样移植(纯 ReadableStream +
  纯函数,零 Vue 依赖),需剥离的只有 waa 的 `state/conv` 写入点,改为向 C9 store 派发(事件回调注入,
  管线不 import store,保持可独立单测)。本项目现有 `index.vue:1840+` 的手写分帧解析保留给旧端点,不混用。
- **验收**:waa 的协议测试用例翻译过来自测:`src/utils/agui/__tests__/parser.test.js`、
  `src/utils/agui/__tests__/historyReassembler.test.js`(事件序列 → 消息时间线的重组正确性)。
- **测试**:纯函数,fixture 驱动,无 IO;运行方式 `pnpm --filter artifylab-frontend test`。

### C9 — Pinia 会话 store

- **新建** `src/stores/aguiSession.js`(Pinia;该包 main.js 已 `app.use(createPinia())`,
  stores/ 目录已有 appStore/batchTaskStore 等先例):状态 = `messages / timeline / interactions /
  isGenerating(per-session) / tokenUsage`;C8 handlers 写入此 store。
  与现有 `index.vue` 的 `messages.value` **并行共存、按端点切换**(新端点走 store,旧端点走原逻辑),
  P3 完成迁移后才删旧路径。
- **验收**:store 单测:handlers 派发事件序列 → 断言 messages/timeline 形状
  (含 tool_call 三帧聚合、CUSTOM todos 替换、REASONING 折叠)。
- **测试**:`src/stores/__tests__/aguiSession.test.js`
  (`@pinia/testing` 的 `createTestingPinia`,根 devDependencies 已有)。

### C10 — WbMarkdown 增量化

- **改动** `views/workbench/components/WbMarkdown.vue`(250 行;现状核实:单 `computed` 里
  `marked.parse` 全量重解析 + DOMPurify 全量消毒,v-html 整体替换)。新增 append 模式:
  增量文本进 buffer,`requestAnimationFrame`/16ms 节流 flush,按 `\n\n` 块边界只解析新块,
  尾段留缓冲;复制按钮等 DOM 后处理改造为增量应用。DOMPurify 消毒路径不变(每块仍过 sanitize)。
- **验收**:长文本(10k 字)分 100 片 append 的渲染正确性 + 节流生效(fake timers)。
- **测试**:`src/views/workbench/components/__tests__/wbMarkdown.test.js`
  (文件头 `// @vitest-environment happy-dom`)。

---

## P3 · UI 升级(`packages/frontend/src/views/workbench/`)

### C11 — 工具调用卡片通用化

- **新建** `views/workbench/components/ToolCallCard.vue`:通用 `{toolCallId, name, args, status, result}`
  形状(消费 C9 store 归一化后的 tool_call),折叠组参照 waa `TimelineToolGroup.vue` 的信息架构
  (header:图标+名称+状态+次数,展开看 args/result),视觉用本项目 antd-vue + tailwind 重写
  (不搬 element-ui 代码)。替换 `index.vue` 中 `toolItemSummary()`(`index.vue:1671`)
  对 codex ThreadItem 的硬编码 switch;codex 特有类型(command_execution/file_change)在
  C2 映射层已归一为 name 约定(`shell`/`file_change`/`web_search`),卡片按 name 选图标即可。
- **验收**:五种工具类型快照渲染 + 展开交互单测。
- **测试**:`__tests__/toolCallCard.test.js`(happy-dom pragma + @vue/test-utils,根依赖已有)。

### C12 — 思考折叠块

- **新建** `views/workbench/components/ReasoningBlock.vue`:消费 REASONING_* 事件流(waa `TimelineReasoning`
  的交互:默认收起、流光 loading、流完自动折叠),渲染走 C10。后端 P1 起事件已就绪,纯前端项。
- **验收**:开始/增量/结束三态 + 默认折叠行为单测。
- **测试**:`__tests__/reasoningBlock.test.js`(happy-dom pragma)。

### C13 — 多会话并行 UI

- **改动** `SessionSidebar.vue`(264 行)+ 会话列表项:per-session 生成态脉冲(waa 同款)、
  未读绿点(后台会话完成)、切换会话不打断进行中流(C9 store 已按 threadId 切片)。
  依赖 C7 的后端并行。
- **验收**:双会话并行生成的状态机单测(store 级),UI 手测清单入 PR 描述。

---

## P4 · HITL + 探索项

### C14 — HITL 后端(工具确认门)

- **设计**:Electron 单实例使 waa 的最难点大幅降级——无需 RedisSaver/Kafka 广播。
  在 wb_* 工具执行路径(`workbenchTools.ts` registry `handle` 前置一层门控)插入确认点:
  白名单工具(`wb_execute_template wait=true`、`wb_run_workflow`、`wb_publish_workflow`)执行前
  挂起 → SSE 下发 `CUSTOM {name:'tool_approval_required', value:{interactionId, toolCalls}}` →
  进程内 Promise 挂起(会话对象持有 resolver,落盘防重启丢)→ 新端点
  `POST /api/workbench/agent/interaction-response` resolve(decisions: approve/reject/edit-args)→ 续跑。
  超时(fail-safe)默认拒绝,对齐 waa `ApprovalGateToolInterceptor` 语义。
- **风险**:codex thread 在 MCP 工具调用期间挂起 10min+ 的心跳/超时行为需实测
  (现有 `wait=true` 10min 轮询已证明长挂起可行,风险中低)。
- **测试**:门控状态机单测(挂起/应答/超时/双应答幂等),mock 时钟。

### C15 — HITL 前端卡片

- **新建** `views/workbench/components/InteractionApprovalCard.vue`(问询卡可后置):
  pending 橙点(会话列表)+ approve/reject/edit-args 三操作 → C14 端点 → `interaction_response`
  留痕翻 answered。历史回放时 pending 无应答 → 显示「待恢复」态(waa 同款安全网)。
- **依赖**:C14 + C9。**验收**:三操作 + 超时态 + 历史回放态单测。
- **测试**:`__tests__/interactionApprovalCard.test.js`(happy-dom pragma)。

### C16 — 正文分段流(spike 已完成,结论:可行,立项条件明确)

> **Spike 结论(2026-08-31,证据链完整)**:
>
> 1. **现状实测(exec 模式)**:生产管线 `codex exec --experimental-json` 下,
>    agent_message/reasoning **只有 `item.completed` 整段**(9.2s 生成期间零中间帧,
>    env 门控观测点落盘实证:6 事件 = thread.started/turn.started/2×item.completed/
>    turn.completed + 1 error 告警项)。SDK 的 ThreadEvent 模型在该模式下无
>    item.updated;代理层 chunk 级 delta(streamToSse 每 chunk 发
>    response.output_text.delta)被 codex 引擎内部聚合,不外吐。
> 2. **app-server 模式实测(决定性)**:codex 二进制 `app-server` 子命令的
>    JSON-RPC 协议**原生含 token 级 delta 通道**——TS 绑定(generate-ts 实测)
>    定义了 `item/agentMessage/delta {threadId,turnId,itemId,delta}`、
>    `item/reasoning/textDelta`、`item/reasoning/summaryTextDelta` 等通知。
>    生产同款代理配置(-c model_providers 覆盖,DeepSeek 网关)下端到端驱动
>    thread/start + turn/start:**单轮 300 字回复产生 243 个 agentMessage delta +
>    696 个 reasoning summaryTextDelta,词粒度清晰**('AG'/'-'/'UI'/'（'…),
>    同轮 item/started×3、item/completed×3、turn/completed 常规收口。
> 3. **坑位记录(迁移实现时必读)**:
>    - app-server **不读 CODEX_HOME/config.toml 的 model_provider 段**(对照实验:
>      base_url 指向死端口仍打 api.openai.com)——provider 必须 `-c` 命令行覆盖;
>    - `turn/start` params 是**平铺**的(threadId + input 顶层,无 params.params 嵌套),
>      input 元素 `text_elements` 必填(缺了报 missing field `input`);
>    - thread/start 的 params **有** `params` 嵌套(两个方法形态不一致);
>    - `thread/resume` 只用于恢复已持久化线程,新会话驱动用 turn/start;
>    - initialize 需先发(clientInfo),否则后续请求被静默丢弃。
>
> **立项判定:可行且值得**。迁移路径 = 新增 app-server 传输 adapter(与现有
> exec JSONL adapter 并存,feature flag 切换),mapper 消费
> `item/agentMessage/delta` → AG-UI TEXT_MESSAGE_CONTENT 增量帧,C10/M5 的
> WbMarkdown 增量渲染管线即刻吃到 token 级流。工作量预估:adapter ~300 行 +
> 映射 ~50 行 + 测试。风险:app-server 协议标 experimental,0.149.x → 升级需
> 锁版本回归。**不阻塞 M1-M4,作为 P5 立项项。**
>
> **实现落地(2026-08-31 第四轮,P5 → 已交付)**:
> - `agui/appServerClient.ts`:app-server 子进程 JSON-RPC 客户端(spawn +
>   readline 逐行解析;request 超时/进程退出全量 reject;脏行/通知异常不杀
>   会话;configArgs → -c 覆盖注入 provider)。测试 9 条(mock spawn)。
> - `agui/appServerTranslator.ts`:通知 → exec 形态 ThreadEvent(类型驼峰→
>   蛇形、usage 驼峰→蛇形+Number 强转、agentMessage 流式标记 __streamed)
>   + StreamDelta 旁路(text/reasoning 双通道;willRetry 的 error 静默)。
>   测试 13 条。
> - `workbench/appServerRun.ts`:会话级运行时(子进程与 thread 跨 decide 复用;
>   initialize 幂等;turn 驱动 AsyncGenerator 帧 = {event?, deltas[]},delta
>   先行;signal abort → turn/interrupt 尽力而为;残帧清理防跨轮泄漏;
>   clientFactory 注入缝供测试)。测试 5 条。
> - `agui/codexMapper.ts`:`feedStreamDelta`(text 首见 START+CONTENT,后续
>   CONTENT;reasoning 同构 + 快照基线同步防 completed 重发);流式过的
>   agent_message completed 只发 END(整段不重发)。测试 +6 条(21/21)。
> - `workbench/service.ts`:`resolveAgentTransport()`(settings > appStore >
>   默认 'exec' 红线不破);AgentSession 增 appServer 可选字段,dispose 全量
>   回收;decide 分支消费 RunFrame(stream_delta → onProgress,thread_event
>   照旧,rawLines 收 exec 形态 JSON 保证 PLAN 解析同构)。顺手修
>   workbench.stop.test.ts 的 service mock 缺 setCanvasSyncHandler(既有债)。
> - `routes/agui.ts`:stream_delta → mapper.feedStreamDelta → emit 增量帧。
> - **端到端实证**:transport=appserver 实跑,单轮回复产出 25 个 token 级
>   TEXT_MESSAGE_CONTENT(词粒度 'AG'/'-'/'UI'/'协'/'议'…),拼接正文完整,
>   START/END 配对正确,no-plan 分支 RUN_ERROR 单终帧语义不变。
> - 回归:C16 新增 27 测试全绿;后端 372/374(基线债 workbenchTools ×2 +
>   canvas suites ×2 环境性,stash HEAD 复核确认与本轮无关);typecheck 0 错;
>   lint 0 新增。**默认仍 exec,零行为变化;appserver 经
>   workbenchAgentTransport 配置灰度。**
>
> **GUI 级 token 流验证 + 渲染节流陷阱(2026-09-01 第五轮)**:
> - **验证方法**:dev server + browser-harness(CDP 挂用户 Chrome,符合
>   SNC ToolGuard 规范;独立 playwright 实例被拦),三层探针——页面内
>   fetch sniffer(透传 reader 统计 SSE chunk 事件类型)、DOM 100ms 采样器
>   (.wb-md 总字符曲线)、console 拦截(临时插桩 aguiBridge/WbMarkdown)。
> - **端到端结论(全部通过)**:transport=appserver 下,SSE 58 个
>   TEXT_MESSAGE_CONTENT 词粒度增量 → 桥 upsertChatText 逐 delta 累积
>   (模型 116 字符逐字长)→ WbMarkdown watch 触发 28 次/streaming=true →
>   前台可见时 DOM 11~13 个增长点,token 级流式渲染完整闭环。
> - **发现并修复——后台节流陷阱(MAJOR)**:验证初期所有 run 都呈现
>   「整段弹出」(DOM 单次跳变)。逐层排查(网络层 chunk 正常 → 模型层
>   渐进 → watch 正常 → runFlush 只执行 1 次)定位根因:**Chrome/Electron
>   对后台/遮挡页面的 setTimeout 激进节流**——WbMarkdown 的 16ms 流式
>   flush 定时器在后台 tab 被合并丢弃(28 次 watch 仅 1 次 flush),token
>   流退化成整段渲染。前台激活后立即恢复正常(15/28 flush、DOM 13 增长点)。
>   **桌面场景等效风险**:单窗口模式 panelView(A UI 宿主)被 ComfyUI 视图
>   切换遮挡时触发同机制。修复:`src/main/host/panelView.ts` webPreferences
>   增 `backgroundThrottling: false`(Electron 默认开启节流),注释记录
>   实测依据。panelView 19/19 测试绿,typecheck/lint 0 错。
> - **验证中的已知噪声(非缺陷)**:PLAN JSON(`msg_` 前缀消息)也会流式
>   渐进渲染——它 kind='chat' 走 markdown,用户会看到 JSON 逐字出现后由
>   wb_plan CUSTOM 卡片接管展示;主回复由路由层 sendText 在 run 收尾整段
>   发出(PLAN.reply 语义,非流式)。用户可感知的 token 流 = PLAN JSON
>   流式段;若后续要把主回复也做成 token 级,需把 reply 从 PLAN 解析后
>   转发改为映射器直通(涉及 PLAN 红线,留档不做)。
> - 回归:前端 185/185、后端 workbench/agui/panel 线 257/257、typecheck
>   0 错、eslint(panelView)0 问题;插桩全部还原(git diff 验证零残留);
>   transport 配置已恢复默认 exec;dev 进程与 app-server 子进程全部清理。

- 现状:codex `agent_message` 事件只有 `item.started/updated/completed` 三态,
  `text` 是整段字段,**SDK 事件模型本身不承诺 delta 粒度**。探索两条路:
  1. 代理层路线:`vendor/mimo2codex` 的 `streamToSse/pipeChatStreamToResponses`
     (`workbenchProxy.ts` 在用)翻译 chat 流时,上游 chunk 边界在代理内部是已知的——
     可在代理层旁路记录"agent_message 累积快照"序列,decide 事件循环里对
     `item.updated` 的 text 做与上次快照的 diff,diff 非空即发 TEXT delta。
     **前提是 codex 在流式期间会发 item.updated**(未验证,可能只在完成时发一次)。
  2. 绕过 SDK 路线:直连 LLM 的 OpenAI 兼容流(抛弃 agent 循环)——不推荐,等于重写 harness。
- ~~先做 1 天 spike~~ spike 已完成(见上方结论:app-server 通道可用,立项可行)。

---

## Legacy 管线删除(M3 收口,2026-09-01 第六轮)

灰度期结束,`/api/workbench/chat` + `/api/workbench/stop` 整条 legacy 管线删除,
AG-UI 成为唯一聊天管线(`?ng=0` 逃生口一并移除——无路可退,也不需要退)。

**删除清单**:
- **后端 `routes/workbench.ts`**(1080→614 行):
  - `POST /api/workbench/chat`(决策+执行 SSE,~420 行)与 `POST /api/workbench/stop` 整体删除;
  - `WorkbenchChatRun` 接口 + `chatRuns` Map(C7 per-session 锁)删除——
    `/agent/run` 的 `activeRuns` 锁(agui.ts)是同语义继承者;
  - `CHAT_TIMEOUT_MS`、`stopExecution`/`validatePlanLocal`/`promptToWorkflowGraph`/
    `AttachmentMeta` 孤儿 import 清理;头部端点文档同步。
- **停止语义对齐(删除前必须补的缺口)**:legacy `/stop` 会同步 interrupt
  ComfyUI(队列中/轮询中的任务一并停),`/agent/cancel` 原先只 abort 决策流。
  `routes/agui.ts` cancel 分支补 `stopExecution(comfyHost)`,失败仅 warn 不阻断,
  响应体带 `interrupted` 字段;agui.test.ts 加断言(`stopExecution` 被调 + 响应含
  `interrupted:true`),21/21 绿。
- **测试删除**:`workbench.stop.test.ts`、`workbench.parallel.test.ts` 整文件删除
  (被测端点已不存在;canvas-sync per-session 隔离语义由 agui.test.ts 的
  `setCanvasSyncHandler` 两参形态用例继续覆盖)。
- **前端 `index.vue`**(3426→3175 行):
  - `runChat` legacy SSE 消费循环(fetch /chat → reader → handleSse)删除,
    函数体 = `aguiBridge.runAgentTurn(...)` 一行;
  - `stopChat` legacy 分支(/stop fetch + reader.cancel + 产物卡标 stopped)删除,
    函数体 = `aguiBridge.stopAgentRun()`;
  - `handleSse`(legacy SSE 事件分派,~112 行)、`stageText`、死代码
    `handleThreadItem`/`isNoisyItem`/`toolItemIndex`/`chatReader`/`chatDone` 删除;
  - 桥无条件创建(`createAguiBridge(...)` 直调),模板/审批转发/历史回放的
    `if (aguiBridge)`/`aguiBridge &&` 守卫全部简化。
- **前端 `aguiBridge.js`**:`isAguiEnabled`/`resolveAguiEnabled`/`NG_STORAGE_KEY`/
  `__resetEnabledCacheForTest` 开关机制删除(桥 = 唯一管线,无旁路)。
- **i18n**:孤儿 key `workbenchValidating` 双语删除(stageText 的产物)。
- **`__tests__/aguiBridge.test.js`**:开关解析 describe(4 用例)删除,23 用例保留。

**GUI 冒烟(browser-harness,唯一管线)**:
- 正常轮:「用20个字介绍TCP三次握手」→ 应答正常渲染;
- 停止轮:长文任务发起 → 点停止 → 「已停止」气泡,ComfyUI interrupt 经
  `/agent/cancel` 生效;
- 锁释放:停止后立即再发「用15个字说什么是DNS」→ 正常应答(无 409)。

**回归**:后端 routes/agui/workbench/panelView 线 274/274(基线债 workbenchTools
×2 + canvas ×2 套件不变,非本轮);前端 181/181;typecheck 0 错;eslint 0 新增
(预存 9 错为基线,stash 复核);`build:copy` 产物 grep 零 legacy 端点引用。

**注意**:`decide()` 落盘的用户消息/会话素材表语义、PLAN JSON 内部红线、
外部 MCP 无身份透传红线均不变;`/poll`、`/execute`、`/run-workflow` 等
L2 快路径端点与 chat 管线无关,保留。

---

## 里程碑与交付顺序

| 里程碑 | 内容 | 出口判据 |
|---|---|---|
| M1(P1 完成) | C1-C6 | 新端点 curl 可见合法 AG-UI 流;`pnpm test` 全绿;旧端点回归零失败 |
| M2(P2 完成) | C8-C10 | 新端点驱动的前端管线在 workbench 页灰度开关(URL query,如 `?ng=1`)下跑通实时 + 历史回放;前端包 `pnpm --filter artifylab-frontend test` 全绿 |
| M3(P3 完成) | C11-C13+C7 | 默认切新管线,旧 SSE 消费路径删除;双会话并行可用 |
| M4(P4 完成) | C14-C15(+C16 结论) | 审批流端到端可用 |

灰度策略:M2 起新旧管线并存(URL/配置开关),M3 才切默认——任一阶段 revert 前端或后端单侧均不破坏对方。
C7(多会话并行)依赖最重、风险最高,允许推迟到 M3 内任意时点,不影响协议迁移主线的交付。

> **实施现状(首批交付)**:M1 全部(C1-C6)+ M2 的 C8/C9 已落地——后端
> `src/main/artifylab/agui/{types,codexMapper,eventStore}.ts` + `routes/{agui,aguiThreads}.ts`
> 已在 server.ts 接线(`/agent/run`、`/agent/cancel`、`/agent/threads/{page,messages}` 四端点,
> C4 与 C5 共享同一 eventStore 实例,实时流旁路落库、历史回放同构);前端 `src/utils/agui/`
> 管线 + `stores/aguiSession.js` 就绪。**未完成**:C7 多会话并行、C11-C13 UI 组件、
> C14/C15 HITL、C16 spike、灰度开关与 workbench 页消费端接线(页面尚未切新管线)。
> C4 端点仅到 `wb_plan` 为止,执行分派仍是扩展点。测试基线:后端 70 新增用例全绿、
> typecheck 零错误;前端包 88 用例全绿。全量 `pnpm test` 中 4 个套件失败
> (canvas.debug/canvas.ops/workbench.stop/workbenchTools)为分支既有问题
> (settings.ts 导入链在 node 测试环境 `electron.app` 未定义,干净基线复现),非本次引入。

> **实施现状(批次二/三更新)**:上述「未完成」项中,C7、C10、C11 消费侧、C12、C13、
> C14、C15 均已落地——
> - **C7 多会话并行**:`routes/workbench.ts` 五个单例锁改 `Map<sessionId, ChatRun>`;
>   `mcp/workbenchTools.ts` 新增 `resolveWorkbenchSessionFromRequest`(header
>   `x-workbench-session` > query `wb_session`)+ per-session decide 上下文;
>   `workbench/service.ts` 每会话 config.toml 写独立 MCP URL(`?wb_session=<sid>`)
>   与 `http_headers` 双写身份。
> - **C14 HITL 后端**:`agui/approvalGate.ts`(白名单挂起/10min 超时拒绝/edit 严格
>   对象校验)+ `agui/approvalRegistry.ts`(gate 单例 + 门控 registry 包装 + ALS
>   `mcpIdentityStorage`);`mcp/index.ts` 在 `/mcp` HTTP 层解析身份经 ALS 带进
>   CallTool(修复过「在 JSON-RPC handler 内读 express req」的位置错误);外部 MCP
>   客户端无身份完全直通。`routes/aguiInteraction.ts` 应答端点已注册。
> - **C10/C11/C12 前端**:`WbMarkdown.vue`(16ms 节流 + 块边界稳定截断)、
>   `ToolCallCard.vue` / `ReasoningBlock.vue`(纯 props);灰度桥 `aguiBridge.js`
>   (`?ng=1` 开、`?ng=0` 逃生口、sessionStorage 持久;emit→页面模型映射层,
>   实时与历史回放同构;index.vue 仅 +26 行纯插入,关闭时 legacy 字节级零变化)。
> - **C13/C15 前端组件**:`SessionSwitcher.vue`(排序/归档/generating 标)、
>   `InteractionApprovalCard.vue`(倒计时/编辑参数/三操作,零 fetch);C15 已挂进
>   灰度桥(`kind:'approval'` 消息 → `respondApproval` → interaction-response,
>   成功翻状态、失败保留 pending 可重试)。C13 组件就绪,index.vue 集成后置
>   (与现有 SessionSidebar 功能重叠,需先做去重设计)。
> - **已知灰度差异(批次五后已全部消除)**:用户消息/附件经 `decide()` 自动落库;
>   附件上行(`attachments` 透传,附件-only 合法);turnUsages 落库(onProgress
>   `turn.completed` → `appendTurnUsage`);STATE_DELTA /tokenUsage 前端桥已接线
>   (`applyTokenUsage` 兜底同步 curSession.turnUsages,页面用量角标 AG-UI 轮实时显示)。
> - **C13 SessionSwitcher 决策**:组件已交付(10 用例)但**不集成进 index.vue**——
>   实测确认现有 SessionSidebar(桌面常驻+窄屏浮层)+selectSession/newDialog/
>   setArchived 已完整覆盖会话切换/新建/归档,且更丰富(重命名/删除/预设/env);
>   硬挂=重复 UI+回归风险。组件保留,供后续纯 embed 窄屏等无侧栏场景复用。
> - **C4 执行分派已补全**(批次二 I 线):post-decide 全链对齐旧 chat 路由——
>   wb_plan CUSTOM → preset 意图/本地校验(wb_invalid + RUN_ERROR)→ memory/chat/
>   text/workflow/canvas-run/编排去重分派 → validateRemote(force 过滤 vram)→
>   预执行 wb_sync → execute/executeBatch(wb_artifact)→ 编排产物 flushArtifacts
>   补发 → RUN_FINISHED;超时/断连/cancel 异常路径与留痕语义逐项对齐(19 用例,
>   legacy 链路 14 步 service 调用 × 事件映射表见 PR 描述)。
> - **C14 gate→SSE 集成完成**(captain):`routes/agui.ts` run 起点
>   `gate.register(threadId, notify→emit(tool_approval_required CUSTOM))`,
>   finally `rejectPending`(断连/超时/cancel 时挂起审批立即按拒绝收口,不等
>   10min 超时)+ `unregister`;approvalGate 新增 `rejectPending(threadId)` API
>   并补 2 用例。灰度 HITL 端到端:门控挂起 → SSE 卡片 → 应答 → 放行/拒绝。
> - **M3 已切默认(2026-08-31)**:`resolveAguiEnabled` 无参数时默认 true;
>   `?ng=0` 逃生口改为**粘性持久**(sessionStorage 记 0,防刷新回弹),`?ng=1` 同理。
>   浏览器实测(browser-harness,真实渲染)发现并修复:**curSession 注入桥时
>   TDZ 白屏**——`createAguiBridge({curSession})` 在 ref 声明前执行,setup 抛
>   `ReferenceError` 整页不渲染;声明已上移并在代码处留注释约束。
>   **GUI 端到端实测通过**:legacy 与新管线同轮对比(新管线多「过程」折叠卡 +
>   `19k 98` 用量角标)、切会话历史回放(结构化还原,无 JSON 泄漏)、HITL 审批卡
>   三按钮(批准/拒绝/修改参数)真实交互、批准后真实提交 ComfyUI(prompt_id
>   入队 + wb_00009_.png 产物落盘 + GUI 产物图渲染)。ComfyUI 未启动时错误路径
>   同样在 GUI 验证:3 次重试 → wb_get_outputs 确认 → 模型给出诊断建议。
>   截图证据:`/tmp/agui-shots/`(A1-G 共 12 张,legacy 空态/回复、AGUI 回复、
>   会话回放、审批卡、批准后、产物卡)。
> - **对抗审查(2026-08-31,三方子代理+人工复核)修复**:
>   ① **CRITICAL——C7 身份链末跳断裂**:门控 registry(approvalRegistry)从
>   ALS 取 threadId 做审批,但放行执行时 `inner.handle(name, args)` 丢身份
>   第三参,wb 工具 `requireSession` 回退「最先 begin 的会话」→ 并发会话串号
>   (审批在 sB、执行落 sA)。测试盲区:parallel 测试直连增强 registry 三参,
>   绕过生产必经门控跳。修复:`ToolRegistry.handle` 接口放宽可选 identity,
>   门控层透传 `inner.handle(name, args, threadId)`;补 3 条「经门控跳」回归
>   (批准/edit 透传身份 + 无身份路径 identity 恒 undefined)。
>   ② **MINOR×3**:终帧统一(业务失败只发 RUN_ERROR 终帧,不再补
>   RUN_FINISHED;前端桥两序均容错);codexMapper usage `Number(??0)` 强转
>   (防 JSON.stringify 丢 value 键产出非法 replace op);cancel 兜底计时器
>   settled 先到时 clearTimeout。回归:后端 137/137,typecheck 0 错。
>   ③ **MAJOR 留档确认**:legacy `/chat` 单飞锁 → per-session 锁的语义变化是
>   **C7 多会话并行的交付本体**(用户批准的拆单飞锁),非意外回归;「legacy
>   行为不变」红线按此范围解释——不变的是单会话视角下的请求/响应语义。
>   遗留观察项(不阻塞):eventStore 无保留策略(桌面长期使用无限增长)、
>   server.ts 异步挂载空窗、SSE 无 drain 背压(环回场景帧量小)、
>   threads/messages 未知 thread 返回空数组(非 404)。
> - **第二轮审查(legacy 红线 + 前端桥,2026-08-31)修复**:
>   ① **CRITICAL C-1A——query 身份通道死代码**:`req.originalUrl` 是路径相对
>   形式(`/mcp?wb_session=x`),`new URL()` 无 base 抛 `ERR_INVALID_URL` 被
>   catch 吞掉 → query 通道生产从未生效(header 通道兜住,故 GUI 实测审批
>   挂起正常)。修复:补 `http://localhost` base。实测复现(express probe +
>   node URL 行为)确认。
>   ② **配套语义——门控对「不在场 run」放行**:修通 query 后 legacy decide
>   轮内的白名单工具会因「无 notify 注册 → fail-safe 拒绝」被误伤(legacy
>   路由从不注册 notify)。判定:「未注册 notify」== 该 thread 不在 AG-UI
>   run 中 == 门控无管辖权 → 放行(与门控引入前 HEAD 行为一致,保 legacy
>   等价红线);「注册了但无人应答/notify 抛错」仍 fail-safe 拒绝(挂起
>   只发生在 AG-UI run 活跃时)。
>   ③ **MAJOR M-1——dispatchCanvasSync 串流**:全局 `peekWorkbenchToolSession()`
>   (最早 begin 会话)派发 → 多会话并行 decide 时 B 会话画布同步投给 A 的
>   handler。修复:显式 sessionId 参数(executeWorkflow 首参/
>   syncTemplateToCanvas 由工具层传入),peek 仅兜底。
>   ④ **CRITICAL(前端)C1——桥忽略执行类 CUSTOM**:`wb_artifact/wb_sync/
>   wb_canvas_exec/wb_invalid` 被过时注释挡在门外,M3 默认管线产物卡/画布
>   同步/执行轮询/修复 UX 全部缺失(此前 GUI 看到的产物图来自会话回放,
>   实时流从未渲染)。修复:页面抽 `applyExecutionSideEffect(kind,data)` 统一
>   分派(legacy handleSse 与 AG-UI 桥 CUSTOM 共用同一实现),经 pageApi 注入。
>   ⑤ **MAJOR M1(前端)——SSE 干净截断收尾**:网关/代理关连接时 reader
>   不抛错、无 RUN_FINISHED → 进度气泡永久残留。修复:`sawRunFinish` 标志 +
>   流读完校验,对齐 legacy finally 的「流被中断」防线。
>   ⑥ **MAJOR M2/M6(前端)——回放保真**:按 runId 边界 nextTurn 重建回合
>   (不再塌缩成巨型回合卡);用户消息从 curSession.messages 按 createdAt 归并
>   (回放不再是 agent 独白);分页循环拉全量(头部不截断)。后端 records 补
>   `createdAt` 字段(threads/messages + eventStore SELECT)。
>   ⑦ **MAJOR M3(前端)——审批应答防抖**:非 pending/在途直接忽略;404 视为
>   「已在他处解决」静默置终态;`_approvalInFlight` 禁用按钮。
>   ⑧ **MAJOR M4——审批终态事件缺失**:gate 补 `onResolved` 钩子(应答/超时
>   兜底/收口 reject 均触发),run 路由据此发 `tool_approval_resolved` CUSTOM
>   并旁路落库——实时多窗口同步 + 回放不再渲染可点的死卡。
>   回归:后端 139/139、前端 129/129、typecheck 0 错、lint 零新增(基线
>   10 错不变)。legacy chat 实测红线:decide → PLAN → 校验 → 执行链全程无
>   门控拦截(ComfyUI 未启动的 fetch failed 是环境错误非拒绝)。
> - **剩余优化(2026-08-31 第三轮)**:
>   ① **M5——WbMarkdown 流式接线落地**:桥 upsertChatText 置 `_streaming`
>   标志(首个 delta 占行时 true,text:end 清),模板两处绑
>   `:streaming="busy && m._streaming"`;组件 `didStream` 语义精化为
>   「source 在流式窗口内真正推进过」(streaming 翻 true 本身不渲染、历史
>   消息零多余 parse——mount 后才进 busy 的实例不会被误标),翻 false 仅对
>   流过的实例做终态全量重渲染;run finally 兜底清全部 `_streaming`(异常
>   截断也翻终态)。C10 增量管线从死代码转生产路径(长回复 O(n²)→O(n))。
>   补 2 条 didStream 行为测试(懒重渲染/真流式终态重渲)。
>   ② **minor**:m1 `__resetEnabledCacheForTest` 测试复位钩子;m3 审批卡
>   v-if 加 `aguiBridge &&` 显式红线防御;m5 回放态不再写 lastState(与
>   运行态分离,stopAgentRun 收尾不受回放干扰)。m2(turnUsages 末位精度)、
>   m4(tool:result 迟到回退,协议 ended 门已挡)、m6(store 组件未接线,
>   C12/C13 预留)留档不做。
>   回归:前端 185/185、后端 124/124、build:copy 已刷新。
>   **运行时冒烟(2026-08-31)**:① M4 全链路——AG-UI run 挂起 → approve →
>   SSE 实时下发 `tool_approval_resolved`(approved:true),run 收口的
>   rejectPending 也产生 approved:false 回执,两类均旁路落库(threads/messages
>   尾部可查,records 已带 createdAt)——实时多窗口 + 回放终态闭环实证;
>   ② 外部 MCP 无身份透传——独立客户端 initialize 建会话 → `wb_list_templates`
>   直通返回,query 通道修通后外部白名单调用**不再被门控挂起**(修复前
>   fail-safe 语义会误伤,新语义实证兼容);③ 同 run 的 `wb_sync` CUSTOM 在
>   新管线正常下发(桥侧 applyExecutionSideEffect 消费路径就绪)。
> - **真实执行验证(dev 实机,ComfyUI 本机)**:文本工作流
>   (PrimitiveString→SaveText)经灰度链端到端成功——AG-UI run → 门控挂起
>   (`tool_approval_required`)→ approve → wb_run_workflow 真实提交 ComfyUI →
>   产物文件落盘(内容逐字节正确)→ executions 记录 + wb_artifact + 历史回放
>   278 条事件。错误反馈环同样验证:缺输出节点/缺必填参数/节点类型错三级
>   ComfyUI 错误均经 wb_error 回传并由模型正确转述,失败 execution 落库。
>   实机另发现并修复:C4 store 装配缺失(落库旁路失效)、turnUsages 分支
>   位置错误(事件包在 thread_event 内层)。
> - **测试基线(最终)**:后端全量 4898 过/3 失败/2 skip——3 失败 + canvas.debug/
>   canvas.ops 2 套件为分支既有问题(settings.ts 导入链在 node 环境
>   `electron.app` 未定义,干净基线复现),非本次引入;typecheck 零错误、
>   lint 0 错误(42 预存警告)、build 通过;前端 180 用例全绿(3 次无 flake)。

## 并行执行方案

关键路径:`C1 → C2 → C4 → C8 → C9`。**C1(事件 schema)是前后端唯一契约点**——C1 先行(约半天),
之后拆 4 条可并行的工作流:

| 工作流 | 组件 | 触碰文件区 | 前置 |
|---|---|---|---|
| **A 后端流式** | C2 → C4(+C6 回归门) | `agui/codexMapper.ts` · `routes/agui.ts` · server.ts 注册 1 行 | C1 |
| **B 后端存储** | C3 → C5* | `agui/eventStore.ts` · `routes/aguiThreads.ts` | 无(C3 即刻可开工) |
| **C 前端管线** | C8 → C9 → C11/C12/C13 | `packages/frontend/src/{utils/agui, stores, views/workbench}` | **仅需 C1**(拿 schema 用 fixture 开发,不等 C4 出真实端点) |
| **D 独立件** | C7 · C10 · C14(状态机) · C16 spike | C7: `routes/workbench.ts`+`mcp/workbenchTools.ts` · C10: `WbMarkdown.vue` · C14: `agui/approvalGate.ts` | 无,即刻可开工 |

\* C5 为并行而拆独立 router 文件(见冲突地图)。

**冲突地图(并行时必读)**:
1. C4 与 C5 原计划同写 `routes/agui.ts` → 并行时 C5 落 `routes/aguiThreads.ts`,
   各自一行注册进 server.ts,互不触碰对方文件。
2. C7 与 C14 都想动 `workbenchTools.ts` → C14 门控独立成 `agui/approvalGate.ts`,
   在 registry 组合处(`mcp/index.ts` 的 `createWorkbenchAugmentedRegistry` 外包一层)接入,
   workbenchTools.ts 零改动;但 C14 读取会话上下文的机制受 C7 影响——
   **C14 状态机+端点可先行单测,最终接线排在 C7 落地之后**。
3. `server.ts` 是唯一多点触碰文件(每条工作流 ≤1 行注册),任意合并顺序无冲突。

人力/agent 容量映射:
- 1 人:按依赖图串行,顺序 C1 → A → B → C → D。
- 2 人:A+D ∥ B+C(B 很小,并到前端线)。
- 3 人(或 3 个并行子代理):A ∥ B+D ∥ C——即 C1 合入后,后端流式、后端存储+独立件、前端管线三线齐开。

## 明确不做(Non-Goals)

- 不迁移 waa 任何 Java 代码或 Vue2 组件代码(仅协议与交互蓝本)。
- 不引入 Spring/Nacos/Redis/Kafka 等任何 SNC 设施等价物。
- 不改动 `plan.ts` 校验语义、wb_* 工具 schema、executor 执行链(PLAN 内部 IR 红线)。
- 不做多用户/远程访问模型(维持回环监听 + 单用户桌面定位;`/mcp` Bearer 机制保持现状)。
