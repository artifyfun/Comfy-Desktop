/**
 * C-H4 计划步骤卡 + 中途拍板（对标建议 #3：RHTV「方向拍板」/ 星流「方案树选择」）。
 *
 * wb_propose_plan 工具：模型在多步任务执行前把「步骤计划 + 关键分歧点选项」
 * 提给用户。实现：
 *   - 计划以 CUSTOM plan_proposed 下发（前端渲染步骤卡 + 选项按钮）；
 *   - 带 options 时挂起等用户点选（自管 pending 表 + 独立 pendingId，
 *     前端经 interaction-response 以 action='edit' + args={optionId} 回传；
 *     resolvePlanChoice() 唤醒挂起，工具把用户选择返回给模型继续执行）。
 *   - 无 SSE 通道（外部 MCP 客户端）→ 不挂起直接返回 acknowledged。
 *   - fail-safe：run 结束 cancelAllPlans()（对齐 approvalGate.rejectPending）。
 */
import { randomUUID } from 'node:crypto'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text } from './shared'
import type { AGUIEvent } from '../../agui/types'
import { logger } from '../../utils/logger'

// ==================== SSE 桥（threadId → emit；run 生命周期注册/注销） ====================

type PlanEmit = (event: AGUIEvent) => void

const planEmits = new Map<string, PlanEmit>()

export function registerPlanEmit(threadId: string, emit: PlanEmit): void {
  planEmits.set(threadId, emit)
}

export function unregisterPlanEmit(threadId: string): void {
  planEmits.delete(threadId)
}

export function clearPlanEmitsForTest(): void {
  planEmits.clear()
}

// ==================== 挂起的拍板（pendingId → settle） ====================

interface PendingChoice {
  sessionId: string
  settle: (result: { approved: boolean; optionId?: string }) => void
  timer: NodeJS.Timeout
}

/** pendingId → 挂起（跨「工具 Promise」与「interaction-response 端点」两端） */
const pendingChoices = new Map<string, PendingChoice>()

/** 拍板超时（10min，对齐 approvalGate 预算） */
const PLAN_TIMEOUT_MS = 10 * 60 * 1000

/** 用户点选（interaction-response 端点调）：按 sessionId 命中该会话唯一挂起并唤醒 */
export function resolvePlanChoiceBySession(sessionId: string, optionId: string): boolean {
  for (const [id, p] of pendingChoices) {
    if (p.sessionId !== sessionId) continue
    pendingChoices.delete(id)
    clearTimeout(p.timer)
    p.settle({ approved: true, optionId })
    return true
  }
  return false
}

/** run 结束收口：该会话全部挂起按取消结算（对齐 approvalGate.rejectPending） */
export function cancelAllPlans(sessionId: string): number {
  let n = 0
  for (const [id, p] of pendingChoices) {
    if (p.sessionId !== sessionId) continue
    pendingChoices.delete(id)
    clearTimeout(p.timer)
    p.settle({ approved: false })
    n++
  }
  return n
}

// ==================== 工具 ====================

export const planTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_propose_plan',
      description:
        '在执行多步/高影响任务前，把「步骤计划」展示给用户（步骤卡），并可附「关键分歧点选项」让用户拍板。用户点选（或跳过拍板）后本工具才返回，返回值含用户选择——据此继续执行。适用于：多种可行方案（不同风格/模板组合）、批量生成前的参数确认、用户表达模糊需要方向性确认。',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: '计划标题（一句话说明要做什么）' },
          steps: {
            type: 'array',
            description: '执行步骤（按顺序，2~8 步）',
            minItems: 2,
            maxItems: 8,
            items: {
              type: 'object',
              properties: {
                title: { type: 'string', description: '步骤名（简洁）' },
                detail: { type: 'string', description: '一句话说明（可选）' }
              },
              required: ['title'],
              additionalProperties: false
            }
          },
          options: {
            type: 'array',
            description:
              '可选：关键分歧点选项（2~4 个）。提供时用户必须点选其一，工具返回所选 optionId；不提供则仅展示计划，直接返回 acknowledged。',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              properties: {
                optionId: { type: 'string', description: '选项 id（模型自定义，如 plan-a）' },
                label: { type: 'string', description: '选项名（展示给用户）' },
                description: { type: 'string', description: '一句话差异说明（可选）' }
              },
              required: ['optionId', 'label'],
              additionalProperties: false
            }
          }
        },
        required: ['title', 'steps'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const title = String(args.title ?? '').slice(0, 120)
      const rawSteps = Array.isArray(args.steps) ? args.steps : []
      const steps = rawSteps.slice(0, 8).map((s, i) => ({
        index: i + 1,
        title: String((s as { title?: unknown })?.title ?? `步骤 ${i + 1}`).slice(0, 80),
        ...(typeof (s as { detail?: unknown })?.detail === 'string'
          ? { detail: String((s as { detail?: unknown }).detail).slice(0, 160) }
          : {})
      }))
      const rawOptions = Array.isArray(args.options) ? args.options : []
      const options = rawOptions.slice(0, 4).map((o, i) => ({
        optionId: String((o as { optionId?: unknown })?.optionId ?? `opt-${i + 1}`),
        label: String((o as { label?: unknown })?.label ?? `方案 ${i + 1}`).slice(0, 60),
        ...(typeof (o as { description?: unknown })?.description === 'string'
          ? { description: String((o as { description?: unknown }).description).slice(0, 120) }
          : {})
      }))

      const emit = planEmits.get(sessionId)

      // 无选项：纯展示（fire-and-forget），模型自行继续
      if (options.length < 2) {
        if (emit) {
          emit({
            type: 'CUSTOM',
            name: 'plan_proposed',
            value: { title, steps, sessionId }
          } as never)
        }
        return text({
          ok: true,
          acknowledged: true,
          note: '计划已展示给用户（无拍板项）。请按计划继续执行。'
        })
      }

      // 有分歧点：先收口该会话的旧挂起(防多卡并存),再登记新挂起
      cancelAllPlans(sessionId)
      const pendingId = randomUUID()
      logger.info(`[planTools] 挂起 pendingId=${pendingId} sessionId=${sessionId}`)
      if (emit) {
        emit({
          type: 'CUSTOM',
          name: 'plan_proposed',
          value: { title, steps, options, sessionId, requestId: pendingId }
        } as never)
      } else {
        pendingChoices.delete(pendingId)
        return text({
          ok: true,
          acknowledged: true,
          note: '当前无活跃画布会话通道，计划无法展示。请按最保守方案继续或向用户询问。'
        })
      }
      const choice = await new Promise<{ approved: boolean; optionId?: string }>((settle) => {
        const timer = setTimeout(() => {
          pendingChoices.delete(pendingId)
          settle({ approved: false })
        }, PLAN_TIMEOUT_MS)
        timer.unref?.()
        pendingChoices.set(pendingId, { sessionId, settle, timer })
      })
      if (!choice.approved) {
        return text({
          ok: false,
          cancelled: true,
          note: '用户未拍板（跳过/超时）。不要臆测选择；改用最保守方案或向用户询问。'
        })
      }
      const selected = options.find((o) => o.optionId === choice.optionId) ?? null
      return text({
        ok: true,
        selectedOptionId: choice.optionId,
        selected,
        note: '用户已拍板。请严格按所选方案继续执行。'
      })
    }
  }
]
