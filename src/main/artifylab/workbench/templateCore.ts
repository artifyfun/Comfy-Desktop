/**
 * 纯函数层：app → 模板转换 + 伪 App 包装（无 electron/appStore 运行时依赖，
 * 便于单测；templates.ts 在此之上加缓存/事件/单例）。
 */
import type { App, ComfyPrompt, ParamNode } from '../appStore'

export type WorkbenchMediaType = 'image' | 'video' | 'audio' | 'text'

export interface WorkflowTemplate {
  id: string // builtin:<name> | app:<appId>
  name: string
  description: string
  descriptionEn?: string
  mediaType: WorkbenchMediaType
  prompt: ComfyPrompt
  /** UI graph 格式（{nodes,links}）：画布同步（intent=workflow）需要；无则提示先固化 */
  workflow?: unknown
  paramsNodes: ParamNode[]
  requiredModels?: string[]
  knowledge?: string
  chainable?: boolean
  source: 'builtin' | 'app' | 'session'
  appId?: string
}

/** 从 app 推断产物媒体类型：输出 renderComponent 优先，class_type 兜底 */
export function inferMediaType(app: App): WorkbenchMediaType {
  const outs = (app.template?.paramsNodes ?? []).filter((n) => n.category === 'output')
  for (const n of outs) {
    if (n.renderComponent === 'video-uploader') return 'video'
    if (n.renderComponent === 'audio-uploader') return 'audio'
  }
  const prompt = app.template?.prompt
  if (prompt) {
    const types = Object.values(prompt).map((n) => n.class_type)
    if (types.some((t) => /video|animate|VHS_/i.test(t))) return 'video'
    if (types.some((t) => /audio|music/i.test(t))) return 'audio'
  }
  return 'image'
}

/** loader 节点提取模型依赖（.safetensors 等），去重 */
export function extractRequiredModels(prompt: ComfyPrompt): string[] {
  const models: string[] = []
  for (const node of Object.values(prompt)) {
    if (!/Loader|Load/i.test(node.class_type)) continue
    for (const v of Object.values(node.inputs)) {
      if (typeof v === 'string' && /\.(ckpt|safetensors|pt|gguf|bin|sft)$/i.test(v)) {
        models.push(v)
      }
    }
  }
  return [...new Set(models)]
}

/**
 * 参数角色推断：沿 prompt 数据流（输入引用边）追踪参数节点的输出是否最终流入
 * 「文件加载类节点」（LoadImage/LoadVideo/LoadAudio/LoadImageFromPath/VHS 等）的输入。
 * 是 → 该参数是素材路径槽：强制 rc 为 uploader 语义、description 标注「路径」——
 * 防止「图片路径槽被命名成 prompt 且 rc=textarea」时 agent 按文本参数误传提示词
 * （真实事故：Anima+槽位替换A 参数 prompt 经 JavascriptExecutor 去引号后喂给
 * LoadImageFromPath，agent 传了整段提示词 → No such file or directory）。
 * 数据流沿「inputs 值为 [上游id, slot]」的消费边 BFS，JS 透传链自然覆盖。
 */
const FILE_LOADER_RE =
  /Load(Image|Video|Audio|ImageFromPath|Mask|Latent|ImageURL|ImageMask)|VHS_Load|ImageLoader|LoadImageFrom|LoadMask/i

