/**
 * 工作台 MCP 工具（decide agent 的编排抓手，dsh 同款"agent 带工具自主跑"语义）。
 *
 * 与 mcp/tools.ts（外部 MCP 客户端驱动 app）并列：这一组工具只服务 decide
 * 链路 —— codex 在决策轮内自主调用，把"研究→生成→再生成→写文案"这类多步
 * 需求编排成真实执行，而不是让模型一次吐一个 JSON PLAN 猜全场。
 *
 * 安全边界：
 * - execute 前强制 validatePlanLocal（与 decide 快路径同一套白名单校验），
 *   codex 拿不到裸执行权；
 * - 会话归属由 decideSessions 注册表限定（工具只在 decide 轮内可用；C7 起按
 *   请求身份精确路由，多会话并行不串号）；
 * - 记忆工具同 workbench memory intent 语义（key 幂等，≤500 字）。
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import {
  validateNodeOverrides,
  validateNodeOverridesLocal,
  validatePlanLocal,
  validateAgainstObjectInfo,
  type ObjectInfoNode,
  type WorkbenchPlan,
  type PlanValidationIssue
} from '../workbench/plan'
import { workbenchService } from '../workbench/service'
import { listBatchQueue, type BatchJobSummary } from '../services/batchRunner'
import { inferFirstMediaSlot } from './executor'
import type { ComfyPrompt, ParamNode } from '../appStore'
import appStoreManager from '../appStore'
import type { ToolRegistry } from './tools'

/**
 * 当前 decide 会话上下文注册表（C7 多会话并行）。
 *
 * 旧实现是模块级单例 currentDecideSession：两个会话并行 decide 时 begin/end
 * 相互覆盖，wb_* 工具经 HTTP 回环 /mcp 时全部落在最先 begin 的会话上（串号）。
 * 现改为 Set<sessionId> 注册表：begin/end 签名不变（嵌套保护语义由「end 只删
 * 自己」继承），工具调用按请求身份精确路由到所属会话。
 */
const decideSessions = new Set<string>()

/** decide 入口置位（嵌套保护：各会话独立入册，互不覆盖） */
export function beginWorkbenchToolContext(sessionId: string): void {
  const session = workbenchService.getSession(sessionId)
  if (!session) throw new Error(`session not found: ${sessionId}`)
  decideSessions.add(sessionId)
}

/** decide 结束清位（只清本会话，其余并行会话不受影响） */
export function endWorkbenchToolContext(sessionId: string): void {
  decideSessions.delete(sessionId)
}

/** 仅测试可见：当前在册 decide 会话数（验证多会话并发注册） */
export function decideContextSizeForTest(): number {
  return decideSessions.size
}

/**
 * 只读窥探当前工具会话（不解析 URL，供 service 的画布同步派发路由）。
 * 返回注册表中最早 begin 的会话 id；无活动 decide 时返回 null。
 */
export function peekWorkbenchToolSession(): string | null {
  if (decideSessions.size === 0) return null
  return decideSessions.values().next().value!
}

const WORKBENCH_SESSION_HEADER = 'x-workbench-session'
const WORKBENCH_SESSION_QUERY = 'wb_session'

/**
 * 从工具请求身份解析 decide 会话（C7）。优先级：X-Workbench-Session header >
 * URL query（wb_session）。返回 null 表示请求未携带会话身份。
 *
 * 这是「接收侧接线面」的纯函数镜像：codex 引擎（0.149.x RawMcpServerConfig
 * 支持 http_headers）目前把会话身份写进每会话 MCP server 的 URL query；
 * 若未来 mcp/index.ts（接收侧）接通 header 透传，同一函数直接吃 req.headers。
 */
