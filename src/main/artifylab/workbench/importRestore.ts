/**
 * bundle 导入产物写回（纯函数核心：无 Electron 依赖，可单测）。
 * 路由层薄壳：只负责 multer buffer → 纯函数 → touchSession/scanOutputDir。
 */
import pathUtil from 'path'
import type { WorkbenchSession } from './sessionTypes'
import type { WorkbenchOutputFile } from './executionLog'

export interface RestoredFile {
  filename: string
  subfolder: string
  /** 写回后的引用（executions.outputs 回填用） */
  target: WorkbenchOutputFile
}

export interface RestoreResult {
  restored: RestoredFile[]
  skipped: number
}

// ---------- ZIP（STORE）解包（A6：从 sessions.ts 路由移入，纯函数可单测） ----------
// 与组包端（sessionBundle 的零依赖 STORE 写出）对称：只读 EOCD → 中央目录 →
// STORE 条目直接切片。DEFLATE 条目跳过（我们自己的组包不产生）。

/** 解析 STORE 模式 ZIP buffer → 条目名→数据 映射。非法返回 null。 */
export function parseZipStore(buf: Buffer): Map<string, Buffer> | null {
  if (buf.length < 22) return null
  // EOCD 定位（末 22B，注释最长 64KB 往前扫）
  let eocd = -1
  const scanStart = Math.max(0, buf.length - 22 - 65535)
  for (let i = buf.length - 22; i >= scanStart; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) return null
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
  return entries
}

/** 写回单文件。write 注入（路由层 fs.writeFileSync；测试内存 map）。 */
export function restoreOne(
  outputDir: string,
  importPrefix: string,
  file: { filename?: string; subfolder?: string },
  entryName: string,
  data: Buffer,
  write: (full: string, data: Buffer) => void,
  mkdir: (dir: string) => void
): { ok: true; target: WorkbenchOutputFile } | { ok: false } {
  const fallback = entryName.split('/').pop() || 'file'
  // 孤儿条目：剥掉组包时加的防重序前缀（outputs/9-x.png → x.png）
  const base = file.filename || fallback.replace(/^\d+-/, '') || 'file'
  const subfolder = file.subfolder ? `${importPrefix}/${file.subfolder}` : importPrefix
  const segs = `${subfolder}/${base}`.split('/').filter(Boolean)
  if (segs.includes('..')) return { ok: false }
  const { resolve, sep } = pathUtil
  // outputDir 先归一化：Windows 上 resolve('/out') 会吃当前盘符（→ D:\out\...），
  // 不归一化则前缀比对恒假（POSIX 风格/相对 outputDir 下 restore 静默失效）。
  const baseAbs = resolve(outputDir)
  const full = resolve(baseAbs, ...segs)
  if (full !== baseAbs && !full.startsWith(baseAbs + sep)) return { ok: false }
  mkdir(resolve(full, '..'))
  write(full, data)
  return { ok: true, target: { filename: base, subfolder, type: 'output' } }
}

/** 整包写回 + 会话引用回填（executions.outputs / messages.outputFiles）。 */
export function restoreBundleFiles(
  session: WorkbenchSession,
  outputDir: string,
  manifestFiles: { path: string; filename?: string; subfolder?: string }[],
  entries: Map<string, Buffer>,
  write: (full: string, data: Buffer) => void,
  mkdir: (dir: string) => void
): RestoreResult {
  const importPrefix = `wb-import-${session.id.slice(0, 8)}`
  const restored: RestoredFile[] = []
  let skipped = 0
  for (const [name, data] of entries) {
    if (!name.startsWith('outputs/')) continue
    const mf = manifestFiles.find((f) => f.path === name)
    let r: ReturnType<typeof restoreOne>
    try {
      r = restoreOne(outputDir, importPrefix, mf ?? {}, name, data, write, mkdir)
    } catch {
      skipped++
      continue
    }
    if (!r.ok) {
      skipped++
      continue
    }
    // 引用回填：同名同 subfolder 的旧引用指向新位置
    for (const ex of session.executions ?? []) {
      ex.outputs = ex.outputs.map((o) =>
        typeof o === 'string'
          ? o
          : o.filename === (mf?.filename ?? '') && o.subfolder === mf?.subfolder
            ? r.target
            : o
      )
    }
    for (const m of session.messages ?? []) {
      if (!m.outputFiles) continue
      m.outputFiles = m.outputFiles.map((o) =>
        o.filename === (mf?.filename ?? '') && o.subfolder === mf?.subfolder ? r.target : o
      )
    }
    restored.push({
      filename: r.target.filename,
      subfolder: r.target.subfolder ?? '',
      target: r.target
    })
  }
  return { restored, skipped }
}
