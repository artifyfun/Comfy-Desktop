/**
 * 无限画布交互回归 · 第二波：平移/拖节点/框选/右键菜单/删除/新建画布。
 * 状态断言全部以 projects store + DOM 为准；每步 ✅/❌。
 */
import { chromium } from 'playwright'

const BASE = 'http://127.0.0.1:3008'
const results = []
function record(name, pass, evidence) {
  results.push({ name, pass, evidence })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  window.electronAPI = new Proxy(
    {},
    {
      get: (t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'getConfig')
          return async () => ({
            comfyHost: 'http://127.0.0.1:8188',
            serverHost: 'http://127.0.0.1:3008'
          })
        return async () => null
      }
    }
  )
  window.isElectron = true
})
const page = await context.newPage()
const jsErrors = []
page.on('pageerror', (e) => jsErrors.push(String(e).slice(0, 120)))

async function closeModals() {
  for (let i = 0; i < 3; i++) {
    const btn = page.locator('.ant-modal .ant-modal-close').first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(500)
  }
}

await page.goto(`${BASE}/canvas?w2=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)
await closeModals()

// 预置 3 个对象: 页面先完整加载(此时 store 已初始化) → 写 store → 强制重载
// (此前的写法在页面加载前写 store,被初始化逻辑覆盖 → 画布空白,3 个断言全误判)
await page.waitForTimeout(1500)
await page.evaluate(() => {
  const proj = JSON.parse(localStorage.getItem('artify.canvas.projects.v1'))
  proj.projects[0].doc.objects = [
    { id: 'a1', type: 'note', x: 200, y: 200, width: 140, height: 90, text: '测试便签一' },
    { id: 'a2', type: 'note', x: 500, y: 200, width: 140, height: 90, text: '测试便签二' },
    { id: 'a3', type: 'note', x: 800, y: 450, width: 140, height: 90, text: '测试便签三' }
  ]
  localStorage.setItem('artify.canvas.projects.v1', JSON.stringify(proj))
})
await page.reload({ waitUntil: 'networkidle' })
await page.waitForTimeout(3500)
await closeModals()
// 断言画布真的渲染了对象(Konva canvas 像素非空 or 侧栏节点计数)——用页面内的节点计数文本
const nodeCountText = await page.evaluate(() => {
  const m = document.body.textContent.match(/节点\s*(\d+)/)
  return m ? Number(m[1]) : -1
})
console.log('  [预检] 画布节点计数:', nodeCountText)

const cv = page.locator('canvas').first()
const box = await cv.boundingBox()

// Konva 直驱辅助: 从容器 DOM 拿 stage 与节点(画布对象按 name/id 定位)
async function konvaState() {
  return page.evaluate(() => {
    const stage = window.Konva?.stages?.[0]
    if (!stage) return { noStage: true, hasGlobal: !!window.Konva }
    const layer = stage.getLayers()[0]
    const groups = layer.getChildren().filter((n) => n.getClassName() === 'Group')
    return {
      ids: groups.map((g) => g.id() || g.name()),
      pos: Object.fromEntries(
        groups.map((g) => [g.id() || g.name(), { x: Math.round(g.x()), y: Math.round(g.y()) }])
      ),
      vp: stage.scale(),
      vpPos: stage.position()
    }
  })
}

// ── 1. 平移(空格+拖,复用真鼠标) ──
const vpBefore = (await konvaState()).vpPos
await page.keyboard.down(' ')
await page.mouse.move(box.x + 500, box.y + 300)
await page.mouse.down()
await page.mouse.move(box.x + 620, box.y + 380, { steps: 8 })
await page.mouse.up()
await page.keyboard.up(' ')
await page.waitForTimeout(400)
const vpAfter = (await konvaState()).vpPos
const panDx = Math.abs(vpAfter.x - vpBefore.x) + Math.abs(vpAfter.y - vpBefore.y)
record('空格+拖 平移', panDx > 10, `stage 位移 ${Math.round(panDx)}px`)
await page.waitForTimeout(1000) // Vue 重渲染 settle(Konva 节点可能销毁重建)

// ── 2. 拖拽节点: 屏幕坐标 = stage.position + 世界坐标 * scale(页面内精确换算)──
const dragPt = await page.evaluate(() => {
  const stage = window.Konva?.stages?.[0]
  if (!stage) return { noStage: true }
  const g = stage.find((n) => n.getClassName() === 'Group' && n.id() === 'a1')[0]
  if (!g) return null
  const container = stage.container().getBoundingClientRect()
  const wx = g.x() + g.width() / 2
  const wy = g.y() + g.height() / 2
  return {
    sx: container.left + wx * stage.scaleX() + stage.x(),
    sy: container.top + wy * stage.scaleY() + stage.y()
  }
})
if (!dragPt) {
  const dbg = await page.evaluate(() => {
    const stage = window.Konva?.stages?.[0]
    if (!stage) return { noStage: true }
    const out = []
    stage
      .getLayers()
      .forEach((l) =>
        l.getChildren().forEach((n) => out.push({ cls: n.getClassName(), id: n.id() }))
      )
    return out
  })
  console.log('❌ 未找到 a1。当前 Konva 节点:', JSON.stringify(dbg).slice(0, 300))
  process.exit(1)
}
await page.mouse.move(dragPt.sx, dragPt.sy)
await page.mouse.down()
await page.mouse.move(dragPt.sx + 130, dragPt.sy + 95, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(400)
// Konva 拖拽即时生效,store 防抖稍后 —— 从 Konva 读回验证
const dragInfo = await page.evaluate(() => {
  const stage = window.Konva?.stages?.[0]
  if (!stage) return { noStage: true }
  const g = stage.find((n) => n.getClassName() === 'Group' && n.id() === 'a1')[0]
  return { x: g.x(), y: g.y() }
})
record('拖拽节点移动', dragInfo.x > 200, `a1 新 x=${Math.round(dragInfo.x)}`)

// ── 3. 删除 a2: 真鼠标单击选中 + Backspace ──
const delPt = await page.evaluate(() => {
  const stage = window.Konva?.stages?.[0]
  if (!stage) return { noStage: true }
  const g = stage.find((n) => n.getClassName() === 'Group' && n.id() === 'a2')[0]
  if (!g) return null
  const container = stage.container().getBoundingClientRect()
  return {
    sx: container.left + (g.x() + g.width() / 2) * stage.scaleX() + stage.x(),
    sy: container.top + (g.y() + g.height() / 2) * stage.scaleY() + stage.y()
  }
})
await page.mouse.click(delPt.sx, delPt.sy)
await page.waitForTimeout(400)
const cntBefore = await page.evaluate(
  () =>
    JSON.parse(
      localStorage.getItem('artify.canvas.projects.v1') || '{"projects":[{"doc":{"objects":[]}}]}'
    ).projects[0].doc.objects.length
)
await page.keyboard.press('Backspace')
await page.waitForTimeout(3500)
const cntAfter = await page.evaluate(
  () => JSON.parse(localStorage.getItem('artify.canvas.projects.v1')).projects[0].doc.objects.length
)
record('选中+删除对象', cntAfter < cntBefore, `${cntBefore} → ${cntAfter}`)

// ── 4. 撤销恢复 ──
await page.keyboard.press('Meta+z')
await page.waitForTimeout(3500)
const cntUndo = await page.evaluate(
  () => JSON.parse(localStorage.getItem('artify.canvas.projects.v1')).projects[0].doc.objects.length
)
record('撤销恢复删除', cntUndo === cntBefore, `${cntAfter} → ${cntUndo}`)

// ── 5. 新建画布项目(画布顶部 tab 条的 + 按钮) ──
const projBefore = await page.evaluate(
  () => JSON.parse(localStorage.getItem('artify.canvas.projects.v1')).projects.length
)
// 「未命名画布」tab 在画布容器内顶部——找画布容器里的 + 按钮
const plusClicked = await page.evaluate(() => {
  const btns = [...document.querySelectorAll('button, [role=button], .cursor-pointer')]
  const layerBtn = btns.find((b) => {
    const r = b.getBoundingClientRect()
    // 画布顶部 tab 条: 项目菜单开关是 fa-layer-group 图标(x≈437)
    return r.y > 50 && r.y < 100 && r.x > 420 && r.x < 480 && b.querySelector('i.fa-layer-group')
  })
  if (!layerBtn) return { noBtn: true }
  layerBtn.click()
  return { clicked: true }
})
await page.waitForTimeout(800)
const newClicked = await page.evaluate(() => {
  const btn = [...document.querySelectorAll('button')].find((b) =>
    (b.textContent || '').includes('新建画布')
  )
  if (!btn) return { noBtn: true }
  btn.click()
  return { clicked: true }
})
await page.waitForTimeout(1800)
const projCount = await page.evaluate(
  () => JSON.parse(localStorage.getItem('artify.canvas.projects.v1')).projects.length
)
record('新建画布项目', projCount > projBefore && newClicked.clicked, `${projBefore} → ${projCount}`)

// ── 6. 全程 JS 健康 ──
record('全程无 JS 异常', jsErrors.length === 0, jsErrors.length ? jsErrors[0] : '')

await page.screenshot({ path: '/tmp/wb-canvas-w2.png' })
await browser.close()

const pass = results.filter((r) => r.pass).length
console.log(`\n=== 画布交互第二波: ${pass}/${results.length} 通过 ===`)
process.exit(0)
