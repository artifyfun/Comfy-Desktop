import './lib/uninstallCleanupEntry'
import {
  app,
  Menu,
  ipcMain,
  net,
  dialog,
  crashReporter,
  nativeTheme,
  powerMonitor,
  shell,
  session,
  BrowserWindow
} from 'electron'
import type { MessageBoxOptions, Tray, WebContentsView } from 'electron'
import path from 'path'
import fs from 'fs'
import { normaliseFirstUseMode } from '../shared/firstUseMode'

// 开发调试：ARTIFY_DEV_DEBUG_PORT=9222 pnpm dev → 开 CDP 供浏览器自动化验收
// （只在显式设置时生效，不影响正常 dev/打包）
if (process.env.ARTIFY_DEV_DEBUG_PORT) {
  app.commandLine.appendSwitch(
    'remote-debugging-port',
    String(parseInt(process.env.ARTIFY_DEV_DEBUG_PORT, 10) || 9222)
  )
}
import { isNewWindowDashboardPage } from '../shared/dashboardPages'
import { execFile } from 'child_process'
import type { ChildProcess } from 'child_process'
import todesktop from '@todesktop/runtime'
import * as ipc from './lib/ipc'
import { getAppVersion } from './lib/ipc'
import { recordHomeTourAudience } from './lib/homeTourAudience'
import { requestHomeTourReplay } from './lib/ipc/registerHomeTourHandlers'
import type { ExitCallbackInfo } from './lib/ipc'
import { closeAllPopouts } from './lib/popoutWindows'
import { disposeAllTerminals } from './lib/terminal'
import * as updater from './lib/updater'
import * as settings from './settings'
import { installAppMenu } from './menu'
import * as i18n from './lib/i18n'
import { migrateXdgPaths, persistWinDataRootChoice } from './lib/paths'
import { relaunchIntoUninstallCleanup } from './lib/uninstallCleanup'
import { saveWindowBounds } from './lib/windowState'
import { flushLastSessionSync, recordDashboardSurface } from './lib/lastSession'
import { registerProcessErrorHandlers } from './lib/processErrorHandlers'
import { registerOutputFilesScheme, registerOutputFolderHandlers } from './lib/outputFolders'
import { initAppLog, flushOperationOutput } from './lib/appLog'
import { pruneCrashDumps } from './lib/crashDumps'
import { createStartupReentryGate } from './lib/startupReentryGate'
import { registerTitleTooltipIpc } from './popups/titleTooltip'
import { registerTitleCoachmarkIpc } from './popups/titleCoachmark'
import { openSystemModal, openSystemModalAsync, registerSystemModalIpc } from './popups/systemModal'
import {
  registerTitlePopupIpc,
  triggerPickerSnapshotBroadcast,
  type InstancePickerInstall
} from './popups/titlePopup'
import { registerPickerSettingsIpc } from './popups/pickerSettingsHandlers'
import { waitForPort, COMFY_BOOT_TIMEOUT_MS } from './lib/process'
import {
  clearQuitReason,
  isQuitInProgress,
  isUpdateInstallQuit,
  setQuitReason,
  setSessionEnding
} from './lib/quit-state'
import { createWillQuitHandler } from './lib/quitWork'
import {
  postponeQuitWhileDestroyedWindowsHaveLiveWebContents,
  trackWindowWebContents
} from './lib/quitAfterWindowWebContents'
import { showUpdateInstallSplash } from './lib/updateSplash'
import { syncCloudWindowWorkspace } from './lib/cloudWorkspace'
import type { InstallationRecord } from './installations'
import {
  cleanupTempDownloads,
  downloadEvents,
  getDownloadsTrayState,
  hasActiveModelTransfers,
  initializeModelDownloads,
  resumeModelDownloadsAfterWake,
  suspendActiveModelDownloadsForQuit,
  suspendActiveModelDownloadsForSleep
} from './lib/comfyDownloadManager'
import { stopAgentPrefetches } from './lib/agentRequirementsLaunch'
import { prefetchEnrolledAgents } from './lib/agentPrefetch'
import { hasActiveTemplateDownloads } from './sources/standalone/templateDownloadTask'
import { registerAssetDownloadHandlers } from './lib/ipc/registerAssetDownloadHandlers'
import { registerDownloadHandlers } from './lib/ipc/registerDownloadHandlers'
import { registerTemplateInputAssetHandlers } from './lib/ipc/registerTemplateInputAssetHandlers'
import { emitInstanceStartedTelemetry } from './lib/ipc/sessionStartTelemetry'
import { emitStorageTelemetry } from './lib/ipc/storageTelemetry'
import {
  get as getInstallation,
  installationEvents,
  list as listInstallations
} from './installations'
import { startPeriodicReleaseChecks } from './lib/release-cache-startup'
import { COMFY_BG, SPLASH_DARK, TITLEBAR_BG, type SplashTheme } from './lib/theme'
import { titleBarOverlayForTheme } from './lib/titleBarOverlay'
import {
  sourceMap,
  _broadcastToRenderer,
  _runningSessions,
  _operationAborts,
  _activeOperationStatus,
  _getLaunchingInstallationIds,
  _setActiveLaunchPickerWorkspace,
  launchHadWindow,
  stopRunning,
  resolveTheme,
  MSG_CANCELLED,
  type PickerOperationStatus
} from './lib/ipc/shared'
import { enrichInstallationsForRenderer } from './lib/ipc/registerInstallationHandlers'
import { getSnapshotListData } from './lib/snapshots'
import { update as updateInstallation } from './installations'
import { pinAutoStartToALocalBuild } from './lib/firstBuildAutoStart'
import { lookupInstallUpdateOverride, recordIpcInvocation } from './lib/e2eOverrides'
import * as mainTelemetry from './lib/telemetry'
import {
  clearLegacyIdentityRetryMarker,
  consumeFirstLaunch,
  getDeviceId,
  getIdClass,
  hasCompletedFirstLaunch,
  hasPersistedDeviceId,
  initDeviceId,
  markIdentityMigrationCompleted,
  startMachineIdLookup
} from './lib/deviceId'
import { getInitialAnonymousDistinctId } from './lib/websiteAnonymousIdentity'
import { recoverPendingIdentityRotation } from './lib/pendingIdentityMerge'
import { initExperiments } from './lib/experiments'
import { initCloudFreeRuns } from './lib/cloudFreeRuns'
import { initCoreBetaFlags, refreshCoreBetaFlags } from './lib/coreBetaCampaignFlags'
import { DesktopConfig } from './artifylab/store/desktopConfig'
import { registerArtifyHandlers } from './artifylab/handlers'
import { startServer } from './artifylab/server'
import { setArtifyPanelMode, setArtifyPanelPort } from './artifylab/panelMode'
import { setArtifyLabFocusHandler, setComfyUIFocusHandler } from './artifylab'
import { initEmbeddedSessionFlag } from './lib/embeddedSessionFlag'
import { runningAppCount, runningApps } from './apps/appPageView'
import { appsQuitPrompt, QUIT_BUTTON } from './apps/appsQuitPrompt'
import { DRAFT_LINK_SCHEME, findDraftLink } from './apps/draftApps'
import { openDraftLink } from './apps/draftLinks'
import {
  DEV_SERVER_START_DATA,
  devCopyLockDir,
  isDevServerStart,
  LOCK_RETRY_INTERVAL_MS,
  planDraftLinkStartup,
  retryLock,
  type DraftLinkStartup
} from './apps/draftLinkStartup'
import { runningPortOf } from './apps/localBuild'
import {
  isRunningForAppsOnly,
  runsWithItsWindowClosed,
  startWithDesktop,
  stopBuildsRunningForAppsOnly
} from './apps/localComfy'
import { initWorkspaceMintSwitchFlag } from './lib/workspaceMintSwitchFlag'
import { getCloudSession } from './devplatform/session'
import { initStaffFlagTargeting } from './lib/staffFlagTargeting'
import { initUserTier } from './lib/userTier'
import { readSmartAppControlState } from './lib/smartAppControl'

