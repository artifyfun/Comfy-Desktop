/**
 * 会话导出/导入核心（纯函数，无 Electron/IO 依赖）。
 *
 * 设计：导出格式带 schema 版本号，向前兼容靠 migrate 链。导入永远生成
 * 新 UUID（防本机已有同 id 会话冲突），导入件视为「用户手动创建」——
 * titleLocked 保持导出时的值，updatedAt 刷新为导入时刻。
 *
 * 剥离字段（不随导出走）：
 *  - debugLogs：每条 ~10KB 调试快照，体积大头且属本机复盘数据；
 *  - executions[].batchJobId：批编排 job 属本机运行时状态，跨机无意义。
 */
import { randomUUID } from 'crypto'
import type { WorkbenchSession } from './service'

export const SESSION_EXPORT_SCHEMA_VERSION = 1

/** 导出文件顶层结构 */
export interface SessionExportFile {
  schema: typeof SESSION_EXPORT_SCHEMA_VERSION
  exportedAt: number
  app: 'artify-desktop'
  session: WorkbenchSession
}

/** 导出：深拷贝 + 剥离本机态字段。入参 session 直接来自 store（不可变处理）。 */
export function exportSession(session: WorkbenchSession): SessionExportFile {
  const clone = JSON.parse(JSON.stringify(session)) as WorkbenchSession
  delete clone.debugLogs
  for (const ex of clone.executions ?? []) delete ex.batchJobId
  return {
    schema: SESSION_EXPORT_SCHEMA_VERSION,
    exportedAt: Date.now(),
    app: 'artify-desktop',
    session: clone
  }
}

export interface ImportResult {
  ok: boolean
  session?: WorkbenchSession
  error?: 'invalid_json' | 'unsupported_schema' | 'not_session_file'
}

/** 结构骨架校验（轻量：字段存在性 + 类型，不逐消息深校验——渲染层本就有容错） */
export function validateSessionFile(raw: unknown): SessionExportFile | null {
  if (!raw || typeof raw !== 'object') return null
  const f = raw as Partial<SessionExportFile>
  if (f.app !== 'artify-desktop' || typeof f.schema !== 'number') return null
  if (f.schema > SESSION_EXPORT_SCHEMA_VERSION) return null
  const s = f.session
  if (!s || typeof s !== 'object') return null
  if (typeof s.id !== 'string' || typeof s.title !== 'string' || !Array.isArray(s.messages)) {
    return null
  }
  if (!Array.isArray(s.executions)) return null
  return f as SessionExportFile
}

/** 导入：校验 + 新 UUID + 时间戳刷新。existingIds 用于防撞（本机已有同 id）。 */
export function importSession(raw: unknown, existingIds: Set<string>): ImportResult {
  const file = validateSessionFile(raw)
  if (!file) return { ok: false, error: 'not_session_file' }
  const s = JSON.parse(JSON.stringify(file.session)) as WorkbenchSession
  s.id = randomUUID()
  // 防御：极端小概率 UUID 撞车
  while (existingIds.has(s.id)) s.id = randomUUID()
  existingIds.add(s.id)
  s.updatedAt = Date.now()
  s.debugLogs = undefined
  for (const ex of s.executions ?? []) delete ex.batchJobId
  // 基本面兜底（老导出件缺字段不至于 NaN）
  s.createdAt = typeof s.createdAt === 'number' ? s.createdAt : Date.now()
  s.messages = Array.isArray(s.messages) ? s.messages : []
  s.executions = Array.isArray(s.executions) ? s.executions : []
  return { ok: true, session: s }
}
