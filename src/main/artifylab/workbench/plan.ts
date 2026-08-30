/**
 * 工作台 PLAN 校验（workbench-plan.md Phase 1 步骤 3）。
 *
 * codex 产出的 PLAN 先过这里：模板存在性 → 参数类型/范围 → 模型已安装
 * （/object_info + 模型名比对）→ VRAM watchdog（/system_stats）。
 * 校验失败返回可读错误，由编排层打回 codex 重试（≤2 次）。
 */
import type { ComfyPrompt } from '../appStore'
import type { WorkflowTemplate } from './templateCore'
import { checkNodeOverrides, looksLikeMediaValue, looksLikeTextBlob } from '../mcp/executor'
import { logger } from '../utils/logger'

/** codex 决策输出的结构化执行计划 */
export interface WorkbenchPlan {
  intent: 'image' | 'video' | 'audio' | 'text' | 'chat' | 'memory' | 'workflow' | 'canvas-run'
  /** intent=chat/text/memory 时直接回复用户；执行意图必须带模板与参数 */
  reply?: string
  /**
   * intent=memory 时的记忆操作:dsh 长期记忆语义。
   * remember=写入/更新(按 key 幂等),forget=按 key 删除
   */
  memory?: {
    action: 'remember' | 'forget'
    /** 记忆键(短标签,如 preferred-style / negative-prompt / hardware) */
    key: string
    /** action=remember 时的内容(一句话,≤500 字) */
    value?: string
  }
  templateId?: string
  params?: Record<string, unknown>
  /**
   * 复合意图（生成 + 画布加载）：intent=image/video/audio 时置 true，
   * 系统先加载模板布局到画布（有 workflow 直接用，无则 prompt 兜底转换），
   * 再执行模板生成。对应「用 XX 模板生成图片，工作流加载到画布中」。
   */
  syncCanvasBeforeExec?: boolean
  /**
   * 节点级参数覆盖（P1 能力）：按 prompt 节点 id 覆盖任意节点的 widget 值
   * （如 KSampler 的 steps/cfg），不限于 paramsNodes 声明的 input。
   * class_type 用于防串号；widgetOverrides 只接受"直接值"字段，链接引用
   * （["nodeId", slot]）字段拒绝直写。校验走 /object_info 的 widget schema。
   */
  nodeOverrides?: Record<
    string,
    {
      class_type?: string
      widgetOverrides?: Record<string, unknown>
    }
  >
  /** 会话内链式：引用上一次执行的产物（图→视频） */
  usePreviousOutput?: boolean
  reason?: string // codex 解释（展示给用户）
  /** P2e：首条消息时可带的会话标题（≤20 字，用户手改过不覆盖） */
  title?: string
  /**
   * 批量编排：items 数据行 + 每行差异参数。存在时走 batchRunner 队列
   * （串行执行，进度经既有 batch 轮询通道），而非单次 executeApp。
   * 每行 item 的键 = params 的参数名（覆盖同名默认值）。
   */
  batch?: {
    items: Array<Record<string, unknown>>
    /** 可选:全批次共享的 prompt 变体（如统一风格词），逐行覆盖 */
    sharedParams?: Record<string, unknown>
  }
}

export interface PlanValidationIssue {
  field: string
  message: string
}

export interface PlanValidationResult {
  ok: boolean
  issues: PlanValidationIssue[]
  template?: WorkflowTemplate
}

