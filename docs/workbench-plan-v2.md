# 工作台 v2：参考 DeepSeek Harness 交互范式重构（Phase 2 方案）

> 背景：Phase 1 工作台（单会话、对话+产物两栏）已上线。用户要求对齐 dsh web 的交互丰富度：
> 左侧会话记录侧栏、中间 AI 执行区、富输入框（附件/模型/技能/预设）、新建会话选预设、技能管理。
> 本文是研究结论 + 分期落地方案。**不引入 cordis 插件系统**——借交互范式，不搬架构。

## 0. dsh 的做法（研究结论）

解剖 `@deepseek-ai/dsh` 六个 client-ui 包（sidebar / workspace / skill / model-selection / agent-preset / attachment）后的可借鉴模式：

| dsh 组件 | 核心机制 | 我们的取舍 |
|---|---|---|
| **sidebar** | 品牌行 + New Session + workspace 分组会话列表 + 底部 Settings 座；折叠成 56px rail；搜索（标题+全文） | ✅ 借布局；❌ 多 workspace（单用户单机，会话平铺+时间分组） |
| **workspace** | 会话行状态点（running 蓝/approval 琥珀/未读绿）、Fork/Rename/Archive、手动/时间双排序、拖拽 | ✅ 状态点 + Rename/Delete/Archive + 时间排序；❌ Fork/拖拽 |
| **session intent（新会话页）** | workspace 选择 + **agent-preset chip**（staged pick：下一次会话生效，首次使用即消费） | ✅ 新会话弹层：预设 chip + 可选初始模板 |
| **skill 体系** | 输入框 `/` 触发器列技能 → 选中插入字面 `/name `；host 侧 gesture boundary 识别 whitespace 分界 token 注入技能内容 | ✅ `/` 触发（我们的技能=预设+模板快捷方式）；菜单选择与手输 token 等价 |
| **model-selection** | 会话级 `/model` 两级菜单（provider 分组→模型→effort）；Host 单一事实；不可路由时禁输入框 | ✅ 会话级模型选择（决策模型+构建模型分离）；❌ effort 概念 |
| **agent-preset 管理** | 设置页卡片管理：复制为唯一新建方式（copy-dialog 收集 id/name）、删除、设默认、broken 标记；预设会话期锁定不可中途换 | ✅ 全套借鉴（预设=复制内置再改，浏览器不编辑原始文本） |

**关键洞察 1**：dsh 的「预设」是 agent 组成（工具集+指令）；我们的「预设」应该是**任务预设**（意图约束 + 提示词模板 + 推荐模板 + 默认参数），因为我们的 codex 是单轮决策器而非多轮 agent。范式对齐，语义不同。

**关键洞察 2**：dsh 会话是纯对话流；我们的会话 = 对话 + 执行 + 产物，**产物是核心价值**。所以中间区域是「对话流 + 执行卡片内联」（图片缩略图/进度条就在对话流里），右侧保留可折叠产物总览面板。

## 1. 信息架构（目标 UI）

```
┌─────────┬──────────────────────────────────────────────┬─────────┐
│ 侧栏     │ 会话头部（标题可编辑 · 预设 badge · 模型选择）    │ 产物面板 │
│         │──────────────────────────────────────────────│ (可折叠) │
│ [+新建   │                                              │         │
│  会话]   │   对话流：                                     │ 执行 #1  │
│         │   - 用户消息（含附件缩略图）                     │  ▢ img  │
│ 搜索     │   - AI 回复/计划卡片                           │ 执行 #2  │
│         │   - 执行卡片（内联进度条→缩略图）                 │  ▢ img  │
│ 今天     │   - invalid 卡（附校验错误）                    │         │
│  s1 s2  │                                              │ 发布     │
│ 昨天     │──────────────────────────────────────────────│         │
│  s3     │ 富输入框                                       │         │
│         │ [附件📎][模型🤖] 输入... [/技能] [发送➤]          │         │
│ [设置]   │ （附件栏：64px 缩略图横滚）                      │         │
└─────────┴──────────────────────────────────────────────┴─────────┘
```

## 2. 数据模型变更（后端）

### 2.1 WorkbenchSession 增字段

```ts
interface WorkbenchSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: WorkbenchMessage[]
  executions: WorkbenchExecution[]
  presetId?: string          // 创建时选定，会话期固定（dsh 语义：不可中途换）
  modelOverride?: { decisionModel?: string; buildModel?: string }  // 会话级，可中途换
  archived?: boolean         // 侧栏不显示，数据保留
}
```

