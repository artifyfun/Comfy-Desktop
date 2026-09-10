/**
 * wb_* 工具共享层：会话上下文注册表（C7 多会话并行）+ 工具函数签名。
 *
 * 旧实现是模块级单例 currentDecideSession：两个会话并行 decide 时 begin/end
 * 相互覆盖，wb_* 工具经 HTTP 回环 /mcp 时全部落在最先 begin 的会话上（串号）。
 * 现改为 Set<sessionId> 注册表：begin/end 签名不变（嵌套保护语义由「end 只删
 * 自己」继承），工具调用按请求身份精确路由到所属会话。
 */
import { workbenchService } from '../../workbench/service'
import type { WorkbenchPlan } from '../../workbench/plan'
import { listBatchQueue, type BatchJobSummary } from '../../services/batchRunner'

export type WBToolFn = (args: Record<string, unknown>, identity?: string) => Promise<unknown>

/**
 * 当前 decide 会话上下文注册表（C7 多会话并行）。
 *
 * 旧实现是模块级单例 currentDecideSession：两个会话并行 decide 时 begin/end
 * 相互覆盖，wb_* 工具经 HTTP 回环 /mcp 时全部落在最先 begin 的会话上（串号）。
 * 现改为 Set<sessionId> 注册表：begin/end 签名不变（嵌套保护语义由「end 只删
 * 自己」继承），工具调用按请求身份精确路由到所属会话。
 */
export const decideSessions = new Set<string>()

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
export function requireSession(identity?: string): string {
  if (identity) {
    const isUrl = /^[a-z][a-z0-9+.-]*:\/\//i.test(identity)
    const sid = isUrl ? resolveWorkbenchSessionFromRequest(undefined, identity) : identity
    if (sid && decideSessions.has(sid)) return sid
    throw new Error('workbench tool called outside decide session')
  }
  if (decideSessions.size === 0) throw new Error('workbench tool called outside decide session')
  return decideSessions.values().next().value!
}

export function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/** wb_execute_template 参数 → WorkbenchPlan（与 decide 快路径同构，命名 snake_case 亲和 MCP） */
export function toPlan(args: Record<string, unknown>): WorkbenchPlan {
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
  // 兼容修复：schema 声明 template_id（snake_case），但模型实测高频输出
  // camelCase 的 templateId/nodeOverrides —— 两键都收，避免参数静默丢失后
  // 校验层报「必须指定 templateId」这种对用户无意义的错（真机 harness 冒烟发现）。
  const templateIdRaw = args.template_id ?? args.templateId
  return {
    intent,
    templateId: templateIdRaw != null ? String(templateIdRaw) : undefined,
    params: (args.params as Record<string, unknown>) ?? {},
    usePreviousOutput: Boolean(args.use_previous_output),
    nodeOverrides: (args.node_overrides ?? args.nodeOverrides) as WorkbenchPlan['nodeOverrides'],
    batch,
    reason: args.reason ? String(args.reason) : undefined
  }
}

/** wait=true 轮询到终态（wb_execute_template / wb_run_workflow 共用） */
export async function pollUntilDone(
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
export async function pollBatchUntilDone(jobId: string): Promise<BatchJobSummary> {
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
