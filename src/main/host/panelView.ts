import { WebContentsView, ipcMain, webFrameMain } from 'electron'
import path from 'path'
import { attachContextMenu } from '../lib/contextMenu'
import { resolveTheme } from '../lib/ipc/shared'
import { get as getSetting } from '../settings'
import { TITLEBAR_BG } from '../lib/theme'
import { TITLEBAR_HEIGHT, titleBarOverlayForTheme } from '../lib/titleBarOverlay'
import {
  _registerExtraBroadcastTarget,
  _unregisterExtraBroadcastTarget,
  _activeOperationStatus
} from '../lib/ipc/shared'
import {
  comfyWindows,
  computeBodyMode,
  findEntryByTitleBarSender,
  getEntryByInstallationId,
  isOverlayPanel,
  revealColdStartHostIfPending,
  VALID_PANELS
} from './registry'
import type { BodyMode, ComfyPanelKey, ComfyWindowEntry } from './registry'
import { getArtifyPanelUrl } from '../artifylab/panelMode'
import { showArtifyLab } from '../artifylab'
import { getComfyInjectScriptSource } from './comfyInject'

/** Opaque panel background matching the title-bar chrome, used while the panel
 *  bundle loads for full-screen bodies so the user never sees a black flash. */
function opaquePanelBg(): string {
  const overlay = titleBarOverlayForTheme(resolveTheme() === 'dark')
  return overlay.color ?? TITLEBAR_BG
}

/** Full-screen bodies that hide the comfy view, so the panel must paint opaque
 *  during load rather than compositing the (hidden) canvas through. `comfy-
 *  lifecycle` is included so the 1-2s `stopping` window shows the spinner over
 *  an opaque surface instead of black. Overlay modes (downloads / feedback)
 *  deliberately stay transparent. */
function isOpaqueBodyMode(mode: BodyMode): boolean {
  return mode === 'chooser' || mode === 'new-install' || mode === 'comfy-lifecycle'
}

/**
 * Inject the playground script into a just-navigated subframe when its URL is the
 * A UI's embedded ComfyUI (`artify_playground=true`). The frame is re-resolved by
 * (processId, routingId) at navigate-commit time — never held across ticks — so a
 * frame that died in a cross-process swap simply resolves to undefined / detached
 * and is skipped. Exported for unit tests.
 */
export function injectPlaygroundScriptIfMatch(
  url: string,
  frameProcessId: number,
  frameRoutingId: number
): void {
  if (!url.includes('artify_playground=true')) return
  const frame = webFrameMain.fromId(frameProcessId, frameRoutingId)
  if (!frame || frame.detached) return
  const injectJs = getComfyInjectScriptSource()
  if (!injectJs) return
  console.log('[iframe-inject] injecting, len=', injectJs.length)
  try {
    void frame.executeJavaScript(injectJs).catch(() => {})
  } catch {
    // Frame died between the navigate event and the call; nothing to inject into.
  }
}

/**
 * Lazily create the panel WebContentsView for a comfy window. The URL params are only an
 * initial hint; `did-finish-load` always re-pushes the current `activePanel` to guard
 * against a mid-load race where the user clicks between buttons before the first load ends.
 */
