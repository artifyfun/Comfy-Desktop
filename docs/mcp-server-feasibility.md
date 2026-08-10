# A UI 应用暴露为 MCP 工具 — 可行性与架构研究

> 状态：研究阶段，未改任何代码。本文档评估"把 artifylab-frontend（A UI）生成的每个 app 暴露为一个 MCP 工具、工具入参由 app 自定义参数决定、随 app 创建动态注册"的可行性，并给出基于 Comfy-Desktop 服务层的最佳实践方案。

## TL;DR

**完全可行，契合度极高。** A UI 的 `template.paramsNodes` 天然就是 MCP 工具的 `inputSchema`，类型系统一一对应；Comfy-Desktop 已有的 Express 服务（`localhost:3008`）+ `electron-store` 持久化层可零成本复用。MCP 2026 spec 原生支持运行时动态工具集（`listChanged` + `notifications/tools/list_changed`），TS SDK 的 `registerTool` 自动发送变更通知。

需要补 **3 个服务端缺口**：① 服务端 `App` 类型缺 `template` 字段；② 无 `/prompt` 代理（执行当前靠前端浏览器直发 ComfyUI）；③ image 参数无服务端上传路径。

---

## 1. 背景与目标

### 1.1 需求

1. 每个 A UI 生成的 app → 一个 MCP 工具，AI 可调用。
2. 工具入参由该 app 在 UI 上"暴露的参数"决定（动态 schema）。
3. 跨 app 公共参数（如 seed）考虑内置为公共入参 / 公共工具。
4. app 创建/更新/删除后，MCP 能动态注册/注销对应工具。
5. MCP 服务放在 Comfy-Desktop 侧。

### 1.2 仓库拓扑

| 仓库 | 角色 | git remote |
|---|---|---|
| `Comfy-Desktop` | Electron 桌面壳 + ComfyUI 管理 + artifylab 服务层（Express，`localhost:3008`） | `artifyfun/Comfy-Desktop` |
| `artifylab-frontend` | Vue 3 前端面板（A UI），app 生成器 | `artifyfun/artifylab-frontend` |

构建合流：`artifylab-frontend` `build:copy` 把产物拷到 `Comfy-Desktop/src/main/artifylab/public/frontend/`，生产环境由 Comfy-Desktop 的 `server.ts` 托管。

---

## 2. 现状分析

### 2.1 A UI 的 app 数据模型（`artifylab-frontend`）

权威 schema：`src/stores/appStore.js:340-357`（`getAppSchema()`）。

```
App = {
  id, name, description, category, powerLevel, createdAt,
  code,                       // 生成的 HTML 应用代码（内嵌 window.appTemplate）
  template: {
    workflow,                 // 原始 ComfyUI litegraph 图（编辑器回显 + extra_pnginfo）
    prompt,                   // API 格式 prompt：{ [nodeId]: { class_type, inputs: { widget: value } } }
    paramsNodes               // app 自定义的输入/输出参数列表 ← MCP schema 的来源
  }
}
```

**核心洞察**：`template.paramsNodes` 即工具入参 schema。每个 input 参数对应作者在 ComfyUI 工作流里"挑出来的某个 widget"，结构如下（构造于 `public/comfy_inject.js:718-823`，enrich 于 `src/components/ComfyuiPlayground/index.vue:106-116`）：

```ts
ParamNode = {
  id: number,                 // ComfyUI 节点 id —— 参数到工作流映射的键
  category: 'input' | 'output',
  type: string,               // ComfyUI 节点类型（LoadImage / KSampler / ...）
  name: string,               // 参数名（作者可改 alias）
  description: string,        // 参数说明
  selectedWidget: {
    name: string,             // widget 名（input）| undefined（output）
    type: string,             // widget 类型（string/number/slider/combo/toggle/...）
    options?: { values?, min?, max?, step?, precision? }  // 约束信息
  },
  renderComponent: string,    // UI 渲染组件 —— 类型系统的对外表达
  color, key                  // 画布高亮 / 排序
}
```

