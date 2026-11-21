<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowDownToLine, Bell, House, Menu as MenuIcon, RotateCw, ZoomIn } from '@lucide/vue'
import { useTitleBarTooltip } from './useTitleBarTooltip'
import { useTitleBarMenus } from './useTitleBarMenus'
import { useTitleBarIdentity } from './useTitleBarIdentity'
import { useTitleBarHoverGate } from './useTitleBarHoverGate'
import { useBetaActivationNotice } from './useBetaActivationNotice'
import { useAppLocale, windowApiLocaleSource } from '../lib/useAppLocale'
import { visibleSurfaceOf } from '../../../shared/visibleSurface'
import ComfyCLogo from '../components/icons/ComfyCLogo.vue'
import artifyLogoUrl from '../assets/artify-logo.png'

const { t } = useI18n()
const { syncLocale } = useAppLocale(windowApiLocaleSource())

type ComfyPanelKey =
  | 'comfy'
  | 'performance-test'
  | 'benchmarks'
  /** Single-window mode: the panel body hosts the A UI / install picker.
   *  Pushed by main on C→A surface flips and used by the A/C switch to
   *  re-wake the warm A panel after an A→C flip. */
  | 'chooser'
  | 'new-install'
  | 'track'
  | 'load-snapshot'

type CoachmarkKind = 'beta-notice'

interface MenuAnchor {
  x: number
  y: number
}

interface DownloadsTrayEntry {
  url: string
  filename: string
  directory?: string
  progress: number
  status: 'pending' | 'downloading' | 'paused' | 'completed' | 'error' | 'cancelled'
  error?: string
}

interface DownloadsTrayState {
  active: DownloadsTrayEntry[]
  recent: DownloadsTrayEntry[]
}

interface Bridge {
  getInstallationId: () => string | null
  isMac: () => boolean
  isLinux: () => boolean
  setPanel: (panel: ComfyPanelKey) => void
  /** Title-bar A/C switch, C→A direction — see ComfyTitleBarBridge. */
  setSurface: (surface: 'artify' | 'chooser') => void
  /** Cold-boot surface seed from the `surface` query param. */
  getSurface: () => 'artify' | 'chooser'
  openNewWindow: () => void
  openFileMenu: (anchor: MenuAnchor) => void
  dismissFileMenu: () => void
  showTooltip: (payload: { text: string; leftX: number; rightX: number; bottomY: number }) => void
  hideTooltip: () => void
  showCoachmark: (payload: {
    kind?: CoachmarkKind
    title: string
    body: string
    dismissLabel: string
    actionLabel?: string
    leftX: number
    rightX: number
    bottomY: number
  }) => void
  hideCoachmark: () => void
  onCoachmarkDismissed: (cb: (payload: { kind: CoachmarkKind }) => void) => () => void
  onCoachmarkAction: (cb: (payload: { kind: CoachmarkKind }) => void) => () => void
  onCoachmarkAutoHidden: (cb: (payload: { kind: CoachmarkKind }) => void) => () => void
  onCoachmarkSettled: (cb: (payload: { kind: CoachmarkKind }) => void) => () => void
  onCoachmarkDisplaced: (cb: (payload: { kind: CoachmarkKind }) => void) => () => void
  onPanelChanged: (cb: (panel: ComfyPanelKey) => void) => () => void
  onBodyModeChanged: (cb: (mode: string) => void) => () => void
  onSurfaceChanged: (cb: (surface: 'artify' | 'chooser') => void) => () => void
  onTitleChanged: (cb: (title: string) => void) => () => void
  onSourceCategoryChanged: (cb: (category: string | null) => void) => () => void
  onZoomChanged: (cb: (level: number) => void) => () => void
  onThemeChanged: (cb: (theme: { bg: string; text: string }) => void) => () => void
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void
  onMenuOpened: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  onMenuClosed: (cb: (info: { menu: 'menu' | 'downloads' }) => void) => () => void
  onFirstUseModeChanged: (
    cb: (mode: 'none' | 'consent-lockdown' | 'post-consent') => void
  ) => () => void
  onPreviewModeChanged: (cb: (preview: boolean) => void) => () => void
  onInstallationIdChanged: (cb: (installationId: string | null) => void) => () => void
  onAppUpdateStateChanged: (
    cb: (state: {
      kind: 'available' | 'downloading' | 'ready' | null
      version: string | null
      autoUpdate: boolean
    }) => void
  ) => () => void
  onInstallUpdateAvailable: (
    cb: (state: { available: boolean; version: string | null }) => void
  ) => () => void
  clickAppUpdatePill: () => void
  clickInstallUpdatePill: () => void
  onDownloadsChanged: (cb: (state: DownloadsTrayState) => void) => () => void
  clickDownloadsTray: (anchor: MenuAnchor) => void
  clickFeedback: () => void
  openWhatsNewMenu: (anchor: { x: number; y: number }) => void
  clickRefreshInstance: () => void
  clickHome: () => void
  resetZoom: () => void
  ready: () => void
}