/** fetch 带超时（与 executor 一致的容错） */
function fetchTimeout(url: string, ms = 15000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/** 参数基础校验：类型 + 数值范围（对照 selectedWidget.options） */
function validateParams(
  template: WorkflowTemplate,
  params: Record<string, unknown>
): PlanValidationIssue[] {
  const issues: PlanValidationIssue[] = []
  const inputs = template.paramsNodes.filter((n) => n.category === 'input')
  for (const [k, v] of Object.entries(params)) {
    const node = inputs.find((n) => n.name === k)
    if (!node) {
      // 未知参数：宽松处理（executor 会忽略无法映射的），但记 issue 供 codex 修正
      issues.push({ field: `params.${k}`, message: '未知参数（模板未声明）' })
      continue
    }
    const widgetType = node.selectedWidget?.type
    // 媒体参数（renderComponent 为 image/video/audio-uploader）：值只能是
    // data:/http(s) URL 或「素材文件名/路径」形态，绝不能是描述文本。否则
    // 中文提示词会被原样写进 LoadImageFromPath 的 image 槽 → No such file。
    // 此校验在 executor 提交前拦截，模型恢复轮能立即看到明确问题。
    const rc = String(node.renderComponent ?? '').toLowerCase()
    if (rc.includes('uploader') && typeof v === 'string') {
      // 媒体值判定与 executor 同源（looksLikeMediaValue / looksLikeTextBlob）
      if (!looksLikeMediaValue(v)) {
        const hint = looksLikeTextBlob(v)
          ? `收到文本描述（含中文或长文本），但该参数是 ${node.renderComponent ?? '媒体上传'}，只能传已上传素材的文件名或 data:/http(s) URL`
          : `该参数是 ${node.renderComponent ?? '媒体上传'}，只能传素材文件名或 data:/http(s) URL`
        issues.push({ field: `params.${k}`, message: hint })
        continue
      }
    } else if (widgetType === 'number' || widgetType === 'float' || widgetType === 'int') {
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        issues.push({ field: `params.${k}`, message: `期望数字，得到 ${typeof v}` })
        continue
      }
      const { min, max } = node.selectedWidget?.options ?? {}
      if (min != null && v < min)
        issues.push({ field: `params.${k}`, message: `小于最小值 ${min}` })
      if (max != null && v > max)
        issues.push({ field: `params.${k}`, message: `大于最大值 ${max}` })
    } else if (widgetType === 'boolean') {
      if (typeof v !== 'boolean')
        issues.push({ field: `params.${k}`, message: `期望布尔，得到 ${typeof v}` })
    } else if (Array.isArray(node.selectedWidget?.options?.values)) {
      const values = node.selectedWidget.options.values.map(String)
      if (!values.includes(String(v)))
        issues.push({ field: `params.${k}`, message: `不在可选值内: ${values.join('/')}` })
    } else if (typeof v !== 'string') {
      // 其余 widget（text/combo 无 options 等）宽松：可字符串化的都收
      if (v !== null && typeof v !== 'object') continue // number 也放行（executor 会原样填 widget）
      issues.push({ field: `params.${k}`, message: `期望字符串，得到 ${typeof v}` })
    }
  }
  // 必填参数提醒（有 description 无默认值的输入参数未提供 → 提示 codex，不阻断）
  return issues
}

/** 对 live ComfyUI /object_info 校验节点图（官方 validate_workflow 思路） */
export async function validateAgainstObjectInfo(
  comfyOrigin: string,
  prompt: ComfyPrompt
): Promise<PlanValidationIssue[]> {
  try {
    const res = await fetchTimeout(`${comfyOrigin}/object_info`)
    if (!res.ok) return []
    const info = (await res.json()) as Record<string, unknown>
    const issues: PlanValidationIssue[] = []
    for (const [nodeId, node] of Object.entries(prompt)) {
      if (!(node.class_type in info)) {
        issues.push({
          field: `workflow.${nodeId}`,
          message: `节点类型不存在: ${node.class_type}（自定义节点未安装？）`
        })
      }
    }
    return issues
  } catch (e) {
    // ComfyUI 未启动等：不阻断（执行时 executor 会给出真实错误）
    logger.warn('workbench object_info check failed', e)
    return []
  }
}

/**
 * 节点覆盖的本地校验（同步、不发网络）：节点存在 → class_type 匹配 →
 * 字段存在 → 非链接引用 → 值可序列化。
 * 规则实现统一走 executor.checkNodeOverrides（单一事实源）——校验层与
 * 执行端 applyNodeOverrides 天然同规则，不再靠注释纪律双写。
 */
