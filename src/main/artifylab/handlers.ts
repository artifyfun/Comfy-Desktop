import { app, dialog, ipcMain, shell } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import artifyUtils from '.'
import { fetchWithRetry } from './utils/fetch'
import { get as getSetting } from '../settings'

/** 产物另存为的合法来源根:settings 配置的 output/input 目录 */
function settingsOutputInputRoots(): string[] {
  const roots: string[] = []
  try {
    const out = getSetting('outputDir')
    const inp = getSetting('inputDir')
    if (typeof out === 'string' && out) roots.push(out)
    if (typeof inp === 'string' && inp) roots.push(inp)
  } catch {}
  return roots
}

/**
 * 解析「活动 install」的 ComfyUI 子目录（custom_nodes 等快捷操作的目标）。
 * 优先级：正在运行的 install → 最近一次 surface 记录 → 安装目录下第一个
 * 已落盘的 install。解析失败返回 null（调用方转为用户可见错误）。
 */
async function resolveActiveComfyuiSubdir(sub: string | undefined): Promise<string | null> {
  try {
    const installations = await import('../installations')
    const { getLastActiveSurface } = await import('../lib/lastSession')

    let installId: string | null = null
    // 1) 正在运行的 install（设置面板通常服务于它）
    try {
      const { _runningSessions } = await import('../lib/ipc/shared')
      installId = _runningSessions.keys().next().value ?? null
    } catch {}
    // 2) 最近一次 surface 记录（上次活跃的 install）
    if (!installId) {
      try {
        const last = getLastActiveSurface()
        installId = last?.kind === 'instance' ? last.installationId : null
      } catch {}
    }
    // 3) 安装目录下第一个存在的 install
    if (!installId) {
      const installDir = getSetting('installDir')
      if (installDir && fs.existsSync(installDir)) {
        const entries = fs
          .readdirSync(installDir, { withFileTypes: true })
          .filter((e) => e.isDirectory())
        if (entries[0]) installId = entries[0].name
      }
    }
    if (!installId) return null

    const inst = await installations.get(installId)
    if (inst?.installPath && fs.existsSync(inst.installPath)) {
      const comfyuiDir = path.join(inst.installPath, 'ComfyUI')
      if (!fs.existsSync(comfyuiDir)) {
        console.warn('[openRootFolder] comfyui dir missing:', comfyuiDir)
        return null
      }
      const target = sub ? path.join(comfyuiDir, sub) : comfyuiDir
      if (!fs.existsSync(target)) {
        console.warn('[openRootFolder] target missing:', target)
        return null
      }
      return target
    }
    // 会话 key 可能是安装名（部分启动路径）而非 inst-id，get() 拿不到或拿到的
    // 记录没有 installPath —— 退化为遍历本地 install，按名字/存在性匹配。
    const all = await installations.list()
    const wanted = String(installId)
    const local =
      all.find((i) => i.installPath && i.name === wanted) ??
      all.find((i) => i.installPath && fs.existsSync(path.join(i.installPath, 'ComfyUI')))
    if (!local?.installPath) {
      console.warn('[openRootFolder] no local install with installPath for key:', wanted)
      return null
    }
    const comfyuiDir = path.join(local.installPath, 'ComfyUI')
    if (!fs.existsSync(comfyuiDir)) return null
    const target = sub ? path.join(comfyuiDir, sub) : comfyuiDir
    return fs.existsSync(target) ? target : null
  } catch (err) {
    console.warn('[openRootFolder] resolveActiveComfyuiSubdir failed:', err)
    return null
  }
}

/** outputDir 等设置值的父目录（共享根）。取不到时返回 null。 */
function parentOfSettingDir(key: 'outputDir' | 'inputDir'): string | undefined {
  try {
    const dir = getSetting(key)
    if (typeof dir === 'string' && dir) return path.dirname(dir)
  } catch {}
  return undefined
}

