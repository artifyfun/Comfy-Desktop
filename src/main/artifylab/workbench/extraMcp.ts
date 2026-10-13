/**
 * stdio 反向桥（借鉴 ai-art-engine：应用内 agent 可消费任意外部 stdio MCP
 * server，不再局限于回环 /mcp 与 civitai，自用移植）。
 *
 * 配置来源：`<userData>/extra-mcp.json`（手编辑，应用启动后无需重启——
 * 每个会话 getOrCreate 时重读）：
 *
 * ```json
 * [
 *   { "name": "blender", "command": "uvx", "args": ["blender-mcp"], "env": { "BLENDER_HOST": "127.0.0.1" } }
 * ]
 * ```
 *
 * agentRuntime.getOrCreate 在写临时 CODEX_HOME/config.toml 时把每个条目
 * 展开成 codex 的 stdio MCP 段（`[mcp_servers.<name>] command/args/env`），
 * codex 二进制自己 spawn 子进程——主进程不托管子进程生命周期（会话级
 * 临时 HOME 天然隔离，run 结束随 reap 收口）。
 *
 * 健壮性：文件缺失/JSON 非法/条目缺 name 或 command → 跳过该条并 warn，
 * 不阻断会话创建（桥是增强，不是依赖）。
 */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { logger } from '../utils/logger'

export interface ExtraMcpServer {
  name: string
  command: string
  args?: string[]
  env?: Record<string, string>
}

/** TOML key 转义（basi 字符 + 引号） */
function tomlStr(s: string): string {
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/** 合法 server 名：TOML 裸键（字母数字-_），防注入段头 */
function validName(name: string): boolean {
  return /^[A-Za-z0-9_-]+$/.test(name)
}

/**
 * 读外部 stdio MCP server 清单。文件路径优先级：
 * EXTRA_MCP_FILE 环境变量（测试/定制用） > <userDataDir>/extra-mcp.json。
 * 任何异常（缺失/非法 JSON/条目畸形）都只 warn 并返回已解析的合法条目。
 */
export async function readExtraMcpServers(userDataDir?: string): Promise<ExtraMcpServer[]> {
  const target =
    process.env.EXTRA_MCP_FILE ?? (userDataDir ? path.join(userDataDir, 'extra-mcp.json') : null)
  if (!target) return []
  let raw: string
  try {
    raw = await readFile(target, 'utf8')
  } catch {
    return []
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (e) {
    logger.warn(`[extra-mcp] ${target} JSON 解析失败，忽略全部外部 server:`, e)
    return []
  }
  if (!Array.isArray(parsed)) {
    logger.warn(`[extra-mcp] ${target} 顶层数组期望，收到 ${typeof parsed}，忽略`)
    return []
  }
  const out: ExtraMcpServer[] = []
  for (const item of parsed) {
    const name =
      typeof (item as ExtraMcpServer)?.name === 'string' ? (item as ExtraMcpServer).name : ''
    const command =
      typeof (item as ExtraMcpServer)?.command === 'string' ? (item as ExtraMcpServer).command : ''
    if (!validName(name) || !command) {
      logger.warn(
        `[extra-mcp] 条目缺合法 name/command，跳过: ${JSON.stringify(item).slice(0, 120)}`
      )
      continue
    }
    out.push({
      name,
      command,
      args: Array.isArray((item as ExtraMcpServer).args)
        ? (item as ExtraMcpServer).args!.map(String)
        : undefined,
      env:
        (item as ExtraMcpServer).env && typeof (item as ExtraMcpServer).env === 'object'
          ? Object.fromEntries(
              Object.entries((item as ExtraMcpServer).env!).map(([k, v]) => [k, String(v)])
            )
          : undefined
    })
  }
  return out
}

/** 条目 → codex config.toml 的 stdio MCP 段（[mcp_servers.<name>]） */
export function extraMcpTomlLines(servers: ExtraMcpServer[]): string[] {
  const lines: string[] = []
  for (const s of servers) {
    lines.push(`[mcp_servers.${s.name}]`)
    lines.push(`command = ${tomlStr(s.command)}`)
    if (s.args && s.args.length > 0) {
      lines.push(`args = [${s.args.map(tomlStr).join(', ')}]`)
    }
    if (s.env && Object.keys(s.env).length > 0) {
      const pairs = Object.entries(s.env).map(([k, v]) => `${tomlStr(k)} = ${tomlStr(v)}`)
      lines.push(`env = { ${pairs.join(', ')} }`)
    }
    lines.push('')
  }
  return lines
}

/** 一步到位：读清单并展开为 TOML 段（agentRuntime 的 config.toml 组装用） */
export async function extraMcpTomlLinesAsync(userDataDir?: string): Promise<string[]> {
  return extraMcpTomlLines(await readExtraMcpServers(userDataDir))
}