export function validateNodeOverridesLocal(
  prompt: ComfyPrompt,
  nodeOverrides?: Record<string, { class_type?: string; widgetOverrides?: Record<string, unknown> }>
): PlanValidationIssue[] {
  return checkNodeOverrides(prompt, nodeOverrides)
}

/** /object_info 的节点输入 schema（widget 定义）。workbenchTools 等处共用。 */
export interface ObjectInfoNode {
  input?: {
    required?: Record<string, [unknown, Record<string, unknown>?] | [unknown]>
  }
}

/**
 * 节点覆盖的网络校验（/object_info widget schema）：
 * 类型（INT/FLOAT/STRING/BOOLEAN/COMBO）+ 枚举（COMBO values）+ 范围（min/max）。
 * ComfyUI 不可达时降级放行（执行时 executor 会给出真实错误）。
 */
export async function validateNodeOverrides(
  comfyOrigin: string,
  prompt: ComfyPrompt,
  nodeOverrides?: Record<string, { class_type?: string; widgetOverrides?: Record<string, unknown> }>
): Promise<PlanValidationIssue[]> {
  if (!nodeOverrides) return []
  const issues: PlanValidationIssue[] = []
  try {
    const res = await fetchTimeout(`${comfyOrigin}/object_info`)
    if (!res.ok) return []
    const info = (await res.json()) as Record<string, ObjectInfoNode>
    for (const [nodeId, cfg] of Object.entries(nodeOverrides)) {
      const node = prompt[nodeId]
      if (!node || !cfg.widgetOverrides) continue
      const schema = info[node.class_type]?.input?.required ?? {}
      for (const [k, v] of Object.entries(cfg.widgetOverrides)) {
        const spec = schema[k]
        if (!spec || !Array.isArray(spec)) {
          issues.push({
            field: `nodeOverrides.${nodeId}.${k}`,
            message: `/object_info 未声明节点 ${node.class_type} 的输入 ${k}`
          })
          continue
        }
        const meta = (spec[1] ?? {}) as { min?: number; max?: number; options?: unknown }
        const combo = spec[0]
        if (Array.isArray(combo)) {
          // COMBO：枚举校验
          const values = combo.map(String)
          if (!values.includes(String(v))) {
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `枚举不匹配：${node.class_type}.${k} 可选 ${values.join('/')}，得到 ${String(v)}`
            })
          }
          continue
        }
        const t = String(combo)
        if (t === 'INT' || t === 'FLOAT' || t === 'NUMBER') {
          if (typeof v !== 'number' || !Number.isFinite(v)) {
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `${node.class_type}.${k} 期望数字，得到 ${typeof v}`
            })
            continue
          }
          if (meta.min != null && v < meta.min)
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `${node.class_type}.${k} 小于最小值 ${meta.min}`
            })
          if (meta.max != null && v > meta.max)
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `${node.class_type}.${k} 大于最大值 ${meta.max}`
            })
        } else if (t === 'BOOLEAN') {
          if (typeof v !== 'boolean')
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `${node.class_type}.${k} 期望布尔，得到 ${typeof v}`
            })
        } else if (t !== 'STRING' && t !== 'TEXT' && typeof v !== 'string') {
          // 其余字符串类宽松（数字可字符串化）
          if (v !== null && typeof v !== 'number')
            issues.push({
              field: `nodeOverrides.${nodeId}.${k}`,
              message: `${node.class_type}.${k} 期望字符串，得到 ${typeof v}`
            })
        }
      }
    }
    return issues
  } catch (e) {
    logger.warn('workbench node overrides object_info check failed', e)
    return []
  }
}

