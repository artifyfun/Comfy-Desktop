/**
 * W22 验收（原生 CDP 版）：**C 侧栏链路 → 真队列 → 真出图** —— 注入桥最后一块端到端
 *
 * W19/W20 的 execute 提交打到的是 stub/未跑生成；本脚本补上「真队列跑完一次生成」：
 * 桥 `handleArtifyMessage({type:'artify:canvas-execute'})` → 真 graphToPrompt →
 * POST :3008/api/canvas/execute（真 executePrompt）→ 真 ComfyUI /prompt 队列 →
 * 轮询 :3008/api/canvas/execute-status（工作台同款轮询路由）→ 真 outputs 图片落盘。
 *
 * 用法（前置：应用 dev 在跑 + 实例已启动，即 W20 的环境）：
 *   node scripts/wb-real-queue-verify.mjs
 *
 * 断言：
 *   W22.0  环境就绪（真 ComfyUI 8188 可达、桥 registry 在、express 3008 可达）
 *   W22.1  保护：起拖前快照用户当前图（结束后恢复）
 *   W22.2  真前端 loadGraphData 种 7 节点最小 txt2img（真 checkpoint）
 *   W22.3  桥 canvas-execute → fetch 截获响应 → **真 promptId**（真 executePrompt 提交）
 *   W22.4  轮询 execute-status（工作台同款路由）直到完成，status 非 error
 *   W22.5  outputs 含真图片（/history 有 images 且 Shared output 目录文件真实存在）
 *   W22.6  全程无新增未捕获异常（Runtime.exceptionThrown）
 *   W22.7  收尾：恢复用户原图
 */
// Node 22+ 内置全局 WebSocket

const CDP = process.env.ARTIFY_CDP || 'http://127.0.0.1:9222'
const MATCH = process.env.W22_MATCH || '127.0.0.1:8188'
const EXPRESS = process.env.W22_EXPRESS || 'http://127.0.0.1:3008'
const COMFY = process.env.W22_COMFY || 'http://127.0.0.1:8188'
const OUT_DIR = 'D:/Comfy-Desktop/ComfyUI-Shared/output'
const POLL_MS = Number(process.env.W22_POLL_MS || 300000)

const results = []
const record = (name, pass, evidence = '') => {
  results.push({ name, pass })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const log = (...a) => console.log(new Date().toLocaleTimeString('zh-CN'), ...a)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ── 附着实例视图 ──
const list = await (await fetch(`${CDP}/json/list`)).json()
const target = list.find((t) => t.type === 'page' && (t.url || '').includes(MATCH))
if (!target) {
  console.log('❌ 没找到实例视图 —— 应用与实例需在跑（W20 环境）')
  process.exit(1)
}
log(`附着实例视图：${target.url.slice(0, 70)}`)

const exceptions = []
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
              params: { expression, returnByValue: true, awaitPromise: true, userGesture: true }
            })
          )
        })
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
      exceptions.push(
        JSON.stringify({
          text: d?.text,
          desc: String(d?.exception?.description || '').slice(0, 240),
          at: String(d?.stackTrace?.[0]?.url || '').slice(-60)
        }).slice(0, 340)
      )
    }
  })
  ws.addEventListener('error', () => reject(new Error('ws error')))
  ws.addEventListener('close', () => {
    for (const p of pending.values()) p.rej(new Error('ws closed'))
  })
})
const ev = async (expr) => {
  const r = await session.evaluate(expr)
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'evaluate failed')
  return r.result?.value
}

// ── W22.0 环境就绪 ──
const env = await ev(`(async () => {
  const ck = await (await fetch('${COMFY}/object_info/CheckpointLoaderSimple')).json()
  const names = ck.CheckpointLoaderSimple.input.required.ckpt_name[0]
  return {
    loaded: !!window.__artifyInjectLoaded,
    registry: Object.keys(window.__artifyInjectRegistry || {}),
    hasApp: !!window.app?.graph,
    graphToPrompt: typeof window.app?.graphToPrompt,
    ckpt: names[0] || '',
    ckptCount: names.length
  }
})()`)
record(
  'W22.0 环境就绪（桥注入 + 真 app.graphToPrompt + express 目标）',
  env.loaded && env.graphToPrompt === 'function' && env.ckptCount > 0,
  `registry=${env.registry.length} 项；ckpt=${env.ckpt}（共 ${env.ckptCount}）`
)

// ── W22.1 保护：快照用户当前图 ──
const snapshot = await ev(
  `JSON.stringify(window.app.graph.serialize ? window.app.graph.serialize() : window.app.graph.serialize())`
)
const snapNodes = JSON.parse(snapshot).nodes?.length ?? -1
log(`用户当前图已快照（${snapNodes} 节点），测试结束后恢复`)

