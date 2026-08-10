# Artify MCP Server 使用文档

把 A UI（artifylab-frontend）生成的每个 app 暴露为 MCP 工具，AI 客户端（Claude Desktop / Cursor 等）可发现并调用。工具入参由 app 自定义参数决定；app 创建/删除后工具列表自动更新。

> 设计与可行性见 [mcp-server-feasibility.md](./mcp-server-feasibility.md)。

---

## 前置条件

1. **Comfy-Desktop 运行**（含 MCP server，随主进程自动启动）。
2. **ComfyUI 运行**（默认 `http://localhost:8188`）—— 工具执行时由 Comfy-Desktop 服务端直连。
3. **至少一个 A UI app**，且创建时配置过参数（有 `template.paramsNodes`）—— 没参数的 app 只会暴露一个空入参工具。

---

## 1. 启动并获取 token / 端口

```
cd Comfy-Desktop
pnpm dev
```

启动后日志会打印一行（token 脱敏，仅显示前 4 位用于确认）：

```
[MCP] 已挂载 http://localhost:3008/mcp | token: a1b2***（完整值见 artify-apps.json 的 config.mcpToken）
```

- **URL**：默认端口 `3008`；若被占用按 `[3008, 3002, 3003, 9528, 8082, 5002, 5003]` 顺序探测，以日志为准。
- **完整 TOKEN**：从配置文件读（日志仅显示前 4 位，不再打印完整 token）：
  - macOS：`~/Library/Application Support/Artify/artify-apps.json` → `config.mcpToken`
  - Windows：`%APPDATA%\Artify\artify-apps.json`

> 安全：MCP 路径仅监听本机回环，需 Bearer token。token 请勿提交到代码库。

---

## 2. 配置 AI 客户端

### Claude Desktop

编辑配置文件：
- macOS：`~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows：`%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "artify": {
      "url": "http://localhost:3008/mcp",
      "headers": {
        "Authorization": "Bearer <TOKEN>"
      }
    }
  }
}
```

保存后重启 Claude Desktop。

### Cursor / 其他支持 streamable HTTP 的客户端

- Server URL：`http://localhost:3008/mcp`
- Header：`Authorization: Bearer <TOKEN>`

---

## 3. 可用工具

### 公共工具（固定）

| 工具 | 入参 | 作用 |
|---|---|---|
| `list_apps` | — | 列出所有 app（id / name / description） |
| `get_app_details` | `app_id` | 返回某 app 的参数 schema（供 LLM 理解入参） |
| `get_execution_status` | `prompt_id` | 查询执行状态（`success` / `running`）与产物 |
| `stop_execution` | — | 中断当前 ComfyUI 执行（POST `/interrupt`） |
| `upload_image` | `data_url` | 上传图片/音频/视频到 ComfyUI，返回 `{name, subfolder, type}` |

### 动态工具（每个 app 一个）

- 名字：`run__<app_id>`
- 入参：由该 app 的参数决定（见下「参数类型」）+ 公共参数（seed / randomize_seed）
- 返回：`{ prompt_id, status: "queued" }`（异步，决策 #7）

---

## 4. 典型调用流程

```
1. list_apps                        → 拿到目标 app 的 id
2. get_app_details(app_id)          → 看它的参数（名字/类型/说明）
3. run__<app_id>(参数...)            → 返回 prompt_id（已提交到 ComfyUI）
4. get_execution_status(prompt_id)  → 轮询，直到 status: "success"，拿到 outputs
```

> 长任务（视频生成可达分钟级）：`run__` 立即返回 `prompt_id`，不要阻塞；用 `get_execution_status` 轮询。未完成时返回 `running`，完成返回 `success` + 产物。

---

## 5. 参数类型映射

每个 app 工具的入参由作者在 A UI 创建 app 时从 ComfyUI 工作流里挑出的 widget 决定：

| A UI 参数类型 | MCP 入参类型 |
|---|---|
| 文本（textarea） | `string` |
| 开关（switch） | `boolean` |
| 数字（input-number） | `number` |
| 滑块（slider） | `number`（含 `minimum` / `maximum` / `multipleOf`） |
| 下拉选择（select） | `string`（`enum` 为可选值列表） |
| 图片 / 音频 / 视频上传 | `string`（base64 data URL 或 http URL） |

### 公共参数（所有 `run__<app>` 工具都有）

| 参数 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `seed` | number | — | 随机种子，省略则按 `randomize_seed` 处理 |
| `randomize_seed` | boolean | `true` | `true`（默认）覆盖 seed 为随机值（复刻 A UI 现有随机行为）；`false` 时使用传入 `seed`，未传则保留工作流原值 |

---

## 6. 动态注册

在 A UI 里 **创建 / 编辑 / 删除** app 后，MCP server 自动：
1. 重新生成工具列表（新增 → 注册 `run__<id>`；删除 → 移除）
2. 发送 `notifications/tools/list_changed`

AI 客户端收到通知后自动重拉 `tools/list`，无需重连。

---

## 7. 故障排查

| 现象 | 排查 |
|---|---|
| 客户端连不上 / 401 | 确认 URL 端口与日志一致；确认 `Authorization: Bearer <TOKEN>` 的 token 与日志/配置文件一致 |
| 工具列表为空 / 缺某 app | 该 app 可能没有 `template.paramsNodes`（创建时没挑参数）；在 A UI 重新编辑该 app 配置参数后会自动出现 |
| `run__` 报错 | 确认 ComfyUI 在跑（`http://localhost:8188`）；看 Comfy-Desktop 日志的 `[MCP]` 与异常堆栈 |
| 一直 `running` 不出结果 | ComfyUI 队列阻塞或执行报错；用 `stop_execution` 中断，或直接看 ComfyUI 的 `/queue` 与 console |
| 图片参数执行失败 | 确认传的是完整 base64 data URL（`data:image/...;base64,...`）或可访问的 http URL |

---

## 8. 已知限制（MVP）

- 无 WebSocket 实时进度，靠 `get_execution_status` 轮询 `/history` 判完成。
- 无 `outputSchema` 完整声明（产物以 JSON 文本返回）。
- 无 `tools/list` 分页（app 极多时可能撑大 LLM 上下文）。
- token 从启动日志或配置文件读取，暂无 UI 展示。
- 未做工具数量上限保护。

完整阶段计划见 feasibility 文档第 7 节。
