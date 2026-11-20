/**
 * C-H14 验收：画布项目 切换 / 重命名 / 删除 / 批量管理（真 UI）
 *
 * 数据层语义（`deleteProject` 删唯一项目补空、`renameProject` 空标题忽略并同步 doc.name、
 * `switchProject` 未知 id 原样、`projectCardStats` 统计、迁移与 I/O 适配）**已在
 * `projectStore.test.js`(20+ 条) 与 `composables.test.js` 的 useCanvasProjects 段覆盖**，
 * 本脚本只验「只有真 DOM 能证明」的部分：
 *   ① 标题双击内联重命名 → store 的 title 与 doc.name 同步
 *   ② 卡片点击切换项目 → **画布真的重装载**（Konva 上渲染的是新项目的物件、旧物件消失）
 *   ③ 刷新后仍是切换后的项目（持久化）
 *   ④ 卡片 hover 操作区重命名（E4）→ 目标卡片标题更新
 *   ⑤ 批量管理：勾选 2 个 → 「删除所选（2）」→ 确认 → 数量正确且未选中的激活项保留
 *   ⑥ 单卡删除走 **Modal.confirm**：取消不动、确认才删
 *   ⑦ 删唯一项目 → 自动补「未命名画布」且**画布清空**（旧节点不许残留 —— 代码里有对应修复注释）
 *
 * 用法：node scripts/wb-canvas-projects-verify.mjs [--app http://127.0.0.1:3008]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
 */
import { chromium } from 'playwright'

const opt = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const SHOT_DIR = 'D:/artifyfun/Comfy-Desktop/acceptance/canvas/screenshots/'
const DOC_KEY = 'artify.canvas.projects.v1'

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const skip = (name, why) => console.log(`➖ ${name} — 跳过（${why}）`)
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

const note = (id, x, y, text) => ({ id, type: 'note', x, y, width: 160, height: 100, text })
const SEED_PROJECTS = [
  {
    id: 'p-a',
    title: '甲画布',
    doc: {
      version: 2,
      name: '甲画布',
      viewport: { scale: 1, x: 0, y: 0 },
      objects: [note('n-a1', 120, 120, 'A1'), note('n-a2', 420, 200, 'A2')],
      links: [],
      groups: []
    }
  },
  {
    id: 'p-b',
    title: '乙画布',
    doc: {
      version: 2,
      name: '乙画布',
      viewport: { scale: 1, x: 0, y: 0 },
      objects: [note('n-b1', 200, 300, 'B1')],
      links: [],
      groups: []
    }
  },
  {
    id: 'p-c',
    title: '丙画布',
    doc: {
      version: 2,
      name: '丙画布',
      viewport: { scale: 1, x: 0, y: 0 },
      objects: [],
      links: [],
      groups: []
    }
  }
]

