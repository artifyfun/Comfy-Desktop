/**
 * C-H9 验收：补 canvas 剩下的三条盲区（真鼠标 / 真键盘 / 真 agent）
 *
 *   ① 手动连线手势 —— 从节点右句柄拖出建连线（真 mousedown/move/up）、
 *      点连线选中 + 删除、选中后拖 to 端锚点**重连**到另一节点
 *   ② 选区快捷指令条（A14）—— 单选/多选浮出 `#canvas-sel-prompt`，回车真发送给 agent，
 *      agent 回复（**用 chat 类指令**，不触发生图，快且不依赖 ComfyUI 队列）
 *   ③ 图片入画布三条路 —— 文件拖入（DataTransfer+File）、剪贴板粘贴（ClipboardEvent）、
 *      素材库拖出载荷（`application/x-artify-asset-url`，真 ComfyUI /view URL）
 *
 * 搭法同 S11：**直接从应用自身打开 /canvas**（:3008 同源伺服 SPA，SSE 原生流式），
 * electronAPI shim + 画布种子用 addInitScript 注入。句柄/连线/锚点都在 Konva 里，
 * 用 `window.Konva.stages[0]` 反查真实屏幕坐标（别用肉眼估）。
 *
 * 用法：node scripts/wb-canvas-gaps-verify.mjs [--app http://127.0.0.1:3008]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const TIMEOUT_MIN = Number(opt('--timeout-min', '10'))
const SHOT_DIR = 'D:/artifyfun/Comfy-Desktop/acceptance/canvas/screenshots/'
const COMFY_VIEW_SRC = opt(
  '--asset-url',
  'http://127.0.0.1:8188/view?filename=krea2_t2i_01054_.png&subfolder=&type=output'
)

const results = []
function record(name, pass, evidence = '') {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
function skip(name, why) {
  console.log(`➖ ${name} — 跳过（${why}）`)
}
function opt(name, def) {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : def
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
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

/** 种子：三张便签（横向排开，便于连线/重连）+ 一张 1x1 图（占位）；**零连线**（连线全部现建） */
const SEED = {
  notes: [
    { id: 'g-a', x: 200, y: 200, width: 160, height: 100, text: '节点 A：起点' },
    { id: 'g-b', x: 640, y: 200, width: 160, height: 100, text: '节点 B：中间' },
    { id: 'g-c', x: 640, y: 460, width: 160, height: 100, text: '节点 C：重连目标' }
  ]
}

