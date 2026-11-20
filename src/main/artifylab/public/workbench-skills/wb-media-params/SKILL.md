---
name: wb-media-params
description: Artify 工作台媒体参数语义与模板变通指南。当遇到「提示词文本被塞进图片/视频上传槽报 No such file」「模板关键参数全是素材槽无法文生图」「需要绕过模板限制改图生文」等媒体槽类型问题时使用。
---

# Artify 工作台媒体参数指南

## 参数类型（rc = renderComponent）

模板参数里的 rc 决定参数真实语义：

- **`*-uploader`（image-uploader / video-uploader / audio-uploader）= 素材文件槽**
  只能传：已上传素材的文件名，或 `data:`/`http(s):` URL。
  **绝不能传提示词文本**——会导致 ComfyUI 报 `No such file or directory`。
- **`textarea` / `select` / `slider` / `number`（或无 rc 的文本型）**：收提示词文本/数值/枚举值。
- 数值参数遵守 min/max；枚举参数必须完全匹配可选值（`wb_list_templates` 的 options 字段）。

## 模板不合适就变通，不要盲目重试

如果用户要文生图、但候选模板的关键参数全是素材槽（图生图/槽位替换类），不要硬传文本。
**先复盘本会话此前的工具调用与执行结果**（它们都在你的上下文里——比如上次是否把文本传进了图片槽导致 No such file），基于事实修正而非凭空重试。变通路径按顺序：

1. `wb_list_nodes(template_id)` 查看模板节点图确认各节点类型；
2. 用 PLAN 的 `node_overrides` 修改节点参数（如把 LoadImageFromPath 换成 EmptyLatentImage，或直接改下游节点输入）；
3. `wb_run_workflow` 提交自组 API 工作流（`wb_list_nodes()` 不带参数可看全量节点类型）；
4. `wb_clone_template` 派生可编辑变体。

重试同参数只会重复同样的失败。

## 素材与链式

- 用户上传的素材：参数值直接填素材文件名（系统已上传到 ComfyUI input 目录）。
- 链式引用：`usePreviousOutput=true` 把本会话上一次执行的产物文件写进工作流首个媒体加载槽（Load* 节点的首个字符串输入字段）。图→视频、图→图的典型链路用它。
