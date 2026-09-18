/**
 * C-H10 验收：多选 / 组合 / 对齐与分布（真鼠标 + 真右键菜单 + 落盘互证）
 *
 * 覆盖「已知遗留」里的 `多选拖动 / 分组（groups） / 对齐与自动布局`：
 *   ① 框选多选（Shift+rubber）→ 选择栏出现且计数正确
 *   ② 选择栏「左对齐 / 水平居中」→ 几何断言（从动作前的 doc 现算期望值，不写死坐标）
 *   ③ 选择栏「组合」→ doc.groups 成员正确
 *   ④ 组合成员拖角柄**不缩放**（`onResizeStart` 里 `groupOf(id) → return` 是设计如此）
 *   ⑤ 拖动组内成员 → 整组同步位移（增量必须与拖动者一致）
 *   ⑥ 工具栏「解组」→ groups 清空
 *   ⑦ 右键菜单「右对齐」「水平等距分布」（走 hitTest 命中已选集合 → 整组 targetIds 那条路）
 *   ⑧ 未组合的多选拖动只移动被拖的那一个（**现状记录**：整体移动需先组合）
 *
 * 注：代码注释里的 `C-H13 多选浮动操作栏` 指的是**功能实现**编号，与验收脚本编号不是一套；
 * 本脚本验收的正是那条浮动栏与它背后的 align/distribute/group 逻辑。
 *
 * 用法：node scripts/wb-canvas-selection-verify.mjs [--app http://127.0.0.1:3008]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
 */
import { chromium } from 'playwright'

