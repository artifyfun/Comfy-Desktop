import { EventEmitter } from 'events'
import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import { _runningSessions, _isStopping, noteStartWindowClosed } from '../lib/ipc/shared'
import type { FirstUseMode } from '../../shared/firstUseMode'
import { isLocalInstall } from './localInstall'
import { normaliseCategory, viewKindFor } from '../../shared/viewKind'
import type { ViewKind } from '../../shared/viewKind'
import { visibleSurfaceOf } from '../../shared/visibleSurface'

export const hostInstallEvents = new EventEmitter()

export type ComfyPanelKey =
  | 'comfy'
  | 'performance-test'
  | 'benchmarks'
  | 'feedback'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'progress'
  /** Single-window mode: the panel body hosts the A UI / install picker
   *  ("Comfy pill → chooser" is the install-less mapping; this is the same
   *  surface as an explicit panel key so `setActivePanel` can flip back to
   *  the A UI from an install-backed window). */
  | 'chooser'
  /** Overlay mode (like `'feedback'`): the MCP setup modal mounts over the live
   *  canvas, which stays visible underneath and dimmed. Set programmatically. */
  | 'mcp-setup'

export const VALID_PANELS: ReadonlySet<ComfyPanelKey> = new Set([
  'comfy',
  'performance-test',
  'benchmarks',
  'feedback',
  'new-install',
  'track',
  'load-snapshot',
  'progress',
  'chooser',
  'mcp-setup'
])

/**
 * Overlay bodies (feedback / mcp-setup / announcement) are rendered by the
 * native panel app (PanelApp.vue), never by the A UI frontend. Single source
 * of truth for that set — panelView's loadPanelContent / setActivePanel /
 * isOverlayPanel call sites all read this predicate so a new overlay key
 * can't be added to the type without this decision point lighting up.
 */
export const OVERLAY_PANELS: ReadonlySet<string> = new Set([
  'feedback',
  'mcp-setup',
  'announcement'
])

export function isOverlayPanel(p: string): boolean {
  return OVERLAY_PANELS.has(p)
}

export type BodyMode =
  | 'comfy'
  | 'comfy-lifecycle'
  | 'feedback'
  | 'chooser'
  | 'performance-test'
  | 'benchmarks'
  | 'progress'
  | 'new-install'
  | 'track'
  | 'load-snapshot'
  | 'mcp-setup'

export interface ComfyWindowEntry {
  windowKey: number
  window: BrowserWindow
  comfyView: WebContentsView
  titleBarView: WebContentsView
  panelView: WebContentsView | null
  activePanel: ComfyPanelKey
  pendingOverlayReveal?: boolean
  overlayRevealTimer?: ReturnType<typeof setTimeout>

  lastTheme: { bg: string; text: string }
  layoutViews: () => void
  comfyUrl: string
  installationId: string | null
  constructedPartition: string | null
  firstUseMode: FirstUseMode
  titleBarText: string
  sourceCategory: string | null
  previewInstallationId: string | null
  coldStartPendingReveal: boolean
  maximizeOnReveal?: boolean
  _installCleanup: (() => void) | null
  /** What the panelView currently hosts: the A UI (artifylab frontend, single-
   *  window mode) or the native chooser/panel app. `setPanelSurface` navigates
   *  between them; `ensurePanelView` (re)builds to whichever is current. */
  panelSurface: 'artify' | 'chooser'
  /** While an overlay modal (feedback / mcp-setup / announcement) is open over
   *  the A UI surface, remembers the surface so `setActivePanel` can navigate
   *  the panelView back to the A UI when the overlay closes. `null` when the
   *  panel is hosting the native chooser/panel app or no overlay is pending. */
  surfaceBeforeOverlay: 'artify' | null
  /** While an overlay is open, records which body the user was on when it
   *  opened ('chooser' = A UI visible, 'comfy' = C canvas visible). Drives
   *  closeCurrentPanel (restore to the right surface) and layoutViews (whether
   *  the C canvas stays visible under the overlay). `undefined` when no overlay
   *  is pending. `surfaceBeforeOverlay` alone can't tell these apart: the C
   *  canvas with a hidden A UI panel also carries panelSurface='artify'. */
  overlayFromChooser?: boolean
  detachInstall: () => void
}

