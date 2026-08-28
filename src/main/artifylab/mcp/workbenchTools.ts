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
 * - 会话归属由 currentDecideSession 限定（工具只在 decide 轮内可用）；
 * - 记忆工具同 workbench memory intent 语义（key 幂等，≤500 字）。
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import { templateLibrary } from '../workbench/templates'
import { validatePlanLocal, type WorkbenchPlan } from '../workbench/plan'
import { workbenchService } from '../workbench/service'
import type { ToolHandler, ToolRegistry } from './tools'

/** 当前 decide 会话（工具执行上下文）。decide 开始时置位，结束后清空。 */
let currentDecideSession: string | null = null

/** decide 入口置位（嵌套保护：外层会话优先，内层不清掉外层） */
export function beginWorkbenchToolContext(sessionId: string): void {
  const session = workbenchService.getSession(sessionId)
  if (!session) throw new Error(`session not found: ${sessionId}`)
  currentDecideSession = currentDecideSession ?? sessionId
}

/** decide 结束清位（only 若仍归属本会话） */
export function endWorkbenchToolContext(sessionId: string): void {
  if (currentDecideSession === sessionId) currentDecideSession = null
}

function requireSession(): string {
  if (!currentDecideSession) throw new Error('workbench tool called outside decide session')
  return currentDecideSession
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

/** wb_execute_template 参数 → WorkbenchPlan（与 decide 快路径同构，命名 snake_case 亲和 MCP） */
function toPlan(args: Record<string, unknown>): WorkbenchPlan {
  const intent = String(args.intent ?? 'image') as WorkbenchPlan['intent']
  return {
    intent,
    templateId: args.template_id ? String(args.template_id) : undefined,
    params: (args.params as Record<string, unknown>) ?? {},
    usePreviousOutput: Boolean(args.use_previous_output),
    reason: args.reason ? String(args.reason) : undefined
  }
}

const WB_TOOLS: Array<{ tool: Tool; fn: ToolHandler }> = [
  {
    tool: {
      name: 'wb_list_templates',
      description:
        '列出工作台模板库（生成类技能）。返回 id/name/mediaType/chainable/参数 schema。多步编排前先看这里选模板。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    fn: async () =>
      text(
        templateLibrary.list().map((t) => ({
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
              options: p.selectedWidget?.options
            }))
        }))
      )
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
          template_id: { type: 'string', description: '模板 id（wb_list_templates 里查）' },
          params: {
            type: 'object',
            description: '模板参数（键=参数名；仅写与默认值不同的键）',
            additionalProperties: true
          },
          use_previous_output: {
            type: 'boolean',
            description: '链式：把本会话上一次执行的产物作为媒体输入'
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
    fn: async (args) => {
      const sessionId = requireSession()
      const plan = toPlan(args)
      const validation = validatePlanLocal(plan, templateLibrary.list())
      if (validation.issues.length > 0 || !validation.template) {
        return text({ ok: false, stage: 'validation', issues: validation.issues })
      }
      const execution = await workbenchService.execute(sessionId, plan, validation.template, [])
      workbenchService.markOrchestrated(sessionId)
      if (args.wait === false) {
        return text({
          ok: true,
          stage: 'submitted',
          prompt_id: execution.promptId,
          status: execution.status
        })
      }
      // wait=true：轮询到终态（与前端 poll 通道同一 service 方法，产物自动落会话）
      const deadline = Date.now() + 10 * 60 * 1000
      for (;;) {
        const r = await workbenchService.pollExecution(sessionId, execution.promptId)
        if (r.status === 'success') {
          return text({
            ok: true,
            stage: 'completed',
            prompt_id: execution.promptId,
            outputs: r.outputs,
            outputs_text: r.outputsText.slice(0, 2000)
          })
        }
        if (r.status === 'error') {
          return text({ ok: false, stage: 'failed', prompt_id: execution.promptId, error: r.error })
        }
        if (Date.now() > deadline) {
          return text({
            ok: false,
            stage: 'timeout',
            prompt_id: execution.promptId,
            error: '10min 超时，可用 wb_poll_execution 稍后再查'
          })
        }
        await new Promise((resolve) => setTimeout(resolve, 3000))
      }
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
    fn: async (args) => {
      const sessionId = requireSession()
      const r = await workbenchService.pollExecution(sessionId, String(args.prompt_id))
      return text({ status: r.status, outputs: r.outputs, error: r.error })
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
    fn: async (args) => {
      requireSession()
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
    fn: async (args) => {
      requireSession()
      const key = String(args.key ?? '').trim()
      const ok = key ? workbenchService.forgetMemory(key) : false
      return text({ ok, key })
    }
  }
]

/**
 * 组合 registry：现有 MCP registry（外部 app 工具）+ 工作台编排工具（wb_*）。
 * /mcp 端点继续服务外部客户端（无 wb 上下文时 wb_* 返回明确错误）；
 * decide 链路用同一个端点+token，工具调用落在当前 decide 会话上。
 */
export function createWorkbenchAugmentedRegistry(base: ToolRegistry): ToolRegistry {
  return {
    list: () => [...base.list(), ...WB_TOOLS.map((w) => w.tool)],
    handle: async (name, args) => {
      const wb = WB_TOOLS.find((w) => w.tool.name === name)
      if (wb) return wb.fn(args ?? {})
      return base.handle(name, args)
    },
    sync: () => base.sync()
  }
}
