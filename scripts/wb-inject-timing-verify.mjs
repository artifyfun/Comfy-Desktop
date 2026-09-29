/**
 * W23 验收：**注入晚于 window load** 时的 A→C 工作流重放（真产物 + 桩宿主）
 *
 * 背景（根因）：`bootstrap.js` 原先把「ready 轮询 + loadWorkflow + 定义
 * `window.__artifyReloadWorkflow`」整块放在 `window.addEventListener('load')`
 * 回调里。但本脚本由桌面端在 **dom-ready 之后**动态注入（attach.ts →
 * executeJavaScript，要先读 82KB 文件再跨 IPC），因此可能晚于 load ——
 * 此时 load 监听器永不触发：轮询不启动 → onReady 不回调 → 工作流不加载、
 * 重放入口不定义；而主进程的重放写作 `window.__artifyReloadWorkflow && f()`，
 * 未定义时静默 no-op。再叠加 `__artifyInjectLoaded` 幂等守卫，该页面整个
 * 生命周期永久失效。用户症状 =「在 A 界面点开工作流，切到 C 界面没加载」。
 *
 * 修复是**两层**，因此断言必须能分别杀死每一层（否则就是假绿）：
 *   层 1 = ready 轮询启动不再只挂在 'load' 上（readyState 兜底）→ 由 W23.1/W23.2/W23.3 判别
 *   层 2 = 重放入口提前到「就绪之前」就定义 → 只能由 W23.4（**重放早于就绪到达**）判别
 * 实测：废掉层 1 → W23.1~W23.5 全红；废掉层 2 → 只有 W23.4 红。见 README 的变异验证一节。
 *
 * 为什么既有测试全绿却漏掉：W18/W19 都用 `addInitScript` / 页面内 `<script>`
 * 注入（必然早于 load），恰好绕开了真机时序；e2e/acceptance 里也没有任何
 * 用例断言 A→C 重放。
 *
 * 本脚本 = **只改「注入时机」这一个变量**的对照实验：
 *   · 对照组 = load **之前**注入（addInitScript）→ 必须全绿，用来证明 harness 自身有效
 *   · 实验组 = load **之后**注入（`waitUntil:'load'` 后 evaluate，真机时序）→ 断言的正是修复点
 *
 * 桩宿主只需满足 `checkComfyUIReady` 的就绪判据：`#vue-app` 有子节点 +
 * `__COMFYUI_FRONTEND_VERSION__` + `LiteGraph.registered_node_types` 数量稳定
 * 5 tick + `window.app.graph`，且顶层非 iframe → standalone 分支。
 * 刻意**不提供** `extensionManager`：`ensureArtifySidebarTab` 会自行 1.5s 重试，
 * 从而把桥注册/画布摘要那一整片依赖面排除在本用例之外（W18 已覆盖）。
 *
 * 用法：node scripts/wb-inject-timing-verify.mjs
 * 前置：`pnpm --filter artifylab-frontend run build:inject`（必须，dev 与实际
 *       注入读的都是 public/comfy_inject.js）；prod min 产物断言需
 *       `pnpm run build:frontend`，缺失时自动跳过。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'

const DEV_INJECT = fileURLToPath(
  new URL('../packages/frontend/public/comfy_inject.js', import.meta.url)
)
const PROD_INJECT = fileURLToPath(
  new URL('../src/main/artifylab/public/frontend/comfy_inject.min.js', import.meta.url)
)

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}

// ── 夹具：两个 app，用于验证重放读到的是**最新** activeAppId ──
const APPS = {
  'app-1': {
    id: 'app-1',
    name: '出图工作流-1',
    template: { workflow: { id: 'wf-1', name: '出图工作流-1', nodes: [], links: [] } }
  },
  'app-2': {
    id: 'app-2',
    name: '换脸工作流-2',
    template: { workflow: { id: 'wf-2', name: '换脸工作流-2', nodes: [], links: [] } }
  }
}
// 服务端侧 config（A 界面点「打开工作流」就是改这里的 activeAppId）
const state = { activeAppId: 'app-1' }

const OK = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) })

const STUB = `
window.__COMFYUI_FRONTEND_VERSION__ = 'w23-1.0.0'
window.__graphLoads = []
window.electronAPI = {
  // apiRequest 只用 server_origin 拼 baseUrl；activeAppId 的真实来源是服务端 /api/config
  ArtifyLab: { getConfig: async () => ({ server_origin: location.origin }) }
}
window.LiteGraph = {
  registered_node_types: { CheckpointLoaderSimple: {}, KSampler: {}, VAEDecode: {} },
  NODE_WIDGET_HEIGHT: 20,
  WIDGET_OUTLINE_COLOR: '#000',
  WIDGET_BGCOLOR: '#222',
  WIDGET_TEXT_COLOR: '#fff',
  WIDGET_SECONDARY_TEXT_COLOR: '#aaa',
  createNode: () => null,
  registerNodeType: () => {}
}
window.app = {
  graph: { _nodes: [], links: {}, name: '', extra: {} },
  canvas: { ds: { scale: 1 } },
  ui: {},
  last_loaded_file: '',
  loadGraphData: async (wf, clear) => {
    window.__graphLoads.push({ name: (wf && wf.name) || null, clear: !!clear })
  }
}
`

const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>w23</title>
<script>${STUB}</script>
</head><body><div id="vue-app"><i></i></div></body></html>`

const serve = (route) => {
  const { pathname } = new URL(route.request().url())
  if (pathname === '/api/config') {
    return route.fulfill(OK({ ok: true, data: { activeAppId: state.activeAppId } }))
  }
  if (pathname === '/api/apps/detail') {
    let id = null
    try {
      id = JSON.parse(route.request().postData() || '{}').id
    } catch {
      /* 非法 body → 当作不存在 */
    }
    const app = APPS[id]
    return app ? route.fulfill(OK({ ok: true, data: app })) : route.fulfill(OK({ ok: false }))
  }
  return route.fulfill({ status: 200, contentType: 'text/html', body: PAGE })
}

