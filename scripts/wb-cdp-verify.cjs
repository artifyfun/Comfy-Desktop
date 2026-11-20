/**
 * CDP 驱动的真实页面验证（零依赖，Node 原生 WebSocket）。
 * 流程：连 Electron CDP → 找/开工作台页 → 发消息 → 等确认卡 → 执行 →
 *       验证快照落盘 + 面板渲染 → 截图输出到 /tmp。
 */
const CDP_PORT = 9223
const fs = require('node:fs')

async function getTargets() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  return res.json()
}

const sleep0 = (ms) => new Promise((r) => setTimeout(r, ms))

/** 最小 CDP 客户端：单 WebSocket，id 递增，事件监听 */
class CdpPage {
  constructor(ws, send, onEvent) {
    this.ws = ws
    this.send = send
    this.onEvent = onEvent
  }
  cmd(method, params = {}) {
    return this.send(method, params)
  }
}

async function connectTo(urlSubstring) {
  const targets = await getTargets()
  let page = targets.find((t) => t.type === 'page' && t.url.includes(urlSubstring))
  if (!page) {
    // 用 /json/new 开新页
    const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/new?${encodeURIComponent('http://127.0.0.1:3008/canvas')}`, { method: 'PUT' })
    page = await res.json()
    await new Promise((r) => setTimeout(r, 3000))
  }
  return page
}

async function main() {
  // 1. 附着到主窗口 target（Electron BrowserWindow；空白 title/url 是正常态）
  const targets = await getTargets()
  // 优先 url 含 canvas/workbench 的；否则挑第一个空 url 的 page（主窗口）
  let target =
    targets.find((t) => t.type === 'page' && (t.url.includes('/canvas') || t.url.includes('/workbench'))) ||
    targets.find((t) => t.type === 'page' && !t.url)
  if (!target) {
    console.error('❌ 无可附着 page target:', targets.map((t) => t.url.slice(0, 40)))
    process.exit(1)
  }
  console.log('附着 target:', (target.url || '(主窗口)').slice(0, 50))

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = (e) => reject(new Error('ws error'))
  })

  let id = 0
  const pending = new Map()
  const events = []
  ws.onmessage = (msg) => {
    const data = JSON.parse(msg.data)
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id)
      pending.delete(data.id)
      if (data.error) reject(new Error(JSON.stringify(data.error)))
      else resolve(data.result)
    } else if (data.method) {
      events.push(data)
      if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'warning') {
        const text = (data.params.args || []).map((a) => a.value ?? '').join(' ')
        if (text.includes('aiSnapshot')) console.log('[console.warn]', text.slice(0, 150))
      }
      if (data.method === 'Runtime.exceptionThrown') {
        console.log('[page exception]', String(data.params.exceptionDetails?.exception?.description || data.params.exceptionDetails?.text).slice(0, 150))
      }
    }
  }
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const mid = ++id
      pending.set(mid, { resolve, reject })
      ws.send(JSON.stringify({ id: mid, method, params }))
    })
  const evaluate = async (expression, awaitPromise = false) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise })
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    return r.result?.value
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync(`/tmp/wb-cdp-${name}.png`, Buffer.from(r.data, 'base64'))
    console.log(`  📸 /tmp/wb-cdp-${name}.png`)
  }

  await send('Page.enable')
  await send('Runtime.enable')

  // 2. 导航到画布（拿最新产物）
  await send('Page.navigate', { url: 'http://127.0.0.1:3008/canvas?cdp=' + Date.now() })
  await sleep(4500)

  // 3. 挂探针 + 清快照
  await evaluate(`(() => {
    localStorage.removeItem('artify.canvas.aiSnapshots.v1');
    window.__snapErrs = [];
    const ow = console.warn;
    console.warn = (...a) => { if (String(a[0]).includes('aiSnapshot')) window.__snapErrs.push(a.join(' ')); ow(...a); };
    return 'hooked';
  })()`)
  console.log('✓ 探针挂载, 快照已清')

  // 4. 侧栏发消息
  const sent = await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'no-textarea';
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, '把模板库里的 3 个模板铺到画布搭成工作流');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    return 'filled';
  })()`)
  console.log('填入:', sent)
  await evaluate(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const send = btns.find(b => b.querySelector('.fa-arrow-up'));
    if (send) { send.click(); return true; }
    return false;
  })()`)
  console.log('✓ 已发送，等模型决策...')

  // 5. 轮询确认卡
  let cardUp = false
  for (let i = 0; i < 10; i++) {
    await sleep(20000)
    cardUp = await evaluate(`!!document.querySelector('.agent-ops-card')`)
    console.log(`  [${(i + 1) * 20}s] 确认卡: ${cardUp}`)
    if (cardUp) break
  }
  await shot('1-card')
  if (!cardUp) {
    console.log('❌ 确认卡未出现')
    await browser.close?.()
    process.exit(1)
  }

  // 6. 点执行
  await evaluate(`(() => {
    const card = document.querySelector('.agent-ops-card');
    const btn = card && [...card.querySelectorAll('button')].find(b => b.textContent.trim() === '执行');
    if (btn) { btn.click(); return true; }
    return false;
  })()`)
  console.log('✓ 已点执行')
  await sleep(3000)
  await shot('2-applied')

  // 7. 验证三件事
  const result = await evaluate(`(() => {
    const raw = localStorage.getItem('artify.canvas.aiSnapshots.v1');
    const panel = [...document.querySelectorAll('*')].some(e => e.children.length === 0 && e.textContent.includes('AI 快照'));
    const nodeMatch = document.body.textContent.match(/(\\d+)\\s*节点/);
    return JSON.stringify({ snapErrs: window.__snapErrs || [], hasSnap: !!raw,
      panelVisible: panel, nodeCount: nodeMatch ? nodeMatch[1] : null,
      snap: raw ? JSON.parse(raw).projects : null });
  })()`)
  const r = JSON.parse(result)
  console.log('=== 最终验证 ===')
  console.log('快照落盘:', r.hasSnap ? '✅' : '❌', '| 面板渲染:', r.panelVisible ? '✅' : '❌', '| 节点数:', r.nodeCount)
  if (r.snapErrs.length) console.log('快照警告:', r.snapErrs)
  console.log('快照数据:', JSON.stringify(r.snap).slice(0, 300))
  await shot('3-final')

  ws.close()
  process.exit(0)
}

main().catch((e) => {
  console.error('验证失败:', e.message)
  process.exit(1)
})
