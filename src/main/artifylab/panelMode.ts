import { isDevMode } from './utils/resourcePaths'

/**
 * 单窗口面板模式：A UI（artifylab 旧前端）作为 host 窗口 panelView 的内容，
 * 与 ComfyUI（comfyView）在同一窗口内切换。`setArtifyPanelMode(true)` 由
 * main/index.ts 在 DesktopConfig 加载成功后调用；prod 的 A UI 端口在
 * startServer 成功后通过 `setArtifyPanelPort` 注入（不直接 import server，
 * 避免测试环境触发 server.ts 顶层的静态文件初始化）。
 */
let artifyPanelEnabled = false
let artifyPanelPort: number | null = null

export function setArtifyPanelMode(enabled: boolean): void {
  artifyPanelEnabled = enabled
}

export function setArtifyPanelPort(port: number | null): void {
  artifyPanelPort = port
}

export function isArtifyPanelMode(): boolean {
  return artifyPanelEnabled
}

/**
 * A UI 的 URL：dev 指向前端 vite dev server（无需 build:copy），
 * prod 指向本地 express server（静态托管 frontend 产物）。
 * 未启用面板模式或端口未知时返回 null。
 */
export function getArtifyPanelUrl(): string | null {
  if (!artifyPanelEnabled) return null
  if (isDevMode) return 'http://localhost:5000'
  return artifyPanelPort ? `http://localhost:${artifyPanelPort}` : null
}
