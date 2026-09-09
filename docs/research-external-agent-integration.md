# 外部 Agent 接入开源方案调研

> 调研问题：AI 工作台 / AI 侧边栏目前自研了一套 AG-UI 风格协议（`src/main/artifylab/agui/`，约 4100 行 TS），
> 开源世界是否有更标准化的「外部 agent 接入层」可以替代或简化这套自研协议——
> 特别是接入 Claude Code、Codex 等外部 CLI agent。
>
> 调研日期：2026-09（版本号、star 数均为当日 npm registry / GitHub API 实测）。
> 所有关键论断均附一手来源；标注「待验证」的除外。

---

## TL;DR

1. **不存在「一个协议包打天下」**。业界实际分化为三层：**AG-UI**（agent 后端 ↔ 前端 UI 的呈现协议）、
   **ACP**（宿主应用 ↔ 外部 CLI agent 的控制协议）、**vendor SDK/私有传输**（Claude Agent SDK、codex app-server）。
   我们的自研 agui 属于第一层，**这层不用换**；真正缺的是第二层——标准化接入任意外部 agent 的能力。
2. **最值得跟进的是 ACP（Agent Client Protocol）**：Zed 主导、JetBrains 背书，官方 JSON-RPC over stdio 协议，
   已有 **40+ agent** 原生或经适配器支持（Gemini CLI、Codex、Claude、Cursor、Kimi、Qwen、Copilot CLI、OpenCode…），
   官方 TS SDK `@zed-industries/agent-client-protocol@0.4.5` 零重依赖（仅 zod）。
   做一次 ACP host，等于一次接入整个编码 agent 生态。
3. **接入 Claude Code 有两条路**：Claude Agent SDK（`@anthropic-ai/claude-agent-sdk@0.3.266`，进程内 SDK）或
   裸 CLI `claude -p --input-format stream-json --output-format stream-json`（OpenDesign 采用，兼容 fork/旧版更好）。
4. **OpenDesign（94.9k star，Apache-2.0）是目前最好的工程蓝本**：它的 `agent-protocol/`（ACP/codex-app-server/dsh-profile/pi-rpc
   四个适配器）+ `runtimes/defs/`（28 个声明式 agent 定义，`streamFormat` 路由）正是我们想做的事的成熟参考实现，
   且其 codex app-server 归一化思路与我们 `codexMapper.ts` 惊人地一致（"one mapping, not two"）。
5. **不建议**：用 `@ag-ui/*` npm 包替换自研 agui（0.0.x 早期，事件面与我们已有实现同构，无净增益）；
   引入 CopilotKit 全家桶；把所有 agent 强行统一到单一传输（OpenDesign 的教训恰恰相反——每个 agent 用它原生的最优传输）。

---

## 一、三层协议地图（先建立坐标系）

```
┌─────────────────────────────────────────────────────┐
│  前端 UI（工作台聊天层 / 侧边栏）                       │
│  ▲                                                   │
│  │ 呈现协议：AG-UI（21 种事件：TEXT_MESSAGE_CONTENT、   │
│  │ TOOL_CALL、THINKING、HITL state 等）                │
│  │ —— 我们已自研实现（agui/types.ts），保留            │
│  ▲                                                   │
│  │ 宿主控制协议：ACP（JSON-RPC over stdio）             │
│  │ initialize → session/new → session/prompt          │
│  │ permission 请求/应答、模型列表、MCP server 注入      │
│  │ —— 我们缺的就是这层                                 │
│  ▲                                                   │
│  │ vendor 私有传输：codex app-server(JSON-RPC)、        │
│  │ codex exec --json、claude stream-json               │
│  │ —— codex 我们已有（appServerClient.ts）             │
└─────────────────────────────────────────────────────┘
```

- **AG-UI**（CopilotKit 主导）：定义「agent 后端推给前端」的事件流（文本 delta、工具调用、状态同步、HITL）。
  它解决的是**呈现层标准化**，不管 agent 进程怎么拉起、怎么鉴权、怎么审批。
  npm：`@ag-ui/core@0.0.59`、`@ag-ui/client@0.0.59`、`@ag-ui/proto@0.0.59`、`@ag-ui/langgraph@0.0.43`、
  `@assistant-ui/react-ag-ui@0.0.58`（来源：npm registry 实测）。版本全部处于 0.0.x，协议仍在快速演化。
