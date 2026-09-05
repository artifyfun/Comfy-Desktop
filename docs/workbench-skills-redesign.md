# 工作台技能体系重设计方案 v2

> 状态：待评审 · 2026-09-05
> v2 变更：① 不处理旧数据迁移 ② 选型以易用性为准 ③ 全面改用生态现成轮子，不自造

---

## 0. v2 相对 v1 的变化

| 维度 | v1（自造） | v2（用轮子） |
|---|---|---|
| 文件格式 | 自定 `SKILL.md` + 私有 `meta.json` | **agentskills.io 开放标准**，目录内零私有文件 |
| 解析 / 校验 | 自己写 `parseFrontmatter` | **`agent-skills-ts-sdk`**（parse / validate / estimateTokens） |
| 目录名 vs name | 允许不一致 | **必须一致**（规范强制） |
| 启用 / 禁用状态 | 写在 `meta.json` 里（污染技能目录） | 存 workbench store，技能目录保持纯净、可直接分享 |
| 导入 | zip 上传为主 | **文件夹拖拽 / .md 拖拽 / 粘贴 / 扫本机其它 agent 目录 / GitHub** |
| 导出 | zip 下载 | **「在文件管理器中打开」**（直接拷走）+ 单文件复制 |
| 正文编辑器 | monaco（代码视角） | **md-editor-v3**（文档视角，分屏预览） |
| token 预算 | 自定上限 50 | **`estimateTokens()`** 官方实现 + 列表实时显示 |
| 旧数据迁移 | v0→v1 迁移逻辑 | **不做**，语义一次切到位 |

---

## 1. 为什么能直接用现成的：生态已经标准化了

### 1.1 Agent Skills 已是开放标准

- **规范**：`agentskills.io/specification`，Anthropic 发起，2025-12-18 起作为开放标准维护
- **采用方**：Claude Code、OpenAI Codex CLI、Gemini CLI、Cursor、VS Code、GitHub Copilot、Windsurf、Cline、Zed 等 30+ 平台
- **规范要点**：

```yaml
---
name: my-skill          # 必填 ≤64 字符，小写字母数字连字符，首/尾/连续连字符禁止
                        # ★ 必须与父目录名一致
description: ...        # 必填 ≤1024 字符，写清「做什么 + 何时用」，决定触发质量
license: Apache-2.0     # 可选
compatibility: ...      # 可选 ≤500 字符
metadata: { k: v }      # 可选
allowed-tools: ...      # 可选（实验性）
---
# 正文（Markdown）
```

目录结构：`SKILL.md` + 可选 `scripts/`、`references/`、`assets/`。正文建议 < 5000 tokens，更长的拆到 `references/`。

### 1.2 现成的轮子（已实测可装）

| 轮子 | 用途 | 实测 |
|---|---|---|
| **`agent-skills-ts-sdk`** @2.4.2 | 规范的 TS 实现：解析 / 校验 / token 估算 / prompt 生成 / diff-patch | ✅ 装得上，2 个依赖，API 齐全 |
| **`skills.sh`**（Vercel，MIT） | 生态分发网络 + CLI，`npx skills add <owner/repo>`，支持 70+ agent | 目录站已有数万技能，41 万+ 安装量 |
| **`md-editor-v3`** @6.5.6 | Vue3 Markdown 编辑器，分屏预览 / 图片上传 / 主题 | 520 KB（CodeMirror 6 内核） |
| LobeHub Skills / SkillsMP / SkillHub | 技能市场（发现用） | — |

`agent-skills-ts-sdk` 提供的关键 API（实测导出）：

```
parseSkillContent  validateSkillContent  validateSkillProperties
estimateTokens     extractBody           extractResourceLinks
toPrompt           toDisclosurePrompt    toReadToolSchema
createSkillPatch   applySkillPatch       diffSkillContent
normalizeNFKC      findSkillMdFile       createSkillRegistry
```

**`estimateTokens` 直接解决 v1 里"技能多了 prompt 会膨胀"的担忧** —— 不用拍脑袋设上限，列表里直接显示每个技能的开销。