export function ensurePanelView(
  windowKey: number,
  entry: ComfyWindowEntry,
  initialPanel: BodyMode
): WebContentsView {
  if (entry.panelView) return entry.panelView

  const panelView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      // preload/index.js imports the shared window.api chunk; a sandboxed preload can't
      // require() relative chunks, which would break window.api in the panel.
      sandbox: false,
      preload: path.join(__dirname, '../preload/index.js')
      // Default session (no partition) keeps the panel isolated from ComfyUI's storage.
    }
  })
  panelView.setBackgroundColor(isOpaqueBodyMode(initialPanel) ? opaquePanelBg() : '#00000000')
  entry.window.contentView.addChildView(panelView)
  // Native right-click Copy/Paste for selectable text + inputs in panel bodies
  // (chooser, install forms, settings, etc.).
  attachContextMenu(entry.window, panelView.webContents)
  // The A UI's workflow editor (WorkflowModal) embeds ComfyUI in an iframe
  // (`artify_playground=true`) and drives it over postMessage. That subframe
  // has no preload and never goes through attach.ts, so the playground-mode
  // script never runs there on its own — inject it once the frame commits its
  // navigation to the playground URL. This is deliberately event-driven: the
  // WebFrameMain handed over by `frame-created` is routinely disposed by the
  // about:blank -> http cross-process swap (and by React rebuilding the
  // iframe), so dereferencing it from a deferred tick throws "Render frame
  // was disposed before WebFrameMain could be accessed" in the main process.
  // The script's own `__artifyInjectLoaded` guard keeps repeat navigations a
  // no-op.
  panelView.webContents.on(
    'did-frame-navigate',
    (
      _event,
      url,
      _httpResponseCode,
      _httpStatusText,
      isMainFrame,
      frameProcessId,
      frameRoutingId
    ) => {
      if (isMainFrame) return
      injectPlaygroundScriptIfMatch(url, frameProcessId, frameRoutingId)
    }
  )
  // Insert at zero size, behind the comfy view; layoutViews handles positioning.
  panelView.setBounds({ x: 0, y: TITLEBAR_HEIGHT + 1, width: 0, height: 0 })
  panelView.setVisible(false)

  // Push the latest body mode (may differ from initialPanel) and steal focus if focused.
  panelView.webContents.once('did-finish-load', () => {
    const latest = comfyWindows.get(windowKey)
    if (!latest || latest.window.isDestroyed() || panelView.webContents.isDestroyed()) return
    // Backstop reveal for the rare case where the titlebar load is delayed past the panel's.
    revealColdStartHostIfPending(windowKey)
    const mode = computeBodyMode(latest)
    if (mode !== 'comfy') {
      panelView.webContents.send('panel-switch', {
        panel: mode,
        installationId: latest.installationId ?? ''
      })
      if (latest.window.isFocused()) panelView.webContents.focus()
    }
  })

  // Pass installationId ('' for install-less hosts), not the numeric windowKey map key.
  const panelInstallationId = entry.installationId ?? ''
  const firstUseCompleted = getSetting('firstUseCompleted') === true
  const panelQuery: Record<string, string> = {
    installationId: panelInstallationId,
    panel: initialPanel,
    firstUseCompleted: String(firstUseCompleted)
  }
  // Propagate the E2E flag via the URL query (the renderer can't read process.env) so the
  // renderer-side test hooks only register when the runner opted in.
  if (process.env['E2E'] === '1') {
    panelQuery['e2e'] = '1'
  }
  loadPanelContent(panelView.webContents, entry, panelQuery)

  _registerExtraBroadcastTarget(panelView.webContents)
  entry.panelView = panelView
  return panelView
}

/**
 * Load the panel body for `entry.panelSurface`: the A UI frontend in
 * single-window mode, otherwise the native panel app. Shared by
 * `ensurePanelView` (first build) and `setPanelSurface` (surface switch)
 * so both always agree on what the panelView hosts. Loads can reject if
 * the window closes mid-load; swallowed to avoid noisy forwarding.
 *
 * Overlay bodies (feedback / mcp-setup / announcement) are rendered by the
 * native panel app (PanelApp.vue), never by the A UI frontend — so an
 * overlay target always loads the native panel body even when
 * `panelSurface === 'artify'`. Without this, opening the MCP setup /
 * announcement / feedback modal from the C canvas would surface the A UI
 * instead of the modal (an unintended A/C switch).
 */
