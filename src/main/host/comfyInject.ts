import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import { getFrontendPath } from '../artifylab/utils/resourcePaths'

/**
 * 生成注入 comfy_inject.js 的脚本源码（传给 `executeJavaScript`）。
 *
 * dev/prod 都直接返回脚本源码由 executeJavaScript 执行——不走动态
 * <script> 标签：Comfy Cloud 页面的 CSP（script-src 'self' https:）
 * 会拒绝 http://localhost:5000 的 dev 加载，导致 cloud 下浮标按钮
 * 永不出现；executeJavaScript 不经过 CSP。
 *
 * 优先读仓库内 vite public 源文件（dev 无需 build:copy），找不到再回退
 * 打包进 frontend 资源的 comfy_inject.min.js。两者都依赖脚本自身的
 * 幂等保护（`__artifyInjectLoaded`）防止多次注入（comfyView attach 注入
 * + WorkflowModal iframe 的子 frame 注入 + iframe 重复导航）。
 */
export function getComfyInjectScriptSource(): string {
  // vite dev 模式下 public/ 原样 serve，直接读仓库内源文件；DEV_MODE
  // 环境变量与 electron-vite dev 的注入环境可能不一致时也优先源文件。
  // 注意不要用 __dirname 反推仓库路径——electron-vite 打包后 __dirname
  // 在 dev/不同启动方式下并不可靠，曾导致回退读到旧的 min.js 产物。
  const devPath = path.join(app.getAppPath(), 'packages', 'frontend', 'public', 'comfy_inject.js')
  if (fs.existsSync(devPath)) {
    return fs.readFileSync(devPath, 'utf-8')
  }
  const comfyInjectPath = path.join(getFrontendPath(), 'comfy_inject.min.js')
  if (fs.existsSync(comfyInjectPath)) {
    return fs.readFileSync(comfyInjectPath, 'utf-8')
  }
  return ''
}