import {
  bringToFront,
  canRestartFromPicker,
  claimAttachHost,
  comfyWindows,
  computeBodyMode,
  consumeAttachClaim,
  dropAttachClaimsForWindow,
  findEntryByHostWindow,
  findEntryByTitleBarSender,
  findHostWindowByPanelSender,
  getEntryByInstallationId,
  isChooserHost,
  isInstallHost,
  maximizeIfPendingReveal,
  openOrFocusAnyHostWindow,
  openOrFocusChooserHostWindow,
  openOrFocusHomeHostWindow,
  raiseAllHostWindows,
  routeBuildOpen,
  setHostFactories,
  shouldConfirmKillForEntry,
  visibleSurface
} from './host/registry'
import type { BuildOpenRoute, ComfyWindowEntry } from './host/registry'
import {
  applyChooserHostThemeToAll,
  createHostWindow,
  expectedPartitionFor,
  openChooserHostWindow,
  quitsOnceEveryWindowClosed,
  rebuildComfyViewIfNeeded,
  setHostWindowFactories
} from './host/createHostWindow'
import { attachInstall, setAttachFactories, type ZoomResetSource } from './host/attach'
import { navigatorFor } from './host/buildNavigator'
import { resetCanvasRendered } from './lib/canvasEntry'
import { IN_PLACE_RELAUNCH, REQUIRES_STOPPED } from '../types/ipc'
import type { CloseComfyWindowOptions } from '../types/ipc'
import { dispatchSessionAction, handleLaunch } from './lib/ipc/sessionActions'
import { applyAttachHostPreview, clearAttachHostPreview } from './host/attachHostPreview'
import { takePriorSessionUnclean } from './lib/comfyProcessRecord'
import {
  _detachInstallImpl,
  confirmAndCloseAllHostWindows,
  confirmAndCloseHostWindow,
  confirmCloseInstanceWindow,
  consultPanelRendererClose,
  detachOrphanedInstallHosts,
  preClearedClose,
  returnToDashboard
} from './host/detach'
import { closeBuildWindow } from './host/closeBuildWindow'
import {
  destroyPanelView,
  ensurePanelView,
  focusActiveBody,
  prewarmAttachedPanel,
  refreshComfyTabBody,
  registerPanelViewIpc,
  sendToPanelDeferred,
  setActivePanel,
  setPanelSurface
} from './host/panelView'

export type { ComfyPanelKey } from './host/registry'

try {
  crashReporter.start({ uploadToServer: false })
} catch {}

if (settings.get('hardwareAcceleration') === false) {
  app.disableHardwareAcceleration()
}

registerOutputFilesScheme()

todesktop.init({ autoUpdater: false })

const APP_VERSION = getAppVersion()

let tray: Tray | null = null

let _stopPeriodicReleaseChecks: (() => void) | null = null

function focusExternalProcessWindow(pid: number): void {
  if (process.platform === 'win32') {
    const vbsPath = path.join(app.getPath('temp'), `comfy-focus-${pid}.vbs`)
    fs.writeFileSync(vbsPath, `CreateObject("WScript.Shell").AppActivate ${pid}`)
    execFile('wscript.exe', ['//Nologo', '//B', vbsPath], { windowsHide: true }, () => {
      fs.unlink(vbsPath, () => {})
    })
  } else if (process.platform === 'darwin') {
    execFile(
      'osascript',
      [
        '-e',
        `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`
      ],
      () => {}
    )
  }
}
function updateTrayMenu(): void {
  if (!tray) return
  const contextMenu = Menu.buildFromTemplate([
    {
      label: i18n.t('tray.showApp'),
      click: () => {
        openOrFocusChooserHostWindow()
      }
    },
    { type: 'separator' },
    { label: i18n.t('tray.quit'), click: () => quitApp() }
  ])
  tray.setContextMenu(contextMenu)
}

function confirmQuitStopsAppRuns(): boolean {
  const [only] = Array.from(comfyWindows.keys()).flatMap((windowKey) => runningApps(windowKey))
  const prompt = appsQuitPrompt(
    {
      running: runningAppCount(),
      onlyTitle: only?.title ?? null,
      downloading: hasActiveTemplateDownloads()
    },
    i18n.t
  )
  return prompt === null || dialog.showMessageBoxSync(prompt) === QUIT_BUTTON
}

function quitApp(): void {
  if (!confirmQuitStopsAppRuns()) return
  setQuitReason('user-quit')
  ipc.cancelAll()
  for (const [, entry] of comfyWindows) {
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.quit()
}

const STARTUP_INSTALL_QUIT_BACKSTOP_MS = 4_000
const STOP_STAMP_QUIT_WAIT_MS = 2_000

async function openStartupSurface(): Promise<void> {
  const autoStartBuild = await pinAutoStartToALocalBuild().catch((err: unknown) => {
    console.warn('[auto-start] could not read the Auto start build:', err)
    return null
  })
  const explicitInst = settings.get('firstUseCompleted') === true ? autoStartBuild : null

  openOrFocusHomeHostWindow()

  if (explicitInst) void startWithDesktop(explicitInst)
}

function onComfyExited({ installationId, crashed }: ExitCallbackInfo = {}): void {
  if (!installationId) return
  if (crashed) recordDashboardSurface()
  refreshComfyTabBody(installationId)
}

interface RelaunchState {
  originalUrl: string
  theme: SplashTheme
  navBlocker: (e: Electron.Event) => void
  token: number
}

const relaunchStates = new Map<string, RelaunchState>()
const comfyZoomResets = new Map<string, (source: ZoomResetSource) => void>()
let relaunchTokenCounter = 0

async function onModelFolderRelaunch({
  installationId
}: {
  installationId: string
}): Promise<void> {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  const comfyContents = entry.comfyView.webContents

  const prev = relaunchStates.get(installationId)
  if (prev) comfyContents.off('will-navigate', prev.navBlocker)

  const currentUrl = comfyContents.getURL()
  const originalUrl = prev ? prev.originalUrl : currentUrl

  const blockNav = (e: Electron.Event): void => {
    e.preventDefault()
  }
  comfyContents.on('will-navigate', blockNav)

  const theme: SplashTheme = SPLASH_DARK
  const token = ++relaunchTokenCounter

  relaunchStates.set(installationId, { originalUrl, theme, navBlocker: blockNav, token })
  await navigatorFor(entry).showSplash(theme)
}

function onComfyRestarted({
  installationId,
  process: _proc
}: { installationId?: string; process?: ChildProcess } = {}): void {
  if (!installationId) return
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  const comfyContents = entry.comfyView.webContents

  const state = relaunchStates.get(installationId)
  const myToken = state?.token

  const currentUrl = state?.originalUrl || comfyContents.getURL()
  if (!currentUrl) return

  const url = new URL(currentUrl)
  const port = parseInt(url.port, 10)
  if (!port) return

  const cleanupRelaunchState = (): void => {
    const current = relaunchStates.get(installationId)
    if (current && current.token === myToken) {
      if (!entry.window.isDestroyed()) comfyContents.off('will-navigate', current.navBlocker)
      relaunchStates.delete(installationId)
    }
  }

  const isStale = (): boolean => {
    const current = relaunchStates.get(installationId)
    return !!current && current.token !== myToken
  }

  waitForPort(port, '127.0.0.1', { timeoutMs: COMFY_BOOT_TIMEOUT_MS })
    .then(async () => {
      for (let attempt = 0; attempt < 10; attempt++) {
        if (entry.window.isDestroyed() || isStale()) {
          cleanupRelaunchState()
          return
        }
        try {
          const resp = await net.fetch(currentUrl, { method: 'HEAD' })
          resp.body?.cancel()
          break
        } catch {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)))
        }
      }
      if (entry.window.isDestroyed() || isStale()) {
        cleanupRelaunchState()
        return
      }
      if (relaunchStates.has(installationId) && !state) return
      cleanupRelaunchState()
      entry.comfyView.setBackgroundColor(state?.theme.bg ?? COMFY_BG)
      await navigatorFor(entry).open(currentUrl)
    })
    .catch((err) => {
      cleanupRelaunchState()
      console.error(`ComfyUI restart failed for ${installationId}:`, err)
    })
}

function onStop({ installationId }: { installationId?: string } = {}): void {
  if (installationId) {
    refreshComfyTabBody(installationId)
  } else {
    for (const entry of comfyWindows.values()) {
      if (isInstallHost(entry)) {
        refreshComfyTabBody(entry.installationId)
      }
    }
  }
}

