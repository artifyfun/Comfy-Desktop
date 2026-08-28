# 工作台 Harness 化架构研究

> 状态：研究分析（未改代码）｜日期：2026-08-28  
> 目标：让 AI 工作台从「一次提示词 → PLAN JSON → 路由执行」变成**完整的 agent harness**（模型在持续会话里自主 思考→行动→观察→修正，直到完成任务），并评估「直接嵌入 DeepSeek Harness」的可行性。

---

## 0. 结论速览

| 问题                           | 结论                                                                                                      |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| 能不能嵌入 DeepSeek Harness（dsh）？ | **能，但不建议当前直接嵌入**。dsh 是 v0.1 完整产品（CLI+WebUI），嵌入=双 UI/改源码，且它面向「编码 agent」而非「ComfyUI 生图 agent」，接入成本≈推倒重来    |
| 最优路径是什么？                     | **把已内置的 codex 引擎的 harness 能力真正用起来**——它本身就是完整 agent harness（多轮对话/工具循环/沙箱/审批/事件流），当前架构把它阉割成了「单轮 JSON 决策器」 |
| 核心改动一句话                      | `decide` 从「spawn 一次 codex 出 JSON」→「会话级持续 Thread + 模型经 wb\_* 工具自主闭环，PLAN JSON 降级为简单需求快路径」                |

**推荐方案：A（用足 codex harness）为主，P2 再评估 dsh 整体替换。**

---

## 1. 现状架构解剖

### 1.1 一次消息的完整生命周期

```
用户消息
  → routes/workbench.ts POST /api/workbench/chat（SSE）
    → service.decide():
        - 预处理（斜杠 token/预设展开）
        - 起内嵌 responses→chat 代理（非 deepseek 官方端点时）
        - mkdtemp 临时 CODEX_HOME（注册 MCP server，wb_* 工具回环到本进程 /mcp）
        - new Codex() + codex.startThread() + runStreamed(spec)   ← 单轮！
        - 收集 JSONL 事件 → 透传前端（item 流）
        - 用完即关代理 / 删 tempHome
        - parsePlanFromCodex(raw) → PLAN JSON
    → 路由层：
        - validatePlanLocal / validateRemote
        - intent=memory/chat/text → 直接回复
        - intent=image/video/audio → execute() 提交 ComfyUI → 前端轮询 pollExecution
        - 失败 → 前端 autoRecover 再喂一轮 decide
```

### 1.2 关键事实：harness 能力其实已在手，但被主动放弃

| 已具备                                                                                       | 现状使用                                                                              |
| ----------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| `Thread` 支持**一个线程多个连续 turn**（SDK 类型注释明文："One thread can have multiple consecutive turns"） | 每次 decide 新建 Thread，跑**一轮**就销毁（tempHome 删、代理关、上下文全丢）                              |
| 模型可经 **wb\_* MCP 工具\*\*自主调用（wb_execute_template / wb_list_nodes / wb_run_workflow…）       | 工具在**同一轮 exec 内**可用，但一轮内工具调用受模型单轮能力限制，且执行产物**不回流**给模型（执行发生在 decide 之后的路由层，结果只进前端） |
| 沙箱（workspace-write / danger-full-access）+ 审批策略 + AbortSignal 取消                           | 已配置（approval=approve / standard 默认）                                               |
| 事件流（item.completed 条目驱动，前端实时渲染工具调用/推理）                                                    | 已打通（SSE `item` 事件 → tool_item 气泡）                                                 |

### 1.3 阉割带来的问题（正是用户体感「很傻」的来源）

1. **模型看不到执行结果**：工具执行（ComfyUI 提交）在 decide 之外由路由层做，成功/失败/产物只进前端，**不进模型上下文** → 模型对「这次到底成没成」毫无感知，只能靠前端 autoRecover 把错误再喂一轮。
2. **上下文断裂**：每轮 spawn 新进程新 Thread，模型没有「上次做了什么、产出在哪」的连续记忆（只能靠 spec 里注入的近史/上次产物摘要，是重建而非真上下文）。
3. **PLAN JSON 是中间物**：多步任务要模型「一次想完输出 JSON」——违背 agent 本质；真实任务需要边做边看边改。
4. **重试循环低效**：失败→前端再喂一轮 decide→又一轮完整 spawn（代理重建、context 重建），既慢又烧 token。

---

## 2. DeepSeek Harness（dsh）调研

### 2.1 是什么

- 2026-08-13 开源，**MIT**，TypeScript/Node（22.19+ 或 24+），CLI 名 `dsh`，`npx @deepseek-ai/dsh web` 起 Web UI（127.0.0.1:3080）。一周 16.5 万 star。
- 定位：**完整的编码 agent 产品**（对标 Claude Code / Codex / Cline / OpenCode），不是 agent 框架（不是 LangGraph 那类）。
- 核心架构：基于 **Cordis** 插件内核——「一切都是插件」：模型适配器、工具注册表、技能、会话日志、沙箱、存储、**agent loop**、调度、UI 九个子系统全部可配置替换。
- 四种子模式：standard（完整编码 agent）/ code（Code Mode SDK，工具合并进一个 TS 程序）/ minimal（两个工具的最小评估脚手架）/ creator（+运行时插件实验）。

