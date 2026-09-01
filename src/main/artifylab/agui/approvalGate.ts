/**
 * C14 — HITL 审批门控(工具确认门):纯状态机 + 通知注册表。
 *
 * 设计来源(见 docs/workbench-agui-migration.md C14 + waa《人工介入(HITL)前端对接说明》v2.3):
 * - 白名单内的 wb_* 工具在真正执行前先经 intercept():进程内 Promise 挂起,
 *   经 notify(路由层接 SSE)下发 `CUSTOM {name:'tool_approval_required'}` 审批请求,
 *   用户三操作(approve / reject / edit-args)经 interaction-response 端点 → resolve() 唤醒续跑。
 * - fail-safe 红线(对齐 waa ApprovalGateToolInterceptor):超时(默认 10min,对齐
 *   wb_* wait=true 轮询预算)未决策按 **reject** 处理——审批工具绝不未经决策执行。
 * - Electron 单实例 → waa 的最难点(RedisSaver checkpoint / 跨实例广播)降级为
 *   进程内 Map 挂起;SSE 断线重连时 pending 仍可经端点应答(通知通道与挂起状态解耦,
 *   unregister 只摘 notify,不清 pending)。
 *
 * 零 express/electron 依赖:仅 node:crypto 取 requestId,任意测试环境可直接实例化。
 *
 * captain 接线约定(本文件不接线,与 C7 冲突地图一致):
 * - mcp/index.ts registry 组合处包一层:白名单工具 intercept() 前置;approve 用
 *   替换后 args 执行原工具;reject/超时返回合成拒绝文本(照 waa「原因注入上下文,模型改道」);
 * - routes/agui.ts SSE:run 开始 gate.register(threadId, (req) => emit(custom(
 *   TOOL_APPROVAL_REQUIRED, toolApprovalRequiredValue(req)))),run 结束/断连
 *   gate.unregister(threadId)。
 */

import { randomUUID } from 'node:crypto'

// ==================== 常量(事件形状,对齐 waa) ====================

/** CUSTOM 事件 name:工具审批请求(waa 同名,见对接说明 §2.2) */
export const TOOL_APPROVAL_REQUIRED = 'tool_approval_required'

/** 审批超时默认 10min —— 对齐 wb_execute_template / wb_run_workflow 的 wait=true 轮询预算 */
export const APPROVAL_TIMEOUT_MS_DEFAULT = 10 * 60 * 1000

/**
 * 白名单默认值建议(C14 计划文档点名的「执行家族」):
 * wb_execute_template(wait=true 阻塞执行)、wb_run_workflow(任意 workflow 直跑)、
 * wb_publish_workflow(固化进模板库)。只读/低危 wb_* 不进默认白名单,接线时可配置扩大。
 */
export const APPROVAL_WHITELIST_DEFAULT: readonly string[] = [
  'wb_execute_template',
  'wb_run_workflow',
  'wb_publish_workflow'
]

// ==================== 类型 ====================

export type ApprovalAction = 'approve' | 'reject' | 'edit'

/** 下发给前端的审批请求(notify 载荷;SSE 事件 value 由 toolApprovalRequiredValue 包装) */
export interface ApprovalRequest {
  requestId: string
  threadId: string
  toolName: string
  args: Record<string, unknown>
  /** 本次审批的挂起预算(前端卡片倒计时用;超时后端按 reject 兜底) */
  timeoutMs: number
}

/** 通知回调(路由层实现:emit AG-UI CUSTOM 事件 + 旁路落库) */
export type ApprovalNotify = (request: ApprovalRequest) => void

/** intercept 结果:白名单外 {suspended:false};白名单内挂起后按决策/超时恢复 */
export interface InterceptResult {
  /** true = 经历过审批挂起(含通知抛错的 fail-safe 拒绝);false = 白名单外/无通知通道直通 */
  suspended: boolean
  /** approve/直通 = true;reject/超时/fail-safe = false */
  approved: boolean
  /**
   * 执行参数:approve 时为原 args(被 edit 则为替换后 args);reject/超时缺省。
   * 白名单外直通也回带归一化后的 args,调用方统一取 result.args 即可。
   */
  args?: Record<string, unknown>
}

/** edit 动作提交的 args 不是(深层校验为)对象时抛出;路由层捕获映射 400 */
export class ApprovalArgsError extends Error {
  constructor(message = 'edit args must be a plain object') {
    super(message)
    this.name = 'ApprovalArgsError'
  }
}

