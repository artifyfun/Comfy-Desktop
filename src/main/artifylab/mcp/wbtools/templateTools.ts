import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text, toPlan, pollUntilDone, pollBatchUntilDone } from './shared'

import { workbenchService } from '../../workbench/service'
import { validatePlanLocal } from '../../workbench/plan'

export const templateTools: Array<{ tool: Tool; fn: WBToolFn }> = [
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
  }
]
