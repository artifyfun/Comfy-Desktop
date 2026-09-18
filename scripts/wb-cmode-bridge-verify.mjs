/**
 * W16 验收：C 模式（workbench iframe `?embed=1` + 注入桥）下 wb_sync / wb_canvas_exec 的
 * **成功路径**（W15 只覆盖了非嵌入态的降级语义，这条是遗留清单里剩下的那半）
 *
 * 为什么不能只在 /workbench 单页里验：`isEmbed` 的判定是
 *   `url 带 embed=1 || window.parent !== window`
 * （workbench/index.vue:1498）——同窗口（`/canvas` 侧栏那种 Vue 组件内嵌）**不算嵌入**，
 * `syncWorkflowToCanvas` 会直接 skipped/reject。真嵌入态必须是 **iframe + 注入桥**。
 *
 * 所以本脚本用**假宿主帧**做 C 侧：
 *   父页（测试控）监听 `artify:canvas-ops` / `artify:canvas-execute`，按协议回 ack
 *   （`callBridge` 只按 `type + requestId` 关联，不校验 origin —— bridgeCall.js:37-47）
 *   iframe 指向 `${harness}/workbench?embed=1`
 *
 * 断言：
 *   ① 与宿主桥通上（宿主收到 `artify:canvas-ops`）
 *   ② wb_sync{ensureTab:true} → ops[0] = loadWorkflow，带 `workflow.nodes/links`、
 *      `newTab:true`、`reason:'workbench-sync-template'`；ack ok → **零错误气泡**（成功路径）
 *   ③ wb_sync（无 ensureTab）→ 同形状但 `newTab` 缺省 → 仍成功
 *   ④ wb_canvas_exec → 宿主收到 `artify:canvas-execute` → ack `{ok:true,promptId}` →
 *      前端推「画布工作流已提交执行」+ 产物卡（'画布当前工作流'）
 *   ⑤ 负路径：宿主改回 `{ok:false,error}` → 错误气泡「同步到画布失败」/「执行画布工作流失败」
 *   ⑥ 全程无新增页面错误
 *
 * 用法：node scripts/wb-cmode-bridge-verify.mjs [port=5177]
 * 前置：node acceptance/workbench/serve.mjs 5177（后台任务方式起）
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const arg = process.argv[2] || '5177'
const BASE = /^https?:\/\//.test(arg) ? arg : `http://127.0.0.1:${arg}`
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

const HOST_HTML = `<!doctype html><html><body style="margin:0">
<iframe id="wb" src="${BASE}/workbench?embed=1" style="width:900px;height:900px;border:0"></iframe>
<script>
  // 假注入桥（C 侧）：按 artify:* 协议收请求、回 ack。
  // ⚠️ 必须包 IIFE：本脚本会被 setContent 注入多次（每段重新拿干净 iframe），
  // 顶层 const 第二次执行直接 SyntaxError（Identifier 'ACK' has already been declared）
  // → 监听没装上 → 表现为 bridge timeout（排查了一轮）。
  (function () {
    window.__host = { got: [], mode: 'ok', error: '宿主拒绝（测试）', promptId: 'p-w16-fake' }
    const ACK = { 'artify:canvas-ops': 'artify:canvas-ops-result', 'artify:canvas-execute': 'artify:canvas-execute-result' }
    window.addEventListener('message', function (e) {
      let d = e.data
      if (typeof d === 'string') { try { d = JSON.parse(d) } catch { return } }
      if (!d || !d.type) return
      window.__host.got.push(d)
      const ackType = ACK[d.type]
      if (!ackType) return
      const fail = window.__host.mode !== 'ok'
      const exec = ackType.indexOf('execute') >= 0
      const payload = fail
        ? { ok: false, error: window.__host.error }
        : exec
          ? { ok: true, promptId: window.__host.promptId, outputs: [] }
          : { ok: true, applied: (d.ops || []).length, checkpointId: 'cp-w16' }
      e.source && e.source.postMessage(JSON.stringify(Object.assign({ type: ackType, requestId: d.requestId }, payload)), '*')
    })
  })()
</script></body></html>`

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 160)))

await page.setContent(HOST_HTML, { waitUntil: 'load' })
await page.waitForTimeout(5000) // 等 iframe 内 workbench boot + 关遮罩

let frame = page.frames().find((f) => f.url().includes('/workbench'))
record(
  'W16.0 iframe（workbench?embed=1）已挂载并被宿主帧接管',
  !!frame,
  frame ? frame.url() : '未找到 frame/未挂载'
)

if (!frame) {
  await browser.close()
  console.log('\n════ W16 汇总：0/1 ════')
  process.exit(1)
}

const host = {
  async got() {
    return page.evaluate(() =>
      window.__host.got.map((d) => ({ type: d.type, ops: d.ops, reason: d.reason, name: d.name }))
    )
  },
  async reset() {
    await page.evaluate(() => (window.__host.got = []))
  },
  async setMode(mode, error) {
    await page.evaluate(
      ([m, e]) => {
        window.__host.mode = m
        if (e) window.__host.error = e
      },
      [mode, error || '']
    )
  }
}
const frameText = (f) => f.evaluate(() => document.body.innerText || '')

/** 关掉 iframe 内的首屏遮罩（使用指南等），否则点不到 composer */
for (let i = 0; i < 3; i++) {
  const btn = frame.locator('.ant-modal-close')
  if (!(await btn.count())) break
  await btn
    .first()
    .click({ timeout: 3000 })
    .catch(() => {})
  await page.waitForTimeout(400)
}
const bootErrors = pageErrors.length

