/**
 * MCP 工具调用审计日志（借鉴 ai-art-engine mcp-audit.jsonl 设计，自用移植）。
 *
 * 每次 /mcp CallTool 全量落一行 JSONL：时间 / 工具名 / 参数摘要（截断）/
 * 耗时 / 是否出错 / 调用方有无 decide 会话身份。可回查 agent 触发的每次
 * 生成与写入——「跑绿≠有效」排查时的第一手证据。
 *
 * 设计约束（对齐既有模块惯例）：
 * - electron 懒探测（batchRunner.ts 同款）：非 Electron 环境（单测）退回 os.tmpdir；
 * - 异步追加，不阻塞主进程事件循环；日志失败静默（审计不应打断工具执行）；
 * - 单文件 5MB 滚动（mcp-audit.jsonl → .1，保留一代），参数超 200 字符截断。
 */
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import electron from 'electron'
import { logger } from '../utils/logger'

const MAX_LOG_BYTES = 5 * 1024 * 1024
const MAX_ARG_SNIPPET = 200

/** 审计文件路径（环境变量可覆盖，便于测试） */
export function getAuditLogFile(): string {
  if (process.env.MCP_AUDIT_FILE) return process.env.MCP_AUDIT_FILE
  const userData =
    typeof electron?.app?.getPath === 'function' ? electron.app.getPath('userData') : ''
  return path.join(userData || os.tmpdir(), 'logs', 'mcp-audit.jsonl')
}

/** 参数摘要：JSON 序列化后截断（对齐 ai-art-engine：超 200 字符截断） */
function argSnippet(args: unknown): string {
  let s: string
  try {
    s = JSON.stringify(args ?? {})
  } catch {
    s = String(args)
  }
  return s.length > MAX_ARG_SNIPPET ? `${s.slice(0, MAX_ARG_SNIPPET)}…(${s.length})` : s
}

export interface AuditEntry {
  tool: string
  args: unknown
  durationMs: number
  isError: boolean
  /** true = 带 decide 会话身份（workbench agent 链路） */
  hasIdentity: boolean
}

let rotating = false

/** 滚动：超 5MB 把当前文件 rename 成 .1（覆盖上一代），继续写新文件 */
async function rotateIfNeeded(file: string): Promise<void> {
  if (rotating) return
  rotating = true
  try {
    const st = await fsp.stat(file)
    if (st.size >= MAX_LOG_BYTES) await fsp.rename(file, `${file}.1`)
  } catch {
    /* 文件不存在/stat 失败：无需滚动 */
  } finally {
    rotating = false
  }
}

/** 追加一条审计记录（异步 fire-and-forget；失败只记主 logger，不影响工具调用） */
export function appendAudit(entry: AuditEntry): void {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    tool: entry.tool,
    args: argSnippet(entry.args),
    durationMs: Math.round(entry.durationMs),
    isError: entry.isError,
    hasIdentity: entry.hasIdentity
  })
  const file = getAuditLogFile()
  void rotateIfNeeded(file)
    .then(() => fsp.mkdir(path.dirname(file), { recursive: true }))
    .then(() => fsp.appendFile(file, `${line}\n`, 'utf8'))
    .catch((e) => logger.warn('[MCP-audit] 写审计日志失败:', e))
}
