/**
 * 会话产物完整包导出（纯函数核心 + 流式 ZIP 组包）。
 *
 * 格式：目录 layout 固定，导入端零歧义——
 *   session.json                       —— 会话数据（sessionTransfer.exportSession 同构，另带 files 清单）
 *   outputs/<executionIdx>-<seq>.<ext> —— 产物文件（原名可能重复，加序前缀防覆盖）
 *
 * ZIP 实现：零第三方依赖。STORE 模式（不 deflate）——产物是 PNG/WebP/MP4
 * 等已压缩格式，再压缩 CPU 白烧体积不降；写法走「本地文件头 + 中央目录」
 * 标准结构，stream 写出避免大包内存峰值。CRC32 查表实现。
 */
import { createHash } from 'crypto'
import { statSync, readFileSync } from 'fs'
import type { WorkbenchSession, WorkbenchOutputFile } from './service'
import type {
  SESSION_EXPORT_SCHEMA_VERSION} from './sessionTransfer';
import {
  exportSession,
  type SessionExportFile
} from './sessionTransfer'

// ---------- CRC32（IEEE，查表） ----------
const CRC_TABLE = (() => {
  const t = new Uint32Array(new ArrayBuffer(4 * 256))
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) >>> 0 : c >>> 1
    t[n] = (c >>> 0) as unknown as number
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) {
    const byte = buf[i] ?? 0
    c = (CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8)) >>> 0
  }
  return (c ^ 0xffffffff) >>> 0
}

// ---------- DOS 时间（ZIP 规范） ----------
function toDosTime(d: Date): { time: number; date: number } {
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2)
  const date = ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  return { time, date }
}

interface ZipEntry {
  nameBytes: Buffer
  data: Buffer
  crc: number
  time: number
  date: number
  offset: number
}

/** 极简 ZIP 组包器（STORE）：一次收齐 entry，输出单 Buffer。会话包 ≤ 数十 MB 量级可整体持有。 */
class ZipWriter {
  private entries: ZipEntry[] = []
  add(name: string, data: Buffer): void {
    const nameBytes = Buffer.from(name, 'utf8')
    const { time, date } = toDosTime(new Date())
    this.entries.push({
      nameBytes,
      data,
      crc: crc32(data),
      time,
      date,
      offset: 0
    })
  }
  /** 组包。文件名重复（防覆盖）由调用方保证唯一。 */
  build(): Buffer {
    const chunks: Buffer[] = []
    let offset = 0
    for (const e of this.entries) {
      e.offset = offset
      const local = Buffer.alloc(30)
      local.writeUInt32LE(0x04034b50, 0)
      local.writeUInt16LE(20, 4) // version needed
      local.writeUInt16LE(0, 6) // flags
      local.writeUInt16LE(0, 8) // STORE
      local.writeUInt16LE(e.time, 10)
      local.writeUInt16LE(e.date, 12)
      local.writeUInt32LE(e.crc, 14)
      local.writeUInt32LE(e.data.length, 18)
      local.writeUInt32LE(e.data.length, 22)
      local.writeUInt16LE(e.nameBytes.length, 26)
      local.writeUInt16LE(0, 28)
      chunks.push(local, e.nameBytes, e.data)
      offset += 30 + e.nameBytes.length + e.data.length
    }
    const cdStart = offset
    for (const e of this.entries) {
      const cd = Buffer.alloc(46)
      cd.writeUInt32LE(0x02014b50, 0)
      cd.writeUInt16LE(20, 4) // version made by
      cd.writeUInt16LE(20, 6) // version needed
      cd.writeUInt16LE(0, 8)
      cd.writeUInt16LE(0, 10) // STORE
      cd.writeUInt16LE(e.time, 12)
      cd.writeUInt16LE(e.date, 14)
      cd.writeUInt32LE(e.crc, 16)
      cd.writeUInt32LE(e.data.length, 20)
      cd.writeUInt32LE(e.data.length, 24)
      cd.writeUInt16LE(e.nameBytes.length, 28)
      cd.writeUInt16LE(0, 30) // extra len
      cd.writeUInt16LE(0, 32) // comment len
      cd.writeUInt16LE(0, 34) // disk number
      cd.writeUInt16LE(0, 36) // internal attrs
      cd.writeUInt32LE(0, 38) // external attrs
      cd.writeUInt32LE(e.offset, 42)
      chunks.push(cd, e.nameBytes)
      offset += 46 + e.nameBytes.length
    }
    const eocd = Buffer.alloc(22)
    eocd.writeUInt32LE(0x06054b50, 0)
    eocd.writeUInt16LE(0, 4)
    eocd.writeUInt16LE(0, 6)
    eocd.writeUInt16LE(this.entries.length, 8)
    eocd.writeUInt16LE(this.entries.length, 10)
    eocd.writeUInt32LE(offset - cdStart, 12)
    eocd.writeUInt32LE(cdStart, 16)
    eocd.writeUInt16LE(0, 20)
    chunks.push(eocd)
    return Buffer.concat(chunks)
  }
}

