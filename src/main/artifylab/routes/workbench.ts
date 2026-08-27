/**
 * 工作台路由（workbench-plan.md §4）。
 *
 * - GET  /api/workbench/templates        模板清单（含元数据与模型可用性）
 * - GET  /api/workbench/sessions         会话列表
 * - POST /api/workbench/sessions/create  建会话
 * - POST /api/workbench/sessions/delete  删会话
 * - POST /api/workbench/chat             SSE：决策→校验→执行→轮询产物
 * - POST /api/workbench/publish          固化成 app（模板+参数快照→createApp→build-app）
 *
 * SSE/超时/并发锁模式复用 build-app 路由的形态（10min 总超时、finally 清理）。
 */
import express from 'express'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { templateLibrary } from '../workbench/templates'
import { workbenchService } from '../workbench/service'
import { validatePlanLocal } from '../workbench/plan'
import { buildAppCode } from '../agentDriver'
import appStoreManager from '../appStore'

/** chat SSE 总超时：决策 + 校验 + 提交（轮询产物由前端持续 poll，不占此窗口） */
const CHAT_TIMEOUT_MS = 5 * 60 * 1000
/** 并发锁：同一时刻一个决策会话（codex 子进程开销大） */
let chatInFlight = false

export function createWorkbenchRouter(): express.Router {
  const router = express.Router()

  router.get('/api/workbench/templates', (_req, res) => {
    res.json(createSuccessResponse(templateLibrary.list()))
  })

  router.get('/api/workbench/sessions', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listSessions()))
  })

  router.post('/api/workbench/sessions/create', (req, res) => {
    const title = (req.body as { title?: string })?.title || '新会话'
    res
      .status(HTTP_STATUS.CREATED)
      .json(createSuccessResponse(workbenchService.createSession(title)))
  })

  router.post('/api/workbench/sessions/delete', (req, res) => {
    const id = (req.body as { id?: string })?.id
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    const ok = workbenchService.deleteSession(id)
    if (!ok) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('session not found'))
      return
    }
    res.json(createSuccessResponse({ deleted: true }))
  })

  router.get('/api/workbench/session/:id', (req, res) => {
    const session = workbenchService.getSession(req.params.id ?? '')
    if (!session) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('session not found'))
      return
    }
    res.json(createSuccessResponse(session))
  })

  // 决策+执行 SSE
  router.post('/api/workbench/chat', async (req, res) => {
    if (chatInFlight) {
      res
        .status(HTTP_STATUS.CONFLICT)
        .json(createErrorResponse('Another workbench chat is running, please wait'))
      return
    }
    const { sessionId, input, force } = req.body as {
      sessionId?: string
      input?: string
      force?: boolean
    }
    if (!sessionId || !input) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('sessionId and input required'))
      return
    }

    res.setHeader('Content-Type', 'text/event-stream')
    res.setHeader('Cache-Control', 'no-cache')
    res.setHeader('Connection', 'keep-alive')
    res.setHeader('X-Accel-Buffering', 'no')
    res.flushHeaders()

    const send = (event: string, data: unknown): void => {
      if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }

    chatInFlight = true
    const ac = new AbortController()
    const timeout = setTimeout(() => ac.abort(), CHAT_TIMEOUT_MS)
    res.on('close', () => ac.abort())
    try {
      send('stage', { stage: 'deciding' })
      const { plan, issues, raw } = await workbenchService.decide(sessionId, input, () => {})
      if (!plan) {
        send('error', { message: 'codex 未输出可解析的 PLAN', raw: raw.slice(0, 2000) })
        res.end()
        return
      }
      send('plan', { plan, localIssues: issues })

      const local = validatePlanLocal(plan, templateLibrary.list())
      if (plan.intent === 'chat' || plan.intent === 'text') {
        send('reply', { intent: plan.intent, reply: plan.reply ?? '' })
        res.end()
        return
      }
      if (!local.ok || !local.template) {
        send('invalid', { issues: local.issues })
        res.end()
        return
      }
      // 远端校验（object_info / models / VRAM）；force=true 跳过 VRAM
      send('stage', { stage: 'validating' })
      const remote = await workbenchService.validateRemote(plan, local.template)
      const blocking = remote.filter((i) => (force ? i.field !== 'vram' : true))
      if (blocking.length > 0) {
        send('invalid', { issues: blocking })
        res.end()
        return
      }
      // 执行
      send('stage', { stage: 'executing', template: local.template.name })
      const execution = await workbenchService.execute(sessionId, plan, local.template)
      send('submitted', {
        promptId: execution.promptId,
        templateId: execution.templateId,
        params: execution.params
      })
      res.end()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('workbench chat failed', error)
      send('error', { message })
    } finally {
      clearTimeout(timeout)
      chatInFlight = false
      if (!res.writableEnded) res.end()
    }
  })

  // 轮询执行状态（前端定时调，成功后拿产物）
  router.post('/api/workbench/poll', async (req, res) => {
    const { sessionId, promptId } = req.body as { sessionId?: string; promptId?: string }
    if (!sessionId || !promptId) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('sessionId and promptId required'))
      return
    }
    const result = await workbenchService.pollExecution(sessionId, promptId)
    res.json(createSuccessResponse(result))
  })

  // 固化成 app：参数快照 → createApp（html 走 build-app）
  router.post('/api/workbench/publish', async (req, res) => {
    const { sessionId, promptId, name, style, buildUi } = req.body as {
      sessionId?: string
      promptId?: string
      name?: string
      style?: string
      buildUi?: boolean
    }
    if (!sessionId || !promptId || !name) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('sessionId, promptId, name are required'))
      return
    }
    const session = workbenchService.getSession(sessionId)
    const execution = session?.executions.find((e) => e.promptId === promptId)
    if (!execution) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('execution not found'))
      return
    }
    try {
      // buildUi=true 时生成 UI 壳（复用 build-app 的 spec：设计体系注入）
      let html: string | undefined
      if (buildUi) {
        const template = templateLibrary.get(execution.templateId)
        if (!template) {
          res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('template not found'))
          return
        }
        html = await buildAppCode(
          {
            appId: `wb-${execution.promptId.slice(0, 8)}`,
            name,
            description: template.description,
            paramsNodes: template.paramsNodes,
            style,
            provider: 'deepseek',
            apiKey: appStoreManager.getConfig().api_key,
            baseUrl: appStoreManager.getConfig().base_url || ''
          },
          () => {}
        )
      }
      const appId = workbenchService.publishToApp(sessionId, execution, name, html)
      res.status(HTTP_STATUS.CREATED).json(createSuccessResponse({ appId }))
    } catch (error) {
      logger.error('workbench publish failed', error)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse(String(error)))
    }
  })

  return router
}
