import type express from 'express'
import multer from 'multer'
import { HTTP_STATUS } from '../../config/constants'
import { logger } from '../../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'
import { workbenchService } from '../../workbench/service'
import { buildSessionBundle } from '../../workbench/sessionBundle'
import { restoreBundleFiles } from '../../workbench/importRestore'
import { get as getSetting } from '../../../settings'
import { readFileSync } from 'fs'
import { resolve, sep } from 'path'
import { scanOutputDir } from '../../gallery/scanner'

/** 会话导入 multer（zip bundle） */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } })

export function registerSessionsRoutes(router: express.Router): void {
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
    })().catch((e: unknown) => {
      logger.warn('workbench import-bundle failed', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse('import failed'))
    })
  })

  router.post('/api/workbench/sessions/create', (req, res) => {
    const { title, presetId, entry } =
      (req.body as {
        title?: string
        presetId?: string
        entry?: string
      }) ?? {}
    res.status(HTTP_STATUS.CREATED).json(
      createSuccessResponse(
        workbenchService.createSession({
          title: typeof title === 'string' ? title.slice(0, 120) : undefined,
          presetId,
          entry:
            entry === 'workbench' || entry === 'comfy-sidebar' || entry === 'a-canvas'
              ? entry
              : undefined
        })
      )
    )
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
}