### 1.3 实测：现有 3 个内置技能已 100% 合规

用 `agent-skills-ts-sdk` 跑项目现有的 `public/workbench-skills/`：

| 技能 | 目录名 = name | 校验错误 | 正文 tokens |
|---|---|---|---|
| `wb-batch-memory` | ✅ | 无 | 306 |
| `wb-media-params` | ✅ | 无 | 277 |
| `wb-orchestration` | ✅ | 无 | 1062 |

**结论：内置技能无需任何改造就能接入开放生态。** 三个加起来才 1645 tokens，常驻开销（name+description）约 60 tokens/个。

---

## 2. 核心设计思路

> **技能库 = 一个标准文件夹；管理界面只是这个文件夹的可视化外壳。**

这条决定了后面所有取舍：

1. 技能目录内**不放任何私有元数据**（启用状态、排序、来源都存 store），整个目录随时可以拷走、提交 git、丢给 Claude Code 用
2. **不做 zip 导入导出**（除了拖拽 zip 的兜底）——生态里技能就是文件夹，"在文件管理器中打开"比下载 zip 直观
3. **能吃整个生态的技能**——本机 `~/.claude/skills/` 里装的、skills.sh 上的、GitHub 仓库里的，格式都一样

---

## 3. 数据模型

### 3.1 技能目录（严格遵循开放标准）

```
<userData>/artify-skills/
  my-prompt-style/
    SKILL.md            # 唯一必需，frontmatter + 正文
    scripts/            # 可选，可执行代码
    references/         # 可选，重型文档，按需读
    assets/             # 可选，模板 / 资源
```

规则（交给 SDK 校验，不自研）：

- 目录名 = `frontmatter.name`，`^[a-z0-9]([a-z0-9-]*[a-z0-9])?$`，≤64 字符
- `description` 必填，≤1024 字符
- 正文 ≤ 256 KB（自定的兜底上限）
- 禁止与内置技能同名（内置用 `wb-` 前缀，用户技能也禁止用该前缀）

### 3.2 平台侧状态（存 workbench store，不进技能目录）

```ts
interface WorkbenchSkillState {
  name: string            // = 技能目录名，主键
  enabled: boolean        // 停用 = 不部署、不注入
  source: 'builtin' | 'local' | 'claude' | 'codex' | 'github' | 'manual'
  order?: number
  importedAt?: number
}
```

存在 `workbench-sessions.json` 的 `skillStates` 字段。内置技能默认 `enabled: true`，可停用不可删改。

### 3.3 预设绑定（语义修正，不迁移）

```ts
interface WorkbenchPreset {
  templateIds?: string[]   // 原 skillIds 改名为 templateIds（存的是模板 id）
  skillIds?: string[]      // 改为存真技能 name
}
```

**不做迁移**：直接改字段名与语义，旧 `skillIds` 里存的模板 id 丢弃。理由：当前该功能刚上线、无存量用户数据，迁移成本 > 收益。

---

## 4. 导入设计（易用性优先，4 条路径）

按"用户最省事"排序：

### 4.1 从本机其它 agent 扫描导入 ⭐ 最高性价比

用户如果已经在用 Claude Code / Cursor / codex，本机大概率已经装了一堆技能。自动探测这些目录：

```
~/.claude/skills/           Claude Code 全局
<工作区>/.claude/skills/     Claude Code 项目级
~/.codex/skills/            Codex CLI
~/.cursor/skills/           Cursor
~/.gemini/skills/           Gemini CLI
.github/skills/             仓库级（部分 agent 用）
```

扫到的技能列出来（名称 + description + token），勾选一键导入。**零网络依赖、零格式风险，装上立刻有几十个现成技能可用。**

### 4.2 拖拽

- 拖**文件夹** → 整个技能目录拷进来（含 scripts/、references/）
- 拖 **`.md` 文件** → 用文件名推 name，正文即内容
- 拖 **`.zip`** → 解压后按顶层目录识别（用 `7zip-bin`，项目已有）

### 4.3 粘贴