function onLaunch({
  port,
  url,
  process: proc,
  installation,
  mode
}: {
  port: number
  url?: string
  process: ChildProcess | null
  installation: InstallationRecord
  mode: string
}): void {
  const comfyUrl = url || `http://127.0.0.1:${port}`
  const installationId = installation.id

  if (mode === 'console' || mode === 'external') {
    return
  }

  resetCanvasRendered(installationId)

  const existing = getEntryByInstallationId(installationId)
  if (existing && !existing.window.isDestroyed()) {
    consumeAttachClaim(installationId)
    existing.comfyUrl = comfyUrl

    const revealReusedComfy = (): void => {
      if (existing.window.isDestroyed() || existing.installationId !== installationId) return
      if (existing.activePanel !== 'progress') {
        setActivePanel(existing.windowKey, 'comfy')
      }
      refreshComfyTabBody(installationId)
    }

    if (!existing.comfyView.webContents.isDestroyed()) {
      existing.comfyView.setBackgroundColor(SPLASH_DARK.bg)
      void navigatorFor(existing).reopenBehindSplash({
        url: comfyUrl,
        theme: SPLASH_DARK,
        copy: {
          title: i18n.t('launch.launchSplashTitle'),
          desc: i18n.t('launch.launchSplashDesc')
        },
        reveal: () => {
          if (existing.installationId !== installationId) return false
          if (!_runningSessions.has(installationId)) {
            refreshComfyTabBody(installationId)
            return false
          }
          revealReusedComfy()
          return true
        }
      })
    } else {
      revealReusedComfy()
    }

    if (proc) {
      proc.on('exit', () => {})
    }
    return
  }

  const claimedKey = consumeAttachClaim(installationId)
  if (claimedKey !== undefined) {
    const claimed = comfyWindows.get(claimedKey)
    if (claimed && !claimed.window.isDestroyed() && isChooserHost(claimed)) {
      rebuildComfyViewIfNeeded(claimed, installation)
      destroyPanelView(claimed)
      const ok = attachInstall(claimed, { installation, comfyUrl, isLocal: !url })
      if (ok) {
        prewarmAttachedPanel(claimed)
        if (proc) {
          proc.on('exit', () => {})
        }
        return
      }
    }
  }

  if (launchHadWindow(installationId)) return

  const initialSourceCategory = sourceMap[installation.sourceId]?.category ?? null

  const { entry } = createHostWindow({
    windowTitle: `${installation.name} — Artify v${APP_VERSION}`,
    boundsKey: installationId,
    initialTheme: { bg: COMFY_BG, text: '#dddddd' },
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : titleBarOverlayForTheme(resolveTheme() === 'dark'),
    comfyWebPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // comfyPreload requires the shared chunks/*.js — sandboxed preloads
      // can't require() relative chunks (issue #521), which kills
      // `window.electronAPI` in the ComfyUI view and silently breaks
      // comfy_inject.js (server_origin lookup / workflow loading).
      sandbox: false,
      preload: path.join(__dirname, '../preload/comfyPreload.js'),
      partition: expectedPartitionFor(installation)
    },
    titleBarBackground: TITLEBAR_BG,
    titleBarInstallationIdParam: installationId,
    initialTitleBarText: installation.name,
    initialSourceCategory
  })

  const attached = attachInstall(entry, { installation, comfyUrl, isLocal: !url })
  if (!attached) {
    entry.window.destroy()
    return
  }

  prewarmAttachedPanel(entry)

  if (proc) {
    proc.on('exit', () => {})
  }
}

ipcMain.handle('quit-app', () => quitApp())

ipcMain.handle('app:relaunch', () => {
  setQuitReason('user-quit')
  ipc.cancelAll()
  for (const [, entry] of comfyWindows) {
    if (!entry.window.isDestroyed()) entry.window.destroy()
  }
  comfyWindows.clear()
  if (tray) {
    tray.destroy()
    tray = null
  }
  app.relaunch()
  app.quit()
})

ipcMain.handle('reset-zoom', () => {})

ipcMain.on('comfy-window:set-first-use-mode', (event, payload: { mode: unknown }) => {
  const mode = normaliseFirstUseMode(payload?.mode)
  recordIpcInvocation('comfy-window:set-first-use-mode', { mode })
  for (const entry of comfyWindows.values()) {
    if (entry.panelView?.webContents === event.sender) {
      entry.firstUseMode = mode
      if (!entry.titleBarView.webContents.isDestroyed()) {
        entry.titleBarView.webContents.send('comfy-titlebar:first-use-mode-changed', mode)
      }
      return
    }
  }
})

async function computeInstallUpdateAvailable(
  installationId: string
): Promise<{ available: boolean; version?: string }> {
  if (!installationId) return { available: false }
  const override = lookupInstallUpdateOverride(installationId)
  if (override) return override
  try {
    const inst = await getInstallation(installationId)
    if (!inst) return { available: false }
    const source = sourceMap[inst.sourceId]
    const tag = source?.getStatusTag ? source.getStatusTag(inst) : undefined
    if (tag?.style !== 'update') return { available: false }
    return { available: true, version: tag.version }
  } catch {
    return { available: false }
  }
}

function _broadcastAppUpdateStateToTitleBars(state: updater.AppUpdateState): void {
  for (const entry of comfyWindows.values()) {
    const wc = entry.titleBarView.webContents
    if (wc.isDestroyed()) continue
    try {
      wc.send('comfy-titlebar:app-update-state-changed', state)
    } catch {}
  }
}

ipcMain.on('comfy-window:click-refresh-instance', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  if (entry.window.isDestroyed()) return
  // fix(A 界面刷新不生效): 按钮此前无条件 reload comfyView(C 侧 ComfyUI)——
  // 用户正看 A 界面时点击"无反应"(A 的 panelView 没动)。按可见表面分流:
  // artify 激活时 reload panelView(A UI),其余才走原 comfyView reload 路径。
  if (visibleSurface(entry) === 'artify') {
    const pv = entry.panelView
    if (!pv || pv.webContents.isDestroyed()) return
    pv.webContents.reload()
    focusActiveBody(entry)
    return
  }
  if (entry.installationId === null) return
  navigatorFor(entry).refresh()
  focusActiveBody(entry)
})

ipcMain.on('comfy-window:reset-zoom', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  if (entry.window.isDestroyed()) return
  const id = entry.installationId
  if (id === null) return
  comfyZoomResets.get(id)?.('titlebar')
  focusActiveBody(entry)
})

ipcMain.on('comfy-window:click-app-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  if (entry.window.isDestroyed()) return
  const state = updater.getCurrentUpdateState()
  if (state.kind === null) return
  if (state.kind === 'downloading') {
    const panelView = entry.panelView
    if (!panelView) return
    sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
      kind: 'open-settings',
      installationId: entry.installationId,
      settingsTab: 'global'
    })
    return
  }
  const isReady = state.kind === 'ready'
  const version = state.version ?? i18n.t('appUpdate.fallbackVersion')
  const title = isReady ? i18n.t('appUpdate.readyTitle') : i18n.t('appUpdate.availableTitle')
  const message = isReady
    ? i18n.t('appUpdate.readyMessage', { version })
    : i18n.t('appUpdate.availableMessage', { version })
  const confirmLabel = isReady ? i18n.t('appUpdate.restartNow') : i18n.t('appUpdate.download')
  const cancelLabel = i18n.t('appUpdate.later')
  const theme = entry.lastTheme
  openSystemModal({
    parent: entry.window,
    spec: {
      id: `app-update-${state.kind}-${version}`,
      title,
      message,
      confirmLabel,
      cancelLabel,
      confirmStyle: 'primary',
      theme
    },
    callback: (action) => {
      if (action !== 'confirm') return
      if (isReady) {
        updater.installUpdate()
      } else {
        void updater.downloadUpdate()
      }
    }
  })
})

ipcMain.on('comfy-window:click-install-update-pill', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  const { entry } = found
  const installationId = entry.installationId
  if (!installationId) return
  const panelView =
    entry.panelView ?? ensurePanelView(entry.windowKey, entry, computeBodyMode(entry))
  sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
    kind: 'install-update',
    installationId
  })
})

function notifyTitleBarDownloads(titleBarView: WebContentsView): void {
  if (titleBarView.webContents.isDestroyed()) return
  titleBarView.webContents.send('comfy-titlebar:downloads-changed', getDownloadsTrayState())
}

function _broadcastDownloadsToTitleBars(): void {
  for (const entry of comfyWindows.values()) {
    notifyTitleBarDownloads(entry.titleBarView)
  }
}

function triggerOpenFeedback(entryId: number, source: 'titlebar' | 'menu'): void {
  const parentEntry = comfyWindows.get(entryId)
  if (!parentEntry || parentEntry.window.isDestroyed()) return
  const panelView = parentEntry.panelView ?? ensurePanelView(entryId, parentEntry, 'feedback')
  setActivePanel(entryId, 'feedback')
  sendToPanelDeferred(panelView, 'comfy-panel:open-feedback', { source })
}

ipcMain.on('comfy-window:click-feedback', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found) return
  triggerOpenFeedback(found.entry.windowKey, 'titlebar')
})