const bridge = (window as unknown as { __comfyTitleBar?: Bridge }).__comfyTitleBar

const titleMenuButtonClass =
  '[-webkit-app-region:no-drag] inline-flex items-center gap-0 rounded-[4px] border border-solid border-transparent bg-transparent px-1.5 py-1 [font:inherit] text-[var(--titlebar-icon)] opacity-85 cursor-pointer transition-[background-color,opacity,border-color] duration-[120ms] ease-[ease] [.title-bar:not(.is-light)_&]:rounded-control [.title-bar.is-hover-active_&]:hover:opacity-100 [.title-bar.is-hover-active_&]:hover:bg-[rgba(255,255,255,0.08)] [.title-bar.is-hover-active_&]:hover:border-[rgba(255,255,255,0.18)] [.title-bar.is-light.is-hover-active_&]:hover:bg-[rgba(0,0,0,0.06)] [.title-bar.is-light.is-hover-active_&]:hover:border-[rgba(0,0,0,0.18)] [.title-bar.is-hover-active:not(.is-light)_&]:hover:bg-secondary [.title-bar.is-hover-active:not(.is-light)_&]:hover:border-transparent'

const titleInstallPillClass = [
  '[-webkit-app-region:no-drag] inline-flex h-7 items-center gap-2 [inline-size:fit-content] [min-inline-size:200px] [max-inline-size:clamp(200px,22cqi,360px)] rounded-[999px] border border-solid border-transparent bg-[var(--chooser-surface-bg)] py-[5px] pr-2.5 pl-3 [font-family:inherit] text-[12px] leading-[inherit] font-normal text-neutral-100 cursor-default transition-[background-color,border-color,color] duration-[120ms] ease-[ease]',
  '[.title-bar.is-light_&]:bg-[rgba(0,0,0,0.04)] [.title-bar.is-light_&]:text-neutral-700',
  '[.title-bar:not(.is-light)_&]:border-border [.title-bar:not(.is-light)_&]:bg-[oklch(1_0_0/0.04)] [.title-bar:not(.is-light)_&]:text-text-muted'
].join(' ')

const titleHomeButtonClass =
  '[-webkit-app-region:no-drag] inline-flex h-7 shrink-0 items-center gap-2 rounded-control border border-solid border-transparent bg-transparent py-0 pr-2.5 pl-2 [font-family:inherit] text-[13px] leading-5 font-normal text-[var(--titlebar-icon)] opacity-85 cursor-pointer transition-[background-color,opacity] duration-[120ms] ease-[ease] [.title-bar.is-hover-active_&]:hover:opacity-100 [.title-bar.is-hover-active_&]:hover:bg-secondary [.title-bar.is-light.is-hover-active_&]:hover:bg-[rgba(0,0,0,0.06)] focus-visible:outline-2 focus-visible:[outline-style:solid] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-1'

const titleDownloadsBadgeClass =
  'pointer-events-none absolute -top-1 -right-1 inline-flex h-3.5 min-w-3.5 items-center justify-center rounded-[999px] bg-[var(--action,#60a5fa)] px-1 py-0 text-[9px] leading-none font-bold text-white tabular-nums [box-shadow:0_0_0_2px_var(--titlebar-bg-active,var(--titlebar-bg,var(--neutral-900)))] [.title-bar:not(.is-light)_&:not(.is-unseen,.is-error)]:text-background [.title-bar.is-light_&:not(.is-unseen,.is-error)]:bg-[var(--titlebar-icon)] [.title-bar.is-light_&:not(.is-unseen,.is-error)]:text-[var(--titlebar-bg-active)] [&.is-unseen]:bg-[#22c55e] [&.is-error]:bg-[var(--danger)] [.title-downloads-tray.has-active_&]:animate-[title-downloads-pulse_1.6s_ease-in-out_infinite] [.title-downloads-tray.is-flashing_&]:[animation:title-downloads-flash_0.55s_cubic-bezier(0.2,0.9,0.3,1.4)_1,title-downloads-pulse_1.6s_ease-in-out_infinite_0.6s]'

