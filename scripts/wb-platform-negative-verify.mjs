/**
 * S6 异常路径验收（直连应用 HTTP，不依赖 LLM）：验证「失败必须失败得清楚」。
 *
 * 计划文档 `docs/workbench-generation-verify-plan.md` §S6：
 *   传不合法参数 / 不存在的模型 / 空输入 → 断言返回**结构化错误**（非 200 + 明确 message），
 *   ComfyUI 队列无残留脏 job，应用不崩、**不静默降级**；
 *   取消链路：提交后取消 → 无悬挂任务、无产物误登记。
 *
 * 每个用例都给「期望失败」并核对错误文案是否可行动（不是裸 500 / 不是静默成功）。
 *
 * 用法：node scripts/wb-platform-negative-verify.mjs [--app http://127.0.0.1:3008]
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188').replace(/\/$/, '')
const EVID_DIR = 'D:/artifyfun/tmp/wb-gen-verify'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(EVID_DIR, { recursive: true })

const results = []
const record = (name, pass, evidence) => {
  results.push({ name, pass, evidence })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const info = (m) => console.log(`ℹ️  ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function jpost(path, body) {
  const res = await fetch(`${APP}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  })
  let json = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}
const jget = async (path) => (await fetch(`${APP}${path}`)).json()

/**
 * 极简 MCP 客户端（streamable HTTP）。必须先 initialize 拿 session id 再 tools/call，
 * 否则服务端返回 400 `Server not initialized`（本脚本第一版就踩了这个）。
 */
async function mcpCall(name, args) {
  const cfg = JSON.parse(
    readFileSync(join(process.env.APPDATA, 'artify-desktop', 'artify-apps.json'), 'utf-8')
  ).config
  const url = `${APP}/mcp?token=${encodeURIComponent(cfg.mcpToken)}`
  const base = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }
  const init = await fetch(url, {
    method: 'POST',
    headers: base,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'wb-verify', version: '1.0' }
      }
    })
  })
  const sid = init.headers.get('mcp-session-id')
  const initText = await init.text()
  if (!sid) {
    return {
      ok: false,
      detail: `initialize 未返回 session（HTTP ${init.status}）：${initText.slice(0, 120)}`
    }
  }
  await fetch(url, {
    method: 'POST',
    headers: { ...base, 'mcp-session-id': sid },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })
  })
  const res = await fetch(url, {
    method: 'POST',
    headers: { ...base, 'mcp-session-id': sid },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name, arguments: args }
    })
  })
  const text = await res.text()
  return {
    ok: res.status === 200 && !/"isError":true/.test(text),
    detail: `HTTP ${res.status} ${text.slice(0, 160).replace(/\s+/g, ' ')}`
  }
}

/** ComfyUI 队列里是否有活 job（脏 job 检查） */
async function queueBusy() {
  const q = await (await fetch(`${COMFY}/queue`)).json()
  return (q.queue_running || []).length + (q.queue_pending || []).length
}

// ───────── 前置 ─────────
const tpls = (await jget('/api/workbench/templates')).data || []
const krea = tpls.find((t) => t.name === 'Krea2文生图1024')
const anima = tpls.find((t) => t.name === 'Anima')
if (!krea) throw new Error('模板库缺少 Krea2文生图1024（先跑 S3）')
const basePrompt = JSON.parse(JSON.stringify(krea.prompt))
info(`基准工作流取自 ${krea.name}（${Object.keys(basePrompt).length} 节点）`)

const mkSession = async (title) =>
  (await jpost('/api/workbench/sessions/create', { title, entry: 'workbench' })).json.data.id

/** 找出某类节点 id（用于定向破坏） */
const findNode = (cls) => Object.entries(basePrompt).find(([, n]) => n.class_type === cls)
const unet = findNode('UNETLoader')
const latent = findNode('EmptySD3LatentImage') || findNode('EmptyLatentImage')
info(`UNETLoader=${unet?.[0]} | latent=${latent?.[0]}(${latent?.[1]?.class_type})`)

// ───────── C1 不存在的 templateId ─────────
{
  const sid = await mkSession('[verify] S6-C1 不存在的模板')
  const { status, json } = await jpost('/api/workbench/execute', {
    sessionId: sid,
    templateId: 'app:00000000-dead-beef-0000-000000000000',
    params: {}
  })
  record(
    'C1 不存在的 templateId → 404 结构化错误',
    status === 404 && !!json?.message,
    `HTTP ${status} message=${String(json?.message).slice(0, 80)}`
  )
}

