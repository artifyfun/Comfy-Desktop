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
import {
  validateNodeOverrides,
  validateNodeOverridesLocal,
  validatePlanLocal,
  validateAgainstObjectInfo,
  type ObjectInfoNode,
  type WorkbenchPlan,
  type PlanValidationIssue
} from '../workbench/plan'
import { workbenchService } from '../workbench/service'
import { inferFirstMediaSlot } from './executor'
import type { ComfyPrompt, ParamNode } from '../appStore'
import appStoreManager from '../appStore'
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
    nodeOverrides: args.node_overrides as WorkbenchPlan['nodeOverrides'],
    reason: args.reason ? String(args.reason) : undefined
  }
}

/** wait=true 轮询到终态（wb_execute_template / wb_run_workflow 共用） */
async function pollUntilDone(
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

const WB_TOOLS: Array<{ tool: Tool; fn: ToolHandler }> = [
  {
    tool: {
      name: 'wb_list_templates',
      description:
        '列出工作台模板库（生成类技能）。返回 id/name/mediaType/chainable/参数 schema。多步编排前先看这里选模板。',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true }
    },
    fn: async () => {
      const sessionId = requireSession()
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
      const validation = validatePlanLocal(plan, workbenchService.listTemplates(sessionId))
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
      return text(await pollUntilDone(sessionId, execution.promptId))
    }
  },
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
    fn: async (args) => {
      const sessionId = requireSession()
      let info: Record<string, ObjectInfoNode> | null = null
      try {
        const ctrl = new AbortController()
        const timer = setTimeout(() => ctrl.abort(), 10000)
        const res = await fetch(`${appStoreManager.getConfig().comfyHost}/object_info`, {
          signal: ctrl.signal
        })
        clearTimeout(timer)
        if (res.ok) info = (await res.json()) as Record<string, ObjectInfoNode>
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
    fn: async (args) => {
      const sessionId = requireSession()
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
    fn: async (args) => {
      const sessionId = requireSession()
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
  },
  {
    tool: {
      name: 'wb_clone_template',
      description:
        '把模板克隆为会话级变体（可叠加 node_overrides 固化进新 prompt）。返回新模板 id，可继续改/执行/固化。',
      inputSchema: {
        type: 'object',
        properties: {
          template_id: { type: 'string' },
          node_overrides: {
            type: 'object',
            description: '要固化进副本的节点覆盖（可选）',
            additionalProperties: true
          }
        },
        required: ['template_id'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args) => {
      const sessionId = requireSession()
      try {
        const t = workbenchService.cloneTemplate(
          sessionId,
          String(args.template_id),
          args.node_overrides as WorkbenchPlan['nodeOverrides']
        )
        if (!t) return text({ ok: false, error: 'template not found' })
        return text({
          ok: true,
          template_id: t.id,
          name: t.name,
          node_count: Object.keys(t.prompt).length
        })
      } catch (e) {
        return text({ ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
  },
  {
    tool: {
      name: 'wb_publish_workflow',
      description:
        '把自建/修改过的 workflow 固化为新 App（进模板库，长期复用）。复用现有 app 固化链路。',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: '新 App 名称' },
          workflow: {
            type: 'object',
            description: 'API 格式 workflow',
            additionalProperties: true
          },
          params_nodes: {
            type: 'array',
            description: '可选：显式参数 schema（缺省按输出节点推断）',
            items: { type: 'object' }
          }
        },
        required: ['name', 'workflow'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args) => {
      requireSession()
      const name = String(args.name ?? '').trim()
      if (!name) return text({ ok: false, error: 'name required' })
      const workflow = args.workflow as ComfyPrompt
      if (!workflow || typeof workflow !== 'object' || Array.isArray(workflow))
        return text({ ok: false, error: 'workflow（API prompt 对象）required' })
      const app = workbenchService.publishWorkflow(
        name,
        workflow,
        args.params_nodes as ParamNode[] | undefined
      )
      return text({ ok: !!app, app_id: app?.id, name })
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
      name: 'wb_get_outputs',
      description:
        '读取会话最近一次（或指定 prompt_id 的）执行产物文件清单，非阻塞、立即返回。用于执行提交后（wait=false 或跨轮）取产物文件名/引用；要「等跑完再继续」请用 wb_execute_template 的 wait 模式。',
      inputSchema: {
        type: 'object',
        properties: {
          prompt_id: {
            type: 'string',
            description: '可选：指定执行的 prompt_id；缺省返回会话最近一次执行'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args) => {
      const sessionId = requireSession()
      const promptId = args.prompt_id ? String(args.prompt_id) : null
      // 指定 prompt_id：直接查该次执行；缺省：会话最近一次执行
      const session = workbenchService.getSession(sessionId)
      const exec = promptId
        ? session?.executions.find((e) => e.promptId === promptId)
        : workbenchService.lastExecution(sessionId)
      if (!exec) return text({ ok: false, error: 'no execution found' })
      // 还在跑：提示用 wb_poll_execution 轮询（这里不做阻塞等待）
      if (exec.status === 'queued' || exec.status === 'running') {
        return text({
          ok: true,
          status: exec.status,
          prompt_id: exec.promptId,
          hint: 'still running — use wb_poll_execution to await completion'
        })
      }
      return text({
        ok: true,
        status: exec.status,
        prompt_id: exec.promptId,
        outputs: exec.outputs ?? [],
        error: exec.error
      })
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
