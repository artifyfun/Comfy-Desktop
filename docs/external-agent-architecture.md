# 外部 Agent 接入架构（ACP / Claude Code）

> 状态:已落地(2026-09,9 commits)。本文是外部 agent 通道的架构地图与排障指南。
> 调研背景见 [research-external-agent-integration.md](./research-external-agent-integration.md)。

## 一图总览

```
前端 Config 面板(「外部 Agent 接入」区)
  │  workbenchAgentTransport: 'exec'|'appserver'|'acp'|'claude'
  │  workbenchAcpAgentBin:    'kimi'|'/usr/local/bin/qwen'|''(claude 缺省 PATH)
  ▼
/api/config/update → appStore.saveConfig          ←── UI 持久化
settings.json(手改,优先级更高)                    ←── 双读: settings → config
  ▼
agentRuntime.getOrCreate()
  ├─ findExternalTransport(transport)   ←── externalTransports.ts 注册表
  ├─ resolveExternalBin(def, rawBin)    ←── 缺二进制抛错(带 UI 指引)
  └─ def.create({sessionId, env, binary})
       ├─ acp:   createAcpRuntime   (agui/acp/)      spawn CLI → ACP JSON-RPC
       └─ claude:createClaudeRuntime(agui/claude/)   spawn CLI → stream-json JSONL
  ▼
runDecideTurn(agent, spec, onProgress)
  外部分支:external.startTurn → AG-UI 事件帧(mapper 直出,单跳)
  ├─ onProgress({type:'thread_event', event:AGUIEvent})
  ├─ TEXT_MESSAGE_CONTENT 聚合 → 流末补 exec 形态合成行(item.completed)
  ▼
routes/agui.ts onProgress 分发
  ├─ AGUI_EVENT_TYPES 白名单命中 → emit 直发(绕过 codexMapper)  ← ef527c0f 修复
  └─ exec 形态(codex 通道)→ codexMapper.feed → emit
  ▼
SSE data: {...}\n\n → 前端 handlers.js registry(21 种事件全支持,零改动)
```

## 关键设计决策

| 决策 | 理由 |
|---|---|
| 外部通道 mapper 直出 AG-UI(单跳) | codex 通道是「exec 事件 → mapper」两跳;外部 agent 的原生协议形态各异(ACP JSON-RPC / claude JSONL),各自 mapper 一步到位映射成 AG-UI,路由层统一消费 |
| 注册表驱动(externalTransports.ts) | 新增外部通道 = 加一个 def(id/requiresBin/create),agentRuntime 零改动(对齐 OpenDesign runtimes/defs 模式) |
| 流末合成 item.completed 行 | parsePlanFromCodexText 主路径认「item.completed + agent_message.text」——外部通道拼接正文合成该行,PLAN 提取零改动闭环 |
| 路由层 AG-UI 白名单直通 | 外部事件若喂 codexMapper 会被 default 分支吞掉(已踩坑,ef527c0f 修复);RUN_STARTED/RUN_FINISHED 仍归路由(防双帧) |
| claude 走裸 CLI 而非 Agent SDK | 比 claude-agent-acp 适配器少一跳进程;prompt 走 stdin 规避双平台 argv 上限;--resume 跨轮上下文(真机实测:暗号跨轮可复述) |
| ACP 用官方 SDK ClientSideConnection | @zed-industries/agent-client-protocol@0.4.5 仅依赖 zod;request_permission 桥接 approvalGate(approve→allow_once / reject→reject_once) |

## 通道对照

| | exec(默认) | appserver | acp | claude |
|---|---|---|---|---|
| 二进制 | 内置 codex | 内置 codex | 必填(kimi/qwen/gemini…) | 缺省 PATH 里的 claude |
| 协议 | JSONL(exec --json) | JSON-RPC | ACP(stdio) | stream-json(JSONL) |
| token 级流式 | ✗ | ✓ | ✓(chunk 粒度) | ✓(块粒度) |
| 会话连续 | thread 复用 | thread 复用 | session 复用 | --resume(实测验证) |
| HITL 审批 | approvalGate(wb_*) | 同左 | request_permission→gate 桥 | CLI 侧 bypass(桌面 gate 不经手) |
| PLAN 提取 | item.completed 行 | 同左 | 合成行 | 合成行 |

## 排障

- **前端只看到最终回复、无流式过程** → 检查 routes/agui.ts 的 AG-UI 直通分支是否在(ef527c0f 后必有);再查事件 type 是否在 AGUI_EVENT_TYPES(拼写错误会落 codexMapper 被吞)
- **「codex 未输出可解析的 JSON PLAN」** → 外部通道正文里没有 PLAN JSON:该通道本质是"另一个大脑"直接对话,PLAN IR 只在 codex 通道有提示词保障;外部通道回复自然语言时走 no-plan 分支(chat 兜底)
- **ACP 缺二进制报错** → resolveExternalBin 抛错带 UI 指引,按提示在 设置 → 外部 Agent 接入 填
- **claude 旧版 CLI** → --include-partial-messages 需 capability 探测后注入(当前默认关,整块输出够用)
- 真机冒烟脚本:`npx tsx scripts/smoke-claude-transport.mts`(两轮 + 暗号验证)

## 测试地图

| 文件 | 覆盖 |
|---|---|
| agui/acp/mapper.test.ts(9) | update→AG-UI 映射:幂等/自愈/降级 |
| agui/acp/transport.test.ts(9) | 握手/单turn/取消/审批桥(mock 连接) |
| agui/claude/mapper.test.ts(7) | stream-json 映射(真实 CLI 采集夹具) |
| agui/claude/transport.test.ts(6) | argv/resume/abort/收口(mock 进程) |
| workbench/externalTransports.test.ts(5) | 注册表完整性/bin 解析 |
| workbench/externalChannel.test.ts(3) | decide 链路集成:合成行/PLAN 提取 |
| routes/agui.test.ts(2 例新增) | AG-UI 直通回归 + codex 通道互不干扰 |
| scripts/smoke-claude-transport.mts | 真 CLI 端到端(手动跑) |

## 演进方向(未做)

- ACP mcpServers 注入(当前 newSession 空):把 wb_* 工具面挂给外部 agent
- claude capability 探测(--include-partial-messages / fork 兼容 fallbackBins)
- 前端工具卡对 acp_tool_update CUSTOM 的细粒度消费(当前忽略,前向兼容)
