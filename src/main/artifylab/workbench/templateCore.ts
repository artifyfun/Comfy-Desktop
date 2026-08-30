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

/** app → 模板（无 template.prompt 不可执行，null） */
export function templateFromApp(app: App): WorkflowTemplate | null {
  const prompt = app.template?.prompt
  if (!prompt || Object.keys(prompt).length === 0) return null
  const paramsNodes = app.template?.paramsNodes ?? []
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
 * 仍能把节点加载到画布（可编辑，布局后续可拖动整理）：
 * - 节点：id/type 保留，pos 网格排布，widgets_values 尽力取 inputs 标量
 * - links：跳过——API 链接引用 ["id", slot] 缺 target_slot 语义，盲连会错位
 */
export function promptToWorkflowGraph(prompt: ComfyPrompt): { nodes: unknown[]; links: unknown[] } {
  const entries = Object.entries(prompt)
  const nodes = entries.map(([id, n], i) => {
    const widgetsValues: unknown[] = []
    for (const v of Object.values(n.inputs)) {
      if (v === null || typeof v === 'object') continue // 链接引用/复杂值不填
      widgetsValues.push(v)
    }
    return {
      id: Number(id),
      type: n.class_type,
      pos: [80 + (i % 6) * 40, 80 + Math.floor(i / 6) * 60],
      size: [280, 90],
      flags: {},
      order: i,
      mode: 0,
      inputs: [],
      outputs: [],
      properties: { 'Node name for S&R': n.class_type },
      widgets_values: widgetsValues
    }
  })
  return { nodes, links: [] }
}
