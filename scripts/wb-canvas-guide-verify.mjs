/**
 * W14 验收：画布指南弹窗（罗盘入口 / 空画布 CTA / 三种关闭口径）
 *
 * 覆盖 d0cf9fdd（指南弹窗）+ 17fd2085（空画布 CTA / Esc 关闭）：
 *   W14.1 罗盘入口 → 弹窗打开（侧栏 2 组 / 12 篇 / 正文 + 示意图渲染）
 *   W14.2 侧栏切页 → 正文标题与步骤随之切换
 *   W14.3 Esc 一次关闭（不残留）
 *   W14.4 关闭按钮关闭
 *   W14.5 点遮罩空白区关闭
 *   W14.6 空画布 CTA 入口 → 打开 → Esc 关闭
 *
 * 两种跑法（同一套断言，两条渲染链路都盖）：
 *
 *   A. 构建产物 + acceptance 静态服务器（默认）
 *      1) cd <repo> && pnpm run build:frontend
 *      2) cd acceptance/canvas && node serve.mjs 5174
 *      3) node scripts/wb-canvas-guide-verify.mjs 5174
 *
 *   B. dev server（`pnpm dev` 起的 5100，验证未打包的 vite dev 链路）
 *      node scripts/wb-canvas-guide-verify.mjs --base http://127.0.0.1:5100 --inject-stub
 *      dev server 不注入 stub，故改由 addInitScript 直接跑 acceptance/canvas/stub.js。
 */
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback
}
const positionalPort = argv.find((a) => /^\d+$/.test(a))
const PORT = Number(opt('--port', positionalPort || 5174))
const BASE = opt('--base', `http://127.0.0.1:${PORT}`)
/** dev server 模式：HTML 不经过 serve.mjs，stub 由 addInitScript 注入 */
const INJECT_STUB = argv.includes('--inject-stub')
/** 产物模式与 dev 模式的截图分开，避免互相覆盖 */
const SHOT_PREFIX = INJECT_STUB ? 'w14-dev-' : 'w14-'
const SHOTS = new URL('../acceptance/workbench/screenshots/', import.meta.url)
const STUB_PATH = fileURLToPath(new URL('../acceptance/canvas/stub.js', import.meta.url))
await mkdir(SHOTS, { recursive: true })

/** 把 activeId 切到 p-empty（空画布项目）——stub 每次加载都会重写 localStorage，故必须注入 */
const EMPTY_PROJECT_SRC =
  `;(function(){try{const K='artify.canvas.projects.v1';` +
  `const s=JSON.parse(localStorage.getItem(K));s.activeId='p-empty';` +
  `localStorage.setItem(K,JSON.stringify(s));` +
  `console.log('[w14] forced activeId=p-empty')}catch(e){console.warn('[w14] force empty failed',e)}})()`

const MODAL = '[data-testid="canvas-guide-modal"]'
const OPEN_BTN = '[data-testid="canvas-guide-btn"]'
const EMPTY_BTN = '[data-testid="canvas-empty-guide-btn"]'

const results = []
function record(name, pass, evidence) {
  results.push({ name, pass, evidence })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
async function shot(page, file) {
  await page.screenshot({
    path: new URL(`${SHOT_PREFIX}${file}`, SHOTS).pathname.replace(/^\//, '')
  })
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
// dev server 模式：stub.js 直接跑在页面上下文（无需 serve.mjs 改 HTML）
if (INJECT_STUB) await context.addInitScript({ path: STUB_PATH })
const page = await context.newPage()

const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e)))
/** 诊断：被 SPA fallback 兜底成 HTML 的 /api 请求（stub 未 mock 的端点，会引发 JSON.parse 噪音） */
const htmlApiHits = new Set()
page.on('response', (res) => {
  const url = res.url()
  if (!url.includes('/api/')) return
  const ct = res.headers()['content-type'] || ''
  if (ct.includes('text/html'))
    htmlApiHits.add(`${res.request().method()} ${new URL(url).pathname}`)
})

/** 首屏会自动弹「使用指南」（GUIDE_SEEN_KEY），遮罩会拦住所有点击，先点掉 */
async function closeModals() {
  for (let i = 0; i < 4; i++) {
    const close = page.locator('.ant-modal .ant-modal-close').first()
    if (!(await close.count())) break
    await close.click({ timeout: 2000 }).catch(() => {})
    await page.waitForTimeout(400)
  }
}