### 2.2 与我们相关的强点

- **模型无关**：内置 DeepSeek/OpenAI/Anthropic/Google/OpenAI 兼容端点 → 我们的 new-api 网关 / deepseek 直连可直接用。
- **完整会话日志不变量**：每次模型调用都对照防篡改会话日志，失败可**重放**（replay-based CI）——调试/回归测试强。
- **fail-closed 沙箱**：沙箱无法约束的工具调用直接拒绝并给结构化错误（Windows 用 ACL restricted-token runner）。
- **loop 可替换**：工作台若想定制「ComfyUI 专属循环」（如生成→看产物→再生成），可挂自己的 loop 插件。

### 2.3 弱点 / 嵌入障碍

| 障碍                     | 说明                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------- |
| v0.1 developer preview | 官方 README 全大写明示 **breaking changes coming**；GitHub releases 无 tagged 版本（dev.to 核实） |
| 是产品不是库                 | CLI+WebUI+自有会话/存储，嵌入 Electron = 要么双 UI、要么改源码复用其插件（违反其产品边界）                         |
| 面向编码 agent             | 默认工具是文件/Shell/搜索；ComfyUI 生图工具（wb\_* 同类）仍需自己写，且要让 loop 理解「产物链」                      |
| 成本                     | Node 版本门槛、包体积、进程管理；替换 codex 意味着 **provider/代理/MCP 全套推倒重来**（本项目已在这上面修了 N 个坑）        |
| 共识                     | 社区两派：seed of Agent OS vs 过度设计；独立评测指 setup 繁琐、执行慢、token 消耗偏重                        |

### 2.4 判断

- **dsh 的正确用法**：作为「未来整体替换方向」持续跟踪（它成熟到可当嵌入引擎时——如出 stable 版本、提供 headless 嵌入 API）；以及**理念借鉴**（会话日志不变量、loop 可替换、replay 测试）。
- **现在直接嵌**：性价比低，且解决不了工作台核心痛点（执行结果回流模型、上下文连续）——这两个痛点用 codex 引擎本身就能解决。

---

## 3. 方案对比

| 维度       | A. 用足 codex harness（推荐）     | B. 嵌入 DeepSeek Harness      | C. 自研轻量 loop                       |
| -------- | --------------------------- | --------------------------- | ---------------------------------- |
| 本质       | 现有引擎解锁多轮会话 + 工具闭环           | 引入 dsh 进程/源码                | 直接 LLM API 自己写 Reason→Tool→Observe |
| 模型工具遵循   | 引擎打磨（Rust，Apache-2.0）       | 引擎打磨（TS）                    | 依赖自研解析质量，flash 级模型易翻车              |
| 执行结果回流模型 | ✅ 工具内闭环（本轮实现）               | ✅                           | ✅                                  |
| 上下文连续    | ✅ Thread 跨消息                | ✅                           | 自管上下文（要自己实现压缩/裁剪）                  |
| 改造量      | 中：service/routes/前端少量       | 大：双 UI 或源码嵌入 + 工具重写 + 全链路迁移 | 大：工具协议/沙箱/流式/审批/重试全自研              |
| 新依赖/风险   | 无（引擎已在）                     | 高（v0.1 breaking、无 tag、包体积）  | 中（全自研的维护面）                         |
| 会话日志/回放  | codex 事件流已有（debugLogs 已有雏形） | 最强（防篡改+replay）              | 自研                                 |
| 成本       | 低                           | 高（重构）                       | 中高（长期维护）                           |

**结论：A 是最优路径。B 的核心理念（完整会话日志、loop 可替换、replay 测试）作为 A 的演进目标吸收；C 不选。**

---

## 4. 推荐方案 A 详细设计

### 4.1 目标形态（Harness 化后的一次消息）

```
用户消息 → 会话级 Thread 继续
  → 模型自主循环（引擎驱动）：
      Reason → wb_execute_template / wb_run_workflow（提交 ComfyUI）
             → 工具结果回流（产物文件名/失败原因，进模型上下文）
             → 模型观察 → 继续或修正（node_overrides / 换模板 / 自组工作流）
             → 满意 → 输出最终回复
  → SSE 全程流式（item 事件实时渲染，与现状一致）
```

### 4.2 核心改造点

