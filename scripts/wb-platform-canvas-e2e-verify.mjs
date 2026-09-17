/**
 * S11 验收：**画布 AI 真实生成 → 产物回画布**（W10 只是 stub SSE 级；这是最后一块真链路拼图）
 *
 * 搭法（v2，v1 的教训见下）：**直接从应用自身打开 /canvas**——应用在 :3008 同时伺服 SPA，
 * 页面与后端同源，agent 的 AG-UI SSE 原生流式，不需要任何代理。
 * `window.electronAPI` 用 addInitScript 注入（页面脚本跑之前生效，boot 走 Electron config
 * 路径，不会跳 /about）；画布种子项目同样经 addInitScript 写入。
 *
 * v1 教训：用 playwright route 把 /api 代理到真应用 —— route.fulfill 缓冲 SSE，
 * 长时间 run 期间连接被断，后端因客户端断开取消整轮（「连接中断，本轮决策未完成」）。
 *
 * 链路：
 *   真会话 → ${APP}/canvas?session=<sid> → 内嵌工作台发真实指令
 *     → POST /api/workbench/agent/run（真 agent + 真 ComfyUI，SSE 流式）
 *     → canvas ops（CUSTOM 帧）→ .agent-ops-card 确认卡 → 点「执行」
 *     → applyCanvasAgentOps → 画布 doc（localStorage）真落 app 节点
 *
 * 用法：node scripts/wb-platform-canvas-e2e-verify.mjs [--app http://127.0.0.1:3008] [--comfy http://127.0.0.1:8188]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）+ ComfyUI 就绪
 */
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188').replace(/\/$/, '')
const COMFY_OUTPUT = 'D:/Comfy-Desktop/ComfyUI-Shared/output'
const IMG_APP = opt('--img-app', 'Krea2文生图1024')
const PROMPT_TEXT = opt('--prompt', 'a red cube on a white table')
const TIMEOUT_MIN = Number(opt('--timeout-min', '18'))