/** 模型文件探测：/object_info 里 loader 节点的可选值含模型名即视为已安装 */
export async function validateModels(
  comfyOrigin: string,
  template: WorkflowTemplate
): Promise<PlanValidationIssue[]> {
  const required = template.requiredModels ?? []
  if (required.length === 0) return []
  try {
    const res = await fetchTimeout(`${comfyOrigin}/object_info`)
    if (!res.ok) return []
    const info = (await res.json()) as Record<
      string,
      { input?: { required?: Record<string, unknown> } }
    >
    const issues: PlanValidationIssue[] = []
    for (const model of required) {
      const base = model.split('/').pop() ?? model
      // 任意 loader 节点的任意枚举入参里能找到该模型名 → 已安装
      const installed = Object.values(info).some((node) => {
        const req = node.input?.required ?? {}
        return Object.values(req).some((spec) => {
          if (!Array.isArray(spec)) return false
          // combo 形如 [["model_a.safetensors", ...], {tooltip}]
          const combo = spec[0]
          return Array.isArray(combo) && combo.some((v) => String(v) === base)
        })
      })
      if (!installed) {
        issues.push({
          field: 'models',
          message: `模型未安装: ${model}（请先在模型管理中下载）`
        })
      }
    }
    return issues
  } catch {
    return [] // ComfyUI 不可达时不阻断
  }
}

/** VRAM watchdog（抄 artokun hook）：空闲 <1GB 拦截（可被 force 跳过） */
export async function checkVram(
  comfyOrigin: string,
  force = false
): Promise<PlanValidationIssue[]> {
  if (force) return []
  try {
    const res = await fetchTimeout(`${comfyOrigin}/system_stats`, 8000)
    if (!res.ok) return []
    const stats = (await res.json()) as {
      devices?: Array<{ vram_free?: number }>
    }
    const free = stats.devices?.[0]?.vram_free
    if (typeof free === 'number' && free < 1024 * 1024 * 1024) {
      return [
        {
          field: 'vram',
          message: `显存空闲仅 ${(free / 1024 / 1024 / 1024).toFixed(1)}GB（<1GB），执行可能 OOM。可在 ComfyUI 中释放显存后重试，或强制执行。`
        }
      ]
    }
    return []
  } catch {
    return []
  }
}