/** 在 iframe 里发一条消息（composer 无 testid，按 title 找发送按钮） */
async function send(text) {
  const ta = frame.locator('textarea:visible').first()
  await ta.click()
  await ta.fill(text)
  await page.waitForTimeout(200)
  const btn = frame.locator('button[title="发送"]').first()
  if (await btn.count()) await btn.click()
  else await ta.press('Enter')
  await page.waitForTimeout(400)
}

// ═══════════ ① wb_sync + ensureTab:true → loadWorkflow 整图同步（成功路径）═══════════
{
  await host.reset()
  await send('同步画布兜底：把这个工作流同步到宿主画布')
  await page.waitForTimeout(3500)
  const got = await host.got()
  const req = got.find((g) => g.type === 'artify:canvas-ops')
  const op = req?.ops?.[0]
  const shapeOk =
    !!op &&
    op.type === 'loadWorkflow' &&
    op.newTab === true &&
    op.name === 'W15 兜底同步' &&
    Array.isArray(op.workflow?.nodes) &&
    op.workflow.nodes.length === 2 &&
    req.reason === 'workbench-sync-template'
  record(
    'W16.1 wb_sync{ensureTab:true} → 宿主收到 CANVAS_OPS loadWorkflow（newTab/name/workflow 形状正确）',
    shapeOk,
    shapeOk
      ? `ops[0]=${JSON.stringify({ type: op.type, newTab: op.newTab, name: op.name, nodes: op.workflow.nodes.length })}`
      : `收到=${JSON.stringify(got.map((g) => g.type))} ops=${JSON.stringify(req?.ops)?.slice(0, 160)}`
  )
  const txt = await frameText(frame)
  record(
    'W16.2 宿主 ack ok → **零错误气泡**（成功路径不报错）',
    !txt.includes('同步到画布失败'),
    txt.includes('同步到画布失败') ? '出现了错误气泡（宿主已 ack ok，不该报错）' : '无错误气泡 ✓'
  )
  await page.screenshot({ path: `${SHOT_DIR}w16-sync-success.png` })
}

