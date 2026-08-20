import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'

/**
 * Gallery 资产库索引（零外部依赖，使用 Node 内置 node:sqlite）。
 *
 * 数据模型参考 InvokeAI 的 images 表（Apache-2.0）：
 * 一行 = output 目录中的一个生成产物文件。
 * prompt/inputs 快照由前端出图成功时写入 /api/gallery/record；
 * 存量文件由 scanner 扫描补录（快照为空，参数靠 ComfyUI PNG chunk 兜底可后续补）。
 */

export interface GalleryAsset {
  id: number
  filename: string
  subfolder: string
  filepath: string
  type: string // 'output' | ...
  size: number
  mtime: number
  created_at: number
  width: number | null
  height: number | null
  app_id: string | null
  app_name: string | null
  inputs_json: string | null
  prompt_json: string | null
  workflow_json: string | null
  starred: number
}

let db: DatabaseSync | null = null

export function getGalleryDbPath(): string {
  return path.join(app.getPath('userData'), 'gallery.db')
}

export function getGalleryThumbDir(): string {
  return path.join(app.getPath('userData'), 'gallery-thumbs')
}

export function getGalleryDb(): DatabaseSync {
  if (db) return db
  fs.mkdirSync(path.dirname(getGalleryDbPath()), { recursive: true })
  db = new DatabaseSync(getGalleryDbPath())
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS assets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      filename TEXT NOT NULL,
      subfolder TEXT NOT NULL DEFAULT '',
      filepath TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL DEFAULT 'output',
      size INTEGER NOT NULL DEFAULT 0,
      mtime INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0,
      width INTEGER,
      height INTEGER,
      app_id TEXT,
      app_name TEXT,
      inputs_json TEXT,
      prompt_json TEXT,
      workflow_json TEXT,
      starred INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_assets_created ON assets(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_assets_app ON assets(app_id);
  `)
  // 兼容旧库：新增列（新装库建表时已包含，此处失败可忽略）
  try {
    db.exec(`ALTER TABLE assets ADD COLUMN workflow_json TEXT`)
  } catch {
    // column already exists
  }
  return db
}

export function assetFromRow(row: Record<string, unknown>): GalleryAsset {
  return {
    id: Number(row.id),
    filename: String(row.filename),
    subfolder: String(row.subfolder ?? ''),
    filepath: String(row.filepath),
    type: String(row.type ?? 'output'),
    size: Number(row.size ?? 0),
    mtime: Number(row.mtime ?? 0),
    created_at: Number(row.created_at ?? 0),
    width: row.width == null ? null : Number(row.width),
    height: row.height == null ? null : Number(row.height),
    app_id: (row.app_id as string | null) ?? null,
    app_name: (row.app_name as string | null) ?? null,
    inputs_json: (row.inputs_json as string | null) ?? null,
    prompt_json: (row.prompt_json as string | null) ?? null,
    workflow_json: (row.workflow_json as string | null) ?? null,
    starred: Number(row.starred ?? 0)
  }
}

/** 插入或更新（按 filepath 去重）。返回 id。 */
export function upsertAsset(asset: {
  filename: string
  subfolder?: string
  filepath: string
  type?: string
  size?: number
  mtime?: number
  created_at?: number
  width?: number | null
  height?: number | null
  app_id?: string | null
  app_name?: string | null
  inputs_json?: string | null
  prompt_json?: string | null
  workflow_json?: string | null
}): number {
  const db = getGalleryDb()
  db.prepare(
    `INSERT INTO assets (filename, subfolder, filepath, type, size, mtime, created_at, width, height, app_id, app_name, inputs_json, prompt_json, workflow_json)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(filepath) DO UPDATE SET
       size = excluded.size,
       mtime = excluded.mtime,
       app_id = COALESCE(excluded.app_id, app_id),
       app_name = COALESCE(excluded.app_name, app_name),
       inputs_json = COALESCE(excluded.inputs_json, inputs_json),
       prompt_json = COALESCE(excluded.prompt_json, prompt_json),
       workflow_json = COALESCE(excluded.workflow_json, workflow_json)
     RETURNING id`
  ).run(
    asset.filename,
    asset.subfolder ?? '',
    asset.filepath,
    asset.type ?? 'output',
    asset.size ?? 0,
    asset.mtime ?? 0,
    asset.created_at ?? Date.now(),
    asset.width ?? null,
    asset.height ?? null,
    asset.app_id ?? null,
    asset.app_name ?? null,
    asset.inputs_json ?? null,
    asset.prompt_json ?? null,
    asset.workflow_json ?? null
  )
  const row = db.prepare('SELECT id FROM assets WHERE filepath = ?').get(asset.filepath) as
    | { id: number }
    | undefined
  return Number(row?.id ?? 0)
}
