/**
 * W19 验收：**真 ComfyUI 页面**里的注入桥（最后一块未覆盖）
 *
 * W18 用「真 inject 产物 + 桩 window.app」，验的是桥的协议与落布语义；
 * 真 ComfyUI 才有的东西一直没验：
 *   - 真 `app.graphToPrompt()` 的返回形状（`{workflow, output}`）与 **真 API 格式 prompt**
 *   - 真 `LiteGraph.createNode` / 真 graph 结构上的 addNode / setWidget / align
 *   - 真 `extensionManager.registerSidebarTab`（桥注册 tab 的真 API）
 *   - 真 `buildCanvasDigest`（真节点 → models/keyParams 投影）
 *   - 真 `/queue`
 *
 * 搭法：
 *   ① 脚本自带服务器（同 W18）：伺服真 inject 产物 + 工作台 iframe（app 产物 + stub）+ express stub
 *   ② 打开**真 ComfyUI 页面**（默认 http://127.0.0.1:8188），用 addInitScript 在页面脚本前注入
 *      桥需要的三个全局（`__ARTIFY_LAB_URL__` / `__ARTIFY_LAB_API__` / `electronAPI`）+ 真桥产物
 *   ③ 桥的 registry 暴露 `handleArtifyMessage` / `buildCanvasDigest` / `applyOneOp` —— 直接以真
 *      app 为宿主驱动它们，断言"桥对真图做了什么"，而不是只看协议外壳
 *
 * 用法：node scripts/wb-real-comfy-bridge-verify.mjs [--comfy http://127.0.0.1:8188] [--port 5181]
 * 前置：ComfyUI 在跑（standalone-env/python.exe main.py --port 8188 …）+ 产物最新（pnpm run build:frontend）
 */
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const opt = (n, d) => {
  const i = process.argv.indexOf(n)
  return i > 0 ? process.argv[i + 1] : d
}
const PORT = Number(opt('--port', 5181))
const BASE = `http://127.0.0.1:${PORT}`
const COMFY = String(opt('--comfy', 'http://127.0.0.1:8188')).replace(/\/$/, '')

const ROOT = fileURLToPath(new URL('../src/main/artifylab/public/frontend/', import.meta.url))
const STUB = fileURLToPath(new URL('../acceptance/workbench/stub.js', import.meta.url))
const INJECT = join(ROOT, 'comfy_inject.min.js')
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

/** 桥打到 express 的请求记账 */
const expressLog = []
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