**类型映射**现成于 `src/utils/index.js:244-294`（`getRenderComponent`）：

| `selectedWidget.type` / 节点类型 | `renderComponent` | MCP inputSchema 等价 |
|---|---|---|
| `string` / `customtext` / `text` | `textarea` | `{ type:"string" }` |
| `toggle` | `switch` | `{ type:"boolean" }` |
| `slider` | `slider` | `{ type:"number", minimum, maximum, multipleOf }` |
| `number` | `input-number` | `{ type:"number" }`（含 min/max/step） |
| `combo`（普通） | `select` | `{ type:"string", enum:[...values] }` |
| `combo` + `LoadImage` | `image-uploader` | `{ type:"string" }`（base64/URL） |
| `combo` + `LoadAudio`/`LoadVideo` | `audio`/`video-uploader` | `{ type:"string" }` |

**默认值**不在 paramsNode 本身，在 `template.prompt[nodeId].inputs[widgetName]`（`genPrompt.js:32-35` 读取）。

**执行链路**（`src/controller/useWorkflow.js:209-264` `start()`）三步：
1. 随机化所有 `seed`（`:213-220`，硬编码强制随机，15 位整数）
2. 按节点 id 合并：`Object.assign(prompt[nodeId].inputs, state.inputs[nodeId])`（`:221-225`）
3. `ComfyUIClient.getResult(prompt)`（`:227`）—— queuePrompt + WS 进度 + history 轮询 + 输出聚合，实现在 npm 包 `@artifyfun/comfy-ui-client`

低层 `/prompt` 请求体格式（`src/utils/comfyui-utils/api.js:199-227`）：
```json
{ "client_id": "...", "prompt": {nodeId:{class_type,inputs}}, "extra_data": { "extra_pnginfo": { "workflow": {...} } } }
```

**无公共参数概念**：全仓库 grep 无 `commonParam`/`sharedParam`/`globalParam`。唯一隐式公共行为是 seed 强制随机化（执行层硬编码，非参数层）。

### 2.2 Comfy-Desktop artifylab 服务层

Express 跑在 **Electron 主进程内**（非独立进程），默认 `localhost:3008`（占用则顺序尝试 `[3008,3002,3003,9528,8082,5002,5003]`，`server.ts:840-903`）。启动：`src/main/index.ts:2181-2305`（`app.whenReady` 链路，`await startServer()`）。

**可直接复用的基础设施**：

| 资产 | 位置 | MCP 用途 |
|---|---|---|
| Express app 实例（可挂子路由） | `server.ts:826` `export default app` | 挂 `/mcp` 路由 |
| App 元数据 CRUD | `store/appStore.ts:47-104`，`/api/apps/*`（`server.ts:351-481`） | `list_apps` / `get_app_details` |
| 配置读取（comfy_origin 等） | `appStoreManager.getConfig()` / `artifyUtils.getConfig()` | 定位 ComfyUI |
| ComfyUI 只读代理 | `/view` `/history/:id` `/queue`（`server.ts:612-679`） | 查询工具 |
| `fetchWithRetry`（超时+重试） | `utils/fetch.ts:42-72` | 服务端调 ComfyUI |
| interrupt 逻辑 | `handlers.ts:34-45`（IPC `artify-stopExecution` → POST `/interrupt`） | `stop_execution` 工具 |

**App 持久化**：`electron-store`，文件 `artify-apps.json`（`appStore.ts:38-44`），结构 `{apps: App[]}`。

### 2.3 关键缺口（三个，必须补）

#### 缺口 ①：服务端 `App` 类型缺 `template` 字段

**冲突**（需明确决策）：前端 app 含完整 `template.{workflow,paramsNodes,prompt}`（`artifylab-frontend/appStore.js:340`），但 Comfy-Desktop 服务端 `App` 接口仅 `{id,name,description,createdAt,updatedAt}`（`store/appStore.ts:4-10`）。

缓解因素：`createApp` 用 spread 存任意字段（`appStore.ts:58-69`），所以 **`paramsNodes` 实际已落进 `artify-apps.json`**，只是 TS 类型未声明、服务端无法以类型安全方式读取。MCP 要可靠生成 schema，需显式扩展 `App` 类型补 `template` 字段（规则：显性化，别靠 cast 猜）。

