/**
 * 工作台 → batchRunner 的提交桥（候选 ②：service.executeBatch 出仓）。
 *
 * 单一职责：把 WorkbenchPlan（batch 语义）转成 batchRunner 的
 * startBatch 入参——媒体槽位预检（拦提示词误填路径槽）、链式引用
 * （usePreviousOutput → 首槽）、附件分配（剩余空槽）、行合并（行内值
 * 覆盖 shared、未知键丢弃）与 inputsMapping 派生。
 */
import type { AttachmentMeta } from './presetCore'
import type { WorkbenchPlan } from './plan'
import type { WorkflowTemplate } from './templateCore'
import { assignAttachmentsToSlots } from './presetCore'
import type { AttachmentKind } from './presetCore'
import type { BatchInputNode } from '../services/batchRunner'

/** 槽位描述：参数名 + 接受的附件类型 + 参数节点 */
export interface MediaSlot {
  param: string
  accept: AttachmentKind[]
}

/** 由模板参数节点派生媒体槽位（updater 类组件） */
export function deriveMediaSlots(
  template: WorkflowTemplate,
  acceptKindsFor: (rc: string) => AttachmentKind[]
): MediaSlot[] {
  return template.paramsNodes
    .filter(
      (n) => n.category === 'input' && /image|video|audio|-uploader$/i.test(n.renderComponent ?? '')
    )
    .map((n) => ({ param: n.name ?? '', accept: acceptKindsFor(n.renderComponent ?? '') }))
}

/** 素材槽值形态预检：提示词文本误填路径槽 → 明确报错（与单次执行一致） */
export function detectSuspectMediaSlot(
  shared: Record<string, unknown>,
  slots: MediaSlot[]
): MediaSlot | null {
  return (
    slots.find((m) => {
      const v = shared[m.param]
      if (v == null || typeof v !== 'string') return false
      if (/^(data:|https?:)/i.test(v)) return false
      return v.length > 80 && /\s{2,}|[.?!]\s/.test(v)
    }) ?? null
  )
}

/**
 * 组装 batch 提交载荷。
 *
 * @param deps { lastOutputs, resolveAttachmentRef } —— 链式产物与附件引用
 *        解析由调用方注入（service 持有会话状态）
 * @returns startBatch 所需的 { items, inputsMapping, suspect }；suspect
 *          命中时调用方应抛错（保留原错误文案）
 */
export function buildBatchPayload(
  plan: WorkbenchPlan,
  template: WorkflowTemplate,
  attachments: readonly AttachmentMeta[],
  deps: {
    lastOutputs: Array<{ filename: string }>
    resolveAttachmentRef(a: AttachmentMeta): string | undefined
    acceptKindsFor(rc: string): AttachmentKind[]
  }
): {
  items: Array<Record<string, unknown>>
  inputsMapping: BatchInputNode[]
  suspectParam: string | null
  suspectValue: string | null
} {
  const shared: Record<string, unknown> = {
    ...(plan.params ?? {}),
    ...(plan.batch?.sharedParams ?? {})
  }
  const mediaSlots = deriveMediaSlots(template, deps.acceptKindsFor)
  const suspect = detectSuspectMediaSlot(shared, mediaSlots)
  if (suspect) {
    return {
      items: [],
      inputsMapping: [],
      suspectParam: suspect.param,
      suspectValue: String(shared[suspect.param]).slice(0, 50)
    }
  }
  if (plan.usePreviousOutput) {
    const last = deps.lastOutputs
    if (last.length > 0 && mediaSlots[0]) {
      shared[mediaSlots[0]!.param] = last[0]
    }
  }
  if (attachments.length > 0 && mediaSlots.length > 0) {
    const occupied = new Set(
      mediaSlots.filter((m) => shared[m.param] !== undefined).map((m) => m.param)
    )
    const freeSlots = mediaSlots.filter((m) => !occupied.has(m.param))
    const { assignments } = assignAttachmentsToSlots(
      attachments as AttachmentMeta[],
      freeSlots.map((m) => ({ param: m.param, accept: m.accept }))
    )
    for (const a of assignments) {
      if (a.slot.param) shared[a.slot.param] = deps.resolveAttachmentRef(a.attachment)
    }
  }
  const inputNodes = template.paramsNodes.filter((n) => n.category === 'input')
  const nodeByName = new Map(inputNodes.map((n) => [n.name, n]))
  const items = (plan.batch?.items ?? []).map((row) => {
    const clean: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(row ?? {})) {
      if (nodeByName.has(k)) clean[k] = v
    }
    return { ...shared, ...clean }
  })
  const inputsMapping: BatchInputNode[] = inputNodes.map((n, i) => ({
    id: n.id,
    key: n.name ?? `param${i}`,
    category: 'input',
    valueType: String(n.selectedWidget?.type ?? n.type ?? ''),
    valueMap: { key: n.name ?? `param${i}` }
  }))
  return { items, inputsMapping, suspectParam: null, suspectValue: null }
}
