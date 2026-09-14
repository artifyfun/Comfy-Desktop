/**
 * C-H7 落布整理真机验收：单会话内发送铺画布请求 → 确认执行 →
 * 从页面 Konva/store 读取 AI 新建 App 节点坐标 → 断言水平居中对齐 + 垂直等距分布。
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3008'
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  window.electronAPI = new Proxy(
    {},
    {
      get: (t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'getConfig')
          return async () => ({ comfyHost: 'http://127.0.0.1:8188', serverHost: 'http://127.0.0.1:3008' })
        return async () => null
      },
    },
  )
  window.isElectron = true
})
const page = await context.newPage()

// 关引导弹窗辅助
async function closeModals() {
  for (let i = 0; i < 3; i++) {
    const btn = page
      .locator('.ant-modal .ant-modal-close, [role="dialog"] button:has(i.fa-times), .ant-modal button:has(i.fa-times)')
      .first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(600)
  }
}

await page.goto(`${BASE}/canvas?layout=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)
await closeModals()

// 侧栏发消息
const ta = page.locator('textarea:visible').first()
await ta.fill('把模板库里的 3 个模板铺到画布搭成工作流', { timeout: 15000 })
await page.locator('button:has(i.fa-arrow-up)').first().click()
console.log('✓ 已发送')

// 轮询确认卡
let cardUp = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(20000)
  cardUp = (await page.locator('.agent-ops-card').count()) > 0
  console.log(`  [${(i + 1) * 20}s] 确认卡: ${cardUp}`)
  if (cardUp) break
}
if (!cardUp) {
  console.log('❌ 确认卡未出现')
  await browser.close()
  process.exit(1)
}
await page.screenshot({ path: '/tmp/wb-layout-1-card.png' })

// 读「执行前」画布上的 app 节点坐标（从 projects store）
const before = await page.evaluate(() => {
  const proj = JSON.parse(localStorage.getItem('artify.canvas.projects.v1') || '{"projects":[]}')
  const out = []
  for (const p of proj.projects || []) {
    for (const o of p.doc?.objects || []) {
      if (o.type === 'app') out.push({ id: o.id, name: o.name, x: o.x, y: o.y })
    }
  }
  return out
})
console.log('执行前 app 节点:', before.length)

// 点「执行」
await page.locator('.agent-ops-card button:has-text("执行")').first().click()
await page.waitForTimeout(3000)
await page.screenshot({ path: '/tmp/wb-layout-2-applied.png' })

// 读「执行后」的 app 节点坐标
const after = await page.evaluate(() => {
  const proj = JSON.parse(localStorage.getItem('artify.canvas.projects.v1') || '{"projects":[]}')
  const out = []
  for (const p of proj.projects || []) {
    for (const o of p.doc?.objects || []) {
      if (o.type === 'app') out.push({ name: o.name, x: Math.round(o.x), y: Math.round(o.y) })
    }
  }
  return out
})
console.log('执行后 app 节点:', after.length)
after.forEach((n) => console.log('  ', n.name, 'x=', n.x, 'y=', n.y))

// 断言对齐/分布：新增的 3 节点应 x 相同(hcenter)且 y 等距(垂直分布)
const news = after.slice(before.length)
if (news.length >= 3) {
  const xs = new Set(news.map((n) => n.x))
  const ys = news.map((n) => n.y).sort((a, b) => a - b)
  const gaps = []
  for (let i = 1; i < ys.length; i++) gaps.push(ys[i] - ys[i - 1])
  const evenGap = gaps.every((g) => g === gaps[0])
  console.log('对齐检查: x 全等 =', xs.size === 1 ? '✅' : '❌ (' + [...xs] + ')')
  console.log('等距检查: y 间距 =', gaps.join(','), evenGap ? '✅' : '⚠️')
} else {
  console.log('⚠️ 新增节点不足 3 个:', news.length)
}

await page.screenshot({ path: '/tmp/wb-layout-3-final.png' })
await browser.close()
console.log('完成')