function loadPanelContent(
  wc: Electron.WebContents,
  entry: ComfyWindowEntry,
  panelQuery: Record<string, string>
): void {
  const panel = panelQuery.panel as BodyMode
  const overlayBody = isOverlayPanel(panel)
  const artifyUrl = entry.panelSurface === 'artify' && !overlayBody ? getArtifyPanelUrl() : null
  if (artifyUrl) {
    void wc.loadURL(artifyUrl).catch(() => {})
    return
  }
  const isDev = !!process.env['ELECTRON_RENDERER_URL']
  if (isDev) {
    void wc
      .loadURL(
        `${(process.env['ELECTRON_RENDERER_URL'] as string).replace(/\/$/, '')}/panel.html?${new URLSearchParams(panelQuery).toString()}`
      )
      .catch(() => {})
  } else {
    void wc
      .loadFile(path.join(__dirname, '../renderer/panel.html'), { query: panelQuery })
      .catch(() => {})
  }
}

/**
 * Switch what the panelView hosts — the A UI frontend or the native
 * chooser/panel app. Navigates the live panelView in place; a destroyed
 * (or not-yet-built) panelView picks the new surface up on the next
 * `ensurePanelView`. No-op when the surface is already current.
 */
export function setPanelSurface(entry: ComfyWindowEntry, surface: 'artify' | 'chooser'): void {
  if (entry.panelSurface === surface) return
  entry.panelSurface = surface
  // Keep the title-bar A/C segmented switch in sync with programmatic
  // flips (float-button paths, attach/detach). Sent before the
  // destroyed-panelView early-return so the push lands even when the
  // switch happens via a panelView rebuild.
  if (!entry.titleBarView.webContents.isDestroyed()) {
    entry.titleBarView.webContents.send('comfy-titlebar:surface-changed', surface)
  }
  if (!entry.panelView || entry.panelView.webContents.isDestroyed()) return
  const panelQuery: Record<string, string> = {
    installationId: entry.installationId ?? '',
    // The native chooser app keys its surface on the `panel` query; the
    // install-less chooser body is `'chooser'`, not the active pill key.
    panel: surface === 'chooser' ? 'chooser' : entry.activePanel,
    firstUseCompleted: String(getSetting('firstUseCompleted') === true)
  }
  loadPanelContent(entry.panelView.webContents, entry, panelQuery)
}

/**
 * Tear down the entry's current panelView so the next `ensurePanelView()` rebuilds it
 * fresh. The chooser-pick attach path uses this to drop the chooser PanelApp (and any
 * in-flight overlay) before the install takes over; otherwise a later close consult would
 * hang on the hidden panel's cancel-prompt waiting for input the user can't see.
 */
export function destroyPanelView(entry: ComfyWindowEntry): void {
  if (!entry.panelView) return
  const oldPanel = entry.panelView
  entry.panelView = null
  // The old panel is gone (and with it any A UI it hosted); a stale overlay
  // restore marker would navigate the rebuilt native panel back to the A UI
  // on the next close. Clear it so the rebuild starts surface-consistent.
  entry.surfaceBeforeOverlay = null
  entry.overlayFromChooser = undefined
  if (!oldPanel.webContents.isDestroyed()) {
    _unregisterExtraBroadcastTarget(oldPanel.webContents)
    oldPanel.webContents.close()
  }
  if (!entry.window.isDestroyed()) {
    try {
      entry.window.contentView.removeChildView(oldPanel)
    } catch {}
  }
  // The rebuilt panel starts with no overlay, so any `firstUseMode` the old renderer pushed
  // is stale. Reset to `'none'` and broadcast so the title bar paints full chrome; the new
  // renderer re-pushes if onboarding is still active.
  if (entry.firstUseMode !== 'none') {
    entry.firstUseMode = 'none'
    if (!entry.titleBarView.webContents.isDestroyed()) {
      entry.titleBarView.webContents.send('comfy-titlebar:first-use-mode-changed', 'none')
    }
  }
}