#### 缺口 ②：服务端无 `/prompt` 代理

执行当前靠 A UI 浏览器直发 `localhost:8188/prompt`（`src/main/index.ts:2226-2244` 注释为证，主进程在那里给 8188 注入 CORS 响应头、剥离请求 Origin）。服务端只有 `/view` `/history` `/queue` 只读代理，**没有 `/prompt`、没有 `/interrupt` 的 HTTP 端点**（interrupt 仅在 IPC）。MCP 要"执行某 app"必须新增服务端执行路径。

#### 缺口 ③：image 参数无服务端上传路径

A UI 的 `image-uploader` 走 `client.uploadImage`（`useWorkflow.js:122-125`，前端 `POST /upload/image`）。MCP 侧 AI 传图（base64/URL）→ 服务端需等价上传 → 拿 ComfyUI 文件名 → 填入 prompt widget。

### 2.4 安全现状（必须收紧）

- CORS 默认 `['*']`（`server.ts:51-74`），允许 `Authorization`/`X-API-KEY`，方法全开。
- **无鉴权中间件**；`rateLimitMiddleware` 已注释掉（`server.ts:17,100`）。
- Body limit 100mb。

MCP `/mcp` 若裸暴露在 3008，等于把执行能力开放给本机任意来源。

---

## 3. MCP 协议要点（2026-07-28 spec）

| 要点 | 语义 | 对本方案的意义 |
|---|---|---|
| `capabilities.tools.listChanged: true` | 服务器声明会发工具变更通知（spec 强制要求声明） | app 增删时通知客户端 |
| `tools/list` 动态返回 | tool set "MAY change over time"，支持 `cursor` 分页 | 每次 list 遍历 appStore 实时生成 |
| `notifications/tools/list_changed` | 工具集变化时推送，客户端重拉 list | app CRUD 钩子触发 |
| **MUST NOT vary per-connection** | 工具集不得按连接区分 | 本方案 app 列表全局，天然满足 |
| `inputSchema` = JSON Schema 2020-12 | `{type:"object", properties, required}` | paramsNodes 直接转换 |
| `outputSchema`（可选） | 声明返回结构 | 按 output paramsNode 声明 image/audio/video |
| **Streamable HTTP transport** | 远程 MCP 推荐传输（取代 SSE），可挂 HTTP 服务器 | 挂到现有 express `/mcp` |
| Tool name | 1+ 字符，建议命名空间风格 | `run__<app_slug>` |

TS SDK（`@modelcontextprotocol/server` 等）关键 API：
- `McpServer.registerTool(name, {description, inputSchema, outputSchema, annotations}, cb)` —— 返回 `RegisteredTool`，注册/移除/启用/禁用**自动发** `notifications/tools/list_changed`。
- `server.sendToolListChanged()` —— 手动发通知（变更不由 registration API 触发时）。
- `createMcpHandler(() => new McpServer(...))` —— 工厂模式挂 express（per-request 实例）；也可用 `toNodeHandler` 挂到已有 app 的 `/mcp`。

---

## 4. 目标架构

```
AI 客户端 (Claude Desktop / Cursor / 自研 Agent)
   │  MCP over Streamable HTTP   POST http://localhost:3008/mcp   (Bearer token)
   ▼
┌──────────────────────────────────────────────────┐
│ Comfy-Desktop 主进程 (现有 express app)            │
│                                                    │
│   app.use('/mcp', mcpHandler)        ← 新增        │
│   ┌─ McpServer ────────────────────────────┐     │
│   │  tools/list  → 遍历 appStore 动态生成     │     │
│   │     公共: list_apps / get_app_details    │     │
│   │           get_execution_status           │     │
│   │           stop_execution / upload_image  │     │
│   │     动态: run__<app_slug> × N            │     │
│   │  callTool    → executeApp() 服务端直连    │     │
│   │  list_changed → appStore 变更钩子推送     │     │
│   └────────────────────────────────────────┘     │
│                                                    │
│   复用: appStoreManager (electron-store)           │
│   复用: fetchWithRetry, 只读 ComfyUI 代理           │
│   新增: /prompt 代理 + 执行状态聚合 (主进程内)       │
└──────────────────────────────────────────────────┘
   │  服务端直连 (fetch, 主进程内)
   ▼
ComfyUI  http://localhost:8188   (/prompt /history /queue /upload/image /interrupt)
```

