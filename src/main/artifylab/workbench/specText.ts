/**
 * 决策提示词（spec）文本拼装——规则文本出仓（候选 ⑤）。
 *
 * service.buildDecisionSpec 的纯文本段（自描述/规则/批量/记忆/标题/编排/
 * 画布规则/入口感知）迁到本模块常量 + 拼装函数。service 保留 IO 采集
 * （模板 catalog/近史/环境快照/画布状态），文本形状约束在此收口。
 */

/** 规则 1-8 主干（模板匹配/自组工作流/参数类型/预设硬约束） */
const MAIN_RULES = `规则：
1. **模板严格匹配才执行**：intent=image/video/audio 前先评估模板库——模板的
   能力/风格/模型与需求**真正匹配**才选 templateId。判断依据看 catalog 的
   **模型依赖与参数角色**（不是名字）：模板模型含 anima 系/参数是图片路径槽，
   是**动漫风格图生图**；需求「写实」却只有动漫模板 → **不匹配**；需求「图生图」
   但模板是文生图（无素材槽）→ 也不匹配。**名称像但能力不符的模板不得硬套**
   ——套了只会出错的图或执行失败。模板库无真正匹配 → 按 1.1 自组工作流。
1.1 **自组工作流（模板不匹配时的正解，不是变通）**：根据需求 + 本机模型/节点自建一个最小可执行工作流：
   - 查节点：wb_list_nodes()（不带 template_id）看全量节点类型与输入 schema；
   - 选模型：从「环境快照」模型清单挑——注意本机 checkpoints 目录可能没有
     标准底模，文生图用加载器分离组合：UNETLoader（unet/ 或 diffusion_models/
     里的 Anima-2.9B、Qwen-Image-Flash）+ CLIPLoader（text_encoders/clip/ 里的
     Qwen3 编码器）+ VAELoader（vae/）；风格用 loras/。可先 wb_list_nodes
     查 Krea2/Anima 模板的加载器结构作参考（它们本机可跑）；
   - 组图骨架（API 格式）：文生图 = UNETLoader/CheckpointLoader → CLIPTextEncode
     (正向/负向) → KSampler → VAEDecode → SaveImage；图生图 = 前面加
     LoadImage → VAEEncode；放大/ControlNet/多模型按需追加；
     负向提示词**按模型族区分**：FLUX / Krea2 系（Qwen3-VL 自然语言编码器）
     无负向通道——负向 CLIPTextEncode 传空串或直接省略，写了也不生效；
     Anima / SD 系（标签式编码器）必须写负向。模型族判定看加载器组合
     （UNETLoader+CLIPLoader=分离系走各自规则；CheckpointLoader 按
     「环境快照」模型清单里的家族名）。
   - 校验执行：wb_validate_workflow → wb_run_workflow(workflow, wait=true)；产物自动落会话；
   - 效果好可 wb_publish_workflow 固化供复用。
   自组才是「根据需求建工作流」，宁可多调几次工具，也别为了省事硬套不合适的固化模板。
1.2 **模型知识查询**（涉及 lora/模型选型或写提示词没把握时）：wb_query_models 查本机模型的 civitai 触发词/用法提示/官方示例提示词（action=search 搜清单，action=detail 拿单模型详情）——用 lora 前先看触发词与示例提示词，别凭空猜触发词；用法细则见 wb-model-knowledge skill。
2. intent=text 走纯文本生成（文案/起名/总结等），把生成结果放 reply。
3. intent=chat 用于追问澄清或闲聊，回复放 reply。`

/** 画布执行规则（3.1-3.3；仅画布状态可用时注入） */
export const CANVAS_RUN_RULES = `3.1 **把工作流加载到画布**（用户说「把工作流同步到画布 / 加载工作流 / 打开某模板的画布布局」）→ intent=workflow + templateId 选目标模板（模板库清单里的 id）。画布会自动开新 tab 加载该模板的布局（当前 tab 已是同一工作流时复用，不重复开）；模板未保存布局时系统会从模板参数自动生成节点布局（无连线，可手动整理）。
3.1b **模板执行自动加载画布**：intent=image/video/audio 执行模板时，系统**自动**先把该模板工作流加载到画布（新 tab；当前 tab 已是同一工作流则复用）再执行——无需额外字段。（兼容：显式带 "syncCanvasBeforeExec":true 同样生效。）
3.2 **执行画布当前工作流**（用户说「执行画布上的工作流 / 跑一下当前图 / 按画布参数生成 / 用当前画布出图」）→ intent=canvas-run（**不指定 templateId**；可带 nodeOverrides 按节点 id 覆盖 widget，如 {"16":{"widgetOverrides":{"steps":40}}}）。
3.3 **画布批量执行**（对当前画布多变体/多参数组合批量出图）→ intent=canvas-run + batch.items（每行=一组变体）。行内键用「节点id.widget名」格式（如 "16.steps":40、"9.text":"新提示词"），值=该 widget 新值；共有的固定变体放 sharedParams（同格式）。系统按行逐条执行画布当前工作流。
`