/** PLAN 主校验入口（本地部分，不发网络请求） */
export function validatePlanLocal(
  plan: WorkbenchPlan,
  templates: WorkflowTemplate[]
): PlanValidationResult {
  const issues: PlanValidationIssue[] = []
  if (plan.intent === 'chat') {
    if (!plan.reply || !plan.reply.trim()) {
      issues.push({ field: 'reply', message: 'chat 意图必须带 reply' })
    }
    return { ok: issues.length === 0, issues }
  }
  if (plan.intent === 'memory') {
    if (!plan.memory) {
      issues.push({ field: 'memory', message: 'memory 意图必须带 memory 操作' })
    } else {
      if (plan.memory.action !== 'remember' && plan.memory.action !== 'forget')
        issues.push({ field: 'memory.action', message: 'action 只能是 remember 或 forget' })
      if (!plan.memory.key || !plan.memory.key.trim())
        issues.push({ field: 'memory.key', message: '必须带记忆 key（短标签）' })
      if (plan.memory.action === 'remember' && !plan.memory.value?.trim())
        issues.push({ field: 'memory.value', message: 'remember 必须带 value' })
      if ((plan.memory.value ?? '').length > 500)
        issues.push({ field: 'memory.value', message: 'value 超 500 字' })
    }
    return { ok: issues.length === 0, issues }
  }
  if (plan.intent === 'text') {
    // 文本意图走 ai.ts，无需模板
    if (!plan.reply) issues.push({ field: 'reply', message: 'text 意图暂以 reply 承载文本结果' })
    return { ok: issues.length === 0, issues }
  }
  if (plan.intent === 'workflow') {
    // 同步工作流到画布：必须指定模板（取其 UI graph workflow）
    if (!plan.templateId) {
      issues.push({ field: 'templateId', message: 'workflow 意图必须指定 templateId' })
      return { ok: false, issues }
    }
    const template = templates.find((t) => t.id === plan.templateId)
    if (!template) {
      issues.push({ field: 'templateId', message: `模板不存在: ${plan.templateId}` })
      return { ok: false, issues }
    }
    return { ok: true, issues, template }
  }
  if (plan.intent === 'canvas-run') {
    // 执行画布当前工作流：图在宿主（ComfyUI），服务端拿不到——不校验模板；
    // nodeOverrides（按节点 id 覆盖 widget）与 batch 都是对画布图的变体，
    // 无法离线校验（无画布 prompt），宽松放行，执行端给真实错误。
    if (plan.batch) {
      const n = plan.batch.items?.length ?? 0
      if (n < 2) issues.push({ field: 'batch', message: 'batch.items 至少 2 行' })
      if (n > 200) issues.push({ field: 'batch', message: 'batch.items 上限 200 行' })
      if (!Array.isArray(plan.batch.items))
        issues.push({ field: 'batch', message: 'batch.items 必须是数组' })
    }
    return { ok: issues.length === 0, issues }
  }
  // image/video/audio：必须有模板
  if (!plan.templateId) {
    issues.push({ field: 'templateId', message: `${plan.intent} 意图必须指定 templateId` })
    return { ok: false, issues }
  }
  const template = templates.find((t) => t.id === plan.templateId)
  if (!template) {
    issues.push({ field: 'templateId', message: `模板不存在: ${plan.templateId}` })
    return { ok: false, issues }
  }
  if (plan.params) issues.push(...validateParams(template, plan.params))
  // 节点级覆盖本地校验（节点存在/类型匹配/字段存在/非链接）；网络侧
  // （/object_info 类型/枚举/范围）由编排层在 validateRemote 阶段补验。
  if (plan.nodeOverrides)
    issues.push(...validateNodeOverridesLocal(template.prompt, plan.nodeOverrides))
  // batch:2~200 行;每行必须是对象;items 行键应与模板参数有交集(纯噪音行直接拒)
  if (plan.batch) {
    const n = plan.batch.items?.length ?? 0
    if (n < 2)
      issues.push({ field: 'batch', message: 'batch.items 至少 2 行（单次执行不需要批量）' })
    if (n > 200) issues.push({ field: 'batch', message: 'batch.items 上限 200 行，请分批' })
    if (plan.batch.sharedParams) {
      issues.push(
        ...validateParams(template, plan.batch.sharedParams).map((i) => ({
          ...i,
          field: `batch.${i.field}`
        }))
      )
    }
  }
  return { ok: issues.length === 0, issues, template }
}

/**
 * 从 codex 原始输出中提取 PLAN。
 * 兼容两种形态：
 * 1. 结构化 ThreadEvent NDJSON（responses 协议经代理/网关时）——取最后一条
 *    item.completed 的 agent_message.text 再提 JSON；
 * 2. 模型原生文本输出（text-delta 流）——整体找首个可解析的 {...}。
 */
export function parsePlanFromCodexText(raw: string): WorkbenchPlan | null {
  for (const line of raw.split('\n').reverse()) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const evt = JSON.parse(trimmed) as {
        type?: string
        item?: { type?: string; text?: unknown }
      }
      if (evt.type === 'item.completed' && evt.item?.type === 'agent_message') {
        const text = typeof evt.item.text === 'string' ? evt.item.text : ''
        const plan = extractPlanJson(text)
        if (plan) return plan
      }
    } catch {
      /* 非 NDJSON 形态的行忽略 */
    }
  }
  return extractPlanJson(raw)
}

/** 从纯文本中提取首个可解析且含 intent 字段的 PLAN JSON 对象 */
function extractPlanJson(text: string): WorkbenchPlan | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return null
  try {
    const obj = JSON.parse(text.slice(start, end + 1)) as WorkbenchPlan
    if (!obj || typeof obj !== 'object' || !('intent' in obj)) return null
    return obj
  } catch {
    return null
  }
}