---

## 5. 详细设计

### 5.1 工具分层

**公共工具**（static，server 启动时注册一次）：

| 工具名 | 入参 | 作用 | 复用 |
|---|---|---|---|
| `list_apps` | — | 列出所有 app（id/name/description/category） | `/api/apps` |
| `get_app_details` | `app_id` | 返回 app 的参数 schema（人类/LLM 可读） | `/api/apps/detail` |
| `get_execution_status` | `prompt_id` | 轮询 `/history/{prompt_id}` 聚合状态 | 新增聚合 |
| `stop_execution` | — | POST `/interrupt` | `handlers.ts:34-45` |
| `upload_image` | `image` (base64/URL) | 上传到 ComfyUI，返回文件名 | 新增 |

**动态工具**（每个 app 一个）：
- 名：`run__<app_id>`（id 已唯一；slug 需满足 spec 工具名字符约束）
- `inputSchema`：由 `paramsNodes`（input 类）+ 公共入参生成
- `outputSchema`：由 `paramsNodes`（output 类）声明
- `description`：取 `app.description`，附参数说明

### 5.2 paramsNodes → inputSchema 转换

```ts
function paramNodeToJsonSchema(node: ParamNode): JsonSchema {
  const desc = node.description || `${node.name} (${node.type}.${node.selectedWidget?.name})`
  const opt = node.selectedWidget?.options
  switch (node.renderComponent) {
    case 'textarea':   return { type: 'string', description: desc }
    case 'switch':     return { type: 'boolean', description: desc }
    case 'input-number':
    case 'slider':     return { type: 'number', description: desc,
                                minimum: opt?.min, maximum: opt?.max,
                                multipleOf: opt?.step ?? opt?.precision }
    case 'select':     return { type: 'string', description: desc,
                                enum: opt?.values ?? [] }
    case 'image-uploader':
    case 'audio-uploader':
    case 'video-uploader':
                      return { type: 'string', description: desc + ' (base64 data URL or http URL)' }
    default:          return { type: 'string', description: desc }
  }
}

function buildAppToolSchema(app: App): JsonSchema {
  const inputs = app.template.paramsNodes.filter(n => n.category === 'input')
  const properties: Record<string, JsonSchema> = {}
  for (const n of inputs) {
    const key = n.name          // 或作者设置的 alias
    properties[key] = paramNodeToJsonSchema(n)
  }
  // 注入公共入参（见 5.3）
  Object.assign(properties, COMMON_INPUT_PARAMS)
  return { type: 'object', properties, additionalProperties: false }
}
```

SDK 接受 Zod shape 或 `StandardSchemaWithJSON`。动态生成的异构 schema 用 JSON Schema 对象直接传更实际（避免动态拼 Zod）。

### 5.3 公共入参（注入每个 app 工具）

```ts
const COMMON_INPUT_PARAMS = {
  seed:            { type: 'number', description: 'Random seed. Omit to auto-randomize.' },
  randomize_seed:  { type: 'boolean', default: true, description: 'If true (default), override seed with random.' },
  // batch_size 仅当 app.prompt 含该 widget 时动态注入，不全局加
}
```

把现有"强制随机 seed"（`useWorkflow.js:213-220`）改成显式可选：`randomize_seed` 默认 true 时覆盖 `seed`，与 MCP"入参显式"语义一致。

### 5.4 执行路径（服务端直连 ComfyUI）

推荐**服务端直连**，不走浏览器 webContents（脆弱、需 UI 常驻）。把 `artifylab-frontend/src/utils/comfyui-utils/api.js:199-227` 的低层 queuePrompt 移植成 TS：