| # | 改动               | 说明                                                                                                                                                                                   |
| - | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1 | **Thread 会话化**   | `sessionId → { thread, tempHome, codex, proxy }` 映射（会话级缓存）；首次创建后**跨消息复用**，不再每次 spawn+销毁。proxy/CODEX_HOME 随会话生命周期管理（空闲超时回收）。应用重启后 thread 失效 → 降级：新 thread + 注入会话历史（现状的 activePath 摘要） |
| 2 | **执行进工具层**       | ComfyUI 执行从「路由层 execute+poll」下沉为 **MCP 工具**（wb_execute_template 已有 wait 模式；补齐 wb_get_outputs / wb_attach_previous）。产物路径、错误、图片预览信息作为**工具结果**直接进模型上下文 → 模型天然「看到」结果并自我修正                |
| 3 | **PLAN JSON 降级** | 保留为**简单需求快路径**（一句话出图/答复，直接 JSON 不绕工具）；复杂任务走工具闭环。二者按 spec 引导由模型自选，校验层不变                                                                                                               |
| 4 | **终止与预算**        | 每会话轮次上限（如 20 turn）+ token 预算（累计 usage 监控）；模型输出 final response 即结束；`done` 语义不变                                                                                                        |
| 5 | **审批/安全**        | 保持 approval=approve + workspace-write；新增可选「on-request 用户审批」模式（高风险 shell 弹窗确认）                                                                                                        |
| 6 | **取消**           | AbortSignal 已有；会话级取消需 kill 对应 thread（SDK signal）                                                                                                                                     |
| 7 | **失败自愈**         | 工具结果即反馈（错误直接进上下文），autoRecover 前端通道**退役**（引擎循环内自愈）                                                                                                                                    |

### 4.3 事件/前端影响

- SSE 事件流不变（`item` 条目流已是引擎事件直通），前端只需：
  - 会话级「agent 工作中」持续指示（turn 之间不断流）
  - 产物卡已存在；工具结果回流后模型能引用上一步产物（图生图链式）
- 调试信息（debugLogs）升级为**完整事件流快照**（天然满足用户之前的调试诉求）。

### 4.4 与已有能力的关系

- 上一轮 P1（node_overrides / wb_run_workflow / wb_clone_template）**直接成为 harness 的工具面**，模型在循环里可自主组合。
- 上一轮修的媒体参数校验/类型元数据**在 harness 下价值更大**：工具结果回流后模型能立即看到「把文本传进图片槽」的报错并当场纠正。

---

## 5. 分期实施计划

| 阶段               | 内容                                                                                                                                | 工作量 |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------- | --- |
| **P0（现状）**       | 快路径 + 前端 autoRecover，保持可用                                                                                                         | —   |
| **P1（核心，2~3 周）** | ① Thread 会话化（跨消息复用/重启降级/空闲回收）② 执行下沉工具层 + 产物回流模型 ③ PLAN 快路径保留 ④ 轮次/token 预算 ⑤ 前端会话级运行指示 ⑥ autoRecover 退役 ⑦ 测试（会话复用、工具闭环、预算中断、重启降级） | 中   |
| **P2（演进）**       | ① 会话日志升级为可回放（借鉴 dsh 不变量）② on-request 审批 ③ 产物链自动注入上下文（上一步图自动可用）                                                                    | 中   |
| **P3（评估 dsh）**   | dsh 出 stable + headless 嵌入 API 后再评估整体替换；当前仅理念跟踪                                                                                   | 评估  |

---

## 6. 风险与待决问题

| 风险            | 说明                                                                          | 缓解                                       |
| ------------- | --------------------------------------------------------------------------- | ---------------------------------------- |
| 多轮 token 成本   | harness 上下文累积，flash 级模型多轮开销大                                                | 轮次+预算上限；自动压缩（近史摘要回灌）；reasoning 模式按需      |
| 模型工具遵循度       | glm-5.3-flash 的工具调用稳定性决定体验                                                  | 快路径兜底（JSON）；工具 schema 精简；可切 reasoning 模型 |
| Thread 生命周期管理 | 长活进程、资源泄漏、重启恢复                                                              | 空闲超时回收；启动时清理孤儿 tempHome                  |
| 审批风险放大        | 工具闭环下模型行动更多                                                                 | 保持沙箱；高风险工具白名单；可选 on-request 审批           |
| 与「构建应用」共用引擎   | agentDriver（buildAppCode）与 workbench 共用 codex 二进制，改 SDK 用法互不影响（各自 Codex 实例） | 确认无共享可变状态                                |
| 前端断流观感        | 多轮 turn 之间无新事件时用户等得慌                                                        | turn 间发 progress 占位（已有 stage 机制）         |

**待用户拍板**：

1. 预算上限默认值（建议：单会话 20 turn / token 上限按模型 2~3 倍单轮量）；
2. 是否接受「简单需求仍走 PLAN JSON 快路径」的双轨设计（推荐保留，快且省）；
3. P1 是否同时把审批从 approve 升级为 on-request（默认先不动）。

