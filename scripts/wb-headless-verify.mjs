/**
 * 无头 Chromium 验证（playwright 独立实例，与用户 Chrome 完全隔离）。
 * 验证 wb_build_workflow → 确认卡 → 执行 → AI 快照落盘 → 面板 → 回滚 全链路。
 * 环境模拟：window.electronAPI（应用启动依赖）。
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3008'
const warnings = []

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  window.__snapErrs = []
  const __ow = console.warn
  console.warn = (...a) => { if (String(a[0]).includes('aiSnapshot')) window.__snapErrs.push(a.join(' ')); __ow(...a) }
  window.addEventListener('error', e => window.__snapErrs.push('ERR:' + String(e.message).slice(0,150)))
  const __os = Storage.prototype.setItem, __or = Storage.prototype.removeItem
  Storage.prototype.setItem = function(k, v) { if (k.includes('artify')) window.__snapErrs.push('SET:' + k); return __os.call(this, k, v) }
  Storage.prototype.removeItem = function(k) { if (k.includes('artify')) window.__snapErrs.push('DEL:' + k); return __or.call(this, k) }
  window.electronAPI = {
    ArtifyLab: new Proxy(
      {},
      {
        get: (t, prop) => {
          if (prop === 'getConfig')
            return async () => ({ comfyHost: 'http://127.0.0.1:8188', serverHost: 'http://127.0.0.1:3008' })
          if (prop === 'getAppInfo') return async () => ({ version: '1.3.0' })
          return async () => null
        },
      },
    ),
  }
  window.isElectron = true
})
const page = await context.newPage()
page.on('console', (m) => {
  warnings.push(m.type() + ':' + m.text().slice(0, 200))
})
page.on('pageerror', (e) => warnings.push('ERR:' + String(e).slice(0, 120)))
page.on('response', (r) => { if (r.status() === 404) warnings.push('NET404:' + r.url().slice(-80)) })

const shot = (name) => page.screenshot({ path: `/tmp/wb-hl-${name}.png` })

// 1. 画布页加载（Electron 同款入口）
await page.goto(`${BASE}/canvas?session=hl-verify`, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)
console.log('✓ 页面加载:', page.url().slice(0, 60))
await shot('1-boot')

// 2. 清快照 + 挂探针
await page.evaluate(() => {
  localStorage.removeItem('artify.canvas.aiSnapshots.v1')
})

// 3. 关首次引导弹窗（ant-modal，headless 全新配置必弹）
const modalClose = page.locator('.ant-modal-wrap button[aria-label="Close"], .ant-modal-close').first()
if (await modalClose.count()) {
  await modalClose.click().catch(() => {})
  await page.waitForTimeout(800)
}
// 侧栏发消息
const ta = page.locator('textarea:visible').first()
await ta.fill('把模板库里的 3 个模板铺到画布搭成工作流', { timeout: 15000 })
await page.waitForTimeout(300)
await page.locator('button:has(i.fa-arrow-up)').first().click()
console.log('✓ 已发送')

// 4. 轮询确认卡
let cardUp = false
for (let i = 0; i < 10; i++) {
  await page.waitForTimeout(20000)
  cardUp = (await page.locator('.agent-ops-card').count()) > 0
  console.log(`  [${(i + 1) * 20}s] 确认卡: ${cardUp}`)
  if (cardUp) break
}
await shot('2-card')
if (!cardUp) {
  console.log('❌ 确认卡未出现。警告:', warnings.slice(0, 3))
  await browser.close()
  process.exit(1)
}

// 4.5 记录加载的 JS chunk(定位 confirmAgentOps 所在 chunk)
const loadedJs = await page.evaluate(() =>
  performance.getEntriesByType('resource').filter(e => e.name.endsWith('.js')).map(e => e.name.split('/').pop()),
)
console.log('加载的 JS chunks:', JSON.stringify(loadedJs))

// 5. 执行(点击时从按钮 DOM 反查 Vue 组件实例)
const compInfo = await page.evaluate(() => {
  const card = document.querySelector('.agent-ops-card')
  if (!card) return { noCard: true }
  // Vue3 实例挂在内部 vnode 上: 用 __vueParentComponent 仅在 dev 可用;生产构建走 __vue_app__ 全局
  let inst = null
  let el = card
  while (el && !inst) {
    const k = Object.keys(el).find(k => k.startsWith('__vue'))
    if (k) inst = el[k]
    el = el.parentElement
  }
  if (!inst) {
    const appEl = document.querySelector('#app')
    const ak = Object.keys(appEl).find(k => k.startsWith('__vue'))
    inst = ak ? appEl[ak] : null
  }
  if (!inst) return { noVueAnywhere: true }
  // 生产构建:setupState 为空,函数在闭包里不可见。改从 DOM 找按钮 → __vueParentComponent
  // 都拿不到时直接从 inst.appContext 找 app,再从 app._instance.subTree 深挖
  let cur = inst
  let hops = 0
  let owner = null
  while (cur && hops < 40) {
    const s = cur.setupState || cur.ctx || {}
    if ('pendingAgentOps' in s || 'confirmAgentOps' in s) { owner = cur; break }
    if (cur.subTree) {
      const stack = [cur.subTree]
      while (stack.length && !owner) {
        const vn = stack.pop()
        if (!vn) continue
        if (vn.component) {
          const cs = vn.component.setupState || {}
          if ('pendingAgentOps' in cs || 'confirmAgentOps' in cs) { owner = vn.component; break }
          stack.push(vn.component.subTree)
        }
        if (Array.isArray(vn.children)) vn.children.forEach(c => stack.push(c))
      }
      if (owner) break
    }
    cur = cur.parent
    hops++
  }
  if (!owner) return { noOwner: true, hops }
  const os = owner.setupState || owner.ctx || {}
  return { ownerFound: true, hasSnapCall: String(os.confirmAgentOps || '').includes('AI 操作前'),
    fn: String(os.confirmAgentOps).slice(0, 400) }
})
console.log('🔍 确认卡组件实例:', JSON.stringify(compInfo).slice(0, 500))
await page.locator('.agent-ops-card button:has-text("执行")').first().click()
await page.waitForTimeout(2500)
await shot('3-applied')
console.log('✓ 已执行')

// 6. 验证快照 + 面板
const result = await page.evaluate(() => {
  localStorage.setItem('artify.canvas.aiSnapshots.probe', 'x')
  var probeOk = localStorage.getItem('artify.canvas.aiSnapshots.probe') === 'x'
  localStorage.removeItem('artify.canvas.aiSnapshots.probe')
  const allKeys = Object.keys(localStorage);
  const raw = localStorage.getItem('artify.canvas.aiSnapshots.v1')
  const panel = document.body.textContent.includes('AI 快照')
  const nodeMatch = document.body.textContent.match(/(\d+)\s*节点/)
  return {
    probeOk,
    hasSnap: !!raw,
    panelVisible: panel,
    nodeCount: nodeMatch ? nodeMatch[1] : null,
    snap: raw ? JSON.parse(raw).projects : null,
    allKeys,
    rawErrs: window.__snapErrs,
  }
})
console.log('=== 验证结果 ===')
console.log(
  '快照落盘:',
  result.hasSnap ? '✅' : '❌',
  '| 面板渲染:',
  result.panelVisible ? '✅' : '❌',
  '| 节点数:',
  result.nodeCount,
)
console.log('快照数据:', JSON.stringify(result.snap).slice(0, 300))
console.log('localStorage keys:', result.allKeys)
console.log('原始探针:', result.rawErrs)
if (warnings.length) console.log('警告:', warnings.slice(0, 3))

// 7. 回滚
const restoreBtn = page.locator('button:has-text("恢复此快照")').first()
if (await restoreBtn.count()) {
  const before = result.nodeCount
  await restoreBtn.click()
  await page.waitForTimeout(1500)
  await shot('4-restored')
  const after = await page.evaluate(() => {
    const m = document.body.textContent.match(/(\d+)\s*节点/)
    return m ? m[1] : null
  })
  console.log('回滚:', Number(after) < Number(before) ? '✅' : '⚠️', `(${before} → ${after})`)
} else {
  console.log('⚠️ 恢复按钮未出现')
}

await browser.close()
console.log('验证完成')
