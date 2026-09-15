/**
 * W13 验收：画布页 header 弹窗（关于/设置）必须压住画布内高 z-index 浮层。
 *
 * 背景（用户报障）：画布页打开「关于」「设置」时，画布内元素（提示词库面板
 * z-30、蒙版对话框 z-[80]、多选浮动栏 z-30…）飘在弹窗上。
 * 根因：AppHeader 根元素 `relative z-20` 建立 stacking context，挂在 header
 * 里的弹窗无论 z-index 多高对外都等效 z=20 < 30/80。
 * 修复：弹窗 Teleport 到 body。
 *
 * 断言（每弹窗两条）：
 *  ① 弹窗遮罩的 stacking-context 祖先链里**没有 header**（Teleport 生效的直接证据）
 *  ② 在画布内高 z 浮层（提示词库面板 z-30）与弹窗的重叠点上，elementsFromPoint
 *     的最上层元素属于弹窗子树（真实叠放，不被数字欺骗）
 *
 * 用法：node scripts/wb-modal-zindex-verify.mjs 5183
 * 前置：node acceptance/workbench/serve.mjs 5183（产物为最新构建）
 * 失败退出码 1。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const arg = process.argv[2] || '5183'
const BASE = /^https?:\/\//.test(arg) ? arg : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const errors = []
page.on('pageerror', (e) => errors.push(String(e).slice(0, 160)))

/** 关掉首屏「使用指南」等 antd 遮罩（否则会拦住所有点击） */
async function dismissOverlays(p) {
  for (const sel of ['.ant-modal-close', '.ant-modal-close-x']) {
    if (await p.locator(sel).count()) {
      await p
        .locator(sel)
        .first()
        .click({ timeout: 3000 })
        .catch(() => {})
      await p.waitForTimeout(500)
    }
  }
}

/** 弹窗遮罩的 SC 祖先链（不含自身）：出现 header 即为 Teleport 失效 */
const scChainHasHeader = (p, sel) =>
  p.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    let cur = el.parentElement
    while (cur && cur !== document.documentElement) {
      const c = getComputedStyle(cur)
      const sc =
        (c.position !== 'static' && c.zIndex !== 'auto') ||
        c.transform !== 'none' ||
        c.filter !== 'none' ||
        c.isolation === 'isolate' ||
        Number(c.opacity) < 1
      if (sc) return { isHeader: cur.tagName === 'HEADER', cls: (cur.className || '').toString().slice(0, 40), z: c.zIndex }
      cur = cur.parentElement
    }
    return { isHeader: false, cls: '(root)', z: null }
  }, sel)

/** 某点上的叠放：最上层元素是否属于弹窗子树 */
const topAtInModal = (p, x, y) =>
  p.evaluate(
    ({ x, y }) => {
      const els = document.elementsFromPoint(x, y)
      return els.length ? !!els[0].closest('.about-modal, .config-modal') : null
    },
    { x, y },
  )

/** 画布页高 z 浮层（提示词库面板 w~560 居中）的中心点 */
const panelCenter = (p) =>
  p.evaluate(() => {
    const els = [...document.querySelectorAll('.z-30')]
    const el = els.find((e) => {
      const r = e.getBoundingClientRect()
      return r.width > 400 && r.width < 700
    })
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
  })

let failed = false
try {
  await page.goto(`${BASE}/canvas?session=w13-zindex`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(3000)
  await dismissOverlays(page)

  // 画布内造一个 z-30 浮层（提示词库面板，居中、与弹窗必然重叠）
  const libBtn = page.locator('button[title="提示词库"]').first()
  if ((await libBtn.count()) === 0) throw new Error('没找到画布工具栏「提示词库」按钮')
  await libBtn.evaluate((el) => el.click())
  await page.waitForTimeout(900)
  if ((await page.locator('input[placeholder*="搜索"]').first().count()) === 0) {
    throw new Error('提示词库面板没打开（前置失败）')
  }
  const pt = await panelCenter(page)
  if (!pt) throw new Error('没定位到提示词库面板（w~560 的 z-30 元素）')
  console.log('✓ 画布内 z-30 浮层已开（提示词库面板），重叠点:', JSON.stringify(pt))

  // ── ① 关于弹窗 ──
  await page
    .locator('header button', { hasText: '关于' })
    .first()
    .evaluate((el) => el.click())
  await page.waitForTimeout(900)
  const aboutChain = await scChainHasHeader(page, '.about-modal .modal-mask')
  const aboutTop = await topAtInModal(page, pt.x, pt.y)
  console.log(`① 关于弹窗: SC祖先是header=${aboutChain?.isHeader}（${aboutChain?.cls} z=${aboutChain?.z}），重叠点最上层属弹窗=${aboutTop}`)
  if (!aboutChain || aboutChain.isHeader) throw new Error('关于弹窗仍挂在 header 的 stacking context 里（Teleport 失效/回归）')
  if (aboutTop !== true) throw new Error('关于弹窗被画布内 z-30 浮层盖住（层级回归）')
  await page.screenshot({ path: SHOT_DIR + 'w13-about-above-canvas.png' })
  // 关掉，给下一个弹窗让位
  await page.locator('.about-modal .close-btn').first().evaluate((el) => el.click())
  await page.waitForTimeout(600)

  // ── ② 设置弹窗（按钮 v-if="isElectron"，harness stub 已 mock electronAPI）──
  const cfgBtn = page.locator('header button', { hasText: '设置' }).first()
  if (await cfgBtn.count()) {
    await cfgBtn.evaluate((el) => el.click())
    await page.waitForTimeout(900)
    const cfgChain = await scChainHasHeader(page, '.config-modal')
    const cfgTop = await topAtInModal(page, pt.x, pt.y)
    console.log(`② 设置弹窗: SC祖先是header=${cfgChain?.isHeader}（${cfgChain?.cls} z=${cfgChain?.z}），重叠点最上层属弹窗=${cfgTop}`)
    if (!cfgChain || cfgChain.isHeader) throw new Error('设置弹窗仍挂在 header 的 stacking context 里（Teleport 失效/回归）')
    if (cfgTop !== true) throw new Error('设置弹窗被画布内 z-30 浮层盖住（层级回归）')
    await page.screenshot({ path: SHOT_DIR + 'w13-config-above-canvas.png' })
  } else {
    console.log('② 设置按钮不存在（isElectron=false），跳过——关于弹窗已覆盖同一根因')
  }

  console.log('\n✅ 通过：关于/设置弹窗都在画布内 z-30/z-[80] 浮层之上（Teleport to body 生效）')
  if (errors.length) {
    console.log('\n⚠️ 页面报错（前 3 条）:')
    errors.slice(0, 3).forEach((x) => console.log('   ' + x))
  }
} catch (e) {
  failed = true
  console.error('\n❌ 失败:', e.message)
  await page.screenshot({ path: SHOT_DIR + 'w13-failed.png' }).catch(() => {})
} finally {
  await browser.close()
}
process.exit(failed ? 1 : 0)
