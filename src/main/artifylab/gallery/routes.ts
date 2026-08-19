import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { get as getSetting } from '../../settings'
import { assetFromRow, getGalleryDb, getGalleryThumbDir } from './db'
import { makeThumb, scanOutputDir } from './scanner'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'

/**
 * /api/gallery/* 路由 + 缩略图静态服务。
 * 挂载在 artifylab server.ts（history() 之前）。
 */
export function createGalleryRouter(): express.Router {
  const router = express.Router()

  // 列表：分页 + app/starred 筛选
  router.post('/api/gallery/list', (req, res) => {
    try {
      const db = getGalleryDb()
      const page = Math.max(1, Number(req.body?.page) || 1)
      const pageSize = Math.min(200, Math.max(1, Number(req.body?.pageSize) || 60))
      const where: string[] = []
      const params: Array<string | number> = []
      if (req.body?.app_id) {
        where.push('app_id = ?')
        params.push(String(req.body.app_id))
      }
      if (req.body?.starred) {
        where.push('starred = 1')
      }
      if (req.body?.q) {
        where.push('(filename LIKE ? OR app_name LIKE ?)')
        const like = `%${String(req.body.q)}%`
        params.push(like, like)
      }
      const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
      const total = (
        db.prepare(`SELECT COUNT(*) AS c FROM assets ${whereSql}`).get(...params) as { c: number }
      ).c
      const rows = db
        .prepare(`SELECT * FROM assets ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, pageSize, (page - 1) * pageSize) as Record<string, unknown>[]
      res.json(
        createSuccessResponse({
          total,
          page,
          pageSize,
          items: rows.map(assetFromRow)
        })
      )
    } catch (e) {
      res.status(500).json(createErrorResponse((e as Error).message))
    }
  })

  // 扫描 output 目录（手动触发；启动时可后台调一次）
  router.post('/api/gallery/scan', async (_req, res) => {
    try {
      const result = await scanOutputDir()
      res.json(createSuccessResponse(result))
    } catch (e) {
      res.status(500).json(createErrorResponse((e as Error).message))
    }
  })

  // 收藏/取消收藏
  router.post('/api/gallery/star', (req, res) => {
    try {
      const { id, starred } = req.body ?? {}
      if (!id) return res.status(400).json(createErrorResponse('id is required'))
      getGalleryDb()
        .prepare('UPDATE assets SET starred = ? WHERE id = ?')
        .run(starred ? 1 : 0, Number(id))
      res.json(createSuccessResponse({ id, starred: !!starred }))
    } catch (e) {
      res.status(500).json(createErrorResponse((e as Error).message))
    }
  })

  // 删除（同时删库记录 + 缩略图；物理文件交给用户/ComfyUI 管理，第一版不删盘）
  router.post('/api/gallery/remove', (req, res) => {
    try {
      const { id } = req.body ?? {}
      if (!id) return res.status(400).json(createErrorResponse('id is required'))
      getGalleryDb().prepare('DELETE FROM assets WHERE id = ?').run(Number(id))
      res.json(createSuccessResponse({ id }))
    } catch (e) {
      res.status(500).json(createErrorResponse((e as Error).message))
    }
  })

  /**
   * 出图成功后由前端调用：写入参数/工作流快照。
   * outputs 为 ComfyUI history 的 outputs 结构（filename/subfolder/type），
   * 前端在 useWorkflow 出图回调处把 (app, inputs, prompt, outputs) 打包上报。
   */
  router.post('/api/gallery/record', (req, res) => {
    try {
      const { app: appMeta, inputs, prompt, outputs } = req.body ?? {}
      if (!Array.isArray(outputs) || outputs.length === 0) {
        return res.status(400).json(createErrorResponse('outputs array is required'))
      }
      const db = getGalleryDb()
      const now = Date.now()
      const ids: number[] = []
      for (const out of outputs) {
        const filename = String(out.filename ?? '')
        if (!filename) continue
        const subfolder = String(out.subfolder ?? '')
        const filepath = subfolder ? `${subfolder}/${filename}` : filename
        // 已存在（扫描器先建过行）则补快照，否则插入
        db.prepare(
          `INSERT INTO assets (filename, subfolder, filepath, type, size, mtime, created_at, app_id, app_name, inputs_json, prompt_json)
             VALUES (?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?)
             ON CONFLICT(filepath) DO UPDATE SET
               app_id = excluded.app_id,
               app_name = excluded.app_name,
               inputs_json = excluded.inputs_json,
               prompt_json = excluded.prompt_json
             RETURNING id`
        ).run(
          filename,
          subfolder,
          filepath,
          String(out.type ?? 'output'),
          now,
          appMeta?.id ?? null,
          appMeta?.name ?? null,
          inputs ? JSON.stringify(inputs) : null,
          prompt ? JSON.stringify(prompt) : null
        )
        const row = db.prepare('SELECT id FROM assets WHERE filepath = ?').get(filepath) as
          | { id: number }
          | undefined
        const id = Number(row?.id ?? 0)
        if (id) ids.push(id)
        // 补尺寸/缩略图（输出目录已知）
        const outputDir = getSetting('outputDir')
        if (outputDir) makeThumb(outputDir, subfolder, filename)
      }
      res.json(createSuccessResponse({ ids }))
    } catch (e) {
      res.status(500).json(createErrorResponse((e as Error).message))
    }
  })

  // 缩略图静态服务（带目录穿越防护）
  router.use('/api/gallery/thumbs', (req, res) => {
    const rel = decodeURIComponent(req.path.replace(/^\//, ''))
    const thumbDir = getGalleryThumbDir()
    const full = path.resolve(thumbDir, rel)
    if (!full.startsWith(thumbDir + path.sep)) {
      return res.status(403).end()
    }
    if (!fs.existsSync(full)) return res.status(404).end()
    res.sendFile(full)
  })

  return router
}
