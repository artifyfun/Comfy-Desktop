import fs from 'node:fs'
import path from 'node:path'
import { nativeImage } from 'electron'
import { get as getSetting } from '../../settings'
import { getGalleryThumbDir, upsertAsset } from './db'
import { extractPngMetadata } from './pngMetadata'
import { logger } from '../utils/logger'

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.webp'])
const THUMB_WIDTH = 320
/** 超过此大小（字节）的文件不再生成缩略图（PNG 原图直接被 /view 使用） */
const THUMB_SRC_LIMIT = 64 * 1024 * 1024

/**
 * 扫描 ComfyUI output 目录（settings 的 outputDir，同 artify-openOutputFolder），
 * 将图片文件增量索引到 gallery.db。已索引且 mtime 未变的文件跳过。
 */
export async function scanOutputDir(): Promise<{
  scanned: number
  added: number
  outputDir: string | null
}> {
  const outputDir = getSetting('outputDir')
  if (!outputDir || !fs.existsSync(outputDir)) {
    return { scanned: 0, added: 0, outputDir: outputDir ?? null }
  }

  let scanned = 0
  let added = 0
  const walk = (dir: string, subfolder: string) => {
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
        walk(full, subfolder ? path.join(subfolder, entry.name) : entry.name)
      } else if (IMAGE_EXT.has(path.extname(entry.name).toLowerCase())) {
        scanned++
        try {
          const stat = fs.statSync(full)
          const sub = subfolder
          const meta =
            path.extname(entry.name).toLowerCase() === '.png' ? extractPngMetadata(full) : {}
          upsertAsset({
            filename: entry.name,
            subfolder: sub,
            filepath: sub ? `${sub}/${entry.name}` : entry.name,
            size: stat.size,
            mtime: Math.floor(stat.mtimeMs),
            created_at: Math.floor(stat.mtimeMs),
            prompt_json: meta.prompt ?? null,
            workflow_json: meta.workflow ?? null
          })
          added++
          makeThumb(outputDir, sub, entry.name)
        } catch (e) {
          logger.warn(`gallery scan skip ${full}: ${(e as Error).message}`)
        }
      }
    }
  }
  walk(outputDir, '')
  return { scanned, added, outputDir }
}

/**
 * 生成缩略图（Electron nativeImage，零依赖）。失败静默——列表可用原图 URL 兜底。
 */
export function makeThumb(outputDir: string, subfolder: string, filename: string): string | null {
  try {
    const rel = subfolder ? path.join(subfolder, filename) : filename
    const src = path.join(outputDir, rel)
    const stat = fs.statSync(src)
    if (stat.size > THUMB_SRC_LIMIT) return null
    const thumbDir = getGalleryThumbDir()
    const thumbPath = path.join(
      thumbDir,
      `${subfolder ? subfolder.replace(/[\\/]/g, '_') + '_' : ''}${filename}.jpg`
    )
    if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).mtimeMs >= stat.mtimeMs) return thumbPath
    const img = nativeImage.createFromPath(src)
    if (img.isEmpty()) return null
    const size = img.getSize()
    const height = Math.max(1, Math.round((size.height / size.width) * THUMB_WIDTH))
    const thumb = img.resize({ width: THUMB_WIDTH, height }).toJPEG(80)
    fs.mkdirSync(thumbDir, { recursive: true })
    fs.writeFileSync(thumbPath, thumb)
    return thumbPath
  } catch (e) {
    logger.warn(`gallery thumb fail: ${(e as Error).message}`)
    return null
  }
}