const browser = await chromium.launch()

/**
 * 一个页面的回合：注入（早/晚）→ 等到 ready 轮询走完（约 600ms 稳定窗口）。
 * waitMs=0 用于「注入后立刻观测」，此时 ComfyUI 尚未就绪。
 */
async function openPage(mode, src, waitMs = 3500) {
  const page = await browser.newPage()
  const logs = []
  const errors = []
  page.on('console', (m) => logs.push(m.text()))
  page.on('pageerror', (e) => errors.push(String(e.message).slice(0, 160)))
  page.on('weberror', (e) => errors.push('WEBERROR: ' + String(e.error()).slice(0, 160)))
  await page.route('**/*', serve)
  if (mode === 'early') await page.addInitScript(src)
  await page.goto('http://w23.local/index.html', { waitUntil: 'load' })
  if (mode === 'late') {
    // 传字符串会被 playwright 当表达式求值 → 用 new Function 等价主进程 executeJavaScript
    await page.evaluate((s) => new Function(s)(), src)
  }
  if (waitMs) await page.waitForTimeout(waitMs)
  return { page, logs, errors }
}

const aiLogs = (logs) => logs.filter((l) => l.includes('ArtifyInject'))
const loads = (page) => page.evaluate(() => window.__graphLoads)
const reloadType = (page) => page.evaluate(() => typeof window.__artifyReloadWorkflow)

const devSrc = await readFile(DEV_INJECT, 'utf-8')

// ══════════════════════════════════════════════════════════════════
// 对照组：load 之前注入（W18/W19 的既有方式）
// ══════════════════════════════════════════════════════════════════
const early = await openPage('early', devSrc)
const earlyLoads = await loads(early.page)
record(
  // 只断言「harness 自身有效」——轮询起来 + 工作流装进画布。
  // 重放入口是否存在属于产品断言，交给 W23.1~W23.6（否则这组变红时
  // 分不清是 harness 坏了还是产品坏了）。
  'W23.0 对照组（load 前注入）自证 harness 有效',
  earlyLoads.length === 1 && earlyLoads[0].name === '出图工作流-1',
  `graphLoads=${JSON.stringify(earlyLoads)}；注入日志 ${aiLogs(early.logs).length} 条；重放入口=${await reloadType(early.page)}`
)
await early.page.close()

// ══════════════════════════════════════════════════════════════════
// 实验组 1：load 之后注入（真机 Electron 时序 = 本 bug 的现场）
// ══════════════════════════════════════════════════════════════════
state.activeAppId = 'app-1'
const late = await openPage('late', devSrc)
const lateLoads = await loads(late.page)

// 层 1 判别：轮询真的启动了（load 监听器不再是唯一入口）
record(
  'W23.1 【层1】晚注入下 ready 轮询确实启动',
  aiLogs(late.logs).some((l) => l.includes('Standalone mode detected')),
  aiLogs(late.logs).length
    ? `注入日志 ${aiLogs(late.logs).length} 条：${aiLogs(late.logs).slice(0, 2).join(' | ')}`
    : '无任何 [ArtifyInject] 日志（load 监听器错过 → 轮询未启动）'
)
record(
  'W23.2 【层1】晚注入下首屏 loadWorkflow 真把工作流装进画布',
  lateLoads.length === 1 && lateLoads[0].name === '出图工作流-1' && lateLoads[0].clear === true,
  `graphLoads=${JSON.stringify(lateLoads)}`
)

