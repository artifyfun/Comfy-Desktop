/**
 * canvas.debug 错误分类器（M4 调试路由第一步）。
 *
 * 输入是执行失败时已掌握的全部信号：
 * - error：extractExecutionError 产出的可读摘要（"KSampler #16: …"）或 400 原文
 * - nodeErrors：ComfyUI /prompt 400 响应的 node_errors 对象（提交期校验失败）
 * - nodeType/nodeId：execution_error 事件的定位字段
 *
 * 输出是结构化诊断：category + severity + 定位 + 修复建议。
 * 建议分两种：
 * - param_fix 且能推导出具体值 → fixOps（走 M2 既有 setWidget 确认通道一键修）
 * - 其余只给 text 指引（缺模型下载/重连/登录是重操作或不可自动修，绝不静默改动）
 *
 * 分类顺序即优先级：提交期 node_errors 最精确（有节点+输入名），先看它；
 * 再匹配 exception 文本关键词；都没命中 → unknown（原文透传，不乱建议）。
 */

export type ErrorCategory =
  | 'missing_model' // 缺模型（ckpt/lora/vae/unet 等不在已装列表）
  | 'bad_param' // 参数越界/非法枚举值
  | 'broken_graph' // 结构坏：缺输入/类型不匹配/无输出
  | 'oom' // 显存不足
  | 'auth' // 节点要求登录/API key
  | 'unknown'

export type SuggestionKind = 'param_fix' | 'download_model' | 'graph_fix' | 'manual'

export interface FixOp {
  type: 'setWidget'
  nodeId: string
  widget: string
  value: unknown
}

export interface ErrorSuggestion {
  kind: SuggestionKind
  text: string
  /** 可一键应用的 M2 白名单 ops（仅 param_fix 且能推导出合法值时给出） */
  fixOps?: FixOp[]
}

/** 诊断结果里的建议（别名保持命名清晰） */
type Suggestion = ErrorSuggestion

export interface ClassifiedError {
  category: ErrorCategory
  severity: 'blocking' | 'warning'
  message: string
  nodeType?: string
  nodeId?: string
  modelName?: string
  inputName?: string
  suggestion: ErrorSuggestion
}

export interface ErrorInput {
  error?: string
  nodeErrors?: Record<
    string,
    {
      errors?: Array<{
        type?: string
        message?: string
        details?: string
        extra_info?: { input_name?: string }
      }>
      class_type?: string
    }
  >
  nodeType?: string
  nodeId?: string
}

/** 模型类输入名/文件后缀：value_not_in_list 命中即缺模型 */
const MODEL_INPUT_RE =
  /ckpt|checkpoint|lora|vae|unet|clip_\d|control_net|upscale_model|style_model/i
