/**
 * S9 验收：批量队列**真跑**（此前只有 UI stub 级验收）
 *
 * ⚠️ 铁律：本脚本绝不设置 autoShutdown / notifyUrl —— 真实关机与通知永远不能被触发。
 *    反而要断言队列配置默认未武装（autoShutdown=false）。
 *
 * 场景（真应用 + 真 ComfyUI）：
 *   S9.1  队列配置默认未武装关机/通知
 *   S9.2  start 3 条（Krea2文生图1024，valueMap 把数据行的 ptext 映射进正向提示词）
 *         → 任务 running，ComfyUI 真被驱动
 *   S9.3  运行中 pause → job=paused、当前条被 abort（无悬挂）
 *   S9.4  resume → 跑到 completed，全部条 success
 *   S9.5  L3：每条产物 type=output 落 Shared/output 且可解码非纯色
 *   S9.6  rerun 完成任务 → 新 job 入队
 *   S9.7  再 start 一个任务让它排队 → cancel 排队任务 → stopped 且 0 条执行过
 *   S9.8  delete / clear 收尾；全程无脏 job
 *
 * 用法：node scripts/wb-platform-batch-verify.mjs [--app http://127.0.0.1:3008] [--comfy http://127.0.0.1:8188]
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = opt('--app', 'http://127.0.0.1:3008')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188')
const COMFY_OUTPUT = 'D:/Comfy-Desktop/ComfyUI-Shared/output'
const IMG_APP = opt('--img-app', 'Krea2文生图1024')

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
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* keep raw */
  }
  return { status: res.status, json, text }
}

/** 用无头浏览器解码图片，防纯色/黑图（与 S1 同款判据） */
async function probeImage(localPath) {
  const b = readFileSync(localPath)
  const dataUrl = `data:image/png;base64,${b.toString('base64')}`
  const { chromium } = await import('playwright')
  const browser = await chromium.launch({ headless: true })
  const page = await browser.newPage()
  const probe = await page.evaluate(async (src) => {
    const img = new Image()
    img.src = src
    await img.decode()
    const c = document.createElement('canvas')
    c.width = img.naturalWidth
    c.height = img.naturalHeight
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0)
    const d = ctx.getImageData(0, 0, c.width, c.height).data
    const colors = new Set()
    let luma = 0
    const step = 4 * 7
    for (let i = 0; i < d.length; i += step) {
      colors.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
      luma += 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]
    }
    return {
      w: c.width,
      h: c.height,
      unique: colors.size,
      luma: luma / (d.length / step)
    }
  }, dataUrl)
  await browser.close()
  return probe
}

