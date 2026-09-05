---
name: wb-model-knowledge
description: 本机模型知识查询规范——用 wb_query_models 获取 lora/checkpoint 的 civitai 触发词、用法提示与官方示例提示词，用于模型选型决策与提示词撰写。当用户提到某个 lora/模型、需求涉及风格化生成但不知该用哪个模型、或需要为选中的 lora 写触发词提示词时使用。
---

# 本机模型知识查询（wb_query_models）

数据源是本机 LoRA Manager（ComfyUI-Lora-Manager 插件）同步的 civitai 元数据。
LoRA Manager 未运行时该工具不可用——此时按环境快照的模型文件名保守决策并告知用户。

## 何时查

1. 用户点名某个 lora/模型 → `action=detail` 拿触发词与示例
2. 需求涉及风格化（电影感/动漫风/特定画风）但用户没说用哪个模型 → `action=search` 按风格关键词搜（匹配文件名/模型名/触发词/标签），从清单里挑
3. 要为选中模型写提示词 → **先看 trigger_words**，把它放进正向提示词（Anima 标签式提示词里触发词放最前）

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
