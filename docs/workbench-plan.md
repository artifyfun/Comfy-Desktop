# Artify Workbench（AI 工作台）方案

> 目标：在 A 界面新增一个「工作台」，用户用自然语言描述需求 → codex agent 选择/组装 ComfyUI 工作流 → 执行生成文本/图片/视频 → 结果在产物区预览 → **一键固化成 app**（进入现有 app 体系 + 市场）。
>
> 状态：**Phase 1 已实施**（2026-08-27，见文末实施记录）。方案 v2 含联网调研结论。

---

## 0.5 联网调研结论（2026-08-27，已核实）

### 官方 Comfy MCP（cloud.comfy.org/mcp，public beta）

工具面（[docs.comfy.org/agent-tools/mcp](https://docs.comfy.org/agent-tools/mcp)）：

| 类别 | 工具 | 对本方案的启示 |
|---|---|---|
| 发现 | `search_templates` / `get_template` / `get_template_schema` / `search_models` / `search_nodes` / `get_node` / `get_prompting_guide` | **官方原话："The server prefers matching pre-built templates before building a workflow from scratch, which tends to produce better results faster"** —— 模板优先于从零画图，与我们的决策 1 完全一致 |
| 生成 | `run_template`（模板+参数覆盖，**首选路径**）/ `submit_workflow` / `apply_slots`（参数覆盖应用到工作流内部值） | `run_template` = 我们的 PLAN 执行；`apply_slots` 的参数覆盖模式可抄 |
| 任务 | `wait_for_job`（免轮询）/ `get_output` / `use_previous_output`（**链式：上次输出作下次输入**）/ `submit_batch`（batch ID 跨会话有效） | `use_previous_output` 值得抄：图→视频链式工作流的钥匙 |
| 应用化 | **`create_app`** —— "Turn a saved workflow into an App Mode app" | **官方已验证「工作流→app」这条路**，我们的「固化成 app」同构 |
| 本地版 | `server_info`（先调用）/ `run_workflow` / `validate_workflow`（**对 live `/object_info` 预检**）/ `search_models`（本地盘）/ `fetch_outputs` | `validate_workflow` 比我们的 requiredModels 探测更强：执行前对真实节点图校验，应纳入 |

### 社区最强轮子：artokun/comfyui-mcp（[GitHub](https://github.com/artokun/comfyui-mcp)）

38 工具 + **42 skills** + 56 installer packs + 4 autonomous agents，自称 "not a bridge, a full control plane"。四个可抄的杀手锏：

1. **模型知识注入（skills）**：每个模型家族一份指南（sampler/CFG/分辨率/模型下载 URL），"Claude knows the right sampler, CFG, resolution without trial and error"。**我们有 design-system 注入 UI 生成，却没有对等的「生成参数知识」注入** —— 补上它，codex 选参数不再瞎猜。
2. **VRAM watchdog hook**：执行前查 `/system_stats`，<1GB 空闲就拦截告警。一行 fetch 的事，防 OOM 崩溃。
3. **WebSocket 实时进度**：连 ComfyUI `/ws?clientId=...` 拿 step 级进度（"step 5/14 36%"），替代轮询。executor 现用 getHistory 轮询——MVP 可保留轮询，视频长任务上 ws 体验碾压。
4. **installer packs**：custom nodes + 模型 URL + 工作流的 manifest，一键装环境。对应我们的「模板带 requiredModels + 缺失时给装模型指引」。

### Codex ↔ MCP 通道（已核实）

`codex mcp add <name> --url <https-url>` 写入 `~/.codex/config.toml` 的 `[mcp_servers.<name>]`，支持 streamable-http transport + headers Bearer（官方文档 Codex 小节原文）。**我们的内嵌 MCP 正是 StreamableHTTP + Bearer token** —— Phase 2 通道确认可行，零改造。

## 0. 核心洞察：我们已经有 80% 的轮子

| 能力 | 现有资产 | 工作台复用方式 |
|---|---|---|
| Agent 引擎 | `agentDriver.ts`（codex SDK + 内置二进制，runStreamed 事件流，SSE） | 直接复用，扩展为「工作台会话」 |
| ComfyUI 执行 | `mcp/executor.ts`：queuePrompt（API 格式）/ getHistory 轮询 / uploadMedia / interrupt / `/free` 显存管理 | 100% 复用，零新代码 |
| 持久化队列 | `batchRunner.ts`：jobs+pump、暂停恢复、断点续跑、autoShutdown | 工作台长任务入队复用 |
| 产物库 | `gallery/`（扫描 output、缩略图、收藏、目录管理） | 产物区直接查 gallery 表 |
| App 模型 | `appStore`：`template.workflow / template.prompt / template.paramsNodes` 三件套 | **固化成 app = 填一个现成的 App 对象** |
| UI 壳生成 | `build-app` 路由 + buildSpec（设计体系注入，刚修完超时/并发） | 固化时直接调 |
| 工作流编辑 | `ComfyuiPlayground` + `comfy_inject.js`（widget→参数挑选） | 模板入库时用；工作台「调整参数」可跳转 |
| AI 文本 | `routes/ai.ts`（DeepSeek，prompt 优化等） | 文本类需求（起名/文案/优化提示词）走这条，不进 ComfyUI |

**最大的一个洞察**：`appStore` 里每个已创建 app 的 `template.prompt` 就是一份**可直接执行的 API 格式工作流模板**（含参数节点映射）。用户积累的 app 越多，工作台的模板库越强——零成本冷启动。

## 1. 业界模式参考（0.5 节为已核实的一手来源，本节为补充）

1. **不让 LLM 从零画节点图**。官方 MCP 的设计自述与社区实践（artokun、RunComfy 等）殊途同归：**模板库 + agent 选择模板 + agent 填参数 + 代码校验后执行**。自由生成节点图不可靠（类型不匹配、节点不存在、模型缺失全是坑）。
2. Comfy-Org 官方模板库 [workflow_templates](https://github.com/Comfy-Org/workflow_templates)（**MIT，已核实**，844 stars，templates/ 下 1000 个分类模板 JSON）：可自由精选内置做种子库，无许可风险。
3. artokun 的 **panel orchestrator**（sidebar agent 驱动 live canvas）证明了「侧边栏 agent + 自然语言改图」体验成立——我们 Phase 2 的 codex 全 agent 模式同构，但它跑在用户自己的 CLI 登录上，我们跑在内置二进制上，体验更无缝。


## 2. 架构：两段式演进

### Phase 1 —— Plan-then-Execute（MVP，可控可靠）

```
用户输入需求（自然语言）
        │
        ▼
┌─ 编排层（新增 services/workbench.ts）────────────────────────┐
│ 1. 收集上下文：模板清单（内置种子 + 用户 app 工作流，含          │
│    paramsNodes schema 与能力描述）                             │
│ 2. codex 单轮决策（复用 agentDriver，注入两块知识到 spec）：       │
│    a. 模板清单（内置种子 + 用户 app 工作流，含 paramsNodes        │
│       schema 与能力描述）                                        │
│    b. 模型知识库（抄 artokun skills：按模型家族的 sampler/CFG/    │
│       分辨率/提示词风格指南，随模板元数据维护）                    │
│    产出结构化 PLAN（JSON）                                     │
│    { intent: 'image'|'video'|'text',                          │
│      workflow_id, params: {...}, 备注 }                       │
│ 3. PLAN 校验（抄官方 validate_workflow 思路：模板存在？参数类型/  │
│    范围对？**对 live /object_info 校验节点图与模型**（models.ts    │
│    有清单）；执行前 VRAM watchdog（/system_stats <1GB 拦截）       │
│    → 不合法打回 codex 重试 ≤2                                    │
│ 4. 执行：文本走 ai.ts；图片/视频走 executor（入 batchRunner 队列）│
│    链式支持（抄 use_previous_output）：上次产物自动可作下次输入   │
│ 5. 会话记录（sessions.json）：PLAN、执行记录、产物 gallery id    │
└──────────────────────────────────────────────────────────────┘
        │ SSE（复用 build-app 的事件流模式）
        ▼
工作台 UI（对话流 + 工具卡片 + 执行进度 + 产物缩略图）
        │ 满意
        ▼
「固化成 app」：模板.paramsNodes + 本次参数为默认值
        → build-app 生成 UI 壳（设计体系注入）→ appStore.createApp
```

### Phase 2 —— Codex 全 Agent（自主多轮）

- agentDriver 启动 codex 时通过 `configOverrides` 挂 `[mcp_servers.artify]`（url=内嵌 MCP + token），codex 在会话内**自主调用** `list_apps / get_app_details / run__<id> / get_execution_status / upload_image / stop_execution`
- Agent loop：看结果 → 不满意自己改参数重跑（「再暗一点、人物换左侧」）
- Plan-Execute 与全 Agent 并存：简单请求走 Phase 1 快路径，复杂/迭代请求走 Phase 2

### Phase 3 —— 增强（可选）

- 模板市场打通（market 视图已是 app 市场，加「工作流模板」tab）
- 会话历史 / 分享；多产物对比（同工作流多参数矩阵跑 batch）

## 3. 数据模型（新增）

```ts
// WorkflowTemplate：工作台模板 = app 三件套的可执行子集
interface WorkflowTemplate {
  id: string                    // builtin:<name> | app:<appId>
  name: string
  description: string           // 给 codex 看的能力描述（中英）
  mediaType: 'image' | 'video' | 'audio' | 'text'
  prompt: ComfyPrompt           // API 格式（直接可执行）
  paramsNodes: ParamNode[]      // 参数 schema（复用现有类型）
  requiredModels?: string[]     // 执行前探测（models.ts 清单比对）
  knowledge?: string            // 模型知识（sampler/CFG/分辨率/提示词风格，抄 artokun skills 思路）
  chainable?: boolean           // 是否可接上游产物（图→视频链式）
  source: 'builtin' | 'app'     // app 来源随 app 增删动态同步（复用 MCP registry sync 模式）
}

// WorkbenchSession：一次工作台会话
interface WorkbenchSession {
  id: string
  createdAt: number
  messages: Array<{ role: 'user' | 'agent' | 'system'; text: string; plan?: Plan; kind?: 'chat' | 'card' | 'progress' | 'artifact' }>
  executions: Array<{ promptId: string; templateId: string; params: Record<string, unknown>; outputs: string[] /* gallery ids */ }>
  pinnedTemplateId?: string     // 固化目标
}
```

- 模板清单实时聚合：`builtin:*`（打包内置，精选官方模板库改造）+ `app:*`（appStore 变更事件驱动同步，模式抄 `mcp/tools.ts` 的 registry.sync）
- 会话存 userData（模式抄 batch-queue.json 防抖落盘）

## 4. API（新增 routes/workbench.ts，挂 history() 之前）

| 接口 | 作用 |
|---|---|
| `GET /api/workbench/templates` | 模板清单（含 schema、模型可用性） |
| `POST /api/workbench/chat`（SSE） | 会话入口：plan 决策 + 执行 + 事件流（复用 build-app 的 SSE/超时/并发锁模式，锁粒度=每会话） |
| `POST /api/workbench/execute` | 直接执行某模板+参数（跳过对话，表单模式） |
| `POST /api/workbench/publish` | 固化成 app：`{ sessionId, executionIdx }` → build-app → createApp → 返回 appId |
| `GET /api/workbench/sessions` / `/:id` | 会话列表/详情 |

## 5. UI（A UI 新视图 /workbench，路由加 tab）

```
┌────────────────────────────────────────────────┬──────────────┐
│  对话流（滚动区）                                │   产物区      │
│  [user] 一段赛博朋克风的猫咪短视频，镜头拉近      │  ┌────┐      │
│  [agent·卡片] 选择模板：WanAnimate-运镜          │  │缩略图│▶    │
│     参数：prompt=…, 运镜=zoom-in, 时长=3s        │  └────┘      │
│  [agent·进度] ▓▓▓▓░░ 排队中(2) → 执行中          │  收藏/打开    │
│  [agent·产物] 3 张关键帧 + 成片 ────►            │  output 目录  │
│                                                 ├──────────────┤
│  [输入框：描述需求…                    ] [发送]   │ [⚡固化成 app] │
└────────────────────────────────────────────────┴──────────────┘
```

- 组件复用：BatchTaskFloat（队列状态角标）、gallery 缩略图组件、GenModal 的 SSE 消费逻辑
- 「固化成 app」流程：确认弹窗（模板参数=本次值的快照，可改名）→ 进度（build-app SSE）→ 跳转 app 详情页

## 6. 关键设计决策（已定，待确认）

| # | 决策 | 理由 |
|---|---|---|
| 1 | **不让 LLM 生成节点图**，只选模板+填参 | 可靠性是生死线；类型/模型/版本坑深不可测 |
| 2 | 文本生成走 ai.ts（DeepSeek），不进 ComfyUI | LLM 节点慢且弱；现有链路零成本 |
| 3 | 模板库 = 内置种子 + **用户 app 工作流实时同步** | 冷启动零内容；用户资产越用越厚 |
| 4 | Phase 1 plan-execute，Phase 2 codex+MCP 全 agent | 先可用后惊艳；两阶段共享全部数据模型 |
| 5 | 执行全走 batchRunner 队列 | 显存管理/autoShutdown/持久化白拿 |
| 6 | 固化时参数值=默认值快照 | 用户期望「和刚才一样」，参数面板预填会话值 |

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| codex 选错模板/填错参 | PLAN schema 校验 + 打回重试≤2；执行前 requiredModels 探测 + `/object_info` 节点图校验（官方 validate_workflow 同款），给出「去装模型」指引 |
| OOM 崩溃 | VRAM watchdog（抄 artokun hook）：执行前查 `/system_stats`，空闲 <1GB 拦截并提示（可强制继续） |
| 视频任务分钟级，会话中断 | 执行已在 batchRunner（持久化+断点续跑），会话重连恢复进度 |
| 模板带自定义节点未装 | 入库时对 live `/object_info` 校验（官方本地 MCP 同款做法），缺失标记 `unavailable` 并给出缺失节点清单 |
| codex 成本（Phase 2 多轮） | 会话轮次上限 + token 预算显示；DeepSeek 便宜是天然优势 |
| 内置模板许可 | ~~待核实~~ **已解除**：官方 workflow_templates 仓库为 MIT |

## 8. 工作量估算

| 阶段 | 内容 | 估时 |
|---|---|---|
| P1a | 模板库（聚合/同步/入库工具）+ 10~20 个内置种子 | 3~4 天 |
| P1b | workbench 服务（plan 决策/校验/执行/会话）+ API | 4~5 天 |
| P1c | 工作台 UI（对话流+产物区+固化流程） | 4~5 天 |
| P1d | 测试（plan 校验/执行/固化链路）+ 文档 | 2~3 天 |
| **Phase 1 小计** | **MVP 可用** | **约 3 周** |
| P2 | codex configOverrides 挂内嵌 MCP，全 agent 会话模式 | 1~1.5 周 |
| P3 | 模板市场 tab / 会话分享 / 参数矩阵 | 按需 |

## 9. 需用户拍板

1. 内置种子模板选型：首批主打哪些（文生图/图生图/首尾帧视频/局部重绘…）？有无目标模型清单（FLUX/Wan/SVD…）
2. 「文本」的边界：是否包含长文写作（走 DeepSeek 直接出）还是只做提示词优化辅助？
3. Phase 2 的 codex 自主重跑轮次上限（建议 3）与每日预算护栏要不要现在定？
4. 工作台入口位置：A UI 顶栏新 tab（建议）还是首页大按钮？

---

## 10. Phase 1 实施记录（2026-08-27）

### 新增文件

| 文件 | 职责 |
|---|---|
| `src/main/artifylab/workbench/templateCore.ts` | 纯函数层：`templateFromApp`（app→模板：媒体类型推断/模型依赖提取/chainable 标记）、`toPseudoApp`（模板→executor 可执行形状）。无 electron 依赖可单测 |
| `src/main/artifylab/workbench/templates.ts` | 模板库单例：双源聚合（builtin 空 + app:* 实时同步，appStore change 清缓存），`describeTemplatesForAgent`（决策裁剪视图） |
| `src/main/artifylab/workbench/plan.ts` | PLAN 校验：本地（模板存在/参数类型/枚举/min-max）+ 远端（`/object_info` 节点图与模型探测 + `/system_stats` VRAM watchdog <1GB 拦截） |
| `src/main/artifylab/workbench/service.ts` | 编排：codex 单轮决策（PLAN JSON 提取容错）→ 校验 → 执行（复用 `executor.executeApp`，含 seed/媒体上传/`/free` 显存管理/链式输入）→ 会话持久化（userData/workbench-sessions.json，防抖落盘，上限 50 会话） |
| `src/main/artifylab/routes/workbench.ts` | 路由：templates/sessions CRUD、chat（SSE：deciding→plan→validating→submitted，5min 超时+并发锁 1）、poll（3s 轮询）、publish（固化=createApp+可选 build-app UI 壳） |
| `packages/frontend/src/views/workbench/index.vue` | 工作台视图：左对话流（卡片/进度/错误/invalid 提示）+ 右产物区（状态/文件/固化按钮）+ 固化弹窗（命名/是否生成 UI）；会话 URL 持久化（?session= 刷新可续，运行中自动恢复轮询） |

### 修改文件

- `agentDriver.ts`：导出 `resolveCodexBinary` 与 `Codex`（供 workbench 复用）
- `server.ts`：挂载 workbench 路由（history() 之前）
- `router/index.js`：`/workbench` 路由
- `AppHeader.vue`：顶栏「AI 工作台」入口
- `i18n.js`：zh/en 各 26 个 workbench 键

### 测试（23 个新测试）

- `templateCore.test.ts`（templates.test.ts）：app→模板转换（媒体推断/video class_type 兜底/chainable/模型去重/空 prompt 拒绝/伪 App 形状）
- `plan.test.ts`：PLAN 校验（chat/text/image 意图分支、数字范围/类型、枚举匹配、布尔、未知参数）+ codex 输出 JSON 提取容错（裸/markdown 包裹/前后杂文/无 JSON）

### 与方案的偏差

- `BUILTIN_TEMPLATES` 暂空：MVP 先验证 app:* 源链路，内置种子（官方 MIT 模板库精选）留到有真实使用反馈后填充
- 固化的「参数值=默认值快照」暂未写回 paramsNodes（`publishToApp` 保留快照入参，快照回写待 UI 参数编辑器配套）
- publish 生成 UI 时 html 资产落盘链路（persistAsset）未接：build-app 返回的 html 目前仅内存传递，待与 app 资产存储打通

### 遗留（Phase 2+）

- codex 决策重试回环（PLAN invalid → 带错误信息重新决策 ≤2）目前路由层只报 invalid，未自动重试
- 会话标题自动生成（现固定「工作台」）
- 产物区图片缩略图（现显示文件名，待接 gallery 缩略图链路）