export function resolveWorkbenchSessionFromRequest(
  headers?: Record<string, unknown>,
  url?: string
): string | null {
  const headerVal = headers?.[WORKBENCH_SESSION_HEADER]
  const headerSid = Array.isArray(headerVal)
    ? String(headerVal[0] ?? '')
    : headerVal != null
      ? String(headerVal)
      : ''
  if (headerSid) return headerSid
  if (url) {
    try {
      // 审查修复 C-1A:express req.originalUrl 是路径相对形式("/mcp?wb_session=x"),
      // new URL(相对) 无 base 抛 ERR_INVALID_URL 被 catch 静默吞掉 → query 身份
      // 通道死代码(生产从未生效,仅 header 通道兜住)。补 base 后两通道都活。
      const q = new URL(url, 'http://localhost').searchParams.get(WORKBENCH_SESSION_QUERY)
      if (q) return q
    } catch {
      /* 非法 URL：按无会话身份处理 */
    }
  }
  return null
}

/**
 * 解析本次工具调用归属的 decide 会话。
 * - 带身份（MCP URL 或会话 id 字面量）：精确路由；会话未在 decide 中 → 拒绝
 *   （外部客户端带伪造身份调用被同一道门挡下）。
 * - 无身份：回退旧单槽语义——最外层（最先 begin）的 decide 会话，行为与
 *   C7 之前逐字节一致。
 */
function requireSession(identity?: string): string {
  if (identity) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(identity)
    const sid = isUrl ? resolveWorkbenchSessionFromRequest(undefined, identity) : identity
    if (sid && decideSessions.has(sid)) return sid
    throw new Error('workbench tool called outside decide session')
  }
  if (decideSessions.size === 0) throw new Error('workbench tool called outside decide session')
  return decideSessions.values().next().value!
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/** wb_execute_template 参数 → WorkbenchPlan（与 decide 快路径同构，命名 snake_case 亲和 MCP） */
function toPlan(args: Record<string, unknown>): WorkbenchPlan {
  const intent = String(args.intent ?? 'image') as WorkbenchPlan['intent']
  // 批量编排：batch_items = 数据行数组；batch_shared_params = 全行共享参数。
  // 行键 = 模板参数名（executeBatch 会按 paramsNodes 过滤未知键并告警）。
  let batch: WorkbenchPlan['batch']
  if (Array.isArray(args.batch_items) && args.batch_items.length > 0) {
    batch = {
      items: args.batch_items as Array<Record<string, unknown>>,
      sharedParams: (args.batch_shared_params as Record<string, unknown>) ?? undefined
    }
  }
  return {
    intent,
    templateId: args.template_id ? String(args.template_id) : undefined,
    params: (args.params as Record<string, unknown>) ?? {},
    usePreviousOutput: Boolean(args.use_previous_output),
    nodeOverrides: args.node_overrides as WorkbenchPlan['nodeOverrides'],
    batch,
    reason: args.reason ? String(args.reason) : undefined
  }
}