```ts
async function executeApp(appId: string, args: Record<string, unknown>) {
  const app = appStoreManager.getApp(appId)
  const prompt = structuredClone(app.template.prompt)
  const comfy = (await artifyUtils.getConfig()).comfy_origin

  // 1. 公共参数
  const randomize = args.randomize_seed ?? true
  if (randomize) randomizeSeeds(prompt)
  else if (args.seed != null) applySeed(prompt, Number(args.seed))

  // 2. image/audio/video 预处理：base64/URL → upload → filename
  for (const n of app.template.paramsNodes.filter(p => p.category === 'input')) {
    const v = args[n.name]
    if (isMediaParam(n) && typeof v === 'string' && /^(data:|https?:)/.test(v)) {
      args[n.name] = await uploadToComfyUI(comfy, v)   // POST /upload/image → { name, subfolder }
    }
  }

  // 3. 按 node id 合并入参（复用 useWorkflow 的 Object.assign 语义）
  for (const n of app.template.paramsNodes.filter(p => p.category === 'input')) {
    const node = prompt[n.id]
    if (node?.inputs && args[n.name] != null) {
      node.inputs[n.selectedWidget.name] = args[n.name]
    }
  }

  // 4. queuePrompt + 等待完成（WS 进度 或 轮询 /history）
  const client_id = randomUUID()
  const { prompt_id } = await queuePrompt(comfy, {
    client_id, prompt,
    extra_data: { extra_pnginfo: { workflow: app.template.workflow } },
  })
  const result = await waitForCompletion(comfy, prompt_id, client_id)  // 复用 fetchWithRetry

  // 5. 抽取 output paramsNode 登记的结果
  return extractOutputs(app, result)
}
```

长任务（视频生成可达分钟级）：`executeApp` 不阻塞返回，先回 `prompt_id`，AI 用 `get_execution_status` 轮询；或 MCP 工具内同步等待 + 流式进度（SDK 支持工具内发 progress notification）。

### 5.5 动态注册机制

**单例 server + 增量同步**（推荐，避免 per-request factory 每次重建全部工具）：

```ts
const server = new McpServer({ name: 'artify-apps', version: '1.0.0' })
const registered = new Map<string, RegisteredTool>()

// 公共工具(启动时注册一次)
registerStaticTools(server)

// app 工具(随 appStore 增量同步)
function syncAppTools() {
  const apps = appStoreManager.getAllApps()
  const seen = new Set<string>()

  for (const app of apps) {
    const name = `run__${app.id}`
    seen.add(name)
    if (!registered.has(name)) {
      const handle = server.registerTool(
        name,
        { description: app.description ?? app.name,
          inputSchema: buildAppToolSchema(app) },
        async (args) => executeApp(app.id, args)   // registerTool 自动发 list_changed
      )
      registered.set(name, handle)
    }
  }
  // 移除已不存在的 app 工具
  for (const [name, handle] of registered) {
    if (!name.startsWith('run__')) continue
    if (!seen.has(name)) { handle.remove(); registered.delete(name) }  // 自动发 list_changed
  }
}

// 钩子：appStore 任何变更触发同步
appStoreManager.on('change', syncAppTools)   // createApp/updateApp/removeApp 后触发
// app 的 paramsNodes 改了也要同步：updateApp 后 diff schema，必要时 remove+register
```

SDK 的 `registerTool`/`handle.remove()`/`handle.disable()` 自动发送 `notifications/tools/list_changed`，无需手动调 `sendToolListChanged()`（除非变更绕过 registration API）。

**同步触发点**：`appStoreManager` 现有 `createApp`/`updateApp`/`removeApp`（`appStore.ts:47-104`）需加事件发射，或监听 electron-store 文件变更。

**动态注册时序**：
```
[UI] 用户创建 app X (POST /api/apps/create)
   → appStoreManager.createApp() 写入 artify-apps.json
   → emit('change')
   → syncAppTools()  registerTool('run__X')  ── 自动 ──► notifications/tools/list_changed
   → AI 客户端重拉 tools/list  ──► 发现 run__X 可用  ──► 可调用
```

