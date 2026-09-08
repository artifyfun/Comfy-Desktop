import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text } from './shared'
import type { WorkbenchPlan } from '../../workbench/plan'
import type { ComfyPrompt, ParamNode } from '../../appStore'
import { listBatchQueue, type BatchJobSummary } from '../../services/batchRunner'

import { workbenchService } from '../../workbench/service'

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
    fn: async (args, identity) => {
      requireSession(identity)
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