/** Move OS focus to whichever body view is now active so keyboard input lands in the right place. */
export function focusActiveBody(entry: ComfyWindowEntry): void {
  if (entry.window.isDestroyed() || !entry.window.isFocused()) return
  const mode = computeBodyMode(entry)
  if (mode === 'comfy') {
    if (!entry.comfyView.webContents.isDestroyed()) entry.comfyView.webContents.focus()
  } else if (
    entry.panelView &&
    !entry.panelView.webContents.isDestroyed() &&
    !entry.panelView.webContents.isLoadingMainFrame()
  ) {
    // If still loading, ensurePanelView's did-finish-load handler focuses it instead.
    entry.panelView.webContents.focus()
  }
}

export function setActivePanel(windowKey: number, panel: ComfyPanelKey): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry || entry.window.isDestroyed()) return
  const prevPanel = entry.activePanel
  if (prevPanel === panel) return

  const openingOverlay = isOverlayPanel(panel) && !isOverlayPanel(prevPanel)
  const closingOverlay = isOverlayPanel(prevPanel) && !isOverlayPanel(panel)

  entry.activePanel = panel
  const mode = computeBodyMode(entry)
  // Broadcast every body-mode change including 'comfy', else the renderer's activePanel ref
  // goes stale after a drawer close and the next open no-ops.
  if (mode !== 'comfy') {
    ensurePanelView(windowKey, entry, mode)
  }
  // Overlay panels reveal only after the renderer's `overlay-ready` ack (see
  // layoutViews); clear the flag for non-overlay targets so it can't strand.
  const isOverlay = isOverlayPanel(mode)
  entry.pendingOverlayReveal = isOverlay
  // Drop any prior fallback timer so a stale one can't reveal this open early.
  if (entry.overlayRevealTimer) clearTimeout(entry.overlayRevealTimer)
  entry.overlayRevealTimer = undefined
  // Overlay modals are rendered by the native panel app (PanelApp.vue), never
  // by the A UI frontend. When the panelView hosts the A UI (single-window
  // mode, panelSurface='artify'), opening an overlay must temporarily navigate
  // the panelView to the native panel body — otherwise the MCP setup /
  // announcement / feedback modal would resolve to the A UI surface, reading
  // as an unwanted A/C switch from the C canvas. When the overlay closes,
  // navigate the panelView back to the A UI it replaced. `entry.panelSurface`
  // itself is left untouched so the title-bar A/C segment and the next
  // surface switch stay consistent.
  // `overlayFromChooser` records which body the user was on before the overlay
  // ('chooser' = A UI, 'comfy' = C canvas): closeCurrentPanel must restore to
  // that same body, and layoutViews needs it to decide whether the C canvas
  // stays visible under the overlay. Only set/cleared on enter/exit — a switch
  // between two overlays (announcement → feedback) must keep the original.
  if (openingOverlay) entry.overlayFromChooser = prevPanel === 'chooser'
  else if (closingOverlay) entry.overlayFromChooser = undefined
  if (openingOverlay && entry.panelSurface === 'artify') {
    entry.surfaceBeforeOverlay = 'artify'
    const pv = entry.panelView
    if (pv && !pv.webContents.isDestroyed()) {
      loadPanelContent(pv.webContents, entry, {
        installationId: entry.installationId ?? '',
        panel: mode,
        firstUseCompleted: String(getSetting('firstUseCompleted') === true)
      })
    }
  } else if (closingOverlay && entry.surfaceBeforeOverlay === 'artify') {
    entry.surfaceBeforeOverlay = null
    const pv = entry.panelView
    if (pv && !pv.webContents.isDestroyed()) {
      loadPanelContent(pv.webContents, entry, {
        installationId: entry.installationId ?? '',
        panel: entry.activePanel,
        firstUseCompleted: String(getSetting('firstUseCompleted') === true)
      })
    }
  }
  forwardToPanelRenderer(entry, 'panel-switch', {
    panel: mode,
    installationId: entry.installationId ?? ''
  })
  entry.layoutViews()
  // Reveal anyway if the ack never arrives (crash / lost IPC); a late ack no-ops.
  if (isOverlay) {
    entry.overlayRevealTimer = setTimeout(() => {
      entry.overlayRevealTimer = undefined
      if (!entry.pendingOverlayReveal || entry.window.isDestroyed()) return
      entry.pendingOverlayReveal = false
      entry.layoutViews()
    }, 400)
  }
  if (!entry.titleBarView.webContents.isDestroyed()) {
    // Pill stays on the user-visible key, not 'comfy-lifecycle'.
    entry.titleBarView.webContents.send('comfy-titlebar:panel-changed', panel)
  }
  pushBodyModeToTitleBar(entry, mode)
  focusActiveBody(entry)
}