/**
 * 用户实际看到的表面（'comfy' = C 画布可见，'artify' = panelView 可见）。
 * 单一判定源（src/shared/visibleSurface.ts）：titlebar 高亮语义、set-surface
 * backstop、devtools 路由都必须走这里，禁止再手写 `activePanel==='comfy'
 * && panelSurface!==…` 式的局部公式——2026-08 的 A/C 倒挂死锁正是公式
 * 分裂的产物。
 */
export function visibleSurface(entry: ComfyWindowEntry): 'artify' | 'comfy' | 'chooser' {
  return visibleSurfaceOf({ panelSurface: entry.panelSurface, activePanel: entry.activePanel })
}

export const comfyWindows = new Map<number, ComfyWindowEntry>()
const installationIdToWindowKey = new Map<string, number>()

let lastFocusedInstallationId: string | null = null
export function getLastFocusedInstallationId(): string | null {
  return lastFocusedInstallationId
}
export function setLastFocusedInstallationId(id: string | null): void {
  lastFocusedInstallationId = id
}

const pendingAttachClaims = new Map<string, number>()

export function claimAttachHost(installationId: string, windowKey: number): void {
  pendingAttachClaims.set(installationId, windowKey)
}

export function consumeAttachClaim(installationId: string): number | undefined {
  const key = pendingAttachClaims.get(installationId)
  if (key === undefined) return undefined
  pendingAttachClaims.delete(installationId)
  return key
}

export function dropAttachClaimsForWindow(windowKey: number): void {
  for (const [installationId, claimedKey] of pendingAttachClaims) {
    if (claimedKey !== windowKey) continue
    pendingAttachClaims.delete(installationId)
    noteStartWindowClosed(installationId)
  }
}

export function _resetAttachClaimsForTest(): void {
  pendingAttachClaims.clear()
}

let _nextWindowKeyValue = 0
export function nextWindowKey(): number {
  return ++_nextWindowKeyValue
}

export function getEntryByInstallationId(installationId: string): ComfyWindowEntry | undefined {
  const key = installationIdToWindowKey.get(installationId)
  return key === undefined ? undefined : comfyWindows.get(key)
}

function isInstallationShownInWindow(installationId: string): boolean {
  if (pendingAttachClaims.has(installationId)) return true
  for (const entry of comfyWindows.values()) {
    if (entry.window.isDestroyed()) continue
    if (entry.installationId === installationId) return true
    if (entry.previewInstallationId === installationId) return true
  }
  return false
}

export function unhostedLaunches(launchingInstallationIds: readonly string[]): string[] {
  return launchingInstallationIds.filter((id) => !isInstallationShownInWindow(id))
}

export function canRestartFromPicker(
  parentEntry: ComfyWindowEntry,
  installationId: string,
  launchingInstallationIds: readonly string[]
): boolean {
  const boundInstallationId = parentEntry.installationId ?? parentEntry.previewInstallationId
  if (boundInstallationId != null) return boundInstallationId === installationId
  return unhostedLaunches(launchingInstallationIds).includes(installationId)
}

export function indexInstallationId(installationId: string, windowKey: number): void {
  installationIdToWindowKey.set(installationId, windowKey)
  hostInstallEvents.emit('changed')
}

export function dropInstallationIndex(installationId: string): void {
  const had = installationIdToWindowKey.delete(installationId)
  if (had) hostInstallEvents.emit('changed')
}

export function registerHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.set(entry.windowKey, entry)
  if (entry.installationId !== null) {
    installationIdToWindowKey.set(entry.installationId, entry.windowKey)
    hostInstallEvents.emit('changed')
  }
}

export function unregisterHostEntry(entry: ComfyWindowEntry): void {
  comfyWindows.delete(entry.windowKey)
  if (entry.installationId !== null) {
    const indexed = installationIdToWindowKey.get(entry.installationId)
    if (indexed === entry.windowKey) {
      installationIdToWindowKey.delete(entry.installationId)
      hostInstallEvents.emit('changed')
    }
  }
}