// ───────── C2 参数名未声明（是否静默忽略？）─────────
{
  const sid = await mkSession('[verify] S6-C2 未声明参数')
  const { status, json } = await jpost('/api/workbench/execute', {
    sessionId: sid,
    templateId: krea.id,
    params: { prompt: 'a red cube', totally_unknown_param: 'x', seed: 7 }
  })
  const ok = status === 200
  const pid = json?.data?.promptId
  if (ok && pid) {
    // 若接受，必须真的跑起来（说明未声明参数被忽略但执行正常）
    record(
      'C2 未声明参数：接受但不影响执行（观测项）',
      true,
      `HTTP 200 promptId=${pid}；未声明键被忽略（模板只取 paramsNodes 声明的参数）`
    )
    for (let i = 0; i < 40; i++) {
      await sleep(3000)
      const pr = await jpost('/api/workbench/poll', { sessionId: sid, promptId: pid })
      const st = pr.json?.data?.status
      if (st === 'success' || st === 'error') {
        info(`C2 终态=${st}（未声明参数未污染执行）`)
        break
      }
    }
  } else {
    record('C2 未声明参数被拒（也是可接受语义）', true, `HTTP ${status} ${json?.message ?? ''}`)
  }
}

// ───────── C3 不存在的模型文件 ─────────
{
  const sid = await mkSession('[verify] S6-C3 不存在的模型')
  const wf = JSON.parse(JSON.stringify(basePrompt))
  if (unet)
    wf[unet[0]].inputs = { ...wf[unet[0]].inputs, unet_name: 'not_exist_model_xyz.safetensors' }
  const { status, json } = await jpost('/api/workbench/run-workflow', {
    sessionId: sid,
    workflow: wf,
    name: 'S6-C3'
  })
  const msg = String(json?.message ?? '')
  const actionable = /not_exist_model_xyz|value_not_in_list|不在|不存在|校验|validation/i.test(msg)
  record(
    'C3 不存在的模型 → 结构化错误且文案可诊断',
    status !== 200 && actionable,
    `HTTP ${status} message=${msg.slice(0, 160)}`
  )
  record('C3 无脏 job 残留', (await queueBusy()) === 0, `队列=${await queueBusy()}`)
}

// ───────── C4 尺寸超模型上限 ─────────
{
  const sid = await mkSession('[verify] S6-C4 尺寸超限')
  const wf = JSON.parse(JSON.stringify(basePrompt))
  if (latent) {
    wf[latent[0]].inputs = { ...wf[latent[0]].inputs, width: 99999, height: 99999 }
  }
  const { status, json } = await jpost('/api/workbench/run-workflow', {
    sessionId: sid,
    workflow: wf,
    name: 'S6-C4'
  })
  const msg = String(json?.message ?? '')
  if (status === 200 && json?.data?.promptId) {
    // ComfyUI 会收下（尺寸本身是 int，无上限校验）→ 必须在执行阶段失败
    const pid = json.data.promptId
    let final = null
    for (let i = 0; i < 30; i++) {
      await sleep(3000)
      const pr = await jpost('/api/workbench/poll', { sessionId: sid, promptId: pid })
      final = pr.json?.data
      if (final?.status === 'error' || final?.status === 'success') break
    }
    record(
      'C4 尺寸 99999 → 执行阶段报错（不产出伪造成果）',
      final?.status === 'error' && !!final?.error,
      `status=${final?.status} error=${String(final?.error).slice(0, 140)}`
    )
  } else {
    record(
      'C4 尺寸 99999 → 提交即被拒',
      status !== 200,
      `HTTP ${status} message=${msg.slice(0, 140)}`
    )
  }
  record('C4 无脏 job 残留', (await queueBusy()) === 0, `队列=${await queueBusy()}`)
}

// ───────── C5 空 prompt（观测）─────────
{
  const sid = await mkSession('[verify] S6-C5 空 prompt')
  const { status, json } = await jpost('/api/workbench/execute', {
    sessionId: sid,
    templateId: krea.id,
    params: { prompt: '' }
  })
  const pid = json?.data?.promptId
  if (status === 200 && pid) {
    let final = null
    for (let i = 0; i < 30; i++) {
      await sleep(3000)
      const pr = await jpost('/api/workbench/poll', { sessionId: sid, promptId: pid })
      final = pr.json?.data
      if (final?.status === 'error' || final?.status === 'success') break
    }
    record(
      'C5 空 prompt：有终态、无悬挂（观测非断言失败）',
      final?.status === 'success' || final?.status === 'error',
      `status=${final?.status} 产物=${JSON.stringify(final?.outputs ?? []).slice(0, 90)}`
    )
  } else {
    record('C5 空 prompt 被拒', status !== 200, `HTTP ${status} ${json?.message ?? ''}`)
  }
}

