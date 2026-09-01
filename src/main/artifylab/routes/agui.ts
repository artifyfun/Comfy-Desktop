/**
 * C4 — AG-UI 流式端点(workbench-agui-migration.md §C4)。
 *
 * 端点:
 * - POST /api/workbench/agent/run    SSE 主入口:runStarted → decide(onProgress.thread_event
 *   喂 C2 映射器逐帧下发)→ decide 返回后按旧 chat 路由同一套分派:
 *   validatePlanLocal → 按 intent 分派(执行/批量/回复/记忆/画布/编排去重)。
 *   业务产物以 CUSTOM 事件补发(C2 业务层表):
 *   wb_plan(PLAN+本地 issues)/ wb_invalid(校验失败)/ wb_sync(画布同步)/
 *   wb_canvas_exec(画布执行桥指令)/ wb_submitted(编排去重)/ wb_artifact(执行产物,
 *   提交回执 + 收尾 flush 编排产物两种形态)。最终回复/确认文案以 TEXT_MESSAGE
 *   三帧下发(messageId 用 msg- 前缀,不与映射器的 codex item.id 冲突)。
 * - POST /api/workbench/agent/cancel 中断进行中的 run(独立 Map<threadId, RunHandle>,
 *   对齐 workbench.ts /stop 的 chatSettled 语义,但不 import 其模块状态)。
 *
 * SSE/超时/断连/分派次序照抄 routes/workbench.ts chat(423 行起):X-Accel-Buffering:no /
 * no-cache / flushHeaders / res.on('close')→abort / 15min 总超时 / setCanvasSyncHandler
 * 在 decide 前注册(C7:两参 session 绑定),收尾统一补发编排产物并释放锁。
 * 红线:PLAN JSON 仍是内部 IR;plan.ts 校验语义、wb_* 工具、executor 链路零改动——
 * 本文件只做「路由层分派 + AG-UI 事件翻译」,全部经 workbenchService 公共 API 复用。
 *
 * 尚属后续组件:C5 threads 分页 API、intentLabel 等 STATE_DELTA 元数据挂载。
 */
import { randomUUID } from 'node:crypto'
import express from 'express'
import type { Request, Response } from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse } from '../utils/errorHandler'
import { workbenchService } from '../workbench/service'
import type { WorkbenchMessageKind } from '../workbench/service'
import { stopExecution } from '../mcp/executor'
import appStoreManager from '../appStore'
import { validatePlanLocal } from '../workbench/plan'
import { promptToWorkflowGraph } from '../workbench/templateCore'
import type { WorkflowTemplate } from '../workbench/templateCore'
import type { AttachmentMeta } from '../workbench/presetCore'
import type { ThreadEvent } from '../vendor/codex-sdk'
import { createCodexMapper } from '../agui/codexMapper'
import { getApprovalGate } from '../agui/approvalRegistry'
import { TOOL_APPROVAL_REQUIRED, toolApprovalRequiredValue } from '../agui/approvalGate'
import {
  custom,
  encodeSseFrame,
  runError,
  runFinished,
  runStarted,
  textMessageContent,
  textMessageEnd,
  textMessageStart
} from '../agui/types'
import type { AGUIEvent } from '../agui/types'
import type { EventStore } from '../agui/eventStore'

/** AG-UI run 总超时:与旧 chat 端点同值(15min,理由见 workbench.ts CHAT_TIMEOUT_MS) */
const AGUI_RUN_TIMEOUT_MS = 15 * 60 * 1000
/** cancel 等待 run 收尾的兜底:codex 子进程 kill 极端慢时不让 cancel 一直挂着(对齐 /stop 的 5s) */
const CANCEL_SETTLE_TIMEOUT_MS = 5000

/** 进行中的 run 句柄:取消柄 + 收尾 promise(cancel 端点 await 之,chatSettled 语义) */
interface RunHandle {
  ac: AbortController
  settled: Promise<void>
}

/**
 * 进行中的 run:threadId(= workbench sessionId)→ 句柄。
 * 同 thread 二连发 run 返回 409(与旧 chatRuns 锁语义对齐);cancel 端点据此 abort。
 */
const activeRuns = new Map<string, RunHandle>()
/** 被用户主动 cancel 的 thread:run 收尾时据此不发「超时」误报(cancel 误报抑制) */
const cancelRequested = new Set<string>()

