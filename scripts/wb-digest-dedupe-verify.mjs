/**
 * W21 验收：画布摘要**去重语义**在应用真机上的行为回归
 *
 * 背景：`buildCanvasDigest` 每次都 `++seq` 并打 `ts` → 去重签名永不命中 →
 * 每 2s 轮询都冗余推一次（embed postMessage + POST /api/canvas/snapshot）。
 * 2026-09-19 修为：去重签名**剥离 seq/ts**（接收方防乱序只看收到的 seq，内容没变
 * 不需要新 seq）；`GET_CANVAS_STATE` 改 `force=true`（刚连上的工作台必须拿到）。
 *
 * 方法（原生 CDP，真 ComfyUI 实例视图）：
 *   `Page.addScriptToEvaluateOnNewDocument` 在文档创建前 hook fetch，计数
 *   `/api/canvas/snapshot` 调用 → reload（extensions 目录的 artify_inject.js 已同步新产物）
 *   → ① 画布不动等 12s（3 个轮询周期）→ 计数必须不变；② 桥真 addNode 改图 →
 *   等 4s → 计数必须 +1。
 *
 * 前置：应用 dev 在跑 + 实例已启动（W20 的环境）+ 两级产物已重建且已同步 extensions 目录。
 */
const CDP = process.env.ARTIFY_CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.W21_MATCH || '127.0.0.1:8188'

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a)

const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH))
if (!target) {
  console.log(`❌ 没找到实例视图（${MATCH}）—— 先起应用并点「运行实例」`)
  process.exit(1)
}
log(`附着实例视图：${target.url}`)

/** 原生 CDP：返回 { send, events }；events 收集 Page 事件 */
const session = await new Promise((resolve, reject) => {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  let seq = 0
  const pending = new Map()
  const events = []
  ws.addEventListener('open', () => {
    for (const m of ['Runtime.enable', 'Page.enable'])
      ws.send(JSON.stringify({ id: ++seq, method: m, params: {} }))
    resolve({
      send: (method, params = {}) =>
        new Promise((res, rej) => {
          const i = ++seq
          pending.set(i, { res, rej })
          ws.send(JSON.stringify({ id: i, method, params }))
        }),
      events
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
    if (m.method) events.push(m)
  })
  ws.addEventListener('error', () => reject(new Error('ws error')))
  setTimeout(() => reject(new Error('cdp session timeout')), 30000)
})
const send = session.send
const evalIn = (expr) =>
  send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }).then(
    (r) => {
      if (r?.exceptionDetails)
        throw new Error(
          String(r.exceptionDetails.exception?.description || 'eval exception').slice(0, 300)
        )
      return r?.result?.value
    }
  )

// ── 文档创建前装 fetch 计数器（reload 后生效）──
await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `(() => {
    window.__snapCount = 0
    const of_ = window.fetch
    window.fetch = function (...a) {
      try {
        const u = typeof a[0] === 'string' ? a[0] : String(a[0] && a[0].url || '')
        if (u.includes('/api/canvas/snapshot')) window.__snapCount++
      } catch {}
      return of_.apply(this, a)
    }
  })()`
})
await send('Page.reload', { ignoreCache: false })
log('reload 中 …（extensions 目录的 artify_inject.js 已是去重版）')
// reload 会销毁旧执行上下文 —— 立刻发 evaluate 会拿到
// "Execution context was destroyed"，先等新 context 稳定
await new Promise((r) => setTimeout(r, 3000))

// ── 等桥 + 注册表就绪 ──
const ready = await evalIn(`(async () => {
  for (let i = 0; i < 300; i++) {
    const n = Object.keys(window.LiteGraph?.registered_node_types || {}).length
    if (window.__artifyInjectLoaded && n >= 100 && window.__w21Last === n) return true
    window.__w21Last = n
    await new Promise((r) => setTimeout(r, 300))
  }
  return false
})()`)
const env = await evalIn(`(() => ({
  injected: !!window.__artifyInjectLoaded,
  nodes: (window.app?.graph?._nodes || []).length
}))()`)
record(
  'W21.0 reload 后桥重新注入（extensions 路径）且注册表就绪',
  ready && env.injected,
  `nodes=${env.nodes} injected=${env.injected}`
)
if (!ready) process.exit(1)

// ── ① 画布不动等 12s（3 个轮询周期）→ snapshot 计数必须不变 ──
const base = await evalIn(`window.__snapCount`)
log(`基线 snapshot 计数 = ${base}；静置 12s 观察 …`)
await new Promise((r) => setTimeout(r, 12000))
const quiet = await evalIn(`window.__snapCount`)
record(
  'W21.1 画布无变化 → 不冗余推送（12s / 3 个轮询周期内 snapshot 计数不变）',
  quiet === base,
  `计数 ${base} → ${quiet}（修复前每 2s +1，12s 应为 +6）`
)

// ── ② 桥真 addNode 改图 → 下个周期必须推一次 ──
const addOk = await evalIn(`(async () => {
  const before = (window.app.graph._nodes || []).length
  await window.__artifyInjectRegistry.handleArtifyMessage({
    type: 'artify:canvas-ops', requestId: 'w21-add',
    ops: [{ type: 'addNode', nodeType: 'Note', pos: [10, 10] }]
  })
  return (window.app.graph._nodes || []).length > before
})()`)
log('已真改画布（addNode），等下个轮询周期 …')
await new Promise((r) => setTimeout(r, 4500))
const after = await evalIn(`window.__snapCount`)
record(
  'W21.2 画布真变化 → 恰好推送一次 snapshot（下个轮询周期）',
  addOk && after === quiet + 1,
  `计数 ${quiet} → ${after}（期望 +1）`
)

const pass = results.filter((r) => r.pass).length
console.log(`\n════ W21 汇总：${pass}/${results.length} ════`)
process.exit(pass === results.length ? 0 : 1)
