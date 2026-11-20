import { contextBridge, ipcRenderer } from 'electron'
import type { IpcRendererEvent } from 'electron'
import { buildElectronApi } from './api'
import { normaliseFirstUseMode, type FirstUseMode } from '../shared/firstUseMode'

export type ComfyPanelKey =
  | 'comfy'
  | 'performance-test'
  | 'benchmarks'
  /** Single-window mode: the panel body hosts the A UI / install picker
   *  (main pushes this key on C→A surface flips; the A/C switch sends
   *  setPanel('chooser') to re-wake the warm A panel after an A→C flip). */
  | 'chooser'
  | 'new-install'
  | 'track'
  | 'load-snapshot'

export type CoachmarkKind = 'beta-notice'

export interface TitleMenuAnchor {
  x: number
  y: number
}

export interface DownloadsTrayEntry {
  id?: string
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

export interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

export interface ComfyTitleBarBridge {
  getInstallationId(): string | null
  isMac(): boolean
  isLinux(): boolean
  setPanel(panel: ComfyPanelKey): void
  /** Request the main process to swap the panelView surface
   *  (`'artify'` = A UI frontend, `'chooser'` = native panel app).
   *  The title-bar A/C segmented switch uses this for C→A; A→C
   *  reuses `setPanel('comfy')`. */
  setSurface(surface: 'artify' | 'chooser'): void
  /** Cold-boot surface seed read from the `surface` query param.
   *  `'chooser'` when absent. Runtime updates arrive via
   *  `onSurfaceChanged`. */
  getSurface(): 'artify' | 'chooser'
  openNewWindow(): void
  openFileMenu(anchor: TitleMenuAnchor): void
  dismissFileMenu(): void

