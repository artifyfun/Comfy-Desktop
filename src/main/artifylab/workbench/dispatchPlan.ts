/**
 * PLAN 意图分派梯——候选 ③：从 routes/agui.ts L343-535 抽出。
 *
 * 形态：纯分派函数 dispatchPlan(plan, ctx)。全部副作用（SSE 帧/会话留痕/
 * service 调用）经 DispatchContext 注入——路由层提供 emit/note/sendText/
 * finishRun，本模块只做「意图 → 动作序列」的映射，可脱离 SSE 单测。
 *
 * 分派次序（历史行为保持）：
 * 1. 预设意图约束（硬校验，violation → wb_invalid + RUN_ERROR）
 * 2. 结构性校验（validatePlanLocal → wb_invalid）
 * 3. memory / chat·text / workflow / canvas-run / canvas-ops（各终帧收口）
 * 4. 编排去重（consumeOrchestratedFlag → wb_submitted）
 * 5. 模板不存在 → wb_invalid
 * 6. 媒体执行：远端校验 → ensure-tab wb_sync → batch/单次执行
 */
import type { WorkbenchPlan, PlanValidationIssue } from './plan'
import { validatePlanLocal } from './plan'
import { promptToWorkflowGraph, type WorkflowTemplate } from './templateCore'

/** 模板画布布局:有保存的 UI graph 直接用,否则 prompt 兜底转换 */
function templateWorkflow(tpl: WorkflowTemplate): unknown {
  return tpl.workflow && Array.isArray((tpl.workflow as { nodes?: unknown }).nodes)
    ? tpl.workflow
    : promptToWorkflowGraph(tpl.prompt)
}

/** 路由层提供的副作用接口（SSE 帧 + 会话留痕 + 收口） */
export interface DispatchContext {
  threadId: string
  /** AG-UI CUSTOM 帧（wb_plan/wb_invalid/wb_sync/...） */
  emitCustom(event: string, data: unknown): void
  /** 会话留痕（kind: chat/progress/error） */
  note(kind: 'chat' | 'progress' | 'error', text: string): void
  /** TEXT_MESSAGE 帧 + 留痕的复合出口 */
  sendText(text: string): void
  /** RUN_FINISHED 终帧 + 产物补发 */
  finishRun(): void
  /** 校验失败统一出口：wb_invalid + RUN_ERROR + flushArtifacts */
  businessInvalid(payload: unknown, message: string): void
  // ---- service 面 ----
  listTemplates(sessionId: string): WorkflowTemplate[]
  validateRemote(plan: WorkbenchPlan, template: WorkflowTemplate): Promise<PlanValidationIssue[]>
  execute(
    plan: WorkbenchPlan,
    template: WorkflowTemplate
  ): Promise<{ promptId: string; templateId: string; status: string }>
  executeBatch(
    plan: WorkbenchPlan,
    template: WorkflowTemplate
  ): Promise<{ jobId: string; total: number }>
  appendBatchExecution(templateId: string, jobId: string, total: number): void
  patchDebugExecution(
    promptId: string,
    patch: { promptId?: string; templateId?: string; executionStatus?: string }
  ): void
  consumeOrchestratedFlag(): boolean
  rememberMemory(key: string, value: string): void
  forgetMemory(key: string): boolean
  /** force=true 跳过 VRAM 拦截 */
  force: boolean
}

/**
 * 分派一个已解析的 PLAN。返回 void——所有产出经 ctx 副作用。
 * 调用方负责 decide 失败/no-plan 分支；本函数只处理「PLAN 存在」的路径。
 */