async function serveFile(res, filePath) {
  const body = await readFile(filePath)
  if (extname(filePath) === '.html') {
    const txt = body.toString()
    res.writeHead(200, { 'Content-Type': MIME['.html'] })
    return res.end(
      txt.includes('</body>') ? txt.replace('</body>', STUB_TAG + '</body>') : txt + STUB_TAG
    )
  }
  res.writeHead(200, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' })
  res.end(body)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, BASE)
  const pathname = decodeURIComponent(url.pathname)
  // 真 ComfyUI 页在 8188，桥的 fetch 打到这里是**跨源** —— 没有 CORS 头浏览器会拦成
  // "TypeError: Failed to fetch"（W18 全同源所以没暴露）。POST + application/json 还会
  // 先发 OPTIONS 预检：必须单独回 204，且**不能**把预检也记进 expressLog（否则断言取到空 body）
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Headers', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }
  if (pathname === '/__inject.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] })
    return res.end(await readFile(INJECT))
  }
  if (pathname === '/__workbench_stub.js') {
    res.writeHead(200, { 'Content-Type': MIME['.js'] })
    return res.end(await readFile(STUB))
  }
  if (pathname === '/queue') {
    res.writeHead(200, { 'Content-Type': MIME['.json'] })
    return res.end(JSON.stringify({ queue_running: [], queue_pending: [] }))
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
      return res.end(JSON.stringify({ success: true, data: { checkpointId: 'cp-w19' } }))
    if (pathname.endsWith('/snapshot')) return res.end(JSON.stringify({ success: true }))
    return res.end(JSON.stringify({ success: true, data: { promptId: 'p-w19' } }))
  }
  const p = pathname === '/' ? '/index.html' : pathname
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
console.log(`W19 静态/桩服务器 on ${BASE}；宿主 = 真 ComfyUI ${COMFY}`)

const injectSource = await readFile(INJECT, 'utf-8')

/**
 * 最小可执行工作流（官方前端格式）：真 ComfyUI 启动后画布是**空的**（不自动载图），
 * 后续断言需要一张真图当宿主。用真前端自己的 `app.loadGraphData()` 载入 ——
 * 这也是桥的 `loadWorkflowGraph` 走的那条 API，顺带覆盖它。
 * 5 节点：CheckpointLoaderSimple → 2×CLIPTextEncode → KSampler，另加 EmptyLatentImage。
 */
const MIN_WF = {
  last_node_id: 5,
  last_link_id: 8,
  nodes: [
    {
      id: 1,
      type: 'CheckpointLoaderSimple',
      pos: [40, 40],
      size: [300, 98],
      flags: {},
      order: 0,
      mode: 0,
      inputs: [],
      outputs: [
        { name: 'MODEL', type: 'MODEL', links: [1] },
        { name: 'CLIP', type: 'CLIP', links: [2, 3] },
        { name: 'VAE', type: 'VAE', links: [] }
      ],
      properties: { 'Node name for S&R': 'CheckpointLoaderSimple' },
      widgets_values: ['w19-model.safetensors']
    },
    {
      id: 2,
      type: 'CLIPTextEncode',
      pos: [400, 40],
      size: [400, 200],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }],
      properties: { 'Node name for S&R': 'CLIPTextEncode' },
      widgets_values: ['a photo of a cat']
    },
    {
      id: 3,
      type: 'CLIPTextEncode',
      pos: [400, 280],
      size: [400, 200],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [6] }],
      properties: { 'Node name for S&R': 'CLIPTextEncode' },
      widgets_values: ['blurry, low quality']
    },
    {
      id: 5,
      type: 'EmptyLatentImage',
      pos: [400, 520],
      size: [300, 106],
      flags: {},
      order: 4,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }],
      properties: { 'Node name for S&R': 'EmptyLatentImage' },
      widgets_values: [512, 512, 1]
    },
    {
      id: 4,
      type: 'KSampler',
      pos: [850, 40],
      size: [300, 262],
      flags: {},
      order: 3,
      mode: 0,
      inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 5 },
        { name: 'negative', type: 'CONDITIONING', link: 6 },
        { name: 'latent_image', type: 'LATENT', link: 8 }
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [] }],
      properties: { 'Node name for S&R': 'KSampler' },
      widgets_values: [123456, 'randomize', 20, 7.5, 'euler', 'normal', 1]
    }
  ],
  links: [
    [1, 1, 0, 4, 0, 'MODEL'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 1, 3, 0, 'CLIP'],
    [5, 2, 0, 4, 1, 'CONDITIONING'],
    [6, 3, 0, 4, 2, 'CONDITIONING'],
    [8, 5, 0, 4, 3, 'LATENT']
  ],
  groups: [],
  config: {},
  extra: {},
  version: 0.4
}

const browser = await chromium.launch({ headless: true })
const page = await (await browser.newContext({ viewport: { width: 1600, height: 950 } })).newPage()
const pageErrors = []
page.on('pageerror', (e) => pageErrors.push(String(e).slice(0, 200)))

const finish = async () => {
  const pass = results.filter((r) => r.pass).length
  console.log(`\n════ W19 汇总：${pass}/${results.length} ════`)
  await browser.close()
  server.close()
  process.exit(pass === results.length ? 0 : 1)
}

// 真机注入的三个全局（主进程 withArtifyLabBootstrap + preload 的 electronAPI）
await page.addInitScript(
  ([base, src]) => {
    window.__ARTIFY_LAB_URL__ = base
    window.__ARTIFY_LAB_API__ = base
    window.electronAPI = {
      ArtifyLab: {
        getConfig: async () => ({ server_origin: base, activeAppId: null })
      }
    }
    // 真桥产物：在页面脚本前落地（等价主进程 executeJavaScript 的时机）
    // eslint-disable-next-line no-eval
    new Function(src)()
  },
  [BASE, injectSource]
)

await page.goto(`${COMFY}/`, { waitUntil: 'load' })

// ── ① 真 ComfyUI 就绪 + 桥加载 ──
// ⚠️ 判据必须等**节点类型注册完成**：真前端里 `app.graph` 很早就存在（空图），而
// `LiteGraph.registered_node_types` 是异步填满的（本机 4052 个）。只等 app.graph 会在
// 注册表还是 0 的时候开跑 → `createNode('KSampler')` 返回 null → 误判成"桥的 addNode 坏了"。
// 桥自己也是这么判的（bootstrap 等 registered_node_types 数量稳定 5 个 tick）。
const ready = await page
  .waitForFunction(
    () => {
      const n = Object.keys(window.LiteGraph?.registered_node_types || {}).length
      if (n < 100) return false
      if (window.__w19Stable === n) return true
      window.__w19Stable = n
      return false
    },
    { timeout: 90000 }
  )
  .then(() => true)
  .catch(() => false)
