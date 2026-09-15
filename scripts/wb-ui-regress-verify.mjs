/**
 * W11 验收：两个用户报障的回归（DOM 级，无头浏览器）。
 *
 *  ① 创作资产库弹窗：点侧栏「创作资产库」**当次就要弹**、点关闭**要能关**。
 *     回归背景：assetLibOpen 从未在 script 里声明 —— 赋值落到渲染 ctx 不触发重渲染，
 *     表现为「点了没反应，点技能库时随那次重渲染一起冒出来，且关不掉」。
 *  ② 画布「添加 app 节点」：选完应用**要真的落节点**。
 *     回归背景：onAppPicked 引用了未注入的页级变量（connectCreate / genFromNote）→
 *     ReferenceError 发生在加节点之前，整条路径静默失效。
 *
 * 用法：node scripts/wb-ui-regress-verify.mjs [port|origin]
 * 前置：node acceptance/workbench/serve.mjs <port>  （先 pnpm run build:frontend）
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const arg = process.argv[2] || '5178'
const BASE = /^https?:\/\//.test(arg) ? arg.replace(/\/$/, '') : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))
const errors = []
let failed = false

/** 等页面稳定（stub 的 SSE 是定时推帧，给足首屏时间） */
const settle = (page, ms = 1500) => page.waitForTimeout(ms)

/**
 * 首屏自动弹出的遮罩（首次进入自动弹「使用指南」，localStorage 标记只弹一次）
 * 会拦截后续点击 —— 每次 goto 后先清掉。
 */
async function dismissOverlays(page) {
  for (let i = 0; i < 3; i++) {
    const close = page.locator('.ant-modal-close:visible')
    if (!(await close.count())) break
    await close
      .first()
      .click()
      .catch(() => {})
    await page.waitForTimeout(300)
  }
  await settle(page, 400)
}

/** 打开侧栏底部菜单项（工作台页面左侧会话栏底部按钮，文案即入口） */
async function clickSidebarEntry(page, label) {
  const btn = page.locator('button:visible', { hasText: label }).first()
  await btn.waitFor({ timeout: 8000 })
  await btn.click()
}

/** 资产库弹窗的可见性（Ant modal：关闭按钮 .ant-modal-close，标题含文案） */
async function assetModalVisible(page) {
  return page.evaluate(() => {
    const modals = [...document.querySelectorAll('.ant-modal')]
    for (const m of modals) {
      const wrap = m.closest('.ant-modal-wrap')
      const hidden =
        !wrap || wrap.style.display === 'none' || wrap.getAttribute('aria-hidden') === 'true'
      const title = (m.querySelector('.ant-modal-title') || {}).textContent || ''
      if (!hidden && title.includes('创作资产库')) return true
    }
    return false
  })
}

/** 画布文档（Konva 渲染，节点/连线只能从持久化 doc 读） */
async function readCanvasDoc(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('artify.canvas.projects.v1')
    if (!raw) return null
    try {
      const doc = JSON.parse(raw)
      const projects = doc.projects || []
      const active = projects.find((p) => p.id === doc.activeId) || projects[0] || null
      // 注意：物件挂在 project.doc.objects 下（不是 project.objects）——照
      // projectStore.js 的真实结构读，别自造形状。
      return active
        ? {
            objects: (active.doc?.objects || []).map((o) => ({
              id: o.id,
              type: o.type,
              appId: o.appId
            })),
            links: active.doc?.links || []
          }
        : { objects: [], links: [] }
    } catch {
      return null
    }
  })
}

const browser = await chromium.launch({ headless: true })
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await ctx.newPage()
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200))
})

