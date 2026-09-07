/**
 * dispatchPlan 单测（候选 ③ test surface）：
 * 意图梯次序（预设硬校验 > 结构校验 > 各意图分支 > 编排去重 > 媒体执行）
 * 用伪造 ctx 记录副作用序列，验证每个分支的帧/留痕/终帧收口。
 */
import { describe, it, expect, vi } from 'vitest'
import { dispatchPlan, type DispatchContext } from './dispatchPlan'
import type { WorkbenchPlan, PlanValidationIssue } from './plan'
import type { WorkflowTemplate } from './templateCore'
import type { ComfyPrompt } from '../appStore'

/** 记录型 ctx：捕获全部副作用调用序列 */
function makeCtx(overrides: Partial<DispatchContext> = {}) {
  const calls: string[] = []
  const ctx: DispatchContext = {
    threadId: 's1',
    emitCustom: (e, d) => calls.push(`custom:${e}:${JSON.stringify(d).slice(0, 60)}`),
    note: (kind, text) => calls.push(`note:${kind}:${text}`),
    sendText: (t) => calls.push(`text:${t}`),
    finishRun: () => calls.push('finish'),
    businessInvalid: (_payload, msg) => calls.push(`invalid:${msg}`),
    listTemplates: () => [],
    validateRemote: vi.fn(async () => []),
    execute: vi.fn(async () => ({ promptId: 'p1', templateId: 't1', status: 'queued' })),
    executeBatch: vi.fn(async () => ({ jobId: 'j1', total: 3 })),
    appendBatchExecution: () => calls.push('appendBatch'),
    patchDebugExecution: () => calls.push('patchDebug'),
    consumeOrchestratedFlag: () => false,
    rememberMemory: (k, v) => calls.push(`remember:${k}=${v}`),
    forgetMemory: (k) => {
      calls.push(`forget:${k}`)
      return true
    },
    force: false,
    ...overrides
  }
  return { ctx, calls }
}

const plan = (over: Partial<WorkbenchPlan>): WorkbenchPlan =>
  ({ intent: 'chat', reason: '', ...over }) as WorkbenchPlan

const tpl = (id: string): WorkflowTemplate =>
  ({
    id,
    name: `模板${id}`,
    mediaType: 'image',
    prompt: { '1': { class_type: 'KSampler', inputs: {} } } as unknown as ComfyPrompt,
    paramsNodes: []
  }) as unknown as WorkflowTemplate

/** 让 validatePlanLocal 通过并命中 template：listTemplates 返回同 id 模板 */
const withTemplate = (t: WorkflowTemplate, over: Partial<DispatchContext> = {}) =>
  makeCtx({
    listTemplates: () => [t],
    ...over
  })

describe('dispatchPlan 次序', () => {
  it('预设意图违反 → wb_invalid，不进入后续分支', async () => {
    const { ctx, calls } = makeCtx()
    const issues: PlanValidationIssue[] = [{ field: 'intent', message: '预设只允许 image' }]
    await dispatchPlan(plan({ intent: 'text' }), issues, ctx)
    expect(calls).toEqual(['invalid:PLAN 违反预设意图约束：预设只允许 image'])
  })

  it('chat 意图 → reply 文本 + finishRun', async () => {
    const { ctx, calls } = makeCtx()
    await dispatchPlan(plan({ intent: 'chat', reply: '你好' }), [], ctx)
    expect(calls).toEqual(['note:chat:你好', 'text:你好', 'finish'])
  })

  it('memory remember → 记忆写入 + 确认文案', async () => {
    const { ctx, calls } = makeCtx()
    await dispatchPlan(
      plan({ intent: 'memory', memory: { action: 'remember', key: '风格', value: '动漫' } }),
      [],
      ctx
    )
    expect(calls[0]).toBe('remember:风格=动漫')
    expect(calls).toContain('text:已记住【风格】：动漫')
    expect(calls[calls.length - 1]).toBe('finish')
  })

  it('memory forget 未命中 → 未删除文案', async () => {
    const { ctx, calls } = makeCtx({ forgetMemory: () => false })
    await dispatchPlan(plan({ intent: 'memory', memory: { action: 'forget', key: 'x' } }), [], ctx)
    expect(calls).toContain('text:没有找到记忆【x】，未删除任何内容')
  })

  it('编排去重：consumeOrchestratedFlag=true → wb_submitted，不执行模板', async () => {
    const t = tpl('t1')
    const { ctx, calls } = withTemplate(t, { consumeOrchestratedFlag: () => true })
    await dispatchPlan(plan({ intent: 'image', templateId: 't1', params: {} }), [], ctx)
    expect(calls[0]).toContain('custom:wb_submitted')
    expect(ctx.execute).not.toHaveBeenCalled()
    expect(calls[calls.length - 1]).toBe('finish')
  })

  it('媒体执行：wb_sync ensure-tab → wb_artifact 提交回执 → finish', async () => {
    const t = tpl('t1')
    const { ctx, calls } = withTemplate(t)
    await dispatchPlan(plan({ intent: 'image', templateId: 't1', params: {} }), [], ctx)
    expect(calls[0]).toContain('custom:wb_sync')
    expect(calls.some((c) => c.startsWith('custom:wb_artifact'))).toBe(true)
    expect(ctx.execute).toHaveBeenCalledOnce()
    expect(calls).toContain('text:已提交到 ComfyUI 队列')
    expect(calls[calls.length - 1]).toBe('finish')
  })

  it('batch 计划 → executeBatch + appendBatchExecution + 入队文案', async () => {
    const t = tpl('t1')
    const { ctx, calls } = withTemplate(t)
    await dispatchPlan(
      plan({
        intent: 'image',
        templateId: 't1',
        params: {},
        batch: { items: [{}, {}, {}] }
      }),
      [],
      ctx
    )
    expect(ctx.executeBatch).toHaveBeenCalledOnce()
    expect(calls).toContain('appendBatch')
    expect(calls.some((c) => c.startsWith('text:批量任务已入队：3 条'))).toBe(true)
    expect(ctx.execute).not.toHaveBeenCalled()
  })

  it('远端校验拦截 → wb_invalid；force 只放行 vram 类', async () => {
    const t = tpl('t1')
    const issues: PlanValidationIssue[] = [
      { field: 'vram', message: '显存不足' },
      { field: 'model', message: '模型缺失' }
    ]
    const { ctx, calls } = withTemplate(t, { validateRemote: async () => issues })
    await dispatchPlan(plan({ intent: 'image', templateId: 't1', params: {} }), [], ctx)
    expect(calls[0]).toBe('invalid:校验未通过：显存不足；模型缺失')

    // force 只豁免 vram：仅剩 vram issue 时放行到执行
    const { ctx: ctx2, calls: calls2 } = withTemplate(t, {
      validateRemote: async () => [{ field: 'vram', message: '显存不足' }],
      force: true
    })
    await dispatchPlan(plan({ intent: 'image', templateId: 't1', params: {} }), [], ctx2)
    expect(calls2[0]).toContain('custom:wb_sync') // vram 被 force 放行
  })
})
