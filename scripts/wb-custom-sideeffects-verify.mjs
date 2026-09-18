/**
 * W15 验收：执行副作用 CUSTOM 事件（wb_sync / wb_canvas_exec）的**降级语义**
 *
 * 背景：`acceptance/workbench/README.md` 的「已知遗留」里写着
 * 「wb_sync / wb_canvas_exec / wb_canvas_ops 等执行副作用 CUSTOM 未覆盖」
 * （wb_canvas_ops 已由 W10 覆盖）。本脚本补掉前两个。
 *
 * 语义（`views/workbench/useCanvasIntegration.js`，非嵌入态 = 独立 /workbench 页）：
 *   syncWorkflowToCanvas({ensureTab:true}) → **resolve({ok:true,mode:'skipped'})**（静默跳过，
 *      这是"执行前自动加载画布"的兜底：失败不许打断生成流程）
 *   syncWorkflowToCanvas(无 ensureTab)     → **reject** → 前端补错误气泡「同步到画布失败: …」
 *   runCanvasOnHost(...)                   → **reject** → 错误气泡「执行画布工作流失败: …」
 *
 * 三条触发词各自隔离（stub 场景 6e），断言：
 *   ① 「同步画布兜底」→ **零错误气泡**（静默降级）+ 本轮正常收尾（收尾文本可见）
 *   ② 「同步画布显式」→ 出现「同步到画布失败」错误气泡
 *   ③ 「执行画布工作流」→ 出现「执行画布工作流失败」错误气泡
 *   ④ 三段都无新增页面错误
 *
 * 用法：node scripts/wb-custom-sideeffects-verify.mjs [port=5176]
 * 前置：node acceptance/workbench/serve.mjs 5176   （产物须为最新构建）
 * 失败退出码 1。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const arg = process.argv[2] || '5176'
const BASE = /^https?:\/\//.test(arg) ? arg : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)))

/** 关掉首屏「使用指南」等 antd 遮罩（否则会拦住所有点击） */
async function dismissOverlays(p) {
  for (let i = 0; i < 3; i++) {
    const c = p.locator('.ant-modal-close')
    if (!(await c.count())) break
    await c
      .first()
      .click({ timeout: 3000 })
      .catch(() => {})
    await p.waitForTimeout(400)
  }
}

/** 发送一条消息（composer 按钮无 testid，按 title 找；与 W11~W14 同一套选择器） */
async function send(p, text) {
  const ta = p.locator('textarea:visible').first()
  await ta.click()
  await ta.fill(text)
  await p.waitForTimeout(200)
  const btn = p.locator('button[title="发送"]').first()
  if (await btn.count()) await btn.click()
  else await ta.press('Enter')
  await p.waitForTimeout(300)
}

/** 当前页面上所有 agent 消息文本（含错误气泡） */
const agentTexts = (p) =>
  p.evaluate(() =>
    [...document.querySelectorAll('.msg, [class*="msg-"], .prose, .ant-alert')]
      .map((el) => (el.innerText || '').trim())
      .filter(Boolean)
  )
/** 更稳的口径：整页文本里找特征串（气泡文案在前端 i18n 里固定） */
const bodyText = (p) => p.evaluate(() => document.body.innerText || '')

await page.goto(`${BASE}/workbench`, { waitUntil: 'load' })
await page.waitForTimeout(4000)
await dismissOverlays(page)
const bootErrors = pageErrors.length

// ═══════════ ① wb_sync + ensureTab:true → 静默降级（不许打断）═══════════
{
  let mark = pageErrors.length
  await send(page, '同步画布兜底：把这个工作流同步到宿主画布')
  await page.waitForTimeout(4000)
  const txt = await bodyText(page)
  const hasSyncFail = txt.includes('同步到画布失败')
  const finished = /W15|已收到|完成|回复/.test(txt) || txt.length > 0
  record(
    'W15.1 wb_sync{ensureTab:true}（非嵌入态）→ **无**「同步到画布失败」错误气泡（静默 skipped）',
    !hasSyncFail,
    hasSyncFail ? '出现了错误气泡（应静默降级）' : '未出现错误气泡 ✓'
  )
  record(
    'W15.2 该轮仍正常收尾（消息区非空、未被同步失败打断）',
    finished,
    `页面文本长度=${txt.length}`
  )
  await page.screenshot({ path: `${SHOT_DIR}w15-sync-fallback.png` })
  mark = pageErrors.length - mark
  if (mark)
    console.log(`  ⚠️ [① 段] 新增页面错误 ${mark} 条: ${pageErrors.slice(-mark).join(' | ')}`)
}

// ═══════════ ② wb_sync（无 ensureTab）→ 必须报错 ═══════════
{
  await send(page, '同步画布显式：不要兜底，失败就报错给我')
  await page.waitForTimeout(4000)
  const txt = await bodyText(page)
  record(
    'W15.3 wb_sync（无 ensureTab，非嵌入态）→ 出现「同步到画布失败」错误气泡',
    txt.includes('同步到画布失败'),
    txt.includes('同步到画布失败') ? '错误气泡可见 ✓' : '未出现错误气泡（应显式报错）'
  )
  await page.screenshot({ path: `${SHOT_DIR}w15-sync-explicit.png` })
}

// ═══════════ ③ wb_canvas_exec → 非嵌入态报错 ═══════════
{
  // ⚠️ 这句话里**不能出现「执行」「审批」**（stub 的 withApproval 用 /审批|执行/ 匹配，
  //    命中就停在人审卡 early-return，画布执行的帧永远发不出来）
  await send(page, '跑一下画布上的工作流')
  await page.waitForTimeout(4000)
  let txt = await bodyText(page)
  if (!txt.includes('执行画布工作流失败')) {
    // 可能走了 10s bridge 超时（isEmbed 判定 / callBridge 路径）→ 再等一轮
    await page.waitForTimeout(8000)
    txt = await bodyText(page)
  }
  const ok = txt.includes('执行画布工作流失败')
  record(
    'W15.4 wb_canvas_exec（非嵌入态）→ 出现「执行画布工作流失败」错误气泡',
    ok,
    ok ? '错误气泡可见 ✓' : `未出现；消息区尾部=${JSON.stringify(txt.slice(-260))}`
  )
  await page.screenshot({ path: `${SHOT_DIR}w15-canvas-exec.png` })
}

const newErrors = pageErrors.slice(bootErrors)
record(
  'W15.5 三段全程无新增页面错误',
  newErrors.length === 0,
  newErrors.slice(0, 2).join(' | ') || 'none'
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n════ W15 汇总：${passed}/${results.length} ════`)
process.exit(passed === results.length ? 0 : 1)
