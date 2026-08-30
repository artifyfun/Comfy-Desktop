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
    `
    document.head.appendChild(style)
  } catch (_e) {
    /* 样式失败不影响主流程 */
  }

  let patching = false
  const clampPanel = () => {
    if (patching) return
    const panel = document.querySelector('.p-splitterpanel.side-bar-panel')
    if (!panel) return
    const m = /calc\(([\d.]+)%/.exec(panel.style.flexBasis || '')
    if (m && parseFloat(m[1]) > MAX_PCT) {
      patching = true
      panel.style.flexBasis = `calc(${MAX_PCT}% - 4px)`
      // 同步把另一半面板补回剩余空间，避免出现空隙/塌陷
      const other = panel.parentElement
        ? Array.from(panel.parentElement.children).find(
            (el) => el !== panel && el.classList && el.classList.contains('p-splitterpanel'),
          )
        : null
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
        const other = p.parentElement
          ? Array.from(p.parentElement.children).find(
              (el) => el !== p && el.classList && el.classList.contains('p-splitterpanel'),
            )
          : null
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
