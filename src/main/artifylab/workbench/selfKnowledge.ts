/**
 * 工作台自我认知（self-knowledge）：AGENTS.md 风格常驻能力说明。
 *
 * 对齐 dsh 的 agent-instructions 语义——给 codex 决策线程一份稳定的
 * 「我是谁/我能干什么/当前环境有什么」上下文，使工作台能：
 * - 联网查工作流最佳实践 / 社区 awesome 提示词（codex 自带 web 检索，
 *   只需在 instructions 中明确授权与用途边界）
 * - 感知本地环境（已装自定义节点/模型清单来自 appStore+modelsDirs+
 *   object_info 缓存，经环境快照段注入）
 * - 按环境推荐可行的最佳工作流设置
 *
 * 纯函数层（无 electron 依赖）以便单测。
 */

/** 环境快照（由 service 从 appStore/models/object_info 聚合） */
export interface WorkbenchEnvSnapshot {
  /** 已固化应用（每个 = 一个可用模板） */
  appNames: string[]
  /** 本地模型文件名（按类型分组，截断到前 N 个防 prompt 膨胀） */
  modelsByType: Record<string, string[]>
  /** VRAM GB（无显卡环境省略） */
  vramGb?: number
  /** 已安装自定义节点包名（best-effort，object_info key 数量过大时截断） */
  customNodes: string[]
  /** 模型根目录（modelsDirs，模型下载/落盘指引的真实目标路径） */
  modelDirs?: string[]
}

export const SELF_KNOWLEDGE_TEXT = `你是 Artify 工作台的调度 agent，运行在 ComfyUI Desktop（ArtifyLab 分支）内。

## 你能做什么
1. 模板执行：从模板库选模板填参执行（image/video/audio），产物自动入库。
   匹配判断与自组工作流的完整规则见下方「规则」1/1.1——那是唯一权威定义，不在此重复。
2. 文本生成：intent=text 时直接产出文案（回复放 reply 字段）。
3. 澄清对话：intent=chat 追问澄清或闲聊。
4. 联网检索：当用户需求涉及「最佳实践/最新模型用法/提示词优化/community 模板」时，
   你可以联网搜索（如 Civitai articles、comfy.org examples、r/StableDiffusion、
   GitHub awesome-comfyui 等社区源），把结论落到参数选择上。不要编造具体 checksum/
   版本号；搜不到就按保守经验值决策并说明。
5. 环境适配：结合「环境快照」里的已装模型与自定义节点推荐可行的工作流设置；
   用户点名的模型/节点不在列表里时，先给 chat 说明缺什么、建议怎么装。
6. 画布协同：能感知「画布当前状态」（当前激活 tab 的工作流/模型/参数），执行
   加载布局 / 执行当前工作流 / 批量变体 / App 节点操作——对应规则 3.x（该段仅在
   有画布上下文时注入）；对齐/自动布局 ops 详见 wb-orchestration skill。

## 术语区分（防误导）
- 本工作台的「模板库」= 已固化模板（wb_list_templates 查、wb_execute_template 执行）。
- 部分技能正文里的 "Template Library" 指 **ComfyUI 原生模板库**（ComfyUI 网页界面
  里的模板卡片）——只有 ComfyUI 界面（C 侧栏/画布宿主）里才有；用户在独立工作台
  或找不到该入口时，把对应步骤转化为：指导用户在 ComfyUI 界面操作，或直接用
  wb_list_nodes + wb_run_workflow 自组等效工作流。

（决策 JSON 输出格式见下方「规则」段——那是唯一权威定义。）
`

/** 环境快照 → 注入文本（模型每类最多 N 个，防 prompt 膨胀） */
export function renderEnvSnapshot(env: WorkbenchEnvSnapshot, maxPerType = 12): string {
  const lines: string[] = []
  if (env.appNames.length) {
    lines.push(`已固化模板（可直接执行）：${env.appNames.join('、')}`)
  }
  const modelTypes = Object.entries(env.modelsByType).filter(([, v]) => v.length > 0)
  if (modelTypes.length) {
    for (const [type, names] of modelTypes) {
      const shown = names.slice(0, maxPerType)
      const more = names.length > shown.length ? ` 等 ${names.length} 个` : ''
      lines.push(`本地模型[${type}]：${shown.join('、')}${more}`)
    }
  }
  if (typeof env.vramGb === 'number' && env.vramGb > 0) {
    lines.push(`显存：约 ${Math.round(env.vramGb)}GB`)
  }
  if (env.modelDirs?.length) {
    // 模型落盘的真实目标路径：model-registry/troubleshooting 类技能指导
    // 下载模型时必须知道往哪个目录放（models/<type>/）
    lines.push(
      `模型根目录（下载模型放 <目录>/<checkpoints|loras|...>/）：${env.modelDirs.join('；')}`
    )
  }
  if (env.customNodes.length) {
    const shown = env.customNodes.slice(0, 20)
    lines.push(
      `已装自定义节点：${shown.join('、')}${env.customNodes.length > shown.length ? ` 等 ${env.customNodes.length} 个` : ''}`
    )
  }
  if (!lines.length) return '（空环境：尚无固化技能/本地模型记录）'
  return lines.join('\n')
}
