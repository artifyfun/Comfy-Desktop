/**
 * MCP 鉴权（决策 #4：独立 Bearer token，仅本机）。
 */
import { randomBytes } from 'node:crypto'
import appStoreManager from '../appStore'

const CONFIG_KEY = 'mcpToken'

/** 首次调用生成随机 token 并存 config，后续读取。 */
export function getOrCreateMcpToken(): string {
  const config = appStoreManager.getConfig() as Record<string, unknown>
  if (typeof config[CONFIG_KEY] === 'string' && config[CONFIG_KEY]) {
    return config[CONFIG_KEY] as string
  }
  const token = randomBytes(32).toString('hex')
  appStoreManager.saveConfig({ [CONFIG_KEY]: token })
  return token
}

/** 校验 Authorization: Bearer <token> 或 ?token=<token> query。 */
export function validateMcpToken(req: {
  headers: Record<string, string | string[] | undefined>
  url?: string
}): boolean {
  const expected = getOrCreateMcpToken()
  const auth = req.headers['authorization']
  const bearer = Array.isArray(auth) ? auth[0] : auth
  if (bearer === `Bearer ${expected}`) return true
  // H4：解析 query 精确匹配，避免 String.includes 虚假匹配（如 ?xtoken=<expected>）
  try {
    const t = new URL(req.url || '', 'http://localhost').searchParams.get('token')
    return t === expected
  } catch {
    return false
  }
}
