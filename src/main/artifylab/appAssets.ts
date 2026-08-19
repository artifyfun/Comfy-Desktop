import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { getGalleryDb } from './gallery/db'
import { logger } from './utils/logger'

/**
 * App 附件（base64 图标等）落盘 + App 版本历史。
 *
 * 动机：实测单个 App JSON ≈ 78KB，其中 imageUrl 为完整 base64 data URI，
 * 每次保存任何字段都会全量重写整个 apps 数组。
 * 优化：
 *  1. data URI 写入 <userData>/app-assets/<id>.<ext>，App 里只存 app-asset://<id>.<ext>
 *     引用；API 出口（serializeApp）自动还原为可访问的 HTTP URL，前端零改动。
 *  2. updateApp 前把旧版本快照写入 gallery.db 的 app_versions 表（保留最近 N 版），
 *     支持恢复历史版本。
 */

const ASSET_REF_PREFIX = 'app-asset://'
export const APP_ASSETS_ROUTE = '/api/app-assets'

export function getAppAssetsDir(): string {
  return path.join(app.getPath('userData'), 'app-assets')
}

/** data URI → 落盘文件，返回引用字符串；非 data URI 原样返回。失败也原样返回（不阻塞保存）。 */
export function persistAsset(dataUri: string): string {
  const m = /^data:image\/(png|jpeg|jpg|webp|gif|svg\+xml);base64,(.+)$/s.exec(dataUri ?? '')
  if (!m) return dataUri
  try {
    const mime = m[1] as string
    const b64 = m[2] as string
    const ext = mime === 'svg+xml' ? 'svg' : mime === 'jpeg' ? 'jpg' : mime
    const hash = hashString(`${mime}:${b64}`).slice(0, 16)
    const filename = `${hash}.${ext}`
    const dir = getAppAssetsDir()
    const full = path.join(dir, filename)
    if (!fs.existsSync(full)) {
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(full, Buffer.from(b64, 'base64'))
    }
    return `${ASSET_REF_PREFIX}${filename}`
  } catch (e) {
    logger.warn(`persistAsset failed: ${(e as Error).message}`)
    return dataUri
  }
}

/** 入口规范化：存储前把 data URI 落盘。递归处理（App 平级字段 + code 里的内联图）。 */
export function normalizeAppForStorage(appObj: Record<string, unknown>): void {
  if (typeof appObj.imageUrl === 'string' && appObj.imageUrl.startsWith('data:')) {
    appObj.imageUrl = persistAsset(appObj.imageUrl)
  }
}

/** 出口序列化：把 app-asset:// 引用还原为 HTTP URL（经 Express 静态服务）。 */
export function serializeApp(
  appObj: Record<string, unknown>,
  serverOrigin: string
): Record<string, unknown> {
  const out = { ...appObj }
  if (typeof out.imageUrl === 'string' && out.imageUrl.startsWith(ASSET_REF_PREFIX)) {
    out.imageUrl = `${serverOrigin}${APP_ASSETS_ROUTE}/${out.imageUrl.slice(ASSET_REF_PREFIX.length)}`
  }
  return out
}

function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16)
}

// ---------- 版本历史 ----------

const MAX_VERSIONS = 20

export interface AppVersion {
  id: number
  app_id: string
  version: number
  created_at: number
  app_json: string
}

export function initAppVersionsTable(): void {
  getGalleryDb().exec(`
    CREATE TABLE IF NOT EXISTS app_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      app_id TEXT NOT NULL,
      version INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      app_json TEXT NOT NULL,
      UNIQUE(app_id, version)
    );
    CREATE INDEX IF NOT EXISTS idx_app_versions_app ON app_versions(app_id, version DESC);
  `)
}

/** 保存快照（同步覆盖被 update 前的旧内容）。超限裁剪。 */
export function snapshotAppVersion(appObj: Record<string, unknown>): void {
  try {
    initAppVersionsTable()
    const db = getGalleryDb()
    const appId = String(appObj.id)
    const row = db
      .prepare('SELECT MAX(version) AS v FROM app_versions WHERE app_id = ?')
      .get(appId) as { v: number | null }
    const version = (row.v ?? 0) + 1
    db.prepare(
      'INSERT OR REPLACE INTO app_versions (app_id, version, created_at, app_json) VALUES (?, ?, ?, ?)'
    ).run(appId, version, Date.now(), JSON.stringify(serializeApp(appObj, '')))
    // 裁剪：JSON 存储态引用（imageUrl 为 app-asset:// 或原样）
    const stale = db
      .prepare(
        'SELECT id FROM app_versions WHERE app_id = ? ORDER BY version DESC LIMIT -1 OFFSET ?'
      )
      .all(appId, MAX_VERSIONS) as Array<{ id: number }>
    for (const s of stale) {
      db.prepare('DELETE FROM app_versions WHERE id = ?').run(s.id)
    }
  } catch (e) {
    logger.warn(`snapshotAppVersion failed: ${(e as Error).message}`)
  }
}

export function listAppVersions(
  appId: string
): Array<{ version: number; created_at: number; name: string | null }> {
  initAppVersionsTable()
  const rows = getGalleryDb()
    .prepare(
      'SELECT version, created_at, app_json FROM app_versions WHERE app_id = ? ORDER BY version DESC'
    )
    .all(appId) as Array<{ version: number; created_at: number; app_json: string }>
  return rows.map((r) => ({
    version: Number(r.version),
    created_at: Number(r.created_at),
    name: (JSON.parse(r.app_json) as { name?: string }).name ?? null
  }))
}

export function getAppVersion(appId: string, version: number): Record<string, unknown> | null {
  initAppVersionsTable()
  const row = getGalleryDb()
    .prepare('SELECT app_json FROM app_versions WHERE app_id = ? AND version = ?')
    .get(appId, version) as { app_json: string } | undefined
  if (!row) return null
  return JSON.parse(row.app_json) as Record<string, unknown>
}