const isMac = ref(bridge?.isMac() ?? false)
const isLinux = ref(bridge?.isLinux() ?? false)
const activePanel = ref<ComfyPanelKey>('comfy')
/**
 * PanelView surface — `'artify'` when the panel body hosts the Artify
 * A UI, `'chooser'` when it hosts the native panel app. Seeded from the
 * URL `surface` query param (cold boot) and kept live via
 * `onSurfaceChanged` pushes from main (float-button flips,
 * attach/detach, and this switch's own C→A handler). Drives the A/C
 * segmented switch next to the center pill.
 */
const surface = ref<'artify' | 'chooser'>(bridge?.getSurface() ?? 'chooser')
/**
 * 可见表面：A 段高亮要求 A UI 面板真正是当前面板体。A→C 切换后主进程
 * 故意保留 panelSurface='artify'（A UI 暖面板继续驻留 panelView，仅隐藏），
 * 所以裸 surface 标志在 C 画布可见时仍是 'artify'——直接拿它驱动高亮会
 * 倒挂。可见性公式 = src/shared/visibleSurface.ts 单源。
 */
const artifyVisible = computed(
  () =>
    visibleSurfaceOf({ panelSurface: surface.value, activePanel: activePanel.value }) === 'artify'
)
/** Body mode pushed by main: 'comfy' = live ComfyUI canvas fills the body.
 *  Anything else (chooser / comfy-lifecycle) means the canvas isn't up and
 *  the A segment of the A/C switch must stay disabled. */
const bodyMode = ref<string>('chooser')
/** A segment may only be clicked once the ComfyUI canvas is live; when the
 *  A UI is already showing the segment is (visibly) the active side. */
const canSwitchToArtify = computed(() => artifyVisible.value || bodyMode.value === 'comfy')
/** A→C: flip the body to the ComfyUI view. */
const switchToComfy = (): void => {
  if (!artifyVisible.value) return
  bridge?.setPanel('comfy')
}
/** C→A: request the Artify surface. Two sub-cases:
 *  - panelSurface 已是 'artify'（A→C 后暖面板驻留）：setPanel('chooser')
 *    把活动面板从 comfy 画布切回 A UI 面板体，不触发任何重载；
 *  - surface 仍是 'chooser'（从未进过 A）：走 setSurface 让主进程做
 *    单窗口 surface 翻转。两条路都会经 panel-changed 推送回流高亮。 */
const switchToArtify = (): void => {
  if (artifyVisible.value) return
  if (!canSwitchToArtify.value) return
  if (surface.value === 'artify') {
    bridge?.setPanel('chooser')
    return
  }
  bridge?.setSurface('artify')
}
const installationId = ref(bridge?.getInstallationId() ?? '')
const isInstallLess = ref((bridge?.getInstallationId() ?? '') === '')

const {
  installLabel,
  sourceCategory,
  themeBg,
  themeText,
  isFullscreen,
  isConsentLockdown,
  isFirstUseLockdown,
  isLoadingLockdown,
  installTypeMeta,
  installTypeLabel,
  showInstallTypeIcon,
  showBrandMark,
  isLight
} = useTitleBarIdentity({ bridge, isInstallLess })

const showRefreshButton = computed(
  () =>
    (sourceCategory.value === 'cloud' ||
      sourceCategory.value === 'remote' ||
      sourceCategory.value === 'local') &&
    !isInstallLess.value &&
    !isFirstUseLockdown.value
)

const showHomeButton = computed(() => !isInstallLess.value && !isFirstUseLockdown.value)

const zoomLevel = ref(0)
const zoomPercent = computed(() => Math.round(Math.pow(1.2, zoomLevel.value) * 100))
const showZoomReset = computed(
  () => zoomLevel.value !== 0 && !isInstallLess.value && !isFirstUseLockdown.value
)

function handleRefreshInstance(): void {
  bridge?.clickRefreshInstance()
}

function handleHome(): void {
  hideTip()
  bridge?.clickHome()
}

