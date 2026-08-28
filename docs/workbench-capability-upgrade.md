# 工作台能力全面优化方案（节点级控制 + 工作流创作）

> 状态：方案评审稿
> 目标：解除"只能调用固化 App 工作流"的限制，让 AI 能改任意节点参数、能创作/导入工作流运行。

## 一、现状与限制

### 1.1 当前数据模型

```
App（appStore）
├─ name / description
└─ template
   ├─ prompt        # API 格式（ComfyUI /prompt 直接消费）：nodeId → {class_type, inputs}
   ├─ paramsNodes   # 参数 schema：Pick as input/output 提取的节点 widget 白名单
   └─ workflow      # UI graph 格式（litegraph，仅 A 界面画布消费）

WorkflowTemplate（工作台模板 = 可执行子集）
├─ id: app:<appId> | builtin:<name>
├─ prompt + paramsNodes（从 App 派生）
└─ mediaType / requiredModels / chainable
```

模板库 = `appStore.getAllApps()` 实时派生 + 内置种子（当前空）。**所有模板都来自 A 界面画布手工制作 + Pick as input/output 固化**。

### 1.2 执行链路

```
用户输入 → decide（codex 单轮 → PLAN JSON）
  → validatePlanLocal（模板存在 + params 类型/范围，只认 paramsNodes 声明的 input）
  → executeApp（executor.ts）
      1. seed 处理（全图 seed 字段）
      2. media 上传（paramsNodes 里 image-uploader 类）
      3. 普通参数合并：仅按 paramsNodes 的 n.id + selectedWidget.name 覆盖
      4. queuePrompt → poll
或：wb_execute_template（编排模式，同一 execute 链路）
```

### 1.3 限制根因

| # | 限制 | 根因 |
|---|------|------|
| A | 不能改节点级传参（KSampler.steps/cfg、任何中间节点 widget） | `executeApp` 第 3 步只合并 **paramsNodes 声明的 input widget**；PLAN/校验也只认 paramsNodes |
| B | 不能改链接型参数（把某节点输出接到另一节点） | prompt 中该字段是 `["nodeId", slot]` 引用，现有合并逻辑完全不处理 |
| C | 不能创作工作流运行 | 主进程只能执行固化模板；无 workflow JSON 上传/直执行；graph→prompt 转换只存在于 ComfyUI 页面（`inject` 的 `graphToPrompt`） |
| D | 不能从现有模板派生变体 | 无模板克隆/会话级模板概念 |
| E | MCP 工具面太窄 | wb_* 只有 list_templates / execute_template / poll / remember / forget，无节点查询/修改/工作流工具 |

## 二、目标

1. **节点级参数控制**：AI 可读取模板完整节点图（/object_info schema），对任意节点任意 widget 覆盖参数（含枚举/范围校验）
2. **任意工作流执行**：API 格式 prompt JSON 可直接校验→执行；支持会话内创作（AI 生成 workflow）
3. **模板派生与固化**：改过的配置可保存为新模板/新 App
4. **提示词与 MCP 全面升级**：模型"看得见、改得动、跑得了、留得下"

## 三、方案总览（分层）

```
┌─────────────────────────────────────────────────────┐
│  L4 固化/沉淀   wb_publish_workflow → createApp      │
├─────────────────────────────────────────────────────┤
│  L3 派生/变体   wb_clone_template / 会话模板         │
├─────────────────────────────────────────────────────┤
│  L2 创作执行   wb_run_workflow(json) / 前端导入 UI    │
├─────────────────────────────────────────────────────┤
│  L1 节点级控制  wb_list_nodes / node_overrides       │
│                 （executor + 校验 + PLAN 扩展）      │
├─────────────────────────────────────────────────────┤
│  L0 现状        固化模板执行（保留，向后兼容）        │
└─────────────────────────────────────────────────────┘
```

- **L1 是本次核心**（痛点 A/B），改动集中、风险可控
- **L2 给"创作"开口子**（痛点 C），API prompt 直执行不依赖画布
- **L3/L4 收尾闭环**（痛点 D，固化复用现有 publish 链路）
- graph 可视化编辑（litegraph → prompt 转换）列为 Phase 2（见 §7），本次不做主进程转换器

## 四、详细设计

### 4.1 L1：节点级参数覆盖

**数据模型**：`WorkbenchPlan` 与 MCP 参数统一增加 `node_overrides`：