const env = await page.evaluate(() => ({
  hasApp: !!(window.app && window.app.graph),
  nodes: (window.app?.graph?._nodes || []).length,
  registry: Object.keys(window.__artifyInjectRegistry || {}).length,
  realGraphToPrompt: typeof window.app?.graphToPrompt === 'function',
  realRegisterTab: typeof window.app?.extensionManager?.registerSidebarTab === 'function',
  realLiteGraph: !!window.LiteGraph?.createNode
}))
record(
  'W19.1 真 ComfyUI 就绪且真桥产物在其上下文中装配完成',
  ready && env.hasApp && env.registry >= 30,
  `节点=${env.nodes} registry=${env.registry} graphToPrompt=${env.realGraphToPrompt} registerTab=${env.realRegisterTab} LiteGraph=${env.realLiteGraph}`
)
if (!ready) await finish()

// 关掉可能挡住 UI 的弹窗（模板/使用指南）
for (let i = 0; i < 3; i++) {
  const btn = page.locator('.ant-modal-close, .p-dialog-header-close').first()
  if (!(await btn.count())) break
  await btn.click({ timeout: 2000 }).catch(() => {})
  await page.waitForTimeout(300)
}

const bootErrors = pageErrors.length
const call = (msg) =>
  page.evaluate((m) => window.__artifyInjectRegistry.handleArtifyMessage(m), msg)

// ── ①b 造真图：真前端 loadGraphData 载入 5 节点官方图 ──
const loadRes = await page.evaluate(async (wf) => {
  await window.app.loadGraphData(wf)
  await new Promise((r) => setTimeout(r, 800))
  const ns = window.app.graph._nodes || []
  return { nodes: ns.length, types: ns.map((n) => n.type) }
}, MIN_WF)
record(
  'W19.1b 真前端 loadGraphData 载入官方格式最小图（后续断言的宿主；也是桥 loadWorkflowGraph 走的 API）',
  loadRes.nodes >= 5 && loadRes.types.includes('KSampler'),
  `${loadRes.nodes} 节点：${JSON.stringify(loadRes.types)}`
)

// ── ② 真 buildCanvasDigest：真图 → 摘要投影 ──
const digest = await page.evaluate(async () => {
  const d = await window.__artifyInjectRegistry.buildCanvasDigest()
  return {
    seq: d.seq,
    nodeCount: d.nodeCount,
    workflowName: d.workflowName,
    queue: d.queue,
    models: d.models
  }
})
record(
  'W19.2 真 buildCanvasDigest 在真图上跑通（真 /queue + 真节点计数）',
  digest.nodeCount >= 0 && typeof digest.queue?.running === 'number' && digest.seq >= 1,
  `nodeCount=${digest.nodeCount} wf=${digest.workflowName} queue=${JSON.stringify(digest.queue)}`
)

// ── ③ 真 addNode：桥在真 LiteGraph 上建节点 ──
const addRes = await page.evaluate(async () => {
  const before = (window.app.graph._nodes || []).length
  const diag = {
    registered: Object.keys(window.LiteGraph.registered_node_types || {}).length,
    hasKSampler: !!window.LiteGraph.registered_node_types?.KSampler,
    createNode: typeof window.LiteGraph.createNode,
    graphAdd: typeof window.app.graph.add
  }
  let made = null
  try {
    made = window.LiteGraph.createNode('KSampler')
  } catch (e) {
    diag.createErr = String(e).slice(0, 160)
  }
  diag.madeOk = !!made
  const ack = await window.__artifyInjectRegistry.handleArtifyMessage({
    type: 'artify:canvas-ops',
    requestId: 'w19-add',
    reason: 'w19-add-node',
    ops: [{ type: 'addNode', nodeType: 'KSampler', pos: [40, 40] }]
  })
  return {
    before,
    after: (window.app.graph._nodes || []).length,
    types: (window.app.graph._nodes || []).map((n) => n.type).slice(-3),
    ackOk: ack?.ok,
    ackErr: ack?.results?.[0]?.error || null,
    diag
  }
})
record(
  'W19.3 桥在真 LiteGraph 上 addNode（真 createNode + 真 graph.add）',
  addRes.after === addRes.before + 1 && addRes.types.includes('KSampler'),
  `节点 ${addRes.before} → ${addRes.after}；ack.ok=${addRes.ackOk} err=${addRes.ackErr || '无'}；diag=${JSON.stringify(addRes.diag)}`
)

// ── ④ 真 setWidget：改真节点的真 widget ──
const setRes = await page.evaluate(async () => {
  const node = (window.app.graph._nodes || []).find((n) => n.type === 'KSampler')
  if (!node) return { ok: false, why: 'no KSampler' }
  const w = (node.widgets || []).find((x) => x.name === 'steps' || x.name === 'seed')
  if (!w)
    return {
      ok: false,
      why: 'no widget',
      names: (node.widgets || []).map((x) => x.name).slice(0, 6)
    }
  const before = w.value
  const r = await window.__artifyInjectRegistry.handleArtifyMessage({
    type: 'artify:canvas-ops',
    requestId: 'w19-set',
    ops: [
      { type: 'setWidget', nodeId: node.id, widget: w.name, value: w.name === 'seed' ? 424242 : 33 }
    ]
  })
  return { ok: true, name: w.name, before, after: w.value, res: r }
})
record(
  'W19.4 桥在真节点上 setWidget（真 widget.value 变化）',
  setRes.ok === true && setRes.before !== setRes.after,
  setRes.ok ? `${setRes.name}: ${setRes.before} → ${setRes.after}` : JSON.stringify(setRes)
)

