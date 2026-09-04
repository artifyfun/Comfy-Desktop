/**
 * bundle 导入产物写回（纯函数核心：无 Electron 依赖，可单测）。
 * 路由层薄壳：只负责 multer buffer → 纯函数 → touchSession/scanOutputDir。
 */
import pathUtil from 'path'
import type { WorkbenchSession, WorkbenchOutputFile } from './service'

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
  const full = resolve(outputDir, ...segs)
  if (full !== outputDir && !full.startsWith(outputDir + sep)) return { ok: false }
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
      target: r.target,
    })
  }
  return { restored, skipped }
}