export function inferParamRoles(prompt: ComfyPrompt, paramsNodes: ParamNode[]): ParamNode[] {
  if (!paramsNodes.length) return paramsNodes
  const byId = new Map(Object.keys(prompt).map((id) => [Number(id), prompt[id]!]))

  /** 参数节点 id 的数据流是否触达文件加载节点（BFS 消费边） */
  const flowsIntoFileLoader = (startId: number): boolean => {
    if (!Number.isFinite(startId) || !byId.has(startId)) return false
    const visited = new Set<number>()
    const queue = [startId]
    while (queue.length) {
      const id = queue.shift()!
      if (visited.has(id)) continue
      visited.add(id)
      const node = byId.get(id)
      if (!node) continue
      if (FILE_LOADER_RE.test(node.class_type)) return true
      // 找消费当前节点输出的下游：任意节点 inputs 值含 [id, slot]
      for (const [downId, down] of byId) {
        if (visited.has(downId)) continue
        const consumes = Object.values(down.inputs).some(
          (v) => Array.isArray(v) && Number(v[0]) === id
        )
        if (consumes) {
          // JS 透传链继续追踪；文件加载链已在顶部命中；其他消费者也继续（防改道）
          queue.push(downId)
        }
      }
    }
    return false
  }

  return paramsNodes.map((p) => {
    if (p.category !== 'input') return p
    if (/uploader$/i.test(p.renderComponent ?? '')) return p // 已是素材槽，不动
    if (!flowsIntoFileLoader(Number(p.id))) return p
    const kind = /video/i.test(String(p.type ?? '') + ' ' + String(p.description ?? ''))
      ? 'video'
      : /audio/i.test(String(p.type ?? '') + ' ' + String(p.description ?? ''))
        ? 'audio'
        : 'image'
    return {
      ...p,
      renderComponent: `${kind}-uploader`,
      description: `${p.description ? `${p.description}；` : ''}${kind === 'image' ? '图片' : kind}路径（填已上传文件名或 http(s)/data URL）`
    }
  })
}

/** app → 模板（无 template.prompt 不可执行，null） */
export function templateFromApp(app: App): WorkflowTemplate | null {
  const prompt = app.template?.prompt
  if (!prompt || Object.keys(prompt).length === 0) return null
  const paramsNodes = inferParamRoles(prompt, app.template?.paramsNodes ?? [])
  const mediaType = inferMediaType(app)
  return {
    id: `app:${app.id}`,
    name: app.name,
    description: app.description || `${app.name}（${mediaType}）`,
    mediaType,
    prompt,
    workflow: app.template?.workflow ?? undefined,
    paramsNodes,
    requiredModels: extractRequiredModels(prompt),
    chainable:
      mediaType !== 'text' &&
      paramsNodes.some(
        (n) =>
          n.category === 'input' && /image|video|audio|-uploader$/i.test(n.renderComponent ?? '')
      ),
    source: 'app',
    appId: app.id
  }
}

/** 模板 → executor.executeApp 认识的伪 App */
export function toPseudoApp(t: WorkflowTemplate): App {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    createdAt: 0,
    updatedAt: 0,
    template: { prompt: t.prompt, paramsNodes: t.paramsNodes, workflow: t.workflow }
  }
}

/**
 * API 格式 prompt → UI graph（{nodes, links}）兜底转换。
 * 模板未保存画布布局（workflow 缺失，如手动建 App 只填 prompt）时，
 * 仍能把节点加载到画布（可编辑、可执行）。实测 ComfyUI 0.33（Playwright
 * 逐方案验证）确认：
 * - LGraph.configure 对大量节点/复杂图会中途中断（真实 62 节点模板只建 10 个，
 *   与 links 是否传入无关）——注入桥对无 version 元数据的简易图改走
 *   「手工加载」：createNode + configure + add 逐节点建 + 按输入名反查 slot
 *   手动 connect（62 节点 87 连线端到端 0 失败）
 * - links 为**数组元组** [link_id, origin_id, origin_slot, target_id,
 *   target_slot, type, toKey]，toKey=目标输入键名——手工 connect 靠它定位
 *   目标槽（节点 inputs 被 class 定义重建后，序号不可靠，名字才可靠）
 * - 节点 inputs 槽只带 {name,type}（手工 connect 不依赖 link 字段）；
 *   outputs 槽数 = 被引用最大 slot+1
 * - 布局：拓扑分层（source-aligned，无上游=层 0，下游 = max(上游)+1），
 *   按层分列、层内排行——列间距 340 / 行间距 150，避免节点堆叠
 */
