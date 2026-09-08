/**
 * 执行轮询与副作用分派（composable）——workbench/index.vue 拆分（第一批①a）。
 *
 * - applyExecutionSideEffect：legacy SSE artifact/sync/canvas-exec/invalid 与
 *   AG-UI 桥 CUSTOM wb_artifact/wb_sync/wb_canvas_exec/wb_invalid 共用同一实现
 * - startPoll/stopPoll：单次执行轮询（3s，产物/错误原位回填占位气泡）
 * - startBatchPoll/stopBatchPoll：批量任务轮询（2.5s，进度条+产物汇聚）
 * - extractFiles：ComfyUI outputs → 文件引用列表
 * 依赖经 deps 注入（pushMsg/scrollToBottom/autoRecover/diagnose 等）。
 */
import { computed } from 'vue'

/** ComfyUI history outputs → 文件引用列表（images/gifs 两键） */
export function extractFiles(outputs) {
  const files = []
  for (const v of Object.values(outputs ?? {})) {
    const o = v ?? {}
    for (const key of ['images', 'gifs']) {
      for (const it of o[key] ?? []) {
        if (it.filename)
          files.push({ filename: it.filename, subfolder: it.subfolder, type: it.type })
      }
    }
  }
  return files
}

/**
 * @param deps { messages, artifacts, sessionId, executingCount, execProgressIndex,
 *               pollTimers, t, pushMsg, scrollToBottom, loadSessions, sessions,
 *               autoRecover, diagnoseArtifact, pushCardsToCanvas, executeApi,
 *               pendingIssues, isCanvasEmbedded, emitOps, dismissDecidingProgress,
 *               syncWorkflowToCanvas, runCanvasOnHost }
 */
