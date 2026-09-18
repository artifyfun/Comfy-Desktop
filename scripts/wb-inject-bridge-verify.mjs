/**
 * W18 验收：**真注入桥**端到端（把 W16 的"假宿主"换成真产物）
 *
 * 背景：W15 验非嵌入态降级语义、W16 用**假宿主帧**验工作台这一侧的协议形状，
 * W17 用单测验桥的实现语义 —— 但「真桥产物在浏览器里跑」这条一直没验。
 * 2026-09-19 修掉 `digest.js` 裸引用 `artifyEmbedWindow`（打包器作用域合并掩盖）
 * 之后，更需要一条**用真产物**的端到端来守住它。
 *
 * 搭法（全部同源，避免跨源/代理坑）：
 *   本脚本自带一台静态服务器，同时负责
 *     ① `/__host`      → 假 ComfyUI 宿主页（桩 window.app / LiteGraph + 真 inject 产物）
 *     ② `/__inject.js` → **真构建产物** `src/main/artifylab/public/frontend/comfy_inject.min.js`
 *     ③ `/api/canvas/*`, `/queue` → express stub（记录桥发出的请求体，供断言）
 *     ④ 其余           → app 构建产物 + `acceptance/workbench/stub.js` 注入（同 harness）
 *   宿主页把真桥注册成 sidebar tab → 桥建出工作台 iframe（`/workbench?embed=1`）
 *   → 桥与工作台真通信（postMessage / 真 applyCanvasOps / 真 graphToPrompt）
 *
 * 与 W16 的关系：W16 = 假宿主 + 真工作台；W18 = **真桥** + 真工作台 + 桩 ComfyUI。
 * 两者互补；仍不覆盖「真 ComfyUI 页面 + 真队列」。
 *
 * 用法：node scripts/wb-inject-bridge-verify.mjs [port=5180]
 * 前置：`pnpm run build:frontend`（要 `comfy_inject.min.js` 与 app 产物都是最新）
 */
import { createServer } from 'node:http'
import { execSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const ROOT = fileURLToPath(new URL('../src/main/artifylab/public/frontend/', import.meta.url))
const STUB = fileURLToPath(new URL('../acceptance/workbench/stub.js', import.meta.url))
const INJECT = join(ROOT, 'comfy_inject.min.js')
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))
const PORT = Number(process.argv[2] || 5180)
const BASE = `http://127.0.0.1:${PORT}`

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

/** 桥发出的 express 请求记账（断言对象） */
const expressLog = []

// ── W18.0 静态守卫：inject 目录不得有"未声明标识符"（no-undef）──
// 本次病灶（16 处：api_workflow / canvas_patches 无条件使用 context 的导出却漏 import）
// 单测抓不到（这些引用在函数体内，只有调用才抛），浏览器脚本要等到跑出 ReferenceError 才发现。
// 静态扫描能在 3 秒内给出**全量清单** —— 根 eslint 忽略了 packages/frontend/**，
// pre-commit 的 `eslint .` 看不到这里，所以把它挂进本脚本。
try {
  let json = ''
  try {
    json = execSync('npx eslint src/inject --format json', {
      cwd: fileURLToPath(new URL('../packages/frontend/', import.meta.url)),
      encoding: 'utf-8',
      maxBuffer: 32 * 1024 * 1024
    })
  } catch (e) {
    json = e.stdout || '' // eslint 有 error 时退出码非 0，但 stdout 仍是 JSON
  }
  const report = JSON.parse(json)
  const hits = []
  for (const f of report)
    for (const m of f.messages || [])
      if (m.ruleId === 'no-undef')
        hits.push(`${f.filePath.split('inject')[1]}:${m.line} ${m.message}`)
  record(
    'W18.0 静态守卫：inject 各模块无"未声明标识符"（no-undef，漏 import 会退化成全局）',
    hits.length === 0,
    hits.length ? `${hits.length} 处：${hits.slice(0, 4).join(' | ')}` : 'no-undef 0 处'
  )
} catch (e) {
  record(
    'W18.0 静态守卫：inject 各模块无"未声明标识符"',
    false,
    `eslint 执行失败：${String(e).slice(0, 120)}`
  )
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
}
const STUB_TAG = '<script src="/__workbench_stub.js"></script>'