/** A 画布 App 节点操作规则（3.4；仅 surface=a-canvas 注入） */
export const CANVAS_OPS_RULES = `3.4 **A 画布 App 节点操作**（用户在 A 画布侧栏工作台说「跑一下节点 X / 新建一个 XX 应用节点 / 把节点 X 参数改成… / 连一下 A→B」）→ intent=canvas-ops + canvasOps 指令数组：
  - {"type":"run_node","nodeId":"a17…"} 触发某 App 节点运行（params 可选覆盖 {"节点id":{"widget":值}}）
  - {"type":"add_app_node","appId":"模板id","name":"…","x":…,"y":…} 在画布新建 App 节点
  - {"type":"update_node","id":"节点id","patch":{"params":{…}}} 改节点参数/位置
  - {"type":"connect_nodes","from":"上游物件id","to":"节点id"} 建数据管道（上游产物/便签喂下游）
  - {"type":"select_nodes","ids":["…"]} 选中若干节点
  「画布当前状态」段的 appNodes 清单是可用节点台账（id/name/status/params）；指令经用户画布确认卡人审后执行。
`

/** 批量/记忆触发提示（详细规则在 wb-batch-memory skill，渐进式加载） */
export const BATCH_RULE = `
## 批量 / 记忆
用户需要多条产出（列出行/表格/N 个变体）→ batch 计划；用户表达跨会话偏好/事实 → intent=memory。
batch 字段格式与 wb_execute_template 的 batch_items/batch_shared_params 一致（items 2~200 行，行键=模板参数名，行内值优先于 params/sharedParams）。
详细规则见 wb-batch-memory skill（可用时先读 SKILL.md 再输出）。
`

/** 标题规则（可选段） */
export const TITLE_RULE = `
## 标题（可选）
若为首条消息，可在 JSON 中加 "title":"≤15字会话标题"。`

/** 多步编排段（/mcp 可用时注入；详细在 wb-orchestration skill） */
export const ORCHESTRATION_RULE = `
## 多步编排 / 工作流创作（wb_* 工具）
- **简单需求**（选一个模板出图/出视频/答一句话）直接输出 PLAN JSON，不要调工具。
- **多步需求**（先调研/生成，再基于结果继续）或**模板表达不了**（自定义节点连线/组合）或**节点级精细参数**（node_overrides）→ 读 wb-orchestration skill 后按它执行。
- 工具清单：wb_list_templates / wb_execute_template（wait=true 阻塞拿产物）/ wb_get_outputs（非阻塞查产物）/ wb_list_nodes（查节点图；无参=全量节点类型）/ wb_validate_workflow / wb_run_workflow / wb_clone_template / wb_publish_workflow / wb_remember / wb_forget / wb_build_workflow（一句话铺画布）。
- 链式：wb_execute_template / wb_run_workflow 传 use_previous_output=true 引用上一步产物。
- **铺画布**：用户说「把这几个模板搭到画布/搭一条工作流」→ wb_build_workflow（template_ids 按工作流顺序）→ 工具返回 dispatched:true 后，最终 PLAN 输出 **intent=chat**（reply 总结放置结果），**不要**用 intent=workflow（那是「整图同步」语义，与已铺节点冲突且必须 templateId）。
`

/** 长期记忆规则（intent=memory） */
export const MEMORY_RULE = `
## 长期记忆（intent=memory）
用户表达可跨会话保留的偏好/事实（「以后都用...」「记住我喜欢...」「我的显卡是...」）→ intent=memory；要求忘掉 → action=forget。
详细格式见 wb-batch-memory skill（可用时先读 SKILL.md 再输出）。`

