/**
 * 无限画布交互真机 E2E（C-H8 回归补充）
 *
 * 覆盖场景（全部走**真鼠标/真键盘**，断言以 projects store + Konva 双源互证）：
 *   C-H8.1 seed 便签既进 store、也真渲染成 Konva 节点
 *   C-H8.2 框选（**Shift+拖**，普通拖是平移）→ 选择栏出现且计数 ≥ 2
 *   C-H8.3 拖拽节点 → Konva 位置变化，且落盘坐标跟随（saveSoon 防抖后）
 *   C-H8.4 选中 + Backspace 删除 → 撤销（⌘/Ctrl+Z）恢复
 *   C-H8.5 滚轮缩放 → 实时 viewport 变化，且 >1.2s 后**落盘**视口跟随
 *   C-H8.6 空格+拖 平移 → Konva stage 位移，且落盘视口跟随
 *   C-H8.7 交互阶段无新增 JS 异常（boot 期噪音单独记账）
 *
 * 用法：node scripts/wb-canvas-interaction-verify.mjs [port|origin]   （默认 3008）
 * 前置：node acceptance/canvas/serve.mjs 3008
 *
 * 三个 harness 要点（都是踩过的）：
 *   ① seed 必须**活过 stub 的重写**——acceptance/canvas/stub.js 每次 boot 都无条件 setItem，
 *      页内 evaluate 改 store 再 reload 会被覆盖。故走 context.route 改写 stub 响应体追加 seed。
 *   ② 视口有「实时（响应式 viewport / Konva stage）」与「落盘（project.doc.viewport）」两份，
 *      落盘走 saveSoon **500ms 防抖** → 等 1.2s 以上再断言，否则会误判「点了没反应」。
 *   ③ **拖拽类断言必须放在缩放/平移之前**——本脚本会真的把画布平移到 (-711,-335)，
 *      之后世界坐标已移出画面，再按屏幕坐标点节点会全落空（曾据此误判成「拖不动/删不掉」）。
 *      框选则相反：普通拖 = 平移画布，框选要 **按住 Shift**（见 index.vue 的 drag.mode）。
 */
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const arg = process.argv[2] || '3008'
const BASE = /^https?:\/\//.test(arg) ? arg.replace(/\/$/, '') : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/canvas/screenshots/', import.meta.url))
const KEY = 'artify.canvas.projects.v1'
const results = []
function record(name, pass, evidence) {
  results.push({ name, pass, evidence })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

const NOTES = [
  { id: 'n1', type: 'note', x: 200, y: 200, width: 140, height: 90, text: '交互回归便签一' },
  { id: 'n2', type: 'note', x: 500, y: 200, width: 140, height: 90, text: '交互回归便签二' },
  { id: 'n3', type: 'note', x: 800, y: 450, width: 140, height: 90, text: '交互回归便签三' }
]
const SEED_SRC =
  `(function(){try{const K='${KEY}';` +
  `const s=JSON.parse(localStorage.getItem(K));s.activeId='p-main';` +
  `s.projects[0].doc.objects=${JSON.stringify(NOTES)};` +
  `localStorage.setItem(K,JSON.stringify(s))}catch(e){console.warn('[ch8] seed failed',e)}})()`

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
await context.addInitScript(() => {
  window.electronAPI = new Proxy(
    {},
    {
      get: (t, prop) => {
        if (prop === 'then') return undefined
        if (prop === 'getConfig')
          return async () => ({ comfyHost: 'http://127.0.0.1:8188', serverHost: location.origin })
        return async () => null
      }
    }
  )
  window.isElectron = true
})
await context.route('**/__canvas_stub.js', async (route) => {
  const res = await route.fetch()
  await route.fulfill({ response: res, body: `${await res.text()}\n;${SEED_SRC}\n` })
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

/** 落盘态：project.doc（objects + viewport） */
async function readDoc() {
  return page.evaluate((key) => {
    const s = JSON.parse(localStorage.getItem(key) || '{"projects":[]}')
    const p = (s.projects || []).find((x) => x.id === 'p-main') || s.projects?.[0]
    return {
      objects: (p?.doc?.objects || []).map((o) => ({
        id: o.id,
        x: Math.round(o.x),
        y: Math.round(o.y)
      })),
      viewport: p?.doc?.viewport || null
    }
  }, KEY)
}

/** 实时态：Konva stage + 节点 */
async function readStage() {
  return page.evaluate(() => {
    const st = window.Konva?.stages?.[0]
    if (!st) return { noStage: true }
    const groups = st
      .getLayers()
      .flatMap((l) => l.getChildren())
      .filter((n) => n.getClassName() === 'Group' && (n.id() || n.name()))
      .map((g) => ({ id: g.id() || g.name(), x: Math.round(g.x()), y: Math.round(g.y()) }))
    return { ids: groups.map((g) => g.id), groups, scale: st.scaleX(), pos: st.position() }
  })
}

/** 世界坐标 → 屏幕坐标（用当前 stage 变换，缩放/平移后仍准确） */
async function toScreen(wx, wy) {
  return page.evaluate(
    ([x, y]) => {
      const st = window.Konva.stages[0]
      const r = st.container().getBoundingClientRect()
      return { x: r.left + x * st.scaleX() + st.x(), y: r.top + y * st.scaleY() + st.y() }
    },
    [wx, wy]
  )
}

await page.goto(`${BASE}/canvas?ch8=${Date.now()}`, { waitUntil: 'networkidle', timeout: 30000 })
await page.waitForTimeout(3000)
await closeModals()
/** boot 期基线（stub 未 mock 端点的 SPA fallback 噪音不计入断言） */
const bootErrors = jsErrors.length

// ── C-H8.1 seed 双源互证 ──
const doc0 = await readDoc()
const st0 = await readStage()
const renderedAll = NOTES.every((n) => st0.ids?.includes(n.id))
record('C-H8.1a seed 进 store', doc0.objects.length === 3, `${doc0.objects.length} 个对象`)
record('C-H8.1b seed 真渲染成 Konva 节点', !!renderedAll, `Konva ids=${JSON.stringify(st0.ids)}`)

const cvBox = await page.locator('canvas').first().boundingBox()

// ── C-H8.2 拖拽节点（**必须在缩放/平移之前**：之后世界坐标已移出画面，点哪都落空）──
const stBefore = await readStage()
const n2Before = stBefore.groups.find((g) => g.id === 'n2')
const pt = await toScreen(500 + 70, 200 + 45) // n2 中心（seed 的世界坐标）
await page.mouse.move(pt.x, pt.y)
await page.mouse.down()
await page.mouse.move(pt.x + 130, pt.y + 70, { steps: 12 })
await page.mouse.up()
await page.waitForTimeout(400)
const stAfter = await readStage()
const n2Live = stAfter.groups.find((g) => g.id === 'n2')
await page.waitForTimeout(1200)
const n2Saved = (await readDoc()).objects.find((o) => o.id === 'n2')
record(
  'C-H8.2a 拖拽节点（Konva 位置变化）',
  !!n2Live && n2Live.x > n2Before.x + 50,
  `n2 x ${n2Before.x} → ${n2Live?.x}`
)
record(
  'C-H8.2b 坐标落盘（防抖后）',
  !!n2Saved && Math.abs(n2Saved.x - n2Live.x) < 2,
  `落盘 x=${n2Saved?.x}, Konva x=${n2Live?.x}`
)
await page.screenshot({ path: `${SHOT_DIR}ch8-drag-node.png` })

// ── C-H8.3 单点选中 + 删除 + 撤销 ──
// 注意：选择栏是**多选**才出现（`selBar` computed 里 `ids.length < 2 → null`），
// 所以单选不能用选择栏断言，要用「删掉了一个 + 撤销回来了」这种功能证据。
const n2now = (await readStage()).groups.find((g) => g.id === 'n2')
const pt2 = await toScreen(n2now.x + 70, n2now.y + 45)
await page.mouse.click(pt2.x, pt2.y)
await page.waitForTimeout(400)
const cntBefore = (await readDoc()).objects.length
await page.keyboard.press('Backspace')
await page.waitForTimeout(1200)
const cntAfter = (await readDoc()).objects.length
await page.keyboard.press('Control+z')
await page.keyboard.press('Meta+z')
await page.waitForTimeout(1200)
const cntUndo = (await readDoc()).objects.length
record('C-H8.3a 单点选中 + 删除', cntAfter === cntBefore - 1, `数量 ${cntBefore} → ${cntAfter}`)
record('C-H8.3b 撤销恢复', cntUndo === cntBefore, `${cntAfter} → ${cntUndo}`)

// ── C-H8.4 Shift+拖 框选（起点必须落在**空地**且不被浮层遮挡）──
// 起手判定是 `if (e.target !== st) return`——点在节点上不会进框选分支；
// 而画布顶部工具条是压在图上的 DOM 浮层，所以起手点别贴着画布左上角。
// 起止点都从**画布容器矩形**推，终点必须留在容器内（留 20px 余量）——上一版把终点算到
// world(1000,120)（屏幕 1425 > 容器右边界 1423）跑出了画布：rubber 不结算、还会把后续
// 的「空格+拖 平移」一起吞掉（表现为 stage 位移 0，极易误读成平移坏了）。
const cr = await page.evaluate(() => {
  const r = window.Konva.stages[0].container().getBoundingClientRect()
  return { left: r.left, top: r.top, w: r.width, h: r.height }
})
const p0 = { x: cr.left + 120, y: cr.top + 640 } // 空地（便签都在 y ≤ 540）
const p1 = { x: cr.left + cr.w - 20, y: cr.top + 100 }
const hitTest = ([x, y]) => {
  const el = document.elementFromPoint(x, y)
  return el ? `${el.tagName}` : null
}
const hitAtStart = await page.evaluate(hitTest, [p0.x, p0.y])
const hitAtEnd = await page.evaluate(hitTest, [p1.x, p1.y])
record(
  'C-H8.4a 框选起止点都落在画布内（未被浮层遮）',
  hitAtStart === 'CANVAS' && hitAtEnd === 'CANVAS',
  `起手命中=${hitAtStart}, 终点命中=${hitAtEnd}`
)
await page.keyboard.down('Shift')
await page.mouse.move(p0.x, p0.y)
await page.mouse.down()
await page.mouse.move(p1.x, p1.y, { steps: 14 })
await page.mouse.up()
await page.keyboard.up('Shift')
await page.waitForTimeout(700)
const selBar = page.locator('[data-testid="selection-bar"]')
const selVisible = (await selBar.count()) > 0 && (await selBar.isVisible())
const selCount = selVisible ? Number((await selBar.innerText()).trim().split(/\s+/)[0]) : 0
record(
  'C-H8.4b 框选 → 选择栏出现且 ≥2',
  selVisible && selCount >= 2,
  `选择栏=${selVisible}, 计数=${selCount}`
)
await page.screenshot({ path: `${SHOT_DIR}ch8-box-select.png` })
const cntBeforeAll = (await readDoc()).objects.length
await page.keyboard.press('Backspace')
await page.waitForTimeout(1200)
const cntAllGone = (await readDoc()).objects.length
await page.keyboard.press('Control+z')
await page.keyboard.press('Meta+z')
await page.waitForTimeout(1200)
const cntRestored = (await readDoc()).objects.length
record(
  'C-H8.4c 框选后一次删除全部选中对象',
  cntAllGone === 0 && cntBeforeAll === 3,
  `${cntBeforeAll} → ${cntAllGone}`
)
record('C-H8.4d 撤销全部恢复', cntRestored === cntBeforeAll, `${cntAllGone} → ${cntRestored}`)

// ── C-H8.5 滚轮缩放（实时 + 落盘）──
const cx = cvBox.x + cvBox.width / 2
const cy = cvBox.y + cvBox.height / 2
const scaleBefore = (await readStage()).scale
await page.mouse.move(cx, cy)
await page.mouse.wheel(0, -400)
await page.waitForTimeout(400)
const scaleLive = (await readStage()).scale
await page.waitForTimeout(1200) // saveSoon 500ms 防抖
const scaleSaved = (await readDoc()).viewport?.scale
record('C-H8.5a 滚轮缩放（实时）', scaleLive > scaleBefore, `${scaleBefore} → ${scaleLive}`)
record(
  'C-H8.5b 缩放落盘（防抖后）',
  Math.abs((scaleSaved ?? 0) - scaleLive) < 0.01,
  `落盘=${scaleSaved}, 实时=${scaleLive}`
)

// ── C-H8.6 空格+拖 平移（实时 + 落盘）──
const posBefore = (await readStage()).pos
await page.keyboard.down(' ')
await page.mouse.move(cx, cy)
await page.mouse.down()
await page.mouse.move(cx + 140, cy + 90, { steps: 10 })
await page.mouse.up()
await page.keyboard.up(' ')
await page.waitForTimeout(400)
const posLive = (await readStage()).pos
await page.waitForTimeout(1200)
const vpSaved = (await readDoc()).viewport
const panDx = Math.abs(posLive.x - posBefore.x) + Math.abs(posLive.y - posBefore.y)
record('C-H8.6a 空格+拖 平移（实时）', panDx > 10, `stage 位移 ${Math.round(panDx)}px`)
record(
  'C-H8.6b 平移落盘（防抖后）',
  Math.abs((vpSaved?.x ?? 0) - posLive.x) < 2 && Math.abs((vpSaved?.y ?? 0) - posLive.y) < 2,
  `落盘=(${Math.round(vpSaved?.x)},${Math.round(vpSaved?.y)}) 实时=(${Math.round(posLive.x)},${Math.round(posLive.y)})`
)
await page.screenshot({ path: `${SHOT_DIR}ch8-zoom-pan.png` })

// ── C-H8.7 JS 健康 ──
const newErrors = jsErrors.length - bootErrors
record(
  'C-H8.7 交互阶段无新增 JS 异常',
  newErrors === 0,
  newErrors ? jsErrors.slice(bootErrors)[0] : '无'
)

await browser.close()
const pass = results.filter((r) => r.pass).length
console.log(`\n=== 无限画布交互回归: ${pass}/${results.length} 通过 ===`)
process.exit(pass === results.length ? 0 : 1)