/** 活动 install 的 venv python（managed: ComfyUI/.venv，adopted: 记录路径）。 */
async function getActiveInstallPythonPath(): Promise<string | null> {
  try {
    const [{ getActivePythonPath }, installations, { _runningSessions }, { getLastActiveSurface }] =
      await Promise.all([
        import('../lib/pythonEnv'),
        import('../installations'),
        import('../lib/ipc/shared'),
        import('../lib/lastSession')
      ])

    let installId: string | null = _runningSessions.keys().next().value ?? null
    if (!installId) {
      const last = getLastActiveSurface()
      installId = last?.kind === 'instance' ? last.installationId : null
    }
    if (!installId) {
      const all = await installations.list()
      const local = all.find((i) => i.installPath && fs.existsSync(i.installPath))
      installId = local?.id ?? null
    }
    if (!installId) return null
    let inst = await installations.get(installId)
    // 会话 key 可能是安装名（部分启动路径）——按名字兜底，再退化为
    // 第一个本地已落盘的 install（与 resolveActiveComfyuiSubdir 一致）。
    if (!inst?.installPath) {
      const all = await installations.list()
      const wanted = String(installId)
      inst =
        all.find((i) => i.installPath && i.name === wanted) ??
        all.find((i) => i.installPath && fs.existsSync(path.join(i.installPath, 'ComfyUI'))) ??
        null
    }
    if (!inst) return null
    return getActivePythonPath(inst)
  } catch {
    return null
  }
}