```ts
// PLAN 扩展（node_overrides 可选，不破坏现有 PLAN）
{
  intent, templateId, params, ...
  nodeOverrides?: {
    [nodeId: string]: {
      class_type?: string,          // 防串号：声明校验用
      widgetOverrides?: Record<string, unknown>,   // 改 widget 值（steps/cfg/prompt...）
    }
  }
}
```

**executor 扩展**（`executeApp` 第 3.5 步，在 input 合并之后、提交之前）：

```ts
// 节点级覆盖：只允许写"直接值"字段（跳过 ["nodeId", slot] 链接引用）；
// 目标是链接的字段 → 明确报错提示（引导改上游节点）
if (nodeOverrides) {
  for (const [nodeId, cfg] of Object.entries(nodeOverrides)) {
    const node = prompt[nodeId]
    if (!node) return issue(`节点不存在: ${nodeId}`)
    if (cfg.class_type && node.class_type !== cfg.class_type)
      return issue(`节点 ${nodeId} 类型不匹配: 期望 ${cfg.class_type}，实际 ${node.class_type}`)
    for (const [k, v] of Object.entries(cfg.widgetOverrides ?? {})) {
      if (!(k in node.inputs)) return issue(`节点 ${nodeId} 无输入 ${k}`)
      if (Array.isArray(node.inputs[k])) return issue(`字段 ${k} 是链接引用，不能直接赋值（请改上游节点）`)
      node.inputs[k] = v
    }
  }
}
```

**校验扩展**（`validatePlanLocal` 之后新增 `validateNodeOverrides`，走 live `/object_info`）：

```ts
// /object_info[class_type].input.required 里有该节点的全部 widget schema：
// 键存在性 + 类型（INT/FLOAT/STRING/BOOLEAN/COMBO）+ 枚举（COMBO values）+ 范围（min/max）
// 与 validateModels / validateAgainstObjectInfo 同源，ComfyUI 不可达时降级放行（执行时真实报错）
```

**MCP 工具新增**：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `wb_list_nodes` | 读模板完整节点图（id/class_type/可写 widget schema，源自 /object_info） | template_id（可选：不传=读 /object_info 全量节点类型） |
| `wb_set_node_params` | 预览校验某节点的覆盖（返回校验结果，不执行） | template_id, node_id, class_type, params |
| `wb_execute_template` 扩展 | 增加 `node_overrides` 参数（与 PLAN 同构） | 原有 + node_overrides |

**提示词（spec）注入**：

```
## 节点级控制（wb_* 工具）
用户需要"更精细"时（改采样步数/CFG/尺寸/换模型等模板未暴露的参数）：
1. wb_list_nodes(template_id) 看节点与可写 widget（含枚举/范围）。
2. 用 node_overrides 精确覆盖：{"node_id": {"class_type": "...", "widgetOverrides": {"steps": 30}}}
3. 链接型字段不能直接赋值——改它上游节点的输出参数。
校验失败会打回原因（字段不存在/类型错/越界/是链接），按提示修正后重试。
```

### 4.2 L2：任意工作流执行（创作）

**MCP 工具**：

| 工具 | 作用 | 关键参数 |
|---|---|---|
| `wb_validate_workflow` | 校验 API prompt JSON（节点类型 /object_info、链接引用完整性） | workflow（ComfyPrompt） |
| `wb_run_workflow` | 校验→seed 处理→queuePrompt→（可选 wait）轮询 | workflow, seed, node_overrides?, wait |

**实现**：`executor.ts` 抽一个 `executePrompt(comfyOrigin, prompt, opts)`（executeApp 内部复用），wb_run_workflow 直接调用，产物落会话（复用 `pollExecution` 回填 + artifact 卡片）。

**前端**：工作台会话输入区支持"粘贴 workflow JSON 运行"（可折叠的进阶入口）；产物走现有 artifact 通道。图形编辑仍建议在 A 界面画布完成。

### 4.3 L3：模板派生/变体

| 工具 | 作用 |
|---|---|
| `wb_clone_template` | template_id → 会话级模板（`session:<id>`），可叠加 node_overrides 保存为变体 |

### 4.4 L4：固化沉淀

| 工具 | 作用 | 复用 |
|---|---|---|
| `wb_publish_workflow` | 把会话内创作/修改的工作流固化为新 App（名称+prompt+paramsNodes 自动提取） | `POST /api/apps` + `appAssets` 链路（现有 publish 能力） |

