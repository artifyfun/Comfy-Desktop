// 从 comfy_inject.js 单体机械切分（技术债重构），逻辑零改动。
export function installSidebarWidthGovernor() {
  const MAX_PCT = 45
  const RESET_PCT = 20
  const GUTTER_HOT = 14
  try {
    if (document.getElementById('artify-sidebar-governor-style')) return
    const style = document.createElement('style')
    style.id = 'artify-sidebar-governor-style'
    style.textContent = `
      .p-splitter-horizontal > .p-splitter-gutter { position: relative; }
      .p-splitter-horizontal > .p-splitter-gutter::before {
        content: ''; position: absolute; top: 0; bottom: 0; left: -${Math.floor(GUTTER_HOT / 2)}px; right: -${Math.floor(GUTTER_HOT / 2)}px;
      }
      .p-splitter-horizontal > .p-splitter-gutter { cursor: col-resize; }
      /* 拖拽调宽「只能变大不能变小」修复：
         PrimeVue splitter 把 mousemove 挂在宿主 document 上，而侧栏里嵌的是
         iframe——往左拖指针移进 iframe 后，宿主 document 收不到 mousemove
         （iframe 是独立文档，事件不冒泡出）→ 宽度冻结，表现为只能往右拉宽。
         拖拽期间禁用 iframe 命中测试 + 宿主选区，指针事件穿透回宿主文档。
         [data-p-resizing] 是 PrimeVue 自己在 onResizeStart 挂的属性，注意必须
         用值匹配 "true"：onResizeEnd 是 setAttribute('data-p-resizing', false)，
         属性依然存在、值变成字符串 "false"，存在性选择器 [data-p-resizing]
         会恒真 → iframe 永久 pointer-events:none（侧栏点不动）且钳制永久失效。
         .artify-resizing 是我们兜底加的（属性时序/版本差异时仍生效）。 */
      [data-p-resizing="true"] iframe,
      html.artify-resizing iframe { pointer-events: none !important; }
      [data-p-resizing="true"],
      html.artify-resizing { user-select: none !important; }
    `
    document.head.appendChild(style)
  } catch (_e) {
    /* 样式失败不影响主流程 */
  }

  /**
   * 侧栏面板的「另一半」：splitter 的 DOM 是 panel → gutter → panel 兄弟链，
   * 按结构取最可靠；父容器里若还有其它 p-splitterpanel（下方队列面板等），
   * 原来的 children.find 会挑错目标，把第三个面板改成 55% 造成布局塌陷。
   * 结构缺失时回退到原查找方式。
   */
  const findSiblingPanel = (panel) => {
    const byStructure = (el) => {
      let n = el.nextElementSibling
      while (n && !(n.classList && n.classList.contains('p-splitterpanel'))) n = n.nextElementSibling
      return n
    }
    const next = byStructure(panel)
    if (next) return next
    let p = panel.previousElementSibling
    while (p && !(p.classList && p.classList.contains('p-splitterpanel'))) p = p.previousElementSibling
    if (p) return p
    return panel.parentElement
      ? Array.from(panel.parentElement.children).find(
          (el) => el !== panel && el.classList && el.classList.contains('p-splitterpanel'),
        )
      : null
  }

  let patching = false
  // 拖拽进行中（gutter mousedown → mouseup）：放行 PrimeVue 的逐帧写入，
  // 否则它与钳制互相覆盖会在 45% 处抖动；松手后再统一收口。
  // 注意：必须值匹配 "true"，理由同上（属性在拖拽结束后仍存在，值为 "false"）
  const isResizing = () =>
    document.documentElement.classList.contains('artify-resizing') ||
    !!document.querySelector('[data-p-resizing="true"]')
  const clampPanel = () => {
    if (patching || isResizing()) return
    const panel = document.querySelector('.p-splitterpanel.side-bar-panel')
    if (!panel) return
    const m = /calc\(([\d.]+)%/.exec(panel.style.flexBasis || '')
    if (m && parseFloat(m[1]) > MAX_PCT) {
      patching = true
      panel.style.flexBasis = `calc(${MAX_PCT}% - 4px)`
      // 同步把另一半面板补回剩余空间，避免出现空隙/塌陷
      const other = findSiblingPanel(panel)
      if (other) other.style.flexBasis = `calc(${100 - MAX_PCT}% - 4px)`
      patching = false
    }
  }

  // MutationObserver 盯 flex-basis 变化（拖拽中实时钳制）
  const panel = document.querySelector('.p-splitterpanel.side-bar-panel')
  if (panel && !window.__artifySidebarGovObserver) {
    window.__artifySidebarGovObserver = new MutationObserver(clampPanel)
    window.__artifySidebarGovObserver.observe(panel, {
      attributes: true,
      attributeFilter: ['style'],
    })
  }

  // 拖拽窗口标记：给 <html> 加 .artify-resizing，驱动 iframe 指针穿透样式；
  // mouseup（含指针在 iframe 上松手，已因穿透回到宿主）后清理并补一次钳制。
  if (!window.__artifySidebarResizeHooks) {
    window.__artifySidebarResizeHooks = true
    const GUTTER_SEL = '.p-splitter-horizontal > .p-splitter-gutter'
    document.addEventListener(
      'mousedown',
      (e) => {
        const g = e.target && e.target.closest && e.target.closest(GUTTER_SEL)
        if (!g) return
        document.documentElement.classList.add('artify-resizing')
      },
      true,
    )
    const endResize = () => {
      if (!document.documentElement.classList.contains('artify-resizing')) return
      document.documentElement.classList.remove('artify-resizing')
      // 等 PrimeVue 的最后一帧写完（mouseup 里会 removeAttribute）再钳制
      setTimeout(clampPanel, 0)
    }
    document.addEventListener('mouseup', endResize, true)
    window.addEventListener('blur', endResize)
  }

  // 双击 gutter 复位（逃生门）；捕获层挂 document，幂等
  if (!window.__artifySidebarGovDbl) {
    window.__artifySidebarGovDbl = true
    document.addEventListener(
      'dblclick',
      (e) => {
        const g =
          e.target &&
          e.target.closest &&
          e.target.closest('.p-splitter-horizontal > .p-splitter-gutter')
        if (!g) return
        const p = document.querySelector('.p-splitterpanel.side-bar-panel')
        if (!p) return
        p.style.flexBasis = `calc(${RESET_PCT}% - 4px)`
        const other = findSiblingPanel(p)
        if (other) other.style.flexBasis = `calc(${100 - RESET_PCT}% - 4px)`
        e.preventDefault()
        e.stopPropagation()
      },
      true,
    )
  }

  /**
   * 右下浮动画布工具条避让（.p-buttongroup, z-1200, fixed 视口右下）：
   * 侧栏拉宽时它会悬在侧栏 iframe 的输入框上方——视觉遮挡且截胡点击。
   * 规则：与侧栏几何重叠 ⇒ 右移到画布剩余区域（left = sideRight + 12）；
   * 不重叠 ⇒ 还原。仅动 left（动画过渡），不改宿主其他行为。
   */
  if (!window.__artifyFabAvoid) {
    window.__artifyFabAvoid = true
    const FAB_SEL = '.p-buttongroup'
    let rafPending = false
    const avoid = () => {
      rafPending = false
      const fab = document.querySelector(FAB_SEL)
      const side = document.querySelector('.p-splitterpanel.side-bar-panel')
      if (!fab || !side) return
      const f = fab.getBoundingClientRect()
      const s = side.getBoundingClientRect()
      const overlaps = f.left < s.right && f.right > s.left && f.top < s.bottom && f.bottom > s.top
      if (overlaps) {
        const target = Math.round(s.right + 12)
        if (fab.style.left !== target + 'px') {
          fab.style.left = target + 'px'
          fab.style.right = 'auto'
        }
      } else if (fab.style.left) {
        fab.style.left = ''
        fab.style.right = ''
      }
    }
    const schedule = () => {
      if (!rafPending) {
        rafPending = true
        requestAnimationFrame(avoid)
      }
    }
    // 侧栏拖拽/窗口缩放/布局变化时重算
    window.addEventListener('resize', schedule, true)
    document.addEventListener('mousemove', schedule, true)
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(schedule)
      ro.observe(document.querySelector('.p-splitter') || document.body)
    }
    avoid()
  }
}

/**
 * 注册 A UI 工作台 sidebar tab（iframe 嵌工作台 /workbench?embed=1）。
 * 时序：registerSidebarTab 需 extensionManager 就绪（app.setup 后）；
 * 采用轮询重试直到注册成功（extensionManager 未就绪时抛错→退避重试）。
 */