### 2.2 新增 WorkbenchPreset（存 appStore，独立于 session）

```ts
interface WorkbenchPreset {
  id: string                              // 'standard' | 'text-to-image' | ...
  name: { zh: string; en: string }
  description: { zh: string; en: string }
  builtin: boolean
  promptTemplate?: string                 // 决策提示词模板，{input} 占位
  intentHint?: 'image' | 'video' | 'audio' | 'text'   // 意图约束（锁 codex 决策范围）
  preferredTemplateId?: string            // 预推荐模板（codex 优先选）
  defaultParams?: Record<string, unknown> // 默认参数
}
```

内置 4 个：standard（无约束）、text-to-image、image-to-image（提示上传附件）、video-gen。
自定义预设 = 复制内置后改（dsh copy-dialog 模式：新建即复制，不在浏览器编辑原始文本）。

### 2.3 技能 = 预设 + 模板快捷方式（合并概念）

dsh 的技能目录对用户是「可 `/` 调用的能力」；对我们用户，「选个预设」和「敲 /t2i」是同一心智动作。分两个概念会让 UI 爆炸。所以：

- `/` 触发器列出两类：**预设**（带意图约束，插入后影响决策）+ **模板快捷方式**（锁定 templateId）
- 「技能管理」页 = 预设管理（列表/复制/删除/设默认）
- 发送 `/t2i 一只猫` → 后端 workbench service 在 appendMessage 前预处理：展开 promptTemplate + 锁 intentHint 注入 codex spec
- 菜单选择与手输 token 等价（dsh gesture boundary 模式：识别 whitespace 分界的 `/name` token）

### 2.4 WorkbenchMessage 增字段

```ts
interface WorkbenchMessage {
  role: 'user' | 'agent'
  kind: 'chat' | 'plan' | 'progress' | 'error' | 'artifact' | 'invalid'
  text?: string
  plan?: WorkbenchPlan
  attachments?: AttachmentMeta[]   // 用户消息附件（图片已上传 ComfyUI）
  executionRef?: string            // 指向 executions[].promptId
}
```

附件链路（**多素材**：图片/视频/音频，单消息不限个数）：前端选择/拖拽多个媒体文件 → 逐个 `POST /api/workbench/upload`（复用 executor.uploadMedia，ComfyUI 支持任意类型上传）→ 拿 `{name, subfolder, type}` 存 AttachmentMeta（含 mime/kind 派生：image|video|audio）→ 决策时 codex spec 带附件清单摘要（如「2 图 1 视频」→ 意图与模板倾向匹配媒体输入位）→ 执行时**按序填充**：附件数组顺序对应模板媒体输入参数顺序（image1→附件1, image2→附件2…），多余附件忽略并提示，不足保留参数默认值。

### 2.5 API 新增

```
GET  /api/workbench/presets                  内置+自定义列表
POST /api/workbench/presets/create           {from?, id?, name?} 复制内置新建
POST /api/workbench/presets/delete           {id}
POST /api/workbench/presets/default          {id}
GET  /api/workbench/models                   可用模型（config: provider/base_url/model/buildModel 派生）
GET  /api/workbench/skills                   预设+模板拼装技能清单（/ 触发器用）
GET  /api/workbench/sessions?archived=true   列表带归档过滤
POST /api/workbench/sessions/update          {id, title?, modelOverride?, archived?}
POST /api/workbench/upload                   multipart → uploadMedia → AttachmentMeta
POST /api/workbench/chat                     请求体 + attachments?；slash 预处理后端做
```

chat SSE 结束事件附带会话摘要，前端据此刷新侧栏（不引入 WS）。

## 3. 前端重构（packages/frontend/src/views/workbench/）

