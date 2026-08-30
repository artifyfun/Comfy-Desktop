---
name: wb-batch-memory
description: Artify 工作台批量编排与长期记忆指南。当用户需要多条产出（列出行/表格/N 个变体）需要输出 batch 计划，或用户表达跨会话偏好/事实（「以后都用…」「记住我喜欢…」「我的显卡是…」）需要记忆读写时使用。
---

# Artify 工作台批量与记忆指南

## 批量编排（batch）

用户需要多条产出（明确列出行、给表格/清单、要求 N 个变体）时，输出 batch 字段：

```json
"batch": { "items": [ {…参数行}, … ], "sharedParams": {…全批次共享覆盖} }
```

- `items` 每行是一个参数对象，键=模板参数名，仅写与默认值不同的键；2~200 行
- 行内值覆盖 `sharedParams`，`sharedParams` 覆盖模板默认值；未提到的参数用模板默认
- 例：「这两个提示词各出一张图」→ `items:[{"prompt":"A"},{"prompt":"B"}]`

## 画布批量（canvas-run + batch）

对**画布当前工作流**批量出图（C 界面侧边栏）时，行键用「节点id.widget名」格式（节点 id 取「画布当前状态」清单里的 `#id`）：

```json
{"intent":"canvas-run","batch":{"items":[{"16.steps":40},{"16.steps":60}],"sharedParams":{"9.text":"夜景氛围"}}}
```

- 键=「节点id.widget名」（如 `16.steps`、`9.text`），值=该 widget 新值
- `sharedParams` 为全批共享的固定变体（同格式），行内值优先
- 系统按行逐条执行画布当前工作流；不确定节点/widget 名时先看「画布当前状态」节点清单

## 长期记忆（intent=memory）

用户表达**可跨会话保留**的偏好/事实时：

```json
{"intent":"memory","memory":{"action":"remember","key":"短标签(英文-kebab,如 preferred-style)","value":"一句话内容"},"reply":"向用户确认记住了什么"}
```

- 用户要求忘掉某事（「别再用…」「忘掉…」）时 `action=forget`（只需 key；不匹配任何键时用最接近的键并在 reply 说明）。
- 环境快照/会话近史与已有记忆冲突时，以用户新表述为准主动 `remember` 更新同 key。
- MCP 工具等价物：`wb_remember(key, value)` / `wb_forget(key)`。
