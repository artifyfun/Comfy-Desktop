/**
 * C-H12 验收：撤销/重做（会话内快照栈）+ AI 快照面板回滚（持久检查点）
 *
 * 这两条是**数据安全网**：撤销栈（60 上限、会话内、混合所有操作）与 AI 快照
 * （`aiSnapshots.js`，按项目分组、单项目 10 上限、AI 批量改画布前自动打的命名检查点）。
 * 快照存储层的容量/FIFO/坏数据语义由 `aiSnapshots.test.js` 单测覆盖；本脚本只验 UI 路径。
 *
 *   ① 撤销/重做：对齐 → Ctrl+Z 回到前态 → Ctrl+Shift+Z 回到后态（全部以落盘态互证）
 *   ② redo 截断：撤销后做**新动作** → 旧 redo 不可再恢复（`pushHistory` 清 future）
 *   ③ 栈底/栈顶边界：连按 Ctrl+Z / Ctrl+Shift+Z 不崩、文档仍合法
 *   ④ AI 快照面板：预置快照 → 面板渲染 → 「恢复此快照」→ 文档回到快照态
 *   ⑤ 回滚本身可撤销（`restoreAiSnapshot` 内有 `beforeChange()`）
 *   ⑥ 删除单条快照 → 存储里该项目列表清空、面板消失
 *
 * 用法：node scripts/wb-canvas-snapshot-verify.mjs [--app http://127.0.0.1:3008]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
 */
import { chromium } from 'playwright'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const opt = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const SHOT_DIR = 'D:/artifyfun/Comfy-Desktop/acceptance/canvas/screenshots/'
const SNAP_KEY = 'artify.canvas.aiSnapshots.v1'
const DOC_KEY = 'artify.canvas.projects.v1'

/**
 * 快照按项目 id 分组（`appStore.config.activeAppId || 'default'`）——真机上 activeAppId 是
 * 真实 app uuid，**不是** 'default'，种错键面板就不会渲染（首轮踩过）。这里从应用自己的
 * 配置读真实 pid，读不到再回落 'default'。
 */
function activeProjectId() {
  const forced = opt('--pid', null)
  if (forced) return forced
  try {
    const p = join(homedir(), 'AppData', 'Roaming', 'artify-desktop', 'artify-apps.json')
    if (existsSync(p)) {
      const cfg = JSON.parse(readFileSync(p, 'utf8'))?.config || {}
      if (cfg.activeAppId) return String(cfg.activeAppId)
    }
  } catch {
    /* 回落 */
  }
  return 'default'
}
const PID = activeProjectId()

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

const SEED_NOTES = [
  { id: 'g-a', x: 120, y: 120, width: 200, height: 100, text: 'A' },
  { id: 'g-b', x: 420, y: 300, width: 120, height: 80, text: 'B' },
  { id: 'g-c', x: 700, y: 140, width: 160, height: 100, text: 'C' },
  { id: 'g-d', x: 300, y: 560, width: 140, height: 90, text: 'D' }
]
/** 快照里的"AI 动手前"状态：只有两个物件，便于"回滚后文档应变成它"这种强断言 */
const SNAP_DOC = {
  version: 2,
  name: 'snapdoc',
  viewport: { scale: 1, x: 0, y: 0 },
  objects: [
    { id: 'k-1', type: 'note', x: 60, y: 60, width: 120, height: 80, text: '旧 1' },
    { id: 'k-2', type: 'note', x: 260, y: 60, width: 120, height: 80, text: '旧 2' }
  ],
  links: [],
  groups: []
}

