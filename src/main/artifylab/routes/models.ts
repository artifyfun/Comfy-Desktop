import fs from 'node:fs'
import path from 'node:path'
import express from 'express'
import { get as getSetting } from '../../settings'
import { HTTP_STATUS } from '../config/constants'
import { logger } from '../utils/logger'
import { createErrorResponse, createSuccessResponse } from '../utils/errorHandler'

/** 模型目录约定子目录（ComfyUI 标准 layout 的常用子集，缺失的跳过） */
const MODEL_SUBDIRS = [
  'checkpoints',
  'loras',
  'vae',
  'embeddings',
  'controlnet',
  'upscale_models',
  'clip_vision',
  'text_encoders',
  'diffusion_models',
  'hypernetworks',
  'style_models',
  'photomaker',
  'gligen',
  'audio_encoders',
  'configs'
]

interface ModelFile {
  /** 相对 models 根的路径，如 checkpoints/foo.safetensors */
  relPath: string
  name: string
  type: string
  size: number
  mtime: number
}

/** safetensors header 解析：返回错误信息（可读即认为文件完好），null = 非本格式 */
export function inspectSafetensorsHeader(
  filePath: string
): { ok: true } | { ok: false; error: string } | null {
  let fd: number | null = null
  try {
    fd = fs.openSync(filePath, 'r')
    const headerLenBuf = Buffer.alloc(8)
    const bytesRead = fs.readSync(fd, headerLenBuf, 0, 8, 0)
    if (bytesRead < 8) return { ok: false, error: 'file too small' }
    const headerLen = Number(headerLenBuf.readBigUInt64LE(0))
    // 上限 100MB header，防异常文件 OOM
    if (headerLen === 0 || headerLen > 100 * 1024 * 1024) {
      return { ok: false, error: `invalid header length ${headerLen}` }
    }
    const fileSize = fs.fstatSync(fd).size
    if (8 + headerLen > fileSize) return { ok: false, error: 'header exceeds file size' }
    const header = Buffer.alloc(Number(headerLen))
    const hRead = fs.readSync(fd, header, 0, header.length, 8)
    if (hRead < header.length) return { ok: false, error: 'header truncated' }
    JSON.parse(header.toString('utf8'))
    return { ok: true }
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  } finally {
    if (fd !== null) fs.closeSync(fd)
  }
}

function* walkModels(dir: string, type: string, depth = 0): Generator<ModelFile> {
  if (depth > 4) return
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      yield* walkModels(full, type, depth + 1)
    } else if (entry.isFile()) {
      let stat: fs.Stats
      try {
        stat = fs.statSync(full)
      } catch {
        continue
      }
      yield {
        relPath: path.join(type, path.relative(dir, full)),
        name: entry.name,
        type,
        size: stat.size,
        mtime: stat.mtimeMs
      }
    }
  }
}

export function createModelsRouter(): express.Router {
  const router = express.Router()

  /**
   * 模型列表 + 统计。
   * body: { type?: string }  省略则返回全部类型
   * 返回 { items, stats: { count, totalSize, byType } }
   */
  router.post('/api/models/list', (req, res) => {
    try {
      const modelsDirs = getSetting('modelsDirs') ?? []
      const typeFilter = req.body?.type
      const items: ModelFile[] = []
      for (const base of modelsDirs) {
        for (const type of MODEL_SUBDIRS) {
          if (typeFilter && type !== typeFilter) continue
          for (const f of walkModels(path.join(base, type), type)) items.push(f)
        }
      }
      const byType: Record<string, { count: number; size: number }> = {}
      let totalSize = 0
      for (const item of items) {
        const entry = (byType[item.type] ??= { count: 0, size: 0 })
        entry.count++
        entry.size += item.size
        totalSize += item.size
      }
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          items,
          stats: { count: items.length, totalSize, byType }
        })
      )
    } catch (e) {
      logger.error('Failed to list models', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  /** 完整性抽检：对 safetensors 文件解析 header，损坏的返回错误。全量较慢，仅对选中文件执行。 */
  router.post('/api/models/verify', (req, res) => {
    try {
      const { relPath } = req.body ?? {}
      if (!relPath) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('relPath is required'))
      }
      const modelsDirs = getSetting('modelsDirs') ?? []
      // 防路径穿越：type 必须是白名单子目录
      const [type = '', ...rest] = String(relPath).split(/[\\/]/)
      if (!MODEL_SUBDIRS.includes(type)) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid type'))
      }
      const rel = rest.join('/')
      if (rel.includes('..')) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid path'))
      }
      let filePath: string | null = null
      for (const base of modelsDirs) {
        const full = path.join(base, relPath)
        if (fs.existsSync(full)) {
          filePath = full
          break
        }
      }
      if (!filePath) {
        return res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('file not found'))
      }
      if (!filePath.endsWith('.safetensors')) {
        return res
          .status(HTTP_STATUS.OK)
          .json(createSuccessResponse({ ok: true, skipped: true, note: 'not safetensors' }))
      }
      const result = inspectSafetensorsHeader(filePath)
      res.status(HTTP_STATUS.OK).json(createSuccessResponse(result))
    } catch (e) {
      logger.error('Failed to verify model', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  /**
   * 重复检测：按 (size, mtime 秒级) 分组，同组视为疑似重复（下载两份）。
   * 注意：不同模型可能碰巧同大小，结果标"疑似"。
   */
  router.post('/api/models/duplicates', (_req, res) => {
    try {
      const modelsDirs = getSetting('modelsDirs') ?? []
      const seen = new Map<string, ModelFile[]>()
      for (const base of modelsDirs) {
        for (const type of MODEL_SUBDIRS) {
          for (const f of walkModels(path.join(base, type), type)) {
            const key = `${f.type}:${f.size}`
            const group = seen.get(key) ?? []
            group.push(f)
            seen.set(key, group)
          }
        }
      }
      const duplicates = [...seen.values()].filter((g) => g.length > 1)
      res.status(HTTP_STATUS.OK).json(
        createSuccessResponse({
          groups: duplicates,
          wastedBytes: duplicates.reduce((acc, g) => acc + (g[0]?.size ?? 0) * (g.length - 1), 0)
        })
      )
    } catch (e) {
      logger.error('Failed to find duplicate models', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  /** 模型缩略/预览：直接 stream 文件（预览 png/webp 旁边可能有同名文件，这里只提供本体） */
  router.get('/api/models/file', (req, res) => {
    try {
      const relPath = String(req.query?.path || '')
      const [type = '', ...rest] = relPath.split(/[\\/]/)
      if (!MODEL_SUBDIRS.includes(type) || rest.join('/').includes('..')) {
        return res.status(HTTP_STATUS.BAD_REQUEST).json(createErrorResponse('invalid path'))
      }
      const modelsDirs = getSetting('modelsDirs') ?? []
      for (const base of modelsDirs) {
        const full = path.join(base, relPath)
        if (fs.existsSync(full)) {
          return res.sendFile(full)
        }
      }
      res.status(HTTP_STATUS.NOT_FOUND).json(createErrorResponse('file not found'))
    } catch (e) {
      logger.error('Failed to serve model file', e)
      res.status(HTTP_STATUS.INTERNAL_SERVER_ERROR).json(createErrorResponse((e as Error).message))
    }
  })

  return router
}