export function promptToWorkflowGraph(prompt: ComfyPrompt): { nodes: unknown[]; links: unknown[] } {
  const entries = Object.entries(prompt)
  const ids = entries.map(([id]) => Number(id))

  // 1) 链接边收集：API 引用 ["上游id", 输出slot]；destSlot 按目标节点链接输入键序编号
  interface Edge {
    from: number
    to: number
    fromSlot: number
    key: string
    linkId: number
    destSlot: number
  }
  const edges: Edge[] = []
  for (const [id, node] of entries) {
    const nid = Number(id)
    let linkIdx = 0
    for (const [key, v] of Object.entries(node.inputs)) {
      if (Array.isArray(v) && Number.isFinite(Number(v[0])) && Number.isFinite(Number(v[1]))) {
        edges.push({
          from: Number(v[0]),
          to: nid,
          fromSlot: Number(v[1]),
          key,
          linkId: 0,
          destSlot: linkIdx
        })
        linkIdx++
      }
    }
  }
  edges.forEach((e, i) => (e.linkId = i + 1))

  // 2) 拓扑分层：无上游=0，其余 = max(上游层)+1（环/孤立兜底 0）
  const inDegree = new Map<number, number>()
  for (const e of edges) inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1)
  const depth = new Map<number, number>()
  const queue: number[] = []
  for (const id of ids) {
    if (!inDegree.has(id)) {
      depth.set(id, 0)
      queue.push(id)
    }
  }
  for (let qi = 0; qi < queue.length; qi++) {
    const id = queue[qi]!
    const d = depth.get(id) ?? 0
    for (const e of edges) {
      if (e.from !== id) continue
      const nd = d + 1
      if (nd > (depth.get(e.to) ?? -1)) depth.set(e.to, nd)
      queue.push(e.to)
    }
  }
  for (const id of ids) if (!depth.has(id)) depth.set(id, 0)

  // 3) 排布：按深度分列，层内按 id 序排行
  const COL_GAP = 340
  const ROW_GAP = 150
  const pos = new Map<number, [number, number]>()
  const byDepth = new Map<number, number[]>()
  for (const id of ids) {
    const d = depth.get(id) ?? 0
    const arr = byDepth.get(d) ?? []
    arr.push(id)
    byDepth.set(d, arr)
  }
  for (const [d, list] of byDepth) {
    list.sort((a, b) => a - b)
    list.forEach((id, row) => pos.set(id, [80 + d * COL_GAP, 80 + row * ROW_GAP]))
  }

  // 4) 节点/连线构造（links 元组带 toKey；节点槽只带 name/type，手工 connect 用）
  const maxOutSlot = new Map<number, number>()
  for (const e of edges) maxOutSlot.set(e.from, Math.max(maxOutSlot.get(e.from) ?? -1, e.fromSlot))

  const nodes = entries.map(([id, n], i) => {
    const nid = Number(id)
    const widgetsValues: unknown[] = []
    const inputSlots: Array<{ name: string; type: string }> = []
    for (const [key, v] of Object.entries(n.inputs)) {
      if (Array.isArray(v) && Number.isFinite(Number(v[0]))) {
        inputSlots.push({ name: key, type: 'default' }) // 链接输入 → 输入槽
      } else if (v === null || typeof v === 'object') {
        continue // 复杂值不填
      } else {
        widgetsValues.push(v)
      }
    }
    const outCount = (maxOutSlot.get(nid) ?? -1) + 1
    const outputSlots = Array.from({ length: outCount }, (_, k) => ({
      name: `out${k}`,
      type: 'default'
    }))
    const [x, y] = pos.get(nid) ?? [80, 80]
    return {
      id: nid,
      type: n.class_type,
      pos: [x, y],
      size: [280, 90],
      flags: {},
      order: i,
      mode: 0,
      inputs: inputSlots,
      outputs: outputSlots,
      properties: { 'Node name for S&R': n.class_type },
      widgets_values: widgetsValues
    }
  })
  // [link_id, origin_id, origin_slot, target_id, target_slot, type, toKey]
  const links = edges.map((e) => [e.linkId, e.from, e.fromSlot, e.to, e.destSlot, 'default', e.key])
  return { nodes, links }
}