try {
  // ══════════ ① 创作资产库弹窗 ══════════
  await page.goto(`${BASE}/workbench?session=e2e-uiregress`, { waitUntil: 'load', timeout: 30000 })
  await settle(page, 2500)
  await dismissOverlays(page)

  if (await assetModalVisible(page)) throw new Error('初始状态资产库弹窗就已打开（异常）')

  await clickSidebarEntry(page, '创作资产库')
  await settle(page, 800)
  const openedDirectly = await assetModalVisible(page)
  console.log('① 点「创作资产库」后弹窗可见:', openedDirectly)
  if (!openedDirectly)
    throw new Error('点「创作资产库」当次没弹出（assetLibOpen 声明缺失型缺陷回归）')
  await page.screenshot({ path: SHOT_DIR + 'w11-assetlib-open.png' })

  // 关闭必须生效（旧缺陷：关闭只改非响应式属性，弹窗关不掉）
  await page.locator('.ant-modal-close:visible').first().click()
  await settle(page, 600)
  const closedOk = !(await assetModalVisible(page))
  console.log('① 点关闭后弹窗消失:', closedOk)
  if (!closedOk) throw new Error('点关闭关不掉（回归）')

  // 顺带锁住当初的怪现象：点技能库不应把资产库也带出来
  await clickSidebarEntry(page, '技能库')
  await settle(page, 800)
  const assetLeaked = await assetModalVisible(page)
  console.log('① 点「技能库」不再连带弹出资产库:', !assetLeaked)
  if (assetLeaked) throw new Error('点技能库仍会连带弹出资产库（回归）')
  await page.keyboard.press('Escape')
  await settle(page, 400)
  await page.screenshot({ path: SHOT_DIR + 'w11-assetlib.png' })

  // ══════════ ② 画布：添加 app 节点 ══════════
  await page.goto(`${BASE}/canvas?session=e2e-uiregress`, { waitUntil: 'load', timeout: 30000 })
  await settle(page, 2500)
  await dismissOverlays(page)

  const before = await readCanvasDoc(page)
  console.log('② 操作前画布节点数:', before ? before.objects.length : '(无 doc)')

  // 工具栏 fa-cube = 「添加 app 节点」（title 取 i18n canvasAddAppNode）
  const addBtn = page.locator('button[title*="app"], button[title*="应用"], button[title*="节点"]')
  const btnCount = await addBtn.count()
  if (!btnCount) throw new Error('未找到画布「添加 app 节点」工具栏按钮')
  // 取 title 含“添加”且含“应用/节点”的那个，避免误点其它工具
  let target = null
  for (let i = 0; i < btnCount; i++) {
    const t = (await addBtn.nth(i).getAttribute('title')) || ''
    if (/添加/.test(t)) {
      target = addBtn.nth(i)
      break
    }
  }
  if (!target) target = addBtn.first()
  console.log('② 触发按钮 title:', await target.getAttribute('title'))
  // 画布顶部常有提示条（z-20）压住工具栏 → 用 DOM 分发 click 绕过命中测试。
  // 顺带把提示条文案打出来，避免把 harness 噪音误判成产品问题。
  const banner = await page.evaluate(() => {
    const el = document.querySelector('[class*="z-20"][class*="top-3"]')
    return el ? (el.textContent || '').trim().slice(0, 60) : null
  })
  if (banner) console.log('② 画布顶部提示条（仅记录）:', banner)
  await target.evaluate((el) => el.click())
  await settle(page, 900)

  const pickerShown = await page.locator('.picker-mask:visible').count()
  console.log('② 拾取器弹出:', pickerShown > 0)
  if (!pickerShown) throw new Error('点「添加 app 节点」后拾取器没出现')

  const cards = page.locator('.picker-mask .card:visible')
  const cardCount = await cards.count()
  console.log('② 拾取器可选项数（空 template 应被过滤 → 期望 1）:', cardCount)
  if (cardCount !== 1)
    throw new Error(`拾取器可选项数异常：${cardCount}（期望 1，仅带工作流的应用）`)

  await page.screenshot({ path: SHOT_DIR + 'w11-apppicker.png' })
  await cards.first().click()
  await settle(page, 1200)

  const after = await readCanvasDoc(page)
  const appNodes = after ? after.objects.filter((o) => o.type === 'app') : []
  console.log('② 落布后的 app 节点:', JSON.stringify(appNodes))
  if (appNodes.length !== 1) {
    throw new Error(`选完应用后没落节点（app 节点数=${appNodes.length}）—— onAppPicked 路径回归`)
  }
  if (appNodes[0].appId !== 'app:e2e-aaa') {
    throw new Error(`落布节点的 appId 不对：${appNodes[0].appId}`)
  }
  console.log('② 拾取器已关闭:', (await page.locator('.picker-mask:visible').count()) === 0)
  await page.screenshot({ path: SHOT_DIR + 'w11-canvas-node-added.png' })

  console.log('\n✅ 两项都通过：资产库当次可弹可关；画布选完应用真的落节点')
} catch (e) {
  failed = true
  console.error('\n❌ 失败:', e.message)
  await page.screenshot({ path: SHOT_DIR + 'w11-failed.png' }).catch(() => {})
} finally {
  if (errors.length) {
    console.log('\n⚠️ 页面报错（前 6 条）:')
    errors.slice(0, 6).forEach((x) => console.log('   ' + x))
  } else {
    console.log('\n✓ 无页面级报错')
  }
  await browser.close()
  process.exit(failed ? 1 : 0)
}
