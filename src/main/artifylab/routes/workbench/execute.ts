import type express from 'express'
import multer from 'multer'
import type { Request } from 'express'
import { HTTP_STATUS } from '../../config/constants'
import { logger } from '../../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'
import { workbenchService } from '../../workbench/service'
import { templateLibrary } from '../../workbench/templates'
import { validateNodeOverridesLocal } from '../../workbench/plan'
import type { ComfyPrompt } from '../../appStore'
import appStoreManager from '../../appStore'
import { buildAppCode } from '../../agentDriver'
import { get as getSetting } from '../../../settings'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } })

export function registerExecuteRoutes(router: express.Router): void {
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
      // 记录到会话（跨轮决策注入素材清单用）；无 sessionId 时跳过不阻断
      const sid = String(req.query.sessionId ?? '')
      if (sid) workbenchService.recordSessionAttachment(sid, meta)
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

  // L2 用户侧入口：直接执行某模板/会话变体（高级参数抽屉「立即执行」用）。
  // 与 chat 快路径同一 service.execute 链路（校验、媒体槽、产物落会话一致）。
  router.post('/api/workbench/execute', async (req, res) => {
    const { sessionId, templateId, params } = req.body as {
      sessionId?: string
      templateId?: string
      params?: Record<string, unknown>
    }
    if (!sessionId || !templateId) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('sessionId and templateId required'))
      return
    }
    const template = workbenchService.resolveTemplate(sessionId, templateId)
    if (!template) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('template not found'))
      return
    }
    try {
      const execution = await workbenchService.execute(
        sessionId,
        {
          intent:
            template.mediaType === 'video'
              ? 'video'
              : template.mediaType === 'audio'
                ? 'audio'
                : 'image',
          templateId,
          params: params ?? {}
        },
        template,
        []
      )
      res
        .status(HTTP_STATUS.OK)
        .json(createSuccessResponse({ promptId: execution.promptId, status: execution.status }))
    } catch (error) {
      logger.error('workbench execute failed', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  // L2 用户侧入口：粘贴 workflow JSON 直接跑（spec §4.2/§六）。前端「导入工作流」
  // 用；与 wb_run_workflow 同一执行链路（产物落会话，前端轮询取产物）。
  router.post('/api/workbench/run-workflow', async (req, res) => {
    const { sessionId, workflow, name, seed } = req.body as {
      sessionId?: string
      workflow?: ComfyPrompt
      name?: string
      seed?: number
    }
    if (!sessionId || !workflow || typeof workflow !== 'object' || Array.isArray(workflow)) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('sessionId and workflow (API prompt object) required'))
      return
    }
    try {
      const execution = await workbenchService.executeWorkflow(sessionId, workflow, { name, seed })
      workbenchService.appendMessage(sessionId, {
        role: 'agent',
        kind: 'chat',
        text: `已提交导入的工作流${name ? `「${name}」` : ''}到 ComfyUI 队列`
      })
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          promptId: execution.promptId,
          status: execution.status
        })
      )
    } catch (error) {
      logger.error('workbench run-workflow failed', error)
      res
        .status(HTTP_STATUS.INTERNAL_SERVER_ERROR)
        .json(createErrorResponse((error as Error).message))
    }
  })

  // L2 用户侧入口：模板派生会话级变体（固化 nodeOverrides，可再跑/再改/固化）。
  // validateOnly=true 时只校验 nodeOverrides 不落模板（前端高级参数抽屉预检用）。
  router.post('/api/workbench/clone-template', (req, res) => {
    const { sessionId, templateId, nodeOverrides, validateOnly } = req.body as {
      sessionId?: string
      templateId?: string
      nodeOverrides?: Record<
        string,
        { class_type?: string; widgetOverrides?: Record<string, unknown> }
      >
      validateOnly?: boolean
    }
    if (!sessionId || !templateId) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('sessionId and templateId required'))
      return
    }
    const template = workbenchService.resolveTemplate(sessionId, templateId)
    if (!template) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('template not found'))
      return
    }
    // 预检：不落模板，只返回 issue 清单（前端抽屉实时校验）
    if (validateOnly) {
      const issues = validateNodeOverridesLocal(template.prompt, nodeOverrides ?? {})
      res.status(HTTP_STATUS.OK).json(createSuccessResponse({ ok: issues.length === 0, issues }))
      return
    }
    try {
      const t = workbenchService.cloneTemplate(sessionId, templateId, nodeOverrides)
      res.status(HTTP_STATUS.CREATED).json(
        createSuccessResponse({
          templateId: t!.id,
          name: t!.name,
          nodeCount: Object.keys(t!.prompt).length
        })
      )
    } catch (error) {
      // cloneTemplate 对非法 nodeOverrides 抛可读错误
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse((error as Error).message))
    }
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
}