const opt = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const SHOT_DIR = 'D:/artifyfun/Comfy-Desktop/acceptance/canvas/screenshots/'

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
async function jget(p) {
  return (await (await fetch(`${APP}${p}`)).json()).data
}
async function jpost(p, body) {
  const res = await fetch(`${APP}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {})
  })
  return res.json().catch(() => ({}))
}

/** 四张便签：宽度各异（否则"先居中再左对齐"这类序列会出现 no-op 假绿）+ 互不遮挡 */
const SEED = {
  notes: [
    { id: 'g-a', x: 120, y: 120, width: 200, height: 100, text: 'A' },
    { id: 'g-b', x: 420, y: 300, width: 120, height: 80, text: 'B' },
    { id: 'g-c', x: 700, y: 140, width: 160, height: 100, text: 'C' },
    { id: 'g-d', x: 300, y: 560, width: 140, height: 90, text: 'D' }
  ]
}

async function main() {
  console.log(`C-H10 多选/组合/对齐验收 → app=${APP}`)
  const tpls = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls) || !tpls.length) throw new Error('应用不可达')

  const session = (
    await jpost('/api/workbench/sessions/create', {
      title: `[verify] C-H10 多选组合对齐 ${new Date().toISOString()}`,
      entry: 'canvas'
    })
  ).data
  const sid = session.id

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  await context.addInitScript(
    ([seed, s]) => {
      window.electronAPI = {
        ArtifyLab: {
          getConfig: async () => ({
            server_origin: location.origin,
            serverHost: location.origin,
            comfyHost: null,
            activeAppId: null,
            lang: 'zh',
            theme: 'dark',
            api_key: '',
            base_url: '',
            model: '',
            provider: ''
          }),
          getAppInfo: async () => ({ name: 'x', version: 'v' }),
          loadComfyUI: async () => ({ url: location.origin })
        }
      }
      const now = Date.now()
      localStorage.setItem(
        'artify.canvas.projects.v1',
        JSON.stringify({
          version: 1,
          activeId: 'p-h10',
          projects: [
            {
              id: 'p-h10',
              title: 'C-H10',
              createdAt: now,
              updatedAt: now,
              doc: {
                version: 2,
                name: 'C-H10',
                viewport: { scale: 1, x: 0, y: 0 },
                objects: seed.notes.map((n) => ({ ...n, type: 'note' })),
                links: [],
                groups: []
              }
            }
          ]
        })
      )
      window.__ch10Session = s
    },
    [SEED, sid]
  )

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) =>
    pageErrors.push(String(e) + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | '))
  )
  await page.goto(`${APP}/canvas?session=${encodeURIComponent(sid)}`, { waitUntil: 'load' })
  await page.waitForTimeout(4000)
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('.ant-modal-close').first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(300)
  }
  const errorsAtBoot = pageErrors.length
  let errMark = errorsAtBoot
  const errSeg = (label) => {
    const fresh = pageErrors.slice(errMark)
    errMark = pageErrors.length
    if (fresh.length) {
      console.log(`  ⚠️ [${label}] 新增未捕获异常 ${fresh.length} 条:`)
      for (const f of fresh) console.log('     ' + f)
    }
    return fresh.length
  }

  const toScreen = async (wx, wy) => {
    const c = await page.evaluate(() => {
      const st = window.Konva?.stages?.[0]
      if (!st) return null
      const r = st.container().getBoundingClientRect()
      return { left: r.left, top: r.top, x: st.x(), y: st.y(), scale: st.scaleX() }
    })
    if (!c) throw new Error('读不到 Konva stage')
    return { x: c.left + wx * c.scale + c.x, y: c.top + wy * c.scale + c.y }
  }
  const readDoc = () =>
    page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('artify.canvas.projects.v1') || '{}')
      const p = (s.projects || []).find((x) => x.id === s.activeId) || s.projects?.[0]
      return {
        objects: (p?.doc?.objects || []).map((o) => ({
          id: o.id,
          type: o.type,
          x: o.x,
          y: o.y,
          w: o.width,
          h: o.height
        })),
        groups: (p?.doc?.groups || []).map((g) => ({ id: g.id, members: [...g.members] }))
      }
    })
  const nodeOf = (doc, id) => doc.objects.find((o) => o.id === id)
  const centerOf = (o) => ({ x: o.x + o.w / 2, y: o.y + o.h / 2 })

  /** 选择栏（≥2 选中才出现）的计数 */
  const selCount = async () => {
    const bar = page.locator('[data-testid="selection-bar"]')
    if (!(await bar.count())) return 0
    const txt = (await bar.locator('span').first().innerText()).trim()
    return Number(txt) || 0
  }
  const clickSelbar = async (iconClass) => {
    await page.locator(`[data-testid="selection-bar"] button:has(i.${iconClass})`).first().click()
    await page.waitForTimeout(700)
  }
  /** Shift + 拖 框选（起止点都必须落在画布容器内） */
  const boxSelect = async (x0, y0, x1, y1) => {
    const a = await toScreen(Math.min(x0, x1), Math.min(y0, y1))
    const b = await toScreen(Math.max(x0, x1), Math.max(y0, y1))
    await page.keyboard.down('Shift')
    await page.mouse.move(a.x, a.y)
    await page.mouse.down()
    await page.mouse.move(b.x, b.y, { steps: 14 })
    await page.mouse.up()
    await page.keyboard.up('Shift')
    await page.waitForTimeout(800)
  }
  const clickObject = async (o) => {
    const c = await toScreen(o.x + o.w / 2, o.y + o.h / 2)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(500)
  }
  const openCtxOn = async (o) => {
    const c = await toScreen(o.x + o.w / 2, o.y + o.h / 2)
    await page.mouse.click(c.x, c.y, { button: 'right' })
    await page.waitForTimeout(500)
    const n = await page.locator('#canvas-ctx-menu').count()
    if (!n) throw new Error('右键菜单未打开')
  }
  const ctxClick = async (label) => {
    await page.locator(`#canvas-ctx-menu button:has-text("${label}")`).first().click()
    await page.waitForTimeout(800)
  }
  /** 真鼠标把某物件拖 (dx,dy) 世界距离 */
  const dragObject = async (o, dx, dy) => {
    const c = await toScreen(o.x + o.w / 2, o.y + o.h / 2)
    const t = await toScreen(o.x + o.w / 2 + dx, o.y + o.h / 2 + dy)
    await page.mouse.move(c.x, c.y)
    await page.waitForTimeout(200)
    await page.mouse.down()
    await page.mouse.move(t.x, t.y, { steps: 16 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await page.waitForTimeout(1200) // saveSoon 500ms 防抖
  }

  // ═══════════ ① 就位（含软渲染提示横幅的遮挡量测）═══════════
  const doc0 = await readDoc()
  record(
    'C-H10.0 画布页就位（四张便签落盘）',
    doc0.objects.length === 4 && doc0.groups.length === 0,
    `objects=${doc0.objects.map((o) => `${o.id}@${o.x},${o.y} ${o.w}x${o.h}`).join(' ')}`
  )
  {
    // 「软件渲染降级提示」是 top-16 居中的 z-20 横幅（原先在 top-3），右上悬浮工具条是
    // top-3 right-3 的 flex 行（≈830px 宽、20 个按钮）——两处同在 top-3 时在 1600px 视口下
    // 重叠 2 万 px²，实测 14/20 个按钮被横幅接住点不到。已把横幅下移；这里持续看守。
    // 量 box model + elementFromPoint（别目测），并**跳过禁用按钮**（禁用态 pointer-events:none）。
    const m = await page.evaluate(() => {
      const tip = document.querySelector('[class*="border-amber-500/40"]')
      const btn = document.querySelector('button[title*="解组"]')
      const bar = btn?.parentElement
      if (!tip || !bar) return { tip: !!tip, bar: !!bar }
      const a = tip.getBoundingClientRect()
      const b = bar.getBoundingClientRect()
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      const blocked = []
      let enabled = 0
      let disabled = 0
      for (const el of bar.querySelectorAll('button')) {
        // 禁用按钮带 `disabled:pointer-events-none` → elementFromPoint 必然返回容器，
        // 那是"禁用"不是"被遮挡"，必须分开统计（首轮就在这里误报 6 个）
        if (el.disabled) {
          disabled++
          continue
        }
        enabled++
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        if (hit && !el.contains(hit) && hit !== el) blocked.push(el.getAttribute('title') || '?')
      }
      return {
        tip: true,
        bar: true,
        overlap: Math.round(ox * oy),
        buttons: bar.querySelectorAll('button').length,
        enabled,
        disabled,
        blocked
      }
    })
    if (!m.tip) {
      console.log('➖ C-H10.0b 软渲染提示未出现（本机未触发降级）→ 跳过遮挡断言')
    } else {
      record(
        'C-H10.0b 软渲染降级提示横幅不遮挡右上悬浮工具条',
        m.overlap === 0 && m.blocked.length === 0,
        `与工具条重叠面积=${m.overlap}px²；可用按钮 ${m.enabled}/${m.buttons} 个（${m.disabled} 个禁用），被遮挡 ${m.blocked.length} 个${
          m.blocked.length ? '：' + m.blocked.slice(0, 5).join(' / ') : ''
        }`
      )
      await page
        .locator('[class*="border-amber-500/40"] button')
        .first()
        .click()
        .catch(() => {})
      await page.waitForTimeout(400)
    }
  }

  // ═══════════ ② 右键菜单：水平等距分布（3 选中）═══════════
  await boxSelect(80, 80, 900, 450)
  const sel3 = await selCount()
  record('C-H10.1 Shift 框选 A/B/C → 选择栏计数 3', sel3 === 3, `选择栏计数=${sel3}`)
  {
    const before = await readDoc()
    const picked = ['g-a', 'g-b', 'g-c'].map((id) => nodeOf(before, id))
    await openCtxOn(picked[1])
    await ctxClick('水平等距分布')
    const after = await readDoc()
    const sorted = picked.map((p) => nodeOf(after, p.id)).sort((a, b) => a.x - b.x)
    const gap1 = sorted[1].x - (sorted[0].x + sorted[0].w)
    const gap2 = sorted[2].x - (sorted[1].x + sorted[1].w)
    const firstHeld = sorted[0].x === Math.min(...picked.map((p) => p.x))
    const lastHeld = sorted[2].x === Math.max(...picked.map((p) => p.x))
    record(
      'C-H10.2 右键菜单「水平等距分布」→ 等距且首尾不动',
      Math.abs(gap1 - gap2) <= 0.6 && firstHeld && lastHeld,
      `gap=${gap1.toFixed(1)}/${gap2.toFixed(1)} 首=${firstHeld} 尾=${lastHeld}`
    )
  }

  // ═══════════ ② b 收敛选择集到恰好 A/B（顺便覆盖 Shift+点选 累加）═══════════
  {
    // 注意：点「已在选区里」的物件不会缩小选区（onItemDown 只在 id 不在选区时才改），
    // 所以先点空地清空，再单选 A、Shift+点 B。
    const empty = await toScreen(1000, 300)
    await page.mouse.click(empty.x, empty.y)
    await page.waitForTimeout(400)
    const cur = await readDoc()
    await clickObject(nodeOf(cur, 'g-a'))
    const bObj = nodeOf(await readDoc(), 'g-b')
    const bc = await toScreen(bObj.x + bObj.w / 2, bObj.y + bObj.h / 2)
    await page.keyboard.down('Shift')
    await page.mouse.click(bc.x, bc.y)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(500)
    const sel2 = await selCount()
    record('C-H10.2b Shift+点选累加到 2 个（收敛选择集）', sel2 === 2, `选择栏计数=${sel2}`)
  }

  // ═══════════ ③ 右键菜单：右对齐（走命中已选集合 → 整组 targetIds）═══════════
  {
    const before = await readDoc()
    const a = nodeOf(before, 'g-a')
    const b = nodeOf(before, 'g-b')
    await openCtxOn(a)
    await ctxClick('右对齐')
    const after = await readDoc()
    const na = nodeOf(after, 'g-a')
    const nb = nodeOf(after, 'g-b')
    const maxR = Math.max(a.x + a.w, b.x + b.w)
    record(
      'C-H10.3 右键「右对齐」（多选整组生效）→ 右边缘齐平',
      Math.abs(na.x + na.w - maxR) <= 0.6 && Math.abs(nb.x + nb.w - maxR) <= 0.6,
      `右缘 ${(na.x + na.w).toFixed(1)} / ${(nb.x + nb.w).toFixed(1)} = maxR ${maxR.toFixed(1)}`
    )
  }

  // ═══════════ ④ 选择栏：水平居中 → 左对齐（同一宽度下"后做左对齐"才有意义，故用异宽便签）═══════════
  {
    const before = await readDoc()
    const a = nodeOf(before, 'g-a')
    const b = nodeOf(before, 'g-b')
    const minX = Math.min(a.x, b.x)
    const maxX = Math.max(a.x + a.w, b.x + b.w)
    const cx = (minX + maxX) / 2

    await clickSelbar('fa-align-center') // 水平居中
    let doc = await readDoc()
    let na = nodeOf(doc, 'g-a')
    let nb = nodeOf(doc, 'g-b')
    const c1 = na.x + na.w / 2
    const c2 = nb.x + nb.w / 2
    record(
      'C-H10.4 选择栏「水平居中」→ 两者中心 x 相同且 = 选区包围盒中心',
      Math.abs(c1 - c2) <= 0.6 && Math.abs(c1 - cx) <= 0.6,
      `中心 ${c1.toFixed(1)} / ${c2.toFixed(1)} vs 包围盒中心 ${cx.toFixed(1)}`
    )

    const preLeft = await readDoc()
    const minX2 = Math.min(nodeOf(preLeft, 'g-a').x, nodeOf(preLeft, 'g-b').x)
    await clickSelbar('fa-align-left') // 左对齐
    doc = await readDoc()
    na = nodeOf(doc, 'g-a')
    nb = nodeOf(doc, 'g-b')
    record(
      'C-H10.5 选择栏「左对齐」→ 左边缘齐平（异宽便签，非 no-op）',
      Math.abs(na.x - nb.x) <= 0.6 && Math.abs(na.x - minX2) <= 0.6,
      `x=${na.x} / ${nb.x} vs minX ${minX2}（宽 ${na.w} vs ${nb.w}）`
    )
  }

  // ═══════════ ⑤ 选择栏：组合 ═══════════
  await clickSelbar('fa-object-group')
  {
    const doc = await readDoc()
    const g = doc.groups[0]
    const ok =
      doc.groups.length === 1 &&
      g &&
      g.members.length === 2 &&
      g.members.includes('g-a') &&
      g.members.includes('g-b')
    record('C-H10.6 选择栏「组合」→ doc.groups 成员正确', ok, JSON.stringify(doc.groups))
  }

  // ═══════════ ⑥ 组合成员拖角柄不缩放（设计如此：groupOf(id) → return）═══════════
  {
    const before = await readDoc()
    const a = nodeOf(before, 'g-a')
    const vp = await page.evaluate(() => {
      const st = window.Konva.stages[0]
      return { scale: st.scaleX() }
    })
    const off = 10 / vp.scale
    const h0 = await toScreen(a.x + a.w + off, a.y + a.h + off)
    const h1 = await toScreen(a.x + a.w + off + 120, a.y + a.h + off + 80)
    await clickObject(a)
    await page.mouse.move(h0.x, h0.y)
    await page.waitForTimeout(200)
    await page.mouse.down()
    await page.mouse.move(h1.x, h1.y, { steps: 14 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await page.waitForTimeout(900)
    const after = await readDoc()
    const na = nodeOf(after, 'g-a')
    record(
      'C-H10.7 组合成员拖角柄不缩放（设计：分组成员整组变换，禁止单独改尺寸）',
      na.w === a.w && na.h === a.h,
      `${a.w}x${a.h} → ${na.w}x${na.h}`
    )
  }

  // ═══════════ ⑦ 拖动组内成员 → 整组同步位移 ═══════════
  {
    const before = await readDoc()
    const a = nodeOf(before, 'g-a')
    const b = nodeOf(before, 'g-b')
    const d = nodeOf(before, 'g-d') // 组外对照（g-d 从未入组）
    await dragObject(a, 80, 60)
    const after = await readDoc()
    const na = nodeOf(after, 'g-a')
    const nb = nodeOf(after, 'g-b')
    const nd = nodeOf(after, 'g-d')
    const dA = { x: na.x - a.x, y: na.y - a.y }
    const dB = { x: nb.x - b.x, y: nb.y - b.y }
    const groupMoved = Math.abs(dA.x - dB.x) <= 0.6 && Math.abs(dA.y - dB.y) <= 0.6
    const actuallyMoved = dA.x > 30 && dA.y > 20
    const dHeld = nd.x === d.x && nd.y === d.y
    record(
      'C-H10.8 拖动组内成员 → 整组同步位移（增量一致）+ 组外物件不动',
      groupMoved && actuallyMoved && dHeld,
      `ΔA=(${dA.x.toFixed(1)},${dA.y.toFixed(1)}) ΔB=(${dB.x.toFixed(1)},${dB.y.toFixed(1)}) 组外未动=${dHeld}`
    )
  }

  // ═══════════ ⑧ 工具栏解组 ═══════════
  {
    const before = await readDoc()
    await page.locator('button:has(i.fa-object-ungroup)').first().click()
    await page.waitForTimeout(800)
    const after = await readDoc()
    record(
      'C-H10.9 工具栏「解组」→ groups 清空',
      before.groups.length === 1 && after.groups.length === 0,
      `groups ${before.groups.length} → ${after.groups.length}`
    )
  }

  // ═══════════ ⑨ 未组合的多选拖动：只移动被拖的那一个（现状记录）═══════════
  {
    // 用「点空地清空 → 单选 A → Shift+点 B」构造 2 选（比框选稳：框选起点若落在物件上
    // 会走 onItemDown 而不是 rubber，选区直接为空 —— 首轮就在这儿踩过）
    const empty = await toScreen(1000, 300)
    await page.mouse.click(empty.x, empty.y)
    await page.waitForTimeout(400)
    const cleared = (await selCount()) === 0
    await clickObject(nodeOf(await readDoc(), 'g-a'))
    const bObj0 = nodeOf(await readDoc(), 'g-b')
    const bc = await toScreen(bObj0.x + bObj0.w / 2, bObj0.y + bObj0.h / 2)
    await page.keyboard.down('Shift')
    await page.mouse.click(bc.x, bc.y)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(500)
    const selN = await selCount()

    const before = await readDoc()
    const a2 = nodeOf(before, 'g-a')
    const b2 = nodeOf(before, 'g-b')
    await dragObject(a2, 70, 0)
    const after = await readDoc()
    const na = nodeOf(after, 'g-a')
    const nb = nodeOf(after, 'g-b')
    const aMoved = na.x - a2.x > 30
    const bHeld = nb.x === b2.x && nb.y === b2.y
    record(
      `C-H10.10 未组合的多选拖动：仅被拖者移动（现状；清空=${cleared} 计数=${selN}）`,
      cleared && selN === 2 && aMoved && bHeld,
      `A Δx=${(na.x - a2.x).toFixed(1)}；B 未动=${bHeld} → 要整体移动需先「组合」`
    )
    await page.screenshot({ path: `${SHOT_DIR}ch10-multiselect.png` })
  }

  errSeg('多选/组合/对齐段')

  const newErrors = pageErrors.slice(errorsAtBoot)
  record(
    'C-H10.11 全程无新增页面错误',
    newErrors.length === 0,
    newErrors.slice(0, 2).join(' | ') || 'none'
  )

  await browser.close()
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ C-H10 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ C-H10 脚本异常:', e.message)
  process.exit(1)
})
