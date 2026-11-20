---
name: wb-model-knowledge
description: 模型知识查询与 civitai 在线搜索——用 wb_query_models 获取 lora/checkpoint 的 civitai 触发词、用法提示、官方示例提示词，或在线搜索 civitai 模型（触发词/热度/基模兼容性）。当用户提到某个 lora/模型、需求涉及风格化生成但不知该用哪个模型、要找本机没有的模型、或需要为选中的 lora 写触发词提示词时使用。
---

# 模型知识查询与 civitai 搜索（wb_query_models）

三个 action，数据源不同：

- `search` / `detail`：本机清单（LoRA Manager 同步的 civitai 元数据）。LoRA Manager 未运行时不可用
- `civitai`：civitai 在线搜索（走官方 API，需网络；无 key 时 NSFW 结果受限）——本机没有的模型用它找

## 何时查

1. 用户点名某个 lora/模型 → `action=detail` 拿触发词与示例
2. 需求涉及风格化但用户没说用哪个模型 → 先 `action=search` 搜本机清单；本机没有 → `action=civitai` 在线找（候选给用户挑，不要擅自下载）
3. 要为选中模型写提示词 → **先看 trigger_words**，放进正向提示词（Anima 标签式提示词里触发词放最前）

## civitai 在线搜索要点

- **务必带 `base_model` 过滤**（如模板是 Illustrious 就传 `"Illustrious,NoobAI"`）——Flux 的 lora 装不进 SDXL checkpoint，基模不兼容的候选没有意义
- 返回字段：`trigger_words`（训练触发词）、`version_id`、`downloads/thumbs_up`（热度参考）、`page_url`（给用户看的页面链接）
- 用户选中候选后：模型需下载安装才能用——告知用户去 page_url 下载（或装进 LoRA Manager），不要假装本机已有
- 优先 `sort=Most Downloaded`；`nsfw` 默认 true，用户要求健康内容时传 false

## 怎么用返回值

| 字段              | 含义                                        | 用法                                                                                                                                                        |
| ----------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `trigger_words`   | 训练触发词                                  | 原样放进提示词，多个逗号分隔；不要自行改写                                                                                                                  |
| `usage_tips`      | 作者的用法建议（推荐强度等）                | 优先遵守（如建议 weight 0.7-0.9）                                                                                                                           |
| `base_model`      | 训练底模（SDXL/Pony/Illustrious/Flux…）     | 必须与所选模板的 checkpoint 兼容，不兼容就换模板或提示用户                                                                                                  |
| `example_prompts` | 官方示例提示词（来自 civitai 图片生成参数） | 参考其结构/风格词；`lora_weight` 是作者用的权重。注意：上传者隐藏生成参数时该字段为空（实测多数模型如此），此时以 trigger_words + usage_tips + 自行组词为准 |
| `notes`           | 用户/作者手写备注                           | 最高优先级参考                                                                                                                                              |

## 与模板执行的关系

- 模板参数里的 lora 槽（参数名含 lora/模型路径）填 `file_name`（相对 models 目录路径）
- 权重默认从 usage_tips / example_prompts.lora_weight 取；都没有时用 0.8 起步
- 一个 lora 没效果时先确认：触发词放了？权重合理？base_model 与 checkpoint 匹配？

## 约束

- `example_prompts` 是 civitai 官方示例，仅作风格与结构参考，不要原样照抄长 prompt
- 查询结果较大，search 先拿清单挑定目标，再 detail 看详情，不要批量 detail
- civitai 在线搜索每轮最多 1-2 次（有 60s 缓存，同词重搜无意义）