const MODEL_FILE_RE = /\.(safetensors|ckpt|pt|gguf|bin|sft)$/i
/** 从 details 里抽 'xxx.safetensors' 或 'xxx.ckpt' 模型文件名 */
const MODEL_NAME_RE = /['"]([\w./-]+\.(?:safetensors|ckpt|pt|gguf|bin|sft))['"]/i

/** 从 "InputName: 'bad_value' not in ['a', 'b']" 抽输入名/坏值/合法清单 */
const NOT_IN_LIST_RE = /(\w+)\s*:\s*['"]([^'"]*)['"]\s*not in \[(.*)\]/i

/** 参数类错误的可自动修：只有能从合法清单推断出具体值才给 fixOps */
function buildParamFix(
  nodeId: string,
  classType: string | undefined,
  inputName: string,
  details: string
): { suggestion: Suggestion; inputName: string } {
  const m = NOT_IN_LIST_RE.exec(details)
  if (m && m[1] && m[2] !== undefined && m[3] !== undefined) {
    const name = m[1]
    const badValue = m[2]
    const options = m[3]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    // 推荐合法清单第一项（ComfyUI 枚举首项通常是默认值）
    const fix = options[0]
    const ops: FixOp[] =
      fix !== undefined ? [{ type: 'setWidget', nodeId, widget: name, value: fix }] : []
    return {
      inputName: name,
      suggestion: {
        kind: 'param_fix',
        text: `参数 ${name} 的值「${badValue}」不在可选列表中（节点 ${classType ?? nodeId}）。${
          ops.length ? `可改为「${fix}」后重跑。` : `可选：${options.slice(0, 8).join('、')}。`
        }`,
        fixOps: ops.length ? ops : undefined
      }
    }
  }
  const inputMatch = /(\w+)\s*:/.exec(details)
  const name = inputName || (inputMatch?.[1] ?? '')
  return {
    inputName: name,
    suggestion: {
      kind: 'param_fix',
      text: `参数${name ? ` ${name}` : ''}取值越界（${details}）。请修正后重跑。`
    }
  }
}

export function classifyExecutionError(input: ErrorInput): ClassifiedError {
  const errorText = input.error ?? ''
  const nodeType = input.nodeType
  const nodeId = input.nodeId

  // ---- 1. 提交期 node_errors：结构最精确，优先 ----
  const firstNode = Object.entries(input.nodeErrors ?? {})[0]
  if (firstNode) {
    const [nid, node] = firstNode
    const firstErr = (node.errors ?? [])[0]
    if (firstErr) {
      const details = firstErr.details ?? ''
      const inputName = firstErr.extra_info?.input_name
      const classType = node.class_type
      const location = {
        nodeType: classType,
        nodeId: nid,
        inputName
      }
      if (firstErr.type === 'value_not_in_list') {
        const isModel = MODEL_INPUT_RE.test(inputName ?? '') || MODEL_FILE_RE.test(details)
        if (isModel) {
          const modelName = MODEL_NAME_RE.exec(details)?.[1]
          return {
            category: 'missing_model',
            severity: 'blocking',
            message: details || firstErr.message || errorText,
            ...location,
            modelName,
            suggestion: {
              kind: 'download_model',
              text: `缺少模型${modelName ? `「${modelName}」` : ''}（节点 ${classType ?? nid} 的 ${inputName}）。请在模型管理中下载后重试；该步骤不可自动执行。`
            }
          }
        }
        const { suggestion, inputName: name } = buildParamFix(
          nid,
          classType,
          inputName ?? '',
          details
        )
        return {
          category: 'bad_param',
          severity: 'blocking',
          message: details || firstErr.message || errorText,
          ...location,
          inputName: name,
          suggestion
        }
      }
      if (
        firstErr.type === 'required_input_missing' ||
        firstErr.type === 'return_type_mismatch' ||
        firstErr.type === 'custom_validation_failed'
      ) {
        // custom_validation_failed 可能是参数语义错（如图名不存在），也可能是节点内部校验——
        // 归 broken_graph 但消息保留 details 供 LLM/用户判断
        return {
          category: 'broken_graph',
          severity: 'blocking',
          message: details || firstErr.message || errorText,
          ...location,
          suggestion: {
            kind: 'graph_fix',
            text: `节点 ${classType ?? nid} 的${inputName ? `输入 ${inputName}` : '输入连接'}无效：${details}。请检查画布连线或输入值后重试。`
          }
        }
      }
      if (firstErr.type === 'out_of_range') {
        const { suggestion, inputName: name } = buildParamFix(
          nid,
          classType,
          inputName ?? '',
          details
        )
        return {
          category: 'bad_param',
          severity: 'blocking',
          message: details || firstErr.message || errorText,
          ...location,
          inputName: name,
          suggestion
        }
      }
    }
  }

  // ---- 2. 文本关键词：execution_error 事件摘要 ----
  const loc = { nodeType, nodeId }

  if (/out of memory|unable to allocate|cuda error|metal error.*memory/i.test(errorText)) {
    return {
      category: 'oom',
      severity: 'blocking',
      message: errorText,
      ...loc,
      suggestion: {
        kind: 'param_fix',
        text: '显存不足。建议降低分辨率/批量大小，或换更小的模型后重跑。'
      }
    }
  }
  if (/unauthorized|please login|api[_ ]?key|forbidden|403/i.test(errorText)) {
    return {
      category: 'auth',
      severity: 'blocking',
      message: errorText,
      ...loc,
      suggestion: {
        kind: 'manual',
        text: '该节点需要登录或 API key（如自定义节点的外部服务）。请先在节点对应服务完成登录/配置后重试。'
      }
    }
  }
  if (/not in list|not in \[|invalid (seed|value)|out of range/i.test(errorText)) {
    return {
      category: 'bad_param',
      severity: 'blocking',
      message: errorText,
      ...loc,
      suggestion: {
        kind: 'param_fix',
        text: '参数取值非法。请对照节点 schema 修正后重跑。'
      }
    }
  }
  if (
    /required input.*missing|return type mismatch|prompt has no outputs|invalid connections/i.test(
      errorText
    )
  ) {
    return {
      category: 'broken_graph',
      severity: 'blocking',
      message: errorText,
      ...loc,
      suggestion: {
        kind: 'graph_fix',
        text: '工作流结构不完整（缺输入连接或无输出节点）。请在画布补全连线后重试。'
      }
    }
  }

  // ---- 3. 兜底：unknown，原文透传 ----
  return {
    category: 'unknown',
    severity: 'blocking',
    message: errorText,
    ...loc,
    suggestion: {
      kind: 'manual',
      text: errorText
        ? `未识别的错误类型，原始信息：${errorText}`
        : '未知错误，请查看 ComfyUI 日志获取详情。'
    }
  }
}