export function useExecutionPolling(deps) {
  const {
    artifacts,
    sessionId,
    executingCount,
    execProgressIndex,
    pollTimers,
    t,
    pushMsg,
    scrollToBottom,
    loadSessions,
    sessions,
    autoRecover,
    diagnoseArtifact,
    pushCardsToCanvas,
    messages,
    executeApi,
  } = deps

  /**
   * 执行类副作用统一分派(legacy SSE artifact/sync/canvas-exec/invalid 与
   * AG-UI 桥 CUSTOM wb_artifact/wb_sync/wb_canvas_exec/wb_invalid 共用同一实现,
   * 消息模型与行为逐字节对齐——两条管线只差事件来源,不差功能)。
   * kind:'artifact'|'sync'|'canvas-ops'|'canvas-exec'|'invalid'
   */
  function applyExecutionSideEffect(kind, data) {
    if (kind === 'artifact') {
      // 工具执行（自组工作流 wb_run_workflow / wb_execute_template wait=true）产物补推：
      // pollExecution 落盘 artifact 消息但不推 SSE，前端实时无图。去重：已有同
      // promptId 的 artifact 消息则跳过（模板/画布执行的前端轮询已原位升级显示）。
      const files = data.outputFiles || []
      if (!files.length) return
      if (messages.value.some((m) => m.kind === 'artifact' && m.promptId === data.promptId)) return
      pushMsg({
        role: 'agent',
        kind: 'artifact',
        text: `产物 ${files.length} 个文件`,
        outputs: files.map((f) => f.filename),
        outputFiles: files,
        promptId: data.promptId,
        createdAt: Date.now(),
      })
      return
    }
    if (kind === 'sync') {
      // 模板工作流 → 宿主画布。ensureTab（执行前自动加载）失败只降级不打断
      // 生成流程；显式同步失败仍补错误气泡。
      deps.syncWorkflowToCanvas(data).catch((e) => {
        if (data.ensureTab) {
          console.warn('[workbench] ensure-tab skipped:', e)
          return
        }
        pushMsg({
          role: 'agent',
          kind: 'error',
          text: t('workbenchSyncFailed') + ': ' + (e?.message || String(e)),
          createdAt: Date.now(),
        })
      })
      return
    }
    if (kind === 'canvas-ops') {
      // P3 A 画布 app 节点指令集：canvas-embedded 模式经总线推给宿主画布页
      // （人审确认卡 → 执行）；embed/独立页无宿主画布，提示不可用
      const ops = Array.isArray(data?.ops) ? data.ops : []
      if (!ops.length) return
      if (deps.isCanvasEmbedded.value) {
        deps.emitOps(ops)
        pushMsg({
          role: 'agent',
          kind: 'chat',
          text: t('workbenchCanvasOpsSent').replace('{n}', String(ops.length)),
          createdAt: Date.now(),
        })
      } else {
        pushMsg({
          role: 'agent',
          kind: 'error',
          text: t('workbenchCanvasOpsNoHost'),
          createdAt: Date.now(),
        })
      }
      return
    }
    if (kind === 'canvas-exec') {
      // 执行画布当前工作流：前端 → 注入桥 graphToPrompt → 服务端提交 → ack
      deps
        .runCanvasOnHost(data)
        .then((r) => {
          deps.dismissDecidingProgress()
          if (r.batch) {
            artifacts.value.unshift({
              promptId: r.jobId,
              templateId: '画布批量',
              templateName: '画布批量',
              status: 'running',
              error: '',
              outputs: [],
              files: [],
            })
            startBatchPoll(r.jobId)
            pushMsg({
              role: 'agent',
              kind: 'chat',
              text: t('workbenchCanvasBatchQueued'),
              createdAt: Date.now(),
            })
          } else {
            artifacts.value.unshift({
              promptId: r.promptId,
              templateId: '画布当前工作流',
              templateName: '画布当前工作流',
              status: 'running',
              error: '',
              outputs: [],
              files: [],
            })
            const msg = pushMsg({
              role: 'agent',
              kind: 'progress',
              text: t('workbenchExecuting'),
              createdAt: Date.now(),
            })
            execProgressIndex.set(r.promptId, msg._key)
            executingCount.value++
            startPoll(r.promptId)
            pushMsg({
              role: 'agent',
              kind: 'chat',
              text: t('workbenchCanvasRunQueued'),
              createdAt: Date.now(),
            })
          }
          scrollToBottom()
        })
        .catch((e) => {
          deps.dismissDecidingProgress()
          pushMsg({
            role: 'agent',
            kind: 'error',
            text: t('workbenchCanvasRunFailed') + ': ' + (e?.message || String(e)),
            createdAt: Date.now(),
          })
        })
      return
    }
    if (kind === 'invalid') {
      deps.pendingIssues.value = data.issues ?? []
      pushMsg({
        role: 'agent',
        kind: 'error',
        text:
          t('workbenchPlanInvalid') + ': ' + (data.issues ?? []).map((i) => i.message).join('；'),
        createdAt: Date.now(),
      })
    }
  }

  // 批量任务轮询:进度/产物经 batch API 汇入产物卡(同一张卡,进度条展示)
  function startBatchPoll(promptId) {
    const poll = async () => {
      try {
        const { executeApi } = deps
        const { json } = await executeApi.batchStatus(promptId)
        const job = json?.data?.job ?? json?.data
        if (!job) return
        const artifact = artifacts.value.find((a) => a.promptId === promptId)
        if (!artifact) {
          stopBatchPoll(promptId)
          return
        }
        artifact.batchStatus = job.status
        artifact.batchPercent = job.percent
        artifact.batchSuccess = job.success
        artifact.batchFailed = job.failed
        artifact.batchTotal = job.total
        const doneFiles = (job.results ?? [])
          .filter((r) => r.success && r.files)
          .flatMap((r) => r.files)
        if (doneFiles.length) {
          artifact.files = doneFiles
          artifact.outputs = doneFiles.map((f) => f.filename)
        }
        if (['completed', 'stopped', 'failed'].includes(job.status)) {
          artifact.status = job.status === 'completed' ? 'success' : 'error'
          // 批量终态：completed 推 artifact 消息（产物图进回合卡片，窄容器也可见）
          pushMsg(
            job.status === 'completed'
              ? {
                  role: 'agent',
                  kind: 'artifact',
                  text: t('workbenchBatchDone', { total: job.total, success: job.success }),
                  outputs: doneFiles.map((f) => f.filename),
                  outputFiles: doneFiles,
                  createdAt: Date.now(),
                }
              : {
                  role: 'agent',
                  kind: 'error',
                  text: `${t('workbenchFailed')}: 批量任务 ${job.status}`,
                  createdAt: Date.now(),
                },
          )
          scrollToBottom()
          stopBatchPoll(promptId)
        }
      } catch {
        /* 下轮重试 */
      }
    }
    poll()
    pollTimers.set(`batch:${promptId}`, setInterval(poll, 2500))
  }

  function stopBatchPoll(promptId) {
    const timer = pollTimers.get(`batch:${promptId}`)
    if (timer) clearInterval(timer)
    pollTimers.delete(`batch:${promptId}`)
  }

  function startPoll(promptId) {
    const poll = async () => {
      try {
        const { executeApi } = deps
        const { json } = await executeApi.poll(sessionId.value, promptId)
        const r = json?.data
        if (!r) return
        let doneFiles = []
        const artifact = artifacts.value.find((a) => a.promptId === promptId)
        if (artifact) {
          artifact.status = r.status
          if (r.status === 'error') {
            artifact.error = (r.error || '').slice(0, 2000)
            // M4 调试路由：失败即自动分类（异步填 diagnosis，卡片出现后可一键修）
            void diagnoseArtifact(artifact)
          }
          if (r.status === 'success' && r.outputs) {
            doneFiles = extractFiles(r.outputs)
            artifact.outputs = doneFiles.map((f) => f.filename)
            artifact.files = doneFiles
            // embed 模式：执行成功自动把产物铺上画布（用户也可手动补贴）
            pushCardsToCanvas(doneFiles)
          }
        }
        if (r.status === 'success' || r.status === 'error') {
          // 按 _key 原位更新执行占位气泡为最终结果；找不到（重进会话/切会话后
          // 恢复轮询/停止后清理）时兜底 push 新气泡
          const execKey = execProgressIndex.get(promptId)
          execProgressIndex.delete(promptId)
          if (executingCount.value > 0) executingCount.value--
          const execIdx =
            execKey !== undefined ? messages.value.findIndex((m) => m._key === execKey) : -1
          if (execIdx !== -1) {
            // 成功：占位气泡原位升级为 artifact 消息——产物图直接进回合卡片
            // （file part 渲染）；失败：原地转错误文本。
            messages.value[execIdx] =
              r.status === 'success'
                ? {
                    ...messages.value[execIdx],
                    kind: 'artifact',
                    text: doneFiles.length
                      ? `${t('workbenchDone')}（${doneFiles.length} 个文件）`
                      : t('workbenchDone'),
                    outputs: doneFiles.map((f) => f.filename),
                    outputFiles: doneFiles,
                  }
                : {
                    ...messages.value[execIdx],
                    kind: 'error',
                    text: `${t('workbenchFailed')}: ${(r.error || '').slice(0, 300)}`,
                  }
          } else {
            pushMsg(
              r.status === 'success'
                ? {
                    role: 'agent',
                    kind: 'artifact',
                    text: doneFiles.length
                      ? `${t('workbenchDone')}（${doneFiles.length} 个文件）`
                      : t('workbenchDone'),
                    outputs: doneFiles.map((f) => f.filename),
                    outputFiles: doneFiles,
                    createdAt: Date.now(),
                  }
                : {
                    role: 'agent',
                    kind: 'error',
                    text: `${t('workbenchFailed')}: ${(r.error || '').slice(0, 300)}`,
                    createdAt: Date.now(),
                  },
            )
          }
          scrollToBottom()
          stopPoll(promptId)
          // 快路径执行失败：自动发起恢复轮（限次防死循环），让 AI 分析原因并继续
          if (r.status === 'error') void autoRecover(r.error || '')
          loadSessions().then(() => {
            const s = sessions.value.find((x) => x.id === sessionId.value)
            const exec = s?.executions?.find((e) => e.promptId === promptId)
            if (exec) {
              const art = artifacts.value.find((a) => a.promptId === promptId)
              if (art) {
                art.outputs = (exec.outputs ?? []).map((f) =>
                  typeof f === 'string' ? f : f.filename,
                )
                art.files = (exec.outputs ?? []).filter((f) => typeof f === 'object')
              }
            }
          })
        }
      } catch {
        /* 下轮重试 */
      }
    }
    pollTimers.set(promptId, setInterval(poll, 3000))
  }

  function stopPoll(promptId) {
    const timer = pollTimers.get(promptId)
    if (timer) {
      clearInterval(timer)
      pollTimers.delete(promptId)
    }
  }

  return {
    applyExecutionSideEffect,
    startPoll,
    stopPoll,
    startBatchPoll,
    stopBatchPoll,
  }
}