await page.goto(`${BASE}/canvas?guide=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(2500)
await closeModals()

// 对照实验基线：先记下「不碰指南」时就已经存在的错误，后面只断言「不新增」。
// 注意每次页面加载（boot）都会产生一批 stub 未 mock 端点的解析噪音，故按「加载段」分段记账。
let phaseBase = pageErrors.length
console.log(
  `ℹ️  基线（bootstrap 阶段）页面错误 ${phaseBase} 条` +
    (htmlApiHits.size ? `；stub 未 mock 的 /api 端点数 ${htmlApiHits.size}` : '')
)
if (htmlApiHits.size) console.log(`   ${[...htmlApiHits].join('\n   ')}`)

// ---------- W14.1 罗盘入口 → 弹窗打开 ----------
const openBtn = page.locator(OPEN_BTN)
const openBtnCount = await openBtn.count()
record('W14.1a 罗盘按钮存在', openBtnCount === 1, `count=${openBtnCount}`)
await openBtn.click()
await page.waitForTimeout(600)

const modal = page.locator(MODAL)
const modalVisible = (await modal.count()) === 1 && (await modal.isVisible())
record('W14.1b 弹窗打开', modalVisible)

const navCount = await page.locator(`${MODAL} .guide-nav`).count()
record('W14.1c 侧栏 12 篇', navCount === 12, `nav=${navCount}`)

const groups = await page.locator(`${MODAL} .guide-group`).allInnerTexts()
record('W14.1d 两个分组', groups.length === 2, groups.join(' / '))

const firstTitle = (await page.locator(`${MODAL} .guide-title h3`).innerText()).trim()
const figureNodes = await page.locator(`${MODAL} .guide-figure svg *`).count()
record(
  'W14.1e 正文默认页 + 示意图渲染',
  firstTitle.length > 0 && figureNodes > 5,
  `标题=${firstTitle}, figure 元素=${figureNodes}`
)
await shot(page, 'guide-open.png')

// ---------- W14.2 侧栏切页 ----------
const target = page.locator(`${MODAL} .guide-nav`, { hasText: '文生图' }).first()
let switchOk = false
let switchEvidence = '未找到「文生图」导航项'
if (await target.count()) {
  await target.click()
  await page.waitForTimeout(400)
  const t2 = (await page.locator(`${MODAL} .guide-title h3`).innerText()).trim()
  const steps = await page.locator(`${MODAL} .guide-main li`).count()
  const active = (await page.locator(`${MODAL} .guide-nav.active`).innerText()).trim()
  switchOk = t2 !== firstTitle && steps > 0
  switchEvidence = `标题 ${firstTitle} → ${t2}, 步骤=${steps}, active=${active}`
  await shot(page, 'guide-page-switch.png')
}
record('W14.2 切页正文随之切换', switchOk, switchEvidence)

// ---------- W14.3 Esc 关闭 ----------
await page.keyboard.press('Escape')
await page.waitForTimeout(500)
record('W14.3a Esc 一次关闭', (await modal.count()) === 0, `残留=${await modal.count()}`)
await shot(page, 'guide-closed.png')

const guidePhaseErrors = pageErrors.length - phaseBase
record(
  'W14.3b 指南交互段未新增页面错误',
  guidePhaseErrors === 0,
  guidePhaseErrors ? pageErrors.slice(phaseBase).join(' | ') : '无'
)

// ---------- W14.4 关闭按钮 ----------
await openBtn.click()
await page.waitForTimeout(400)
await page.locator(`${MODAL} .guide-close`).click()
await page.waitForTimeout(400)
record('W14.4 关闭按钮关闭', (await modal.count()) === 0, `残留=${await modal.count()}`)

// ---------- W14.5 点遮罩空白区关闭 ----------
await openBtn.click()
await page.waitForTimeout(400)
await page.locator('.guide-mask').click({ position: { x: 8, y: 8 } })
await page.waitForTimeout(400)
record('W14.5 点遮罩关闭', (await modal.count()) === 0, `残留=${await modal.count()}`)

// ---------- W14.6 空画布 CTA ----------
// stub 每次加载都会重写 localStorage（activeId 回到 p-main），所以不能靠 evaluate 切项目，
// 必须在 stub 之后追加一段「切到 p-empty」的脚本 —— 不改动 acceptance/canvas/stub.js。
if (INJECT_STUB) {
  // dev 模式：addInitScript 按注册顺序执行，这段跑在 stub.js 之后
  await context.addInitScript(EMPTY_PROJECT_SRC)
} else {
  // 产物模式：stub 由 serve.mjs 以 <script src> 注入，改写它的响应体
  await context.route('**/__canvas_stub.js', async (route) => {
    const res = await route.fetch()
    const body = await res.text()
    await route.fulfill({ response: res, body: `${body}\n${EMPTY_PROJECT_SRC}\n` })
  })
}
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(2500)
await closeModals()
phaseBase = pageErrors.length // 第二段加载：重新取基线

const emptyBtnCount = await page.locator(EMPTY_BTN).count()
record('W14.6a 空画布 CTA 存在', emptyBtnCount === 1, `count=${emptyBtnCount}`)
let emptyOk = false
let emptyEvidence = 'CTA 未出现，后续跳过'
if (emptyBtnCount === 1) {
  await shot(page, 'empty-cta.png')
  await page.locator(EMPTY_BTN).click()
  await page.waitForTimeout(600)
  const opened = (await modal.count()) === 1
  await page.keyboard.press('Escape')
  await page.waitForTimeout(500)
  const closed = (await modal.count()) === 0
  emptyOk = opened && closed
  emptyEvidence = `打开=${opened}, Esc 关闭=${closed}`
  await shot(page, 'empty-cta-closed.png')
}
record('W14.6b 空画布 CTA → 打开 → Esc 关闭', emptyOk, emptyEvidence)

// ---------- 收尾 ----------
const emptyPhaseErrors = pageErrors.length - phaseBase
record(
  'W14.7 空画布段未新增页面错误',
  emptyPhaseErrors === 0,
  emptyPhaseErrors ? pageErrors.slice(phaseBase).join(' | ') : '无'
)

await browser.close()

const failed = results.filter((r) => !r.pass)
console.log(
  `\n${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`
)
console.log(`截图目录：acceptance/workbench/screenshots/（前缀 ${SHOT_PREFIX}）`)
process.exit(failed.length ? 1 : 0)
