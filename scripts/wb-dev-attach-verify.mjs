/**
 * W20 验收（原生 CDP 版）：**应用自管实例**里的注入桥
 *
 * pnpm dev（ARTIFY_DEV_DEBUG_PORT=9222）→ 用户在应用里点「运行实例」→
 * 应用启动 ComfyUI 实例并经主进程注入桥 → 本脚本经 CDP 附着到实例视图做断言。
 *
 * ⚠️ 不用 playwright.connectOverCDP：对 Electron 的 browser 端点握手成功后挂死
 * （实测两次），改用原生 CDP —— /json/list 拿 page 的 webSocketDebuggerUrl，
 * Node 24 内置 WebSocket 直发 Runtime.evaluate / 订阅 Runtime.exceptionThrown。
 *
 * 用法：
 *   ARTIFY_DEV_DEBUG_PORT=9222 pnpm dev        # 先起应用（另开终端）
 *   node scripts/wb-dev-attach-verify.mjs      # 本脚本：等实例视图 → 自动断言
 *
 * 断言（全部在应用自己启动的 ComfyUI 视图里）：
 *   W20.0 桥由主进程注入（__artifyInjectLoaded + registry 完整），
 *         bootstrap 全局 __ARTIFY_LAB_URL__/__ARTIFY_LAB_API__ 指向 express(3008)，
 *         preload 的 electronAPI 真存在
 *   W20.1 真 LiteGraph 注册表就绪（>100，稳定采样）
 *   W20.2 真 buildCanvasDigest 在真图上跑通（真 /queue + 真节点）
 *   W20.3 真 sidebar tab 注册（extensionManager.getSidebarTabs 含 artify-workbench）
 *   W20.4 无 ReferenceError 类未捕获异常（CDP Runtime.exceptionThrown）
 */
// Node 22+ 内置全局 WebSocket（浏览器兼容 API），无需依赖

const CDP = process.env.ARTIFY_CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.W20_MATCH || '127.0.0.1:8188'
const WAIT_MS = Number(process.env.W20_WAIT_MS || 300000)

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a)

// ── 找目标 page（等用户点「运行实例」后出现）──
async function findTarget() {
  const list = await (await fetch(`${CDP}/json/list`)).json()
  return list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH)) || null
}
log(`等 ComfyUI 实例视图（url 含 ${MATCH}）…（应用未起时先按上面命令启动）`)
let target = null
const deadline = Date.now() + WAIT_MS
while (Date.now() < deadline && !target) {
  try {
    target = await findTarget()
  } catch {
    /* CDP 未就绪，继续等 */
  }
  if (!target) await new Promise((r) => setTimeout(r, 2000))
}
if (!target) {
  log(`❌ ${WAIT_MS / 1000}s 内没等到实例视图 —— 请在应用里点「运行实例」后重跑`)
  process.exit(1)
}
log(`发现实例视图：${target.url}`)

// ── 原生 CDP 会话 ──
const exceptions = [] // Runtime.exceptionThrown（未捕获异常）
const session = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ id: ++seq, method: 'Runtime.enable', params: {} }))
    resolve({
      evaluate: (expression) =>
        new Promise((res, rej) => {
          const i = ++seq
          pending.set(i, { res, rej })
          ws.send(
            JSON.stringify({
              id: i,
              method: 'Runtime.evaluate',
              params: { expression, returnByValue: true, awaitPromise: true, userGesture: true },
            })
          )
        }),
    })
  })
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data))
    if (m.id && pending.has(m.id)) {
      const p = pending.get(m.id)
      pending.delete(m.id)
      m.error ? p.rej(new Error(JSON.stringify(m.error))) : p.res(m.result)
      return
    }
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params?.exceptionDetails
      exceptions.push(String(d?.exception?.description || d?.text || 'unknown').slice(0, 200))
    }
  })
  ws.addEventListener('error', () => reject(new Error('ws error')))
  setTimeout(() => reject(new Error('cdp session timeout')), 30000)
})
const evalIn = (expr) =>
  session.evaluate(expr).then((r) => {
    if (r?.exceptionDetails)
      throw new Error(String(r.exceptionDetails.exception?.description || 'eval exception').slice(0, 300))
    return r?.result?.value
  })