/**
 * 假 ComfyUI 宿主页。
 * 关键：桥的启动判定是「#vue-app 存在 + __COMFYUI_FRONTEND_VERSION__ + LiteGraph 的
 * 节点类型数稳定 5 tick + window.app.graph」，顶层非 iframe → standalone 分支；
 * `registerSidebarTab` 必须是函数，桥才会注册 tab（并在其中挂 message 监听）。
 */
const HOST_HTML = `<!doctype html><html><head><meta charset="utf-8"><title>W18 fake ComfyUI host</title>
<style>body{margin:0;font:12px sans-serif}#vue-app{height:8px}#sidebar-holder{width:900px;height:820px}</style>
</head><body>
<div id="vue-app"></div>
<div id="sidebar-holder"></div>
<script>
// ── 桩 ComfyUI 全局（形状照真前端惯例，只保桥会读到的字段）──
window.__COMFYUI_FRONTEND_VERSION__ = 'w18-fake-1.0.0'
window.__ARTIFY_LAB_API__ = ${JSON.stringify(BASE)}   // 桥的 express 目标 = 本脚本服务器（同源）
window.__ARTIFY_LAB_URL__ = ${JSON.stringify(BASE)}   // 工作台 iframe 源 = 本脚本服务器（同源）
// 真机 ComfyUI 页由 preload 注入 electronAPI（src/preload/comfyPreload.ts:142），
// inject 的 isElectron 与 apiRequest 的 baseUrl 都依赖它：
// 缺了它会回落到硬编码 http://localhost:3000（api_workflow.js:38）→ fetch 直接失败。
window.electronAPI = {
  ArtifyLab: { getConfig: async function () { return { server_origin: ${JSON.stringify(BASE)}, activeAppId: null } } },
}
window.__w18 = { tabs: [], loadGraphCalls: [], graphClear: 0, created: 0, prompts: 0 }

;(function () {
  function makeNode(type) {
    return {
      id: ++window.__w18.created,
      type: type,
      pos: [0, 0],
      size: [200, 100],
      widgets: [],
      inputs: [],
      outputs: [],
      connect: function () {},
      configure: function () {},
      setDirtyCanvas: function () {},
    }
  }
  var LGraphNode = function () { this.widgets = []; this.inputs = []; this.outputs = [] }
  LGraphNode.prototype.connect = function () {}
  LGraphNode.prototype.onDrawBackground = function () {}
  window.LGraphNode = LGraphNode
  window.LiteGraph = {
    registered_node_types: {
      KSampler: {},
      CheckpointLoaderSimple: {},
      CLIPTextEncode: {},
      SaveImage: {},
    },
    createNode: function (t) { return makeNode(t) },
    registerNodeType: function () {},
    LGraphNode: LGraphNode,
    LGraphCanvas: { prototype: { getNodeMenuOptions: function () { return [] } } },
  }
  window.LGraph = window.LiteGraph

  // ── 画布：两个节点，够 buildCanvasDigest 取 models/keyParams ──
  var nodes = [
    { id: 1, type: 'KSampler', widgets_values: [7, 20, 7.5, 'euler'], pos: [0, 0], size: [210, 100], inputs: [], outputs: [] },
    { id: 2, type: 'CheckpointLoaderSimple', widgets_values: ['w18-model.safetensors'], pos: [0, 160], size: [240, 100], inputs: [], outputs: [] },
  ]
  window.app = {
    graph: {
      _nodes: nodes,
      links: {},
      add: function (n) { this._nodes.push(n) },
      remove: function (n) { var i = this._nodes.indexOf(n); if (i >= 0) this._nodes.splice(i, 1) },
      clear: function () { window.__w18.graphClear++; this._nodes.length = 0 },
      change: function () {},
      setDirtyCanvas: function () {},
    },
    canvas: { ds: { visible_area: [0, 0, 1200, 800], fitToBounds: function () {} }, selected_nodes: {} },
    extensionManager: {
      workflow: { activeWorkflow: { name: 'w18-host-wf' } },
      getSidebarTabs: function () { return window.__w18.tabs },
      // 假宿主替真 ComfyUI 侧栏框架调用 render（真桥就是靠它建工作台 iframe）
      registerSidebarTab: function (tab) {
        window.__w18.tabs.push({ id: tab.id, title: tab.title, type: tab.type })
        var holder = document.getElementById('sidebar-holder')
        try { tab.render(holder) } catch (e) { window.__w18.renderError = String(e) }
      },
    },
    api: { addEventListener: function () {} },
    // 真 graphToPrompt 返回 {workflow, output}；桩保形状
    graphToPrompt: async function () {
      window.__w18.prompts++
      return {
        workflow: { id: 'w18-wf', version: 1, nodes: [{ id: 1, type: 'KSampler' }], links: [] },
        output: { 1: { class_type: 'KSampler', inputs: { seed: 7, steps: 20 } } },
      }
    },
    // loadWorkflowGraph 的官方分支会走这里（workflow 带 version）
    loadGraphData: async function (wf) { window.__w18.loadGraphCalls.push(wf); return true },
  }
})()
</script>
<script src="/__inject.js"></script>
</body></html>`