### 5.6 outputSchema（可选，提升返回结构化）

按 output 类 paramsNode 声明：
```ts
function buildAppOutputSchema(app: App): JsonSchema | undefined {
  const outs = app.template.paramsNodes.filter(n => n.category === 'output')
  if (!outs.length) return undefined
  // SaveImage → { type:'object', properties:{ images:{ type:'array', items:{...image} } } }
  // 简化：统一 { type:'object', properties:{ outputs:{...} } }
}
```

工具结果同时返回 `content`（image base64 / 文件 URL，AI 可直接看图）和 `structuredContent`（spec 2026 要求二者并存）。

---

## 6. 安全与运维

| 项 | 现状 | 建议 |
|---|---|---|
| 鉴权 | 无 | MCP `/mcp` 路径加 Bearer token 中间件；启动时生成随机 token 写入配置，UI 展示给用户配置 AI 客户端 |
| 监听 | `*` | MCP 仅 `127.0.0.1`（本机 AI 客户端），不暴露局域网 |
| 限流 | 禁用 | 对 `run__*` 工具加并发上限（ComfyUI 单实例，串行执行队列） |
| 长任务 | — | `executeApp` 返回 `prompt_id` + 进度，或同步等待带超时（如 10 min） |
| 工具数量 | — | app 多时用 `tools/list` 的 `cursor` 分页；设上限（如 200 app），超出提示用 `list_apps` 查询 |
| 并发执行 | ComfyUI 单实例瓶颈 | 服务端排队（复用 ComfyUI 自身 `/queue`），MCP 工具返回排队位置 |
| 媒体体积 | body 100mb | image base64 体积大，限制单工具入参大小；大文件走 `upload_image` + filename 引用 |

---

## 7. 落地路径

### MVP（最小可用，约 2–3 天）
1. 扩展 `store/appStore.ts` 的 `App` 类型，显式声明 `template?: { workflow, paramsNodes, prompt }`。
2. 主进程接入 MCP server（`@modelcontextprotocol/server` + express handler），挂 `/mcp`。
3. 实现 `list_apps` / `get_app_details` + 一个 `run__<app>`（先支持 string/number/enum，跳过 image）。
4. 新增服务端 `/prompt` 代理（移植 `api.js:199-227`）+ 执行状态聚合 `waitForCompletion`。
5. `/mcp` Bearer token + `127.0.0.1`。
6. `appStoreManager` 变更事件 → `syncAppTools` → 自动 list_changed。

### 完整（再 2–3 天）
- image/audio/video 参数：`upload_image` 工具 + `executeApp` 内媒体预处理。
- 公共入参 `seed`/`randomize_seed`/`batch_size` 注入。
- `outputSchema` + 结构化返回（含 image content）。
- `tools/list` cursor 分页 + 工具数量上限。
- 长任务：progress notification + 超时策略。
- `stop_execution` / `get_execution_status` 工具完善。

---

## 8. 决策记录（已拍板）

7 个决策点已全部确认，均采纳推荐方案。第 5 章设计正文即据此展开。

| # | 决策 | ✅ 决定 | 否决的备选 |
|---|---|---|---|
| 1 | **执行路径** | 服务端直连 ComfyUI（主进程 fetch `/prompt`，移植 `api.js:199-227`） | 驱动前端 webContents（脆弱、headless 不可用） |
| 2 | **seed 语义** | 显式可选 `seed` + `randomize_seed`（默认 true 覆盖 seed） | 沿用强制随机（AI 无法控制/复现） |
| 3 | **App 类型** | 显式扩展 `App.template` 字段（类型安全） | MCP 层 cast（隐式、字段漂移无保护） |
| 4 | **端口/路径** | 复用 3008，路径 `/mcp`（**MCP 路径独立 Bearer 鉴权 + 仅 127.0.0.1**） | 独立端口（多一份启动协调） |
| 5 | **image 入参格式** | base64 data URL（AI 客户端通用） | http URL（服务端可能取不到） |
| 6 | **动态注册模式** | 单例 server + 增量 sync（`registerTool`/`remove` 自动发 `list_changed`） | per-request factory（每次重建开销大） |
| 7 | **长任务返回** | 异步：返回 `prompt_id` + `get_execution_status` 轮询 | 同步阻塞等待（超时风险） |