async function main() {
  console.log(`C-H12 撤销/重做 + AI 快照回滚验收 → app=${APP} pid=${PID}`)
  const tpls = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls) || !tpls.length) throw new Error('应用不可达')
  const session = (
    await jpost('/api/workbench/sessions/create', {
      title: `[verify] C-H12 撤销与快照 ${new Date().toISOString()}`,
      entry: 'canvas'
    })
  ).data
  const sid = session.id

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  await context.addInitScript(
    ([notes, snapDoc, docKey, snapKey, s, pid]) => {
      window.electronAPI = {
        ArtifyLab: {
          getConfig: async () => ({
            server_origin: location.origin,
            serverHost: location.origin,
            comfyHost: null,
            activeAppId: null, // → 快照按 'default' 分组（见 useAppNodes：activeAppId || 'default'）
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
        docKey,
        JSON.stringify({
          version: 1,
          activeId: 'p-h12',
          projects: [
            {
              id: 'p-h12',
              title: 'C-H12',
              createdAt: now,
              updatedAt: now,
              doc: {
                version: 2,
                name: 'C-H12',
                viewport: { scale: 1, x: 0, y: 0 },
                objects: notes.map((n) => ({ ...n, type: 'note' })),
                links: [],
                groups: []
              }
            }
          ]
        })
      )
      // 预置一条 AI 快照（真实写入路径见 applyCanvasAgentOps；此处只验面板与回滚 UI）
      localStorage.setItem(
        snapKey,
        JSON.stringify({
          version: 1,
          projects: {
            [pid]: [
              {
                id: 'snap-seed-1',
                label: 'AI 操作前（3 条指令）',
                at: now,
                doc: JSON.stringify(snapDoc)
              }
            ]
          }
        })
      )
      window.__session = s
    },
    [SEED_NOTES, SNAP_DOC, DOC_KEY, SNAP_KEY, sid, PID]
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
    page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k) || '{}')
      const p = (s.projects || []).find((x) => x.id === s.activeId) || s.projects?.[0]
      return {
        objects: (p?.doc?.objects || []).map((o) => ({
          id: o.id,
          x: o.x,
          y: o.y,
          w: o.width,
          h: o.height
        })),
        groups: (p?.doc?.groups || []).map((g) => ({ id: g.id, members: [...g.members] }))
      }
    }, DOC_KEY)
  const readSnapStore = () =>
    page.evaluate((k) => {
      try {
        const d = JSON.parse(localStorage.getItem(k) || '{}')
        return Object.fromEntries(
          Object.entries(d.projects || {}).map(([pid, list]) => [pid, list.map((x) => x.id)])
        )
      } catch {
        return {}
      }
    }, SNAP_KEY)
  const nodeOf = (doc, id) => doc.objects.find((o) => o.id === id)
  const undo = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Control+z')
      await page.waitForTimeout(320)
    }
    await page.waitForTimeout(1000) // saveSoon 500ms 防抖
  }
  const redo = async (n = 1) => {
    for (let i = 0; i < n; i++) {
      await page.keyboard.press('Control+Shift+z')
      await page.waitForTimeout(320)
    }
    await page.waitForTimeout(1000)
  }
  const clickObject = async (o) => {
    const c = await toScreen(o.x + o.w / 2, o.y + o.h / 2)
    await page.mouse.click(c.x, c.y)
    await page.waitForTimeout(450)
  }
  const shiftClickObject = async (o) => {
    const c = await toScreen(o.x + o.w / 2, o.y + o.h / 2)
    await page.keyboard.down('Shift')
    await page.mouse.click(c.x, c.y)
    await page.keyboard.up('Shift')
    await page.waitForTimeout(450)
  }
  const clickSelbar = async (iconClass) => {
    await page.locator(`[data-testid="selection-bar"] button:has(i.${iconClass})`).first().click()
    await page.waitForTimeout(800)
  }

  // ═══════════ ① 就位 ═══════════
  const doc0 = await readDoc()
  record(
    'C-H12.0 画布就位（4 便签落盘；AI 快照预置 1 条）',
    doc0.objects.length === 4 && (await readSnapStore())[PID]?.length === 1,
    `objects=${doc0.objects.length} 快照=${JSON.stringify(await readSnapStore())}`
  )

  // ═══════════ ② 撤销/重做：对齐 → Ctrl+Z → Ctrl+Shift+Z ═══════════
  {
    const a0 = nodeOf(await readDoc(), 'g-a')
    const b0 = nodeOf(await readDoc(), 'g-b')
    await clickObject(a0)
    await shiftClickObject(b0)
    const preAlign = await readDoc()
    const minX = Math.min(nodeOf(preAlign, 'g-a').x, nodeOf(preAlign, 'g-b').x)
    await clickSelbar('fa-align-left')
    const postAlign = await readDoc()
    const aligned =
      Math.abs(nodeOf(postAlign, 'g-a').x - minX) <= 0.6 &&
      Math.abs(nodeOf(postAlign, 'g-b').x - minX) <= 0.6

    await undo()
    const afterUndo = await readDoc()
    const reverted =
      nodeOf(afterUndo, 'g-a').x === nodeOf(preAlign, 'g-a').x &&
      nodeOf(afterUndo, 'g-b').x === nodeOf(preAlign, 'g-b').x
    record(
      'C-H12.1 对齐后 Ctrl+Z → 坐标回到对齐前（落盘）',
      aligned && reverted,
      `对齐后 x=${nodeOf(postAlign, 'g-a').x}/${nodeOf(postAlign, 'g-b').x} → 撤销后 ${nodeOf(afterUndo, 'g-a').x}/${nodeOf(afterUndo, 'g-b').x}（对齐前 ${nodeOf(preAlign, 'g-a').x}/${nodeOf(preAlign, 'g-b').x}）`
    )

    await redo()
    const afterRedo = await readDoc()
    const redone =
      nodeOf(afterRedo, 'g-a').x === nodeOf(postAlign, 'g-a').x &&
      nodeOf(afterRedo, 'g-b').x === nodeOf(postAlign, 'g-b').x
    record(
      'C-H12.2 Ctrl+Shift+Z → 重做回对齐后（落盘）',
      redone,
      `x=${nodeOf(afterRedo, 'g-a').x}/${nodeOf(afterRedo, 'g-b').x}（期望 ${nodeOf(postAlign, 'g-a').x}/${nodeOf(postAlign, 'g-b').x}）`
    )
  }

  // ═══════════ ③ redo 截断：撤销后做新动作 → 旧 redo 不可恢复 ═══════════
  {
    await undo() // 撤销刚才的对齐
    const beforeNew = await readDoc()
    // 新动作：组合（走 Ctrl+G，与按钮等价）
    await clickObject(nodeOf(beforeNew, 'g-a'))
    await shiftClickObject(nodeOf(beforeNew, 'g-b'))
    await page.keyboard.press('Control+g')
    await page.waitForTimeout(900)
    const afterGroup = await readDoc()
    await redo(2) // future 已被新动作清空 → 不该有任何变化
    const afterRedo = await readDoc()
    const groupKept = afterRedo.groups.length === 1 && afterGroup.groups.length === 1
    record(
      'C-H12.3 撤销后做新动作 → redo 栈被截断（新动作不被重做吃掉）',
      groupKept && afterRedo.groups[0].members.length === 2,
      `新动作后 groups=${afterGroup.groups.length} → 再按重做后 groups=${afterRedo.groups.length}`
    )
  }

  // ═══════════ ④ 栈底/栈顶边界：连按到底不崩 ═══════════
  {
    const before = await readDoc()
    await undo(14) // 撤销栈撑不到 14 步，测"到底后继续按"
    const atBottom = await readDoc()
    const stillSound =
      atBottom.objects.length >= 2 &&
      atBottom.objects.every((o) => Number.isFinite(o.x) && Number.isFinite(o.w))
    record(
      'C-H12.4 连按 Ctrl+Z 到底 → 不崩、文档仍合法（物件数可为基线态）',
      stillSound,
      `objects ${before.objects.length} → ${atBottom.objects.length}（栈底继续按无副作用）`
    )
    await redo(20) // 同理测栈顶
    const atTop = await readDoc()
    record(
      'C-H12.5 连按 Ctrl+Shift+Z 到顶 → 不崩、文档仍合法',
      atTop.objects.every((o) => Number.isFinite(o.x)) && atTop.objects.length >= 2,
      `objects=${atTop.objects.length} groups=${atTop.groups.length}`
    )
  }

  // ═══════════ ⑤ AI 快照面板：渲染 + 一键回滚 ═══════════
  const panel = page.locator('.agent-ops-card:has-text("AI 快照")')
  if ((await panel.count()) > 0) {
    const rows = await panel.locator('div.ops-lines > div').count()
    record('C-H12.6 AI 快照面板渲染（预置 1 条 → 面板可见且 1 行）', rows === 1, `面板行数=${rows}`)

    const beforeRestore = await readDoc()
    await panel.locator('button:has-text("恢复此快照")').first().click()
    await page.waitForTimeout(1400)
    const afterRestore = await readDoc()
    const restored =
      afterRestore.objects.length === 2 && afterRestore.objects.some((o) => o.id === 'k-1')
    record(
      'C-H12.7 点「恢复此快照」→ 文档回到快照态（4 → 2 物件）',
      restored,
      `objects ${beforeRestore.objects.length} → ${afterRestore.objects.length}（${afterRestore.objects.map((o) => o.id).join(',')}）`
    )

    await undo()
    const afterUndoRestore = await readDoc()
    record(
      'C-H12.8 回滚本身可被撤销（restoreAiSnapshot 内有 beforeChange）',
      afterUndoRestore.objects.length === beforeRestore.objects.length,
      `撤销后 objects=${afterUndoRestore.objects.length}（回滚前 ${beforeRestore.objects.length}）`
    )

    // 删除单条快照 → 存储清空 + 面板消失
    await page.locator('.agent-ops-card button:has(i.fa-trash)').first().click()
    await page.waitForTimeout(900)
    const store = await readSnapStore()
    const panelGone = (await page.locator('.agent-ops-card:has-text("AI 快照")').count()) === 0
    record(
      'C-H12.9 删除快照 → 存储该项目清空 + 面板消失',
      (store[PID] || []).length === 0 && panelGone,
      `projects=${JSON.stringify(store)} 面板消失=${panelGone}`
    )
    await page.screenshot({ path: `${SHOT_DIR}ch12-snapshot.png` })
  } else {
    // 面板没渲染 → 打全诊断（卡片文本 / 存储键 / 语言），别只报一个 false 就卡在超时
    const diag = await page.evaluate(
      ([snapKey, docKey]) => {
        let projectKeys = []
        let raw = ''
        try {
          raw = localStorage.getItem(snapKey) || '(null)'
          projectKeys = Object.keys(JSON.parse(raw).projects || {})
        } catch (e) {
          raw = '解析失败: ' + e.message
        }
        let docActive = ''
        try {
          docActive = JSON.parse(localStorage.getItem(docKey) || '{}').activeId || '(无)'
        } catch {
          /* 忽略 */
        }
        return {
          cards: [...document.querySelectorAll('.agent-ops-card')].map((el) =>
            (el.innerText || '').replace(/\s+/g, ' ').slice(0, 60)
          ),
          projectKeys,
          raw: raw.slice(0, 100),
          docActive,
          lang: document.documentElement.lang || '(未设)'
        }
      },
      [SNAP_KEY, DOC_KEY]
    )
    record(
      'C-H12.6 AI 快照面板渲染（预置 1 条 → 面板可见且 1 行）',
      false,
      `未渲染；.agent-ops-card=${JSON.stringify(diag.cards)}；存储 projects 键=${JSON.stringify(diag.projectKeys)}；raw=${diag.raw}；activeId=${diag.docActive}；lang=${diag.lang}`
    )
    for (const n of [
      'C-H12.7 点「恢复此快照」→ 文档回到快照态',
      'C-H12.8 回滚本身可被撤销',
      'C-H12.9 删除快照 → 存储清空 + 面板消失'
    ])
      console.log(`➖ ${n} — 跳过（面板未渲染）`)
  }

  errSeg('撤销/快照段')

  const newErrors = pageErrors.slice(errorsAtBoot)
  record(
    'C-H12.10 全程无新增页面错误',
    newErrors.length === 0,
    newErrors.slice(0, 2).join(' | ') || 'none'
  )

  await browser.close()
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ C-H12 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ C-H12 脚本异常:', e.message)
  process.exit(1)
})
