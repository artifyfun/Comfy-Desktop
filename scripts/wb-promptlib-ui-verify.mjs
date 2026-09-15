/**
 * W12 验收：画布「提示词库」重写后的真实渲染与回填（DOM 级，无头浏览器）。
 *
 * 覆盖：
 *  ① 面板打开后按**工作流分类**渲染（分类数、五大模态分类名、条目总量）
 *  ② 搜索命中（新库的 hint 里写了适用模型，搜索要能搜到 hint）
 *  ③ 点词条真的回填到目标（选中便签 → 追加进 note.text）
 *
 * 用法：node scripts/wb-promptlib-ui-verify.mjs [port|origin]
 * 前置：node acceptance/workbench/serve.mjs <port>  （先 pnpm run build:frontend）
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const arg = process.argv[2] || '5182'
const BASE = /^https?:\/\//.test(arg) ? arg.replace(/\/$/, '') : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))
const errors = []
let failed = false

const settle = (page, ms = 1200) => page.waitForTimeout(ms)

async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const c = page.locator('.ant-modal-close:visible')
    if (!(await c.count())) break
    await c.first().click().catch(() => {})
    await settle(page, 300)
  }
}

/** 面板内省：分类头（形如「① 模型分档…」）+ 可点条目 */
const readPanel = (page) =>
  page.evaluate(() => {
    // 面板根：包含「内置 / 自定义」两个 tab 按钮的那个浮层
    const tabs = [...document.querySelectorAll('button')].filter((b) =>
      /^(内置|自定义)$/.test((b.textContent || '').trim()),
    )
    if (!tabs.length) return null
    const root = tabs[0].closest('div[class*="absolute"]') || tabs[0].parentElement?.parentElement
    if (!root) return null
    const lines = (root.innerText || '')
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    const circled = /^[①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯]/
    const categories = lines.filter((l) => circled.test(l))
    // 条目 = 面板内带 title 的小按钮（title 即 hint）
    const chipEls = [...root.querySelectorAll('button[title]')]
    return {
      visible: true,
      categories,
      chipCount: chipEls.length,
      chipTitles: chipEls.map((b) => b.getAttribute('title') || ''),
      chipTexts: chipEls.map((b) => (b.textContent || '').trim()),
    }
  })

const readNoteText = (page) =>
  page.evaluate(() => {
    const store = JSON.parse(localStorage.getItem('artify.canvas.projects.v1') || '{}')
    const p = (store.projects || []).find((x) => x.id === store.activeId) || (store.projects || [])[0]
    const note = (p?.doc?.objects || []).find((o) => o.type === 'note')
    return note ? note.text : null
  })

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage()
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200))
})

const clickToolbar = async (label) => {
  const btns = page.locator(`button[title="${label}"]`)
  if (!(await btns.count())) throw new Error(`未找到工具栏按钮「${label}」`)
  await btns.first().evaluate((el) => el.click())
}

try {
  await page.goto(`${BASE}/canvas?session=probe-promptlib`, { waitUntil: 'load', timeout: 30000 })
  await settle(page, 2500)
  await dismissOverlays(page)

  // ══════ ① 打开面板：按工作流分类渲染 ══════
  await clickToolbar('提示词库')
  await settle(page, 900)
  const panel = await readPanel(page)
  if (!panel) throw new Error('提示词库面板没打开')
  console.log(`① 分类数=${panel.categories.length} 条目数=${panel.chipCount}`)
  panel.categories.forEach((c) => console.log(`   ${c}`))
  if (panel.categories.length < 14) {
    throw new Error(`分类数偏少：${panel.categories.length}（重写后应 ≥14）`)
  }
  for (const kw of ['模型分档', '文生图', '文生视频', '图生视频', '图生图', '图像编辑']) {
    if (!panel.categories.some((c) => c.includes(kw))) throw new Error(`缺少「${kw}」分类`)
  }
  if (panel.chipCount < 100) throw new Error(`条目总量偏少：${panel.chipCount}（重写后应 ≥100）`)
  const noHint = panel.chipTitles.filter((t) => !t.trim()).length
  console.log(`① 缺 hint 的条目数=${noHint}（应为 0——最佳实践就写在 hint 里）`)
  if (noHint) throw new Error(`${noHint} 个条目没有 hint`)
  await page.screenshot({ path: SHOT_DIR + 'w12-promptlib-open.png' })

  // ══════ ② 搜索：能搜到 hint 里的模型名 ══════
  const searchBox = page.locator('input[placeholder*="搜索提示词"]').first()
  await searchBox.fill('Krea2')
  await settle(page, 700)
  const searched = await readPanel(page)
  console.log(`② 搜「Krea2」→ 条目数=${searched.chipCount}（全量 ${panel.chipCount}）`)
  if (!(searched.chipCount > 0 && searched.chipCount < panel.chipCount)) {
    throw new Error(`搜索没生效：${searched.chipCount}`)
  }
  await searchBox.fill('')
  await settle(page, 500)

  // ══════ ③ 回填：选中便签 → 点词条 → note.text 追加 ══════
  await clickToolbar('添加便签')
  await settle(page, 700)
  // 工具栏那个按钮是**开关**：面板已开时再点会关掉，所以这里按需打开
  if (!(await readPanel(page))) {
    await clickToolbar('提示词库')
    await settle(page, 800)
  }
  if (!(await readPanel(page))) throw new Error('重新打开提示词库面板失败')
  const target = 'Keep the same person, facial features, hairstyle, clothing, pose and camera framing.'
  const chip = page.locator(`button[title]:has-text("Keep the same person")`).first()
  if (!(await chip.count())) throw new Error('没找到「先锁不变项」那条词条')
  await chip.evaluate((el) => el.click())
  await settle(page, 1400)
  const noteText = await readNoteText(page)
  console.log(`③ 便签文本 = ${JSON.stringify((noteText || '').slice(0, 80))}`)
  if (!noteText || !noteText.includes(target.slice(0, 40))) {
    throw new Error('点词条没有回填到便签（应追加进 note.text）')
  }
  const panelGone = !(await readPanel(page))
  console.log('③ 回填后面板自动关闭:', panelGone)
  await page.screenshot({ path: SHOT_DIR + 'w12-promptlib-applied.png' })

  console.log('\n✅ 三项都通过：按工作流分类渲染 / 搜索命中 hint / 点词条回填便签')
} catch (e) {
  failed = true
  console.error('\n❌ 失败:', e.message)
  await page.screenshot({ path: SHOT_DIR + 'w12-failed.png' }).catch(() => {})
} finally {
  if (errors.length) {
    console.log('\n⚠️ 页面报错（前 5 条）:')
    errors.slice(0, 5).forEach((x) => console.log('   ' + x))
  } else {
    console.log('\n✓ 无页面级报错')
  }
  await browser.close()
  process.exit(failed ? 1 : 0)
}