```
views/workbench/
├── index.vue                  # 三栏布局壳 + ?session= 路由语义保留
├── components/
│   ├── SessionSidebar.vue     # 新建按钮/搜索/时间分组列表/设置入口
│   ├── SessionRow.vue         # 标题/状态点/重命名/删除/归档
│   ├── ChatStream.vue         # 对话流（附件缩略图/计划卡/执行卡内联/invalid 卡）
│   ├── ExecutionCard.vue      # 进度条→缩略图/视频占位/失败态
│   ├── Composer.vue           # 富输入框：附件/模型菜单/技能触发/发送
│   ├── AttachmentRail.vue     # 64px 缩略图横滚栏（dsh 模式）
│   ├── ModelMenu.vue          # 会话级模型选择（决策模型+构建模型两项）
│   ├── SkillMenu.vue          # "/" 触发：预设+模板，选中插入文本
│   ├── PresetChip.vue         # 新会话弹层预设 chip（staged pick）
│   ├── NewSessionDialog.vue   # 新建会话：预设 chip 组 + 可选初始模板
│   └── ArtifactPanel.vue      # 右侧产物总览（可折叠 + 缩略图）
└── composables/
    ├── useWorkbenchSessions.js  # 会话列表/CRUD/状态点轮询
    └── useComposer.js           # 草稿附件/模型选择/斜杠触发/发送管线
```

新增 i18n 约 60 键（zh/en 同步）。

## 4. 分期计划

| 期 | 内容 | 估时 |
|---|---|---|
| **P2a 侧栏+会话管理** | SessionSidebar/SessionRow/时间分组/搜索/新建对话框(预设 chip)/重命名/删除/归档；后端 sessions/update、presets CRUD | 2~3 天 |
| **P2b 富输入框** | Composer/AttachmentRail/ModelMenu/SkillMenu；后端 upload（复用 uploadMedia）、models 派生、skills 清单、chat 带 attachments + `/` 预处理 | 3~4 天 |
| **P2c 体验打磨** | 执行卡片内联进度、产物缩略图（接 gallery view 链路）、lightbox、快捷键（⌘N/⌘K）、空态引导 | 2 天 |
| P2d 技能与预设管理页 | 预设卡片管理（复制/删除/设默认）、模板能力展示、内置 4 预设文案 | 1~2 天 |
| P2e 会话标题自动生成 | codex 决策同轮在 PLAN JSON 顺带 `title`（≤15 字），用户手改过则不覆盖 | 0.5 天 |

## 5. 关键设计决策

1. **不引入 cordis**。dsh 插件体系为多部署形态设计；我们是单体 app。借交互范式（侧栏/chip/触发器/附件栏），技术保持 Vue 组件 + express 路由 + appStore 三件套。
2. **预设会话期锁定**：创建时选、不可中途换（历史在预设 A 下产生，换 B 错位）；模型可中途换（dsh ModelSelection 同款 per-session 可变事实）。
3. **技能 = 预设 + 模板快捷方式合并展示**：`/` 菜单两者都列；预设影响 codex 决策 spec（promptTemplate/intentHint/preferredTemplateId）；模板快捷方式锁定 templateId 降低决策不确定性。
4. **附件=多素材走 ComfyUI 原生上传**（executor.uploadMedia）：图片/视频/音频不限个数，单机单用户 ComfyUI 即存储，不复制到 userData。决策 spec 带附件清单摘要（个数+类型）；执行时按附件顺序填充模板的媒体输入参数位（按序分配，多余忽略并提示）。
5. **模型选择只影响后续请求**：进行中的执行不受影响（dsh 同款：running step keeps assembled selection）。
6. **会话列表靠 SSE 结束事件刷新**，保持 HTTP 轮询架构，不引入 WS。
7. **预设对齐 dsh copy-dialog 语义**：新建=复制内置，浏览器只编辑结构化字段（名称/描述/模板/默认参数），不暴露原始文本编辑。

## 6. 测试策略

- 后端单测：presets CRUD / sessions update / slash 预处理纯函数 / models 派生逻辑 / chat attachments 透传（纯函数抽离到独立文件，不 import electron 链）
- 前端：slash token 展开、附件 meta 拼装等纯函数做单测（沿用 templateCore 模式）
- 手动验收清单见 §7

## 7. 验收清单（手动）

- 新建会话选预设 text-to-image → 输「一只猫」→ 计划卡 → 执行卡 → 产物图 → 固化成 app
- 侧栏搜索（标题）命中 → 重命名/归档；归档视图可恢复
- 附件（按钮+拖拽）→ 附件栏缩略图 → 发送 → 走图生图（附件作为链式输入）
- `/` 菜单选预设或模板 → 插入文本 → 发送生效
- 模型菜单切换 buildModel → 固化 UI 生成用新模型
- 预设管理页：复制内置 → 编辑 → 删除；设默认