- 粘贴 SKILL.md 全文 → 自动解析 frontmatter
- 粘贴 GitHub 仓库链接 → 下载 zipball 后按技能目录识别（第二期）

### 4.4 从 skills.sh / GitHub 安装（第二期）

`npx skills add <owner/repo>` 已能自动写入 70+ agent 的目录。两种集成方式：

- **简版**：直接 spawn `npx skills add --target <我们的目录>`（依赖用户机器有 node）
- **可控版**：自己拉 GitHub zipball → 解压 → 用 SDK 校验 → 拷入（不依赖 node 环境）

建议先做可控版，简版作为可选。

### 4.5 冲突处理

同名已存在时给三个选择，UI 直接列出来：**跳过** / **重命名**（加 `-2`）/ **覆盖**。默认跳过。

### 4.6 安全（易用性优先下的取舍）

技能正文是指挥 agent 行为的指令，导入第三方技能 = 让别人指挥你的 agent。

取舍决定：**默认启用，但导入前必须看到全文预览**。

- 导入弹窗展示 SKILL.md 完整正文 + `scripts/` 文件清单 + token 估算
- 来源标记要清晰（`来自 ~/.claude/skills` / `来自 <GitHub repo>`），列表里可追溯
- 来自本机其它 agent 目录的技能：视为用户已审核过，一键导入
- 来自 GitHub / 陌生 zip：展示预览 + 警告，需确认

（v1 提的"默认停用"放弃 —— 多一步操作违背易用性优先，改成"看得见再启用"。）

---

## 5. 导出设计（极简）

| 操作 | 实现 | 说明 |
|---|---|---|
| **在文件管理器中打开** | `shell.openPath(skillDir)` | 主推。用户直接拷贝 / git 管理 / 拖给别的工具 |
| 复制 SKILL.md 全文 | 剪贴板 | 单技能分享到聊天框、issues |
| 下载单个 .md | 浏览器下载 | 少量场景需要 |
| 批量导出 zip | `fflate` 或 7zip-bin | 兜底，低频 |

**不做**：复杂的打包向导、导出模板、版本快照。

---

## 6. 后端设计

### 6.1 依赖与模块

新增依赖（主进程）：

```
pnpm add agent-skills-ts-sdk     # 解析 / 校验 / token 估算（2 个传递依赖）
```

新增 `src/main/artifylab/workbench/skillStore.ts` —— 只做**文件读写 + 目录管理**，解析校验全部委托给 SDK：

```ts
import {
  parseSkillContent, validateSkillContent, estimateTokens, findSkillMdFile
} from 'agent-skills-ts-sdk'

list(): SkillInfo[]                    // 内置 + 用户，附 token / source / enabled
read(name): { properties, body, raw }
create(input: { name, description, body, files? }): Result
update(name, input): Result
remove(name): boolean                  // 内置 false
scanLocalAgents(): DiscoveredSkill[]   // 扫 ~/.claude/skills 等
importFromDir(srcDir, mode): ImportResult
importFromZip(buf, mode): ImportResult
importFromText(text, mode): ImportResult
```

`workbench/service.ts` 侧只加薄封装 + 预设绑定校验。

