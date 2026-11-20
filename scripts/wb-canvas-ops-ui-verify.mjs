/**
 * canvas-ops **DOM 级**端到端验收（playwright 无头 Chromium，与用户 Chrome 隔离）。
 *
 * 补的是「embed 模式下画布页真的弹出确认卡、并在确认后把节点和**连线**落到画布」这一段。
 * 此前用单元/契约测试钉住了载荷与语义（见 routes/agui.test.ts、__tests__/aguiBridge.test.js、
 * __tests__/useExecutionPolling.test.js、canvas/composables.test.js），但**没有渲染层证据**。
 *
 * 链路（一次真实跑通）：
 *   stub SSE(CUSTOM wb_canvas_ops) → aguiBridge → useExecutionPolling（embed 分支）
 *     → canvasMode.emitOps → 画布页 useAppNodes.onOps → pendingAgentOps
 *       → .agent-ops-card 确认卡 → 点确认 → applyCanvasAgentOps → 画布 doc 落盘
 *
 * 前置：
 *   pnpm run build:frontend
 *   node acceptance/workbench/serve.mjs 5177      # 复用带 SSE stub 的 harness
 *   node scripts/wb-canvas-ops-ui-verify.mjs 5177
 *
 * 注意：本脚本刻意打开 `/canvas`（不是 /workbench）——画布页内联渲染了
 * `<Workbench :canvas-embedded="true" />` 侧栏，这样才走 embed 分支。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

// 参数既接受纯端口（5177）也接受完整 origin，避免把端口当 URL 用
const arg = process.argv[2]
const BASE = !arg
  ? 'http://127.0.0.1:5177'
  : /^\d+$/.test(arg)
    ? `http://127.0.0.1:${arg}`
    : arg.replace(/\/+$/, '')
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))
const SEND_TEXT = process.env.WB_MSG || '帮我把模板铺画布搭成工作流'

/** 期望落盘的节点引用名（与 stub 的 ops 一致） */
const REF_A = 'wf-e2e-0-a1'
const REF_B = 'wf-e2e-1-b2'

const errors = []
let failed = false

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200))
})

/** 画布 doc 的权威状态在 projects store（localStorage）——读它而不是数 DOM（画布是 Konva 渲染的） */
const readDoc = () =>
  page.evaluate(() => {
    const raw = localStorage.getItem('artify.canvas.projects.v1')
    if (!raw) return null
    const store = JSON.parse(raw)
    const p = (store.projects || []).find((x) => x.id === store.activeId) || store.projects?.[0]
    return {
      objects: (p?.doc?.objects || []).map((o) => ({ id: o.id, type: o.type, appId: o.appId })),
      links: (p?.doc?.links || []).map((l) => ({ from: l.from, to: l.to })),
    }
  })

async function closeOverlays() {
  for (let i = 0; i < 4; i++) {
    const btn = page
      .locator('.ant-modal-close, [role="dialog"] button:has(i.fa-times), .ant-modal button:has(i.fa-times)')
      .first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(400)
  }
  await page.keyboard.press('Escape').catch(() => {})
}