export async function dispatchPlan(
  plan: WorkbenchPlan,
  issues: PlanValidationIssue[],
  ctx: DispatchContext
): Promise<void> {
  // 预设意图约束是硬校验:codex 违反预设(如 text-to-image 预设下输出 text)
  // 时立即拦截并回显,而不是继续执行/回复
  const presetIssue = issues.find((i) => i.field === 'intent')
  if (presetIssue) {
    ctx.businessInvalid({ issues: [presetIssue] }, `PLAN 违反预设意图约束：${presetIssue.message}`)
    return
  }
  const local = validatePlanLocal(plan, ctx.listTemplates(ctx.threadId))
  if (!local.ok) {
    // 结构性非法的 PLAN 先于 reply/execution 拦截
    const errText = `PLAN 无效：${local.issues.map((i) => i.message).join('；')}`
    ctx.note('error', errText)
    ctx.businessInvalid({ issues: local.issues }, errText)
    return
  }
  if (plan.intent === 'memory' && plan.memory) {
    // 长期记忆(dsh memory 语义):执行 remember/forget,确认文案下发
    const { action, key, value } = plan.memory
    const ok =
      action === 'remember' ? (ctx.rememberMemory(key, value ?? ''), true) : ctx.forgetMemory(key)
    const confirmText =
      action === 'remember'
        ? `已记住【${key}】：${value}`
        : ok
          ? `已忘掉【${key}】`
          : `没有找到记忆【${key}】，未删除任何内容`
    ctx.note('chat', confirmText)
    ctx.sendText(confirmText)
    ctx.finishRun()
    return
  }
  if (plan.intent === 'chat' || plan.intent === 'text') {
    const reply = plan.reply ?? ''
    ctx.note('chat', reply)
    ctx.sendText(reply)
    ctx.finishRun()
    return
  }
  if (plan.intent === 'workflow') {
    // 同步模板工作流到宿主画布:UI graph({nodes,links})经 CUSTOM wb_sync 下发,
    // 前端走注入桥 artify:canvas-ops loadWorkflow 整图加载;无保存布局时
    // 用 prompt 兜底转换,保证节点能上画布
    const tpl = local.template
    const wf = tpl ? templateWorkflow(tpl) : null
    if (!wf) {
      const msg = `模板「${tpl?.name ?? plan.templateId}」无可用布局，无法同步。`
      ctx.note('chat', msg)
      ctx.sendText(msg)
      ctx.finishRun()
      return
    }
    ctx.emitCustom('wb_sync', {
      templateId: tpl!.id,
      name: tpl!.name,
      workflow: wf,
      ensureTab: true
    })
    const okMsg = `已把「${tpl!.name}」加载到画布。`
    ctx.note('chat', okMsg)
    ctx.sendText(okMsg)
    ctx.finishRun()
    return
  }
  if (plan.intent === 'canvas-run') {
    // 执行画布当前工作流:图在宿主前端,服务端拿不到——下发桥指令
    // (前端 graphToPrompt → /api/canvas/execute 或 /api/canvas/batch),
    // 结果由前端轮询补气泡
    ctx.emitCustom('wb_canvas_exec', {
      requestId: `canvas-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      nodeOverrides: plan.nodeOverrides ?? undefined,
      sessionId: ctx.threadId,
      batch: plan.batch
        ? { items: plan.batch.items, sharedParams: plan.batch.sharedParams }
        : undefined
    })
    const progress = plan.batch ? '画布批量执行中…' : '正在执行画布当前工作流…'
    ctx.note('progress', progress)
    ctx.sendText(progress)
    ctx.finishRun()
    return
  }
  if (plan.intent === 'canvas-ops') {
    // P3 A 画布 app 节点指令集：AI 产出 ops（run_node/add_app_node/
    // update_node/connect_nodes/select_nodes），前端 canvas-embedded
    // 模式经总线到宿主画布页人审执行；产物落布/状态灯由画布页闭环
    ctx.emitCustom('wb_canvas_ops', { ops: plan.canvasOps ?? [] })
    const n = Array.isArray(plan.canvasOps) ? plan.canvasOps.length : 0
    ctx.note('progress', `画布节点指令 ${n} 条已下发，等待画布确认…`)
    ctx.sendText(plan.reply || `已下发 ${n} 条画布节点指令，请在画布上确认执行。`)
    ctx.finishRun()
    return
  }
  if (ctx.consumeOrchestratedFlag()) {
    // 编排去重:codex 在 decide 轮内经 wb_execute_template 真实执行过时,
    // 最终 PLAN 只是「编排总结的载体」——产物/卡片已由工具链路落会话,
    // 跳过重复执行(产物由调用方 flushArtifacts 补发)
    ctx.emitCustom('wb_submitted', { orchestrated: true })
    ctx.sendText(plan.reply ?? '多步编排已完成，产物见上方过程流。')
    ctx.finishRun()
    return
  }
  if (!local.template) {
    ctx.businessInvalid(
      { issues: [{ field: 'templateId', message: '模板不存在' }] },
      'PLAN 无效：模板不存在'
    )
    return
  }
  // 媒体执行意图:远端校验 → 执行前画布 tab 保证 → batch/单次执行
  const template = local.template
  const remote = await ctx.validateRemote(plan, template)
  // force=true 跳过 VRAM 拦截
  const blocking = remote.filter((i) => (ctx.force ? i.field !== 'vram' : true))
  if (blocking.length > 0) {
    ctx.businessInvalid(
      { issues: blocking },
      `校验未通过：${blocking.map((i) => i.message).join('；')}`
    )
    return
  }
  // 执行前画布 tab 保证(ensure-tab):每次执行模板都先把目标工作流
  // 加载到画布——桥判定当前 tab 已是该工作流则复用,否则开新 tab
  ctx.emitCustom('wb_sync', {
    templateId: template.id,
    name: template.name,
    workflow: templateWorkflow(template),
    ensureTab: true
  })
  if (plan.batch) {
    // batch 编排:batchRunner 队列(串行),进度经既有 batch 轮询通道
    const { jobId, total } = await ctx.executeBatch(plan, template)
    ctx.appendBatchExecution(template.id, jobId, total)
    ctx.emitCustom('wb_artifact', {
      promptId: jobId,
      batch: { jobId, total },
      templateId: template.id,
      name: template.name
    })
    const batchMsg = `批量任务已入队：${total} 条，模板「${template.name}」。进度可在批量任务面板查看。`
    ctx.note('chat', batchMsg)
    ctx.sendText(batchMsg)
    ctx.finishRun()
    return
  }
  const execution = await ctx.execute(plan, template)
  // 调试日志回填执行信息(模板/参数/状态)
  ctx.patchDebugExecution(execution.promptId, {
    promptId: execution.promptId,
    templateId: execution.templateId,
    executionStatus: execution.status
  })
  // 提交回执:outputs 在提交时点为空,真实产物由轮询落会话、
  // 下一轮 flushArtifacts 补发(submitted/artifact 两段同构)
  ctx.emitCustom('wb_artifact', {
    promptId: execution.promptId,
    name: execution.templateId,
    outputs: [],
    outputFiles: []
  })
  ctx.note('chat', '已提交到 ComfyUI 队列')
  ctx.sendText('已提交到 ComfyUI 队列')
  ctx.finishRun()
}