export interface SessionBundleFile {
  /** 包内路径（outputs/xxx.png） */
  path: string
  filename: string
  subfolder?: string
  type?: string
  size: number
  sha256: string
}

/** 包内 session.json 结构：导出件 + files 清单 */
export interface SessionBundleManifest {
  schema: typeof SESSION_EXPORT_SCHEMA_VERSION
  bundleVersion: 1
  exportedAt: number
  app: 'artify-desktop'
  session: WorkbenchSession
  /** 包内产物文件清单（导入端校验 + 展示用） */
  files: SessionBundleFile[]
}

/** 从会话收集去重产物引用（executions.outputs + messages 里的 outputFiles 引用） */
export function collectBundleFiles(session: WorkbenchSession): WorkbenchOutputFile[] {
  const seen = new Set<string>()
  const out: WorkbenchOutputFile[] = []
  const push = (f: WorkbenchOutputFile | string) => {
    const norm: WorkbenchOutputFile =
      typeof f === 'string'
        ? { filename: f }
        : { filename: f.filename, subfolder: f.subfolder, type: f.type }
    const key = `${norm.subfolder ?? ''}/${norm.filename}`
    if (!norm.filename || seen.has(key)) return
    seen.add(key)
    out.push(norm)
  }
  for (const ex of session.executions ?? []) for (const f of ex.outputs ?? []) push(f)
  for (const m of session.messages ?? []) for (const f of m.outputFiles ?? []) push(f)
  return out
}

/** zip 内文件名唯一化：序前缀 + 保留原扩展名 */
export function uniqueEntryName(index: number, filename: string): string {
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_')
  return `outputs/${index}-${safe}`
}

export type BundleBuildResult =
  | {
      ok: true
      zip: Buffer
      manifest: SessionBundleManifest
      missing: { path: string; filename: string }[]
    }
  | { ok: false; error: 'session_not_found' }
  | { ok: false; error: 'output_dir_not_configured' }
  | { ok: false; error: 'file_missing'; missing: { path: string; filename: string }[] }

/**
 * 组包。readFile 注入（路由层接 fs + safeJoin；测试注入内存 map）。
 * 单文件大小上限 4GB（ZIP32）；缺文件不 fail 整包——清单里标记、文件跳过，
 * 会话数据完整性优先（历史产物被清理是常态，不该阻断导出）。
 */
export function buildSessionBundle(
  session: WorkbenchSession,
  readFile: (f: WorkbenchOutputFile) => Buffer | null
): BundleBuildResult {
  const files = collectBundleFiles(session)
  const zip = new ZipWriter()
  const manifestFiles: SessionBundleFile[] = []
  const missing: { path: string; filename: string }[] = []
  let idx = 0
  for (const f of files) {
    const data = readFile(f)
    if (!data) {
      missing.push({ path: `${f.subfolder ?? ''}/${f.filename}`, filename: f.filename })
      continue
    }
    const entryName = uniqueEntryName(idx++, f.filename)
    zip.add(entryName, data)
    manifestFiles.push({
      path: entryName,
      filename: f.filename,
      subfolder: f.subfolder,
      type: f.type,
      size: data.length,
      sha256: createHash('sha256').update(data).digest('hex')
    })
  }
  const base = exportSession(session) as SessionExportFile
  const manifest: SessionBundleManifest = {
    ...base,
    bundleVersion: 1,
    files: manifestFiles
  }
  zip.add('session.json', Buffer.from(JSON.stringify(manifest, null, 2)))
  return { ok: true, zip: zip.build(), manifest, missing }
}

/** statSync 兜底暴露（路由层组装 readFile 用） */
export function statSize(p: string): number | null {
  try {
    return statSync(p).size
  } catch {
    return null
  }
}

export { readFileSync as _readFileSyncForTest }