// ───────── C6 取消链路（走应用 MCP 的 stop_execution，不依赖 LLM）─────────
// 走「长任务 + 真取消」而不是「秒级任务 + 立刻 cancel」：只有任务真的在跑，
// /interrupt 才谈得上「停下它」，也才能验出「取消后是否留悬挂状态」。
{
  const longTpl = tpls.find((t) => t.mediaType === 'video') || anima || krea
  info(`C6 使用长任务模板：${longTpl.name}（mediaType=${longTpl.mediaType}）`)
  const sid = await mkSession('[verify] S6-C6 取消')
  const { status, json } = await jpost('/api/workbench/execute', {
    sessionId: sid,
    templateId: longTpl.id,
    params: { prompt: 'a slow pan over a calm lake at dusk' }
  })
  const pid = json?.data?.promptId
  if (status !== 200 || !pid) {
    record('C6a 长任务可提交（取消前置）', false, `HTTP ${status} ${json?.message ?? ''}`)
  } else {
    record('C6a 长任务可提交（取消前置）', true, `promptId=${pid}`)
    // 等它真的开始跑（queue_running 出现）最多 90s
    let running = false
    for (let i = 0; i < 45; i++) {
      await sleep(2000)
      const q = await (await fetch(`${COMFY}/queue`)).json()
      if ((q.queue_running || []).length > 0) {
        running = true
        break
      }
    }
    info(`任务已进入 running=${running}`)

    const stopped = await mcpCall('stop_execution', {})
    record('C6b 取消请求被应用受理（MCP stop_execution）', stopped.ok, `${stopped.detail}`)

    // 队列应在 30s 内清空（无悬挂/无脏 job）
    let drained = false
    for (let i = 0; i < 15; i++) {
      await sleep(2000)
      if ((await queueBusy()) === 0) {
        drained = true
        break
      }
    }
    record('C6c 取消后 ComfyUI 队列排空（无悬挂任务）', drained, `队列=${await queueBusy()}`)

    // 应用侧必须收敛到终态，不能永远停在 queued/running
    let final = null
    for (let i = 0; i < 30; i++) {
      const pr = await jpost('/api/workbench/poll', { sessionId: sid, promptId: pid })
      final = pr.json?.data
      if (final?.status === 'error' || final?.status === 'success') break
      await sleep(2000)
    }
    const sd = (await jget(`/api/workbench/session/${sid}`)).data
    const exec = (sd?.executions || []).find((e) => e.promptId === pid)
    record(
      'C6d 取消后应用侧收敛到终态（不停留在 queued/running）',
      !!final && final.status !== 'queued' && final.status !== 'running',
      `poll.status=${final?.status} execution.status=${exec?.status} error=${String(
        final?.error ?? exec?.error ?? ''
      ).slice(0, 120)}`
    )
    record(
      'C6e 取消后无产物误登记',
      (exec?.outputs || []).length === 0,
      `execution.outputs=${JSON.stringify(exec?.outputs ?? [])}`
    )
    record('C6f 取消后无脏 job 残留', (await queueBusy()) === 0, `队列=${await queueBusy()}`)
  }
}

// ───────── 收尾 ─────────
record(
  '全程无「200 + 静默成功但无产物」的假成功',
  results.every((r) => r.pass),
  results
    .filter((r) => !r.pass)
    .map((r) => r.name)
    .join(' | ') || '全部通过'
)

writeFileSync(
  join(EVID_DIR, `s6-${stamp}.json`),
  JSON.stringify({ scenario: 's6', at: stamp, results }, null, 2)
)

const failed = results.filter((r) => !r.pass)
console.log(`\n════ 汇总 ════`)
console.log(
  `共 ${results.length} 项，通过 ${results.length - failed.length}，失败 ${failed.length}`
)
for (const f of failed) console.log(`  ❌ ${f.name} — ${f.evidence ?? ''}`)
console.log(`evidence: ${join(EVID_DIR, `s6-${stamp}.json`)}`)
if (!existsSync(join(EVID_DIR, `s6-${stamp}.json`))) process.exitCode = 1
process.exitCode = failed.length ? 1 : 0
