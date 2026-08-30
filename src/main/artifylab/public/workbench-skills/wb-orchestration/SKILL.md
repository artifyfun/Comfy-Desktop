---
name: wb-orchestration
description: Artify 工作台多步编排与工作流创作指南。当需求需要多步执行（先调研/生成，再基于结果继续生成或写文案）、模板无法表达（需自定义节点连线/组合）、或需要精细控制节点参数（node_overrides）时使用。
---

# Artify 工作台编排指南

## 多步编排（wb_* 工具）

**多步需求**（如「查XX主题→文生图→图生视频→写文案」）逐步自主执行：

1. `wb_list_templates` 看可用模板（研究类需求可用你的 shell 联网检索，结论作为后续 prompt 输入）。
2. `wb_execute_template(template_id, params, wait=true)` 逐步执行；链式步骤传 `use_previous_output=true` 自动引用上一步产物。
3. 每步产物自动落会话（用户实时可见）；全部完成后，最终回复（agent_message）输出：完整编排总结 + 交付文案（若需要）+ 仍输出 PLAN JSON（intent 标记为最后一个生成步骤，系统会跳过重复执行）。
4. 用户偏好/硬件等跨会话事实用 `wb_remember`/`wb_forget` 沉淀。
5. 非阻塞查询某次执行：`wb_get_outputs`（立即返回最近/指定执行的产物清单）；等跑完用 `wait=true`。

## 节点级控制（node_overrides）

用户要求**更精细的参数**（改采样步数/CFG/尺寸/换模型/改任意节点参数，模板未暴露的）时：

1. `wb_list_nodes(template_id)` 查模板节点图与可写 widget（含类型/枚举/范围，源自 ComfyUI /object_info）。
2. 在 PLAN 里带 `node_overrides` 精确覆盖：`{"节点id": {"class_type": "KSampler", "widgetOverrides": {"steps": 40, "cfg": 7}}}`；`wb_execute_template` 同样接受 node_overrides。
3. **链接型字段**（值是 `["nodeId", slot]` 引用）不能直接赋值——改它上游节点的输出参数，或用 `use_previous_output` 让系统把上一次产物写进首个媒体加载槽。
4. 校验失败会打回原因（字段不存在/类型错/越界/是链接），按提示修正后重试。
5. 模板参数够用时**优先用 params（省 token）**；确实要动模板未暴露的节点才用 node_overrides。

## 工作流创作

现有模板无法表达需求时（要自定义节点连线/组合）：

1. `wb_list_templates` 确认没有可用的；`wb_list_nodes()`（不传 template_id）可看 ComfyUI 全量节点类型清单。
2. `wb_validate_workflow(workflow)` 先校验你的 API 格式 workflow JSON（节点类型/链接完整性，可迭代修正）。
3. `wb_run_workflow(workflow, wait=true)` 直接运行；seed/node_overrides/use_previous_output 可传。产物自动落会话。
4. 效果好的可 `wb_publish_workflow(name, workflow)` 固化为新模板，供后续复用。

API 格式：`{"节点id": {"class_type": "节点类名", "inputs": {"参数名": 值 或 ["上游id", 端口号]}}}`；链接字段值为 `["上游节点id", 输出端口下标]`。

## 画布协同（C 界面 AI 侧边栏）

主场景：感知画布当前 tab 工作流 → 修改 → 执行 → 批量。agent 决策时「画布当前状态」段已注入当前激活 tab 的节点清单/模型/关键参数，节点 id 以清单里 `#id` 为准：

1. **同步模板到画布**：用户说「把工作流同步到画布 / 打开某模板布局」→ PLAN `intent=workflow` + `templateId`（模板库 id）。
2. **执行画布当前工作流**：用户说「执行画布上的 / 跑当前图 / 按画布参数生成」→ PLAN `intent=canvas-run`（不指定 templateId）。需要改参数再跑 → 加 `nodeOverrides`（键=节点 id，值=widgetOverrides，同「节点级控制」格式）。
3. **画布批量执行**：对当前画布多变体 → `intent=canvas-run` + `batch`。行键用「节点id.widget名」格式（如 `"16.steps": 40`、`"9.text": "新提示词"`）；共有的固定变体放 `sharedParams`（同格式）。系统按行逐条执行画布当前工作流，产物逐个回卡。
4. 画布未就绪/图太小时（如空画布），用 chat 说明并建议先在画布打开工作流。