async function main() {
  console.log(`C-H14 画布项目 切换/重命名/删除 验收 → app=${APP}`)
  const tpls = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls) || !tpls.length) throw new Error('应用不可达')
  const session = (
    await jpost('/api/workbench/sessions/create', {
      title: `[verify] C-H14 画布项目管理 ${new Date().toISOString()}`,
      entry: 'canvas'
    })
  ).data
  const sid = session.id

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })
  await context.addInitScript(
    ([projects, docKey, s]) => {
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
      // 只在没有权威 seed 时写入（刷新时保留页面自己演进过的 store）
      if (!localStorage.getItem(docKey)) {
        localStorage.setItem(
          docKey,
          JSON.stringify({
            version: 1,
            activeId: 'p-a',
            projects: projects.map((p, i) => ({
              id: p.id,
              title: p.title,
              createdAt: now,
              updatedAt: now + i,
              doc: p.doc
            }))
          })
        )
      }
      window.__session = s
    },
    [SEED_PROJECTS, DOC_KEY, sid]
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

  const readStore = () =>
    page.evaluate((k) => {
      const s = JSON.parse(localStorage.getItem(k) || '{}')
      return {
        activeId: s.activeId,
        projects: (s.projects || []).map((p) => ({
          id: p.id,
          title: p.title,
          docName: p.doc?.name,
          objects: (p.doc?.objects || []).length
        }))
      }
    }, DOC_KEY)
  /** 画布上真实渲染的物件 id（Konva 节点 id = 物件 id；切换项目后必须整批换掉） */
  const canvasNodeIds = () =>
    page.evaluate(() => {
      const st = window.Konva?.stages?.[0]
      if (!st) return []
      return st
        .find('Group')
        .map((g) => g.id())
        .filter((id) => id && /^n-/.test(id))
    })
  const openMenu = async () => {
    if ((await page.locator('[data-project-bar] div.grid-cols-2').count()) === 0) {
      await page.locator('[data-project-bar] button:has(i.fa-layer-group)').first().click()
      await page.waitForTimeout(500)
    }
  }
  const cards = () => page.locator('[data-project-bar] div.grid-cols-2 > div')
  const cardOf = (title) => cards().filter({ hasText: title }).first()
  const confirmDialog = () => page.locator('.ant-modal-confirm')
  const clickDialogOk = async () => {
    await confirmDialog().locator('button.ant-btn-dangerous').first().click()
    await page.waitForTimeout(900)
  }

  // ═══════════ ① 就位 ═══════════
  {
    const st = await readStore()
    const barTitle = (
      await page.locator('[data-project-bar] span.truncate').first().innerText()
    ).trim()
    record(
      'C-H14.0 项目栏就位（3 个项目，激活「甲画布」）',
      st.projects.length === 3 && st.activeId === 'p-a' && barTitle === '甲画布',
      `标题=${barTitle} activeId=${st.activeId} projects=${st.projects.map((p) => p.title).join('/')}`
    )
  }

  // ═══════════ ② 标题双击内联重命名 ═══════════
  {
    await page.locator('[data-project-bar] div.h-9').first().dblclick()
    await page.waitForTimeout(400)
    const input = page.locator('[data-project-bar] input').first()
    const appeared = (await input.count()) > 0
    if (appeared) {
      await input.fill('甲画布改')
      await input.press('Enter')
      await page.waitForTimeout(900)
    }
    const st = await readStore()
    const p = st.projects.find((x) => x.id === 'p-a')
    record(
      'C-H14.1 双击标题重命名 → title 与 doc.name 同步（activeId 不变）',
      appeared && p.title === '甲画布改' && p.docName === '甲画布改' && st.activeId === 'p-a',
      appeared ? `title=${p.title} doc.name=${p.docName}` : '双击未出现输入框'
    )
  }

  // ═══════════ ③ 卡片切换项目 → 画布真的重装载 ═══════════
  {
    await openMenu()
    const n = await cards().count()
    const before = await canvasNodeIds()
    await cardOf('乙画布').click()
    await page.waitForTimeout(1400)
    const st = await readStore()
    const after = await canvasNodeIds()
    const swapped =
      st.activeId === 'p-b' &&
      after.includes('n-b1') &&
      !after.includes('n-a1') &&
      !after.includes('n-a2')
    record(
      'C-H14.2 点「乙画布」卡片 → activeId 切换 + 画布重装载（Konva 上只剩乙的物件）',
      n === 3 && swapped,
      `卡片数=${n}；画布节点 ${JSON.stringify(before)} → ${JSON.stringify(after)}`
    )
  }

  // ═══════════ ④ 刷新后仍是切换后的项目 ═══════════
  {
    await page.reload({ waitUntil: 'load' })
    await page.waitForTimeout(3500)
    const st = await readStore()
    const nodes = await canvasNodeIds()
    record(
      'C-H14.3 刷新后仍是「乙画布」（持久化 + 重装载）',
      st.activeId === 'p-b' && nodes.includes('n-b1') && !nodes.includes('n-a1'),
      `activeId=${st.activeId} 画布节点=${JSON.stringify(nodes)}`
    )
  }

  // ═══════════ ⑤ 卡片 hover 操作区重命名（E4）═══════════
  {
    await openMenu()
    // ⚠️ 一旦进入重命名态，标题文本就进了 `<input value>`（innerText 看不到）——
    // 用 hasText 过滤的 locator 会当场失效。所以**先记下标，再按位置定位**。
    const idx = await cards().evaluateAll(
      (els, t) => els.findIndex((e) => (e.innerText || '').includes(t)),
      '丙画布'
    )
    const card = cards().nth(idx)
    await card.hover()
    await page.waitForTimeout(400)
    const pen = card.locator('button[title="重命名"]')
    const hasPen = (await pen.count()) > 0
    let filled = false
    let diag = ''
    if (hasPen) {
      await pen.click()
      await page.waitForTimeout(600)
      const input = cards().nth(idx).locator('input').first()
      if ((await input.count()) > 0) {
        await input.fill('丙改名')
        await input.press('Enter')
        await page.waitForTimeout(900)
        filled = true
      } else {
        diag = `卡索引=${idx} 下拉input数=${await page.locator('[data-project-bar] div.grid-cols-2 input').count()}`
        await page.screenshot({ path: `${SHOT_DIR}ch14-rename-diag.png` })
      }
    }
    const st = await readStore()
    record(
      'C-H14.4 卡片内联重命名（hover 露出笔按钮）→ 目标卡片标题更新',
      idx >= 0 && hasPen && filled && st.projects.find((x) => x.id === 'p-c')?.title === '丙改名',
      hasPen
        ? filled
          ? `丙画布 → ${st.projects.find((x) => x.id === 'p-c')?.title}`
          : `输入框未出现；诊断=${diag}`
        : '未找到笔按钮'
    )
  }

  // ═══════════ ⑥ 单卡删除：先取消（负路径）再确认 ═══════════
  {
    await openMenu()
    const card = cardOf('丙改名')
    await card.hover()
    await card.locator('button[title="删除当前画布"]').click()
    await page.waitForTimeout(700)
    const dlg = await confirmDialog().count()
    let canceled = false
    if (dlg) {
      await confirmDialog().locator('button.ant-btn-dangerous').first().waitFor({ timeout: 5000 })
      // 取消按钮 = 非 danger 的那个
      await confirmDialog()
        .locator('.ant-modal-confirm-btns button:not(.ant-btn-dangerous)')
        .first()
        .click()
      await page.waitForTimeout(700)
      canceled = (await readStore()).projects.length === 3
    }
    record(
      'C-H14.5 单卡删除走确认弹窗：**点取消不删**（3 个项目原样）',
      dlg > 0 && canceled,
      dlg ? `弹窗出现，取消后项目数=${(await readStore()).projects.length}` : '未出现确认弹窗'
    )

    await openMenu()
    const card2 = cardOf('丙改名')
    await card2.hover()
    await card2.locator('button[title="删除当前画布"]').click()
    await page.waitForTimeout(700)
    await clickDialogOk()
    const st = await readStore()
    record(
      'C-H14.6 确认删除「丙改名」→ 项目数 3 → 2 且列表里不再有它',
      st.projects.length === 2 && !st.projects.some((p) => p.id === 'p-c'),
      `projects=${st.projects.map((p) => p.title).join('/')}`
    )
  }

  // ═══════════ ⑦ 批量管理：勾 2 → 删除所选 ═══════════
  {
    await openMenu()
    // 「软渲染降级提示」横幅曾压住这个菜单表头（与工具条同源的遮挡问题）→ 提示层必须
    // pointer-events-none，只留关闭按钮可点。这里顺手量一次（横幅不出现则跳过）。
    const tipProbe = await page.evaluate(() => {
      const tip = document.querySelector('[class*="border-amber-500/40"]')
      if (!tip) return null
      const btn = [...document.querySelectorAll('[data-project-bar] button')].find((b) =>
        (b.innerText || '').includes('批量管理')
      )
      if (!btn) return { tip: true, blocked: null }
      const r = btn.getBoundingClientRect()
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return {
        tip: true,
        pointerEvents: getComputedStyle(tip).pointerEvents,
        blocked: !!hit && hit !== btn && !btn.contains(hit)
      }
    })
    if (tipProbe?.tip) {
      record(
        'C-H14.7 软渲染提示横幅不拦截指针（pointer-events:none，不挡下拉菜单表头）',
        tipProbe.pointerEvents === 'none' && tipProbe.blocked === false,
        `pointer-events=${tipProbe.pointerEvents}；表头按钮被拦截=${tipProbe.blocked}`
      )
    } else {
      skip('C-H14.7 软渲染提示横幅不拦截指针', '本机未触发降级提示')
    }

    await page.locator('[data-project-bar] button:has-text("批量管理")').first().click()
    await page.waitForTimeout(500)
    const boxes = page.locator('[data-project-bar] div.grid-cols-2 input[type="checkbox"]')
    const n = await boxes.count()
    if (n >= 1) {
      await boxes.nth(0).click()
      await page.waitForTimeout(300)
    }
    const delBtn = page.locator('[data-project-bar] button:has-text("删除所选")').first()
    const label = (await delBtn.count()) ? (await delBtn.innerText()).trim() : ''
    // 再补勾第二个（若存在）
    if (n >= 2) {
      await boxes.nth(1).click()
      await page.waitForTimeout(300)
    }
    const label2 = (await delBtn.innerText()).trim()
    await delBtn.click()
    await page.waitForTimeout(700)
    await clickDialogOk()
    const st = await readStore()
    record(
      'C-H14.8 批量管理：勾选计入按钮文案（删除所选（n）），确认后批量删除',
      // 删到空时 deleteProject 会自动补一个「未命名画布」→ 期望剩 1 个而不是 0
      n === 2 && label.includes('（1）') && label2.includes('（2）') && st.projects.length === 1,
      `勾选框=${n} 按钮文案「${label}」→「${label2}」，删除后 projects=${st.projects.length}（自动补 ${st.projects[0]?.title}）`
    )
  }

  errSeg('项目切换/重命名/批量段')

  // ═══════════ ⑧ 删到一个不剩 → 自动补空项目且画布清空 ═══════════
  {
    let st = await readStore()
    if (st.projects.length === 1) {
      await openMenu()
      const only = st.projects[0]
      const card = cards().first()
      await card.hover()
      await card.locator('button[title="删除当前画布"]').click()
      await page.waitForTimeout(700)
      await clickDialogOk()
      await page.waitForTimeout(1200)
      st = await readStore()
      const nodes = await canvasNodeIds()
      record(
        'C-H14.9 删唯一项目 → 自动补「未命名画布」且**画布清空**（旧节点不残留）',
        st.projects.length === 1 &&
          st.projects[0].id !== only.id &&
          st.projects[0].objects === 0 &&
          nodes.length === 0,
        `新项目=${st.projects[0].title}(${st.projects[0].id}) objects=${st.projects[0].objects} 画布节点=${JSON.stringify(nodes)}`
      )
    } else {
      skip(
        'C-H14.9 删唯一项目 → 自动补空项目',
        `批量删除后剩 ${st.projects.length} 个，未走到"唯一"分支`
      )
    }
    await openMenu().catch(() => {})
    await page.screenshot({ path: `${SHOT_DIR}ch14-projects.png` })
  }

  errSeg('删唯一项目段')

  const newErrors = pageErrors.slice(errorsAtBoot)
  record(
    'C-H14.10 全程无新增页面错误',
    newErrors.length === 0,
    newErrors.slice(0, 2).join(' | ') || 'none'
  )

  await browser.close()
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ C-H14 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ C-H14 脚本异常:', e.message)
  process.exit(1)
})