/** SSE 帧写出:destroyed 挡(客户端提前断连时 writableEnded 仍 false,继续写会报错) */
function sendFrame(res: Response, event: AGUIEvent): void {
  if (!res.writableEnded && !res.destroyed) res.write(encodeSseFrame(event))
}

/** 模板画布布局:有保存的 UI graph 直接用,否则 prompt 兜底转换(旧路由同款) */
function templateWorkflow(tpl: WorkflowTemplate): unknown {
  return tpl.workflow && Array.isArray((tpl.workflow as { nodes?: unknown }).nodes)
    ? tpl.workflow
    : promptToWorkflowGraph(tpl.prompt)
}

export function createAguiRouter(deps: { store?: EventStore } = {}): express.Router {
  const router = express.Router()
  /** C3 事件旁路:可选(server.ts 注入;单测不传)。失败仅告警,不阻断实时流。 */
  const store = deps.store

  /** 旁路写事件;任何异常吞掉并告警(C3 容错契约:append 失败不阻断 SSE) */
  function persist(runId: string, ev: AGUIEvent, threadId: string): void {
    if (!store) return
    try {
      store.appendEvent(threadId, runId, ev)
    } catch (error) {
      logger.warn(`agui event persist failed (thread=${threadId})`, error)
    }
  }

  // AG-UI SSE 主入口:decide 流式 + 完整业务分派(次序对齐 workbench.ts chat)
  router.post('/api/workbench/agent/run', async (req: Request, res: Response) => {
    const { threadId, runId, input, force, attachments } = req.body as {
      threadId?: string
      runId?: string
      input?: string
      force?: boolean
      attachments?: AttachmentMeta[]
    }
    // 对齐旧路由:附件-only 输入(无文本)合法,service 内有默认占位提示
    if (!threadId || !runId || (!input && !(attachments && attachments.length > 0))) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('threadId, runId and (input or attachments) are required'))
      return
    }
    if (activeRuns.has(threadId)) {
      res
        .status(HTTP_STATUS.CONFLICT)
        .json(createErrorResponse('Another agent run is active for this thread'))
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const ac = new AbortController()
    // resolve 句柄挂在对象属性上(Promise executor 回调内赋值不被 TS 流分析跟踪,
    // 裸 let 会在使用点被收窄成 never;属性收窄会被 intervening 函数调用重置)
    const settleRef: { settle: (() => void) | null } = { settle: null }
    const settled = new Promise<void>((r) => {
      settleRef.settle = r
    })
    activeRuns.set(threadId, { ac, settled })

    // C14 HITL:decide 轮内白名单工具(wb_execute_template / wb_run_workflow /
    // wb_publish_workflow)被门控 registry 挂起时,经此 notify 下发
    // tool_approval_required CUSTOM 帧(前端灰度桥渲染审批卡)。
    // 共享 approvalRegistry 单例——与 mcp 门控 registry、interaction-response
    // 端点同一 gate 实例,pending 才能跨端点闭环。run 结束统一清理。
    const gate = getApprovalGate()
    gate.register(threadId, (approvalReq) => {
      emit(custom(TOOL_APPROVAL_REQUIRED, toolApprovalRequiredValue(approvalReq)))
    })
    // 审查修复 M4:审批终态(应答/超时兜底)补发 tool_approval_resolved CUSTOM,
    // 经统一 emit 出口旁路落库——实时流与历史回放都能拿到 approved/rejected
    // (否则刷新即丢,回放渲染出可点的死卡)。
    gate.onResolved(threadId, (info) => {
      emit(
        custom('tool_approval_resolved', {
          requestId: info.requestId,
          threadId: info.threadId,
          toolName: info.toolName,
          approved: info.approved
        })
      )
    })

    // C2 映射器:本文件内创建,单轮一个实例(diff 快照/幂等 Set 随 run 生命周期)
    const mapper = createCodexMapper({ threadId, runId })

    /** 统一出口:写 SSE 帧 + C3 旁路落库(实时流与历史回放同构的关键) */
    const emit = (ev: AGUIEvent): void => {
      sendFrame(res, ev)
      persist(runId, ev, threadId)
    }

    /** 会话留痕(对齐旧路由 appendMessage;AG-UI 客户端经 C5 历史回放可见) */
    const note = (kind: WorkbenchMessageKind, text: string): void => {
      workbenchService.appendMessage(threadId, { role: 'agent', kind, text })
    }

    /** 自生成最终回复文案:TEXT_MESSAGE 三帧(msg- 前缀,不与映射器 codex item.id 冲突) */
    const sendText = (text: string): void => {
      const messageId = `msg-${randomUUID()}`
      emit(textMessageStart(messageId))
      emit(textMessageContent(messageId, text))
      emit(textMessageEnd(messageId))
    }

    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      ac.abort()
    }, AGUI_RUN_TIMEOUT_MS)
    res.on('close', () => ac.abort())

    /** decide 起点时间戳:编排产物补发只看本轮 decide 期间新产生的执行 */
    const runStartTs = Date.now()
    /** 已补发过产物的 promptId:同一执行带产物只补发一次(提交回执 outputs 为空不占位) */
    const emittedWithOutputs = new Set<string>()

    /**
     * 收尾补发:扫描会话 executions,把本轮 decide 期间(编排工具链)真实执行
     * 成功且有产物的条目补发为 wb_artifact(旧路由 flushOrchestratedArtifacts
     * 同款判定与 string outputs 归一化)。任何异常吞掉——补发失败不阻断收尾。
     */
    const flushArtifacts = (): void => {
      try {
        const session = workbenchService.getSession(threadId)
        if (!session) return
        for (const execution of session.executions) {
          if (
            execution.startedAt < runStartTs ||
            execution.status !== 'success' ||
            execution.outputs.length === 0 ||
            emittedWithOutputs.has(execution.promptId)
          ) {
            continue
          }
          emittedWithOutputs.add(execution.promptId)
          const outputFiles = execution.outputs.map((o) =>
            typeof o === 'string' ? { filename: o, subfolder: '', type: 'output' } : o
          )
          emit(
            custom('wb_artifact', {
              promptId: execution.promptId,
              name: execution.templateId,
              outputs: outputFiles.map((f) => f.filename),
              outputFiles
            })
          )
        }
      } catch (error) {
        logger.warn(`agui artifact flush failed (thread=${threadId})`, error)
      }
    }

    /** 业务路径统一收尾:先补发编排产物,再 RUN_FINISHED(对齐旧路由 finish()) */
    const finishRun = (): void => {
      flushArtifacts()
      emit(runFinished(threadId, runId))
    }

    try {
      emit(runStarted(threadId, runId))
      // 画布同步桥(C7:两参 session 绑定):decide 轮内 wb_* 工具触发的画布同步
      // 经此以 CUSTOM wb_sync 补发;finally 置空,防跨 run 泄漏。
      workbenchService.setCanvasSyncHandler((sync) => {
        emit(
          custom('wb_sync', {
            templateId: sync.templateId ?? `session:${sync.name ?? 'workflow'}`,
            name: sync.name ?? '自建工作流',
            workflow: promptToWorkflowGraph(sync.workflow),
            ensureTab: true
          })
        )
      }, threadId)

      // decide(sessionId=threadId, input, onProgress, attachments, {signal}):
      // sessionId=threadId 复用既有 getOrCreateAgentSession harness(thread 复用/
      // 轮次与 token 预算双闸全继承),迁移零 service 改动;附件透传(落用户消息+
      // 会话素材表,与旧路由同语义)
      const { plan, raw, issues } = await workbenchService.decide(
        threadId,
        input ?? '',
        (p) => {
          // 轮级 token 用量落会话(turnUsages):turn.completed 是 codex
          // ThreadEvent 流内事件(decide 全部包成 thread_event 透传,无顶层
          // turn.completed progress),与旧路由 chat 的 onProgress 同判定。
          // 前端用量角标读 curSession.turnUsages,AG-UI 轮才能显示。
          const pe = (p as { event?: unknown }).event as
            | { type?: string; usage?: Record<string, unknown> }
            | undefined
          if (p.type === 'thread_event' && pe?.type === 'turn.completed' && pe.usage) {
            workbenchService.appendTurnUsage(threadId, {
              inputTokens: Number(pe.usage.input_tokens ?? 0),
              cachedInputTokens: Number(pe.usage.cached_input_tokens ?? 0),
              outputTokens: Number(pe.usage.output_tokens ?? 0),
              reasoningOutputTokens: Number(pe.usage.reasoning_output_tokens ?? 0),
              at: Date.now()
            })
          }
          if (p.type === 'stream_delta') {
            // C16:token 级增量(appserver 通道)→ AG-UI TEXT/REASONING CONTENT 帧
            for (const ev of mapper.feedStreamDelta(p.delta)) emit(ev)
            return
          }
          if (p.type !== 'thread_event') return // log 类进度不下发:AG-UI 无对应帧
          for (const ev of mapper.feed(p.event as ThreadEvent)) {
            // RUN_STARTED 生命周期帧归路由所有(已在 decide 前发送);mapper 对
            // thread.started 的映射服务于独立使用场景(decide 流必带 thread.started,
            // 不过滤会双帧,waa 消费端视为协议错误)
            if (ev.type === 'RUN_STARTED') continue
            emit(ev)
          }
        },
        attachments ?? [],
        { signal: ac.signal }
      )

      if (!ac.signal.aborted) {
        if (!plan) {
          // 终帧统一口径:业务失败只发 RUN_ERROR 终态(AG-UI 规范一个 run 恰一终帧),
          // 不再补 RUN_FINISHED;前端桥对两序均容错(RUN_ERROR 已推错误泡)
          emit(runError('codex 未输出可解析的 PLAN'))
          logger.warn(`agui run: no plan (thread=${threadId}) raw=${raw.slice(0, 200)}`)
          flushArtifacts()
        } else {
          // PLAN 以 CUSTOM wb_plan 下发(对齐旧路由 send('plan', {plan, localIssues}));
          // PLAN JSON 仍是内部 IR,前端据此渲染过程卡片,不经 LLM 再消费
          emit(custom('wb_plan', { plan, localIssues: issues }))

          /** 业务性校验失败统一出口:wb_invalid + RUN_ERROR(终帧,不再补
           *  RUN_FINISHED——终帧统一口径,见 no-plan 分支注释) */
          const businessInvalid = (payload: unknown, message: string): void => {
            emit(custom('wb_invalid', payload))
            emit(runError(message, 'validate_error'))
            flushArtifacts()
          }

          // ---- 分派(次序对齐 routes/workbench.ts chat 595-793)----
          // 预设意图约束是硬校验:codex 违反预设(如 text-to-image 预设下输出 text)
          // 时立即拦截并回显,而不是继续执行/回复
          const presetIssue = issues.find((i) => i.field === 'intent')
          if (presetIssue) {
            businessInvalid(
              { issues: [presetIssue] },
              `PLAN 违反预设意图约束：${presetIssue.message}`
            )
          } else {
            const local = validatePlanLocal(plan, workbenchService.listTemplates(threadId))
            if (!local.ok) {
              // 结构性非法的 PLAN 先于 reply/execution 拦截(旧路由同款文案)
              const errText = `PLAN 无效：${local.issues.map((i) => i.message).join('；')}`
              note('error', errText)
              businessInvalid({ issues: local.issues }, errText)
            } else if (plan.intent === 'memory' && plan.memory) {
              // 长期记忆(dsh memory 语义):执行 remember/forget,确认文案下发
              const { action, key, value } = plan.memory
              let ok = false
              if (action === 'remember') {
                workbenchService.rememberMemory(key, value ?? '')
                ok = true
              } else {
                ok = workbenchService.forgetMemory(key)
              }
              const confirmText =
                action === 'remember'
                  ? `已记住【${key}】：${value}`
                  : ok
                    ? `已忘掉【${key}】`
                    : `没有找到记忆【${key}】，未删除任何内容`
              note('chat', confirmText)
              sendText(confirmText)
              finishRun()
            } else if (plan.intent === 'chat' || plan.intent === 'text') {
              const reply = plan.reply ?? ''
              note('chat', reply)
              sendText(reply)
              finishRun()
            } else if (plan.intent === 'workflow') {
              // 同步模板工作流到宿主画布:UI graph({nodes,links})经 CUSTOM wb_sync 下发,
              // 前端走注入桥 artify:canvas-ops loadWorkflow 整图加载;无保存布局时
              // 用 prompt 兜底转换,保证节点能上画布
              const tpl = local.template
              const wf = tpl ? templateWorkflow(tpl) : null
              if (!wf) {
                const msg = `模板「${tpl?.name ?? plan.templateId}」无可用布局，无法同步。`
                note('chat', msg)
                sendText(msg)
                finishRun()
              } else {
                emit(
                  custom('wb_sync', {
                    templateId: tpl!.id,
                    name: tpl!.name,
                    workflow: wf,
                    ensureTab: true
                  })
                )
                const okMsg = `已把「${tpl!.name}」加载到画布。`
                note('chat', okMsg)
                sendText(okMsg)
                finishRun()
              }
            } else if (plan.intent === 'canvas-run') {
              // 执行画布当前工作流:图在宿主前端,服务端拿不到——下发桥指令
              // (前端 graphToPrompt → /api/canvas/execute 或 /api/canvas/batch),
              // 结果由前端轮询补气泡
              emit(
                custom('wb_canvas_exec', {
                  requestId: `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
                  nodeOverrides: plan.nodeOverrides ?? undefined,
                  sessionId: threadId,
                  batch: plan.batch
                    ? { items: plan.batch.items, sharedParams: plan.batch.sharedParams }
                    : undefined
                })
              )
              const progress = plan.batch ? '画布批量执行中…' : '正在执行画布当前工作流…'
              note('progress', progress)
              sendText(progress)
              finishRun()
            } else if (plan.intent === 'canvas-ops') {
              // P3 A 画布 app 节点指令集：AI 产出 ops（run_node/add_app_node/
              // update_node/connect_nodes/select_nodes），前端 canvas-embedded
              // 模式经总线到宿主画布页人审执行；产物落布/状态灯由画布页闭环
              emit(custom('wb_canvas_ops', { ops: plan.canvasOps ?? [] }))
              const n = Array.isArray(plan.canvasOps) ? plan.canvasOps.length : 0
              note('progress', `画布节点指令 ${n} 条已下发，等待画布确认…`)
              sendText(plan.reply || `已下发 ${n} 条画布节点指令，请在画布上确认执行。`)
              finishRun()
            } else if (workbenchService.consumeOrchestratedFlag(threadId)) {
              // 编排去重:codex 在 decide 轮内经 wb_execute_template 真实执行过时,
              // 最终 PLAN 只是「编排总结的载体」——产物/卡片已由工具链路落会话,
              // 跳过重复执行(产物经上方 flushArtifacts 补发)
              emit(custom('wb_submitted', { orchestrated: true }))
              sendText(plan.reply ?? '多步编排已完成，产物见上方过程流。')
              finishRun()
            } else if (!local.template) {
              businessInvalid(
                { issues: [{ field: 'templateId', message: '模板不存在' }] },
                'PLAN 无效：模板不存在'
              )
            } else {
              // 媒体执行意图:远端校验 → 执行前画布 tab 保证 → batch/单次执行
              const template = local.template
              const remote = await workbenchService.validateRemote(plan, template)
              // force=true 跳过 VRAM 拦截(旧路由同款)
              const blocking = remote.filter((i) => (force ? i.field !== 'vram' : true))
              if (blocking.length > 0) {
                businessInvalid(
                  { issues: blocking },
                  `校验未通过：${blocking.map((i) => i.message).join('；')}`
                )
              } else {
                // 执行前画布 tab 保证(ensure-tab):每次执行模板都先把目标工作流
                // 加载到画布——桥判定当前 tab 已是该工作流则复用,否则开新 tab
                emit(
                  custom('wb_sync', {
                    templateId: template.id,
                    name: template.name,
                    workflow: templateWorkflow(template),
                    ensureTab: true
                  })
                )
                if (plan.batch) {
                  // batch 编排:batchRunner 队列(串行),进度经既有 batch 轮询通道
                  const { jobId, total } = await workbenchService.executeBatch(
                    threadId,
                    plan,
                    template,
                    []
                  )
                  workbenchService.appendBatchExecution(threadId, template.id, jobId, total)
                  emit(
                    custom('wb_artifact', {
                      promptId: jobId,
                      batch: { jobId, total },
                      templateId: template.id,
                      name: template.name
                    })
                  )
                  const batchMsg = `批量任务已入队：${total} 条，模板「${template.name}」。进度可在批量任务面板查看。`
                  note('chat', batchMsg)
                  sendText(batchMsg)
                  finishRun()
                } else {
                  const execution = await workbenchService.execute(threadId, plan, template, [])
                  // 调试日志回填执行信息(模板/参数/状态)
                  workbenchService.patchDebugExecution(threadId, execution.promptId, {
                    promptId: execution.promptId,
                    templateId: execution.templateId,
                    executionStatus: execution.status
                  })
                  // 提交回执:outputs 在提交时点为空,真实产物由轮询落会话、
                  // 下一轮 flushArtifacts 补发(旧路由 submitted/artifact 两段同构)
                  emit(
                    custom('wb_artifact', {
                      promptId: execution.promptId,
                      name: execution.templateId,
                      outputs: [],
                      outputFiles: []
                    })
                  )
                  note('chat', '已提交到 ComfyUI 队列')
                  sendText('已提交到 ComfyUI 队列')
                  finishRun()
                }
              }
            }
          }
        }
      }
    } catch (error) {
      if (ac.signal.aborted) {
        // 中断来源三分:用户 cancel / 15min 超时 / SSE close。
        // cancel 误报抑制:用户主动取消不发「超时」RUN_ERROR(前端由 cancel 响应呈现);
        // SSE close 时 sendFrame 的 destroyed 挡兜底,写帧静默丢弃。
        if (cancelRequested.has(threadId)) {
          // 用户主动停止:会话留痕「已停止」而非错误,SSE 静默收尾(旧路由同款)
          note('chat', '已停止')
          flushArtifacts()
        } else if (timedOut) {
          const msg = `决策超时（${Math.round(AGUI_RUN_TIMEOUT_MS / 60000)} 分钟），本轮未完成。编排中已提交的生成任务可能仍在后台执行，可稍后重进会话查看产物。`
          note('error', msg)
          flushArtifacts()
          emit(runError(msg))
        } else {
          // 客户端断连:会话留痕,流已断,无帧可发
          note('error', '连接中断，本轮决策未完成')
          flushArtifacts()
        }
      } else {
        const message = error instanceof Error ? error.message : String(error)
        logger.error('agui run failed', error)
        note('error', message)
        flushArtifacts()
        emit(runError(message))
      }
    } finally {
      clearTimeout(timeout)
      cancelRequested.delete(threadId)
      // C14 清理:收口该 thread 仍挂起的审批(断连/超时/cancel 后 SSE 已死,
      // 无人能应答,挂起工具按拒绝结算,不等 10min 超时兜底),再摘 notify 注册。
      try {
        gate.rejectPending(threadId)
      } catch (error) {
        logger.warn(`agui approval gate rejectPending failed (thread=${threadId})`, error)
      }
      try {
        gate.unregister(threadId)
      } catch (error) {
        logger.warn(`agui approval gate unregister failed (thread=${threadId})`, error)
      }
      try {
        workbenchService.setCanvasSyncHandler(null, threadId)
      } catch (error) {
        logger.warn(`agui sync handler unregister failed (thread=${threadId})`, error)
      }
      activeRuns.delete(threadId)
      settleRef.settle?.()
      if (!res.writableEnded) res.end()
    }
  })

  // 中断进行中的 run:abort 对应句柄,并等 run 收尾(锁释放)后响应——
  // 对齐原 workbench.ts /stop 的 chatSettled 语义(legacy 删除后本端点是其
  // 唯一继承者);独立实现,不 import 旧路由状态。
  // 5s 兜底:codex 子进程 kill 极端慢时不让 cancel 一直挂着。
  router.post('/api/workbench/agent/cancel', async (req: Request, res: Response) => {
    const { threadId } = req.body as { threadId?: string }
    if (!threadId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('threadId is required'))
      return
    }
    const handle = activeRuns.get(threadId)
    if (!handle) {
      res
        .status(HTTP_STATUS.NOT_FOUND)
        .json(createErrorResponse(`no active run for thread ${threadId}`))
      return
    }
    cancelRequested.add(threadId)
    handle.ac.abort()
    // 兜底计时器在 settled 先到时清掉(零泄漏;超时路径由 run finally 的
    // settle 收口,双保险)
    let settleTimer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        handle.settled,
        new Promise((r) => {
          settleTimer = setTimeout(r, CANCEL_SETTLE_TIMEOUT_MS)
        })
      ])
    } finally {
      if (settleTimer) clearTimeout(settleTimer)
    }
    // 对齐原 /stop 语义:run 中断后同步 interrupt ComfyUI(可能有已提交到
    // 队列/轮询中的任务);失败不阻断取消确认(ComfyUI 可能离线或无任务)。
    let interrupted = false
    try {
      await stopExecution(appStoreManager.getConfig().comfyHost)
      interrupted = true
    } catch (error) {
      logger.warn('agui cancel: ComfyUI interrupt failed', error)
    }
    res.json({ ok: true, cancelled: true, interrupted })
  })

  return router
}
