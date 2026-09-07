/**
 * HTTP apiClient —— baseUrl 解析的唯一 home。
 *
 * 此前 appStore.apiRequest（electron config → query param → config 三路解析）
 * 与 batchTaskStore.api（自造 serverHost 前缀拼接）各持一份；现在统一从这里走。
 *
 * 优先级（与原 appStore 实现一致）：
 *   1. Electron 宿主：electronAPI.ArtifyLab.getConfig().server_origin
 *   2. URL 查询参数 server_origin
 *   3. 调用方传入的 fallback（通常是 appStore.config.serverHost）
 */
import { isElectron, getElectronConfig, getQueryParam } from './env'

/** 解析当前应使用的 baseUrl（无 fallback 时返回 ''，即相对路径）。 */
export async function resolveBaseUrl(fallbackHost = '') {
  if (isElectron) {
    try {
      const electronConfig = await getElectronConfig()
      if (electronConfig?.server_origin) return electronConfig.server_origin
    } catch {
      /* electron 桥不可用则继续降级 */
    }
  }
  const qp = getQueryParam('server_origin')
  if (qp) return qp
  return fallbackHost || ''
}

/**
 * 带错误归一的 JSON API 请求。
 * @returns {Promise<any>} response.json()；非 2xx 抛 Error（服务端 message 优先）
 */
export async function apiRequest(endpoint, options = {}, { fallbackHost = '' } = {}) {
  const baseUrl = await resolveBaseUrl(fallbackHost)
  const defaultOptions = {
    headers: {
      'Content-Type': 'application/json',
    },
  }
  const response = await fetch(`${baseUrl}${endpoint}`, {
    ...defaultOptions,
    ...options,
  })
  if (!response.ok) {
    const errorData = await response.json().catch(() => ({ message: 'Request failed' }))
    throw new Error(errorData.message || `HTTP ${response.status}`)
  }
  return response.json()
}