async function main() {
  console.log(`C-H9 画布盲区补测 → app=${APP}`)
  const tpls = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls) || !tpls.length) throw new Error('应用不可达')

  const session = (
    await jpost('/api/workbench/sessions/create', {
      title: `[verify] C-H9 画布盲区补测 ${new Date().toISOString()}`,
      entry: 'canvas'
    })
  ).data
  const sid = session.id

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })

  await context.addInitScript(
    ([seed, sid]) => {
      if (window.__ch9Installed) return
      window.__ch9Installed = true
      window.electronAPI = {
        ArtifyLab: {
          getConfig: async () => ({
            server_origin: location.origin,
            serverHost: location.origin,
            comfyHost: 'http://127.0.0.1:8188',
            activeAppId: null,
            lang: 'zh',
            theme: 'dark',
            api_key: '',
            base_url: '',
            model: '',
            provider: ''
          }),
          getAppInfo: async () => ({ name: 'Artify Lab', version: 'verify' }),
          loadComfyUI: async () => ({ url: location.origin })
        }
      }
      try {
        const now = Date.now()
        const px =
          'data:image/svg+xml;charset=utf-8,' +
          encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="60"><rect width="100%" height="100%" fill="#3355aa"/></svg>'
          )
        localStorage.setItem(
          'artify.canvas.projects.v1',
          JSON.stringify({
            version: 1,
            activeId: 'p-ch9',
            projects: [
              {
                id: 'p-ch9',
                title: 'C-H9',
                createdAt: now,
                updatedAt: now,
                doc: {
                  version: 2,
                  name: 'C-H9',
                  viewport: { scale: 1, x: 0, y: 0 },
                  objects: [
                    ...seed.notes.map((n) => ({
                      id: n.id,
                      type: 'note',
                      x: n.x,
                      y: n.y,
                      width: n.width,
                      height: n.height,
                      text: n.text
                    })),
                    { id: 'g-img', type: 'image', x: 200, y: 460, width: 80, height: 60, src: px }
                  ],
                  links: [],
                  groups: []
                }
              }
            ]
          })
        )
      } catch (e) {
        console.warn('[ch9] seed failed', e)
      }
      window.__ch9Session = sid
    },
    [SEED, sid]
  )

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) =>
    pageErrors.push(String(e) + ' @ ' + (e.stack || '').split('\n').slice(1, 4).join(' | '))
  )
  await page.goto(`${APP}/canvas?session=${encodeURIComponent(sid)}`, {
    waitUntil: 'load',
    timeout: 30000
  })
  await page.waitForTimeout(4000)
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('.ant-modal-close, [role="dialog"] button:has(i.fa-times)').first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(400)
  }
  const errorsAtBoot = pageErrors.length
  let errMark = errorsAtBoot
  /** 分段记账：打印本段新增未捕获异常（含栈）——定位是哪一段引入的 */
  const errSeg = (label) => {
    const fresh = pageErrors.slice(errMark)
    errMark = pageErrors.length
    if (fresh.length) {
      console.log(`  ⚠️ [${label}] 新增未捕获异常 ${fresh.length} 条:`)
      for (const f of fresh) console.log('     ' + f)
    }
    return fresh.length
  }
  const ta = page.locator('textarea:visible').first()
  if (!(await ta.count())) throw new Error('内嵌工作台未渲染（画布页未就位）')
  record('C-H9.0 画布页 + 内嵌工作台就位（真会话）', true, `session=${sid}`)

  // ── 屏幕坐标工具（读 Konva stage 真值，不估）──
  const toScreen = async (wx, wy) => {
    const ctx = await page.evaluate(() => {
      const st = window.Konva?.stages?.[0]
      if (!st) return null
      const r = st.container().getBoundingClientRect()
      return { left: r.left, top: r.top, x: st.x(), y: st.y(), scale: st.scaleX() }
    })
    if (!ctx) throw new Error('读不到 Konva stage')
    return { x: ctx.left + wx * ctx.scale + ctx.x, y: ctx.top + wy * ctx.scale + ctx.y }
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
          h: o.height,
          src: o.src ? String(o.src).slice(0, 60) : undefined,
          title: o.title || o.text || ''
        })),
        links: (p?.doc?.links || []).map((l) => ({ id: l.id, from: l.from, to: l.to }))
      }
    })
  const nodeOf = (doc, id) => doc.objects.find((o) => o.id === id)
  /** 通过 Konva 找连线命中路径的中点（屏幕坐标）——贝塞尔中点靠算不如直接问 Konva */
  const linkMidScreen = async (linkId) => {
    const p = await page.evaluate((id) => {
      const st = window.Konva?.stages?.[0]
      const node = st?.findOne(`#${id}`)
      if (!node) return null
      const pt = node.getPointAtLength(node.getLength() / 2)
      const abs = node.getAbsoluteTransform().point(pt)
      const r = st.container().getBoundingClientRect()
      return { x: r.left + abs.x, y: r.top + abs.y }
    }, linkId)
    return p
  }

  // ═══════════ ① 连线手势 ═══════════
  {
    const doc0 = await readDoc()
    const A = nodeOf(doc0, 'g-a')
    const B = nodeOf(doc0, 'g-b')

    // 选中 A（句柄显现）→ 从右句柄拖到 B 中心
    const cA = await toScreen(A.x + A.w / 2, A.y + A.h / 2)
    await page.mouse.click(cA.x, cA.y)
    await page.waitForTimeout(500)
    const hSrc = await toScreen(A.x + A.w, A.y + A.h / 2)
    const cB = await toScreen(B.x + B.w / 2, B.y + B.h / 2)
    await page.mouse.move(hSrc.x, hSrc.y)
    await page.waitForTimeout(150)
    await page.mouse.down()
    await page.mouse.move(cB.x, cB.y, { steps: 14 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await page.waitForTimeout(900)
    let doc1 = await readDoc()
    const made = doc1.links.find((l) => l.from === 'g-a' && l.to === 'g-b')
    record('C-H9.1 从右句柄拖出建连线（真鼠标）', !!made, `links=${JSON.stringify(doc1.links)}`)
    await page.screenshot({ path: `${SHOT_DIR}ch9-link-created.png` })

    if (made) {
      // 点连线（Konva 求中点）→ 删除
      const mid = await linkMidScreen(made.id)
      if (mid) {
        await page.mouse.click(mid.x, mid.y)
        await page.waitForTimeout(400)
        await page.keyboard.press('Delete')
        await page.waitForTimeout(900)
        const doc2 = await readDoc()
        record(
          'C-H9.2 点连线选中 + Delete 删除',
          !doc2.links.some((l) => l.id === made.id),
          `links 数 ${doc1.links.length} → ${doc2.links.length}`
        )
      } else {
        record('C-H9.2 点连线选中 + Delete 删除', false, 'Konva 里找不到连线命中路径')
      }

      // 重连：重建 A→B，选中后拖 to 端锚点到 C
      const hSrc2 = await toScreen(A.x + A.w, A.y + A.h / 2)
      await page.mouse.click(
        (await toScreen(A.x + A.w / 2, A.y + A.h / 2)).x,
        (await toScreen(A.x + A.w / 2, A.y + A.h / 2)).y
      )
      await page.waitForTimeout(400)
      await page.mouse.move(hSrc2.x, hSrc2.y)
      await page.mouse.down()
      await page.mouse.move(cB.x, cB.y, { steps: 12 })
      await page.mouse.up()
      await page.waitForTimeout(900)
      let doc3 = await readDoc()
      const link2 = doc3.links.find((l) => l.from === 'g-a' && l.to === 'g-b')
      if (!link2) {
        record('C-H9.3 拖 to 端锚点重连到另一节点', false, '第二次建线未成功，重连无从测')
      } else {
        const mid2 = await linkMidScreen(link2.id)
        await page.mouse.click(mid2.x, mid2.y)
        await page.waitForTimeout(500)
        // to 端锚点位于目标节点左边缘中点（seg.x2,y2）
        const anchor = await toScreen(B.x, B.y + B.h / 2)
        const cC = await toScreen(
          SEED.notes[2].x + SEED.notes[2].width / 2,
          SEED.notes[2].y + SEED.notes[2].height / 2
        )
        await page.mouse.move(anchor.x, anchor.y)
        await page.waitForTimeout(150)
        await page.mouse.down()
        await page.mouse.move(cC.x, cC.y, { steps: 14 })
        await page.waitForTimeout(200)
        await page.mouse.up()
        await page.waitForTimeout(1000)
        const doc4 = await readDoc()
        const relinked = doc4.links.find((l) => l.from === 'g-a' && l.to === 'g-c')
        record(
          'C-H9.3 拖 to 端锚点重连到另一节点',
          !!relinked,
          `links=${JSON.stringify(doc4.links)}`
        )
        await page.screenshot({ path: `${SHOT_DIR}ch9-link-reconnect.png` })
      }
    }
  }

  errSeg('① 连线手势段')

  // ═══════════ ② 选区快捷指令条（A14）═══════════
  // ⚠️ 触发条件：`openSelPrompt()` 只在 **rubber（框选）分支** 调用（index.vue onMouseUp）——
  // 单选点击不浮出是设计如此，用框选来触发。
  {
    const marquee = async (x0, y0, x1, y1) => {
      const s0 = await toScreen(x0, y0)
      const s1 = await toScreen(x1, y1)
      await page.keyboard.down('Shift')
      await page.mouse.move(s0.x, s0.y)
      await page.mouse.down()
      await page.mouse.move(s1.x, s1.y, { steps: 12 })
      await page.mouse.up()
      await page.keyboard.up('Shift')
      await page.waitForTimeout(800)
    }
    // 框住 A + B（y 120~340 覆盖 200..300）
    await marquee(120, 120, 900, 340)
    const bar = page.locator('#canvas-sel-prompt')
    const up1 = (await bar.count()) > 0
    const selNow = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem('artify.canvas.projects.v1') || '{}')
      const p = (s.projects || []).find((x) => x.id === s.activeId) || s.projects?.[0]
      return (p?.doc?.objects || []).length
    })
    record('C-H9.4 框选 → 选区快捷指令条浮出', up1, up1 ? '有 #canvas-sel-prompt' : '未浮出')
    await page.screenshot({ path: `${SHOT_DIR}ch9-sel-prompt.png` })

    if (up1) {
      // 输入后重新框另一处 → 指令条仍在且输入被重置（openSelPrompt 每次 text:''）
      const input0 = page.locator('#canvas-sel-prompt input').first()
      await input0.fill('临时输入')
      await marquee(600, 400, 900, 620) // 框住 C
      await page.waitForTimeout(500)
      const stillUp = (await page.locator('#canvas-sel-prompt').count()) > 0
      const textNow = stillUp
        ? await page.locator('#canvas-sel-prompt input').first().inputValue()
        : '(bar 不在)'
      record(
        'C-H9.5 再框选 → 指令条仍在且输入重置',
        stillUp && textNow === '',
        `bar=${stillUp} 输入="${textNow}"（objects=${selNow}）`
      )

      // 真发送：chat 类指令（不触发生图）
      const input = page.locator('#canvas-sel-prompt input').first()
      await input.fill('用一句话概括我选中的这些便签写了什么')
      await input.press('Enter')
      console.log('✓ 选区指令已回车发送（期望 agent 只聊天、不出图）')

      let sent = false
      let finished = false
      let agentText = ''
      const deadline = Date.now() + TIMEOUT_MIN * 60_000
      while (Date.now() < deadline) {
        await sleep(3000)
        const approveBtn = page.locator('[data-testid="approval-approve"]:visible').first()
        if (await approveBtn.count()) {
          await approveBtn.click().catch(() => {})
          console.log('  · 人审门：已批准')
          await sleep(1200)
          continue
        }
        const body = await page.locator('body').innerText()
        sent = sent || body.includes('用一句话概括我选中的这些便签写了什么')
        if (/概括|便签|节点/.test(body) && body.length > 0) {
          // 会话侧校验更权威，下面统一查
        }
        const s = (await jget(`/api/workbench/session/${sid}`)) || {}
        const msgs = s.messages || []
        sent = sent || msgs.some((m) => String(m.text || '').includes('概括'))
        const agentMsg = msgs.filter((m) => m.role === 'agent' && m.kind !== 'error')
        if (agentMsg.length) {
          agentText = String(agentMsg[agentMsg.length - 1].text || '')
          finished = true
          break
        }
        const errMsg = msgs.find((m) => m.role === 'agent' && m.kind === 'error')
        if (errMsg) {
          agentText = 'ERR: ' + String(errMsg.text || '')
          break
        }
      }
      record(
        'C-H9.6 指令真送达 agent（会话侧可见用户消息）',
        sent,
        sent ? '会话/页面出现该指令' : '未观察到'
      )
      record(
        'C-H9.7 agent 回复（chat 类，未触发生图）',
        finished && !agentText.startsWith('ERR:'),
        agentText.slice(0, 160) || '超时未回复'
      )
      await page.screenshot({ path: `${SHOT_DIR}ch9-sel-prompt-sent.png` })
    } else {
      skip('C-H9.5 / C-H9.6 / C-H9.7', '指令条未浮出')
    }
  }

  errSeg('② 选区指令条段')

  // ═══════════ ③ 图片入画布（三条路）═══════════
  // 落点语义（2026-09-18 修后）：**落点 = 节点中心**，且坐标优先取拖放事件的 clientX/clientY
  // （原生拖拽期间浏览器不派发 pointermove，只读 Konva getPointerPosition 会落到拖动开始前的位置）。
  // 因此这里三次投放都**显式带坐标**，并把「落点 ≈ 坐标」作为断言；粘贴无坐标 → 断言贴指针。
  const DROP1 = { x: 1100, y: 320 } // 文件拖入的落点（避开 A/B/C 与 g-img，免得挡住了 ④ 段要点的 A 角柄）
  const DROP2 = { x: 860, y: 640 } // 素材库拖出的落点
  const PASTE_AT = { x: 860, y: 300 } // 粘贴时的真实指针位置
  const near = (o, p, tol = 3) =>
    Math.abs(o.x + o.w / 2 - p.x) <= tol && Math.abs(o.y + o.h / 2 - p.y) <= tol
  {
    // I1 文件拖入：合成 DataTransfer + File（走 onDrop 的 files 分支）+ 真实落点坐标
    const before = await readDoc()
    const s1 = await toScreen(DROP1.x, DROP1.y)
    await page.evaluate(
      async ({ sx, sy }) => {
        const svg =
          '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="680"><defs><linearGradient id="g"><stop offset="0" stop-color="#c33"/><stop offset="1" stop-color="#36c"/></linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/><circle cx="500" cy="340" r="200" fill="#ffd"/></svg>'
        const blob = new Blob([svg], { type: 'image/svg+xml' })
        const file = new File([blob], 'ch9-drop.svg', { type: 'image/svg+xml' })
        const dt = new DataTransfer()
        dt.items.add(file)
        const target =
          document.querySelector('[data-testid="canvas-drop-zone"]') ||
          document.querySelector('canvas')?.parentElement?.parentElement ||
          document.body
        const ev = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy }
        target.dispatchEvent(new DragEvent('dragover', ev))
        target.dispatchEvent(new DragEvent('drop', ev))
      },
      { sx: s1.x, sy: s1.y }
    )
    await page.waitForTimeout(1200)
    let after = await readDoc()
    const dropped = after.objects.filter((o) => !before.objects.some((b) => b.id === o.id))
    record(
      'C-H9.8 文件拖入画布 → 建图片节点（尺寸按真实比例缩放）',
      dropped.length === 1 &&
        dropped[0].type === 'image' &&
        dropped[0].w === 260 &&
        dropped[0].h === 173,
      dropped.length
        ? `${dropped[0].id} ${dropped[0].w}x${dropped[0].h} src=${dropped[0].src}`
        : '未新增对象'
    )
    record(
      'C-H9.8b 文件拖入落点 = 拖放事件坐标（节点中心）',
      dropped.length === 1 && near(dropped[0], DROP1),
      dropped.length
        ? `中心 (${dropped[0].x + dropped[0].w / 2}, ${dropped[0].y + dropped[0].h / 2}) vs 拖放点 (${DROP1.x}, ${DROP1.y})`
        : '未新增对象'
    )

    // I2 剪贴板粘贴：合成 ClipboardEvent（走 onPaste）；无拖放坐标 → 落点应贴着真实指针
    const before2 = await readDoc()
    const sp = await toScreen(PASTE_AT.x, PASTE_AT.y)
    await page.mouse.move(sp.x, sp.y)
    await page.waitForTimeout(250)
    await page.evaluate(() => {
      const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512"><rect width="100%" height="100%" fill="#1c8"/></svg>'
      const file = new File([new Blob([svg], { type: 'image/svg+xml' })], 'ch9-paste.svg', {
        type: 'image/svg+xml'
      })
      const dt = new DataTransfer()
      dt.items.add(file)
      window.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt })
      )
    })
    await page.waitForTimeout(1200)
    after = await readDoc()
    const pasted = after.objects.filter((o) => !before2.objects.some((b) => b.id === o.id))
    record(
      'C-H9.9 剪贴板粘贴图片 → 建图片节点',
      pasted.length === 1 && pasted[0].type === 'image' && pasted[0].w === 260,
      pasted.length ? `${pasted[0].id} ${pasted[0].w}x${pasted[0].h}` : '未新增对象'
    )
    record(
      'C-H9.9b 粘贴无拖放坐标 → 落点贴真实指针（回落到 Konva 指针）',
      pasted.length === 1 && near(pasted[0], PASTE_AT, 4),
      pasted.length
        ? `中心 (${pasted[0].x + pasted[0].w / 2}, ${pasted[0].y + pasted[0].h / 2}) vs 指针 (${PASTE_AT.x}, ${PASTE_AT.y})`
        : '未新增对象'
    )

    // I3 素材库拖出载荷（application/x-artify-asset-url，真 ComfyUI /view URL）+ 指定落点
    const before3 = await readDoc()
    const s2 = await toScreen(DROP2.x, DROP2.y)
    await page.evaluate(
      ({ url, sx, sy }) => {
        const dt = new DataTransfer()
        dt.setData('application/x-artify-asset-url', url)
        const target =
          document.querySelector('[data-testid="canvas-drop-zone"]') ||
          document.querySelector('canvas')?.parentElement?.parentElement ||
          document.body
        const ev = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: sx, clientY: sy }
        target.dispatchEvent(new DragEvent('dragover', ev))
        target.dispatchEvent(new DragEvent('drop', ev))
      },
      { url: COMFY_VIEW_SRC, sx: s2.x, sy: s2.y }
    )
    await page.waitForTimeout(1600)
    after = await readDoc()
    const fromAsset = after.objects.filter((o) => !before3.objects.some((b) => b.id === o.id))
    record(
      'C-H9.10 素材库拖出（asset-url 载荷）→ 建图片节点',
      fromAsset.length === 1 && fromAsset[0].type === 'image' && fromAsset[0].w > 0,
      fromAsset.length
        ? `${fromAsset[0].id} ${fromAsset[0].w}x${fromAsset[0].h} src=${fromAsset[0].src}`
        : '未新增对象（URL 可能不可达）'
    )
    record(
      'C-H9.10b 素材库落点 = 拖放事件坐标（节点中心）',
      fromAsset.length === 1 && near(fromAsset[0], DROP2),
      fromAsset.length
        ? `中心 (${fromAsset[0].x + fromAsset[0].w / 2}, ${fromAsset[0].y + fromAsset[0].h / 2}) vs 拖放点 (${DROP2.x}, ${DROP2.y})`
        : '未新增对象'
    )
    await page.screenshot({ path: `${SHOT_DIR}ch9-image-drop.png` })
  }

  errSeg('③ 图片入画布段')

  // ═══════════ ④ 角柄缩放（同属"无 id 的 v-group"病灶，修冒泡后必须仍可用）═══════════
  // 角柄组是 `<v-group v-for="o in resizeTargets">` —— **没有 id**，修 stopKonvaEvent 之前
  // 它的 mousedown 会冒泡到全局 onItemDown(idx())，idx 用 g.id() 反查 → -1 → 抛 TypeError；
  // 修好后要在源头被阻断，同时缩放本身必须照常工作、且**不能把节点整体拖走**（状态归属正确）。
  {
    const doc0 = await readDoc()
    const A = nodeOf(doc0, 'g-a')
    const c = await page.evaluate(() => {
      const st = window.Konva.stages[0]
      const r = st.container().getBoundingClientRect()
      return { left: r.left, top: r.top, x: st.x(), y: st.y(), scale: st.scaleX() }
    })
    const S = (wx, wy) => ({
      x: c.left + wx * c.scale + c.x,
      y: c.top + wy * c.scale + c.y
    })
    // 先选中（角柄是选中态才可见）
    const ctr = S(A.x + A.w / 2, A.y + A.h / 2)
    await page.mouse.click(ctr.x, ctr.y)
    await page.waitForTimeout(600)
    // se 角柄：圆心在 (x+w+off, y+h+off)，off = 10/scale
    const off = 10 / c.scale
    const h0 = S(A.x + A.w + off, A.y + A.h + off)
    const h1 = S(A.x + A.w + off + 120, A.y + A.h + off + 80)
    await page.mouse.move(h0.x, h0.y)
    await page.waitForTimeout(200)
    await page.mouse.down()
    await page.mouse.move(h1.x, h1.y, { steps: 16 })
    await page.waitForTimeout(200)
    await page.mouse.up()
    await page.waitForTimeout(1400) // 等 saveSoon 500ms 防抖落盘
    const doc1 = await readDoc()
    const B = nodeOf(doc1, 'g-a')
    const grew = B.w > A.w + 80 && B.h > A.h + 50
    record('C-H9.12 拖 se 角柄真缩放（尺寸变化落盘）', grew, `${A.w}x${A.h} → ${B.w}x${B.h}`)
    record(
      'C-H9.13 缩放不误触整体拖动（x/y 不动 = 状态归属正确）',
      B.x === A.x && B.y === A.y,
      `x/y ${A.x},${A.y} → ${B.x},${B.y}`
    )
    await page.screenshot({ path: `${SHOT_DIR}ch9-resize.png` })
  }

  errSeg('④ 角柄缩放段')

  // 交互段无新增页面错误
  const newErrors = pageErrors.slice(errorsAtBoot)
  record(
    'C-H9.11 全程无新增页面错误',
    newErrors.length === 0,
    newErrors.slice(0, 2).join(' | ') || 'none'
  )

  await browser.close()
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ C-H9 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ C-H9 脚本异常:', e.message)
  process.exit(1)
})