// ═══════════ ② wb_sync（无 ensureTab）→ 同样成功，但 newTab 缺省 ═══════════
{
  await host.reset()
  await send('同步画布显式：不要兜底，失败就报错给我')
  await page.waitForTimeout(3500)
  const got = await host.got()
  const op = got.find((g) => g.type === 'artify:canvas-ops')?.ops?.[0]
  const txt = await frameText(frame)
  record(
    'W16.3 wb_sync（无 ensureTab）→ 桥消息里 newTab 缺省、仍 ack ok 不报错',
    !!op &&
      op.type === 'loadWorkflow' &&
      op.newTab === undefined &&
      !txt.includes('同步到画布失败'),
    op ? `newTab=${String(op.newTab)}` : `宿主未收到（${JSON.stringify(got.map((g) => g.type))}）`
  )
}

// ═══════════ ③ 负路径：宿主拒绝 → 两条事件各自报错 ═══════════
// ⚠️ 顺序很关键：本段必须排在「执行成功」段**之前** —— canvas-exec 成功会进"执行中"轮询态，
// 之后的发送被 `!sessionId || busy` 挡住 → 消息根本发不出去（首轮就在这卡住，误判成桥的问题）。
// 也**不能**靠重新 setContent 拿干净 iframe：stub 会把会话历史还原回来，状态反而更脏。
{
  await host.setMode('fail', '宿主拒绝（测试）')

  await send('同步画布显式：不要兜底，失败就报错给我')
  await page.waitForTimeout(3500)
  let txt = await frameText(frame)
  const syncFail = txt.includes('同步到画布失败') && txt.includes('宿主拒绝（测试）')
  record(
    'W16.4 宿主 ack {ok:false} → 错误气泡「同步到画布失败: 宿主拒绝（测试）」（透出宿主错误原文）',
    syncFail,
    syncFail ? '错误气泡带宿主原文 ✓' : `未命中；尾部=${JSON.stringify(txt.slice(-160))}`
  )

  await send('跑一下画布上的工作流')
  await page.waitForTimeout(3500)
  txt = await frameText(frame)
  const execFail = txt.includes('执行画布工作流失败') && txt.includes('宿主拒绝（测试）')
  record(
    'W16.5 执行失败同理 → 错误气泡「执行画布工作流失败: 宿主拒绝（测试）」',
    execFail,
    execFail ? '错误气泡带宿主原文 ✓' : `未命中；尾部=${JSON.stringify(txt.slice(-160))}`
  )
  await page.screenshot({ path: `${SHOT_DIR}w16-bridge-reject.png` })
  await host.setMode('ok')
}

// ═══════════ ④ wb_canvas_exec 成功 → 宿主 ack promptId → 排队回执（放最后：会留下执行中态）═══════════
{
  await host.reset()
  await send('跑一下画布上的工作流')
  await page.waitForTimeout(4500)
  const got = await host.got()
  const req = got.find((g) => g.type === 'artify:canvas-execute')
  const txt = await frameText(frame)
  const queued = txt.includes('画布工作流已提交执行')
  record(
    'W16.6 wb_canvas_exec → 宿主收到 CANVAS_EXECUTE 且 ack(promptId) 后推「画布工作流已提交执行」',
    !!req && queued,
    req
      ? `宿主收到=${req.type}；排队文案=${queued}`
      : `宿主未收到（${JSON.stringify(got.map((g) => g.type))}）`
  )
  record(
    'W16.7 同一成功路径的进度气泡「提交执行…」可见（产物栏在 embed 窄栏下不渲染，故不作 DOM 断言）',
    txt.includes('提交执行…'),
    txt.includes('提交执行…')
      ? '进度气泡可见 ✓（产物面板仅独立工作台页渲染，见 index.vue:278 注释）'
      : '未见进度气泡'
  )
  await page.screenshot({ path: `${SHOT_DIR}w16-canvas-exec-success.png` })
}

const newErrors = pageErrors.slice(bootErrors)
record(
  'W16.8 全程无新增页面错误',
  newErrors.length === 0,
  newErrors.slice(0, 2).join(' | ') || 'none'
)

await browser.close()
const passed = results.filter((r) => r.pass).length
console.log(`\n════ W16 汇总：${passed}/${results.length} ════`)
process.exit(passed === results.length ? 0 : 1)
