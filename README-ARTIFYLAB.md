# ArtifyLab 分支（artifylab-v2）

本分支是 [Comfy-Org/Comfy-Desktop](https://github.com/Comfy-Org/Comfy-Desktop) 的 fork，在官方桌面版基础上内置 **A UI（ArtifyLab 前端）**：一个 Electron 窗口内同时承载「AI 应用生成与运行界面」和「ComfyUI 节点画布」，共享同一个 ComfyUI 后端。

上游 README 见 [README.md](README.md)，本文只介绍本分支的增量能力。

## 核心概念

- **A UI（ArtifyLab）**：面向普通用户的应用层。用自然语言描述需求，AI（DeepSeek 等）生成可运行的小应用（HTML 前端 + ComfyUI 工作流后端），表单填参即可出图，无需理解节点。
- **C UI（ComfyUI 画布）**：官方原生节点编辑器，与本分支新增功能完全共存，随时切换。
- **App**：A UI 的基本单位。`template.prompt` 是 ComfyUI API 格式工作流，`state.inputs` 是用户可调参数，`code` 是生成的界面 HTML。

## 本分支新增能力

### 应用（A UI）

- **App 管理**：创建 / 编辑 / 导入导出 / 分类搜索；AI 对话式构建（生成代码 / 修改代码 / 换构建风格）
- **版本历史**：每次更新自动快照（保留 20 版），可一键恢复；图标等资产落盘去重，不膨胀 JSON
- **依赖检查**：对比 ComfyUI `/object_info`，报告缺失的自定义节点与模型文件（checkpoint / LoRA / VAE 等），导入他人分享的 App 前一键体检
- **MCP 工具化**：所有已保存 App 自动暴露为 MCP 工具（`/mcp` 端点），AI 客户端填表参数即可直接执行完整工作流

### 生成结果资产库（Gallery，`/gallery`）

- 出图自动入库：SQLite 索引 + 本地缩略图，记录完整参数与工作流快照
- 星标、搜索、按 App 筛选；缩略图本地直出，原图走 ComfyUI `/view`
- **复用参数再跑**：详情页一键跳回对应 App 并回填当时的全部参数

### 模型管理（`/models`）

- 按类型浏览（checkpoints / loras / vae / controlnet 等 16 类）+ 占用空间统计
- **重复检测**：按「类型 + 大小」分组报告疑似重复及可释放空间
- **完整性校验**：safetensors header 解析（长度合法性 + JSON 结构），快速发现损坏文件

### 批量任务（`/batch`）

- Excel 驱动批量执行（xlsx 按需加载，不拖累首屏）
- 执行进度 / 成功失败统计 / 断点续跑 / 执行记录
- **完成后动作**：自动关机、手机通知（Bark / Telegram / Server酱等通用 webhook）

### 其他

- **外网访问**：内置 ngrok 支持（自动配置 comfy/server 双隧道）
- **同构 ComfyUI 客户端**：[`@artifyfun/comfy-ui-client`](https://www.npmjs.com/package/@artifyfun/comfy-ui-client)（npm 0.5.0，浏览器 / Node / Electron 通用）
- **ComfyUI 扩展注入**：启动时自动同步注入脚本，画布与 A UI 数据互通
- **零额外依赖原则**：新增后端能力尽量用 Node 内置（`node:sqlite`、`node:fs`），保持对上游的可合并性

## 数据位置（Electron userData）

| 内容 | 路径 |
|---|---|
| App 库 | `artify-apps.json`（electron-store） |
| 资产库索引 | `gallery.db`（SQLite，WAL） |
| 缩略图 | `gallery-thumbs/` |
| App 图标等资产 | `app-assets/` |

## 开发

```bash
pnpm install
pnpm dev        # 主进程 + 渲染层
```

前端位于 `packages/frontend`（pnpm workspace），本分支新增代码集中在 `src/main/artifylab/`（主进程）与 `packages/frontend/src/`（界面）。

### 开发调试

```bash
pnpm dev              # 一键起：前端 vite (5000) + electron-vite 主进程（DEV_MODE=true）
```

`pnpm dev` 实际执行 `pnpm --filter artifylab-frontend dev & cross-env DEV_MODE=true electron-vite dev`——A UI 前端跑在 vite dev server（热更新），Electron 窗口加载它；C UI（ComfyUI 画布）部分由 electron-vite dev 处理。

常用调试手段：

- **日志**：桌面运行日志在 `<userData>/logs/app.log`（含 ComfyUI Python traceback，排查节点报错先看它）；dev 模式下 vite/electron stdout 直接在终端。`<userData>` 即 `AppData/Roaming/artify-desktop`（win）或 `~/Library/Application Support/artify-desktop`（mac）
- **artifylab server**：主进程内置 Express（`src/main/artifylab/server.ts`），开发时端口自动选择；所有 `/api/*` 可直接 curl 调试
- **画廊/版本数据库**：`<userData>/gallery.db`（`node:sqlite`，可用任意 SQLite 工具直接打开，WAL 模式）
- **单独跑前端**：`pnpm --filter artifylab-frontend dev`（不启 Electron，浏览器访问 localhost:5000，需 `?server_origin=&comfy_origin=` query 指向已运行的桌面端）

### 校验

```bash
pnpm typecheck   # node/web/e2e/integration 四套
pnpm lint        # eslint（不含 frontend，frontend 用其自身 lint）
pnpm --filter artifylab-frontend lint
pnpm test        # vitest（注意：上游遗留 70 个失败为已知基线）
```

### 打包

```bash
pnpm build            # 前端产出到 src/main/artifylab/public/frontend + typecheck + electron-vite build
pnpm build:unpack     # build + electron-builder --dir（不装包，快速本地验证）
```

打包链路说明：

1. `build:frontend` → `pnpm --filter artifylab-frontend run build:desktop`：vite 构建 A UI 前端，**直接输出到 `src/main/artifylab/public/frontend/`**（并 minify `comfy_inject.js` 注入脚本）——A UI 前端作为主进程静态资源随包分发，不走 electron-builder 的额外文件声明（`electron-builder.yml` 与上游一致，未改）
2. `electron-vite build` 构建主进程/预加载
3. `electron-builder --dir` 出未安装目录结构（`dist/`），本地双击即可运行验证

正式发布走 ToDesktop 云构建（`todesktop:*` 脚本，与上游一致）；本地一般 `build:unpack` 验证即可。

前端库模式（发布 `ArtifyLib` 给生成代码使用）：

```bash
pnpm --filter artifylab-frontend build:lib    # dist/lib
pnpm --filter artifylab-frontend publish:lib  # 构建 + npm publish
```

## 与上游的关系

- 上游 0 差距：本分支 HEAD 的 merge-base 即 upstream/main 最新，可随时合并上游更新
- 仅新增文件 + 最小化修改既有文件，`electron-builder.yml`、打包链路等均未改动
- 上游原 README、贡献指南、测试体系保持原样
