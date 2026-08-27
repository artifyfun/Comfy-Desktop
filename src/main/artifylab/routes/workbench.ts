/**
 * 工作台路由（workbench-plan.md §4，v2 扩展见 workbench-plan-v2.md §2.5）。
 *
 * - GET  /api/workbench/templates        模板清单（含元数据与模型可用性）
 * - GET  /api/workbench/sessions         会话列表（?archived=true 过滤归档）
 * - POST /api/workbench/sessions/create  建会话（title + presetId）
 * - POST /api/workbench/sessions/update  会话元信息（title/modelOverride/archived/presetId）
 * - POST /api/workbench/sessions/delete  删会话
 * - GET  /api/workbench/presets          预设清单 + 默认预设
 * - POST /api/workbench/presets/*        预设 CRUD（copy-dialog 语义）
 * - GET  /api/workbench/skills           技能清单（/ 触发器：模板快捷方式，预设点击选择不参与）
 * - GET  /api/workbench/models           可选模型
 * - POST /api/workbench/upload           附件上传（多素材：图/视频/音频）
 * - POST /api/workbench/chat             SSE：决策→校验→执行；done 事件带会话摘要
 * - POST /api/workbench/publish          固化成 app
 *
 * SSE/超时/并发锁模式复用 build-app 路由的形态（finally 清理）。
 */
import express from 'express'
import multer from 'multer'
import type { Request } from 'express'
import { CONFIG, HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'
import { templateLibrary } from '../workbench/templates'
import { workbenchService } from '../workbench/service'
import { validatePlanLocal } from '../workbench/plan'
import type { AttachmentMeta } from '../workbench/presetCore'
import { buildAppCode } from '../agentDriver'
import appStoreManager from '../appStore'
import { get as getSetting } from '../../settings'

/** chat SSE 总超时：决策 + 校验 + 提交（轮询产物由前端持续 poll，不占此窗口） */
const CHAT_TIMEOUT_MS = 5 * 60 * 1000
/** 并发锁：同一时刻一个决策会话（codex 子进程开销大） */
let chatInFlight = false
/** 附件上传 multer（内存态，直接透传 ComfyUI；大小限制交给 executor 的 MAX_MEDIA_BYTES） */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } })

export function createWorkbenchRouter(): express.Router {
  const router = express.Router()

  router.get('/api/workbench/templates', (_req, res) => {
    res.json(createSuccessResponse(templateLibrary.list()))
  })

  router.get('/api/workbench/sessions', (req, res) => {
    const archivedQ = (req.query as { archived?: string }).archived
    const archived = archivedQ === undefined ? undefined : archivedQ === 'true'
    res.json(createSuccessResponse(workbenchService.listSessions(archived)))
  })

  router.post('/api/workbench/sessions/create', (req, res) => {
    const { title, presetId } = (req.body as { title?: string; presetId?: string }) ?? {}
    res
      .status(HTTP_STATUS.CREATED)
      .json(createSuccessResponse(workbenchService.createSession({ title, presetId })))
  })

  router.post('/api/workbench/sessions/update', (req, res) => {
    const { id, title, modelOverride, archived, presetId } = req.body as {
      id?: string
      title?: string
      modelOverride?: { decisionModel?: string; buildModel?: string }
      archived?: boolean
      presetId?: string
    }
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    const updated = workbenchService.updateSession(id, { title, modelOverride, archived, presetId })
    if (!updated) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('session not found'))
      return
    }
    res.json(createSuccessResponse(updated))
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

  // ---------------- 预设（copy-dialog 语义 CRUD） ----------------

  router.get('/api/workbench/presets', (_req, res) => {
    res.json(
      createSuccessResponse({
        presets: workbenchService.listPresets(),
        default: workbenchService.getDefaultPresetId()
      })
    )
  })

  router.post('/api/workbench/presets/create', (req, res) => {
    const { from, id, name } = req.body as { from?: string; id?: string; name?: string }
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    try {
      res
        .status(HTTP_STATUS.CREATED)
        .json(createSuccessResponse(workbenchService.createPreset({ from, id, name })))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'invalid preset'))
    }
  })

  router.post('/api/workbench/presets/delete', (req, res) => {
    const { id } = req.body as { id?: string }
    if (!id) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id is required'))
      return
    }
    const ok = workbenchService.deletePreset(id)
    if (!ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('builtin or unknown preset'))
      return
    }
    res.json(createSuccessResponse({ deleted: true }))
  })

  router.post('/api/workbench/presets/default', (req, res) => {
    const { id } = req.body as { id?: string }
    if (!id || !workbenchService.setDefaultPreset(id)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('unknown preset'))
      return
    }
    res.json(createSuccessResponse({ default: id }))
  })

  // 预设挂技能（dsh preset skills/ 目录语义：捆绑模板推荐池）
  router.post('/api/workbench/presets/skills', (req, res) => {
    const { id, skillIds } = req.body as { id?: string; skillIds?: string[] }
    if (!id || !Array.isArray(skillIds)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('id and skillIds required'))
      return
    }
    try {
      res.json(createSuccessResponse(workbenchService.updatePresetSkills(id, skillIds)))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'update failed'))
    }
  })

  // ---------------- 技能清单（/ 触发器）与模型 ----------------

  router.get('/api/workbench/skills', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listSkills()))
  })

  router.get('/api/workbench/models', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listModels()))
  })

  // 环境快照（工作台自我认知：技能/本地模型/显存/自定义节点）
  router.get('/api/workbench/env', async (_req, res) => {
    try {
      res.json(createSuccessResponse(await workbenchService.getEnvSnapshot()))
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  // ---------------- 附件上传（多素材） ----------------

  // 工作台运行环境:产物磁盘根目录(同机 ComfyUI 时另存为按钮的数据源)。
  // 只暴露 outputDir 一个字符串,无敏感信息。
  // ---------------- 收藏（产物收藏夹） ----------------

  router.get('/api/workbench/favorites', (req: Request, res) => {
    res.json(
      createSuccessResponse(
        workbenchService.listFavorites((req.query.sessionId as string) || undefined)
      )
    )
  })

  router.post('/api/workbench/favorites', async (req: Request, res) => {
    try {
      const { sessionId, promptId, file, note } = req.body as {
        sessionId?: string
        promptId?: string
        file?: { filename: string; subfolder?: string; type?: string }
        note?: string
      }
      if (!sessionId || !promptId || !file?.filename) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('sessionId/promptId/file required'))
        return
      }
      const fav = workbenchService.addFavorite({
        sessionId,
        executionPromptId: promptId,
        file,
        note
      })
      res.json(createSuccessResponse(fav))
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  router.delete('/api/workbench/favorites/:id', (req: Request, res) => {
    const ok = workbenchService.removeFavorite(String(req.params.id ?? ''))
    if (!ok) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('favorite not found'))
      return
    }
    res.json(createSuccessResponse({ ok: true }))
  })

  // ---------------- 内部 API 代理（工作台 → app 内部接口全量打通） ----------------
  // 白名单前缀只含本 Express 自挂的路由（apps/batch/models/config/mcp-config 等）,
  // 明确排除 workbench 自身(防递归)与未知路径(防把 127.0.0.1:3008 当出网跳板)。
  // 工作台前端一律经此代理访问内部能力,不再各自直连。
  const INTERNAL_PREFIXES = [
    '/api/apps',
    '/api/batch',
    '/api/models',
    '/api/config',
    '/api/mcp',
    '/api/notify',
    '/api/history'
  ]
  const LOCAL_EXCLUDED = '/api/workbench'
  router.all('/api/workbench/internal/*', async (req: Request, res) => {
    const restRaw = (req.params as Record<string, string | string[]>)[0] ?? ''
    const rest = Array.isArray(restRaw) ? (restRaw[0] ?? '') : restRaw
    const target = `/${rest}`
    if (
      !INTERNAL_PREFIXES.some((p) => target === p || target.startsWith(p + '/')) ||
      target.startsWith(LOCAL_EXCLUDED)
    ) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('internal path not allowed'))
      return
    }
    // 内置最小转发:目标就是本 server。host 头取请求自带的(浏览器→本机代理)，
    // 兜底 CONFIG.SERVER_HOST:PORT。
    const hostHeader = String(req.headers.host ?? '')
    const authority = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(hostHeader)
      ? hostHeader
      : `127.0.0.1:${CONFIG.PORT}`
    try {
      const url = `http://${authority}${target}`
      const method = req.method.toUpperCase()
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const init: RequestInit = { method, headers }
      if (!['GET', 'HEAD'].includes(method)) {
        init.body = JSON.stringify(req.body ?? {})
      }
      const r = await fetch(url, init)
      const text = await r.text()
      res.status(r.status).type('json').send(text)
    } catch (e) {
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  router.get('/api/workbench/runtime', (_req: Request, res) => {
    try {
      const outputDir = getSetting('outputDir') as string | undefined
      res.json(createSuccessResponse({ outputDir: outputDir ?? null }))
    } catch (e) {
      res.json(createSuccessResponse({ outputDir: null }))
    }
  })

  router.post('/api/workbench/upload', upload.single('file'), async (req: Request, res) => {
    const file = req.file
    if (!file || !file.buffer) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('file is required'))
      return
    }
    try {
      const meta = await workbenchService.uploadAttachment(
        file.buffer,
        file.originalname,
        file.mimetype
      )
      res.status(HTTP_STATUS.CREATED).json(createSuccessResponse(meta))
    } catch (e) {
      const raw = e instanceof Error ? e.message : 'upload failed'
      // ComfyUI 离线是上传失败的最常见根因（上传=转发 ComfyUI /upload/image），
      // undici 的底层 "fetch failed" 对用户没有信息量，翻译成可行动的提示
      const message = /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(raw)
        ? `无法连接 ComfyUI（${appStoreManager.getConfig().comfyHost}），请先启动 ComfyUI 再上传`
        : raw
      logger.warn('workbench upload failed', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse(message))
    }
  })

  // 决策+执行 SSE
  router.post('/api/workbench/chat', async (req, res) => {
    if (chatInFlight) {
      res
        .status(HTTP_STATUS.CONFLICT)
        .json(createErrorResponse('Another workbench chat is running, please wait'))
      return
    }
    const { sessionId, input, force, attachments } = req.body as {
      sessionId?: string
      input?: string
      force?: boolean
      attachments?: AttachmentMeta[]
    }
    if (!sessionId || (!input && !(attachments && attachments.length > 0))) {
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
    // SSE 收尾：附会话摘要供侧栏刷新（不引入 WS）
    const finish = (): void => {
      const session = workbenchService.getSession(sessionId)
      send('done', {
        session: session
          ? {
              id: session.id,
              title: session.title,
              updatedAt: session.updatedAt,
              archived: !!session.archived
            }
          : null
      })
      res.end()
    }
    try {
      send('stage', { stage: 'deciding' })
      const { plan, issues, raw } = await workbenchService.decide(
        sessionId,
        input ?? '',
        (p) => {
          // codex 结构化条目流透传（工具调用/文件改动/搜索/reasoning 实时可见，
          // 抄 codex app-server 条目驱动模型）；普通 log 不再逐次刷「deciding」
          if (p.type === 'thread_event') {
            send('item', { event: p.event })
          }
        },
        attachments ?? []
      )
      if (!plan) {
        send('error', { message: 'codex 未输出可解析的 PLAN', raw: raw.slice(0, 2000) })
        finish()
        return
      }
      send('plan', { plan, localIssues: issues })

      // 预设意图约束是硬校验：codex 违反预设（如 text-to-image 预设下输出 text）
      // 时立即拦截并回显，而不是继续执行/回复
      const presetIssue = issues.find((i) => i.field === 'intent')
      if (presetIssue) {
        send('invalid', { issues: [presetIssue] })
        finish()
        return
      }

      const local = validatePlanLocal(plan, templateLibrary.list())
      if (!local.ok) {
        // 结构性非法的 PLAN 也先于 reply/execution 拦截
        const errText = `PLAN 无效：${local.issues.map((i) => i.message).join('；')}`
        workbenchService.appendMessage(sessionId, { role: 'agent', kind: 'error', text: errText })
        send('invalid', { issues: local.issues })
        finish()
        return
      }
      if (plan.intent === 'chat' || plan.intent === 'text') {
        send('reply', { intent: plan.intent, reply: plan.reply ?? '' })
        finish()
        return
      }
      if (!local.template) {
        send('invalid', { issues: [{ field: 'templateId', message: '模板不存在' }] })
        finish()
        return
      }
      // 远端校验（object_info / models / VRAM）；force=true 跳过 VRAM
      send('stage', { stage: 'validating' })
      const remote = await workbenchService.validateRemote(plan, local.template)
      const blocking = remote.filter((i) => (force ? i.field !== 'vram' : true))
      if (blocking.length > 0) {
        send('invalid', { issues: blocking })
        finish()
        return
      }
      // 执行（batch 编排 vs 单次）
      if (plan.batch) {
        send('stage', { stage: 'executing', template: local.template.name, batch: true })
        const { jobId, total } = await workbenchService.executeBatch(
          sessionId,
          plan,
          local.template,
          attachments ?? []
        )
        // 会话记录一条 batch 执行(产物经 batch 轮询通道;此处先记元信息)
        workbenchService.appendBatchExecution(sessionId, local.template.id, jobId, total)
        send('submitted', {
          promptId: jobId,
          batch: { jobId, total },
          template: local.template.name
        })
        send('reply', {
          intent: plan.intent,
          reply: `批量任务已入队：${total} 条，模板「${local.template.name}」。进度可在批量任务面板查看。`
        })
        finish()
        return
      }
      const execution = await workbenchService.execute(
        sessionId,
        plan,
        local.template,
        attachments ?? []
      )
      send('submitted', {
        promptId: execution.promptId,
        templateId: execution.templateId,
        params: execution.params
      })
      finish()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      logger.error('workbench chat failed', error)
      // 错误落盘:重进会话仍可见（此前仅前端内存,刷新/切会话即丢）
      workbenchService.appendMessage(sessionId, { role: 'agent', kind: 'error', text: message })
      send('error', { message })
      finish()
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
