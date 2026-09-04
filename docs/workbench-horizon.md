# 工作台（Workbench）横向总结 —— artifylab-v2 线

> 状态：现状存档（截至 `2c80b7bc`，2026-09-04）
> 范围：2026-08-25 起的 v2 迭代线（约 210 commit，其中 workbench 直接相关 88 个）。
> 用途：给后来者一张全景地图——架构在哪、能力到哪、坑在哪、下一步往哪。

## 一、工作台是什么

嵌在宿主侧栏里的 AI 对话工作区：用户用自然语言驱动 AI 调用固化 App 工作流
（ComfyUI /prompt）与画布工具链，产物实时回流聊天窗并可上画布。技术底座是
**codex 引擎 + AG-UI 事件管线**，2026-08-25 起从 legacy SSE 自研管线整体迁移而来
（`0f8ff855`）。

一句话数据流：

```
用户输入（Composer）
  → 前端 aguiBridge（AG-UI 事件 → Vue 状态）
  → 主进程 workbenchProxy → codex 引擎（PLAN / 工具调用 / 审批）
  → ComfyUI /prompt 执行（appServerRun）→ 产物文件落盘 outputDir
  → 聊天窗消息流（ToolCallCard / ProgressCard / 图片气泡）
  → 可选上画布（wb_canvas_ops）/ gallery 索引（scanOutputDir）
```

## 二、代码地图（模块与体量）

| 层     | 模块                                                                                            | 行数 | 职责                                                            |
| ------ | ----------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| 主进程 | `workbench/service.ts`                                                                          | 2318 | 会话存取（50 上限/分支树/turnUsages）、preset、引擎装配、审批   |
| 主进程 | `workbench/workbenchProxy.ts`                                                                   | 283  | codex 引擎 HTTP 桥（SSE → 内部事件）                            |
| 主进程 | `workbench/appServerRun.ts`                                                                     | —    | ComfyUI /prompt 提交与产物提取                                  |
| 主进程 | `workbench/plan.ts` / `planBatch` / `templateCore` / `templates.ts`                             | —    | PLAN 校验、批量任务、模板派生                                   |
| 主进程 | `workbench/sessionTransfer.ts`                                                                  | —    | 会话导出/导入纯函数（originId 重复检测）                        |
| 主进程 | `workbench/sessionBundle.ts`                                                                    | —    | 零依赖 ZIP 组包（STORE 模式，CRC32/DOS 时间手写）               |
| 主进程 | `workbench/importRestore.ts`                                                                    | —    | 产物回填（路径穿越防御、`wb-import-<uuid8>/` 防覆盖前缀）       |
| 主进程 | `workbench/reasoningEffort.ts` / `docContext` / `selfKnowledge` / `skillsDeploy` / `presetCore` | —    | 推理强度透传、文档上下文、自我知识、技能部署、预设核心          |
| 主进程 | `routes/workbench.ts`                                                                           | —    | REST 面（会话 CRUD/导出导入/执行/审批/批量）                    |
| 前端   | `views/workbench/index.vue`                                                                     | 3531 | 主视图：消息流、导入导出、输入合成、会话管理                    |
| 前端   | `views/workbench/aguiBridge.js`                                                                 | 728  | AG-UI 事件 → Vue 状态（唯一聊天管线）                           |
| 剉端   | `views/workbench/components/*`（15 个）                                                         | —    | Composer/SessionSidebar/ToolCallCard/ProgressCard/WbMarkdown 等 |
| 前端   | `views/canvas/engine.js`（共享）                                                                | —    | LOD/裁剪/吸附/网格等纯函数（canvas 与 workbench 画布嵌入共用）  |

## 三、能力清单（按落地批次）

### 1. AG-UI 迁移与执行链路（8 月下旬）

