/**
 * MCP 接入信息的进程内构建（供 HTTP 路由与桌面 IPC 共用）。
 *
 * 桌面 mcp-setup 面板与 A UI 设置弹窗展示同一份数据：
 * endpoint URL / token / 已暴露的 app 数 / 监听地址信息。
 */
import appStoreManager from '../appStore'
import { getServerPort } from '../server'
import { getOrCreateMcpToken } from './auth'
import { isLoopbackHost, resolveListenHost } from '../config/listenHost'

export interface McpConfigInfo {
  url: string
  token: string
  /** 已暴露为 MCP 工具的 app 数（run__<id> 动态工具） */
  appCount: number
  listenHost: string
  loopback: boolean
}

export function buildMcpConfigInfo(): McpConfigInfo {
  const port = getServerPort()
  const host = resolveListenHost(appStoreManager.getConfig())
  return {
    url: `http://localhost:${port ?? ''}/mcp`,
    token: getOrCreateMcpToken(),
    appCount: appStoreManager.getAllApps().length,
    listenHost: host,
    loopback: isLoopbackHost(host)
  }
}