// ── W20.0 注入链路 ──
const env = await evalIn(`(() => ({
  injected: !!window.__artifyInjectLoaded,
  registry: Object.keys(window.__artifyInjectRegistry || {}).length,
  labUrl: window.__ARTIFY_LAB_URL__ || null,
  labApi: window.__ARTIFY_LAB_API__ || null,
  hasElectronAPI: !!window.electronAPI?.ArtifyLab,
  registered: Object.keys(window.LiteGraph?.registered_node_types || {}).length,
  nodeCount: (window.app?.graph?._nodes || []).length,
  graphToPrompt: typeof window.app?.graphToPrompt,
  version: window.__COMFYUI_FRONTEND_VERSION__ || null
}))()`)
record(
  'W20.0 应用注入链路完整（主进程 bootstrap 全局 + preload electronAPI + 桥 registry）',
  env.injected && env.registry >= 30 && !!env.labUrl && !!env.labApi && env.hasElectronAPI,
  `labUrl=${env.labUrl} labApi=${env.labApi} electronAPI=${env.hasElectronAPI} registry=${env.registry}`
)

// ── W20.1 真注册表就绪（app.graph 出现 ≠ 注册完成）──
const regReady = await evalIn(`(async () => {
  const stable = () => Object.keys(window.LiteGraph?.registered_node_types || {}).length
  let last = -1
  for (let i = 0; i < 300; i++) {
    const n = stable()
    if (n >= 100 && n === last) return true
    last = n
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
})()`)
record(
  'W20.1 真 LiteGraph 注册表就绪（稳定采样，本机约 4000+）',
  regReady && env.registered > 100,
  `registered=${env.registered} graph 节点=${env.nodeCount} graphToPrompt=${env.graphToPrompt} frontend=${env.version}`
)

// ── W20.2 真 buildCanvasDigest（真图 + 真 /queue，labApi 指向 express 3008）──
const digest = await evalIn(`(async () => {
  try {
    const d = await window.__artifyInjectRegistry.buildCanvasDigest()
    return { ok: true, seq: d.seq, nodeCount: d.nodeCount, workflowName: d.workflowName,
             queue: d.queue, models: (d.models || []).length }
  } catch (e) { return { ok: false, why: String(e).slice(0, 160) } }
})()`)
record(
  'W20.2 真 buildCanvasDigest 在应用实例的真图上跑通',
  digest.ok === true && digest.seq >= 1,
  digest.ok
    ? `nodeCount=${digest.nodeCount} wf=${digest.workflowName} queue=${JSON.stringify(digest.queue)} models=${digest.models}`
    : JSON.stringify(digest)
)

// ── W20.3 真 sidebar tab 注册 ──
const tabs = await evalIn(`(() => {
  try {
    const list = window.app.extensionManager.getSidebarTabs?.() || []
    return { total: list.length, mine: list.some((t) => t && t.id === 'artify-workbench') }
  } catch (e) { return { total: -1, mine: false, why: String(e).slice(0, 120) } }
})()`)
record(
  'W20.3 桥注册进应用实例的真侧栏（extensionManager）',
  tabs.mine === true,
  `侧栏 tab 共 ${tabs.total} 个`
)

// ── W20.4 无 ReferenceError 类未捕获异常（给摘要轮询几秒暴露窗口）──
await new Promise((r) => setTimeout(r, 3000))
const refErr = exceptions.filter((t) => /ReferenceError|is not defined/.test(t))
record(
  'W20.4 实例视图无 ReferenceError 类未捕获异常（CDP Runtime.exceptionThrown）',
  refErr.length === 0,
  refErr.length ? refErr.slice(0, 3).join(' | ') : `（exceptionThrown 共 ${exceptions.length} 条）`
)
if (exceptions.length) log('异常样本：', exceptions.slice(0, 4).join('\n  '))

const pass = results.filter((r) => r.pass).length
console.log(`\n════ W20 汇总：${pass}/${results.length} ════`)
process.exit(pass === results.length ? 0 : 1)
