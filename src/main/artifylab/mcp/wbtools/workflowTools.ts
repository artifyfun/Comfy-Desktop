import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text, pollUntilDone } from './shared'
import { inferFirstMediaSlot } from '../executor'

import { getObjectInfo } from '../../comfyClient'
import {
  validateNodeOverrides,
  validateNodeOverridesLocal,
  validateAgainstObjectInfo,
  type ObjectInfoNode,
  type PlanValidationIssue,
  type WorkbenchPlan
} from '../../workbench/plan'
import { workbenchService } from '../../workbench/service'
import appStoreManager from '../../appStore'
import type { ComfyPrompt } from '../../appStore'

export const workflowTools: Array<{ tool: Tool; fn: WBToolFn }> = [
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
        // object_info 读取已收口 comfyClient（候选 ④）：超时/错误形状统一
        info = (await getObjectInfo()) as unknown as Record<string, ObjectInfoNode>
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
  }
]