### 6.2 API 端点

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/workbench/skills` | 技能清单（内置 + 用户，含 token / enabled / source）—— **语义修正** |
| POST | `/api/workbench/skills/create` | `{ name, description, body }` |
| POST | `/api/workbench/skills/update` | `{ name, ...patch }` |
| POST | `/api/workbench/skills/remove` | `{ name }` |
| POST | `/api/workbench/skills/toggle` | `{ name, enabled }` |
| POST | `/api/workbench/skills/open-folder` | 在文件管理器中打开（单技能或根目录） |
| GET | `/api/workbench/skills/scan-local` | 扫描本机其它 agent 的技能目录 |
| POST | `/api/workbench/skills/import-dir` | `{ srcPath, mode }` 从本机路径导入 |
| POST | `/api/workbench/skills/import` | `upload.single('file')`，`.md` / `.zip` |
| POST | `/api/workbench/presets/skills` | **语义修正**：绑真技能 |
| POST | `/api/workbench/presets/templates` | 新增：绑模板（承接原 skillIds 语义） |

现有 `GET /api/workbench/templates` 已存在，模板不需要新端点。

复用现成能力：

- **multer**：`routes/workbench.ts:42` 已配好 `memoryStorage`
- **7zip-bin**：项目已有，用于 zip 解压
- **shell.openPath**：Electron 原生，打开目录

### 6.3 部署链路改造

```ts
// workbench/service.ts:549 附近
deployWorkbenchSkills(tempHome)
```

保持现有"拷贝目录到 `CODEX_HOME/skills/`"的做法（codex 原生扫描），只改两点：

1. 增加用户技能源：`resources/workbench-skills`（内置）+ `userData/artify-skills`（用户，仅 enabled）
2. **整目录复制**，不再只拷 `SKILL.md` —— 开放标准的技能可以带 `scripts/`、`references/`、`assets/`

热刷新：创建会话时部署之外，每次 run 前再部署一次（IO 仅几十 KB），改完技能立刻生效，不用等新会话。

---

## 7. 前端设计

### 7.1 依赖

```
pnpm add md-editor-v3        # Vue3 Markdown 编辑器，520KB（CodeMirror 6）
```

### 7.2 组件

```
stores/skillStore.js                      照 stores/appStore.js 的 apiRequest 写法
views/workbench/components/
  SkillManager.vue                        技能管理主界面
  SkillForm.vue                           新建 / 编辑（md-editor-v3）
  SkillImportDialog.vue                   导入（扫描 / 拖拽 / 粘贴 + 正文预览）