function handleResetZoom(): void {
  bridge?.resetZoom()
}

let unsubTourSettings: (() => void) | null = null

const BELL_NUDGE_MS = 700
const bellNudging = ref(false)
let bellNudgeTimer: ReturnType<typeof setTimeout> | null = null

function nudgeBell(): void {
  if (bellNudgeTimer) clearTimeout(bellNudgeTimer)
  bellNudging.value = true
  bellNudgeTimer = setTimeout(() => {
    bellNudging.value = false
    bellNudgeTimer = null
  }, BELL_NUDGE_MS)
}

async function nudgeBellWhenTourEnds(): Promise<void> {
  try {
    if ((await window.api?.getSetting?.('homeTourDone')) === true) nudgeBell()
  } catch {}
}

onMounted(() => {
  unsubTourSettings =
    window.api?.onSettingsChanged?.(({ key }) => {
      if (key === 'homeTourDone') void nudgeBellWhenTourEnds()
    }) ?? null
})

onUnmounted(() => {
  unsubTourSettings?.()
  if (bellNudgeTimer) clearTimeout(bellNudgeTimer)
})

const fileBtnRef = useTemplateRef<HTMLButtonElement>('fileBtn')
const downloadsBtnRef = useTemplateRef<HTMLButtonElement>('downloadsBtn')
const announcementBtnRef = useTemplateRef<HTMLButtonElement>('announcementBtn')

let unmounted = false

const { tooltipAttrs, handleTooltipPointer, hideTip } = useTitleBarTooltip({
  bridge,
  isMac
})

const { isHoverActive } = useTitleBarHoverGate({ hideTip, handleTooltipPointer })

const {
  isDownloadsOpen,
  downloadsActiveCount,
  unseenFinishedCount,
  unseenErrorCount,
  downloadsTrayLabel,
  downloadsStartedAt,
  handleFileMenu,
  handleWhatsNewMenu,
  handleDownloadsTray
} = useTitleBarMenus({
  bridge,
  hideTip,
  fileBtnRef,
  downloadsBtnRef,
  whatsNewBtnRef: announcementBtnRef
})

const betaNotice = useBetaActivationNotice({
  bridge,
  installationId: () => installationId.value,
  isInstallLess,
  isFirstUseLockdown,
  isLoadingLockdown,
  anchorRef: announcementBtnRef,
  copyFor: ({ direction, description }) => {
    const keys =
      direction === 'disabled'
        ? description
          ? (['titleBar.betaNoticeOffTitleNamed', 'titleBar.betaNoticeOffBodyNamed'] as const)
          : (['titleBar.betaNoticeOffTitle', 'titleBar.betaNoticeOffBody'] as const)
        : description
          ? (['titleBar.betaNoticeTitleNamed', 'titleBar.betaNoticeBodyNamed'] as const)
          : (['titleBar.betaNoticeTitle', 'titleBar.betaNoticeBody'] as const)
    const params = { feature: description ?? '' }
    return {
      title: t(keys[0], params),
      body: t(keys[1], params),
      dismissLabel: t('titleBar.betaNoticeDismiss'),
      actionLabel: t('titleBar.betaNoticeSettings')
    }
  }
})

function retryBetaNotice(): void {
  if (unmounted) return
  void nextTick().then(() => {
    if (!unmounted) void betaNotice.maybeShow()
  })
}

const downloadsFlash = ref(false)
let flashTimer: ReturnType<typeof setTimeout> | null = null
watch(downloadsStartedAt, (next) => {
  if (next === 0) return
  downloadsFlash.value = true
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => {
    downloadsFlash.value = false
    flashTimer = null
  }, 1600)
})

let unsubPanel: (() => void) | undefined
let unsubBodyMode: (() => void) | undefined
let unsubSurface: (() => void) | undefined
let unsubInstallationId: (() => void) | undefined
let unsubZoom: (() => void) | undefined
let unsubCoachmarkDismissed: (() => void) | undefined
let unsubCoachmarkAction: (() => void) | undefined
let unsubCoachmarkAutoHidden: (() => void) | undefined
let unsubCoachmarkSettled: (() => void) | undefined
let unsubCoachmarkDisplaced: (() => void) | undefined