---

## 9. 风险与边界

- **`@artifyfun/comfy-ui-client` npm 包**：执行链路部分实现在该包内（不在两仓库源码）。服务端若用 TS 重写执行路径，需确认不依赖浏览器 WS API，或直接用低层 `api.js` 的 fetch 实现（推荐）。
- **ComfyUI 单实例**：同一时刻只能跑一个工作流，并发调用需排队；MCP 工具需暴露队列状态。
- **`comfy_inject.js` 源码不在 Comfy-Desktop**：若执行路径需复刻"加载工作流到画布"逻辑，需回 artifylab-frontend 找（服务端直连方案不依赖此，仅 MCP 工具按 API 格式 prompt 直发，无需画布）。
- **app schema 漂移**：`paramsNodes` 结构由前端 `comfy_inject.js` 构造，版本演进时 MCP schema 生成需跟随；建议固化 paramsNode 的字段契约。
- **工具爆炸**：app 数量 → 工具数量 1:1，几百个 app 会撑爆 LLM 上下文；分页 + `list_apps` 引导 + 按需注册（仅"收藏/启用"的 app 注册为工具）是中长期解。

---

## 10. 关键文件索引

### artifylab-frontend
- `src/stores/appStore.js:340-357` — app schema（含 template）
- `src/utils/genPrompt.js:18-388` — `genMeta`，paramsNodes → inputs/outputs 映射与默认值
- `src/utils/index.js:244-294` — `getRenderComponent`，widget → 类型映射
- `src/components/ParamsManager/index.vue:128-142` — renderComponent 选项表
- `public/comfy_inject.js:718-823` — paramsNode 构造（ComfyUI 右键菜单"提取输入/输出"）
- `src/controller/useWorkflow.js:209-264` — `start()`，参数→prompt 映射与执行（seed 随机化 `:213-220`，合并入参 `:221-225`）
- `src/controller/useWorkflow.js:115-120,122-125,169-182` — ComfyUIClient / uploadImage / getResult
- `src/utils/comfyui-utils/api.js:199-227` — 低层 queuePrompt（POST /prompt，服务端移植参考）

### Comfy-Desktop
- `src/main/artifylab/server.ts` — Express 服务（`export default app` :826；端口探测 :840-903；CORS :51-74）
- `src/main/artifylab/store/appStore.ts:4-10` — 服务端 `App` 类型（**缺 template，需扩展**）
- `src/main/artifylab/store/appStore.ts:47-104` — app CRUD（MCP 复用 + 加变更事件）
- `src/main/artifylab/server.ts:351-481` — `/api/apps/*` 路由
- `src/main/artifylab/server.ts:612-679` — ComfyUI 只读代理（/view /history /queue）
- `src/main/artifylab/utils/fetch.ts:42-72` — `fetchWithRetry`
- `src/main/artifylab/handlers.ts:34-45` — interrupt（IPC → POST /interrupt）
- `src/main/index.ts:2181-2305` — 服务启动链路
- `src/main/index.ts:2226-2244` — 8188 CORS 注入 / Origin 剥离（执行当前走前端的证据）

---

## 11. 参考资料

- [MCP 2026-07-28 Tools Spec](https://modelcontextprotocol.io/specification/2026-07-28/server/tools)
- [Speakeasy: Dynamic Tool Discovery in MCP](https://www.speakeasy.com/mcp/tool-design/dynamic-tool-discovery/)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)（`@modelcontextprotocol/server` / `express` / `node`）
- [VS Code: MCP Streamable HTTP 指南](https://code.visualstudio.com/api/extension-guides/ai/mcp)
- [LibreChat: Streamable HTTP vs SSE](https://www.librechat.ai/docs/features/mcp)
