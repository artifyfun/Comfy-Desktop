import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { getAppResourcesPath } from './utils/resourcePaths'
import { getServer, startServer, getServerPort } from './server'

const DEV_MODE = process.env.DEV_MODE === 'true'
const DEV_ORIGIN = `http://localhost:5000`
let comfy_origin: string
let web_root: string
let comfy_port: number
let appWindow: any
let serverArgs: any

function injectHtml() {
  const config = getConfig()
  web_root = path.join(getAppResourcesPath(), 'ComfyUI', 'web_custom_versions', 'desktop_app')
  const htmlPath = os.platform() === 'darwin' ? `${web_root}/index.html` : `${web_root}\\index.html`
  const bak =
    os.platform() === 'darwin' ? `${web_root}/index.html.bak` : `${web_root}\\index.html.bak`
  const indexHtml = fs.readFileSync(htmlPath, 'utf-8')
  try {
    fs.readFileSync(bak, 'utf-8')
  } catch (e) {
    fs.writeFileSync(bak, indexHtml)
  }
  const htmlContent = fs.readFileSync(bak, 'utf-8')
  const prodUrl = `${config.server_origin}/comfy_inject.min.js?rand=${Math.random()}`
  const devUrl = `${DEV_ORIGIN}/comfy_inject.js?rand=${Math.random()}`
  const injectScriptUrl = DEV_MODE ? devUrl : prodUrl
  const inject_html = htmlContent.replace(
    '<head>',
    `<head><script src="${injectScriptUrl}"></script>`
  )
  fs.writeFileSync(htmlPath, inject_html)
}

function getUrl(serverArgs: any) {
  const config = getConfig()
  comfy_port = serverArgs.port
  const host = serverArgs.listen === '0.0.0.0' ? 'localhost' : serverArgs.listen
  comfy_origin = `http://${host}:${serverArgs.port}`
  const prodUrl = `${config.server_origin}`
  const devUrl = DEV_ORIGIN
  const url = DEV_MODE ? devUrl : prodUrl
  return url
}

function getConfig() {
  const server = getServer()
  if (!server) {
    throw new Error('Server is not running')
  }
  const address = server.address()
  if (!address || typeof address === 'string') {
    throw new Error('Invalid server address')
  }
  const port = address.port
  const server_origin = `http://localhost:${port}`
  // 新版 ComfyUI 由 install 架构动态管理，comfy_origin 无固定值（旧版
  // 由 getUrl 设置，已弃用）——给默认端口兜底：appStore 的 config
  // 依赖 comfy_origin 非空（App.vue 浮动按钮 v-if），stopExecution 的
  // interrupt 请求也用它拼 URL
  const effectiveComfyOrigin = comfy_origin || `http://localhost:${comfy_port || 8188}`
  return {
    comfy_origin: effectiveComfyOrigin,
    comfy_port,
    web_root,
    server_origin,
    server_port: port,
    // 旧前端 A UI 的浮动按钮 v-if 依赖 comfyHost 存在（App.vue）
    comfyHost: effectiveComfyOrigin
  }
}

/** 供 comfyInject 等主进程模块读取 express API 真实 origin（server 未起返回 null） */
export function getArtifyLabServerOrigin(): string | null {
  try {
    return getConfig().server_origin
  } catch {
    return null
  }
}

function setAppWindow(window: any) {
  appWindow = window
}

function setServerArgs(args: any) {
  serverArgs = args
}

function loadComfyUI() {
  if (!appWindow) {
    throw new Error(
      'loadComfyUI is not available — ComfyUI views are managed by the new install architecture'
    )
  }
  appWindow.loadComfyUI(serverArgs)
}

/**
 * A→C 切换回调：由 main/index.ts 注入（同窗口内切到 ComfyUI 视图，
 * 无运行实例时面板切到 install 选择器）。handlers 的 artify-loadComfyUI 调用它。
 */
let comfyUIFocusHandler: (() => Promise<boolean>) | null = null

export function setComfyUIFocusHandler(handler: () => Promise<boolean>): void {
  comfyUIFocusHandler = handler
}

/** 切到 ComfyUI：优先同窗口切 comfy 视图，无实例时回退选择器 */
export async function focusComfyUI(): Promise<boolean> {
  if (comfyUIFocusHandler) {
    return comfyUIFocusHandler()
  }
  return false
}

/**
 * C→A 切换回调：由 main/index.ts 注入（同窗口内把面板切回 A UI）。
 * handlers 的 artify-loadArtifyLab 调用它。
 */
let artifyLabFocusHandler: (() => Promise<boolean>) | null = null

export function setArtifyLabFocusHandler(handler: () => Promise<boolean>): void {
  artifyLabFocusHandler = handler
}

/** 切回 A UI：同窗口内显示 A UI 面板 */
export async function showArtifyLab(): Promise<boolean> {
  if (artifyLabFocusHandler) {
    return artifyLabFocusHandler()
  }
  return false
}

export default {
  injectHtml,
  getUrl,
  getConfig,
  startServer,
  getServerPort,
  setAppWindow,
  setServerArgs,
  loadComfyUI,
  showArtifyLab,
  focusComfyUI,
  appWindow,
  serverArgs
}