onMounted(() => {
  syncLocale().catch((err) => {
    console.error('TitleBar: syncLocale failed', err)
  })

  if (!bridge) return
  unsubPanel = bridge.onPanelChanged((panel) => {
    activePanel.value = panel
  })
  // Body mode ('comfy' = live canvas) gates the A-segment of the A/C
  // switch. Start conservative ('chooser' → A disabled) until main's
  // authoritative push lands on title-bar-ready.
  unsubBodyMode = bridge.onBodyModeChanged((mode) => {
    bodyMode.value = mode
  })
  unsubSurface = bridge.onSurfaceChanged((s) => {
    surface.value = s
  })
  unsubZoom = bridge.onZoomChanged((level) => {
    zoomLevel.value = level
  })
  unsubInstallationId = bridge.onInstallationIdChanged((nextInstallationId) => {
    const previous = installationId.value
    installationId.value = nextInstallationId ?? ''
    isInstallLess.value = nextInstallationId === null
    if (previous !== installationId.value) {
      if (betaNotice.isShowing.value) {
        bridge.hideCoachmark()
        betaNotice.forgetWithoutAcknowledging()
      }
      retryBetaNotice()
    }
  })
  unsubCoachmarkDismissed = bridge.onCoachmarkDismissed(({ kind }) => {
    if (kind === 'beta-notice') void betaNotice.dismiss()
  })
  unsubCoachmarkAction = bridge.onCoachmarkAction(({ kind }) => {
    if (kind === 'beta-notice') void betaNotice.openSettings()
  })
  unsubCoachmarkAutoHidden = bridge.onCoachmarkAutoHidden(({ kind }) => {
    if (kind === 'beta-notice') betaNotice.forgetWithoutAcknowledging()
  })
  unsubCoachmarkSettled = bridge.onCoachmarkSettled(() => {
    if (!unmounted) void betaNotice.maybeShow()
  })
  unsubCoachmarkDisplaced = bridge.onCoachmarkDisplaced(({ kind }) => {
    if (kind === 'beta-notice') betaNotice.forgetWithoutAcknowledging()
  })
  bridge.ready()
})

watch(
  [isInstallLess, isFirstUseLockdown, isLoadingLockdown],
  ([installLess, lockdown, loading]) => {
    if (installLess || lockdown || loading) {
      if (betaNotice.isShowing.value) bridge?.hideCoachmark()
      return
    }
    void nextTick().then(() => {
      requestAnimationFrame(() => {
        if (!unmounted) void betaNotice.maybeShow()
      })
    })
  },
  { immediate: true }
)

onUnmounted(() => {
  unmounted = true
  unsubPanel?.()
  unsubBodyMode?.()
  unsubSurface?.()
  unsubInstallationId?.()
  unsubZoom?.()
  unsubCoachmarkDismissed?.()
  unsubCoachmarkAction?.()
  unsubCoachmarkAutoHidden?.()
  unsubCoachmarkSettled?.()
  unsubCoachmarkDisplaced?.()
  bridge?.hideCoachmark()
  hideTip()
  if (flashTimer) {
    clearTimeout(flashTimer)
    flashTimer = null
  }
})
</script>

