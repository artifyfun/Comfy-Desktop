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
 * - POST /api/workbench/agent/run        AG-UI SSE 决策→执行（routes/agui.ts，唯一管线）
 * - POST /api/workbench/agent/cancel     停止当前轮（中断决策流 + ComfyUI /interrupt）
 * - POST /api/workbench/run-workflow     L2：粘贴 workflow JSON 直接执行（前端导入入口）
 * - POST /api/workbench/clone-template   L2：模板派生会话级变体（固化 nodeOverrides）
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
import { buildSessionBundle } from '../workbench/sessionBundle'
import { scanOutputDir } from '../gallery/scanner'
import { restoreBundleFiles } from '../workbench/importRestore'
import { validateNodeOverridesLocal } from '../workbench/plan'
import type { ComfyPrompt } from '../appStore'
import { readFileSync } from 'fs'
import { resolve, sep } from 'path'
import { get as getSetting } from '../../settings'
import { buildAppCode } from '../agentDriver'
import appStoreManager from '../appStore'

/** 附件上传 multer（内存态，直接透传 ComfyUI；大小限制交给 executor 的 MAX_MEDIA_BYTES） */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } })

export function createWorkbenchRouter(): express.Router {
  const router = express.Router()

  router.get('/api/workbench/templates', (_req, res) => {
    res.json(createSuccessResponse(templateLibrary.list()))
  })

  // 最近一轮调试快照（前端「复制调试信息」数据源：spec/原始输出/PLAN/校验/执行）
  router.get('/api/workbench/debug/last', (req, res) => {
    const sessionId = (req.query as { sessionId?: string }).sessionId
    if (!sessionId) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('sessionId is required'))
      return
    }
    const log = workbenchService.lastDebugLog(sessionId)
    if (!log) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('no debug log yet'))
      return
    }
    res.json(createSuccessResponse(log))
  })

  router.get('/api/workbench/sessions', (req, res) => {
    const archivedQ = (req.query as { archived?: string }).archived
    const archived = archivedQ === undefined ? undefined : archivedQ === 'true'
    res.json(createSuccessResponse(workbenchService.listSessions(archived)))
  })

  // 会话导出：单会话完整 JSON 下载（schema 版本化，剥 debugLogs/batchJobId）
  router.get('/api/workbench/sessions/:id/export', (req, res) => {
    const file = workbenchService.exportSession(req.params.id ?? '')
    if (!file) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('session not found'))
      return
    }
    // filename*=RFC 5987：中文标题浏览器兼容（ASCII 回退名兜底）
    const asciiName = 'workbench-session-' + file.session.id.slice(0, 8) + '.json'
    const encoded = encodeURIComponent(
      (file.session.title || 'session').replace(/[/:*?"<>|]/g, '_') + '.json'
    )
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`
    )
    res.json(file)
  })

  // 会话导入：JSON 体校验 + 新 UUID 落库
  // 会话完整包导出：session.json + 产物文件 ZIP（STORE 零依赖组包）。
  // 与单会话 JSON 导出共存：?bundle=true 或独立路径，产物文件随包走。
  router.get('/api/workbench/sessions/:id/export-bundle', (req, res) => {
    const session = workbenchService.getSession(req.params.id ?? '')
    if (!session) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('session not found'))
      return
    }
    const outputDir = getSetting('outputDir')
    if (!outputDir) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('outputDir not configured'))
      return
    }
    const r = buildSessionBundle(session, (f) => {
      // 路径穿越防御（safeJoin 同款语义，内联防跨模块导出）
      const rel = f.subfolder ? `${f.subfolder}/${f.filename}` : f.filename
      const segs = rel.split(/[\\/]/).filter(Boolean)
      if (segs.includes('..')) return null
      const full = resolve(outputDir, ...segs)
      if (full !== outputDir && !full.startsWith(outputDir + sep)) return null
      try {
        return readFileSync(full)
      } catch {
        return null
      }
    })
    if (!r.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error))
      return
    }
    const asciiName = 'workbench-session-' + session.id.slice(0, 8) + '-bundle.zip'
    const encoded = encodeURIComponent(
      (session.title || 'session').replace(/[/:*?"<>|]/g, '_') + '.zip'
    )
    res.setHeader('Content-Type', 'application/zip')
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="${asciiName}"; filename*=UTF-8''${encoded}`
    )
    if (r.missing.length > 0) {
      // 缺文件不阻断（历史产物被清理是常态），头里带摘要供前端提示
      res.setHeader('X-Missing-Files', String(r.missing.length))
    }
    res.end(r.zip)
  })

  router.post('/api/workbench/sessions/import', (req, res) => {
    const { force } = (req.body as { force?: boolean }) ?? {}
    const r = workbenchService.importSession(req.body, { force })
    if (!r.ok) {
      // duplicate 语义 409（非 4xx 泛错误）：前端据此弹确认框
      if (r.error === 'duplicate') {
        res
          .status(HTTP_STATUS.CONFLICT)
          .json({ success: false, error: 'duplicate', existing: r.existing })
        return
      }
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error ?? 'import failed'))
      return
    }
    res.status(HTTP_STATUS.CREATED).json(createSuccessResponse(r.session))
  })

  // 会话完整包导入：multipart(zip)。解包 session.json → 既有导入路径（新 UUID）；
  // 产物文件写回 outputDir 对应 subfolder（保持会话引用有效）。ZIP 解析零依赖：
  // 只读 EOCD → 中央目录 → STORE 条目直接切片（组包端是我们自己的 STORE 实现）。
  router.post('/api/workbench/sessions/import-bundle', upload.single('file'), (req, res) => {
    void (async () => {
      const buf = req.file?.buffer
      if (!buf || buf.length < 22) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('zip file required'))
        return
      }
      // EOCD 定位（末 22B，注释最长 64KB 往前扫）
      let eocd = -1
      const scanStart = Math.max(0, buf.length - 22 - 65535)
      for (let i = buf.length - 22; i >= scanStart; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
          eocd = i
          break
        }
      }
      if (eocd < 0) {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid zip'))
        return
      }
      const count = buf.readUInt16LE(eocd + 10)
      let ptr = buf.readUInt32LE(eocd + 16)
      const entries = new Map<string, Buffer>()
      for (let i = 0; i < count; i++) {
        if (buf.readUInt32LE(ptr) !== 0x02014b50) break
        const method = buf.readUInt16LE(ptr + 10)
        const compSize = buf.readUInt32LE(ptr + 20)
        const nameLen = buf.readUInt16LE(ptr + 28)
        const extraLen = buf.readUInt16LE(ptr + 30)
        const commentLen = buf.readUInt16LE(ptr + 32)
        const localOff = buf.readUInt32LE(ptr + 42)
        const name = buf.toString('utf8', ptr + 46, ptr + 46 + nameLen)
        if (method === 0 && name) {
          // 本地头：跳到 data（30 + nameLen + localExtra）
          const lNameLen = buf.readUInt16LE(localOff + 26)
          const lExtraLen = buf.readUInt16LE(localOff + 28)
          const dataStart = localOff + 30 + lNameLen + lExtraLen
          entries.set(name, buf.subarray(dataStart, dataStart + compSize))
        }
        ptr += 46 + nameLen + extraLen + commentLen
      }
      const manifestBuf = entries.get('session.json')
      if (!manifestBuf) {
        res
          .status(HTTP_STATUS.BAD_REQUEST)
          .json(createErrorResponse('session.json missing in bundle'))
        return
      }
      let manifest: {
        session?: unknown
        files?: { path: string; filename?: string; subfolder?: string }[]
      }
      try {
        manifest = JSON.parse(manifestBuf.toString('utf8'))
      } catch {
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('session.json invalid'))
        return
      }
      // 会话数据导入（新 UUID）
      const force = (req.query as { force?: string }).force === '1'
      const r = workbenchService.importSession(manifest, { force })
      if (!r.ok || !r.session) {
        if (r.error === 'duplicate') {
          res
            .status(HTTP_STATUS.CONFLICT)
            .json({ success: false, error: 'duplicate', existing: r.existing })
          return
        }
        res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error ?? 'import failed'))
        return
      }
      // 产物文件写回 outputDir（文件名冲突：新 UUID 前缀防覆盖本机已有产物）
      const outputDir = getSetting('outputDir')
      let filesRestored = 0
      let filesSkipped = 0
      if (outputDir) {
        const { mkdirSync, writeFileSync: wf } = await import('fs')
        const rr = restoreBundleFiles(
          r.session,
          outputDir,
          manifest.files ?? [],
          entries,
          (full, data) => wf(full, data),
          (dir) => mkdirSync(dir, { recursive: true })
        )
        filesRestored = rr.restored.length
        filesSkipped = rr.skipped
        if (filesRestored > 0) {
          workbenchService.touchSession(r.session.id)
          void scanOutputDir().catch((e) => logger.warn('gallery scan after import failed', e))
        }
      }
      res
        .status(HTTP_STATUS.CREATED)
        .json(createSuccessResponse({ ...r.session, filesRestored, filesSkipped }))
    })().catch((e) => {
      logger.warn('workbench import-bundle failed', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse('import failed'))
    })
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
    // 分支视图(dsh 同款):只投影当前激活路径,并附每条的导航信息(变体数/当前变体号)
    const path = workbenchService.activePath(session.id)
    const childCountOf = new Map<number, number>()
    for (const m of session.messages) {
      const pid = m.parentId ?? -1
      if (pid >= 0) childCountOf.set(pid, (childCountOf.get(pid) ?? 0) + 1)
    }
    const activeVariantOf = new Map<number, number>()
    for (const idx of path) {
      const pid = session.messages[idx]?.parentId ?? -1
      if (pid >= 0) {
        const parent = session.messages[pid]!
        const vi = (parent.childrenIds ?? []).indexOf(idx)
        if (vi >= 0) activeVariantOf.set(pid, vi)
      }
    }
    const viewMessages = path.map((idx) => {
      const m = session.messages[idx]!
      const pid = m.parentId ?? -1
      return {
        ...m,
        _idx: idx,
        _variants: pid >= 0 ? (childCountOf.get(pid) ?? 1) : 1,
        _variant: pid >= 0 ? (activeVariantOf.get(pid) ?? 0) : 0
      }
    })
    res.json(
      createSuccessResponse({
        ...session,
        messages: viewMessages,
        branchCount: session.messages.length
      })
    )
  })

  // 分支切换:把 idx 消息切到第 variant 个兄弟分支(dsh < > 语义)
  router.post('/api/workbench/session/:id/branch', (req, res) => {
    const { messageIdx, variant } = req.body as { messageIdx?: number; variant?: number }
    const id = req.params.id ?? ''
    if (typeof messageIdx !== 'number' || typeof variant !== 'number') {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('messageIdx and variant required'))
      return
    }
    // 语义:前端传的是"分叉父消息下标 + 要去的变体号";父下标按存储序
    const ok = workbenchService.switchBranch(id, messageIdx, variant)
    if (!ok) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('branch not found'))
      return
    }
    res.json(createSuccessResponse({ ok: true }))
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

  // 跨会话长期记忆:读取(前端可展示/管理);写入走 decide 的 memory intent
  router.get('/api/workbench/memories', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listMemories()))
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

  return router
}
