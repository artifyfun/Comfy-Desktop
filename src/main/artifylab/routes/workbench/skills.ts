import type express from 'express'
import multer from 'multer'
import { app, shell } from 'electron'
import { join } from 'path'
import { existsSync, mkdirSync } from 'fs'
import { HTTP_STATUS } from '../../config/constants'
import { createErrorResponse, createSuccessResponse } from '../../utils/errorHandler'
import { workbenchService } from '../../workbench/service'
import { defaultSkillLibrary, type SkillSource, type ImportMode } from '../../workbench/skillStore'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 512 * 1024 * 1024 } })

export function registerSkillsRoutes(router: express.Router): void {
  router.get('/api/workbench/skills', (_req, res) => {
    res.json(createSuccessResponse(workbenchService.listSkills()))
  })

  router.get('/api/workbench/skills/read', (req, res) => {
    const name = (req.query as { name?: string }).name ?? ''
    const content = defaultSkillLibrary().read(name)
    if (!content) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('skill not found'))
      return
    }
    res.json(createSuccessResponse(content))
  })

  router.post('/api/workbench/skills/create', (req, res) => {
    const { name, description, body } = req.body as {
      name?: string
      description?: string
      body?: string
    }
    if (!name || description === undefined || body === undefined) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse('name, description and body required'))
      return
    }
    const r = defaultSkillLibrary().create({ name, description, body })
    if (!r.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error ?? 'create failed'))
      return
    }
    res.json(createSuccessResponse({ created: true }))
  })

  router.post('/api/workbench/skills/update', (req, res) => {
    const { name } = req.body as {
      name?: string
      newName?: string
      description?: string
      body?: string
    }
    if (!name) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('name required'))
      return
    }
    const body = req.body as { newName?: string; description?: string; body?: string }
    const r = defaultSkillLibrary().update(name, {
      // 改名走 newName 字段（body.name 是定位键，不是新名字）
      name: body.newName,
      description: body.description,
      body: body.body
    })
    if (!r.ok) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse(r.error ?? 'update failed'))
      return
    }
    // 改名联动：修正所有预设里的捆绑引用（改名不失效）
    let presetsFixed = 0
    if (r.renamedTo) presetsFixed = workbenchService.fixPresetSkillRefs(name, r.renamedTo)
    res.json(createSuccessResponse({ updated: true, renamedTo: r.renamedTo, presetsFixed }))
  })

  router.post('/api/workbench/skills/remove', (req, res) => {
    const { name } = req.body as { name?: string }
    if (!name || !defaultSkillLibrary().remove(name)) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('unknown or builtin skill'))
      return
    }
    res.json(createSuccessResponse({ deleted: true }))
  })

  router.post('/api/workbench/skills/toggle', (req, res) => {
    const { name, enabled } = req.body as { name?: string; enabled?: boolean }
    if (!name || typeof enabled !== 'boolean') {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('name and enabled required'))
      return
    }
    try {
      res.json(createSuccessResponse(defaultSkillLibrary().setEnabled(name, enabled)))
    } catch (e) {
      res
        .status(HTTP_STATUS.BAD_REQUEST)
        .json(createErrorResponse(e instanceof Error ? e.message : 'toggle failed'))
    }
  })

  // 在文件管理器中打开（技能目录 / 库根目录）
  router.post('/api/workbench/skills/open-folder', (req, res) => {
    const { name } = req.body as { name?: string }
    const lib = defaultSkillLibrary()
    const info = name ? lib.list().find((s) => s.name === name) : null
    if (name && !info) {
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('skill not found'))
      return
    }
    const dir = info
      ? join(app.getPath('userData'), 'artify-skills', name!)
      : join(app.getPath('userData'), 'artify-skills')
    const target = info?.builtin
      ? [
          process.resourcesPath ? join(process.resourcesPath, 'workbench-skills', name!) : '',
          join(app.getAppPath(), 'src/main/artifylab/public/workbench-skills', name!)
        ].find((p) => p && existsSync(p))
      : dir
    if (!target || !existsSync(target)) {
      // 根目录不存在时先建（首次打开给用户一个空目录）
      if (!name) mkdirSync(dir, { recursive: true })
      else {
        res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('skill folder missing'))
        return
      }
    }
    void shell.openPath(name ? target! : dir)
    res.json(createSuccessResponse({ opened: true }))
  })

  // 扫描本机其它 agent 的技能目录（~/.claude/skills 等）
  router.get('/api/workbench/skills/scan-local', (_req, res) => {
    res.json(createSuccessResponse(defaultSkillLibrary().scanLocalAgents()))
  })

  // 从本机路径导入（扫描勾选 / 手填路径），srcDir 可为技能目录或其父目录
  router.post('/api/workbench/skills/import-dir', (req, res) => {
    const { srcPath, source, mode } = req.body as {
      srcPath?: string
      source?: string
      mode?: string
    }
    if (!srcPath) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('srcPath required'))
      return
    }
    const r = defaultSkillLibrary().importFromDir(
      srcPath,
      (source as SkillSource) || 'local',
      (mode as ImportMode) || 'skip'
    )
    res.json(createSuccessResponse(r))
  })

  // 文件导入：.md（单技能全文）或 .zip（标准 <name>/SKILL.md 结构）
  router.post('/api/workbench/skills/import', upload.single('file'), (req, res) => {
    const file = req.file
    if (!file?.buffer?.length) {
      res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('file required'))
      return
    }
    const buf = file.buffer
    const source = ((req.body as { source?: string }).source || 'manual') as SkillSource
    const mode = ((req.body as { mode?: string }).mode || 'skip') as ImportMode
    const isZip =
      file.mimetype === 'application/zip' ||
      file.mimetype === 'application/x-zip-compressed' ||
      (file.originalname ?? '').toLowerCase().endsWith('.zip')
    const r = isZip
      ? defaultSkillLibrary().importFromZip(buf, source, mode)
      : defaultSkillLibrary().importFromText(buf.toString('utf8'), source, mode)
    res.json(createSuccessResponse(r))
  })
}