ipcMain.on('comfy-window:new-chooser-window', (event) => {
  openChooserHostWindow('comfy', {
    nearWindow: findEntryByTitleBarSender(event.sender)?.entry.window
  })
})

ipcMain.on('comfy-window:open-page-in-new-window', (event, page: unknown) => {
  if (!isNewWindowDashboardPage(page)) return
  openChooserHostWindow('comfy', {
    dashboardPage: page,
    nearWindow: findHostWindowByPanelSender(event.sender) ?? undefined
  })
})

ipcMain.on('comfy-window:show-home', (event) => {
  const found = findEntryByTitleBarSender(event.sender)
  if (!found || !isInstallHost(found.entry)) return
  recordIpcInvocation('comfy-window:show-home')
  openOrFocusHomeHostWindow()
})

function startHomeTour(fromWindowKey: number): void {
  requestHomeTourReplay()
  const from = comfyWindows.get(fromWindowKey)
  const home =
    from && isChooserHost(from) && !from.window.isDestroyed()
      ? from.window
      : openOrFocusHomeHostWindow()
  const panelView = findEntryByHostWindow(home)?.panelView
  if (panelView) sendToPanelDeferred(panelView, 'comfy-panel:show-home-page', {})
}

async function prepareBuildWindowFocus(
  entry: ComfyWindowEntry,
  requester?: BrowserWindow | null,
  pickerWorkspaceId?: string
): Promise<boolean> {
  try {
    return (
      (await syncCloudWindowWorkspace(entry, { pickerWorkspaceId })) && !entry.window.isDestroyed()
    )
  } catch (error) {
    if (entry.window.isDestroyed()) return false
    console.error('Could not switch Comfy Cloud workspace:', error)
    const options: MessageBoxOptions = {
      type: 'error',
      message: i18n.t('installShowcase.cloudFailedTitle'),
      detail: i18n.t('installShowcase.cloudFailedMessage')
    }
    const alert =
      requester && !requester.isDestroyed()
        ? dialog.showMessageBox(requester, options)
        : dialog.showMessageBox(options)
    void alert.catch((error) => console.error('Could not show Comfy Cloud error:', error))
    return false
  }
}

async function focusOpenComfyWindow(
  installationId: string,
  requester?: BrowserWindow | null,
  pickerWorkspaceId?: string
): Promise<boolean> {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return false
  if (await prepareBuildWindowFocus(entry, requester, pickerWorkspaceId)) {
    maximizeIfPendingReveal(entry.window)
    entry.window.show()
    entry.window.focus()
  }
  return !entry.window.isDestroyed()
}

async function openWindowForAppsBuild(installationId: string): Promise<boolean> {
  const installation = await getInstallation(installationId)
  if (await focusOpenComfyWindow(installationId)) return true
  const port = runningPortOf(installationId)
  if (!installation || port === null) return false
  onLaunch({
    port,
    process: ipc.getSessionProcess(installationId),
    installation,
    mode: 'window'
  })
  return focusOpenComfyWindow(installationId)
}

ipcMain.handle(
  'focus-comfy-window',
  async (event, installationId: string, pickerWorkspaceId?: unknown) => {
    recordIpcInvocation('focus-comfy-window', { installationId })
    const requester = findHostWindowByPanelSender(event.sender)
    const workspaceId =
      requester && typeof pickerWorkspaceId === 'string' ? pickerWorkspaceId : undefined
    if (await focusOpenComfyWindow(installationId, requester, workspaceId)) return true
    if (isRunningForAppsOnly(installationId) || runsWithItsWindowClosed(installationId)) {
      return openWindowForAppsBuild(installationId)
    }

    const proc = ipc.getSessionProcess(installationId)
    if (proc?.pid) {
      focusExternalProcessWindow(proc.pid)
      return true
    }

    return false
  }
)

ipcMain.handle(
  'close-comfy-window',
  (_event, installationId: string, opts?: CloseComfyWindowOptions) =>
    closeBuildWindow(installationId, opts)
)

ipcMain.handle('close-host-window', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (entry.panelView?.webContents === event.sender) {
      entry.window.close()
      return true
    }
  }
  return false
})

ipcMain.handle('return-to-dashboard', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (!isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    entry.detachInstall()
    return true
  }
  return false
})

ipcMain.handle('claim-attach-host', (event, installationId: string) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    claimAttachHost(installationId, entry.windowKey)
    void applyAttachHostPreview(entry, installationId)
    return true
  }
  return false
})

ipcMain.handle('release-attach-host-preview', (event) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    dropAttachClaimsForWindow(entry.windowKey)
    clearAttachHostPreview(entry)
    return true
  }
  return false
})

ipcMain.handle('transfer-host-bounds-to-install', (event, installationId: string) => {
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed()) continue
    if (isInstallHost(entry)) continue
    if (entry.panelView?.webContents !== event.sender) continue
    saveWindowBounds(installationId, entry.window)
    return true
  }
  return false
})

function findInstallationIdForWindow(win: BrowserWindow): string | undefined {
  for (const entry of comfyWindows.values()) {
    if (entry.window !== win) continue
    return entry.installationId ?? undefined
  }
  return undefined
}

const hostReentryGate = createStartupReentryGate()

const draftLinkStartup = planDraftLinkStartup({
  isPackaged: app.isPackaged,
  platform: process.platform,
  env: process.env,
  startupLink: findDraftLink(process.argv)
})

function requestDevCopyLock(additionalData: Record<string, unknown> | undefined): boolean {
  const userData = app.getPath('userData')
  app.setPath('userData', devCopyLockDir(userData, app.getAppPath(), process.platform))
  try {
    return app.requestSingleInstanceLock(additionalData)
  } finally {
    app.setPath('userData', userData)
  }
}

function holdsInstanceLockAtStart({ lock, lockTiming }: DraftLinkStartup): boolean {
  if (lock === 'none' || lockTiming === 'ready') return true
  if (lock === 'app') return app.requestSingleInstanceLock()
  return requestDevCopyLock(undefined)
}

function takeDevCopyLockWhenReady({ lock, lockTiming, lockWaitMs }: DraftLinkStartup): void {
  if (lock !== 'dev-copy' || lockTiming !== 'ready') return
  void app.whenReady().then(() =>
    retryLock({
      tryLock: () => requestDevCopyLock(DEV_SERVER_START_DATA),
      waitMs: lockWaitMs,
      intervalMs: LOCK_RETRY_INTERVAL_MS,
      now: Date.now,
      schedule: (attempt, ms) => void setTimeout(attempt, ms),
      onDone: (held) => {
        if (held) return
        console.warn(
          `Another Comfy Desktop started from ${app.getAppPath()} is running, so ${DRAFT_LINK_SCHEME}:// links clicked now go to it, not to this copy.`
        )
      }
    })
  )
}

function registerDraftLinkScheme({ registration, desktopEntry }: DraftLinkStartup): void {
  const commandArgs = [path.resolve(process.argv[1] ?? '.')]
  let registered = true
  if (registration === 'scheme') {
    registered = app.setAsDefaultProtocolClient(DRAFT_LINK_SCHEME)
  } else if (registration === 'scheme-with-command') {
    registered = app.setAsDefaultProtocolClient(DRAFT_LINK_SCHEME, process.execPath, commandArgs)
  } else if (registration === 'desktop-entry' && desktopEntry) {
    app.setDesktopName(desktopEntry)
    registered = app.setAsDefaultProtocolClient(DRAFT_LINK_SCHEME)
  } else if (
    registration === 'remove-own-command' &&
    app.isDefaultProtocolClient(DRAFT_LINK_SCHEME, process.execPath, commandArgs)
  ) {
    app.removeAsDefaultProtocolClient(DRAFT_LINK_SCHEME, process.execPath, commandArgs)
  }
  if (!registered) {
    console.warn(
      `Could not register ${DRAFT_LINK_SCHEME}:// links for this copy (${registration}).`
    )
  }
}

async function explainDevCopyNotRunning(): Promise<void> {
  app.releaseSingleInstanceLock()
  await app.whenReady()
  await dialog.showMessageBox({
    type: 'info',
    buttons: ['OK'],
    message: 'Comfy Desktop is not running from source',
    detail: `This link opens the development copy in ${app.getAppPath()}. Start it there with pnpm run dev, then open the link again.`
  })
  app.quit()
}