async function serveFile(res, filePath) {
  const body = await readFile(filePath)
  if (extname(filePath) === '.html') {
    const txt = body.toString()
    const injected = txt.includes('</body>')
      ? txt.replace('</body>', STUB_TAG + '</body>')
      : txt + STUB_TAG
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    return res.end(injected)
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  const pathname = decodeURIComponent(url.pathname)

  // ① 宿主页
  if (pathname === '/__host') {
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    return res.end(HOST_HTML)
  }
  // ② 真注入产物
  if (pathname === '/__inject.js') {
    try {
      res.writeHead(200, { 'Content-Type': MIME['.js'] })
      return res.end(await readFile(INJECT))
    } catch {
      res.writeHead(404)
      return res.end('inject bundle not found — 先跑 pnpm run build:frontend')
    }
  }
  if (pathname === '/__workbench_stub.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] })
    return res.end(await readFile(STUB))
  }
  // ③ 桥打到 express 的路径（记 body 供断言）
  if (pathname === '/queue') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] })
    return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
  }
  // `/api/config`：桥的 standalone 分支会拉它决定"要不要自动加载 activeApp 工作流"。
  // 返回 ok:false → loadWorkflow 走「No active app found」早退（零后续 fetch，夹具干净）
  if (pathname === '/api/config') {
    expressLog.push({ path: pathname, body: null })
    res.writeHead(200, { 'Content-Type': MIME['.json'] })
    return res.end(JSON.stringify({ ok: false, data: null }))
  }
  if (pathname.startsWith('/api/canvas/')) {
    let raw = ''
    for await (const chunk of req) raw += chunk
    let body = null
    try {
      body = JSON.parse(raw || 'null')
    } catch {
      body = raw
    }
    expressLog.push({ path: pathname, body })
    res.writeHead(200, { 'Content-Type': MIME['.json'] })
    if (pathname.endsWith('/checkpoint'))
      return res.end(JSON.stringify({ success: true, data: { checkpointId: 'cp-w18' } }))
    if (pathname.endsWith('/snapshot')) return res.end(JSON.stringify({ success: true }))
    if (pathname.endsWith('/batch'))
      return res.end(JSON.stringify({ success: true, data: { jobId: 'j-w18' } }))
    return res.end(JSON.stringify({ success: true, data: { promptId: 'p-w18' } }))
  }
  // ④ app 产物 + SPA fallback（同 harness）
  let p = pathname === '/' ? '/index.html' : pathname
  const filePath = join(ROOT, normalize(p).replace(/^([/\\])+/, ''))
  try {
    await serveFile(res, filePath)
  } catch {
    try {
      await serveFile(res, join(ROOT, 'index.html'))
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log(`W18 fake-host + app server on ${BASE}`)

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1440, height: 950 } })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))

const finish = async (code = 0) => {
  const pass = results.filter((r) => r.pass).length
  console.log(`\n════ W18 汇总：${pass}/${results.length} ════`)
  await browser.close()
  server.close()
  process.exit(code || (pass === results.length ? 0 : 1))
}

await page.goto(`${BASE}/__host`, { waitUntil: 'load' })

// ── ① 真注入产物在浏览器里加载并注册 ──
await page
  .waitForFunction(() => window.__artifyInjectLoaded === true, { timeout: 15000 })
  .catch(() => {})