// ── A→C 重放：A 界面点开工作流（改服务端 activeAppId）→ 切到 C（主进程重放） ──
state.activeAppId = 'app-2'
// 入口缺失时**不要**让脚本自己崩：主进程那行 `f && f()` 的等价写法在这里，
// 恰好也是 bug 现场的行为（静默 no-op），断言必须能把它记成 ❌ 而不是异常。
await late.page.evaluate(() => {
  if (typeof window.__artifyReloadWorkflow === 'function') window.__artifyReloadWorkflow()
})
await late.page.waitForTimeout(1500)
const afterReplay = await loads(late.page)
record(
  'W23.3 【层2】重放读到**最新** activeAppId（A 写入的新 app 真的进了画布）',
  afterReplay.length === 2 && afterReplay[1].name === '换脸工作流-2',
  `graphLoads=${JSON.stringify(afterReplay)}`
)

// ── 重入守卫：同一 tick 连发两次重放，只允许一次图加载 ──
const before = afterReplay.length
await late.page.evaluate(() => {
  if (typeof window.__artifyReloadWorkflow !== 'function') return
  window.__artifyReloadWorkflow()
  window.__artifyReloadWorkflow()
})
await late.page.waitForTimeout(1500)
const afterDouble = await loads(late.page)
// 注意：必须在此刻重新过滤 logs（上面若缓存过 aiLogs 就只是快照）
const guarded = aiLogs(late.logs).some((l) => l.includes('skipped: already loading'))
record(
  'W23.4 【层2】重入守卫覆盖取配置窗口（同 tick 连发两次只加载一次）',
  afterDouble.length === before + 1 && guarded,
  `新增 graphLoads ${afterDouble.length - before} 次（期望 1）；守卫日志 ${guarded ? '有' : '无'}`
)
record(
  'W23.5 全程零未捕获异常 / 零 unhandled rejection',
  late.errors.length === 0,
  late.errors.length ? late.errors.slice(0, 3).join(' | ') : '宿主页与控制台均无异常'
)
await late.page.close()

// ══════════════════════════════════════════════════════════════════
// 实验组 2：重放**早于就绪**到达 —— 层 2 的唯一判别点
// 注入后立刻模拟 A→C 切换：此时 ComfyUI 尚未 ready（稳定窗口约 600ms）。
// 没有「提前定义」时 window.__artifyReloadWorkflow 此刻是 undefined，
// 主进程那行 `f && f()` 就成了静默 no-op，这次切换被永久丢弃。
// ══════════════════════════════════════════════════════════════════
state.activeAppId = 'app-2'
const pre = await openPage('late', devSrc, 0)
const typeAtInjection = await reloadType(pre.page)
await pre.page.evaluate(() => {
  if (typeof window.__artifyReloadWorkflow === 'function') window.__artifyReloadWorkflow()
})
const notReadyLogged = aiLogs(pre.logs).some((l) => l.includes('not ready yet'))
await pre.page.waitForTimeout(3500)
const preLoads = await loads(pre.page)
record(
  'W23.6 【层2 判别】重放早于就绪到达：入口已存在，且被首屏加载兜住',
  typeAtInjection === 'function' &&
    preLoads.length > 0 &&
    preLoads[preLoads.length - 1].name === '换脸工作流-2',
  `注入瞬间 typeof=${typeAtInjection}（期望 function）；graphLoads=${JSON.stringify(preLoads)}；命中 not-ready 分支=${notReadyLogged ? '是' : '否'}`
)
await pre.page.close()

// ══════════════════════════════════════════════════════════════════
// 产物新鲜度（静态）：防「源码修了、产物没重建」——本 bug 的孪生陷阱
// ══════════════════════════════════════════════════════════════════
const hasFallback = (s) => s.includes('readyState') && s.includes('__artifyReloadWorkflow')
record(
  'W23.7 dev 产物 public/comfy_inject.js 含兜底代码（build:inject 已跑）',
  hasFallback(devSrc),
  hasFallback(devSrc) ? '含 readyState 兜底 + 重放入口' : '产物陈旧：先跑 build:inject'
)

if (existsSync(PROD_INJECT)) {
  const prodSrc = await readFile(PROD_INJECT, 'utf-8')
  record(
    'W23.8 prod 产物 comfy_inject.min.js 含兜底代码（build:frontend 已跑）',
    hasFallback(prodSrc),
    hasFallback(prodSrc) ? '含 readyState 兜底 + 重放入口' : '产物陈旧：先跑 build:frontend'
  )
} else {
  console.log('⏭️  W23.8 跳过：src/main/artifylab/public/frontend/comfy_inject.min.js 不存在')
}

const pass = results.filter((r) => r.pass).length
console.log(`\n════ W23 汇总：${pass}/${results.length} ════`)
await browser.close()
process.exit(pass === results.length ? 0 : 1)