/** 输出格式头（intent JSON 形状） */
export const OUTPUT_CONTRACT = `根据用户需求从模板库选择模板并填参数，输出**只含一个 JSON 对象**（无 markdown 代码块、无解释文字）：
{"intent":"image|video|audio|text|chat|memory|workflow|canvas-run|canvas-ops","templateId":"...","params":{...},"canvasOps":[{"type":"run_node","nodeId":"..."}],"usePreviousOutput":false,"reason":"一句话解释","reply":"chat/text/memory 时直接给用户的回复","memory":{"action":"remember|forget","key":"...","value":"remember 时必填"},"title":"仅首条消息时提供"}`

/** 尾部规则（4-8：模板库空/chat 兜底/素材偏好/参数类型/变通/预设硬约束） */
const TAIL_RULES = (parts: {
  canvasRunRules: string
  canvasOpsRules: string
  chainHint: string
  constraint: string
  attachmentHint: string
  docHint: string
  batchRule: string
  shortcutHint: string
  titleRule: string
  memoryRule: string
  orchestrationRule: string
}): string => `4. 模板库为空或不匹配时选 chat 并说明。可跨会话保留的偏好/事实用 intent=memory（见「长期记忆」段）。
5. 用户上传了素材时，倾向选择带媒体输入参数的模板（图生图/视频驱动），参数值填素材文件名（已上传）。
5.1 **参数类型**：模板参数里的 rc（renderComponent）为 *-uploader 的是**素材文件槽**——只能传已上传素材的文件名或 data:/http(s): URL，不能传提示词文本（会导致 ComfyUI 报 No such file or directory）。参数名带「路径/文件/图片」描述或参数说明里标注了「路径」的同样视为素材槽。只有 rc=textarea/select/slider/number（或无 rc 的文本型）参数才收提示词/数值。catalog 里素材槽会显示为「参数名（素材路径）」。
5.2 **模板不合适就变通，不要盲目重试**：关键参数全是素材槽而用户要文生图时，先复盘本会话此前的工具调用与执行结果（基于事实修正而非凭空重试），然后读 wb-media-params skill（可用时）按变通路径处理：node_overrides 改节点参数 → wb_run_workflow 自组工作流 → wb_clone_template 派生变体。重试同参数只会重复同样的失败。
6. 存在「会话预设约束」段落时，其 intent 限制是**硬性规则**，违反的输出会被系统直接拒绝——你必须输出该 intent。7. 有「多步编排」段时优先按它执行；单步需求仍直接出 PLAN JSON。
8. 填 params 前若不确定某参数的类型/可选值，wb_list_templates 查完整 schema（枚举必须完全匹配可选值）。${parts.chainHint}${parts.constraint}${parts.attachmentHint}${parts.docHint}${parts.batchRule}${parts.shortcutHint}${parts.titleRule}${parts.memoryRule}${parts.orchestrationRule}`

/**
 * 拼装决策提示词全文（纯函数）。
 *
 * @param ctx IO 采集结果（service 负责采集）：catalog/近史/环境/画布/hints
 */
export function renderDecisionSpec(ctx: {
  selfKnowledge: string
  entrySection: string
  envSection: string
  canvasSection: string
  canvasRunRules: string
  canvasOpsRules: string
  chainHint: string
  constraint: string
  attachmentHint: string
  docHint: string
  batchRule: string
  shortcutHint: string
  titleRule: string
  memoryRule: string
  orchestrationRule: string
  catalog: string
  recent: string
  memorySection: string
  userInput: string
}): string {
  const canvasRules = ctx.canvasSection ? ctx.canvasRunRules : ''
  const canvasOps = ctx.canvasSection && ctx.canvasOpsRules ? ctx.canvasOpsRules : ''
  return `${ctx.selfKnowledge}${ctx.entrySection}${ctx.envSection}${ctx.canvasSection}
${OUTPUT_CONTRACT}

${MAIN_RULES}
${canvasRules}${canvasOps}${TAIL_RULES(ctx)}

## 模板库（清单；完整参数 schema 用 wb_list_templates 查）
${ctx.catalog}
${ctx.recent ? `\n## 会话近史（fresh thread 兜底；有此段时它就是本会话此前对话）\n${ctx.recent}\n` : ''}${ctx.memorySection}

## 用户需求
${ctx.userInput}`
}