### 4.5 提示词全面升级（decide spec）

- 工具能力声明从"5 个 wb_*"扩到"节点级 + 创作"两段，附**决策规则**：
  1. 模板够用时先用模板（默认路径，省 token）
  2. 用户明确要改参数 → 节点级覆盖（L1）
  3. 现有模板无法表达 → 创作/上传工作流（L2）
  4. 运行成功后建议沉淀（L4，可选）
- 会话近史自动携带执行错误（含节点级错误），模型能自我修正（已有 autoRecover 兜底）

### 4.6 安全边界（新增能力必须同等级防护）

| 风险 | 对策 |
|---|---|
| 覆盖非法参数 | `/object_info` 校验 widget 存在性/类型/枚举/范围；链接字段拒绝直写 |
| 节点类型不存在 | `validateAgainstObjectInfo`（已存在）复用 |
| 上传恶意/超限工作流 | prompt 大小上限（如 2MB）、节点数上限（如 200）、超时沿用 10min |
| 破坏性节点 | MVP：节点类型白名单 = /object_info 已装节点（本地代码，风险≈在本地 ComfyUI 点运行）；如后续需要可加黑名单（python 执行类） |
| 越权修改 | node_overrides 仅作用于本次执行副本（structuredClone），不污染模板 |

## 五、数据流（改动后快路径）

```
用户："把 KSampler 步数调到 40，cfg 7，换成某个模型"
  → decide：wb_list_nodes(template) 查 schema
  → PLAN { templateId, params: {prompt: "..."}, nodeOverrides: { "12": {class_type:"KSampler", widgetOverrides:{steps:40,cfg:7}} } }
  → validatePlanLocal + validateNodeOverrides(/object_info)
  → executeApp（input 合并 + nodeOverrides 合并）→ queuePrompt → poll
  → 产物卡片 + 错误回喂（失败自动恢复轮可修正 nodeOverrides）
```

## 六、改动清单（Phase 1）

| 文件 | 改动 |
|---|---|
| `executor.ts` | `executeApp` 加 node_overrides 合并；抽 `executePrompt` 供 wb_run_workflow 复用；`extractOutputs` 不变（paramsNodes 缺省时按输出节点推断） |
| `plan.ts` | `WorkbenchPlan.nodeOverrides`；`validateNodeOverrides`（/object_info widget schema） |
| `workbenchTools.ts` | 新增 wb_list_nodes / wb_set_node_params / wb_validate_workflow / wb_run_workflow / wb_clone_template / wb_publish_workflow；wb_execute_template 加 node_overrides |
| `service.ts` | execute 透传 nodeOverrides；会话模板支持（clone）；publish_workflow 复用 appStore |
| `routes/workbench.ts` | /api/workbench/run-workflow（前端导入入口）；/api/workbench/clone-template |
| `workbench/index.vue`（前端） | 会话输入区"运行工作流 JSON"入口（可折叠）；节点覆盖结果展示 |
| `i18n.js` | 新文案 |

## 七、分阶段实施

| 阶段 | 内容 | 依赖 | 工作量 |
|---|---|---|---|
| **P1（建议本次）** | L1 节点级覆盖（executor+校验+MCP+提示词）+ L2 API prompt 直执行 + L3 clone | 无 | 中（~1 天） |
| P2 | graph(litegraph)→prompt 转换器（移植 ComfyUI 前端逻辑）或画布联动编辑 | P1 | 大 |
| P3 | 模板市场 / 分享 / 内置模板精选（Comfy-Org MIT 库） | P1 | 中 |

## 八、风险与待确认

1. **节点 id 稳定性**：`wb_list_nodes` 返回的 nodeId 是 prompt 的数字键；graph 重排（A 界面重新固化）后 id 会变——会话内使用没问题，跨会话需重新查。确认是否引入"节点名称 → id"映射辅助（基于 graph 的 title，graph 缺失时降级）。
2. **/object_info 体积**：全量节点 schema 可能几百 KB，`wb_list_nodes` 需裁剪（只返回目标模板涉及的节点 + 参数摘要），避免 token 爆炸。
3. **validateNodeOverrides 的 widget 来源**：/object_info 的 required 含全部输入（含链接位）。需区分 widget（直接值）与链接位——直接值才能覆盖，与执行端一致。
4. **graph→prompt 是否本轮做**：若用户高频创作复杂工作流，P2 价值高；但实现量级是 P1 的数倍，建议先 P1 验证需求。