- **ACP**（[agentclientprotocol.com](https://agentclientprotocol.com)）：定义「**客户端**（编辑器/桌面应用/IDE 插件）
  如何**驱动**一个**agent**（CLI 子进程）」——会话生命周期、prompt 提交、流式更新、工具权限审批（HITL）、
  模型枚举、MCP server 转发。协议 v1 已稳定、v2 起草中；官方库覆盖 TypeScript/Kotlin/Java/Python/Rust
  （来源：[ACP 官网 Libraries](https://agentclientprotocol.com/libraries/typescript)）。
- **vendor 传输**：每个 agent 的原生最优接口，功能最全但每家一个方言（见第四节）。

**结论**：三层的职责正交。自研 agui（第一层）继续当我们的内部标准；接入外部 agent 的新增工作全部落在第二/三层。

---

## 二、ACP（Agent Client Protocol）——重点推荐

### 2.1 协议形态

- 传输：JSON-RPC over stdio（子进程 stdout/stdin，JSON-line 分帧）。与我们的 `appServerClient.ts` 同构，
  团队已有同型经验。
- 握手：`initialize`（协议版本协商）→ `session/new`（或 `session/load` 恢复会话）→ `session/prompt`（提交轮次）
  （来源：[OpenDesign agent-protocol/acp/session.ts 模块文档](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/agent-protocol/acp/session.ts)，实读确认）。
- 内建能力：流式 session update（agent 文本/思考/工具调用）、`session/request_permission`（HITL 审批——
  OpenDesign `rpc.ts` 里有 `choosePermissionOutcome`，实读确认）、模型列表探测（`detectAcpModels`）、
  MCP server 注入（stdio 与 http/sse，`session-params.ts` 的 `AcpMcpServerInput`）。

### 2.2 生态（官方 [Agents 列表](https://agentclientprotocol.com/get-started/agents)，2026-09 抓取）

原生支持（部分）：Gemini CLI、Qwen Code、Kimi CLI、Cursor CLI、OpenCode、Goose、GitHub Copilot CLI
（public preview）、Kiro CLI、Qoder CLI、Mistral Vibe、Cline、OpenHands、Factory Droid、Poolside…
经适配器支持：
- **Codex CLI** ← [agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp)（360 star，2026-09 仍在更新）
- **Claude** ← [zed-industries/claude-agent-acp](https://github.com/zed-industries/claude-agent-acp)（2,505 star，
  "Use Claude Agent SDK from any ACP client"，用 Claude Agent SDK 包了一层 ACP server）

### 2.3 TS SDK

- [`@zed-industries/agent-client-protocol@0.4.5`](https://www.npmjs.com/package/@zed-industries/agent-client-protocol)，
  唯一依赖 `zod@^3`（npm view 实测）。提供协议类型 + JSON-RPC 端到端编解码，host 侧可直接用。

### 2.4 桌面端集成成本评估

- 我们已具备全部前置能力：子进程管理（`appServerRun.ts`）、JSON-line 传输、AG-UI 事件落库（`eventStore.ts`）、
  HITL 门（`approvalGate.ts`）。
- 新增工作量：ACP host 适配器 = 握手 + update→AG-UI 事件映射 + permission→approvalGate 桥接。
  参考 OpenDesign `acp/`（约 1500 行含大量防御性处理），我们最小可用版 **3–5 天**（用官方 SDK 可再省 1 天类型/编解码工作）。
- 收益：一次接入 40+ agent；permission/模型/MCP 语义标准化，不再逐家写 mapper。

---

## 三、Claude Code 的接入面

两条路线，**不是二选一**——ACP 路线最终也建立在 SDK 之上：

1. **Claude Agent SDK**（[`@anthropic-ai/claude-agent-sdk@0.3.266`](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)，
   前身 claude-code SDK；npm 实测）。进程内 SDK，流式事件（含 partial message）、`canUseTool` 权限回调（HITL）、
   subagent/自定义 agent、`--add-dir` 工作区授权。适合做深度集成（我们与 codex 的 app-server 关系同构）。
2. **裸 CLI stream-json 模式**：`claude -p --input-format stream-json --output-format stream-json --verbose`
   （新版本加 `--include-partial-messages` 可拿到 token 级 delta）。OpenDesign 用的是这条：
   见 [`runtimes/defs/claude.ts`](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/claude.ts)（实读）：
   - prompt 走 **stdin** 而非 argv——规避 Linux `E2BIG`（单 argv ~128KB 上限）与 Windows `ENAMETOOLONG`（~32KB）；
   - **capability 探测**：`claude -p --help` 子串扫描 + 对 `--help` 里看不到的隐藏 flag（如 `--thinking-display`）
     做「值拒绝探测」——旧版 CLI 不认识的 flag 会直接 exit 1 杀死会话，必须先探测再启用；
   - `fallbackBins`：兼容 drop-in fork（如 openclaude），`claude` 不在 PATH 时按序尝试。
   - 解析器 [`claude-stream.ts`](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/claude-stream.ts)（实读）
     归并为 7 种 UI 事件：status / text_delta / thinking_delta / tool_use / tool_result / usage / 任务清单。
3. 值得注意：**stream-json 已是事实方言**——OpenDesign 的 `amp`、`codebuddy` 两个 agent 直接声明
   `streamFormat: 'claude-stream-json'`（defs 实读），一份解析器吃三家。

---

## 四、Codex 的官方接口面（我们已在这条路上）

- 我们当前：`@openai/codex@0.149.1`（`package.json` devDependencies，实读），双传输并存：
  `app-server`（JSON-RPC，协议标 experimental，升级需回归——见 `docs/workbench-agui-migration.md` 实测记录）
  + `exec --experimental-json` 兜底。
- OpenDesign 同样双传输，且 `app-server` 已是**默认**、`exec --json` 共存兜底
  （[`runtimes/defs/codex.ts`](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/codex.ts) 实读）。
  其 [`codex-app-server/normalize.ts`](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/agent-protocol/codex-app-server/normalize.ts)（实读）的设计规则与我们 `appServerTranslator.ts` + `codexMapper.ts` 完全同构：
  - **"one mapping, not two"**：把 app-server 通知翻译回 `exec --json` 的 frame 形状，复用同一个渲染分支，杜绝第二份映射漂移；
  - 仅四类信息无法经 exec frame round-trip（assistant delta / reasoning delta ×2 / token usage），由该层独有承载；
  - **降级不失败**：未知 method、未知 item type 一律忽略——"a codex upgrade that adds a notification must
    degrade to 'we render one thing less', never to 'the run fails'"。这条值得我们写进 `codexMapper` 的注释与测试。
- 另有官方 [codex-acp](https://github.com/agentclientprotocol/codex-acp) 适配器（TS 包一层 ACP server）。
  对我们价值有限：我们已直连 app-server，再隔一层 ACP 反而多一跳、少拿 delta 级信息。

---

## 五、OpenDesign 架构解剖（94,960 star · Apache-2.0 · TypeScript）

来源：[GitHub](https://github.com/nexu-io/open-design) + 源码实读（2026-09）。它是「本地优先 Claude Design 替代品」，
桌面应用 + daemon 架构，**26 个 CLI agent 运行时**。与我们相关性最高的是它的接入层三层结构：

### 5.1 `apps/daemon/src/runtimes/defs/*.ts` —— 28 个声明式 agent 定义

每个 agent 一个 `RuntimeAgentDef` 纯数据对象：`bin` / `fallbackBins` / `versionArgs` / `authProbe` /
`capabilityFlags`（--help 子串探测）/ `hiddenCapabilityFlags`（值拒绝探测）/ `fetchModels` / `fallbackModels` /
`buildArgs` / `streamFormat`。**新增一个 agent ≈ 新增一个 defs 文件，零逻辑改动。**

`streamFormat` 分布（28 个 defs 逐一实读统计）：

| streamFormat | agent | 说明 |
|---|---|---|
| `acp-json-rpc` ×8 | devin, hermes, kilo, kimi, kiro, reasonix, trae-cli, vibe | ACP 只是众多格式之一，**不是统一答案** |
| `claude-stream-json` ×3 | claude, amp, codebuddy | 事实方言 |
| `json-event-stream` ×3 | codex, mimo, opencode | codex 为 `app-server` 或 `exec --json` |
| `copilot-stream-json` ×1 | copilot | |
| `qoder-stream-json` ×1 | qoder | |
| `pi-rpc` ×1 | pi | 独立 RPC 方言 |
| `plain` ×6 | aider, antigravity, atomcode, grok-build, qwen, deepseek | 无结构化流，纯文本兜底 |
| 其他 | cursor-agent(json-event-stream), byok-opencode | |

**教训**：OpenDesign 没有把 26 个 agent 统一到 ACP，而是按「每个 agent 的原生最优传输」路由，
ACP 是其中覆盖面最大的**一种**格式。统一传输是伪目标，**统一内部事件模型**才是（它做到了）。

### 5.2 `apps/daemon/src/agent-protocol/` —— 传输适配器

- 星型拓扑：`core/json-line-stream.ts`（唯一共享原语）← `acp/`（8 个关注点文件：types/constants/json/
  models/rpc/session-params/session/updates）+ `pi-rpc/`（4 文件）+ `codex-app-server/` + `dsh-profile/`（DeepSeek Harness 原生运行时）。
  acp 与 pi-rpc **互不 import**，公共 API 走根 barrel 显式具名 re-export（README 实读）。
- `acp/session.ts` 承担：握手、权限应答、模型探测、MCP server 注入（含 **kimi 0.37.0 移除 stdio MCP 的版本门控**
  ——`acpStdioMcpRemovedInVersion: '0.37.0'`，这类真实世界坑位清单本身就是资产）、abort 清理。
- 我们与之对应的存量：`appServerClient.ts` + `appServerTranslator.ts` + `codexMapper.ts` ≈ 它的
  `codex-app-server/`，结构对得上，**可平移它的目录规范与降级原则**。

### 5.3 `packages/agui-adapter` —— 内部事件 → AG-UI 子集

- 把 daemon 内部事件流映射为 **6 种** AG-UI 事件（`agent.message` / `tool_call` / `state_update` /
  `ui.surface_requested` / `ui.surface_responded` / `run.lifecycle`），供 CopilotKit 风格客户端消费
  （`packages/agui-adapter/src/types.ts` 实读）。**未发 npm**，纯内部包。
- 这印证了分层：OpenDesign 内部有自己的事件模型，AG-UI 只是**对外导出**时的一个视图。
  我们的 agui/types.ts（21 种标准事件）比它的 6 事件子集更完整，无需回退。

### 5.4 可直接抄的运营细节清单

- prompt 一律走 stdin（argv 长度上限双平台坑）；promptViaStdin 逐 agent 可配。
- capability 探测两段式：`--help` 子串扫描 + 隐藏 flag 值拒绝探测；探测结果缓存到 `agentCapabilities`。
- 版本门控 workaround 表（kimi stdio MCP、claude `--include-partial-messages` ≥1.0.86、codex app-server 无版本协商）。
- 未知事件降级渲染，绝不 fail run。

---

## 六、其他值得关注

- **Vercel AI SDK**：ACP 有 [community provider](https://ai-sdk.dev/providers/community-providers/acp)，
  可把任意 ACP agent 当作 AI SDK 的模型/agent 用。对我们（Electron 主进程自持管线）增益有限，记录备查。
- **assistant-ui**：`@assistant-ui/react-ag-ui@0.0.58` 提供 AG-UI 的 React 渲染组件。
  我们前端是 Vue（`packages/frontend` 纯 JS），不适用，仅证明 AG-UI 前端生态在长。
- **vscode-acp**（[formulahendry/vscode-acp](https://github.com/formulahendry/vscode-acp)）：VS Code 侧 ACP client
  参考实现，host 侧写法可对照。

---

## 七、与现状对照

| 维度 | 自研 agui（现状） | ACP 接入层（新增） | Claude Agent SDK | codex app-server（现状） |
|---|---|---|---|---|
| 定位 | 前端呈现协议（内部标准） | 宿主 ↔ 外部 agent 控制协议 | Claude 深度集成 | codex 深度集成 |
| 覆盖 agent | 1（codex） | 40+（含 claude/codex 经适配器） | 1（claude） | 1（codex） |
| HITL | ✅ approvalGate | ✅ request_permission（标准语义） | ✅ canUseTool | ⚠️ app-server 实验性 |
| 流式 delta | ✅ | ✅（经 adapter） | ✅ partial messages | ✅（app-server 独有） |
| 模型枚举 | ❌ 写死 | ✅ 标准方法 | ✅ | ✅ |
| MCP 注入 | ✅（wb_* 内置） | ✅ 标准字段 | ✅ | ⚠️ |
| 主要风险 | 自维护成本 | v2 起草中，部分 agent 实现质量参差 | Anthropic 单点 | 协议 experimental，升级需回归 |

结论：**ACP 不替代 agui，是它的上游**。事件面映射关系（ACP session update → AG-UI 事件）与现有
codexMapper 完全同型，属于已验证过一遍的模式。

---

## 八、采用路线建议

**短期（1–2 周，增量、不破坏现有链路）**
1. **ACP host 适配器**（3–5 天）：新建 `agui/acp/`（沿用 OpenDesign 星型拓扑：core/acp 分层），官方 SDK +
   握手 + update→AG-UI 映射 + `request_permission`→`approvalGate` 桥。先接 1 个 ACP 原生 agent
   （推荐 **Kimi CLI** 或 **Qwen Code**——免费、本体即 ACP server、无适配器中间层）打通全链路。
2. **Claude Code 接入**（2–4 天）：`claude -p --output-format stream-json` 裸 CLI 路线（OpenDesign defs/claude.ts
   的探测与 stdin 投喂细节照抄），写 `claudeMapper.ts` → AG-UI 事件。比走 claude-agent-acp 少一跳进程。
3. 两者共用现有 `agui/types.ts` 事件落库与前端管线，前端零改动。

**中期（2–4 周）**
4. 把接入面重构为声明式 `RuntimeAgentDef` 注册表（对齐 OpenDesign defs 模式）：bin 探测 / capability 探测 /
   streamFormat 路由 / 版本门控，codex 现有双传输迁移为注册表的两个 entry。纯重构，3–5 天，测试护栏已就位
   （现有 4100 行里约一半是 *.test.ts）。
5. 评估 ACP v2 draft 跟进策略；app-server 协议在 codex 升级窗口做降级渲染加固（对齐 OpenDesign
   normalize.ts 的「未知即忽略」原则，补 codexMapper 测试）。

**不做**
- 不引入 `@ag-ui/*` 替换自研 types（同构无增益，0.0.x 溃缩风险）。
- 不经 codex-acp / claude-agent-acp 中转接 codex/claude（已有更优直连）。
- 不引入 CopilotKit / assistant-ui（React 系，与 Vue 前端冲突）。

---

## 九、参考链接

- ACP 官网：https://agentclientprotocol.com · [Agents 列表](https://agentclientprotocol.com/get-started/agents) ·
  [协议仓库](https://github.com/agentclientprotocol/agent-client-protocol)
- ACP TS SDK：https://www.npmjs.com/package/@zed-industries/agent-client-protocol
- Codex ACP 适配器：https://github.com/agentclientprotocol/codex-acp
- Claude ACP 适配器（Zed，基于 Claude Agent SDK）：https://github.com/zed-industries/claude-agent-acp
- Claude Agent SDK：https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk ·
  https://platform.claude.com/docs/en/agent-sdk/overview
- AG-UI：https://ag-ui.com · https://www.npmjs.com/package/@ag-ui/core · https://github.com/CopilotKit/CopilotKit
- OpenDesign：https://github.com/nexu-io/open-design ·
  [agent-protocol README](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/agent-protocol/README.md) ·
  [defs/claude.ts](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/runtimes/defs/claude.ts) ·
  [codex-app-server/normalize.ts](https://github.com/nexu-io/open-design/blob/main/apps/daemon/src/agent-protocol/codex-app-server/normalize.ts) ·
  [agui-adapter types.ts](https://github.com/nexu-io/open-design/blob/main/packages/agui-adapter/src/types.ts)
- Vercel AI SDK ACP provider：https://ai-sdk.dev/providers/community-providers/acp
- 内部现状：`src/main/artifylab/agui/`（types/codexMapper/appServerClient/approvalGate/eventStore）、
  `docs/workbench-agui-migration.md`（app-server 实测与迁移记录）