const loaded = await page.evaluate(() => ({
  loaded: !!window.__artifyInjectLoaded,
  registryKeys: Object.keys(window.__artifyInjectRegistry || {}).length,
  hasEnsure: typeof window.__artifyInjectRegistry?.ensureArtifySidebarTab === 'function'
}))
record(
  'W18.1 真 inject 产物加载成功（__artifyInjectLoaded + registry 装配完整）',
  loaded.loaded && loaded.registryKeys >= 30 && loaded.hasEnsure,
  `registry 导出 ${loaded.registryKeys} 项`
)

// ── ② 桥注册 sidebar tab 并建出工作台 iframe ──
const tabs = await page
  .waitForFunction(() => window.__w18.tabs.length > 0, { timeout: 15000 })
  .then(() => page.evaluate(() => window.__w18.tabs))
  .catch(() => [])
record(
  'W18.2 桥向宿主注册 sidebar tab（id=artify-workbench）',
  tabs.some((t) => t.id === 'artify-workbench'),
  tabs.length ? JSON.stringify(tabs) : '未注册（render 未调用/桥未启动）'
)

const iframeInfo = await page
  .waitForFunction(() => document.getElementById('artify-workbench-embed'), { timeout: 15000 })
  .then(() =>
    page.evaluate(() => {
      const f = document.getElementById('artify-workbench-embed')
      const reg = window.__artifyInjectRegistry
      return {
        src: f?.getAttribute('src') || '',
        embedWinSet: !!reg?.getEmbedWindow?.(),
        sameWindow: reg?.getEmbedWindow?.() === f?.contentWindow
      }
    })
  )
  .catch(() => ({ src: '', embedWinSet: false, sameWindow: false }))
record(
  'W18.3 桥建出 iframe 且 setEmbedWindow 生效（两处引用同一 contentWindow）',
  iframeInfo.src.includes('/workbench?embed=1') && iframeInfo.embedWinSet && iframeInfo.sameWindow,
  `src=${iframeInfo.src.slice(0, 80)} embedWin=${iframeInfo.embedWinSet}`
)

let frame = page.frames().find((f) => f.url().includes('/workbench'))
if (!frame) {
  await page.waitForTimeout(6000)
  frame = page.frames().find((f) => f.url().includes('/workbench'))
}
if (!frame) {
  record('W18.4 工作台 iframe 已挂载（后续断言前置）', false, '未找到 frame')
  await finish(1)
}

// 关掉 iframe 内首屏遮罩
for (let i = 0; i < 3; i++) {
  const btn = frame.locator('.ant-modal-close')
  if (!(await btn.count())) break
  await btn
    .first()
    .click({ timeout: 3000 })
    .catch(() => {})
  await page.waitForTimeout(400)
}
record('W18.4 工作台 iframe 已挂载且 boot 完成（embed 形态）', true, frame.url().slice(0, 70))

// 在 iframe 内挂 message 监听（记录桥推来的 CANVAS_STATE）——同源，等价于工作台自己的 window
await frame.evaluate(() => {
  window.__w18states = []
  window.addEventListener('message', (e) => {
    let d = e.data
    if (typeof d === 'string') {
      try {
        d = JSON.parse(d)
      } catch {
        return
      }
    }
    if (d && d.type === 'artify:canvas-state') window.__w18states.push(d.state)
  })
})

const bootErrors = pageErrors.length
const frameErrors = []
frame.on('pageerror', (e) => frameErrors.push(String(e).slice(0, 200)))

// ── ⑤ 摘要推送（本轮的修复点：裸引用 → getEmbedWindow）──
// 工作台 boot 400ms 后会主动 GET_CANVAS_STATE；桥每 2s 也会推一次 → 10s 内必到
const states = await page
  .waitForFunction(
    () => {
      try {
        const f = document.querySelector('#artify-workbench-embed')
        return (
          f &&
          f.contentWindow &&
          f.contentWindow.__w18states &&
          f.contentWindow.__w18states.length > 0
        )
      } catch {
        return false
      }
    },
    { timeout: 12000 }
  )
  .then(() =>
    page.evaluate(() => document.querySelector('#artify-workbench-embed').contentWindow.__w18states)
  )
  .catch(() => [])