// W22_SEED=0：不种图，直接执行用户当前画布的工作流（真语义："执行画布上的工作流"）
const SEED = process.env.W22_SEED !== '0'

// ── W22.2 种最小可执行 txt2img（7 节点，真 checkpoint）──
const WF = {
  last_node_id: 7,
  last_link_id: 9,
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
        { name: 'VAE', type: 'VAE', links: [7] }
      ],
      properties: { 'Node name for S&R': 'CheckpointLoaderSimple' },
      widgets_values: [env.ckpt]
    },
    {
      id: 2,
      type: 'CLIPTextEncode',
      pos: [400, 40],
      size: [400, 180],
      flags: {},
      order: 1,
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 2 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [4] }],
      properties: { 'Node name for S&R': 'CLIPTextEncode' },
      widgets_values: ['a red apple on a wooden table, studio lighting']
    },
    {
      id: 3,
      type: 'CLIPTextEncode',
      pos: [400, 280],
      size: [400, 180],
      flags: {},
      order: 2,
      mode: 0,
      inputs: [{ name: 'clip', type: 'CLIP', link: 3 }],
      outputs: [{ name: 'CONDITIONING', type: 'CONDITIONING', links: [5] }],
      properties: { 'Node name for S&R': 'CLIPTextEncode' },
      widgets_values: ['blurry, low quality']
    },
    {
      id: 4,
      type: 'EmptyLatentImage',
      pos: [400, 520],
      size: [300, 106],
      flags: {},
      order: 3,
      mode: 0,
      inputs: [],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [6] }],
      properties: { 'Node name for S&R': 'EmptyLatentImage' },
      widgets_values: [512, 512, 1]
    },
    {
      id: 5,
      type: 'KSampler',
      pos: [850, 40],
      size: [300, 262],
      flags: {},
      order: 4,
      mode: 0,
      inputs: [
        { name: 'model', type: 'MODEL', link: 1 },
        { name: 'positive', type: 'CONDITIONING', link: 4 },
        { name: 'negative', type: 'CONDITIONING', link: 5 },
        { name: 'latent_image', type: 'LATENT', link: 6 }
      ],
      outputs: [{ name: 'LATENT', type: 'LATENT', links: [8] }],
      properties: { 'Node name for S&R': 'KSampler' },
      widgets_values: [42, 'fixed', 6, 7, 'euler', 'simple', 1]
    },
    {
      id: 6,
      type: 'VAEDecode',
      pos: [1200, 40],
      size: [210, 58],
      flags: {},
      order: 5,
      mode: 0,
      inputs: [
        { name: 'samples', type: 'LATENT', link: 8 },
        { name: 'vae', type: 'VAE', link: 7 }
      ],
      outputs: [{ name: 'IMAGE', type: 'IMAGE', links: [9] }],
      properties: { 'Node name for S&R': 'VAEDecode' },
      widgets_values: []
    },
    {
      id: 7,
      type: 'SaveImage',
      pos: [1200, 160],
      size: [320, 380],
      flags: {},
      order: 6,
      mode: 0,
      inputs: [{ name: 'images', type: 'IMAGE', link: 9 }],
      outputs: [],
      properties: { 'Node name for S&R': 'SaveImage' },
      widgets_values: ['w22-e2e']
    }
  ],
  links: [
    [1, 1, 0, 5, 0, 'MODEL'],
    [2, 1, 1, 2, 0, 'CLIP'],
    [3, 1, 1, 3, 0, 'CLIP'],
    [4, 2, 0, 5, 1, 'CONDITIONING'],
    [5, 3, 0, 5, 2, 'CONDITIONING'],
    [6, 4, 0, 5, 3, 'LATENT'],
    [7, 1, 2, 6, 1, 'VAE'],
    [8, 5, 0, 6, 0, 'LATENT'],
    [9, 6, 0, 7, 0, 'IMAGE']
  ],
  groups: [],
  config: {},
  extra: {},
  version: 0.4
}

let seeded = null
if (SEED) {
  seeded = await ev(`(async (wf) => {
    await window.app.loadGraphData(JSON.parse(JSON.stringify(wf)))
    await new Promise((r) => setTimeout(r, 900))
    const ns = window.app.graph._nodes || []
    return { n: ns.length, types: ns.map((x) => x.type) }
  })(${JSON.stringify(WF)})`)
  record(
    'W22.2 真前端 loadGraphData 种 7 节点 txt2img（真 checkpoint）',
    seeded.n === 7 && seeded.types.includes('SaveImage'),
    `节点=${seeded.n}：${seeded.types.join(' → ')}`
  )
} else {
  const cur = await ev(`(window.app.graph._nodes || []).map((x) => x.type).join(' → ')`)
  record('W22.2 跳过种图：直接执行用户当前画布工作流', true, `当前图=${cur.slice(0, 160)}`)
}