try {
  // 带 ?session=：与 wb-headless-verify.mjs 同款开法（画布页需要一个会话上下文
  // 才能把内嵌工作台侧栏挂起来）
  await page.goto(`${BASE}/canvas?session=wbops-${Date.now()}`, {
    waitUntil: 'load',
    timeout: 30000
  })
  await page.waitForTimeout(3500)
  await closeOverlays()
  console.log('✓ 页面加载:', page.url())

  // ── 前置断言：embed 侧栏确实渲染了（否则后面测不到 embed 分支）──
  const probe = await page.evaluate(() => ({
    textareas: document.querySelectorAll('textarea').length,
    visibleTextareas: [...document.querySelectorAll('textarea')].filter((t) => t.offsetParent)
      .length,
    asides: document.querySelectorAll('aside').length,
    appChildren: document.querySelector('#app')?.children?.length ?? -1,
    bodyLen: (document.body.innerText || '').length,
    bodyHead: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160)
  }))
  if (!probe.visibleTextareas) {
    console.log('诊断:', JSON.stringify(probe, null, 2))
    await page.screenshot({ path: SHOT_DIR + 'w10-canvas-ops-diagnose.png' })
    throw new Error('未找到画布页内嵌工作台的输入框（embed 侧栏没渲染？）')
  }
  console.log('✓ 内嵌工作台侧栏可见（embed 模式）')

  // ── 发消息触发 stub 的 withCanvasOps 场景 ──
  const ta = page.locator('textarea:visible').first()
  await ta.fill(SEND_TEXT, { timeout: 15000 })
  await page.waitForTimeout(300)
  await page
    .locator('button:has(i.fa-arrow-up), button[title="发送"], button[title="Send"]')
    .first()
    .click()
  console.log('✓ 已发送触发消息')

  // ── ① DOM 级：确认卡出现 ──
  let cardText = ''
  let cardUp = false
  for (let i = 0; i < 20; i++) {
    await page.waitForTimeout(500)
    const card = page.locator('.agent-ops-card').first()
    if (await card.count()) {
      cardUp = true
      cardText = ((await card.innerText()) || '').replace(/\s+/g, ' ').trim()
      break
    }
  }
  await page.screenshot({ path: SHOT_DIR + 'w10-canvas-ops-card.png' })
  if (!cardUp) throw new Error('未出现画布 AI 指令确认卡（.agent-ops-card）——ops 没到画布页')
  console.log('✓ 确认卡已渲染:', cardText.slice(0, 120))

  // 卡片文案应体现这批 ops（含连线，且用 fromName/toName 而不是内部 id）
  if (!/E2E 文生图/.test(cardText)) throw new Error(`确认卡未列出节点名：${cardText.slice(0, 200)}`)
  if (/wf-e2e-/.test(cardText)) throw new Error('确认卡暴露了内部 nodeId（应显示名字）')

  // ── ② 确认前：画布上还没有这些节点（确认卡必须是真的"待人审"）──
  const before = await readDoc()
  if (before?.objects?.some((o) => o.id === REF_A)) {
    throw new Error('ops 在确认前就被应用了——人审门失效')
  }
  console.log('✓ 确认前人审门有效（节点未落布）')

  // ── ③ 点「执行」（t('canvasAgentOpsConfirm')）→ 落布 ──
  // 注意：卡片里有两个按钮「执行 / 忽略」，不能靠 last()（那是忽略）——按文案定位。
  const cardButtons = page.locator('.agent-ops-card button')
  const btnTexts = (await cardButtons.allInnerTexts()).map((x) => x.trim())
  const confirmBtn = cardButtons.filter({ hasText: /^\s*(执行|确认)\s*$/ }).first()
  if (!(await confirmBtn.count())) {
    throw new Error(`未找到「执行」按钮，卡上按钮实际为：${JSON.stringify(btnTexts)}`)
  }
  await confirmBtn.click()
  await page.waitForTimeout(1200)
  await page.screenshot({ path: SHOT_DIR + 'w10-canvas-ops-applied.png' })

  // ── ④ 权威状态：节点 + 连线都落盘 ──
  let after = null
  for (let i = 0; i < 20; i++) {
    after = await readDoc()
    if (after?.objects?.some((o) => o.id === REF_A)) break
    await page.waitForTimeout(400)
  }
  const ids = (after?.objects || []).map((o) => o.id)
  const links = after?.links || []
  console.log('--- 落布结果 ---')
  console.log(JSON.stringify({ objectCount: ids.length, ids, links }, null, 2))

  if (!ids.includes(REF_A) || !ids.includes(REF_B)) {
    throw new Error(`节点未按 nodeId 落布（期望 ${REF_A}/${REF_B}，实得 ${JSON.stringify(ids)}）`)
  }
  const appIds = (after.objects || []).filter((o) => o.type === 'app').map((o) => o.appId)
  if (!appIds.includes('app:e2e-aaa') || !appIds.includes('app:e2e-bbb')) {
    throw new Error(`appId 不对：${JSON.stringify(appIds)}`)
  }
  if (links.length !== 1) {
    throw new Error(`**连线数应为 1，实得 ${links.length}** —— 这正是此前被静默丢弃的那一环`)
  }
  if (links[0].from !== REF_A || links[0].to !== REF_B) {
    throw new Error(`连线端点用了非对象 id：${JSON.stringify(links[0])}`)
  }
  console.log(
    `\n✓ 通过：确认卡渲染 → 人审 → 2 节点按 nodeId 落布 → **1 条连线建立（${links[0].from} → ${links[0].to}）**`
  )
} catch (e) {
  failed = true
  console.log('\n❌ 失败：' + (e instanceof Error ? e.message : String(e)))
  await page.screenshot({ path: SHOT_DIR + 'w10-canvas-ops-failed.png' }).catch(() => {})
  const doc = await readDoc().catch(() => null)
  console.log('现场 doc:', JSON.stringify(doc)?.slice(0, 400))
} finally {
  if (errors.length) {
    console.log('\n⚠️ 页面报错（前 5 条）:')
    errors.slice(0, 5).forEach((x) => console.log('   ' + x))
  } else {
    console.log('\n✓ 无页面级报错')
  }
  await browser.close()
}

process.exit(failed ? 1 : 0)
