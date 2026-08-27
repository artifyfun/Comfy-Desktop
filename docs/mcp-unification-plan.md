# Artify MCP 体验统一 — 实施记录

> 背景：合并 upstream #1432 后，官方在桌面端加入了「Local MCP 分发界面」（侧边栏按钮 + McpSetupModal 弹窗，引导用户 `pip install comfy-mcp` 外部 server）。Artify 已内嵌自己的 MCP server（`localhost:<port>/mcp`，A UI app 即工具），两套入口并存导致体验分裂。本文记录统一方案的落地。

## 决策

| 决策点 | 结论 |
|---|---|
| 局域网访问 | server 默认仅回环（`127.0.0.1`），`config.listenHost` 可显式放开（如 `0.0.0.0`） |
| 官方视频位 | 移除 comfy.org 宣传片（McpVideoPlayer 删除），弹窗改单列纯配置布局 |
| 重置 token | 提供（`POST /api/mcp/regenerate-token` + A UI 确认弹窗），旧 token 立即失效 |
| 实施顺序 | Phase 0（安全）→ 1（配置面）→ 2（C 界面接管）→ 3（文档） |

## Phase 0 — 安全加固（前置）

**问题**：`app.listen(port)` 未指定 host = 绑 `0.0.0.0`，整个 A UI server（含需 Bearer token 的 `/mcp`）暴露局域网，与文档声称的"仅回环"不符。

**改动**：
- `src/main/artifylab/config/listenHost.ts`（新）：`resolveListenHost` / `isLoopbackHost` 纯函数 + 单测
- `src/main/artifylab/appStore.ts`：默认配置新增 `listenHost: '127.0.0.1'`
- `src/main/artifylab/server.ts`：`startActualServer` 显式绑定 host；非回环监听时打 warn 日志

## Phase 1 — 配置 API + A UI 设置入口

**改动**：
- `src/main/artifylab/mcp/configInfo.ts`（新）：`buildMcpConfigInfo()`——endpoint/token/appCount/listenHost，HTTP 路由与桌面 IPC 共用
- `src/main/artifylab/routes/mcp.ts`（新）：`GET /api/mcp/config`、`POST /api/mcp/regenerate-token`（挂 history() 之前）
- `src/main/artifylab/mcp/auth.ts`：新增 `regenerateMcpToken()`
- A UI `packages/frontend/src/components/Config/index.vue`：设置弹窗新增 **AI 接入** tab——endpoint/token（打码+reveal+复制+重置）、三段客户端配置片段（Claude Code 命令 / Cursor JSON / 通用）、app 工具数说明、非回环监听告警
- `packages/frontend/src/utils/i18n.js`：zh/en 文案（`aiAccess` / `mcp*` 系列 key）

## Phase 2 — C 界面入口接管

**改动**：
- `src/main/host/attach.ts`：侧边栏插头按钮注入从「flag 开」改为「**默认开**」（`mcp_sidebar_enabled` 降级为远程 kill-switch，显式 `false` 才关闭）
- `src/renderer/src/views/mcp/McpSetupModal.vue`：重写为 Artify MCP 配置面板——数据经新 IPC `desktop2-get-mcp-config` 同进程直读；展示 endpoint / token（打码）/ 客户端片段 / app 工具数 / 非回环告警；保留 agent 安装链接；移除 comfy.org 视频、pip 引导与「终端内跑 agent」路径（HTTP server 无需终端）
- `McpVideoPlayer.vue`：删除（无引用）
- IPC 链路：`src/types/ipc.ts`（`McpConfigInfo` + `ElectronApi.getMcpConfig`）→ `src/preload/api.ts` → `src/main/popups/titlePopup.ts` handler（延迟 require，避免把 artifylab 服务层拽进 popup 模块图）
- `src/renderer/src/panel/PanelApp.vue`：移除 `open-terminal` 事件链（`handleMcpOpenTerminal`）

**遥测**：保留 `comfy.desktop.mcp.*` 命名空间（content script 与其测试已依赖），弹窗侧只保留 `snippet_copied` 事件。

## Phase 3 — 文档

- `docs/mcp-server-usage.md`：安全声明与实现对齐（默认回环 + listenHost 配置）；新增「UI 配置入口」一节；移除"暂无 UI 展示"限制
- 本文

## 遗留 / 后续

- A UI 的 MCP tab 与 C 界面弹窗数据同源（configInfo），但 C 界面弹窗暂无「重置 token」按钮（重置入口在 A UI 设置里）；需要时可在弹窗加同款确认按钮。
- `comfy.desktop.mcp.*` 遥测事件在 Artify 自己的 PostHog（若配置）里才有意义；未配置时为 no-op，不影响功能。