  onPanelChanged(cb: (panel: ComfyPanelKey) => void): () => void
  /** Subscribe to body-mode pushes from main. `'comfy'` means the live
   *  ComfyUI canvas fills the body; `'chooser'` (install-less host) and
   *  `'comfy-lifecycle'` (stopped / starting) mean the canvas is NOT up.
   *  The A/C switch's A segment is gated on this: the A UI may only be
   *  entered once the canvas is live. */
  onBodyModeChanged(cb: (mode: string) => void): () => void
  /** Subscribe to panelView surface flips (artify ↔ chooser) coming
   *  from main. Fired by `setPanelSurface` so the title-bar A/C
   *  segmented switch stays in sync with programmatic flips (the
   *  float-button paths, attach/detach). */
  onSurfaceChanged(cb: (surface: 'artify' | 'chooser') => void): () => void
  onTitleChanged(cb: (title: string) => void): () => void
  onSourceCategoryChanged(cb: (category: string | null) => void): () => void
  onZoomChanged(cb: (level: number) => void): () => void
  onThemeChanged(cb: (theme: { bg: string; text: string }) => void): () => void
  onFullscreenChanged(cb: (fullscreen: boolean) => void): () => void
  onMenuOpened(cb: (info: { menu: 'menu' | 'downloads' | 'instance-picker' }) => void): () => void
  onMenuClosed(cb: (info: { menu: 'menu' | 'downloads' | 'instance-picker' }) => void): () => void
  onFirstUseModeChanged(cb: (mode: FirstUseMode) => void): () => void
  onPreviewModeChanged(cb: (preview: boolean) => void): () => void
  onInstallationIdChanged(cb: (installationId: string | null) => void): () => void
  onAppUpdateStateChanged(
    cb: (state: {
      kind: 'available' | 'downloading' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void
  ): () => void
  onInstallUpdateAvailable(
    cb: (state: { available: boolean; version: string | null }) => void
  ): () => void
  clickAppUpdatePill(): void
  clickInstallUpdatePill(): void
  onDownloadsChanged(cb: (state: DownloadsTrayState) => void): () => void
  clickDownloadsTray(anchor: TitleMenuAnchor): void
  clickFeedback(): void
  openWhatsNewMenu(anchor: TitleMenuAnchor): void
  clickRefreshInstance(): void
  clickHome(): void
  resetZoom(): void
  showTooltip(payload: { text: string; leftX: number; rightX: number; bottomY: number }): void
  hideTooltip(): void
  showCoachmark(payload: {
    kind?: CoachmarkKind
    title: string
    body: string
    dismissLabel: string
    actionLabel?: string
    leftX: number
    rightX: number
    bottomY: number
  }): void
  hideCoachmark(): void
  onCoachmarkDismissed(cb: (payload: { kind: CoachmarkKind }) => void): () => void
  onCoachmarkAction(cb: (payload: { kind: CoachmarkKind }) => void): () => void
  onCoachmarkAutoHidden(cb: (payload: { kind: CoachmarkKind }) => void): () => void
  onCoachmarkSettled(cb: (payload: { kind: CoachmarkKind }) => void): () => void
  onCoachmarkDisplaced(cb: (payload: { kind: CoachmarkKind }) => void): () => void
  ready(): void
}

interface PreloadGlobals {
  location?: { href: string }
  navigator?: { userAgent: string }
}
const g = globalThis as unknown as PreloadGlobals

function readInstallationId(): string | null {
  try {
    const href = g.location?.href
    if (!href) return null
    return new URL(href).searchParams.get('installationId')
  } catch {
    return null
  }
}

/** Cold-boot seed for the panelView surface. Main re-pushes the
 *  authoritative value on `comfy-titlebar:surface-changed` after the
 *  title-bar-ready handshake and on every flip. */
function readSurface(): 'artify' | 'chooser' {
  try {
    const href = g.location?.href
    if (!href) return 'chooser'
    return new URL(href).searchParams.get('surface') === 'artify' ? 'artify' : 'chooser'
  } catch {
    return 'chooser'
  }
}

const bridge: ComfyTitleBarBridge = {
  getInstallationId: () => readInstallationId(),
  isMac: () => (g.navigator?.userAgent ?? '').toLowerCase().includes('mac'),
  isLinux: () => (g.navigator?.userAgent ?? '').toLowerCase().includes('linux'),
  setPanel: (panel) => {
    ipcRenderer.send('comfy-window:set-panel', { panel })
  },
  /** Request the main process to swap the panelView surface (A UI ↔
   *  native chooser). Mirrors `setPanel` but targets the surface —
   *  used by the title-bar A/C segmented switch for the C→A
   *  direction; A→C goes through `setPanel('comfy')`. */
  setSurface: (surface) => {
    ipcRenderer.send('comfy-window:set-surface', { surface })
  },
  getSurface: () => readSurface(),
  openNewWindow: () => {
    ipcRenderer.send('comfy-window:new-chooser-window')
  },
  openFileMenu: (anchor) => {
    ipcRenderer.send('comfy-window:open-title-menu', { menu: 'file', anchor })
  },
  dismissFileMenu: () => {
    ipcRenderer.send('comfy-window:dismiss-title-menu')
  },

  onPanelChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, panel: unknown): void => {
      if (typeof panel === 'string') cb(panel as ComfyPanelKey)
    }
    ipcRenderer.on('comfy-titlebar:panel-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:panel-changed', handler)
  },
  onBodyModeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, mode: unknown): void => {
      if (typeof mode === 'string') cb(mode)
    }
    ipcRenderer.on('comfy-titlebar:body-mode-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:body-mode-changed', handler)
  },
  onSurfaceChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, surface: unknown): void => {
      if (surface === 'artify' || surface === 'chooser') cb(surface)
    }
    ipcRenderer.on('comfy-titlebar:surface-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:surface-changed', handler)
  },
  onTitleChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, title: unknown): void => {
      if (typeof title === 'string') cb(title)
    }
    ipcRenderer.on('comfy-titlebar:title-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:title-changed', handler)
  },
  onSourceCategoryChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, category: unknown): void => {
      cb(typeof category === 'string' ? category : null)
    }
    ipcRenderer.on('comfy-titlebar:source-category-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:source-category-changed', handler)
  },
  onZoomChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, level: unknown): void => {
      cb(typeof level === 'number' ? level : 0)
    }
    ipcRenderer.on('comfy-titlebar:zoom-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:zoom-changed', handler)
  },
  onThemeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { bg, text } = (data || {}) as { bg?: string; text?: string }
      if (typeof bg === 'string' && typeof text === 'string') cb({ bg, text })
    }
    ipcRenderer.on('comfy-titlebar:theme-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:theme-changed', handler)
  },
  onFullscreenChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, fullscreen: unknown): void => {
      cb(!!fullscreen)
    }
    ipcRenderer.on('comfy-titlebar:fullscreen-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:fullscreen-changed', handler)
  },
  onMenuOpened: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'menu' || menu === 'downloads' || menu === 'instance-picker') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-opened', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-opened', handler)
  },
  onMenuClosed: (cb) => {
    const handler = (_event: IpcRendererEvent, data: unknown): void => {
      const { menu } = (data || {}) as { menu?: unknown }
      if (menu === 'menu' || menu === 'downloads' || menu === 'instance-picker') cb({ menu })
    }
    ipcRenderer.on('comfy-titlebar:menu-closed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:menu-closed', handler)
  },
  onFirstUseModeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, mode: unknown): void => {
      cb(normaliseFirstUseMode(mode))
    }
    ipcRenderer.on('comfy-titlebar:first-use-mode-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:first-use-mode-changed', handler)
  },
  onPreviewModeChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, preview: unknown): void => {
      cb(!!preview)
    }
    ipcRenderer.on('comfy-titlebar:preview-mode-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:preview-mode-changed', handler)
  },
  onInstallationIdChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, installationId: unknown): void => {
      cb(typeof installationId === 'string' ? installationId : null)
    }
    ipcRenderer.on('comfy-titlebar:installation-id-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:installation-id-changed', handler)
  },
  onAppUpdateStateChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { kind?: unknown; version?: unknown; autoUpdate?: unknown }
      const kind =
        data.kind === 'available' || data.kind === 'downloading' || data.kind === 'ready'
          ? data.kind
          : null
      const version = typeof data.version === 'string' ? data.version : null
      const autoUpdate = data.autoUpdate !== false
      cb({ kind, version, autoUpdate })
    }
    ipcRenderer.on('comfy-titlebar:app-update-state-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:app-update-state-changed', handler)
  },
  onInstallUpdateAvailable: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { available?: unknown; version?: unknown }
      const available = !!data.available
      const version = typeof data.version === 'string' ? data.version : null
      cb({ available, version })
    }
    ipcRenderer.on('comfy-titlebar:install-update-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:install-update-changed', handler)
  },
  clickAppUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-app-update-pill')
  },
  clickInstallUpdatePill: () => {
    ipcRenderer.send('comfy-window:click-install-update-pill')
  },
  onDownloadsChanged: (cb) => {
    const handler = (_event: IpcRendererEvent, state: unknown): void => {
      const data = (state || {}) as { active?: unknown; recent?: unknown }
      const active = Array.isArray(data.active) ? (data.active as DownloadsTrayEntry[]) : []
      const recent = Array.isArray(data.recent) ? (data.recent as DownloadsTrayEntry[]) : []
      cb({ active, recent })
    }
    ipcRenderer.on('comfy-titlebar:downloads-changed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:downloads-changed', handler)
  },
  clickDownloadsTray: (anchor) => {
    ipcRenderer.send('comfy-window:click-downloads-tray', { anchor })
  },
  clickFeedback: () => {
    ipcRenderer.send('comfy-window:click-feedback')
  },
  openWhatsNewMenu: (anchor) => {
    ipcRenderer.send('comfy-window:open-title-menu', { menu: 'whats-new', anchor })
  },
  clickRefreshInstance: () => {
    ipcRenderer.send('comfy-window:click-refresh-instance')
  },
  clickHome: () => {
    ipcRenderer.send('comfy-window:show-home')
  },
  resetZoom: () => {
    ipcRenderer.send('comfy-window:reset-zoom')
  },
  showTooltip: (payload) => {
    ipcRenderer.send('comfy-window:show-titlebar-tooltip', payload)
  },
  hideTooltip: () => {
    ipcRenderer.send('comfy-window:hide-titlebar-tooltip')
  },
  showCoachmark: (payload) => {
    ipcRenderer.send('comfy-window:show-titlebar-coachmark', payload)
  },
  hideCoachmark: () => {
    ipcRenderer.send('comfy-window:hide-titlebar-coachmark')
  },
  onCoachmarkDismissed: (cb) => {
    const handler = (): void => cb({ kind: 'beta-notice' })
    ipcRenderer.on('comfy-titlebar:coachmark-dismissed', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:coachmark-dismissed', handler)
  },
  onCoachmarkAction: (cb) => {
    const handler = (): void => cb({ kind: 'beta-notice' })
    ipcRenderer.on('comfy-titlebar:coachmark-action', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:coachmark-action', handler)
  },
  onCoachmarkAutoHidden: (cb: (payload: { kind: CoachmarkKind }) => void) => {
    const handler = (): void => cb({ kind: 'beta-notice' })
    ipcRenderer.on('comfy-titlebar:coachmark-auto-hidden', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:coachmark-auto-hidden', handler)
  },
  onCoachmarkSettled: (cb: (payload: { kind: CoachmarkKind }) => void) => {
    const handler = (): void => cb({ kind: 'beta-notice' })
    ipcRenderer.on('comfy-titlebar:coachmark-settled', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:coachmark-settled', handler)
  },
  onCoachmarkDisplaced: (cb: (payload: { kind: CoachmarkKind }) => void) => {
    const handler = (): void => cb({ kind: 'beta-notice' })
    ipcRenderer.on('comfy-titlebar:coachmark-displaced', handler)
    return () => ipcRenderer.removeListener('comfy-titlebar:coachmark-displaced', handler)
  },
  ready: () => {
    ipcRenderer.send('comfy-window:title-bar-ready')
  }
}

const api = buildElectronApi()

if (process.contextIsolated) {
  contextBridge.exposeInMainWorld('__comfyTitleBar', bridge)
  contextBridge.exposeInMainWorld('api', api)
} else {
  ;(globalThis as Record<string, unknown>).__comfyTitleBar = bridge
  ;(globalThis as Record<string, unknown>).api = api
}
