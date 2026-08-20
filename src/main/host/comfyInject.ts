import fs from 'node:fs'
import path from 'node:path'
import { getFrontendPath, isDevMode } from '../artifylab/utils/resourcePaths'

/**
 * 生成注入 comfy_inject.js 的脚本源码（传给 `executeJavaScript`）。
 *
 * dev/prod 都直接返回脚本源码由 executeJavaScript 执行——不走动态
 * <script> 标签：Comfy Cloud 页面的 CSP（script-src 'self' https:）
 * 会拒绝 http://localhost:5000 的 dev 加载，导致 cloud 下浮标按钮
 * 永不出现；executeJavaScript 不经过 CSP。
 *
 * dev：读 vite dev server 的 public 源文件（无需 build:copy）；
 * prod：读打包进 frontend 资源的 comfy_inject.min.js。
 * 两者都依赖脚本自身的幂等保护（`__artifyInjectLoaded`）防止多次注入
 * （comfyView attach 注入 + WorkflowModal iframe 的子 frame 注入 +
 * iframe 重复导航）。
 */
export function getComfyInjectScriptSource(): string {
  if (isDevMode) {
    // vite dev 模式下 public/ 原样 serve，直接读仓库内源文件
    const devPath = path.resolve(__dirname, '../../../packages/frontend/public/comfy_inject.js')
    if (fs.existsSync(devPath)) {
      return fs.readFileSync(devPath, 'utf-8')
    }
    return ''
  }
  const comfyInjectPath = path.join(getFrontendPath(), 'comfy_inject.min.js')
  if (fs.existsSync(comfyInjectPath)) {
    return fs.readFileSync(comfyInjectPath, 'utf-8')
  }
  return ''
}
