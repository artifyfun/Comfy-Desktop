import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFromId, mockGetInjectSource } = vi.hoisted(() => ({
  mockFromId: vi.fn(),
  mockGetInjectSource: vi.fn(() => 'window.__artifyTest = 1')
}))

vi.mock('electron', () => ({
  // `default` export: artifylab/services/batchRunner does `import electron
  // from 'electron'` (pulled in transitively via ../artifylab -> showArtifyLab);
  // without a default export vitest fails the module load before any test runs.
  default: {},
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
    getAppPath: () => '/app',
    getVersion: () => '0.0.0-test',
    getLocale: () => 'en'
  },
  ipcMain: { handle: vi.fn(), on: vi.fn(), off: vi.fn() },
  dialog: {},
  shell: {},
  WebContentsView: class {},
  BrowserWindow: { getAllWindows: () => [] },
  nativeTheme: { on: vi.fn(), shouldUseDarkColors: false },
  webFrameMain: { fromId: mockFromId }
}))

vi.mock('./comfyInject', () => ({
  getComfyInjectScriptSource: mockGetInjectSource
}))

vi.mock('../artifylab/panelMode', () => ({
  getArtifyPanelUrl: () => 'http://localhost:5000'
}))

import { _runningSessions } from '../lib/ipc/shared'
import {
  comfyWindows,
  computeBodyMode,
  indexInstallationId,
  nextWindowKey,
  type ComfyWindowEntry
} from './registry'
import {
  injectPlaygroundScriptIfMatch,
  prewarmAttachedPanel,
  refreshComfyTabBody,
  setActivePanel
} from './panelView'

interface FakeWindow {
  destroyed: boolean
  focused: boolean
  isDestroyed: () => boolean
  isFocused: () => boolean
}

function makeWindow(opts: { destroyed?: boolean; focused?: boolean } = {}): FakeWindow {
  const win: FakeWindow = {
    destroyed: opts.destroyed ?? false,
    focused: opts.focused ?? false,
    isDestroyed: () => win.destroyed,
    isFocused: () => win.focused
  }
  return win
}

interface FakeWebContents {
  destroyed: boolean
  sent: { channel: string; args: unknown[] }[]
  loaded: Array<['url', string] | ['file', string]>
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  focus: () => void
  isLoadingMainFrame: () => boolean
  loadURL: (url: string) => Promise<void>
  loadFile: (path: string) => Promise<void>
}

function makeWc(): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: false,
    sent: [],
    loaded: [],
    isDestroyed: () => wc.destroyed,
    send: (channel, ...args) => {
      wc.sent.push({ channel, args })
    },
    focus: () => {},
    isLoadingMainFrame: () => false,
    loadURL: (url) => {
      wc.loaded.push(['url', url])
      return Promise.resolve()
    },
    loadFile: (path) => {
      wc.loaded.push(['file', path])
      return Promise.resolve()
    }
  }
  return wc
}

function makeEntry(
  opts: {
    installationId?: string | null
    activePanel?: ComfyWindowEntry['activePanel']
    panelSurface?: ComfyWindowEntry['panelSurface']
    destroyed?: boolean
  } = {}
): {
  entry: ComfyWindowEntry
  titleBarWc: FakeWebContents
  layoutCalls: number
} {
  const window = makeWindow({ destroyed: opts.destroyed })
  const titleBarWc = makeWc()
  const counters = { layout: 0 }
  const entry: ComfyWindowEntry = {
    windowKey: nextWindowKey(),
    window: window as unknown as ComfyWindowEntry['window'],
    comfyView: { webContents: makeWc() } as unknown as ComfyWindowEntry['comfyView'],
    titleBarView: { webContents: titleBarWc } as unknown as ComfyWindowEntry['titleBarView'],
    panelView: null,
    activePanel: opts.activePanel ?? 'comfy',
    lastTheme: { bg: '#000', text: '#fff' },
    layoutViews: () => {
      counters.layout += 1
    },
    comfyUrl: '',
    installationId: opts.installationId ?? null,
    constructedPartition: null,
    firstUseMode: 'none',
    titleBarText: '',
    sourceCategory: null,
    previewInstallationId: null,
    coldStartPendingReveal: false,
    _installCleanup: null,
    detachInstall: () => {},
    panelSurface: opts.panelSurface ?? 'chooser',
    surfaceBeforeOverlay: null
  }
  return {
    entry,
    titleBarWc,
    get layoutCalls(): number {
      return counters.layout
    }
  }
}