/**
 * Warm the install-backed panel in the background right after a chooser-pick
 * in-place attach, so the first Settings/MCP click doesn't build it cold.
 *
 * The reset to `'comfy'` MUST precede `ensurePanelView`: the picker drove its
 * launch through a `'progress'` overlay on this host, and without clearing it
 * `computeBodyMode` stays `'progress'` — the rebuilt panel would then cover the
 * just-attached canvas with a stranded progress surface.
 */
export function prewarmAttachedPanel(entry: ComfyWindowEntry): void {
  setActivePanel(entry.windowKey, 'comfy')
  // `setActivePanel` early-returns (and skips its body-mode push) when
  // activePanel is already 'comfy' — the chooser host's initial value. But
  // this attach just changed the body from 'chooser' (install-less) to
  // 'comfy' (install + running), so push explicitly or the title-bar A
  // segment stays disabled forever after a chooser-pick attach.
  pushBodyModeToTitleBar(entry, computeBodyMode(entry))
  ensurePanelView(entry.windowKey, entry, computeBodyMode(entry))
  entry.layoutViews()
}

/**
 * Re-evaluate the body mode after a session-state transition and reflect it in the layout.
 * When the mode is `'comfy-lifecycle'`, the panelView renders the lifecycle UI; the pill
 * stays on `'comfy'` either way.
 */
export function refreshComfyTabBody(installationId: string): void {
  const entry = getEntryByInstallationId(installationId)
  if (!entry || entry.window.isDestroyed()) return
  if (entry.activePanel !== 'comfy') return
  // A background op (inline picker update/restore) is managing this lifecycle; don't flash
  // the "not running" screen while it's in-flight.
  const bgOp = _activeOperationStatus.get(installationId)
  if (bgOp && !bgOp.done) return

  const mode = computeBodyMode(entry)
  if (mode === 'comfy-lifecycle') {
    const lifecyclePanel = ensurePanelView(entry.windowKey, entry, 'comfy-lifecycle')
    // Re-force opaque in case the panel was first created transparent (overlay/
    // comfy mode); otherwise the hidden canvas shows black until Vue paints.
    if (!lifecyclePanel.webContents.isDestroyed()) {
      lifecyclePanel.setBackgroundColor(opaquePanelBg())
    }
  }
  pushBodyModeToTitleBar(entry, mode)
  forwardToPanelRenderer(entry, 'panel-switch', { panel: mode, installationId })
  entry.layoutViews()
  focusActiveBody(entry)
}

/**
 * Push the entry's current body mode to the title bar. Drives the A/C
 * surface switch's A-segment gate: the A UI may only be entered once the
 * ComfyUI canvas is actually visible (`'comfy'`), not while the chooser
 * (install-less) or the lifecycle panel (stopped / starting) fills the body.
 */
function pushBodyModeToTitleBar(entry: ComfyWindowEntry, mode: BodyMode): void {
  if (entry.titleBarView.webContents.isDestroyed()) return
  entry.titleBarView.webContents.send('comfy-titlebar:body-mode-changed', mode)
}

/**
 * Send a payload to a panelView, deferring until `did-finish-load` if the bundle is still
 * loading, so IPC landing during the lazy first-load isn't dropped before the listener wires up.
 */