const SHOT_DIR = 'D:/artifyfun/Comfy-Desktop/acceptance/workbench/screenshots/'
const results = []
function record(name, pass, evidence = '') {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
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

async function main() {
  console.log(`S11 画布 AI 真实生成验证 → app=${APP} comfy=${COMFY}`)
  // 前置（/api/config 是 SPA fallback 假 200，用 templates 探活）
  const tpls = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls) || !tpls.length) throw new Error('应用不可达')
  const tmpl = tpls.find((t) => t.name === IMG_APP)
  if (!tmpl) throw new Error(`模板不存在: ${IMG_APP}`)
  const st = await (await fetch(`${COMFY}/system_stats`)).json()
  console.log(`ComfyUI ${st.system?.comfyui_version} 就绪 | 靶模板 ${IMG_APP} (${tmpl.id})`)

  // 真会话（画布 ?session= 上下文用它）
  const session = (
    await jpost('/api/workbench/sessions/create', {
      title: `[verify] S11 画布真实生成 ${new Date().toISOString()}`,
      entry: 'canvas'
    })
  ).data
  const sid = session.id
  console.log(`真会话: ${sid}`)

  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({ viewport: { width: 1600, height: 950 } })

  // electronAPI shim + 画布种子项目：必须在页面脚本之前（addInitScript 满足）
  await context.addInitScript(
    ([sid]) => {
      if (window.__s11Installed) return
      window.__s11Installed = true
      // 与 acceptance/canvas/stub.js 同款最小 electronAPI（boot 走 Electron config 路径）
      window.electronAPI = {
        ArtifyLab: {
          getConfig: async () => ({
            server_origin: location.origin, // = 真应用 :3008，同源 → SSE 原生流式
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
          getAppInfo: async () => ({ name: 'Artify Lab', version: 'verify' }),
          loadComfyUI: async () => ({ url: location.origin })
        }
      }
      // 种一个空画布项目（stub 每次都写 activeId=p-main，对齐它的键形）
      try {
        const now = Date.now()
        localStorage.setItem(
          'artify.canvas.projects.v1',
          JSON.stringify({
            version: 1,
            activeId: 'p-main',
            projects: [
              {
                id: 'p-main',
                title: 'S11 真实生成',
                createdAt: now,
                updatedAt: now,
                doc: {
                  version: 2,
                  name: 'S11 真实生成',
                  viewport: { scale: 1, x: 0, y: 0 },
                  objects: [],
                  links: [],
                  groups: []
                }
              }
            ]
          })
        )
      } catch (e) {
        console.warn('[s11] seed failed', e)
      }
      window.__s11Session = sid
    },
    [sid]
  )

  const page = await context.newPage()
  const pageErrors = []
  page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))
  await page.goto(`${APP}/canvas?session=${encodeURIComponent(sid)}`, {
    waitUntil: 'load',
    timeout: 30000
  })
  await page.waitForTimeout(4000)
  // 关首屏遮罩（若有）
  for (let i = 0; i < 4; i++) {
    const btn = page.locator('.ant-modal-close, [role="dialog"] button:has(i.fa-times)').first()
    if (!(await btn.count())) break
    await btn.click().catch(() => {})
    await page.waitForTimeout(400)
  }
  const errorsAtBoot = pageErrors.length

  // embed 侧栏就位
  const ta = page.locator('textarea:visible').first()
  if (!(await ta.count())) {
    const probe = await page.evaluate(() => ({
      url: location.href,
      head: (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 160)
    }))
    await page.screenshot({ path: `${SHOT_DIR}s11-diagnose.png` })
    throw new Error('内嵌工作台输入框未渲染: ' + JSON.stringify(probe))
  }
  record('S11.1 应用源 /canvas + 内嵌工作台就位（同源真 SSE）', true, `session=${sid}`)

  const docBefore = await readDoc(page)
  record(
    'S11.2 确认前画布无本模板的 app 节点（人审门前置）',
    !(docBefore.objects || []).some((o) => o.appId === tmpl.id),
    `确认前 objects=${docBefore.objects?.length ?? 0}`
  )

  // 发真实指令
  await ta.fill(
    `用模板「${IMG_APP}」生成一张图片：${PROMPT_TEXT}。生成完成后，把这次的工作流节点铺到画布上。`
  )
  await page.waitForTimeout(300)
  await page
    .locator('button:has(i.fa-arrow-up), button[title="发送"], button[title="Send"]')
    .first()
    .click()
  console.log('✓ 已发送真实指令（LLM + ComfyUI 全链，同源 SSE 流式）')

  // 等确认卡（真 agent：LLM 决策 + Krea2 出图，量级分钟）。
  // 期间会出现**工具审批卡**（wb_execute_template 默认要人审，v2 就是没处理它耗到超时）——
  // 自动点「批准」，与 agent-verify 脚本的 tool_approval_required 回执同语义。
  let cardText = ''
  let cardUp = false
  let approvals = 0
  const deadline = Date.now() + TIMEOUT_MIN * 60_000
  while (Date.now() < deadline) {
    await sleep(4000)
    // 工具审批卡（侧栏内）：批准它让 run 继续
    const approveBtn = page.locator('[data-testid="approval-approve"]:visible').first()
    if (await approveBtn.count()) {
      const tool = await page
        .locator('[data-testid="approval-tool-name"]:visible')
        .first()
        .innerText()
        .catch(() => '?')
      await approveBtn.click().catch(() => {})
      approvals++
      console.log(`  · 人审门：已批准 ${tool.trim()}（第 ${approvals} 次）`)
      await sleep(1500)
      continue
    }
    const card = page.locator('.agent-ops-card').first()
    if (await card.count()) {
      cardText = ((await card.innerText()) || '').replace(/\s+/g, ' ').trim()
      cardUp = cardText.length > 0
      break
    }
  }
  record(
    'S11.3 画布确认卡出现（真实 agent 的 canvas ops）',
    cardUp,
    `${cardText.slice(0, 120) || '超时未出现'}（期间批准工具 ${approvals} 次）`
  )
  if (!cardUp) {
    const s = (await jget(`/api/workbench/session/${sid}`)) || {}
    console.log('诊断 executions:', JSON.stringify(s.executions, null, 1).slice(0, 600))
    console.log(
      '诊断 messages 尾部:',
      JSON.stringify((s.messages || []).slice(-3), null, 1).slice(0, 600)
    )
    await browser.close()
    return finish()
  }

  // 确认前人审门仍然有效
  const docMid = await readDoc(page)
  record(
    'S11.4 确认前 ops 未落布（人审门有效）',
    !(docMid.objects || []).some((o) => o.appId === tmpl.id),
    `objects=${docMid.objects?.length ?? 0}`
  )

  // 点「执行 / 确认」
  const cardButtons = page.locator('.agent-ops-card button')
  const btnTexts = (await cardButtons.allInnerTexts()).map((x) => x.trim())
  const confirmBtn = cardButtons.filter({ hasText: /^\s*(执行|确认)\s*$/ }).first()
  if (!(await confirmBtn.count())) {
    record('S11.5 确认卡有「执行/确认」按钮', false, `按钮=${JSON.stringify(btnTexts)}`)
    await browser.close()
    return finish()
  }
  await confirmBtn.click()
  await page.waitForTimeout(1500)
  await page.screenshot({ path: `${SHOT_DIR}s11-canvas-ops-applied.png` })

  // 画布 doc 落布
  let after = null
  for (let i = 0; i < 20; i++) {
    after = await readDoc(page)
    if ((after.objects || []).some((o) => o.appId === tmpl.id)) break
    await sleep(500)
  }
  const appObjs = (after.objects || []).filter((o) => o.type === 'app' && o.appId === tmpl.id)
  record(
    'S11.5 确认后 app 节点落画布（doc 落盘）',
    appObjs.length > 0,
    `新增 app 节点=${appObjs.length}（objects 总数 ${after.objects?.length}，links ${after.links?.length}）`
  )

  // 会话执行记录：真出图 + 产物落盘
  let exec = null
  for (let i = 0; i < 40; i++) {
    const s = (await jget(`/api/workbench/session/${sid}`)) || {}
    exec = (s.executions || []).find(
      (e) => e.templateId === tmpl.id || (e.outputs || []).length > 0
    )
    if (exec && ['success', 'error', 'failed'].includes(exec.status)) break
    await sleep(3000)
  }
  record(
    'S11.6 会话登记真实执行（success）',
    !!exec && exec.status === 'success',
    exec ? `status=${exec.status} promptId=${exec.promptId}` : '无执行记录'
  )
  const outFile = (exec?.outputs || []).find(
    (f) => f.type === 'output' || (typeof f === 'object' && f.filename?.match(/krea2_t2i/))
  )
  const fname = outFile?.filename
  let l3ok = false
  let l3ev = '无 output 产物'
  if (fname) {
    const local = join(COMFY_OUTPUT, outFile.subfolder || '', fname)
    if (existsSync(local)) {
      const kb = (statSync(local).size / 1024).toFixed(0)
      l3ok = Number(kb) > 50
      l3ev = `${local}（${kb}KB）`
    } else {
      l3ev = `history 记了 ${fname} 但磁盘上没有: ${local}`
    }
  }
  record('S11.7 生成产物落盘（type=output 真文件）', l3ok, l3ev)

  // 交互段无新增页面错误
  const newErrors = pageErrors.slice(errorsAtBoot)
  record(
    'S11.8 交互段无新增页面错误',
    newErrors.length === 0,
    newErrors.slice(0, 2).join(' | ') || 'none'
  )

  await browser.close()
  return finish()
}

async function readDoc(page) {
  return page.evaluate(() => {
    const raw = localStorage.getItem('artify.canvas.projects.v1')
    if (!raw) return { objects: [], links: [] }
    const store = JSON.parse(raw)
    const p = (store.projects || []).find((x) => x.id === store.activeId) || store.projects?.[0]
    return {
      objects: (p?.doc?.objects || []).map((o) => ({ id: o.id, type: o.type, appId: o.appId })),
      links: (p?.doc?.links || []).map((l) => ({ from: l.from, to: l.to }))
    }
  })
}

function finish() {
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ S11 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ S11 脚本异常:', e.message)
  process.exit(1)
})
