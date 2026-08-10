/**
 * A UI app 参数 → MCP 工具 JSON Schema 转换。
 *
 * 映射来源：artifylab-frontend/src/utils/index.js:244-294 (getRenderComponent)。
 * 每个 input 类 ParamNode 对应作者在 ComfyUI 工作流里挑出的一个 widget。
 */
import type { ParamNode } from '../appStore'

type JsonSchema = Record<string, unknown>

/** 注入到每个 app 工具的公共入参（决策 #2：显式 seed + randomize_seed；M2：显式 seed 优先） */
const COMMON_INPUT_PARAMS: Record<string, JsonSchema> = {
  seed: {
    type: 'number',
    description: '随机种子。显式传入即生效；未传入时按 randomize_seed 自动随机。'
  },
  randomize_seed: {
    type: 'boolean',
    default: false,
    description:
      'false（默认）时显式 seed 生效；true 时强制覆盖为随机值，复刻 A UI 现有强制随机行为。'
  }
}

function paramNodeToJsonSchema(node: ParamNode): JsonSchema {
  const widgetName = node.selectedWidget?.name ? `.${node.selectedWidget.name}` : ''
  const desc = node.description || `${node.name} (${node.type}${widgetName})`
  const opt = node.selectedWidget?.options
  switch (node.renderComponent) {
    case 'textarea':
      return { type: 'string', description: desc }
    case 'switch':
      return { type: 'boolean', description: desc }
    case 'input-number':
      return { type: 'number', description: desc }
    case 'slider':
      return {
        type: 'number',
        description: desc,
        ...(opt?.min != null && { minimum: opt.min }),
        ...(opt?.max != null && { maximum: opt.max }),
        ...(opt?.step != null && { multipleOf: opt.step })
      }
    case 'select':
      return { type: 'string', description: desc, ...(opt?.values?.length && { enum: opt.values }) }
    case 'image-uploader':
    case 'audio-uploader':
    case 'video-uploader':
      return { type: 'string', description: `${desc}（base64 data URL 或 http URL）` }
    default:
      return { type: 'string', description: desc }
  }
}

/** 由 app 的 input 参数 + 公共入参生成 MCP 工具 inputSchema */
export function buildAppToolInputSchema(paramsNodes: ParamNode[] = []): JsonSchema {
  const inputs = paramsNodes.filter((n) => n.category === 'input')
  const properties: Record<string, JsonSchema> = {}
  for (const n of inputs) {
    properties[n.name] = paramNodeToJsonSchema(n)
  }
  // 公共参数不覆盖 app 同名参数（L3：app 若显式暴露 seed，以其 schema 为准）
  for (const [k, v] of Object.entries(COMMON_INPUT_PARAMS)) {
    if (!(k in properties)) properties[k] = v
  }
  return { type: 'object', properties, additionalProperties: false }
}

/** MVP：output 简化为统一占位（完整阶段按 output paramsNode 声明 image/audio/video） */
export function buildAppToolOutputSchema(paramsNodes: ParamNode[] = []): JsonSchema | undefined {
  const outputs = paramsNodes.filter((n) => n.category === 'output')
  if (!outputs.length) return undefined
  return { type: 'object', description: '执行结果，含产物（图片/音频/视频）文件信息' }
}

/** 给 LLM 看的参数说明（get_app_details 工具用） */
export function describeParams(paramsNodes: ParamNode[] = []): Array<Record<string, unknown>> {
  return paramsNodes.map((n) => ({
    name: n.name,
    category: n.category,
    type: n.renderComponent || n.selectedWidget?.type || 'unknown',
    description: n.description || '',
    node: { id: n.id, type: n.type, widget: n.selectedWidget?.name }
  }))
}