export function isChooserHost(
  entry: ComfyWindowEntry
): entry is ComfyWindowEntry & { installationId: null } {
  return entry.installationId === null
}

export function isInstallHost(
  entry: ComfyWindowEntry
): entry is ComfyWindowEntry & { installationId: string } {
  return entry.installationId !== null
}

export function shouldConfirmKillForEntry(
  entry: ComfyWindowEntry | null | undefined
): entry is ComfyWindowEntry & { installationId: string } {
  return isLocalInstall(entry)
}

export function hasRunningSessionForEntry(
  entry: ComfyWindowEntry | null | undefined
): entry is ComfyWindowEntry & { installationId: string } {
  return !!entry && isInstallHost(entry) && _runningSessions.has(entry.installationId)
}

export function computeBodyMode(entry: ComfyWindowEntry): BodyMode {
  if (entry.installationId === null) {
    return entry.activePanel === 'comfy' ? 'chooser' : entry.activePanel
  }
  if (entry.activePanel !== 'comfy') return entry.activePanel
  if (_isStopping(entry.installationId)) return 'comfy-lifecycle'
  return _runningSessions.has(entry.installationId) ? 'comfy' : 'comfy-lifecycle'
}

export function computeViewKind(entry: ComfyWindowEntry): ViewKind {
  return viewKindFor(entry.installationId, normaliseCategory(entry.sourceCategory))
}

export function findEntryByTitleBarSender(
  wc: WebContents
): { id: number; entry: ComfyWindowEntry } | null {
  for (const [id, entry] of comfyWindows) {
    if (entry.titleBarView.webContents === wc) return { id, entry }
  }
  return null
}

export function isPanelSender(wc: WebContents): boolean {
  for (const entry of comfyWindows.values()) {
    if (entry.panelView?.webContents === wc) return true
  }
  return false
}

export function findHostWindowByPanelSender(wc: WebContents): BrowserWindow | null {
  for (const entry of comfyWindows.values()) {
    if (entry.panelView?.webContents === wc) return entry.window
  }
  return null
}

export function findEntryByComfySender(wc: WebContents): ComfyWindowEntry | null {
  for (const entry of comfyWindows.values()) {
    if (entry.comfyView.webContents === wc) return entry
  }
  return null
}

export function findInstallationIdByComfySender(wc: WebContents): string | null {
  return findEntryByComfySender(wc)?.installationId ?? null
}

export function findEntryByHostWindow(window: BrowserWindow): ComfyWindowEntry | null {
  for (const entry of comfyWindows.values()) {
    if (entry.window === window) return entry
  }
  return null
}

export function findPreferredHostByVisibility(
  pred: (entry: ComfyWindowEntry) => boolean
): ComfyWindowEntry | null {
  let minimisedFallback: ComfyWindowEntry | null = null
  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed() || !pred(entry)) continue
    if (!entry.window.isMinimized()) return entry
    if (minimisedFallback === null) minimisedFallback = entry
  }
  return minimisedFallback
}

export function findPreferredChooserHostWindow(): BrowserWindow | null {
  const entry = findPreferredHostByVisibility((e) => e.installationId === null)
  return entry?.window ?? null
}

export function findPreferredInstallHostWindow(): BrowserWindow | null {
  const mruEntry =
    lastFocusedInstallationId !== null
      ? getEntryByInstallationId(lastFocusedInstallationId)
      : undefined
  const mruAlive = mruEntry && !mruEntry.window.isDestroyed() ? mruEntry : null
  const fallback = findPreferredHostByVisibility((e) => e.installationId !== null)
  if (mruAlive && !mruAlive.window.isMinimized()) return mruAlive.window
  if (fallback && !fallback.window.isMinimized()) return fallback.window
  if (mruAlive) return mruAlive.window
  return fallback?.window ?? null
}

export function maximizeIfPendingReveal(win: BrowserWindow): void {
  const entry = findEntryByHostWindow(win)
  if (!entry?.maximizeOnReveal) return
  entry.maximizeOnReveal = false
  win.maximize()
}

