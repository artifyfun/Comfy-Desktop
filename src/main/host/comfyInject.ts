import fs from 'node:fs'
import path from 'node:path'
import { getFrontendPath, isDevMode } from '../artifylab/utils/resourcePaths'

/**
 * 生成注入 comfy_inject.js 的脚本源码（传给 `executeJavaScript`）。
 *
 * dev：动态 script 标签从 vite dev server 加载源码（无需 build:copy，
 * 与旧版 DEV_MODE 行为一致）；prod：读取打包进 frontend 资源的
 * comfy_inject.min.js 直接执行。两者都依赖脚本自身的幂等保护
 * （`__artifyInjectLoaded`）防止多次注入（comfyView attach 注入 +
 * WorkflowModal iframe 的子 frame 注入 + iframe 重复导航）。
 */
export function getComfyInjectScriptSource(): string {
  if (isDevMode) {
    return (
      `(function(){var s=document.createElement('script');` +
      `s.src='http://localhost:5000/comfy_inject.js?rand='+Math.random();` +
      `document.head.appendChild(s)})()`
    )
  }
  const comfyInjectPath = path.join(getFrontendPath(), 'comfy_inject.min.js')
  if (fs.existsSync(comfyInjectPath)) {
    return fs.readFileSync(comfyInjectPath, 'utf-8')
  }
  return ''
}