/** 严格对象校验:typeof object 且非 null 且非数组(工具参数不允许数组/标量顶层) */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * CUSTOM value 形状(对齐 waa 对接说明 §2.2 同流模式):
 * - waa 契约字段:interactionId(= requestId,应答原样回传)、mode:'sameflow'
 *   (同流阻塞,SSE 保持打开 → 走 interaction-response,与桌面单实例语义一致)、
 *   toolCalls 恒 1 条(toolCallId = requestId,arguments 为 JSON 字符串,展示/编辑初始值);
 *   agentId 同流模式可为空 → 省略。
 * - 桌面端扩展字段(超集不破坏 waa 消费端的多余字段忽略行为):requestId/threadId/
 *   toolName/args(已解析对象,C15 卡片免二次 parse)/timeoutMs(倒计时)。
 */
export function toolApprovalRequiredValue(request: ApprovalRequest): Record<string, unknown> {
  return {
    // —— waa v2.3 契约字段 ——
    interactionId: request.requestId,
    mode: 'sameflow',
    toolCalls: [
      {
        toolCallId: request.requestId,
        toolCallName: request.toolName,
        arguments: JSON.stringify(request.args)
      }
    ],
    // —— 桌面端扩展字段 ——
    requestId: request.requestId,
    threadId: request.threadId,
    toolName: request.toolName,
    args: request.args,
    timeoutMs: request.timeoutMs
  }
}

// ==================== 门控接口 ====================

/** 审批终态回执(M4:run 路由据此补发 tool_approval_resolved) */
export interface ApprovalResolvedInfo {
  requestId: string
  threadId: string
  toolName: string
  approved: boolean
}

export interface ApprovalGate {
  /** 登记某 thread 的通知通道(SSE 打开时调用;重复登记覆盖,SSE 重连幂等) */
  register(threadId: string, notify: ApprovalNotify): void
  /**
   * 登记终态回执钩子(与 notify 同生命周期,unregister 一并清理;审查修复 M4)。
   * 审批被 resolve(应答/超时兜底)时回调 {requestId, threadId, toolName, approved}。
   */
  onResolved(threadId: string, hook: (r: ApprovalResolvedInfo) => void): void
  /** 摘除通知通道(run 结束/断连);不清已挂起 pending——端点仍可应答 */
  unregister(threadId: string): void
  /**
   * 收口清理:该 thread 全部挂起 pending 按 reject 结算(清 timer、settle、摘表),
   * 返回收口数量(0 = 无挂起)。run 结束/断连/取消时调用——SSE 已死,无人能应答,
   * 挂起工具不得悬到超时兜底。与 unregister 顺序无关,二者通常一起调用。
   */
  rejectPending(threadId: string): number
  /**
   * 工具执行前拦截:白名单外直通;白名单内置 pending + notify 并挂起 Promise。
   * args 非对象时归一化为 {}(防御 MCP 入参)。
   */
  intercept(threadId: string, toolName: string, args: unknown): Promise<InterceptResult>
  /**
   * 应答:approve → 原参数执行;edit → args 整体替换(必须为对象,否则抛 ApprovalArgsError
   * 且不消费 pending,可重新应答);reject → 拒绝。超时由内部 timer 按 reject 兜底。
   * 未知 threadId/requestId 或已终态 → 返回 false(幂等忽略)。
   */
  resolve(threadId: string, requestId: string, action: ApprovalAction, args?: unknown): boolean
}

// ==================== 实现 ====================

interface PendingApproval {
  requestId: string
  threadId: string
  toolName: string
  args: Record<string, unknown>
  settle: (result: InterceptResult) => void
  timer: ReturnType<typeof setTimeout>
}