const st0 = states[0] || {}
record(
  'W18.5 画布摘要真的推给工作台 iframe（CANVAS_STATE；修复前裸引用使这条从未发生）',
  states.length > 0 && st0.workflowName === 'w18-host-wf' && st0.nodeCount === 2,
  states.length
    ? `${states.length} 条；workflowName=${st0.workflowName} nodeCount=${st0.nodeCount} models=${JSON.stringify(st0.models)}`
    : '一条也没收到'
)

const snapCalls = expressLog.filter((c) => c.path.endsWith('/snapshot')).length
record(
  'W18.6 摘要同时落 express 快照（POST /api/canvas/snapshot 带真实 digest）',
  snapCalls > 0 && expressLog.some((c) => c.path.endsWith('/snapshot') && c.body?.seq >= 1),
  `snapshot 调用 ${snapCalls} 次`
)
await page.screenshot({ path: `${SHOT_DIR}w18-bridge-digest.png` })

// ── ⑦ CANVAS_OPS 真落布：工作台 wb_sync → 桥真 applyCanvasOps → 桩画布被改 ──
const send = async (text) => {
  const ta = frame.locator('textarea:visible').first()
  await ta.click()
  await ta.fill(text)
  await page.waitForTimeout(200)
  const btn = frame.locator('button[title="发送"]').first()
  if (await btn.count()) await btn.click()
  else await ta.press('Enter')
  await page.waitForTimeout(400)
}

await send('同步画布兜底：把这个工作流同步到宿主画布')
await page.waitForTimeout(4500)
const applied = await page.evaluate(() => ({
  clear: window.__w18.graphClear,
  created: window.__w18.created,
  loads: window.__w18.loadGraphCalls.length,
  err: window.__w18.renderError || ''
}))
const ckpt = expressLog.filter((c) => c.path.endsWith('/checkpoint')).length
record(
  'W18.7 wb_sync → 桥真执行 applyCanvasOps（桩画布被 loadWorkflow 重建：clear + createNode）',
  applied.clear > 0 && applied.created > 0 && !applied.err,
  `graph.clear=${applied.clear} createNode=${applied.created} loadGraphData=${applied.loads} renderError=${applied.err || '无'}`
)
record(
  'W18.8 结构级 ops 先落 express checkpoint（POST /api/canvas/checkpoint）',
  ckpt > 0,
  `checkpoint 调用 ${ckpt} 次；checkpoint body.reason=${JSON.stringify(expressLog.find((c) => c.path.endsWith('/checkpoint'))?.body?.reason ?? null)}`
)

// ── ⑨ CANVAS_EXECUTE 真提交流程：真 graphToPrompt → POST /api/canvas/execute ──
await send('跑一下画布上的工作流')
await page.waitForTimeout(4500)
const execCalls = expressLog.filter((c) => c.path.endsWith('/execute'))
const execBody = execCalls.length ? execCalls[execCalls.length - 1].body : null
const frameTxt = await frame.evaluate(() => document.body.innerText || '')
record(
  'W18.9 wb_canvas_exec → 桥真 graphToPrompt 并把 prompt 提交到 /api/canvas/execute',
  execCalls.length > 0 && !!execBody?.prompt && execBody.prompt['1']?.class_type === 'KSampler',
  `execute 调用 ${execCalls.length} 次；prompt 节点=${execBody?.prompt ? Object.keys(execBody.prompt).join(',') : '无'}`
)
record(
  'W18.10 工作台侧出现「已提交执行」回执文案（ack 经 XMLHttpRequest 真回流）',
  frameTxt.includes('画布工作流已提交执行') || frameTxt.includes('提交执行'),
  frameTxt.includes('画布工作流已提交执行') ? '回执文案可见 ✓' : '未见回执文案'
)
await page.screenshot({ path: `${SHOT_DIR}w18-bridge-execute.png` })

// ── ⑪ 全程无新增页面错误 ──
const allErrors = [...pageErrors, ...frameErrors]
record(
  'W18.11 宿主页 + 工作台 iframe 全程无新增未捕获异常',
  allErrors.length === 0,
  allErrors.length ? allErrors.slice(0, 3).join(' | ') : `宿主 boot 前 ${bootErrors} 条`
)

await finish()