components/CodeEditor/index.vue           保留，用于内置技能的只读查看
```

入口：SessionSidebar 底部「管理预设」下方加「技能库」按钮。

### 7.3 技能管理界面

```
┌──────────────────────────────────────────────────────────────┐
│ 技能库                          [打开目录] [导入] [新建技能]    │
│ 共 12 个 · 常驻 720 tokens · 全量加载 8,420 tokens             │
├──────────────────────────────────────────────────────────────┤
│ 内置 (3)                                                      │
│  ☑ wb-orchestration   多步编排与工作流创作指南      1,062 t [查看] │
│  ☑ wb-batch-memory    批量编排与长期记忆              306 t [查看] │
│  ☑ wb-media-params    媒体参数语义与模板变通          277 t [查看] │
├──────────────────────────────────────────────────────────────┤
│ 我的技能 (9)                                   来源            │
│  ☑ my-prompt-style    写提示词时的分层结构      412 t 自建  [编辑][删除] │
│  ☑ pdf-processing     提取文本/填表/合并 PDF   1,205 t claude [编辑][删除] │
│  ⚠ commit-convention  团队 commit 规范         388 t github [编辑][删除] │
│  ☐ draft-test         草稿，暂不启用           150 t 自建  [编辑][删除] │
└──────────────────────────────────────────────────────────────┘
```

要点：

- **token 双指标**：常驻（name+description，约 60t/个）+ 全量加载（正文），顶部汇总，超标时变黄
- **来源列**：一眼看出哪些是外来的（安全可追溯）
- **内置只读**：只有「查看」+ 停开关
- 停用（☐）的技能保留数据，不部署

### 7.4 新建 / 编辑弹窗

```
┌────────────────────────────────────────────────┐
│ 新建技能                              [从模板开始 ▾] │
│ 名称  [my-prompt-style        ]  ⓘ 小写连字符，也是目录名 │
│ 描述  [当用户要求写图生图提示词时使用。规定了…]        │
│       ⓘ 最重要：写清「做什么 + 何时用」，决定 AI 是否会用它│
│       [看几个好例子 ▾]                          │
│ ┌──────────────────────────────────────────┐  │
│ │ md-editor-v3：分屏预览                     │  │
│ │ 左：Markdown 正文      右：实时渲染         │  │
│ └──────────────────────────────────────────┘  │
│                        [取消] [保存]            │
└────────────────────────────────────────────────┘
```

- **「从模板开始」**：预置几个骨架（提示词风格 / 项目规范 / 工作流 SOP / 代码审查），避免面对空白页
- **描述输入给示例**：规范里明确 description 是最难写也最关键的部分，直接内嵌几个正面/反面对照
- 名称改动 = 目录改名（需处理已绑定预设的引用）

### 7.5 导入弹窗

```
┌────────────────────────────────────────────┐
│ 导入技能                                     │
│ ┌────────────────────────────────────────┐ │
│ │ ① 从本机已有技能导入  ← 推荐             │ │
│ │   在 ~/.claude/skills 发现 8 个技能      │ │
│ │   ☑ pdf-processing   ☐ web-testing  …   │ │
│ ├────────────────────────────────────────┤ │
│ │ ② 拖拽文件夹 / .md / .zip 到此处          │ │
│ ├────────────────────────────────────────┤ │
│ │ ③ 粘贴 SKILL.md 全文                     │ │
│ └────────────────────────────────────────┘ │
│ 同名冲突：[跳过 ▾]                           │
│                        [取消] [导入]          │
└────────────────────────────────────────────┘
```

### 7.6 术语统一（顺带清理）

| 位置 | 改动 |
|---|---|
| `service.ts:2235` `listSkills()` | 改为返回真技能 |
| `presetCore.ts:133` | `prefer skills (templates)` → `prefer templates [...]` |
| `selfKnowledge.ts:61` | 「已固化技能（可作为模板直接使用）」→「已固化模板」 |
| `i18n` `workbenchEnvSkills` | 同左 |
| `Composer.vue` 的 skills prop | 改名 `templates`（`/` 触发器本来就是模板） |
| 各处「技能」文案 | 按新语义重新划分：模板 = template，技能 = skill |

---

## 8. 实施计划

| 阶段 | 内容 | 依赖新增 |
|---|---|---|
| P1 | 术语统一（改名、`skillIds` → `templateIds`、文案清理） | 无 |
| P2 | 装 `agent-skills-ts-sdk`，`skillStore.ts` + API + 部署链路改造 | 1 个 |
| P3 | 技能管理 UI（列表 / 启停 / 查看 / 打开目录） | 无 |
| P4 | 新建编辑（md-editor-v3）+ 描述写作引导 | 1 个 |
| P5 | 导入三路径（扫本机 / 拖拽 / 粘贴）+ 冲突处理 | 无 |
| P6（可选） | 从 GitHub / skills.sh 安装 | 无 |

P1-P3 做完就已经可用（内置技能可见可管 + 自建技能），P4-P6 是体验增强。

---

## 9. 验收

**单元测试**：SDK 校验结果（合规 / 缺 description / name 与目录名不符 / 非法字符）、扫描本地目录（存在 / 不存在 / 空）、冲突三策略、整目录复制（含 scripts/ 子目录）、停用技能不部署。

**浏览器验收**（`acceptance/workbench/` 三件套）：

- **W9** 技能 CRUD：新建 → 列表出现 → 停用 → 再启用 → 删除
- **W10** 导入：扫描本机目录 → 勾选 → 导入 → 来源标记正确
- **W11** 预设绑定：绑技能 → 决策提示词含 `prefer skills [...]`

**兼容性验收**（这条最重要）：导入一个从 skills.sh 装的技能（如 `anthropics/skills` 里的 pdf），确认能被正确解析、部署、被 codex 加载。

---

## 10. 待你拍板

1. **md-editor-v3（+520KB，第二个编辑器内核）值不值得？** 项目已有 monaco。备选是 monaco + 预览 tab（零新增依赖，但代码视角）。易用性优先的话我选 md-editor-v3。
2. **扫描本机 agent 目录要不要做成"自动同步"而非"手动导入"？** 自动同步（软链或定时拷贝）更省事，但双向修改会打架。我倾向手动导入 + 提供"检查更新"。
3. **内置 3 个技能要不要加 `license` 字段？** 规范里可选，加了更规范，但当前没许可信息。
4. **技能改名怎么处理已绑定的预设？** 自动改引用 / 拒绝改名 / 允许改名但预设引用失效（列表里标红）。