export function createApprovalGate(opts: {
  whitelist: string[]
  timeoutMs?: number
}): ApprovalGate {
  const whitelist = new Set(opts.whitelist)
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : APPROVAL_TIMEOUT_MS_DEFAULT

  /** threadId → 通知通道(SSE 生命周期) */
  const notifies = new Map<string, ApprovalNotify>()
  const onResolvedHooks = new Map<string, (r: ApprovalResolvedInfo) => void>()
  /** threadId → requestId → 挂起审批(同 thread 并发多 pending;跨 thread 隔离) */
  const pendings = new Map<string, Map<string, PendingApproval>>()

  /** 消费一个 pending:摘表 + 清 timer + settle;不存在返回 false(幂等/未知) */
  function finish(threadId: string, requestId: string, result: InterceptResult): boolean {
    const byRequest = pendings.get(threadId)
    const pending = byRequest?.get(requestId)
    if (!byRequest || !pending) return false
    byRequest.delete(requestId)
    if (byRequest.size === 0) pendings.delete(threadId)
    clearTimeout(pending.timer)
    pending.settle(result)
    // 审查修复 M4:终态回执(批准/拒绝/超时兜底)通知订阅方——run 路由据此补发
    // tool_approval_resolved CUSTOM 并旁路落库,实时与回放都能拿到终态
    const hook = onResolvedHooks.get(threadId)
    if (hook) {
      try {
        hook({ requestId, threadId, toolName: pending.toolName, approved: result.approved })
      } catch {
        /* 订阅方异常不影响 settle 主流程 */
      }
    }
    return true
  }

  return {
    register(threadId, notify) {
      notifies.set(threadId, notify)
    },

    /**
     * 注册终态回执钩子(与 notify 同生命周期,unregister 一并清理)。
     * 审批被 resolve(应答/超时兜底)时回调——订阅方补发终态事件供实时流
     * 与历史回放消费。
     */
    onResolved(threadId, hook) {
      onResolvedHooks.set(threadId, hook)
    },

    unregister(threadId) {
      notifies.delete(threadId)
      onResolvedHooks.delete(threadId)
    },

    rejectPending(threadId) {
      const byRequest = pendings.get(threadId)
      if (!byRequest) return 0
      const ids = [...byRequest.keys()]
      for (const id of ids) {
        // finish 内部已做清 timer + settle + 摘表;拒绝语义(fail-safe 与超时一致)
        finish(threadId, id, { suspended: true, approved: false })
      }
      return ids.length
    },

    intercept(threadId, toolName, args) {
      // 防御归一化:MCP 入参顶层必须是对象,否则按空参处理(不阻断白名单语义)
      const safeArgs = isPlainObject(args) ? args : {}

      // 白名单外 → 直接放行(无挂起、无通知)
      if (!whitelist.has(toolName)) {
        return Promise.resolve({ suspended: false, approved: true, args: safeArgs })
      }

      const notify = notifies.get(threadId)
      // 无通知通道时不再 fail-safe 拒绝(审查修复 C-1A 配套语义调整):
      // 「未注册 notify」== 该 thread 不在 AG-UI run 中(legacy /chat 与外部 MCP
      // 客户端同此路径)——门控对不在场的 run 无管辖权,放行即与门控引入前
      // (HEAD)行为一致,保 legacy 等价红线。挂起只发生在 notify 已注册
      // (AG-UI run 活跃)时;run 内 SSE 断连经 unregister+rejectPending 收口,
      // 超时兜底 reject 仍覆盖「注册了但无人应答」。
      if (!notify) {
        return Promise.resolve({ suspended: false, approved: true, args: safeArgs })
      }

      const requestId = randomUUID()
      return new Promise<InterceptResult>((settle) => {
        const timer = setTimeout(() => {
          // fail-safe 红线:超时按 reject 处理,审批工具绝不未经决策执行
          finish(threadId, requestId, { suspended: true, approved: false })
        }, timeoutMs)

        const pending: PendingApproval = {
          requestId,
          threadId,
          toolName,
          args: safeArgs,
          settle,
          timer
        }
        let byRequest = pendings.get(threadId)
        if (!byRequest) {
          byRequest = new Map()
          pendings.set(threadId, byRequest)
        }
        // 先入表再通知:notify 内同步 resolve 也成立
        byRequest.set(requestId, pending)

        try {
          notify({ requestId, threadId, toolName, args: safeArgs, timeoutMs })
        } catch {
          // 通知通道异常(SSE 写失败等)→ fail-safe 拒绝,工具绝不静默执行
          finish(threadId, requestId, { suspended: true, approved: false })
        }
      })
    },

    resolve(threadId, requestId, action, args) {
      const byRequest = pendings.get(threadId)
      const pending = byRequest?.get(requestId)
      // 未知 threadId/requestId / 已终态 → 幂等忽略(路由层映射 404)
      if (!byRequest || !pending) return false

      if (action === 'edit') {
        // 深校验:替换后 args 必须是(严格)对象;校验失败抛错且**不消费 pending**
        if (!isPlainObject(args)) throw new ApprovalArgsError()
        return finish(threadId, requestId, { suspended: true, approved: true, args })
      }
      if (action === 'approve') {
        return finish(threadId, requestId, { suspended: true, approved: true, args: pending.args })
      }
      // reject(含超时兜底语义):拒绝执行,不回带 args
      return finish(threadId, requestId, { suspended: true, approved: false })
    }
  }
}