export function sendToPanelDeferred(
  panelView: WebContentsView,
  channel: string,
  payload: unknown
): void {
  if (panelView.webContents.isDestroyed()) return
  const send = (): void => {
    if (panelView.webContents.isDestroyed()) return
    panelView.webContents.send(channel, payload)
  }
  if (panelView.webContents.isLoadingMainFrame()) {
    panelView.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

/** Forward an IPC to the entry's panel renderer, no-op if absent. */
function forwardToPanelRenderer(entry: ComfyWindowEntry, channel: string, payload?: unknown): void {
  const pv = entry.panelView
  if (!pv || pv.webContents.isDestroyed()) return
  sendToPanelDeferred(pv, channel, payload)
}

/** Wire the panel-routing IPC handlers. Called once at app `whenReady`. */
export function registerPanelViewIpc(): void {
  ipcMain.on('comfy-window:set-panel', (event, payload: { panel: string }) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    const panel = payload?.panel as ComfyPanelKey
    if (!VALID_PANELS.has(panel)) return
    setActivePanel(found.id, panel)
  })

  // Title-bar A/C segmented switch, C→A direction. Routes through the
  // same `showArtifyLab()` focus handler the float button uses, so the
  // single-window surface flip (and chooser-window cleanup) behaves
  // identically to the existing C→A path. The A→C direction is just
  // `setPanel('comfy')` and needs no surface special-case.
  // Gate: the A UI may only be entered once the ComfyUI canvas is live
  // (body mode 'comfy'). While the chooser or lifecycle panel fills the
  // body, refuse the switch — the title bar also disables the segment,
  // this is the main-side backstop.
  ipcMain.on('comfy-window:set-surface', (event, payload: { surface: string }) => {
    const found = findEntryByTitleBarSender(event.sender)
    if (!found) return
    if (payload?.surface !== 'artify') return
    if (computeBodyMode(found.entry) !== 'comfy') return
    // A→C 后暖面板驻留形态：panelSurface 已是 'artify'，A UI 只是随
    // activePanel='comfy' 一起被 layoutViews 隐藏。此时不需要 surface
    // 翻转/重载——把活动面板从 comfy 画布切回 chooser（A UI 面板体）
    // 即可，setActivePanel 内部完成可见性切换与标题栏推送。
    if (found.entry.panelSurface === 'artify') {
      if (found.entry.activePanel !== 'comfy') return
      setActivePanel(found.id, 'chooser')
      if (!found.entry.window.isDestroyed()) {
        found.entry.window.show()
        found.entry.window.focus()
      }
      return
    }
    void showArtifyLab().catch(() => {})
  })

  // Page-level X close inside the panel: same effect as a pill click. Resolve the host via
  // the panel's WebContents sender (walking entries, since the panelView is lazily created).
  // Restore to the body the overlay was opened from: an overlay opened on the A UI
  // (overlayFromChooser) must land back on 'chooser' so the A UI shows again — 'comfy'
  // would leave the user on the C canvas while the title-bar A/C segment still reads
  // 'artify' (and its A click no-ops), trapping them off the A surface. Everything else
  // closes back to the Comfy canvas.
  ipcMain.on('comfy-window:close-current-panel', (event) => {
    for (const [id, entry] of comfyWindows) {
      if (entry.panelView?.webContents === event.sender) {
        setActivePanel(id, entry.overlayFromChooser ? 'chooser' : 'comfy')
        return
      }
    }
  })

  // The panel renderer painted an overlay modal; reveal the until-now-hidden
  // panel view so it appears with content rather than as an opaque flash.
  ipcMain.on('comfy-window:overlay-ready', (event) => {
    for (const entry of comfyWindows.values()) {
      if (entry.panelView?.webContents === event.sender) {
        if (!entry.pendingOverlayReveal) return
        entry.pendingOverlayReveal = false
        if (entry.overlayRevealTimer) clearTimeout(entry.overlayRevealTimer)
        entry.overlayRevealTimer = undefined
        if (!entry.window.isDestroyed()) entry.layoutViews()
        return
      }
    }
  })
}