- **唯一聊天管线**：legacy SSE 消费删除，aguiBridge 统一事件流（`0f8ff855`）。
- **执行前画布 tab 保证 / 画布连线修复 / 素材传参根治**（`c022a529` `25531d3f` `e2a81fdd`）：画布从“经常坏”到稳定可用。
- **画布整理能力**（`55e9f704`）：align/autoLayout ops（参考 ComfyUI-AlignLayout）。
- **digest 可寻址**（`869fb8de`）：D2 → `wb_canvas_ops` 宿主画布工具链闭环。

### 2. 智能体行为（E/B/P1 系列）

- **E1 推理强度**（`e45c01f9`）：reasoning_effort 下拉透传 codex。
- **B1 低危工具自动放行**（`5911afe2` `2cfef7de`）：risk-tier 表 + 会话级审批模式（保守/标准）。
- **P1-B3 任务进度卡**（`ab46542d` `1fa32e3c`）：runId 收敛原生 todo 清单 + 活动态合成兜底。
- **吸收 infinite-canvas 经验**（`161fea5e`）：A1 引用注入 / A3 IME 守卫 / A4 粘贴图。

### 3. 前端体验修复

- **侧栏嵌入布局**（`fee4242e` `dbbbb3c5` `8b5542f3`）：输入框截断/新 tab 空白/任务不渲染。
- **死按钮清理**（`c6c30ca1`）：embed 侧栏产物面板开关隐藏。

### 4. 韧性（resilience）

- **会话切换竞态守卫**（`82661d9d` `08e443f1`）：旧会话回放不再覆盖新会话。
- **断线重试**（`6e176bae`）：中断错误气泡一键重发本轮。

### 清单 5. 模型与消毒

- **model_catalog_json 注入**（`34967e81`）：根治第三方模型 "Model metadata not found"——codex 启动时写 `model_catalog.json` + config.toml 顶层 `model_catalog_json` 键（须在任意 `[section]` 之前）。
- **WbMarkdown 消毒收紧**（`15148ae8`）：DOMPurify `FORBID_ATTR:['style']`——Chromium 默认放行 style，可被 `position:fixed` 覆盖层钓鱼；happy-dom 恰好剥掉整个 div，但显式锁才是不变量。

### 6. 数据可迁移性（本轮收官四连）

- **会话 JSON 导出/导入**（`ecce22e2`）：`sessionTransfer.ts` 纯函数，schema v1，防 id 冲突。
- **完整包导出/导入**（`369fdc3d`）：`sessionBundle.ts` 零依赖 ZIP（STORE 模式——产物已压缩，无需 deflate）；导入端 EOCD→中央目录→STORE 切片自解析。
- **gallery 自动索引**（`276dc389`）：bundle 导入产物回填后异步 `scanOutputDir()`（递归含 `wb-import-*` 子目录，sqlite gallery.db + nativeImage 320px 缩略图）。
- **导入体验补强**（`1385c1c3`）：originId 同源检测（409 + 确认框 + force 放行）、XHR 上传进度浮条、成功提示带产物数。

### 7. 验收与资产

- **W4–W8 验收闭环**（`7d9699ac`）：3 项契约修复。
- **验收资产归档**（`e1322a8f`）：serve+stub+截图+README，可离线复跑。

## 四、关键设计决策（为什么这么改）

1. **AG-UI 事件统一管线**：三套 SSE 消费并存时消息乱序/丢事件不可排查；收敛到 aguiBridge 单点后，任何新事件类型只需在桥内加映射。
2. **零依赖 ZIP**：Electron 打包链路加 npm 依赖成本高（原生模块/签名）；产物本身 PNG/JPG 已压缩，STORE 模式只差 CRC32 + 头部拼装（约 200 行）。
3. **产物回填永不覆盖宿主文件**：`wb-import-<uuid8>/` 前缀 + 路径穿越防御（`..` 段拒绝 + resolve+startsWith 双保险）。产品原则：导入是纯增量操作。
4. **重复导入用 originId 而非内容哈希**：同源会话演进后内容哈希会变，originId（源会话 UUID）跨导出稳定；老导出件缺 originId 时 validate 兜底 `session.id`（语义等价）。
5. **LOD 纯函数化**：`lodTextVisible`/`lodImageVisible`/`lodNoteRectStyle` 全部抽进 engine.js——Konva 配置层薄、纯函数单测锁定阈值语义，避免视图文件里散落魔法数。
6. **审批分级**：一刀切审批打断心流，全放行有风险；risk-tier 表 + 会话级模式让用户自选信任档位。