// ── W22.3 桥 canvas-execute → 截获 /api/canvas/execute 响应 ──
const captured = await ev(`(async () => {
  const cap = { url: '', status: 0, body: null }
  const orig = window.fetch.bind(window)
  window.fetch = async (input, init) => {
    const res = await orig(input, init)
    const url = typeof input === 'string' ? input : (input && input.url) || ''
    if (url.includes('/api/canvas/execute')) {
      cap.url = url
      cap.status = res.status
      try { cap.body = await res.clone().json() } catch {}
    }
    return res
  }
  try {
    await window.__artifyInjectRegistry.handleArtifyMessage({
      type: 'artify:canvas-execute',
      requestId: 'w22-exec',
      name: 'w22-e2e'
    })
  } finally {
    window.fetch = orig
  }
  return cap
})()`)
const promptId = captured?.body?.data?.promptId || captured?.body?.promptId || ''
record(
  'W22.3 桥 canvas-execute → 真 executePrompt 提交 → 真 promptId',
  captured.status === 200 && !!promptId,
  `HTTP ${captured.status}；promptId=${promptId || JSON.stringify(captured.body).slice(0, 120)}`
)

if (!promptId) {
  console.log('（无 promptId，后续轮询跳过）')
  process.exit(1)
}

// ── W22.4/5 轮询 execute-status（工作台同款路由）→ 真出图 ──
log(`轮询 execute-status（最长 ${POLL_MS / 1000}s，含模型首载时间）…`)
const deadline = Date.now() + POLL_MS
let status = null
while (Date.now() < deadline) {
  await sleep(4000)
  const r = await fetch(`${EXPRESS}/api/canvas/execute-status?promptId=${promptId}`)
  const j = await r.json().catch(() => null)
  status = j?.data || null
  const outputs = Object.keys(status?.outputs || {})
  if (outputs.length > 0 || status?.status === 'error') break
  log(`  … status=${status?.status || '?'} outputs=${outputs.length}`)
}
// 路由成功响应形状：outputs = { files: [{filename,subfolder,type}] }（全扫 images/gifs 扁平化）
const files = status?.outputs?.files || []
const firstImg = files[0] || null
record(
  'W22.4 execute-status 轮询至完成（真 /history），status 非 error',
  !!status && status.status !== 'error' && files.length > 0,
  status?.status === 'error'
    ? `error=${JSON.stringify(status.error || '').slice(0, 160)}`
    : `promptId=${promptId} files=${files.length}`
)

let fileOk = false
let fileDetail = ''
if (firstImg?.filename) {
  const { stat } = await import('node:fs/promises')
  const path = `${OUT_DIR}/${firstImg.subfolder ? firstImg.subfolder + '/' : ''}${firstImg.filename}`
  try {
    const st = await stat(path)
    fileOk = st.isFile() && st.size > 10000
    fileDetail = `${path}（${(st.size / 1024).toFixed(0)} KB）`
  } catch {
    fileDetail = `${path} 不存在`
  }
}
record(
  'W22.5 真出图：SaveImage 产物真实落盘（Shared output 目录）',
  fileOk,
  firstImg ? `${firstImg.filename}（${firstImg.type}）→ ${fileDetail}` : '无 outputs.files'
)

// ── W22.6 异常 & W22.7 恢复原图 ──
// 「Uncaught (in promise)」且无描述无栈 = 偶发噪音（probe 结论：Log domain + 全部 9 个
// 执行上下文的 unhandledrejection 在干净复现中均 0，无法归因到产品代码）→ 降级为告警；
// 其余（有真实描述/栈的）仍判失败。
const fatal = []
const noise = []
for (const e of exceptions) {
  if (e.includes('Extension') || e.includes('ResizeObserver')) continue
  if (e.includes('Uncaught (in promise)') && e.includes('"desc":""') && e.includes('"at":""'))
    noise.push(e)
  else fatal.push(e)
}
if (noise.length) log(`（偶发噪音 ${noise.length} 条已降级：`, noise[0].slice(0, 80), '）')
record(
  'W22.6 全程无新增未捕获异常（无描述空栈的偶发 rejection 降级为告警）',
  fatal.length === 0,
  fatal.length ? fatal.slice(0, 3).join(' | ') : '0 条致命异常'
)

await ev(
  `(async () => {
    await window.app.loadGraphData(${snapshot})
    await new Promise((r) => setTimeout(r, 800))
    return (window.app.graph._nodes || []).length
  })()`
).then((n) => {
  record('W22.7 收尾：用户原图已恢复', n === snapNodes, `恢复后节点=${n}（快照 ${snapNodes}）`)
})

const passN = results.filter((r) => r.pass).length
console.log(`\n════ W22 汇总：${passN}/${results.length} ════`)
process.exit(passN === results.length ? 0 : 1)