export function bringToFront(win: BrowserWindow): void {
  if (win.isMinimized()) win.restore()
  maximizeIfPendingReveal(win)
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true)
    win.show()
    win.focus()
    win.setAlwaysOnTop(false)
  } else {
    win.show()
    win.focus()
  }
}

export function revealColdStartHostIfPending(windowKey: number): void {
  const entry = comfyWindows.get(windowKey)
  if (!entry?.coldStartPendingReveal || entry.window.isDestroyed()) return
  entry.coldStartPendingReveal = false
  entry.layoutViews()
  bringToFront(entry.window)
}

interface HostFactories {
  createChooser: () => BrowserWindow
}
let hostFactories: HostFactories | null = null
export function setHostFactories(factories: HostFactories): void {
  hostFactories = factories
}
function requireChooserFactory(): () => BrowserWindow {
  if (!hostFactories) {
    throw new Error('host registry: setHostFactories() must be called before openOrFocus*')
  }
  return hostFactories.createChooser
}

export function openOrFocusChooserHostWindow(): BrowserWindow {
  const existing = findPreferredChooserHostWindow()
  if (existing) {
    bringToFront(existing)
    return existing
  }
  return requireChooserFactory()()
}

function isHandingOffToBuild(entry: ComfyWindowEntry): boolean {
  if (entry.previewInstallationId !== null) return true
  for (const claimedKey of pendingAttachClaims.values()) {
    if (claimedKey === entry.windowKey) return true
  }
  return false
}

export function isHomeHostEntry(entry: ComfyWindowEntry): boolean {
  return !entry.window.isDestroyed() && isChooserHost(entry) && !isHandingOffToBuild(entry)
}

function findHomeHostWindow(): BrowserWindow | null {
  return findPreferredHostByVisibility(isHomeHostEntry)?.window ?? null
}

export function openOrFocusHomeHostWindow(): BrowserWindow {
  const existing = findHomeHostWindow()
  if (existing) {
    bringToFront(existing)
    return existing
  }
  return requireChooserFactory()()
}

export type BuildOpenRoute =
  | { kind: 'focus'; entry: ComfyWindowEntry }
  | { kind: 'start-from'; entry: ComfyWindowEntry }
  | { kind: 'start-from-home' }
  | { kind: 'show-starting'; entry: ComfyWindowEntry | null }
  | { kind: 'ignore' }

function findWindowForBuild(installationId: string): ComfyWindowEntry | undefined {
  const hosted = getEntryByInstallationId(installationId)
  if (hosted && !hosted.window.isDestroyed()) return hosted
  const claimedKey = pendingAttachClaims.get(installationId)
  const claimed = claimedKey === undefined ? undefined : comfyWindows.get(claimedKey)
  return claimed && !claimed.window.isDestroyed() ? claimed : undefined
}

export function routeBuildOpen(
  installationId: string,
  requester: ComfyWindowEntry | undefined,
  launchingInstallationIds: readonly string[]
): BuildOpenRoute {
  const own = findWindowForBuild(installationId)
  if (own) return { kind: 'focus', entry: own }
  if (requester?.installationId === installationId) return { kind: 'ignore' }
  const homeRequester = requester && isHomeHostEntry(requester) ? requester : null
  if (launchingInstallationIds.includes(installationId)) {
    return { kind: 'show-starting', entry: homeRequester }
  }
  if (homeRequester) return { kind: 'start-from', entry: homeRequester }
  return { kind: 'start-from-home' }
}

export function openOrFocusAnyHostWindow(): BrowserWindow {
  const installWin = findPreferredInstallHostWindow()
  if (installWin) {
    bringToFront(installWin)
    return installWin
  }
  const chooser = findPreferredChooserHostWindow()
  if (chooser) {
    bringToFront(chooser)
    return chooser
  }
  return requireChooserFactory()()
}

export function raiseAllHostWindows(): BrowserWindow {
  const preferred = findPreferredInstallHostWindow() ?? findPreferredChooserHostWindow()
  if (!preferred) return requireChooserFactory()()

  for (const [, entry] of comfyWindows) {
    if (entry.window.isDestroyed() || entry.window === preferred) continue
    bringToFront(entry.window)
  }
  bringToFront(preferred)
  return preferred
}
