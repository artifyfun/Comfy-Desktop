import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockFromId, mockGetInjectSource } = vi.hoisted(() => ({
  mockFromId: vi.fn(),
  mockGetInjectSource: vi.fn(() => 'window.__artifyTest = 1')
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: () => '/tmp',
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

import { _runningSessions } from '../lib/ipc/shared'
import { comfyWindows, indexInstallationId, nextWindowKey, type ComfyWindowEntry } from './registry'
import { injectPlaygroundScriptIfMatch, refreshComfyTabBody, setActivePanel } from './panelView'

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
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  focus: () => void
  isLoadingMainFrame: () => boolean
}

function makeWc(): FakeWebContents {
  const wc: FakeWebContents = {
    destroyed: false,
    sent: [],
    isDestroyed: () => wc.destroyed,
    send: (channel, ...args) => {
      wc.sent.push({ channel, args })
    },
    focus: () => {},
    isLoadingMainFrame: () => false
  }
  return wc
}

function makeEntry(
  opts: {
    installationId?: string | null
    activePanel?: ComfyWindowEntry['activePanel']
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
    panelSurface: 'chooser'
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