export function registerArtifyHandlers() {
  ipcMain.handle('artify-selectFile', async (_event, _data) => {
    const { canceled, filePaths } = await dialog.showOpenDialog({
      properties: ['openDirectory']
    })
    if (!canceled) {
      return filePaths[0]
    }
  })

  // —— 工作台文件权限(A/B 档默认可用) ——
  // A:产物另存为。系统保存对话框 + 复制,不涉及 agent 写用户目录。
  ipcMain.handle(
    'artify-saveArtifact',
    async (_event, payload: { sourcePath: string; suggestedName?: string; title?: string }) => {
      try {
        const src = String(payload?.sourcePath ?? '')
        if (!src || !path.isAbsolute(src)) return { ok: false, error: 'invalid source path' }
        if (!fs.existsSync(src)) return { ok: false, error: 'source file not found' }
        // 只允许从 ComfyUI 的 output/input 目录取产物,防止被诱导读任意系统文件
        const allowed = settingsOutputInputRoots()
        const resolved = path.resolve(src)
        if (!allowed.some((root) => resolved.startsWith(path.resolve(root) + path.sep))) {
          return { ok: false, error: 'source path outside ComfyUI output/input' }
        }
        const { canceled, filePath } = await dialog.showSaveDialog({
          title: payload.title || '保存产物',
          defaultPath: payload.suggestedName || path.basename(resolved)
        })
        if (canceled || !filePath) return { ok: false, error: 'canceled' }
        await fs.promises.copyFile(resolved, filePath)
        return { ok: true, savedTo: filePath }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  // 在系统文件管理器中定位文件(showItemInFolder)。同 saveArtifact 的来源白名单。
  ipcMain.handle('artify-revealInFolder', async (_event, payload: { path: string }) => {
    try {
      const src = String(payload?.path ?? '')
      if (!src || !path.isAbsolute(src)) return { ok: false, error: 'invalid path' }
      if (!fs.existsSync(src)) return { ok: false, error: 'file not found' }
      const allowed = settingsOutputInputRoots()
      const resolved = path.resolve(src)
      if (!allowed.some((root) => resolved.startsWith(path.resolve(root) + path.sep))) {
        return { ok: false, error: 'path outside ComfyUI output/input' }
      }
      shell.showItemInFolder(resolved)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  })

  // B:本地文件引用登记。系统打开对话框由用户显式选择,返回绝对路径与元数据;
  // 不复制不转发——是否吃路径由执行链路按同机检测决定,否则回退上传。
  ipcMain.handle(
    'artify-referenceLocalFile',
    async (_event, payload: { filters?: { name: string; extensions: string[] }[] }) => {
      try {
        const { canceled, filePaths } = await dialog.showOpenDialog({
          properties: ['openFile', 'multiSelections'],
          filters: payload?.filters
        })
        if (canceled || filePaths.length === 0) return { ok: false, error: 'canceled' }
        const items = await Promise.all(
          filePaths.map(async (p) => {
            const st = await fs.promises.stat(p)
            return { path: p, filename: path.basename(p), size: st.size }
          })
        )
        return { ok: true, items }
      } catch (e) {
        return { ok: false, error: (e as Error).message }
      }
    }
  )

  ipcMain.handle('artify-getConfig', async (_event, _data) => {
    return artifyUtils.getConfig()
  })

  ipcMain.handle('artify-loadComfyUI', async (_event, _data) => {
    await artifyUtils.focusComfyUI()
  })

  ipcMain.handle('artify-loadArtifyLab', async (_event, _data) => {
    await artifyUtils.showArtifyLab()
  })

  /**
   * 停止后端批量执行：向 ComfyUI 发送 interrupt 请求
   * @returns 是否成功停止执行
   */
  ipcMain.handle('artify-stopExecution', async () => {
    try {
      const config = artifyUtils.getConfig()
      const response = await fetchWithRetry(`${config.comfy_origin}/interrupt`, {
        method: 'POST'
      })
      return { success: response.ok }
    } catch (error) {
      console.error('Error stopping execution:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  ipcMain.handle('artify-getAppInfo', async (_event, _data) => {
    return {
      version: app.getVersion(),
      name: app.getName(),
      repository: 'artifyfun/Comfy-Desktop' // 添加repository字段用于GitHub发布页
    }
  })

  /**
   * 打开output目录
   * @param event IPC事件
   * @returns 是否成功打开目录
   */
  ipcMain.handle('artify-openOutputFolder', async (_event) => {
    try {
      // ComfyUI 通过 `--output-directory` 启动（见 launch.ts），实际输出目录
      // 是 settings 的 `outputDir`（默认 <dataRoot>/ComfyUI-Shared/output，
      // 可被用户/per-install 覆盖）。basePath/output 并非真实输出位置。
      const outputPath = getSetting('outputDir')
      if (!outputPath) {
        throw new Error('Output directory not configured')
      }

      // 检查目录是否存在，如果不存在则创建
      if (!fs.existsSync(outputPath)) {
        fs.mkdirSync(outputPath, { recursive: true })
      }

      // 打开目录
      await shell.openPath(outputPath)
      return { success: true, path: outputPath }
    } catch (error) {
      console.error('Error opening output folder:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 获取output目录路径
   * @param event IPC事件
   * @returns output目录的完整路径
   */
  ipcMain.handle('artify-getOutputPath', async (_event) => {
    try {
      const outputPath = getSetting('outputDir')
      if (!outputPath) {
        throw new Error('Output directory not configured')
      }
      return { success: true, path: outputPath }
    } catch (error) {
      console.error('Error getting output path:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 扫描文件夹下所有文件，返回文件信息数组
   * @param event IPC事件
   * @param folderPath 要扫描的文件夹路径
   * @returns 文件信息数组，包含完整路径、文件名、后缀等信息
   */
  ipcMain.handle('artify-scanFolder', async (_event, folderPath: string) => {
    try {
      // 验证路径是否存在且是目录
      const stats = fs.statSync(folderPath)
      if (!stats.isDirectory()) {
        throw new Error('Path is not a directory')
      }

      const files: Array<{
        fullPath: string
        fileName: string
        extension: string
        size: number
        isDirectory: boolean
        lastModified: Date
        relativePath: string
      }> = []

      // 只扫描当前目录，不递归
      const items = fs.readdirSync(folderPath)
      for (const item of items) {
        const fullPath = path.join(folderPath, item)
        const itemRelativePath = item
        try {
          const itemStats = fs.statSync(fullPath)
          const extension = path.extname(item)
          files.push({
            fullPath,
            fileName: item,
            extension,
            size: itemStats.size,
            isDirectory: itemStats.isDirectory(),
            lastModified: itemStats.mtime,
            relativePath: itemRelativePath
          })
        } catch (error) {
          // 忽略无法访问的文件/目录
          console.warn(`Cannot access ${fullPath}:`, error)
        }
      }
      return files
    } catch (error) {
      console.error('Error scanning folder:', error)
      throw error
    }
  })

  /**
   * 打开根目录下的指定文件夹
   * @param event IPC事件
   * @param folderName 要打开的文件夹名称（如 'output', 'models' 等）
   * @returns 是否成功打开目录
   */
  ipcMain.handle('artify-openRootFolder', async (_event, folderName: string) => {
    try {
      // 目录按语义映射到真实运行时位置。`basePath` 是上游 Electron 模板的
      // 孤儿键——全工程没有任何写入点，原实现永远抛 'Base path not
      // configured'，设置面板「快捷操作」tab 全部按钮失效。映射：
      //   input        → settings inputDir
      //   output       → settings outputDir（与 artify-openOutputFolder 一致）
      //   models       → settings modelsDirs[0]（共享模型库）
      //   custom_nodes → 当前活动 install 的 ComfyUI/custom_nodes
      //   ''（根）     → 共享根（output/input/models 的上一级）
      const folder = String(folderName ?? '')
      let targetPath: string | undefined
      if (folder === 'input') {
        targetPath = getSetting('inputDir')
      } else if (folder === 'output') {
        targetPath = getSetting('outputDir')
      } else if (folder === 'models') {
        const dirs = getSetting('modelsDirs')
        targetPath = Array.isArray(dirs) ? dirs[0] : undefined
      } else if (folder === 'custom_nodes') {
        targetPath = (await resolveActiveComfyuiSubdir('custom_nodes')) ?? undefined
      } else {
        targetPath = parentOfSettingDir('outputDir')
      }

      if (!targetPath) {
        throw new Error('Target folder not available')
      }

      // 共享目录约定由启动流程落盘；这里兜底创建，避免 openPath 静默失败
      if (!fs.existsSync(targetPath)) {
        fs.mkdirSync(targetPath, { recursive: true })
      }

      await shell.openPath(targetPath)
      return { success: true, path: targetPath, openedFolder: folder || 'root' }
    } catch (error) {
      console.error('Error opening root folder:', error)
      return { success: false, error: (error as Error).message }
    }
  })

  /**
   * 打开命令行
   * @param event IPC事件
   * @param type 命令行类型，python: python虚拟机环境下的python可执行文件
   * @returns 是否成功打开
   */
  ipcMain.handle('artify-openCMD', async (_event, type: string) => {
    try {
      if (type === 'python') {
        // 用当前活动 install 的 venv python（managed: <install>/ComfyUI/.venv，
        // adopted: 记录的 adoptedPythonPath）。原实现依赖从未写入的 basePath
        // 孤儿键拼 '<basePath>/.venv'，永远返回 'Base path not configured'。
        const pythonInterpreterPath = await getActiveInstallPythonPath()
        if (!pythonInterpreterPath) {
          throw new Error('No active ComfyUI installation found')
        }
        return {
          success: true,
          cmd: pythonInterpreterPath
        }
      }
      // 未知的 type：之前落穿返回 undefined，前端 `const { cmd } = await ...` 解构会抛错。
      return { success: false, error: 'Unknown cmd type: ' + type }
    } catch (error) {
      console.error('Error opening cmd:', error)
      return { success: false, error: (error as Error).message }
    }
  })
}