/** wait=true 轮询到终态（wb_execute_template / wb_run_workflow 共用） */
async function pollUntilDone(
  sessionId: string,
  promptId: string
): Promise<{
  ok: boolean
  stage: string
  prompt_id: string
  outputs?: unknown
  outputs_text?: string
  error?: string
}> {
  const deadline = Date.now() + 10 * 60 * 1000
  for (;;) {
    const r = await workbenchService.pollExecution(sessionId, promptId)
    if (r.status === 'success') {
      return {
        ok: true,
        stage: 'completed',
        prompt_id: promptId,
        outputs: r.outputs,
        outputs_text: r.outputsText.slice(0, 2000)
      }
    }
    if (r.status === 'error') {
      return { ok: false, stage: 'failed', prompt_id: promptId, error: r.error }
    }
    if (Date.now() > deadline) {
      return {
        ok: false,
        stage: 'timeout',
        prompt_id: promptId,
        error: '10min 超时，可用 wb_poll_execution 稍后再查'
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

/**
 * 批量任务轮询到终态（completed/stopped/failed）。批量可能上百行，
 * 单行快任务也至少 2s 间隔，deadline 放宽到 60min；超时不失败——
 * 任务仍在队列里继续跑，返回当前快照让 LLM 告知用户稍后查看。
 */
async function pollBatchUntilDone(jobId: string): Promise<BatchJobSummary> {
  const deadline = Date.now() + 60 * 60 * 1000
  for (;;) {
    const job = listBatchQueue().find((j) => j.id === jobId)
    if (!job) {
      // 队列被清（clear/delete）——返回空壳避免无限等
      return {
        id: jobId,
        status: 'stopped',
        total: 0,
        processed: 0,
        success: 0,
        failed: 0,
        percent: 0,
        currentIndex: 0,
        currentPreview: '',
        createdAt: '',
        updatedAt: '',
        logs: [],
        results: []
      }
    }
    if (['completed', 'stopped', 'failed'].includes(job.status) || Date.now() > deadline) {
      return job
    }
    await new Promise((resolve) => setTimeout(resolve, 3000))
  }
}

/** wb_* 工具函数签名：第二参为「请求身份」（每会话 MCP 配置注入的 URL 或会话
 * id 字面量），requireSession 据此做会话路由（C7）。tools.ts 的 ToolHandler
 * 不含身份参（其文件本组件不触碰），故在此独立声明。 */
type WBToolFn = (args: Record<string, unknown>, identity?: string) => Promise<unknown>

import {
  searchModelKnowledge,
  modelKnowledgeDetail,
  searchCivitaiModels
} from '../workbench/modelKnowledge'

const WB_TOOLS: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_list_templates',
      description:
        '列出工作台模板库（生成类技能）。返回 id/name/mediaType/chainable/参数 schema。多步编排前先看这里选模板。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    fn: async (_args, identity) => {
      const sessionId = requireSession(identity)
      return text(
        workbenchService.listTemplates(sessionId).map((t) => ({
          id: t.id,
          name: t.name,
          description: t.description,
          mediaType: t.mediaType,
          chainable: t.chainable ?? false,
          params: t.paramsNodes
            .filter((p) => p.category === 'input')
            .map((p) => ({
              name: p.name,
              type: p.selectedWidget?.type ?? p.type,
              widget: p.selectedWidget?.name,
              // rc=*-uploader → 素材文件槽（只能传文件名或 data:/http URL，
              // 不能传提示词文本）；textarea/select/slider/number → 文本/枚举/数值
              rc: p.renderComponent ?? null,
              options: p.selectedWidget?.options
            }))
        }))
      )
    }
  },
  {
    tool: {
      name: 'wb_execute_template',
      description:
        '执行一个工作台模板（图/视频/音频生成）。校验→提交 ComfyUI→立即返回 prompt_id 与 execution_id；用 wb_poll_execution 轮询产物。use_previous_output=true 时自动把本会话上一次产物填入媒体输入位（图→视频链式）。多步需求请逐步调用本工具（生成→拿产物→下一步引用）。',
      inputSchema: {
        type: 'object',
        properties: {
          intent: {
            type: 'string',
            enum: ['image', 'video', 'audio'],
            description: '生成意图（决定校验口径）'
          },
          template_id: {
            type: 'string',
            description: '模板 id（wb_list_templates 里查；会话变体 id 也可）'
          },
          params: {
            type: 'object',
            description: '模板参数（键=参数名；仅写与默认值不同的键）',
            additionalProperties: true
          },
          node_overrides: {
            type: 'object',
            description:
              '节点级参数覆盖：{"节点id": {"class_type": "KSampler", "widgetOverrides": {"steps": 40}}}。只改直接值字段，链接引用不能直写。可先用 wb_list_nodes 查 schema。',
            additionalProperties: true
          },
          use_previous_output: {
            type: 'boolean',
            description: '链式：把本会话上一次执行的产物作为媒体输入'
          },
          batch_items: {
            type: 'array',
            description:
              '批量编排：数据行数组（2~200 行，每行一个对象，键=模板参数名）。提供时本计划走批量队列串行执行（进度经 /api/batch 通道），不再单次执行。用户明确要「批量/多组/每个都来一张」时使用；行数超 200 请分批多次调用。',
            items: { type: 'object', additionalProperties: true }
          },
          batch_shared_params: {
            type: 'object',
            description: '批量共享参数：所有行公用的参数（与 params 合并，行内值优先）。',
            additionalProperties: true
          },
          wait: {
            type: 'boolean',
            description: 'true=阻塞到执行完成并直接返回产物（推荐；失败/超时也会明确返回）'
          },
          reason: { type: 'string', description: '一句话解释这步在整体编排里的作用' }
        },
        required: ['template_id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const plan = toPlan(args)
      const validation = validatePlanLocal(plan, workbenchService.listTemplates(sessionId))
      if (validation.issues.length > 0 || !validation.template) {
        return text({ ok: false, stage: 'validation', issues: validation.issues })
      }
      workbenchService.markOrchestrated(sessionId)
      // ensure-tab（与路由层快路径一致）：模板执行前先把工作流同步到宿主画布
      // （新 tab；当前 tab 已是同一工作流则复用）。此前编排路径缺这一步，
      // spec 承诺的「执行模板自动加载画布」对 wb_execute_template 不成立
      // （真实事故：C 界面侧边栏跑完任务画布不动）。非 chat 链路
      // （handler 未注册）时内部静默跳过，不阻断执行。sessionId 显式传入
      // (审查修复 M-1):多会话并行时同步事件不再串投最早 begin 的会话。
      workbenchService.syncTemplateToCanvas(validation.template, sessionId)
      // 批量编排：走 batchRunner 队列（串行、可暂停/取消），进度经
      // /api/batch 通道。行级失败不互相阻塞，终态汇总返回。
      if (plan.batch) {
        const { jobId, total } = await workbenchService.executeBatch(
          sessionId,
          plan,
          validation.template,
          []
        )
        const done = await pollBatchUntilDone(jobId)
        return text({
          ok: done.status === 'completed',
          stage: 'batch',
          job_id: jobId,
          total,
          success: done.success,
          failed: done.failed,
          status: done.status,
          outputs: done.results.flatMap((r) => r.files ?? [])
        })
      }
      const execution = await workbenchService.execute(sessionId, plan, validation.template, [])
      if (args.wait === false) {
        return text({
          ok: true,
          stage: 'submitted',
          prompt_id: execution.promptId,
          status: execution.status
        })
      }
      return text(await pollUntilDone(sessionId, execution.promptId))
    }
  },
  {
    tool: {
      name: 'wb_list_nodes',
      description:
        '读取模板的完整节点图：节点 id / class_type / 可写 widget（直接值字段，附 /object_info 的类型/枚举/范围）。改节点参数（node_overrides）前先查这里。不传 template_id 时返回 ComfyUI 全量节点类型清单（class_type → 输入 schema 摘要），用于自组工作流（wb_run_workflow）前探查有哪些节点可用。',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: {
            type: 'string',
            description:
              '模板 id（wb_list_templates 里查；会话变体 id 也可）。缺省时返回全量节点类型清单'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      let info: Record<string, ObjectInfoNode> | null = null
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 10000)
        const res = await fetch(`${appStoreManager.getConfig().comfyHost}/object_info`, {
          signal: ctrl.signal
        })
        clearTimeout(timer)
        if (res.ok) info = (await res.json()) as Record<string, ObjectInfoNode>
      } catch {
        /* schema 补充失败不阻断：只有 current 值 */
      }
      // 无参调用：返回全量节点类型清单（spec §4.1：不传=读 /object_info 全量）
      const templateId = args.template_id ? String(args.template_id) : null
      if (!templateId) {
        if (!info) return text({ ok: false, error: 'ComfyUI 不可达，无法读取 /object_info' })
        const kinds = Object.entries(info).map(([classType, def]) => {
          const required = def?.input?.required ?? {}
          const inputs = Object.entries(required).map(([k, spec]) => {
            const combo = Array.isArray(spec) ? spec[0] : undefined
            return {
              name: k,
              type: Array.isArray(combo) ? 'COMBO' : String(combo ?? '?')
            }
          })
          return { class_type: classType, inputs }
        })
        return text({ ok: true, mode: 'object_info', count: kinds.length, kinds })
      }
      const template = workbenchService.resolveTemplate(sessionId, templateId)
      if (!template) return text({ ok: false, error: 'template not found' })
      const nodes = Object.entries(template.prompt).map(([id, n]) => {
        const schema = info?.[n.class_type]?.input?.required ?? {}
        return {
          id,
          class_type: n.class_type,
          widgets: Object.entries(n.inputs)
            .filter(([, v]) => !Array.isArray(v))
            .map(([k, v]) => {
              const spec = schema[k]
              const meta = (Array.isArray(spec) ? (spec[1] ?? {}) : {}) as {
                min?: number
                max?: number
              }
              const combo = Array.isArray(spec) ? spec[0] : undefined
              return {
                name: k,
                current: v,
                type: Array.isArray(combo) ? 'COMBO' : String(combo ?? '?'),
                ...(Array.isArray(combo) ? { options: combo } : {}),
                ...(meta.min != null ? { min: meta.min } : {}),
                ...(meta.max != null ? { max: meta.max } : {})
              }
            })
        }
      })
      return text({ ok: true, template_id: template.id, nodes })
    }
  },
  {
    tool: {
      name: 'wb_set_node_params',
      description:
        '预览校验某节点的参数覆盖（不执行）：本地规则（节点存在/类型匹配/字段存在/非链接）+ /object_info（类型/枚举/范围）。返回 issue 列表，全过才可入 node_overrides。',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          node_id: { type: 'string', description: 'prompt 节点 id（wb_list_nodes 里查）' },
          class_type: { type: 'string', description: '节点类型（防串号，可选但推荐）' },
          params: {
            type: 'object',
            description: '要覆盖的 widget 键值',
            additionalProperties: true
          }
        },
        required: ['template_id', 'node_id', 'params'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const template = workbenchService.resolveTemplate(sessionId, String(args.template_id))
      if (!template) return text({ ok: false, error: 'template not found' })
      const nodeOverrides = {
        [String(args.node_id)]: {
          class_type: args.class_type ? String(args.class_type) : undefined,
          widgetOverrides: args.params as Record<string, unknown>
        }
      }
      const local = validateNodeOverridesLocal(template.prompt, nodeOverrides)
      let issues: PlanValidationIssue[] = local
      if (local.length === 0) {
        issues = await validateNodeOverrides(
          appStoreManager.getConfig().comfyHost,
          template.prompt,
          nodeOverrides
        )
      }
      return text({ ok: issues.length === 0, issues })
    }
  },
  {
    tool: {
      name: 'wb_validate_workflow',
      description:
        '校验一个 API 格式 workflow JSON（自建工作流）：节点结构、链接完整性（引用节点存在）、节点类型已安装（/object_info）。错误可迭代修正后重试。',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: {
            type: 'object',
            description:
              'API 格式：{"节点id": {"class_type": "节点类名", "inputs": {"参数": 值 或 ["上游id", 端口]}}}',
            additionalProperties: true
          }
        },
        required: ['workflow'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args) => {
      const workflow = args.workflow as ComfyPrompt
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow))
        return text({ ok: false, error: 'workflow（API prompt 对象）required' })
      const size = Object.keys(workflow).length
      if (size === 0) return text({ ok: false, error: 'workflow 为空' })
      if (size > 200) return text({ ok: false, error: `节点数超限（${size}/200）` })
      const localIssues: PlanValidationIssue[] = []
      for (const [id, n] of Object.entries(workflow)) {
        if (
          !n ||
          typeof n !== 'object' ||
          !n.class_type ||
          !n.inputs ||
          typeof n.inputs !== 'object'
        ) {
          localIssues.push({
            field: `workflow.${id}`,
            message: '节点结构非法（需 class_type + inputs）'
          })
          continue
        }
        for (const [k, v] of Object.entries(n.inputs)) {
          if (Array.isArray(v) && v.length >= 2 && typeof v[0] === 'string') {
            if (!(v[0] in workflow))
              localIssues.push({
                field: `workflow.${id}.${k}`,
                message: `链接指向不存在的节点 ${v[0]}`
              })
          }
        }
      }
      const remote = await validateAgainstObjectInfo(
        appStoreManager.getConfig().comfyHost,
        workflow
      )
      return text({
        ok: localIssues.length + remote.length === 0,
        issues: [...localIssues, ...remote],
        node_count: size
      })
    }
  },
  {
    tool: {
      name: 'wb_run_workflow',
      description:
        '直接运行一个 API 格式 workflow JSON（自建/粘贴/改过的工作流），不依赖固化模板。校验→提交→（wait=true 阻塞到完成返回产物）。产物自动落会话。',
      inputSchema: {
        type: 'object',
        properties: {
          workflow: {
            type: 'object',
            description:
              'API 格式：{"节点id": {"class_type": "节点类名", "inputs": {"参数": 值 或 ["上游id", 端口]}}}',
            additionalProperties: true
          },
          name: { type: 'string', description: '工作流名称（便于会话/产物识别，可选）' },
          seed: { type: 'number', description: '显式 seed（缺省随机）' },
          randomize_seed: { type: 'boolean', description: '强制随机 seed' },
          node_overrides: {
            type: 'object',
            description: '节点级覆盖（同 node_overrides 语义）',
            additionalProperties: true
          },
          use_previous_output: {
            type: 'boolean',
            description: '链式：把本会话上一次执行的产物作为媒体输入（写进首个 Load* 媒体槽）'
          },
          wait: { type: 'boolean', description: 'true=阻塞到完成（推荐）' }
        },
        required: ['workflow'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const workflow = args.workflow as ComfyPrompt
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow))
        return text({ ok: false, error: 'workflow（API prompt 对象）required' })
      // 链式：上一次产物写进首个媒体加载槽（图→视频/图→图典型）
      if (args.use_previous_output) {
        const last = workbenchService.lastExecution(sessionId)
        if (!last || last.outputs.length === 0)
          return text({ ok: false, error: 'no previous execution output to attach' })
        const slot = inferFirstMediaSlot(workflow)
        if (!slot) return text({ ok: false, error: 'workflow has no media loader slot (Load*)' })
        const node = workflow[slot.nodeId]
        if (!node) return text({ ok: false, error: `loader node ${slot.nodeId} missing` })
        node.inputs[slot.inputKey] = last.outputs[0]
      }
      const remote = await validateAgainstObjectInfo(
        appStoreManager.getConfig().comfyHost,
        workflow
      )
      if (remote.length > 0) return text({ ok: false, stage: 'validation', issues: remote })
      const execution = await workbenchService.executeWorkflow(sessionId, workflow, {
        name: args.name ? String(args.name) : undefined,
        seed: args.seed != null ? Number(args.seed) : null,
        randomizeSeed: Boolean(args.randomize_seed),
        nodeOverrides: args.node_overrides as WorkbenchPlan['nodeOverrides']
      })
      workbenchService.markOrchestrated(sessionId)
      if (args.wait === false) {
        return text({ ok: true, stage: 'submitted', prompt_id: execution.promptId })
      }
      return text(await pollUntilDone(sessionId, execution.promptId))
    }
  },
  {
    tool: {
      name: 'wb_clone_template',
      description:
        '把模板克隆为会话级变体（可叠加 node_overrides 固化进新 prompt）。返回新模板 id，可继续改/执行/固化。',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          node_overrides: {
            type: 'object',
            description: '要固化进副本的节点覆盖（可选）',
            additionalProperties: true
          }
        },
        required: ['template_id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      try {
        const t = workbenchService.cloneTemplate(
          sessionId,
          String(args.template_id),
          args.node_overrides as WorkbenchPlan['nodeOverrides']
        )
        if (!t) return text({ ok: false, error: 'template not found' })
        return text({
          ok: true,
          template_id: t.id,
          name: t.name,
          node_count: Object.keys(t.prompt).length
        })
      } catch (e) {
        return text({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
  },
  {
    tool: {
      name: 'wb_publish_workflow',
      description:
        '把自建/修改过的 workflow 固化为新 App（进模板库，长期复用）。复用现有 app 固化链路。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '新 App 名称' },
          workflow: {
            type: 'object',
            description: 'API 格式 workflow',
            additionalProperties: true
          },
          params_nodes: {
            type: 'array',
            description: '可选：显式参数 schema（缺省按输出节点推断）',
            items: { type: 'object' }
          }
        },
        required: ['name', 'workflow'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const name = String(args.name ?? '').trim()
      if (!name) return text({ ok: false, error: 'name required' })
      const workflow = args.workflow as ComfyPrompt
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow))
        return text({ ok: false, error: 'workflow（API prompt 对象）required' })
      const app = workbenchService.publishWorkflow(
        name,
        workflow,
        args.params_nodes as ParamNode[] | undefined
      )
      return text({ ok: !!app, app_id: app?.id, name })
    }
  },
  {
    tool: {
      name: 'wb_poll_execution',
      description: '查询某次执行的最新状态与产物（wb_execute_template wait=false 时用）。',
      inputSchema: {
        type: 'object',
        properties: { prompt_id: { type: 'string' } },
        required: ['prompt_id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const r = await workbenchService.pollExecution(sessionId, String(args.prompt_id))
      return text({ status: r.status, outputs: r.outputs, error: r.error })
    }
  },
  {
    tool: {
      name: 'wb_get_outputs',
      description:
        '读取会话最近一次（或指定 prompt_id 的）执行产物文件清单，非阻塞、立即返回。用于执行提交后（wait=false 或跨轮）取产物文件名/引用；要「等跑完再继续」请用 wb_execute_template 的 wait 模式。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt_id: {
            type: 'string',
            description: '可选：指定执行的 prompt_id；缺省返回会话最近一次执行'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const promptId = args.prompt_id ? String(args.prompt_id) : null
      // 指定 prompt_id：直接查该次执行；缺省：会话最近一次执行
      const session = workbenchService.getSession(sessionId)
      const exec = promptId
        ? session?.executions.find((e) => e.promptId === promptId)
        : workbenchService.lastExecution(sessionId)
      if (!exec) return text({ ok: false, error: 'no execution found' })
      // 还在跑：提示用 wb_poll_execution 轮询（这里不做阻塞等待）
      if (exec.status === 'queued' || exec.status === 'running') {
        return text({
          ok: true,
          status: exec.status,
          prompt_id: exec.promptId,
          hint: 'still running — use wb_poll_execution to await completion'
        })
      }
      return text({
        ok: true,
        status: exec.status,
        prompt_id: exec.promptId,
        outputs: exec.outputs ?? [],
        error: exec.error
      })
    }
  },
  {
    tool: {
      name: 'wb_remember',
      description:
        '写入/更新跨会话长期记忆（key 幂等；value ≤500 字）。用于沉淀用户偏好、硬件信息等。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '短标签键，如 preferred-style' },
          value: { type: 'string', description: '记忆内容，≤500 字' }
        },
        required: ['key', 'value'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const key = String(args.key ?? '').trim()
      const value = String(args.value ?? '')
      if (!key) return text({ ok: false, error: 'key required' })
      if (!value || value.length > 500)
        return text({ ok: false, error: 'value required, ≤500 chars' })
      workbenchService.rememberMemory(key, value)
      return text({ ok: true, key })
    }
  },
  {
    tool: {
      name: 'wb_forget',
      description: '删除跨会话长期记忆（按 key）。',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const key = String(args.key ?? '').trim()
      const ok = key ? workbenchService.forgetMemory(key) : false
      return text({ ok, key })
    }
  },
  {
    tool: {
      name: 'wb_query_models',
      description:
        '查询模型知识与 civitai 在线搜索。action=search 搜本机清单（LoRA Manager 的 civitai 元数据：触发词/用法提示/备注），action=detail 按文件名查单模型详情+官方示例提示词，action=civitai 在线搜索 civitai 模型（触发词/版本 id/热度/页面链接，需网络）。选模型没把握、不知道某 lora 的触发词怎么写、想参考高质量示例提示词、或用户要找本机没有的模型时先调它。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'detail', 'civitai'],
            description: 'search=搜本机清单（默认）；detail=单模型详情；civitai=在线搜索'
          },
          type: {
            type: 'string',
            enum: ['loras', 'checkpoints', 'embeddings'],
            description: '模型类型，默认 loras'
          },
          query: {
            type: 'string',
            description: 'action=search/civitai：关键词（civitai 支持英文/空格分词）'
          },
          file: {
            type: 'string',
            description: 'action=detail：模型文件名（或相对路径，支持部分匹配）'
          },
          base_model: {
            type: 'string',
            description:
              'action=civitai：按基模过滤，逗号分隔，如 "Illustrious,Pony"（Flux 装不上 SDXL 的 lora，务必过滤）'
          },
          sort: {
            type: 'string',
            enum: ['Most Downloaded', 'Highest Rated', 'Newest'],
            description: 'action=civitai：排序，默认 Most Downloaded'
          },
          nsfw: {
            type: 'boolean',
            description: 'action=civitai：包含 NSFW（默认 true；false 仅 SFW）'
          },
          limit: { type: 'number', description: '返回条数上限，默认 10-15，civitai 上限 20' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const action =
        args.action === 'detail' ? 'detail' : args.action === 'civitai' ? 'civitai' : 'search'
      try {
        if (action === 'detail') {
          const file = String(args.file ?? '').trim()
          if (!file) return text({ ok: false, error: 'action=detail 需要 file 参数' })
          return text(await modelKnowledgeDetail(file, args.type as string))
        }
        if (action === 'civitai') {
          const query = String(args.query ?? '').trim()
          if (!query) return text({ ok: false, error: 'action=civitai 需要 query 参数' })
          const typeMap: Record<string, string> = {
            loras: 'LORA',
            checkpoints: 'Checkpoint',
            embeddings: 'TextualInversion'
          }
          const result = await searchCivitaiModels({
            query,
            type: typeMap[String(args.type ?? 'loras')] ?? 'LORA',
            baseModels: args.base_model
              ? String(args.base_model)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
            sort: args.sort ? String(args.sort) : undefined,
            nsfw: args.nsfw === false ? false : true,
            limit: typeof args.limit === 'number' ? args.limit : 10
          })
          if (!result.ok)
            return text({
              ...result,
              hint: 'civitai 不可达（网络/镜像）时不影响其它流程'
            })
          return text(result)
        }
        return text(
          await searchModelKnowledge(
            args.type as string,
            args.query ? String(args.query) : undefined,
            typeof args.limit === 'number' ? args.limit : 15
          )
        )
      } catch (e) {
        return text({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          hint: 'LoRA Manager 未运行或未安装时不可用；不影响其它流程'
        })
      }
    }
  }
]

/**
 * 组合 registry：现有 MCP registry（外部 app 工具）+ 工作台编排工具（wb_*）。
 * /mcp 端点继续服务外部客户端（无 wb 上下文时 wb_* 返回明确错误）；
 * decide 链路用同一个端点+token，工具调用落在当前 decide 会话上。
 *
 * C7：wb_* 工具 fn 增加第二参「请求身份」（每会话 MCP 配置注入的完整 URL 或
 * 会话 id 字面量），requireSession 按它精确路由到所属会话；未携带身份的调用
 * 保持单槽回退语义（最外层 decide 会话），与 C7 之前行为一致。
 * base registry 转发不携带身份（外部工具无 wb 会话语义）。
 */
/**
 * 仅外部 MCP 客户端可见的 app 工具：与 wb_* 功能重叠（list_apps≈wb_list_templates、
 * upload_image≈附件 HTTP 上传），对 decide agent 是 ~830 tok 的常驻噪音——带会话
 * 身份的 ListTools 会过滤掉它们（CallTool 不拦，误调也能得到明确错误）。
 */
export const EXTERNAL_ONLY_TOOL_NAMES = new Set([
  'list_apps',
  'get_app_details',
  'get_execution_status',
  'stop_execution',
  'upload_image'
])

export function createWorkbenchAugmentedRegistry(base: ToolRegistry): ToolRegistry {
  return {
    list: () => [...base.list(), ...WB_TOOLS.map((w) => w.tool)],
    handle: async (name, args, identity?: string) => {
      const wb = WB_TOOLS.find((w) => w.tool.name === name)
      if (wb) return wb.fn(args ?? {}, identity)
      return base.handle(name, args)
    },
    sync: () => base.sync()
  }
}
