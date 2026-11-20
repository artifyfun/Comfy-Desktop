import fs from 'fs'
import path from 'node:path'
import { findSitePackages } from '../sources/standalone/envPaths'
import { getActiveVenvDir } from '../lib/pythonEnv'
import type { InstallationRecord } from '../installations'
import { getFrontendPath } from './utils/resourcePaths'

const EXTENSION_FILE = 'artify_inject.js'
// 构建产物只保留 terser 压缩版（build 脚本会删除明文 comfy_inject.js）
const SOURCE_FILE = 'comfy_inject.min.js'

/** 读文件文本，缺失/不可读返回 null。 */
async function readTextIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8')
  } catch {
    return null
  }
}

/**
 * 将 A UI 的 comfy_inject.js 同步为 ComfyUI 前端扩展 artify_inject.js
 * （位于 comfyui_frontend_package/static/extensions，ComfyUI 升级/重装会覆盖）。
 * 幂等：源文件或目标目录任一缺失时静默跳过；写入失败仅告警，绝不打断 launch。
 */
export async function syncArtifyExtension(installation: InstallationRecord): Promise<void> {
  const sourceContent = await readTextIfExists(path.join(getFrontendPath(), SOURCE_FILE))
  if (sourceContent === null) return

  const sitePackages = findSitePackages(getActiveVenvDir(installation))
  if (!sitePackages) return

  const extensionsDir = path.join(sitePackages, 'comfyui_frontend_package', 'static', 'extensions')
  if (!fs.existsSync(extensionsDir)) return

  const targetPath = path.join(extensionsDir, EXTENSION_FILE)
  if ((await readTextIfExists(targetPath)) === sourceContent) return

  try {
    await fs.promises.writeFile(targetPath, sourceContent, 'utf-8')
    console.info(`[artify] synced ${EXTENSION_FILE} -> ${targetPath}`)
  } catch (err) {
    console.warn('Failed to sync artify_inject.js:', err)
  }
}