## 四·五、踩过的坑（未来必看）

- **Konva `visible()` 不级联**：父 group visible:false 后子 shape `visible()` 仍 true（`isVisible()` 才级联）——剖析脚本曾因此误读数据。写性能剖析时一律用 `isVisible()`。
- **Konva perfectDraw 离屏中转**：opacity<1 且带 stroke 的 shape 每个都走离屏 canvas，千件全览实测一个数量级差（26~189ms vs 8~10ms）。缩略级一律 opacity:1。
- **codex config.toml 顶层键顺序**：`model_catalog_json` 必须在任意 `[section]` 之前，TOML 顶层键出现在 section 后会被解析进该 section。
- **前端 build 静默失败**：`>/dev/null 2>&1` 吞掉 RollupError（变量重名）；dev freshness gate 拦的是产物过期，两者叠加会让 E2E 长时间跑旧 bundle 而不自知。构建命令必须裸跑看 tail。
- **i18n 双语块插入**：zh 块与 en 块正则匹配易串块（en 词条插进 zh 块尾部）；先 `indexOf('en: {')` 切片再匹配。
- **Electron `app` 在单测不可用**：`settings.ts` 导入链会炸（`getPath` undefined）；纯函数测试保持零 Electron 依赖。
- **CDP 探测必须先 `--nav`**：页面 origin 未就位时 fetch 404/空；Electron 环境 25s 超时，绝不 await rAF。
- **GitHub push SSL_ERROR_SYSCALL**：瞬时网络抖动，15–45s 退避重试 1–2 次即过。

## 五、测试与质量门

| 门         | 命令                                           | 基线                            |
| ---------- | ---------------------------------------------- | ------------------------------- |
| 主进程单测 | `npx vitest run src/main/artifylab/workbench/` | 114 全绿                        |
| 前端单测   | `(cd packages/frontend && npx vitest run)`     | 296 全绿                        |
| 类型       | `pnpm run typecheck:node` / `typecheck:web`    | 0 err                           |
| Lint       | `npm run lint`                                 | 0 err（42 warnings 基线）       |
| pre-commit | husky                                          | typecheck + lint + format:check |

E2E 手法：Electron CDP（`node /tmp/cdp-eval.mjs --nav <url>`）+ API 探针 fetch；产物回填链已由单测锁定（真实 scanner 需 Electron 运行时，不进 CI）。

## 六、遗留与下一步

**已知遗留（按价值排序）**：

1. canvas LOD 第三轮（45ms 再往下）：需分块渲染/位图缓存，架构级改动，收益递减——暂缓。
2. 批量任务（planBatch）无暂停/恢复：只有取消。
3. 会话搜索：50 条上限内前端过滤即可，暂不需要索引。
4. WbMarkdown 更多消毒面（如 img src 协议白名单）未系统审计。

**下一步候选方向**（未排期）：

- 会话内全文搜索（跨消息 grep）
- 产物面板增强（按会话分组浏览 wb-import-\* 目录）
- 批量任务断点续跑
- 审批模式细粒度化（按工具而非按档位）

## 七、相关文档

- `docs/workbench-agui-migration.md` —— AG-UI 迁移方案（前置阅读）
- `docs/workbench-capability-upgrade.md` —— 早期能力方案（历史）
- `docs/canvas-parity-audit-retrospective.md` —— canvas 对齐复盘（画布工具链背景）
