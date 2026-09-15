import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text } from './shared'
import type { WorkbenchPlan } from '../../workbench/plan'
import type { ComfyPrompt, ParamNode } from '../../appStore'
import { listBatchQueue, type BatchJobSummary } from '../../services/batchRunner'

import { workbenchService } from '../../workbench/service'
import { canvasWorkflowStore } from '../../workbench/canvasWorkflowStore'
import { toTemplateId } from '../../workbench/templateCore'

export const lifecycleTools: Array<{ tool: Tool; fn: WBToolFn }> = [
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
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
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
        '把 workflow 固化为模板（进模板库，长期复用）。两种来源：直接给 workflow（API 格式），或给 prompt_id 沉淀「画布上刚跑通的那次执行」（用户在画布上手动搭的工作流无需重传本体）。缺省自动推断输入参数（提示词/seed/steps/尺寸/参考图槽）与输出节点——固化后即可用 wb_execute_template 填参复跑；要精确控制参数面时用 params_nodes 显式覆盖。\n\n新建还是迭代：默认按 name 判断——若模板库里**恰好有一个同名模板**，则视为「迭代它」，写入其新版本（旧版本自动快照，用户可在模板的版本历史里恢复），返回 mode=versioned 与新的 version；没有同名则新建（mode=created）。要强制新建变体而非迭代，传 force_new=true；要明确迭代某个模板，传 app_id（wb_list_templates 可查 id）。\n\n用户对某次画布结果满意、或某条操作链值得反复用时用它沉淀。',
      inputSchema: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description:
              '模板名称。同名唯一时会被视为「迭代既有模板」的判定依据；想另起一个独立模板就换个名字。'
          },
          workflow: {
            type: 'object',
            description: 'API 格式 workflow（与 prompt_id 二选一）',
            additionalProperties: true
          },
          prompt_id: {
            type: 'string',
            description:
              '与 workflow 二选一：沉淀「某次已执行的画布工作流」。用户在画布上手动搭好并跑通后想存成模板时传它（该次执行的 promptId，服务端已存快照），无需重传 workflow。'
          },
          params_nodes: {
            type: 'array',
            description: '可选：显式参数 schema（缺省按输出节点推断）',
            items: { type: 'object' }
          },
          app_id: {
            type: 'string',
            description:
              '可选：明确要迭代（写入新版本）的既有模板 id。给了它就不再看 name 同名。id 不存在会明确报错，不会静默新建。'
          },
          force_new: {
            type: 'boolean',
            description:
              '可选：即使存在同名模板也强制新建一个独立模板（做变体用）。默认 false = 同名唯一时迭代。'
          }
        },
        required: ['name'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const name = String(args.name ?? '').trim()
      if (!name) return text({ ok: false, error: 'name required' })

      // 两种来源：显式 workflow（模型自建/修改的）或 prompt_id（沉淀画布上刚跑通的
      // 那次执行——工作流本体的暂存见 workbench/canvasWorkflowStore.ts，前端零改动）
      let workflow = args.workflow as ComfyPrompt
      let source: 'workflow' | 'canvas' = 'workflow'
      const hasWorkflow = !!workflow && typeof workflow === 'object' && !Array.isArray(workflow)
      if (!hasWorkflow) {
        const promptId = String(args.prompt_id ?? args.promptId ?? '').trim()
        if (!promptId) {
          return text({ ok: false, error: 'workflow（API prompt 对象）或 prompt_id 至少提供一个' })
        }
        const snapshot = canvasWorkflowStore.get(promptId)
        if (!snapshot) {
          return text({
            ok: false,
            error: `未找到 prompt_id=${promptId} 的画布工作流快照（可能已过期，或该次执行来自模板）`,
            hint: '画布快照仅保留最近 30 次执行。可请用户重新在画布上执行一次，或改用 workflow 显式传 API 格式工作流。'
          })
        }
        workflow = snapshot
        source = 'canvas'
      }

      const result = workbenchService.publishWorkflow(
        name,
        workflow,
        args.params_nodes as ParamNode[] | undefined,
        {
          appId: (args.app_id as string | undefined) ?? (args.appId as string | undefined),
          forceNew: args.force_new === true || args.forceNew === true
        }
      )
      // 回传固化后的可填参数名——模型据此告诉用户「这个模板以后能改哪些」
      const inputParams = (result?.app?.template?.paramsNodes ?? [])
        .filter((n) => n.category === 'input')
        .map((n) => n.name)
      return text({
        ok: !!result,
        // 输出统一用规范模板 id（app:<uuid>，与 wb_list_templates 同口径）——
        // 裸 uuid 喂不进 wb_execute_template（它按 templateLibrary 精确匹配）
        app_id: result ? toTemplateId(result.appId) : undefined,
        name,
        source,
        // created / versioned 让模型（与用户）明确刚才发生的是新建还是迭代
        mode: result?.mode,
        version: result?.version,
        input_params: inputParams,
        ...(result ? {} : { error: '目标 App 不存在（app_id 无效），或固化失败' })
      })
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
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
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
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
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
      name: 'wb_list_batch_jobs',
      description:
        '查询批量队列快照（只读、非阻塞）：默认返回全部任务的紧凑进度（id/状态/成败计数/百分比/当前行预览），可传 job_id 看单任务详情（含最近日志尾部与失败行样本）。配合 wb_execute_template 的 batch_items 使用——会话中断后用它找回队列里的任务状态。',
      inputSchema: {
        type: 'object',
        properties: {
          job_id: {
            type: 'string',
            description: '可选：只看某个任务的详情（含最近日志尾部与失败样本）；缺省返回全队列'
          },
          include_results: {
            type: 'boolean',
            description:
              '配合 job_id：返回该任务的逐行结果表（行号/成败/产物文件/错误/耗时）——行级重跑或批量质检前先看这个，不要凭记忆猜行号'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const jobId = args.job_id ? String(args.job_id) : null
      const queue = listBatchQueue()
      // 紧凑投影：剥掉 notifyUrl/autoShutdown/results/logs 等大字段，控上下文体积
      const compact = (j: BatchJobSummary) => ({
        id: j.id,
        status: j.status,
        app_name: j.appName ?? j.appId ?? '',
        total: j.total,
        processed: j.processed,
        success: j.success,
        failed: j.failed,
        percent: j.percent,
        current_preview: j.currentPreview,
        updated_at: j.updatedAt
      })
      if (jobId) {
        const job = queue.find((j) => j.id === jobId)
        if (!job) return text({ ok: false, error: 'job not found' })
        // C-H14 行级结果表: agent 批量质检/行级重跑的数据源(Genspark 表格语义的 agent 侧)
        if (args.include_results === true) {
          const rows = job.results.map((r) => ({
            index: r.index,
            success: r.success,
            files: (r.files ?? []).map((f) => f.filename),
            ...(r.error ? { error: r.error } : {}),
            duration_ms: r.durationMs
          }))
          return text({
            ok: true,
            job_id: job.id,
            app_name: job.appName ?? job.appId ?? '',
            status: job.status,
            total: job.total,
            rows
          })
        }
        const failedSamples = job.results
          .filter((r) => !r.success)
          .slice(0, 5)
          .map((r) => ({ index: r.index, error: r.error ?? 'unknown' }))
        return text({
          ok: true,
          job: {
            ...compact(job),
            recent_logs: job.logs.slice(-10),
            failed_samples: failedSamples
          }
        })
      }
      const running = queue.filter((j) => j.status === 'running').length
      const queued = queue.filter((j) => j.status === 'queued' || j.status === 'paused').length
      return text({ ok: true, running, queued, jobs: queue.map(compact) })
    }
  }
]