// ── ⑤ 真 graphToPrompt + 真提交流程（CANVAS_EXECUTE）──
const execRes = await call({
  type: 'artify:canvas-execute',
  requestId: 'w19-exec',
  name: 'w19-real'
})
await page.waitForTimeout(1500)
const execCall = expressLog.filter((c) => c.path.endsWith('/execute')).pop()
const promptNodes = execCall?.body?.prompt ? Object.keys(execCall.body.prompt) : []
record(
  'W19.5 桥用真 app.graphToPrompt() 取 prompt 并提交（/api/canvas/execute 收到真 API 格式）',
  !!execCall &&
    promptNodes.length > 0 &&
    Object.values(execCall.body.prompt).every((n) => typeof n.class_type === 'string' && n.inputs),
  `提交 ${promptNodes.length} 个节点；class_type 示例=${Object.values(execCall?.body?.prompt || {})[0]?.class_type}`
)

// ── ⑥ 真 checkpoint：真 graphToPrompt 双格式（workflow + prompt）落 express ──
const ckptCall = expressLog.filter((c) => c.path.endsWith('/checkpoint')).pop()
record(
  'W19.6 结构级 ops 触发真 checkpoint（body 同时带 workflow 与 prompt 双格式）',
  !!ckptCall?.body?.workflow && !!ckptCall?.body?.prompt,
  ckptCall?.body?.workflow
    ? `workflow.nodes=${(ckptCall.body.workflow.nodes || []).length} prompt 节点=${Object.keys(ckptCall.body.prompt || {}).length} reason=${JSON.stringify(ckptCall.body.reason)}`
    : `未收到 checkpoint（${expressLog.length} 条 express 调用：${expressLog.map((c) => c.path).join(',') || '无'}）`
)
await page.screenshot({ path: `${SHOT_DIR}w19-real-comfy.png` })

// ── ⑦ 真 extensionManager.registerSidebarTab：桥注册 tab 真 API ──
const tabInfo = await page.evaluate(() => {
  try {
    const tabs = window.app.extensionManager.getSidebarTabs?.() || []
    const mine = tabs.find((t) => t && t.id === 'artify-workbench')
    return { count: tabs.length, hasMine: !!mine, keys: mine ? Object.keys(mine) : [] }
  } catch (e) {
    return { error: String(e).slice(0, 120) }
  }
})
record(
  'W19.7 桥通过真 extensionManager.registerSidebarTab 注册进真侧栏',
  tabInfo.hasMine === true,
  tabInfo.hasMine
    ? `侧栏 tab 数=${tabInfo.count}，字段=${JSON.stringify(tabInfo.keys)}`
    : JSON.stringify(tabInfo)
)

// ── ⑧ 真 align：对真节点做对齐（几何真变化）──
const alignRes = await page.evaluate(async () => {
  const g = window.app.graph
  const ns = (g._nodes || []).slice(0, 3)
  if (ns.length < 2) return { ok: false, why: 'need >=2 nodes', n: ns.length }
  ns.forEach((n, i) => (n.pos = [i * 137, i * 53]))
  const before = ns.map((n) => n.pos[0])
  await window.__artifyInjectRegistry.handleArtifyMessage({
    type: 'artify:canvas-ops',
    requestId: 'w19-align',
    ops: [{ type: 'align', mode: 'left', nodes: ns.map((n) => n.id) }]
  })
  const after = ns.map((n) => n.pos[0])
  return { ok: true, before, after, allEqual: new Set(after).size === 1 }
})
record(
  'W19.8 桥对真节点执行 align（真 pos 被改到同一左缘）',
  alignRes.ok === true && alignRes.allEqual === true,
  alignRes.ok
    ? `x: ${JSON.stringify(alignRes.before)} → ${JSON.stringify(alignRes.after)}`
    : JSON.stringify(alignRes)
)

// ── ⑨ 全程无未捕获异常 ──
record(
  'W19.9 真 ComfyUI 页面全程无新增未捕获异常',
  pageErrors.length === bootErrors,
  pageErrors.length > bootErrors
    ? pageErrors.slice(bootErrors, bootErrors + 3).join(' | ')
    : `boot 前 ${bootErrors} 条，之后 0 条`
)

await finish()