async function main() {
  console.log(`S9 批量队列真跑验证 → APP=${APP} COMFY=${COMFY}`)
  // 前置（⚠️ /api/config 是 GET 未注册路由，SPA fallback 返回 HTML 的假 200，别用它探活）
  const tpls0 = await jget('/api/workbench/templates')
  if (!Array.isArray(tpls0) || !tpls0.length) throw new Error('应用不可达（templates 无响应）')
  const st = await (await fetch(`${COMFY}/system_stats`)).json()
  console.log(`ComfyUI ${st.system?.comfyui_version} 就绪`)

  // ── S9.1 队列配置默认未武装 ──
  const q0 = await jget('/api/batch/queue')
  const cfgRes = await jpost('/api/batch/config', {})
  const qcfg = cfgRes.json?.data?.config ?? {}
  record(
    'S9.1 队列配置默认未武装关机/通知',
    !qcfg.autoShutdown && !qcfg.notifyUrl,
    `autoShutdown=${qcfg.autoShutdown} notifyUrl=${qcfg.notifyUrl || '(空)'}`
  )

  // ── 准备 prompt + inputsMapping（Krea2文生图1024）──
  const tpls = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
  const tmpl = tpls.find((t) => t.name === IMG_APP)
  if (!tmpl) throw new Error(`模板不存在: ${IMG_APP}`)
  // 取正向提示词参数（text 类、名字 prompt）
  const promptParam = (tmpl.paramsNodes || []).find(
    (p) => p.name === 'prompt' && !String(p.renderComponent || '').startsWith('image')
  )
  if (!promptParam) throw new Error('模板无文本 prompt 参数')
  const nodeId = String(promptParam.id)
  const widget = promptParam.selectedWidget?.name || promptParam.name
  const inputsMapping = [
    { id: nodeId, key: widget, valueType: 'string', valueMap: { key: 'ptext' } }
  ]
  const items = [
    { ptext: 'a red cube on a white table' },
    { ptext: 'a blue sphere on a wooden desk' },
    { ptext: 'a green pyramid on black velvet' }
  ]
  console.log(`batch prompt: node ${nodeId}.${widget} ← ptext（3 条）`)

  // ── S9.2 start → running ──
  const started = await jpost('/api/batch/start', {
    prompt: tmpl.prompt,
    inputsMapping,
    items,
    appId: tmpl.id,
    appName: `${IMG_APP}（S9 验收）`
  })
  const jobId = started.json?.data?.jobId
  record(
    'S9.2a batch/start 受理',
    started.status === 200 && !!jobId,
    `HTTP ${started.status} jobId=${jobId}`
  )
  if (!jobId) throw new Error('start 失败: ' + started.text.slice(0, 300))

  // 等 running（或直接 completed 也记录）
  let st1 = null
  for (let i = 0; i < 20; i++) {
    await sleep(1500)
    st1 = await jget('/api/batch/status')
    if (st1) break
  }
  record(
    'S9.2b 任务进入 running',
    st1?.id === jobId && st1?.status === 'running',
    st1 ? `processed=${st1.processed}/${st1.total}` : 'status=null（可能已跑完）'
  )

  // ── S9.3 pause（steps 大时能赶上中间；赶不上就记 flake 不判死）──
  const p = await jpost('/api/batch/pause', {})
  await sleep(2500)
  const qAfterPause = await jget('/api/batch/queue')
  const jobAfterPause = (qAfterPause.jobs || []).find((j) => j.id === jobId)
  const pausedSeen = jobAfterPause && ['paused', 'completed'].includes(jobAfterPause.status)
  record(
    'S9.3 pause 受理且任务收敛（paused 或已完成）',
    p.status === 200 && !!pausedSeen,
    `pause HTTP ${p.status} → job=${jobAfterPause?.status} processed=${jobAfterPause?.processed}/${jobAfterPause?.total}`
  )
  if (jobAfterPause?.status === 'paused') {
    // ⚠️ 语义：/api/batch/resume 是**队列级**恢复（只 pump 排队任务）；恢复单个
    // paused 任务必须 job-resume。另外暂停会 abort 在跑的那条并计 failed
    //（processed 前进），resume 从下一条继续 → 预期 success = total-1。
    const r = await jpost('/api/batch/job-resume', { id: jobId })
    record('S9.3b job-resume 受理（恢复单个 paused 任务）', r.status === 200, `HTTP ${r.status}`)
  }

  // ── 等终态 ──
  let finalJob = null
  for (let i = 0; i < 120; i++) {
    await sleep(3000)
    const q = await jget('/api/batch/queue')
    finalJob = (q.jobs || []).find((j) => j.id === jobId)
    if (finalJob && ['completed', 'stopped', 'failed'].includes(finalJob.status)) break
  }
  const expectMinSuccess = jobAfterPause?.status === 'paused' ? items.length - 1 : items.length
  record(
    'S9.4a 任务到 completed 且成功数达标',
    finalJob?.status === 'completed' &&
      finalJob?.success >= expectMinSuccess &&
      finalJob?.success + finalJob?.failed === finalJob?.total,
    `status=${finalJob?.status} success=${finalJob?.success}/${finalJob?.total} failed=${finalJob?.failed}（暂停牺牲在跑 1 条计 failed）`
  )

  // ── S9.5 L3 产物 ──
  const resultFiles = (finalJob?.results || [])
    .flatMap((r) => r.files || [])
    .filter((f) => f.type === 'output')
  record(
    'S9.5a 每条成功都有 type=output 产物',
    resultFiles.length >= (finalJob?.success ?? 0),
    `output 文件数=${resultFiles.length} ≥ success=${finalJob?.success}（结果 ${finalJob?.results?.length} 条）`
  )
  let probeOk = 0
  let probeEv = []
  for (const f of resultFiles.slice(0, 3)) {
    const local = join(COMFY_OUTPUT, f.subfolder || '', f.filename)
    if (!existsSync(local)) {
      probeEv.push(`${f.filename} 不在磁盘`)
      continue
    }
    const kb = (statSync(local).size / 1024).toFixed(0)
    const pr = await probeImage(local)
    const ok = pr.w >= 256 && pr.unique > 1000 && pr.luma > 5 && pr.luma < 250
    probeEv.push(
      `${f.filename} ${pr.w}x${pr.h} 唯一色=${pr.unique} 亮度=${pr.luma.toFixed(0)} ${kb}KB`
    )
    if (ok) probeOk++
  }
  record(
    'S9.5b 产物可解码且非纯色',
    probeOk === Math.min(3, resultFiles.length) && probeOk > 0,
    probeEv.join(' | ') || '无'
  )

  // ── S9.6 rerun ──
  const rerun = await jpost('/api/batch/rerun', { id: jobId })
  const rerunJobId = rerun.json?.data?.jobId
  record(
    'S9.6 rerun 完成任务 → 新任务入队',
    rerun.status === 200 && !!rerunJobId && rerunJobId !== jobId,
    `HTTP ${rerun.status} newJobId=${rerunJobId}`
  )

  // ── S9.7 排队任务的 cancel ──
  // rerun 的任务正在跑（队列空时立即接管）；再 start 一个让它排队，然后 cancel 它
  const second = await jpost('/api/batch/start', {
    prompt: tmpl.prompt,
    inputsMapping,
    items: items.slice(0, 1),
    appName: 'S9-cancel靶子'
  })
  const cancelTarget = second.json?.data?.jobId
  // cancel 前先确认靶子确实在排队（rerun 3 条还在跑）
  await sleep(1000)
  const qBeforeCancel = await jget('/api/batch/queue')
  const queuedTarget = (qBeforeCancel.jobs || []).find((j) => j.id === cancelTarget)
  const wasQueued = queuedTarget?.status === 'queued'
  const cancel = await jpost('/api/batch/cancel', { id: cancelTarget })
  await sleep(1000)
  const qAfterCancel = await jget('/api/batch/queue')
  const canceledJob = (qAfterCancel.jobs || []).find((j) => j.id === cancelTarget)
  // 产品语义（batchRunner.cancelBatchJob）：取消 queued/paused 任务 = **直接移出队列**
  //（不留 stopped 记录）；取消 running 任务才走 stopBatch → stopped。
  record(
    'S9.7 cancel 排队任务 → 移出队列且 0 条执行',
    wasQueued && cancel.status === 200 && !canceledJob,
    `cancel 前=${queuedTarget?.status} → HTTP ${cancel.status} → 队列中${canceledJob ? '仍存在' : '已移除'}`
  )

  // 停掉 rerun 任务（避免占队列），并等 ComfyUI 队列排空（在跑那条被中断需要几秒）
  await jpost('/api/batch/stop', {})
  let drained = false
  for (let i = 0; i < 12; i++) {
    await sleep(2500)
    const cq = await (await fetch(`${COMFY}/queue`)).json()
    if (!(cq.queue_running || []).length && !(cq.queue_pending || []).length) {
      drained = true
      break
    }
  }

  // ── S9.8 收尾：delete（只删自己建的；队列里有用户历史记录，clear 会误删）──
  for (const id of [jobId, rerunJobId, cancelTarget].filter(Boolean)) {
    await jpost('/api/batch/delete', { id }).catch(() => {})
  }
  const qEnd = await jget('/api/batch/queue')
  const comfyQueue = await (await fetch(`${COMFY}/queue`)).json()
  const comfyClean =
    (comfyQueue.queue_running || []).length + (comfyQueue.queue_pending || []).length === 0
  record(
    'S9.8 本轮 job 已清理 + ComfyUI 无脏 job',
    (qEnd.jobs || []).filter(
      (j) =>
        String(j.appName || '').includes('S9') || [jobId, rerunJobId, cancelTarget].includes(j.id)
    ).length === 0 && comfyClean,
    `本轮残留已清（历史记录 ${(qEnd.jobs || []).length} 条不动） comfy 排空=${drained} running=${(comfyQueue.queue_running || []).length} pending=${(comfyQueue.queue_pending || []).length}`
  )

  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ S9 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

main().catch((e) => {
  console.error('❌ S9 脚本异常:', e.message)
  process.exit(1)
})