if (!holdsInstanceLockAtStart(draftLinkStartup)) {
  app.quit()
} else if (draftLinkStartup.linkWithoutDevServer) {
  void explainDevCopyNotRunning()
} else {
  if (process.platform === 'win32') startMachineIdLookup()
  const sacStateRead = readSmartAppControlState()

  registerDraftLinkScheme(draftLinkStartup)
  takeDevCopyLockWhenReady(draftLinkStartup)
  if (draftLinkStartup.lock !== 'none') {
    app.on('second-instance', (_event, argv, _workingDirectory, additionalData) => {
      if (isDevServerStart(additionalData)) return
      const draftLink = findDraftLink(argv)
      if (draftLink) hostReentryGate.runEachWhenOpen(() => void openDraftLink(draftLink))
      else hostReentryGate.runOrQueue(() => openOrFocusAnyHostWindow())
    })
  }

  app.on('open-url', (event, url) => {
    if (!findDraftLink([url])) return
    event.preventDefault()
    hostReentryGate.runEachWhenOpen(() => void openDraftLink(url))
  })

  const startupDraftLink = findDraftLink(process.argv)
  if (startupDraftLink) hostReentryGate.runEachWhenOpen(() => void openDraftLink(startupDraftLink))

  app.on('browser-window-created', (_event, window) => {
    trackWindowWebContents(window)
    window.on('query-session-end', () => {
      updater.suppressInstallOnQuit()
    })
    window.on('session-end', () => {
      setSessionEnding()
      updater.suppressInstallOnQuit()
    })
  })

  app.whenReady().then(async () => {
    initAppLog()
    registerProcessErrorHandlers()
    nativeTheme.themeSource = 'dark'
    pruneCrashDumps()
    console.info(
      `App started v${APP_VERSION} pid=${process.pid} platform=${process.platform} crashDumps=${app.getPath('crashDumps')}`
    )

    if (process.env['E2E'] === '1') {
      const { registerE2EHooks } = await import('./lib/e2eHooks')
      registerE2EHooks()
    }

    if (!app.isPackaged) {
      const { registerDevShortcuts } = await import('./lib/devShortcuts')
      registerDevShortcuts({ computeInstallUpdateAvailable })
    }

    setHostWindowFactories({
      consultPanelRendererClose,
      confirmCloseInstanceWindow,
      detachInstallImpl: _detachInstallImpl,
      preClearedClose,
      computeInstallUpdateAvailable
    })
    setAttachFactories({
      comfyZoomResets,
      relaunchStates,
      computeInstallUpdateAvailable
    })
    setHostFactories({ createChooser: openChooserHostWindow })
    registerPanelViewIpc()
    registerOutputFolderHandlers()

    migrateXdgPaths()
    persistWinDataRootChoice()

    installAppMenu(process.platform, undefined, {
      onCheckForUpdates: () => {
        void updater.runCheck('app-menu').catch(() => {})
      }
    })

    if (process.platform !== 'darwin') {
      app.on('browser-window-created', (_event, window) => {
        window.setMenuBarVisibility(false)
        window.autoHideMenuBar = true
      })
    }

    const telemetrySetting = settings.telemetryConsent()
    const initialConsent: mainTelemetry.ConsentState =
      telemetrySetting === true ? 'granted' : telemetrySetting === false ? 'denied' : 'undecided'
    let priorSessionUnclean = false
    try {
      priorSessionUnclean = takePriorSessionUnclean()
    } catch (err) {
      console.warn('[comfy-procs] startup scan failed:', err)
    }
    mainTelemetry.initTelemetry({
      appVersion: APP_VERSION,
      appEnv: app.isPackaged ? 'prod-v2' : 'dev',
      isPackaged: app.isPackaged,
      sessionStartProps: {
        prior_session_unclean: priorSessionUnclean
      }
    })
    mainTelemetry.setConsentState(initialConsent)
    mainTelemetry.installAppHooks()

    const existingInstallation = hasCompletedFirstLaunch() || hasPersistedDeviceId()
    recordHomeTourAudience(existingInstallation)
    const { legacyId } = await initDeviceId()
    clearLegacyIdentityRetryMarker()
    const installationId = getDeviceId()
    const sacState = await sacStateRead
    console.info('[sac-state] init: state=', sacState)
    mainTelemetry.setSmartAppControlState(sacState)
    const anonymousDistinctId = recoverPendingIdentityRotation(
      getInitialAnonymousDistinctId(existingInstallation)
    )

    mainTelemetry.bindAnonymousId(anonymousDistinctId, installationId, {
      app_version: APP_VERSION,
      platform: process.platform,
      arch: process.arch,
      id_class: getIdClass()
    })

    mainTelemetry.registerPersonProperties(settings.getTrackedSettingsTelemetryProperties())

    const isFirstLaunch = consumeFirstLaunch()
    if (legacyId) {
      markIdentityMigrationCompleted()
    }

    void initExperiments({
      distinctId: installationId,
      personProperties: {
        platform: process.platform,
        arch: process.arch,
        app_version: APP_VERSION,
        id_class: getIdClass()
      }
    })

    initStaffFlagTargeting({ onFlagPropertiesChange: () => void refreshCoreBetaFlags() })

    await initUserTier()

    void initCloudFreeRuns({ distinctId: installationId })

    void initCoreBetaFlags({
      distinctId: installationId,
      betaEnabled: settings.peekBetaFeaturesEnabled()
    }).then(prefetchEnrolledAgents)

    void initEmbeddedSessionFlag({ distinctId: installationId })

    void initWorkspaceMintSwitchFlag({ distinctId: installationId })

    getCloudSession().resumeRevocations()

    const locale = (settings.get('language') as string | undefined) || app.getLocale().split('-')[0]
    i18n.init(locale)

    mainTelemetry.capture('comfy.desktop.app.language_resolved', {
      os_locale: app.getLocale(),
      selected_language: (settings.get('language') as string | undefined) || null,
      effective_language: i18n.getLocale()
    })

    if (isFirstLaunch) {
      mainTelemetry.captureFirstLaunch({
        id_class: getIdClass(),
        locale
      })
    }
    registerTitleTooltipIpc({
      findParentByTitleBarSender: (wc) => findEntryByTitleBarSender(wc)?.entry.window ?? null
    })
    registerTitleCoachmarkIpc({
      findParentByTitleBarSender: (wc) => findEntryByTitleBarSender(wc)?.entry.window ?? null,
      findTitleBarByParent: (parent) =>
        findEntryByHostWindow(parent)?.titleBarView.webContents ?? null
    })
    registerSystemModalIpc()

    const deliverPickToEntry = (
      entry: ComfyWindowEntry,
      installationId: string,
      pickerWorkspaceId?: string
    ): void => {
      if (entry.window.isDestroyed()) return
      const panelView =
        entry.panelView ?? ensurePanelView(entry.windowKey, entry, computeBodyMode(entry))
      if (panelView.webContents.isDestroyed()) return
      sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
        kind: 'picker-pick-install',
        installationId,
        actionData: pickerWorkspaceId ? { pickerWorkspaceId } : undefined
      })
    }

    const recordBuildOpen = (installationId: string, route: BuildOpenRoute): void => {
      recordIpcInvocation('open-build', { installationId, route: route.kind })
      if (route.kind === 'start-from' || route.kind === 'start-from-home') {
        mainTelemetry.emit('comfy.desktop.instance.opened_new_window', {
          to_installation_id: installationId,
          method: 'picker'
        })
      }
    }

    const openBuild = async (
      installationId: string,
      requesterEntryId: number,
      pickerWorkspaceId?: string
    ): Promise<void> => {
      const requester = comfyWindows.get(requesterEntryId)
      if (pickerWorkspaceId) _setActiveLaunchPickerWorkspace(installationId, pickerWorkspaceId)
      const route = routeBuildOpen(installationId, requester, _getLaunchingInstallationIds())
      recordBuildOpen(installationId, route)
      switch (route.kind) {
        case 'ignore':
          return
        case 'focus':
          if (await prepareBuildWindowFocus(route.entry, requester?.window, pickerWorkspaceId)) {
            bringToFront(route.entry.window)
          }
          return
        case 'show-starting':
          if (route.entry) bringToFront(route.entry.window)
          else openOrFocusHomeHostWindow()
          return
        case 'start-from':
          deliverPickToEntry(route.entry, installationId, pickerWorkspaceId)
          return
        case 'start-from-home': {
          const inst = await getInstallation(installationId)
          if (!inst) {
            console.error('openBuild: unknown installation, not starting it', { installationId })
            return
          }
          const homeEntry = findEntryByHostWindow(openOrFocusHomeHostWindow())
          if (!homeEntry) {
            console.error('openBuild: Desktop window not in registry', { installationId })
            return
          }
          deliverPickToEntry(homeEntry, installationId, pickerWorkspaceId)
          return
        }
      }
    }

    ipcMain.handle('open-install-window', async (event, installationId: unknown) => {
      if (typeof installationId !== 'string' || installationId === '') return false
      recordIpcInvocation('open-install-window', { installationId })
      const requester = [...comfyWindows.values()].find(
        (entry) => !entry.window.isDestroyed() && entry.panelView?.webContents === event.sender
      )
      if (!requester) return false
      try {
        await openBuild(installationId, requester.windowKey)
        return true
      } catch (error) {
        console.error('open-install-window: could not open the build', { installationId, error })
        return false
      }
    })

    registerTitlePopupIpc({
      openChooserHostWindow,
      returnToDashboard,
      confirmAndCloseAllHostWindows: (parentWindow) =>
        confirmAndCloseAllHostWindows(parentWindow, quitApp),
      confirmAndCloseHostWindow,
      removeAppDataAndQuit: (options) =>
        relaunchIntoUninstallCleanup(options, {
          suppressInstallOnQuit: updater.suppressInstallOnQuit,
          quit: quitApp
        }),
      setActivePanel,
      triggerOpenFeedback,
      startHomeTour,
      resetComfyZoom: (installationId) => comfyZoomResets.get(installationId)?.('menu'),
      sendToPanelDeferred,
      ensurePanelViewForEntry: (entry) =>
        entry.panelView ?? ensurePanelView(entry.windowKey, entry, computeBodyMode(entry)),
      pickerRunBackgroundOp: ({ installationId, actionId, actionData, title, cancellable }) => {
        void (async () => {
          const inst = await getInstallation(installationId)
          if (!inst) {
            _activeOperationStatus.set(installationId, {
              status: '',
              percent: -1,
              done: true,
              ok: false,
              error: 'Installation not found.',
              cancellable,
              title,
              actionId,
              actionData
            })
            triggerPickerSnapshotBroadcast()
            return
          }

          if (_operationAborts.has(installationId)) {
            const activeOperation = _activeOperationStatus.get(installationId)
            if (activeOperation && !activeOperation.done) return

            _activeOperationStatus.set(installationId, {
              status: '',
              percent: -1,
              done: true,
              ok: false,
              error: 'Another operation is already running.',
              cancellable,
              title,
              actionId,
              actionData
            })
            triggerPickerSnapshotBroadcast()
            return
          }

          const opStartMs = Date.now()
          mainTelemetry.capture('comfy.desktop.action.invoked', {
            action_id: actionId,
            installation_id: installationId,
            source: 'picker'
          })
          const emitPickerOpResult = (
            opResult: 'success' | 'failed' | 'cancelled_user',
            errorMessage?: string | null
          ): void => {
            mainTelemetry.emit('comfy.desktop.op.result', {
              installation_id: installationId,
              action_id: actionId,
              source: 'picker',
              result: opResult,
              duration_ms: Date.now() - opStartMs,
              ...(opResult === 'failed' && errorMessage
                ? { error_bucket: mainTelemetry.bucketError(errorMessage) }
                : {})
            })
          }

          const wasRunning = _runningSessions.has(installationId)
          if (REQUIRES_STOPPED.has(actionId) && wasRunning) {
            _activeOperationStatus.set(installationId, {
              status: 'Stopping…',
              percent: -1,
              done: false,
              ok: null,
              error: null,
              cancellable,
              title,
              actionId,
              actionData
            })
            triggerPickerSnapshotBroadcast()
            try {
              await stopRunning(installationId)
            } catch (err) {
              _activeOperationStatus.set(installationId, {
                status: '',
                percent: -1,
                done: true,
                ok: false,
                error: (err as Error).message ?? 'Stop failed.',
                cancellable,
                title,
                actionId,
                actionData
              })
              triggerPickerSnapshotBroadcast()
              emitPickerOpResult('failed', (err as Error).message ?? 'Stop failed.')
              return
            }
          }

          _activeOperationStatus.set(installationId, {
            status: '',
            percent: -1,
            done: false,
            ok: null,
            error: null,
            cancellable,
            title,
            actionId,
            actionData
          })
          triggerPickerSnapshotBroadcast()

          const feedStatus = (channel: string, payload: Record<string, unknown>): void => {
            if (channel !== 'install-progress') return
            const cur = _activeOperationStatus.get(installationId)
            if (!cur || cur.done) return
            const status =
              typeof payload.status === 'string'
                ? payload.status
                : typeof payload.phase === 'string'
                  ? payload.phase
                  : cur.status
            const percent = typeof payload.percent === 'number' ? payload.percent : cur.percent
            const speedBytesPerSec =
              typeof payload.speedBytesPerSec === 'number'
                ? payload.speedBytesPerSec
                : cur.speedBytesPerSec
            _activeOperationStatus.set(installationId, {
              ...cur,
              status,
              percent,
              speedBytesPerSec
            })
            triggerPickerSnapshotBroadcast()
          }
          const stubSender = {
            isDestroyed: () => false,
            send: feedStatus as unknown as Electron.WebContents['send']
          } as unknown as Electron.WebContents
          const stubEvent = { sender: stubSender } as unknown as Electron.IpcMainInvokeEvent

          let result: PickerOperationStatus
          try {
            const actionResult = await dispatchSessionAction(
              { event: stubEvent, installationId, inst, actionData },
              actionId
            )
            const wantsRelaunch = wasRunning && IN_PLACE_RELAUNCH.has(actionId)
            let relaunchFailure: string | null = null
            if (actionResult.ok && wantsRelaunch) {
              const freshInst = (await getInstallation(installationId)) ?? inst
              const relaunch = await handleLaunch({
                event: stubEvent,
                installationId,
                inst: freshInst,
                actionData: undefined
              })
              if (!relaunch.ok && !relaunch.cancelled) {
                relaunchFailure = relaunch.message ?? i18n.t('progress.unknownError')
              }
            }
            const wasCancelled = actionResult.cancelled === true
            result = {
              status: '',
              percent: wasCancelled ? -1 : 100,
              done: true,
              ok: !wasCancelled && actionResult.ok !== false && relaunchFailure === null,
              error: wasCancelled
                ? MSG_CANCELLED
                : actionResult.ok === false
                  ? (actionResult.message ?? 'Failed.')
                  : relaunchFailure,
              cancellable,
              title,
              actionId,
              actionData
            }
            if (wasCancelled) {
              emitPickerOpResult('cancelled_user')
            } else if (actionResult.ok !== false) {
              emitPickerOpResult('success')
            } else {
              emitPickerOpResult('failed', actionResult.message ?? 'Failed.')
            }
          } catch (err) {
            const abort = _operationAborts.get(installationId)
            result = {
              status: '',
              percent: -1,
              done: true,
              ok: false,
              error: abort?.signal.aborted ? MSG_CANCELLED : ((err as Error).message ?? 'Failed.'),
              cancellable,
              title,
              actionId,
              actionData
            }
            if (abort?.signal.aborted) {
              emitPickerOpResult('cancelled_user')
            } else {
              emitPickerOpResult('failed', (err as Error).message ?? 'Failed.')
            }
          }
          _activeOperationStatus.set(installationId, result)
          triggerPickerSnapshotBroadcast()
          setTimeout(() => {
            const cur = _activeOperationStatus.get(installationId)
            if (cur?.done && cur.ok) {
              _activeOperationStatus.delete(installationId)
              triggerPickerSnapshotBroadcast()
            }
          }, 15_000)
        })()
      },
      broadcastPickerSnapshot: () => triggerPickerSnapshotBroadcast(),
      getInstancePickerInstalls: async () => {
        const all = await listInstallations()
        const { enriched } = enrichInstallationsForRenderer(all)
        return enriched as unknown as InstancePickerInstall[]
      },
      getRunningInstallationIds: () => Array.from(_runningSessions.keys()),
      getRunningSessionStartedAt: () =>
        Object.fromEntries(Array.from(_runningSessions, ([id, s]) => [id, s.startedAt])),
      getLaunchingInstallationIds: () => _getLaunchingInstallationIds(),
      getPickerDetailsForInstall: async (installationId) => {
        const inst = await getInstallation(installationId)
        if (!inst) return { settings: null, snapshots: null }
        const source = sourceMap[inst.sourceId]
        const settings = source
          ? (source.getDetailSections(inst) as Record<string, unknown>[])
          : null
        let snapshots: Record<string, unknown> | null = null
        if (inst.installPath) {
          try {
            const data = await getSnapshotListData(inst.installPath)
            snapshots = { ...data, copyEvents: [] }
          } catch (err) {
            console.error(`Picker: snapshot read failed for ${installationId}:`, err)
            snapshots = null
          }
        }
        return { settings, snapshots }
      },
      pickerUpdateField: async (installationId, fieldId, value) => {
        const inst = await getInstallation(installationId)
        if (!inst) return { ok: false, message: 'Installation not found.' }
        const source = sourceMap[inst.sourceId]
        if (!source) return { ok: false, message: 'Unknown source.' }
        const sections = source.getDetailSections(inst) as Record<string, unknown>[]
        const allowed = new Set<string>(['name', 'seen'])
        for (const section of sections) {
          const fields = section.fields as Record<string, unknown>[] | undefined
          if (!fields) continue
          for (const f of fields) {
            if (f.editable && typeof f.id === 'string') allowed.add(f.id)
          }
        }
        if (!allowed.has(fieldId)) {
          return { ok: false, message: `Field '${fieldId}' is not editable.` }
        }
        try {
          await updateInstallation(installationId, { [fieldId]: value })
          if (fieldId === 'updateChannel') {
            const next = await getInstallation(installationId)
            if (next) {
              const abort = new AbortController()
              source
                .handleAction('check-update', next, undefined, {
                  update: (data) => updateInstallation(installationId, data).then(() => {}),
                  sendProgress: () => {},
                  sendOutput: () => {},
                  signal: abort.signal
                })
                .catch((err) => {
                  console.error(
                    `Picker: check-update after channel switch failed for ${installationId}:`,
                    err
                  )
                })
            }
          }
          return { ok: true }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : 'Update failed.' }
        }
      },
      pickerRunAction: async (installationId, actionId, actionData) => {
        try {
          const inst = await getInstallation(installationId)
          if (!inst) return { ok: false, message: 'Installation not found.' }
          const source = sourceMap[inst.sourceId]
          if (!source) return { ok: false, message: 'Unknown source.' }
          const abort = new AbortController()
          const result = await source.handleAction(actionId, inst, actionData, {
            update: (data) => updateInstallation(installationId, data).then(() => {}),
            sendProgress: () => {},
            sendOutput: () => {},
            signal: abort.signal
          })
          return {
            ok: result.ok !== false,
            message: typeof result.message === 'string' ? result.message : undefined
          }
        } catch (err) {
          return { ok: false, message: err instanceof Error ? err.message : 'Action failed.' }
        }
      },
      pickInstallFromPicker: openBuild,
      restartInstallFromPicker: async (installationId, parentEntryId, opts) => {
        const parentEntry = comfyWindows.get(parentEntryId)
        if (!parentEntry || parentEntry.window.isDestroyed()) return
        if (!canRestartFromPicker(parentEntry, installationId, _getLaunchingInstallationIds())) {
          return
        }
        if (opts?.confirmed !== true && shouldConfirmKillForEntry(parentEntry)) {
          const confirmed = await openSystemModalAsync({
            parent: parentEntry.window,
            spec: {
              title: 'Restart instance?',
              message: 'Restart this instance?',
              details: [
                {
                  label: 'Heads up',
                  items: [
                    'Restarting will stop the running session.',
                    'Any unsaved work in the workflow will be lost.'
                  ]
                }
              ],
              confirmLabel: 'Restart',
              cancelLabel: 'Cancel',
              confirmStyle: 'primary',
              theme: parentEntry.lastTheme
            }
          })
          if (!confirmed) return
        }
        try {
          const cancelled = await ipc.cancelLaunching(installationId)
          recordIpcInvocation('picker-restart:cancel-launching', { installationId, cancelled })
          await ipc.stopRunning(installationId)
        } catch (err) {
          console.error(`Picker restart: stop failed for ${installationId}:`, err)
          return
        }
        if (!parentEntry || parentEntry.window.isDestroyed()) return
        const panelView =
          parentEntry.panelView ??
          ensurePanelView(parentEntryId, parentEntry, computeBodyMode(parentEntry))
        if (panelView.webContents.isDestroyed()) return
        sendToPanelDeferred(panelView, 'panel-trigger-overlay', {
          kind: 'picker-pick-install',
          installationId,
          isRestart: true
        })
      }
    })
    registerPickerSettingsIpc({ quitForRelaunch: quitApp })
    registerDownloadHandlers()
    registerAssetDownloadHandlers({ findInstallationIdForWindow })
    registerTemplateInputAssetHandlers({
      findInstallationIdForWindow,
      isLocalInstallation: (installation) => sourceMap[installation.sourceId]?.category === 'local'
    })
    cleanupTempDownloads()
    await ipc.register({
      onLaunch,
      onStop,
      onComfyExited,
      onInstanceStarted: (info) => {
        void emitInstanceStartedTelemetry(info)
        void emitStorageTelemetry(info.installationId)
      },
      onComfyRestarted,
      onModelFolderRelaunch,
      onLocaleChanged: updateTrayMenu,
      onThemeChanged: applyChooserHostThemeToAll
    })
    initializeModelDownloads().catch((err) => {
      console.warn('Model download startup pass failed at app startup:', err)
    })
    updater.register()
    // ArtifyLab service bootstrap: load the desktop-config store (artify
    // handlers read the install `basePath` from it), register the `artify-*`
    // IPC handlers, and start the express server (AI agent + ComfyUI API
    // proxy) backing the Artify surfaces. `DesktopConfig.load` returns
    // `undefined` when the user chose to quit from the config-repair prompt,
    // in which case we skip the service — the app is about to exit anyway.
    const desktopConfig = await DesktopConfig.load(shell)
    if (desktopConfig) {
      // 单窗口模式：A UI 作为 host 窗口 panelView 的内容（与 ComfyUI
      // comfyView 同窗口切换）。必须在任何 host 窗口创建前启用——
      // openStartupSurface 在后面才打开窗口。
      setArtifyPanelMode(true)
      registerArtifyHandlers()
      // ComfyUI 后端对带 `Origin` 头的跨源导航返回 403（CSRF 校验）。
      // A UI 的 WorkflowModal iframe 从 http://localhost:5000 导航到
      // ComfyUI（127.0.0.1:8188）时会带上 Origin → 403 空文档。剥掉
      // 默认 session（panelView / A UI / iframe 所在）对 ComfyUI 请求
      // 的 Origin/Referer/Sec-Fetch-Site，让 iframe 能加载 ComfyUI 前端
      // 画布；comfyView 走独立 partition，不受影响。
      session.defaultSession.webRequest.onBeforeSendHeaders((details, callback) => {
        if (
          details.url.startsWith('http://127.0.0.1:8188') ||
          details.url.startsWith('http://localhost:8188') ||
          // ws 握手同样被 origin_only_middleware 校验（Host vs Origin 不匹配 → 403），
          // 批量任务（3008 页面）连 ComfyUI ws 必须剥头；http:// 前缀不匹配 ws://。
          details.url.startsWith('ws://127.0.0.1:8188') ||
          details.url.startsWith('ws://localhost:8188')
        ) {
          const headers: Record<string, string> = {}
          for (const [k, v] of Object.entries(details.requestHeaders ?? {})) {
            // 剥离 Origin/Referer/Sec-Fetch-Site：ComfyUI v0.29 的 origin_only_middleware
            // 对 Sec-Fetch-Site: cross-site 直接 403（不看 Origin），iframe 跨源导航
            // 携带该头导致空文档；剥离后与直接 curl 等价，返回完整 index.html。
            if (
              k.toLowerCase() !== 'origin' &&
              k.toLowerCase() !== 'referer' &&
              k.toLowerCase() !== 'sec-fetch-site'
            ) {
              headers[k] = v
            }
          }
          callback({ requestHeaders: headers })
        } else {
          callback({})
        }
      })
      // 批量任务跨源 POST /prompt：ComfyUI 未启用 --enable-cors-header，
      // 预检与实际响应都缺 Access-Control-Allow-* 头 → 浏览器抛
      // "Failed to fetch"。给 8188 的全部响应注入允许头（non-simple
      // 跨源请求的响应也必须带 ACAO 才通过 CORS 检查；请求侧的 Origin
      // 已被上方的剥离逻辑去掉，安全边界不变）。
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (
          details.url.startsWith('http://127.0.0.1:8188') ||
          details.url.startsWith('http://localhost:8188')
        ) {
          const headers = details.responseHeaders ?? {}
          headers['Access-Control-Allow-Origin'] = ['*']
          headers['Access-Control-Allow-Methods'] = ['POST, GET, DELETE, PUT, OPTIONS, PATCH']
          headers['Access-Control-Allow-Headers'] = ['Content-Type, Authorization']
          callback({ responseHeaders: headers })
        } else {
          callback({})
        }
      })
      // A→C 切换（单窗口）：有运行中的 install → 同窗口切到 comfy
      // 视图；无运行实例 → 面板切到 install 选择器让用户启动/安装。
      setComfyUIFocusHandler(async () => {
        for (const installationId of Array.from(_runningSessions.keys())) {
          const entry = getEntryByInstallationId(installationId)
          if (entry && !entry.window.isDestroyed()) {
            // 单窗口闭环：A UI 面板通常还停在启动时的 chooser 窗口
            // （installationId=null），而 comfyView 在 install 窗口——
            // 直接 focus install 窗口会让用户看到"另一个窗口弹出来"。
            // 把 A UI 面板迁到 install 窗口（后续 C→A 在同窗口内切回），
            // 再关闭承载 A UI 的 chooser 窗口，切换从此只发生在同一窗口。
            setPanelSurface(entry, 'artify')
            setActivePanel(entry.windowKey, 'comfy')
            entry.window.show()
            entry.window.focus()
            for (const [, other] of comfyWindows) {
              if (other !== entry && other.installationId === null && !other.window.isDestroyed()) {
                other.window.close()
              }
            }
            // 工作流重放：ComfyUI 页面可能早已加载（实例先启动），面板
            // 切换不会重载页面——comfy_inject.js 的 loadWorkflow 只在
            // 页面加载时跑过一次（当时 activeAppId 可能还不是本应用）。
            // 重放 __artifyReloadWorkflow 让画布加载最新 activeAppId 的
            // 工作流；页面未就绪时 executeJavaScript 会失败，但页面加载
            // 完成后 loadWorkflow 自身会按当时的 activeAppId 执行一次。
            if (!entry.comfyView.webContents.isDestroyed()) {
              entry.comfyView.webContents
                .executeJavaScript(
                  'window.__artifyReloadWorkflow && window.__artifyReloadWorkflow()'
                )
                .catch(() => {})
            }
            return true
          }
        }
        const host = openOrFocusAnyHostWindow()
        const entry = findEntryByHostWindow(host)
        if (entry && entry.panelSurface === 'artify') setPanelSurface(entry, 'chooser')
        return false
      })
      // C→A 切换（单窗口）：面板切回 A UI 并显示 host 窗口。
      setArtifyLabFocusHandler(async () => {
        const host = openOrFocusAnyHostWindow()
        const entry = findEntryByHostWindow(host)
        if (!entry || entry.window.isDestroyed()) return false
        setPanelSurface(entry, 'artify')
        setActivePanel(entry.windowKey, 'chooser')
        entry.window.show()
        entry.window.focus()
        return true
      })
      await startServer()
        .then((server) => {
          const address = server.address()
          if (address && typeof address !== 'string') setArtifyPanelPort(address.port)
        })
        .catch((err) => {
          console.error('ArtifyLab server failed to start:', err)
        })
    }
    updater.onUpdateStateChanged(_broadcastAppUpdateStateToTitleBars)
    downloadEvents.on('tray-state-changed', _broadcastDownloadsToTitleBars)
    const updateSplash = updater.hasPendingStartupUpdate() ? showUpdateInstallSplash() : undefined
    let updateInstallQuitStarted = false
    const onUpdateInstallQuit = (): void => {
      updateInstallQuitStarted = true
    }
    app.once('before-quit', onUpdateInstallQuit)
    let installingUpdate = false
    try {
      installingUpdate = await updater.applyPendingUpdateOnStartup(
        updateSplash ? { onInstallCommitted: () => updateSplash.showInstallCountdown() } : undefined
      )
    } catch (err) {
      console.error('applyPendingUpdateOnStartup failed:', err)
    }
    const openSurfaceAndDismissSplash = async (): Promise<void> => {
      try {
        await openStartupSurface()
      } catch (err) {
        console.error('openStartupSurface failed after update splash:', err)
      } finally {
        const otherWindowExists = BrowserWindow.getAllWindows().some(
          (w) => w !== updateSplash?.window && !w.isDestroyed()
        )
        if (updateSplash && !updateSplash.window.isDestroyed() && otherWindowExists) {
          updateSplash.window.destroy()
        }
      }
    }
    if (installingUpdate) {
      setTimeout(() => {
        if (updateInstallQuitStarted) return
        app.removeListener('before-quit', onUpdateInstallQuit)
        clearQuitReason()
        updater.recordStartupInstallBackstopRecovered()
        void openSurfaceAndDismissSplash().then(() => {
          hostReentryGate.open()
        })
      }, STARTUP_INSTALL_QUIT_BACKSTOP_MS)
    } else {
      app.removeListener('before-quit', onUpdateInstallQuit)
      if (updateSplash) {
        await openSurfaceAndDismissSplash()
      } else {
        void openStartupSurface()
      }
      hostReentryGate.open()
    }

    installationEvents.on('changed', () => {
      _broadcastToRenderer('installations-changed', {})
    })

    installationEvents.on('changed', () => {
      void (async () => {
        const liveIds = new Set((await listInstallations()).map((i) => i.id))
        detachOrphanedInstallHosts(liveIds)
      })()
    })

    const _periodicIntervalMs = process.env['E2E_PERIODIC_RECHECK_MS']
      ? Number(process.env['E2E_PERIODIC_RECHECK_MS'])
      : undefined
    _stopPeriodicReleaseChecks = startPeriodicReleaseChecks(listInstallations, {
      onRefreshed: () => _broadcastToRenderer('installations-changed', {}),
      ...(typeof _periodicIntervalMs === 'number' && Number.isFinite(_periodicIntervalMs)
        ? { intervalMs: _periodicIntervalMs }
        : {})
    })
  })

  app.on('activate', () => {
    hostReentryGate.runOrQueue(() => {
      if (process.platform === 'darwin') {
        raiseAllHostWindows()
      } else {
        openOrFocusAnyHostWindow()
      }
    })
  })

  app.on('before-quit', (event) => {
    const asksAboutRuns = !isQuitInProgress() && runningAppCount() > 0
    if (asksAboutRuns && !confirmQuitStopsAppRuns()) {
      event.preventDefault()
      return
    }
    if (!isQuitInProgress() && !asksAboutRuns && hasActiveTemplateDownloads()) {
      const choice = dialog.showMessageBoxSync({
        type: 'warning',
        buttons: [i18n.t('templateQuit.quit'), i18n.t('templateQuit.cancel')],
        defaultId: 1,
        cancelId: 1,
        title: i18n.t('templateQuit.title'),
        message: i18n.t('templateQuit.message')
      })
      if (choice === 1) {
        event.preventDefault()
        return
      }
    }
    if (!isQuitInProgress()) {
      setQuitReason('user-quit')
      ipc.cancelAll()
      for (const [, entry] of comfyWindows) {
        if (!entry.window.isDestroyed()) entry.window.destroy()
      }
      comfyWindows.clear()
      closeAllPopouts()
      disposeAllTerminals()
      if (tray) {
        tray.destroy()
        tray = null
      }
    }
    if (postponeQuitWhileDestroyedWindowsHaveLiveWebContents(event)) return
    updater.recordProcessExit()
    if (_stopPeriodicReleaseChecks) {
      _stopPeriodicReleaseChecks()
      _stopPeriodicReleaseChecks = null
    }
    flushLastSessionSync()
    flushOperationOutput()
    cleanupTempDownloads()
    stopAgentPrefetches()
  })

  app.on(
    'will-quit',
    createWillQuitHandler({
      quit: () => app.quit(),
      hasActiveModelTransfers,
      suspendActiveModelDownloadsForQuit,
      hasPendingStopStamps: ipc.hasPendingStopStamps,
      settleStopStamps: ipc.settleStopStamps,
      stopStampWaitMs: STOP_STAMP_QUIT_WAIT_MS,
      isUpdateInstallQuit
    })
  )

  powerMonitor.on('suspend', () => {
    suspendActiveModelDownloadsForSleep()
  })
  powerMonitor.on('resume', () => {
    void resumeModelDownloadsAfterWake()
  })

  app.on('window-all-closed', () => {
    void stopBuildsRunningForAppsOnly().finally(() => {
      if (BrowserWindow.getAllWindows().length > 0) return
      if (quitsOnceEveryWindowClosed()) app.quit()
    })
  })
}