beforeEach(() => {
  comfyWindows.clear()
  _runningSessions.clear()
})

afterEach(() => {
  comfyWindows.clear()
  _runningSessions.clear()
})

describe('setActivePanel', () => {
  it('no-ops when the requested panel is already active', () => {
    const fixture = makeEntry({ activePanel: 'feedback' })
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    setActivePanel(fixture.entry.windowKey, 'feedback')
    expect(fixture.layoutCalls).toBe(0)
    expect(fixture.titleBarWc.sent).toHaveLength(0)
  })

  it('no-ops when the windowKey does not resolve to an entry', () => {
    expect(() => setActivePanel(999_999, 'feedback')).not.toThrow()
  })

  it('no-ops when the host window has been destroyed', () => {
    const fixture = makeEntry({ activePanel: 'comfy', destroyed: true })
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    setActivePanel(fixture.entry.windowKey, 'feedback')
    expect(fixture.layoutCalls).toBe(0)
    expect(fixture.entry.activePanel).toBe('comfy')
  })

  // After a chooser-pick in-place attach the picker leaves the host on
  // 'progress'; prewarmAttachedPanel must reset it to 'comfy' so the rebuilt
  // panel stays hidden instead of covering the just-attached canvas.
  it('prewarms the attached panel hidden by resetting a progress host to comfy', () => {
    const fixture = makeEntry({ installationId: 'inst-A', activePanel: 'progress' })
    // A pre-set panelView makes the real ensurePanelView short-circuit, so the
    // helper runs without constructing an Electron WebContentsView.
    fixture.entry.panelView = {
      webContents: makeWc()
    } as unknown as ComfyWindowEntry['panelView']
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-A', fixture.entry.windowKey)
    _runningSessions.set('inst-A', {} as never)

    expect(computeBodyMode(fixture.entry), 'starts stranded on progress').toBe('progress')

    prewarmAttachedPanel(fixture.entry)

    expect(fixture.entry.activePanel).toBe('comfy')
    expect(computeBodyMode(fixture.entry), 'panel hidden, ComfyUI visible').toBe('comfy')
    expect(fixture.layoutCalls, 'the prewarm lays the views out').toBeGreaterThan(0)
  })

  // Overlay modals (feedback / mcp-setup / announcement) are rendered by the
  // native panel app. When the panelView hosts the A UI (panelSurface='artify'),
  // opening an overlay must navigate the panelView to the native panel body —
  // otherwise the modal would resolve to the A UI surface (unwanted A/C switch).
  it('navigates the panel body to the native app when an overlay opens over the A UI surface', () => {
    const fixture = makeEntry({ installationId: 'inst-A', panelSurface: 'artify' })
    fixture.entry.panelView = {
      webContents: makeWc()
    } as unknown as ComfyWindowEntry['panelView']
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-A', fixture.entry.windowKey)
    _runningSessions.set('inst-A', {} as never)

    setActivePanel(fixture.entry.windowKey, 'mcp-setup')

    expect(fixture.entry.surfaceBeforeOverlay).toBe('artify')
    expect(fixture.entry.activePanel).toBe('mcp-setup')
    const pv = fixture.entry.panelView as unknown as { webContents: FakeWebContents }
    // The native panel body is a local file, never the A UI URL.
    expect(pv.webContents.loaded.some(([kind]) => kind === 'file')).toBe(true)
    expect(pv.webContents.loaded.some(([kind]) => kind === 'url')).toBe(false)
  })

  it('restores the A UI surface when the overlay closes', () => {
    const fixture = makeEntry({
      installationId: 'inst-A',
      activePanel: 'mcp-setup',
      panelSurface: 'artify'
    })
    fixture.entry.surfaceBeforeOverlay = 'artify'
    fixture.entry.panelView = {
      webContents: makeWc()
    } as unknown as ComfyWindowEntry['panelView']
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-A', fixture.entry.windowKey)
    _runningSessions.set('inst-A', {} as never)

    setActivePanel(fixture.entry.windowKey, 'comfy')

    expect(fixture.entry.surfaceBeforeOverlay).toBeNull()
    const pv = fixture.entry.panelView as unknown as { webContents: FakeWebContents }
    // Back to the A UI URL (panelSurface stayed 'artify').
    expect(pv.webContents.loaded.some(([kind]) => kind === 'url')).toBe(true)
    expect(pv.webContents.loaded.some(([kind]) => kind === 'file')).toBe(false)
  })

  it('leaves the panelView untouched when the surface is the native chooser', () => {
    const fixture = makeEntry({ installationId: 'inst-A', panelSurface: 'chooser' })
    fixture.entry.panelView = {
      webContents: makeWc()
    } as unknown as ComfyWindowEntry['panelView']
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-A', fixture.entry.windowKey)
    _runningSessions.set('inst-A', {} as never)

    setActivePanel(fixture.entry.windowKey, 'announcement')

    expect(fixture.entry.surfaceBeforeOverlay).toBeNull()
    const pv = fixture.entry.panelView as unknown as { webContents: FakeWebContents }
    // The native panel app is already the host; no navigation is needed.
    expect(pv.webContents.loaded).toHaveLength(0)
  })
})