<template>
  <header
    class="title-bar relative box-border grid h-screen w-screen grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 border-b border-solid border-current border-b-[var(--border)] bg-[var(--titlebar-bg-active,var(--titlebar-bg))] px-3 py-0 font-sans text-[12px] leading-none font-normal text-text-muted select-none [-webkit-app-region:drag] [container:title-bar_/_inline-size] [&.is-mac]:pl-[78px] [&.is-mac.is-fullscreen]:pl-3 [&:not(.is-mac,.is-linux)]:pr-[140px] [&.is-linux]:[--title-controls-left:env(titlebar-area-x,0px)] [&.is-linux]:[--title-controls-right:calc(100vw_-_env(titlebar-area-x,0px)_-_env(titlebar-area-width,100vw))] [&.is-linux]:pl-[calc(var(--title-controls-left)_+_12px)] [&.is-linux]:pr-[calc(var(--title-controls-right)_+_12px)] [&:not(.is-light)]:border-b-border [&.is-light]:border-b-[color-mix(in_srgb,var(--titlebar-icon)_16%,transparent)]"
    :class="{
      'is-mac': isMac,
      'is-linux': isLinux,
      'is-light': isLight,
      'is-fullscreen': isFullscreen,
      'is-hover-active': isHoverActive,
      'is-consent-lockdown': isConsentLockdown
    }"
    :style="{
      color: themeText ?? undefined,
      '--titlebar-bg-active': themeBg ?? undefined,
      '--titlebar-icon': themeText ?? undefined
    }"
  >
    <div class="title-cluster flex items-center gap-1">
      <button
        v-if="showHomeButton"
        type="button"
        class="title-home-button"
        :class="titleHomeButtonClass"
        @click="handleHome"
      >
        <House :size="15" aria-hidden="true" />
        <span>{{ t('titleBar.home') }}</span>
      </button>
      <div v-if="isFirstUseLockdown" class="title-install-pill" :class="titleInstallPillClass">
        <div
          class="title-install-slot title-install-slot--leading inline-flex flex-[0_0_18px] items-center justify-center"
        >
          <ComfyCLogo
            v-if="showBrandMark"
            class="title-install-brand-mark shrink-0 text-current"
            :size="16"
          />
          <component
            :is="installTypeMeta.icon"
            v-else-if="showInstallTypeIcon"
            :size="16"
            class="title-install-type-icon shrink-0 opacity-85"
            v-bind="tooltipAttrs(installTypeLabel)"
          />
        </div>
        <div
          class="title-install-slot title-install-slot--center inline-flex min-w-0 flex-auto items-center justify-center gap-1.5"
        >
          <span class="title-install-name min-w-0 truncate">{{ installLabel }}</span>
        </div>
        <div
          class="title-install-slot title-install-slot--trailing inline-flex flex-[0_0_18px] items-center justify-center"
        ></div>
      </div>
    </div>

    <div class="title-center">
      <!-- A/C surface switch (segmented). Native title-bar replacement for
           the page-embedded float buttons: left segment flips the panel body
           to the Artify A UI, right segment to the ComfyUI view. Hidden on
           first-use lockdown (chrome is locked down during bootstrap) and on
           install-less hosts (the chooser/Home window is a navigation page,
           not a ComfyUI instance — neither side of the switch can do anything
           there, so showing it is a dead control).
           Active side = azure fill + white text; inactive = muted fill on a
           transparent tray, matching the title bar's token language. -->
      <div
        v-if="!isFirstUseLockdown && !isInstallLess"
        class="mr-2.5 inline-flex items-center gap-0.5 rounded-lg border border-solid border-[rgba(255,255,255,0.14)] p-0.5 [-webkit-app-region:no-drag] [.title-bar.is-light_&]:border-[rgba(0,0,0,0.14)]"
        role="tablist"
        aria-label="Artify / ComfyUI"
      >
        <button
          type="button"
          class="inline-flex h-[22px] cursor-pointer items-center justify-center gap-1 rounded-md border-0 px-2 font-[inherit] text-[var(--titlebar-icon,rgba(255,255,255,0.55))] transition-[background-color,color] duration-150 ease-[ease]"
          :class="
            artifyVisible
              ? 'bg-[#0b8ce9] text-white'
              : canSwitchToArtify
                ? 'bg-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.12)] hover:text-[var(--titlebar-icon,#fff)] [.title-bar.is-light_&]:bg-[rgba(0,0,0,0.05)] [.title-bar.is-light_&]:hover:bg-[rgba(0,0,0,0.1)]'
                : 'cursor-not-allowed opacity-30'
          "
          role="tab"
          :aria-selected="artifyVisible"
          :disabled="!canSwitchToArtify"
          v-bind="tooltipAttrs('Artify 工坊')"
          @click="switchToArtify"
        >
          <img :src="artifyLogoUrl" class="block size-3.5 shrink-0" alt="" aria-hidden="true" />
          <span class="text-[11px] font-semibold leading-none whitespace-nowrap">{{
            t('titleBar.surfaceArtify')
          }}</span>
        </button>
        <button
          type="button"
          class="inline-flex h-[22px] cursor-pointer items-center justify-center gap-1 rounded-md border-0 px-2 font-[inherit] text-[var(--titlebar-icon,rgba(255,255,255,0.55))] transition-[background-color,color] duration-150 ease-[ease]"
          :class="
            !artifyVisible
              ? 'bg-[#0b8ce9] text-white'
              : 'bg-[rgba(255,255,255,0.06)] hover:bg-[rgba(255,255,255,0.12)] hover:text-[var(--titlebar-icon,#fff)] [.title-bar.is-light_&]:bg-[rgba(0,0,0,0.05)] [.title-bar.is-light_&]:hover:bg-[rgba(0,0,0,0.1)]'
          "
          role="tab"
          :aria-selected="!artifyVisible"
          v-bind="tooltipAttrs('ComfyUI')"
          @click="switchToComfy"
        >
          <ComfyCLogo :size="14" class="shrink-0" aria-hidden="true" />
          <span class="text-[11px] font-semibold leading-none whitespace-nowrap">{{
            t('titleBar.surfaceComfy')
          }}</span>
        </button>
      </div>
    </div>

    <div class="title-trailing flex items-center gap-2 [justify-self:end]">
      <Transition name="title-zoom-fade">
        <button
          v-if="showZoomReset"
          type="button"
          class="title-zoom-reset [&:is(.title-zoom-fade-enter-active,.title-zoom-fade-leave-active)]:transition-[opacity,transform] [&:is(.title-zoom-fade-enter-active,.title-zoom-fade-leave-active)]:duration-[160ms] [&:is(.title-zoom-fade-enter-active,.title-zoom-fade-leave-active)]:ease-[ease] [&:is(.title-zoom-fade-enter-from,.title-zoom-fade-leave-to)]:opacity-0 [&:is(.title-zoom-fade-enter-from,.title-zoom-fade-leave-to)]:[transform:scale(0.9)] [-webkit-app-region:no-drag] inline-flex shrink-0 items-center gap-1 rounded-[999px] border border-solid border-transparent bg-transparent px-2 py-[3px] [font-family:inherit] text-[11px] leading-[14px] font-normal text-[var(--titlebar-icon)] opacity-85 tabular-nums cursor-pointer transition-[background-color,opacity,border-color,color] duration-[120ms] ease-[ease] [.title-bar.is-hover-active_&]:hover:opacity-100 [.title-bar.is-hover-active_&]:hover:bg-[rgba(255,255,255,0.08)] [.title-bar.is-hover-active_&]:hover:border-[rgba(255,255,255,0.18)] [.title-bar.is-light.is-hover-active_&]:hover:bg-[rgba(0,0,0,0.06)] [.title-bar.is-light.is-hover-active_&]:hover:border-[rgba(0,0,0,0.18)] [.title-bar.is-hover-active:not(.is-light)_&]:hover:bg-secondary [.title-bar.is-hover-active:not(.is-light)_&]:hover:border-transparent focus-visible:outline-2 focus-visible:[outline-style:solid] focus-visible:outline-[var(--focus-ring)] focus-visible:outline-offset-1"
          v-bind="tooltipAttrs(t('titleBar.resetZoomTooltip'))"
          @click="handleResetZoom"
        >
          <ZoomIn :size="14" class="title-zoom-reset-icon" />
          <span class="title-zoom-reset-percent tracking-[0.01em]">{{ zoomPercent }}%</span>
        </button>
      </Transition>
      <button
        v-if="showRefreshButton"
        type="button"
        class="title-menu-button title-menu-button--icon title-refresh-button"
        :class="titleMenuButtonClass"
        v-bind="tooltipAttrs(t('titleBar.refreshInstanceTooltip'))"
        @click="handleRefreshInstance"
      >
        <RotateCw :size="16" />
      </button>
      <button
        v-if="!isFirstUseLockdown"
        ref="announcementBtn"
        type="button"
        class="title-menu-button title-menu-button--icon title-announcement-button relative [&.is-nudging_svg]:origin-[50%_10%] [&.is-nudging_svg]:animate-bell-nudge motion-reduce:[&.is-nudging_svg]:animate-bell-fade"
        :class="[titleMenuButtonClass, { 'is-nudging': bellNudging }]"
        v-bind="tooltipAttrs(t('titleBar.announcementTooltip'), t('titleBar.announcement'))"
        @click="handleWhatsNewMenu"
      >
        <Bell :size="16" />
      </button>
      <button
        v-if="!isFirstUseLockdown"
        ref="downloadsBtn"
        type="button"
        class="title-downloads-tray [-webkit-app-region:no-drag] relative cursor-pointer rounded-lg border border-solid border-transparent bg-transparent px-1.5 py-1 text-[var(--titlebar-icon)] transition-[color] duration-[120ms] ease-[ease] [.title-bar.is-hover-active_&:hover:not(:disabled):not(.is-open)]:text-comfy-yellow [.title-bar.is-light.is-hover-active_&:hover:not(:disabled):not(.is-open)]:text-neutral-700 [&.has-active]:border-[rgba(96,165,250,0.55)] [&.has-active]:bg-[rgba(96,165,250,0.16)] [.title-bar.is-light_&.has-active]:border-[rgba(37,99,235,0.55)] [.title-bar.is-light_&.has-active]:bg-[rgba(37,99,235,0.12)] [&.is-open]:text-neutral-50 [.title-bar.is-light_&.is-open]:text-neutral-700 [&.is-flashing]:animate-[title-downloads-tray-flash_0.9s_ease-out_1] [&.has-unseen]:border-[rgba(34,197,94,0.55)] [&.has-unseen]:bg-[rgba(34,197,94,0.16)] [.title-bar.is-light_&.has-unseen]:border-[rgba(22,163,74,0.55)] [.title-bar.is-light_&.has-unseen]:bg-[rgba(22,163,74,0.12)] [&.has-error]:border-[color-mix(in_srgb,var(--danger)_55%,transparent)] [&.has-error]:bg-[color-mix(in_srgb,var(--danger)_16%,transparent)] [.title-bar.is-hover-active:not(.is-light)_&:not(.has-active,.has-unseen,.has-error):hover]:bg-secondary [.title-bar.is-hover-active:not(.is-light)_&:not(.has-active,.has-unseen,.has-error):hover]:border-transparent"
        :class="{
          'has-active': downloadsActiveCount > 0,
          'has-error': unseenErrorCount > 0,
          'has-unseen':
            downloadsActiveCount === 0 && unseenErrorCount === 0 && unseenFinishedCount > 0,
          'is-flashing': downloadsFlash,
          'is-open': isDownloadsOpen
        }"
        v-bind="tooltipAttrs(downloadsTrayLabel)"
        @click="handleDownloadsTray"
      >
        <ArrowDownToLine :size="16" />
        <span
          v-if="downloadsActiveCount > 0"
          class="title-downloads-badge"
          :class="titleDownloadsBadgeClass"
          aria-hidden="true"
          >{{ downloadsActiveCount }}</span
        >
        <span
          v-else-if="unseenErrorCount > 0"
          class="title-downloads-badge is-error"
          :class="titleDownloadsBadgeClass"
          aria-hidden="true"
          >{{ unseenErrorCount }}</span
        >
        <span
          v-else-if="unseenFinishedCount > 0"
          class="title-downloads-badge is-unseen"
          :class="titleDownloadsBadgeClass"
          aria-hidden="true"
          >{{ unseenFinishedCount }}</span
        >
        <span
          v-if="downloadsActiveCount > 0 && unseenErrorCount > 0"
          class="title-downloads-error-dot pointer-events-none absolute -top-[3px] -left-[3px] size-2 rounded-[999px] bg-[var(--danger)] [box-shadow:0_0_0_2px_var(--titlebar-bg-active,var(--titlebar-bg,var(--neutral-900)))]"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="!isConsentLockdown"
        ref="fileBtn"
        type="button"
        class="title-menu-button title-menu-button--icon"
        :class="titleMenuButtonClass"
        aria-haspopup="menu"
        v-bind="tooltipAttrs(t('titleBar.menu'))"
        @click="handleFileMenu"
      >
        <MenuIcon :size="16" />
      </button>
    </div>
  </header>
</template>

<style>
@keyframes title-downloads-pulse {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.55);
  }
  50% {
    box-shadow: 0 0 0 4px rgba(96, 165, 250, 0);
  }
}
@keyframes title-downloads-flash {
  0% {
    transform: scale(0.6);
    opacity: 0;
  }
  60% {
    transform: scale(1.25);
    opacity: 1;
  }
  100% {
    transform: scale(1);
    opacity: 1;
  }
}
@keyframes title-downloads-tray-flash {
  0%,
  100% {
    box-shadow: 0 0 0 0 rgba(96, 165, 250, 0);
  }
  20% {
    box-shadow: 0 0 0 4px rgba(96, 165, 250, 0.55);
  }
}
@media (prefers-reduced-motion: reduce) {
  .title-downloads-tray.has-active .title-downloads-badge,
  .title-downloads-tray.is-flashing,
  .title-downloads-tray.is-flashing .title-downloads-badge {
    animation: none;
  }
}
</style>