describe('injectPlaygroundScriptIfMatch', () => {
  const playgroundUrl = 'http://localhost:8188/?artify_inject=readonly&artify_playground=true'

  beforeEach(() => {
    mockFromId.mockReset()
    mockGetInjectSource.mockClear()
  })

  it('ignores non-playground URLs without resolving the frame', () => {
    injectPlaygroundScriptIfMatch('about:blank', 1, 2)
    expect(mockFromId).not.toHaveBeenCalled()
  })

  it('no-ops when the frame no longer resolves (disposed cross-process swap)', () => {
    mockFromId.mockReturnValue(undefined)
    expect(() => injectPlaygroundScriptIfMatch(playgroundUrl, 1, 2)).not.toThrow()
  })

  it('no-ops when the resolved frame is already detached', () => {
    const executeJavaScript = vi.fn()
    mockFromId.mockReturnValue({ detached: true, executeJavaScript })
    injectPlaygroundScriptIfMatch(playgroundUrl, 1, 2)
    expect(executeJavaScript).not.toHaveBeenCalled()
  })

  it('injects the playground script into a live subframe', () => {
    const executeJavaScript = vi.fn().mockResolvedValue(undefined)
    mockFromId.mockReturnValue({ detached: false, executeJavaScript })
    injectPlaygroundScriptIfMatch(playgroundUrl, 7, 9)
    expect(mockFromId).toHaveBeenCalledWith(7, 9)
    expect(executeJavaScript).toHaveBeenCalledWith('window.__artifyTest = 1')
  })

  it('swallows a synchronous throw from a frame that dies mid-call', () => {
    const executeJavaScript = vi.fn(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed')
    })
    mockFromId.mockReturnValue({ detached: false, executeJavaScript })
    expect(() => injectPlaygroundScriptIfMatch(playgroundUrl, 1, 2)).not.toThrow()
  })
})

describe('refreshComfyTabBody', () => {
  it('no-ops when the install id does not resolve to an entry', () => {
    expect(() => refreshComfyTabBody('does-not-exist')).not.toThrow()
  })

  it('no-ops when the host window is destroyed', () => {
    const fixture = makeEntry({ installationId: 'inst-1', destroyed: true })
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-1', fixture.entry.windowKey)
    refreshComfyTabBody('inst-1')
    expect(fixture.layoutCalls).toBe(0)
  })

  it('no-ops when the entry is currently parked on a non-comfy panel', () => {
    const fixture = makeEntry({ installationId: 'inst-1', activePanel: 'feedback' })
    comfyWindows.set(fixture.entry.windowKey, fixture.entry)
    indexInstallationId('inst-1', fixture.entry.windowKey)
    refreshComfyTabBody('inst-1')
    // No layout pass since the entry isn't on the comfy pill.
    expect(fixture.layoutCalls).toBe(0)
  })
})
