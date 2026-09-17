/**
 * S2/S3/S4：通过工作台 agent 驱动生成（自然语言 → MCP 工具 → 真出图/出视频）。
 *
 * 与 S1（直连 execute）不同，本脚本走 `/api/workbench/agent/run` 的 AG-UI SSE 流，
 * 抓 **agent 真实调用过的工具与参数**，再回到会话/ComfyUI history/磁盘三层核对。
 *
 * 场景：
 *   --scenario s2   自然语言让 agent 跑既有 app（Anima），真出图
 *   --scenario s3   让 agent 用 wb_build_workflow **新建**文生图 app → 发布 → 再真跑一次
 *   --scenario s4   让 agent 新建 **H3 文生视频** app → 发布 → 再真跑一次（耗时长）
 *   --scenario s5   让 agent 对既有 app **同名版本化迭代**（改尺寸）→ 再真跑一次
 *                   （断言 app_versions 新快照 + 产物尺寸随新版本变化）
 *
 * 用法：
 *   node scripts/wb-platform-agent-verify.mjs --scenario s2
 *   node scripts/wb-platform-agent-verify.mjs --scenario s3 --timeout-min 20
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188').replace(/\/$/, '')
const SCENARIO = opt('--scenario', 's2')
/** s2 的目标 app：默认 Anima（带模板漂移的历史样本）；runner 传健康 app 做门禁 */
const S2_APP = opt('--app-name', 'Anima')
/** s2 的画面内容：不给就会触发 agent 按设计先反问澄清（intent=chat），场景就断了 */
const S2_PROMPT = opt('--s2-prompt', '')
const TIMEOUT_MIN = Number(opt('--timeout-min', SCENARIO === 's4' ? '45' : '20'))
const EXPECT_SIZE = opt('--expect-size', null)
const VERSION_APP = opt('--version-app', 'Krea2文生图1024')
const COMFY_ROOT = 'D:/Comfy-Desktop/ComfyUI-Shared'
const EVID_DIR = 'D:/artifyfun/tmp/wb-gen-verify'
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(EVID_DIR, { recursive: true })

const INSTRUCTIONS = {
  s2: `请调用模板 ${S2_APP} 生成一张图片${S2_PROMPT ? `：${S2_PROMPT}` : S2_APP === 'Anima' ? '，使用默认输入图' : ''}。`,
  s3:
    '请用 wb_build_workflow 新建一个**文生图** app：' +
    '要求 (1) 暴露一个名为 prompt 的**文本**参数（不要图片上传槽）；' +
    '(2) 出图尺寸 1024x1024；(3) 模型用本地已有的 krea2（diffusion_models/krea2_raw_int8_convrot.safetensors）' +
    '与 qwen_image_vae；(4) 必需节点都要能在 object_info 里查到。' +
    '建好后用 wb_publish_workflow 发布为模板，然后**用它真跑一次**：prompt 用 "a red cube on a white table"。',
  s4:
    '请用 wb_build_workflow 新建一个 **MiniMax H3 文生视频** app：' +
    '要求 (1) 暴露名为 prompt 的文本参数；(2) 用本地已有的 ' +
    'diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors、' +
    'vae/minimax_h3_video_vae_int8_convrot.safetensors、vae/minimax_h3_audio_vae_fp32.safetensors、' +
    'loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors 与 ' +
    'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors（⚠️ 必须用它：H3 的 fl2va 模型配的是这个 32B convrot 编码器；' +
    'qwen3-vl-4b-heretic_fp8_e4m3fn 与之维度不配对，KSampler 会报 19x2560 vs 5120x5376）；' +
    '(3) 输出必须走**保存节点**（不要只接 Preview）；(4) 必需节点都要能在 object_info 里查到。' +
    '建好后用 wb_publish_workflow 发布为模板，然后**用它真跑一次**：prompt 用 "a cat walking on a sunny beach"。',
  s5:
    '请对模板「Krea2文生图1024」做一次**版本化迭代**：' +
    '把默认出图尺寸从 1024x1024 改成 768x768（width/height 两个参数），其余结构与参数名保持不变；' +
    '用 wb_publish_workflow **同名重新发布**（走版本化更新，**不要** force_new）。' +
    '然后用**新版本**真跑一次：prompt 用 "a blue sphere on a black table"。',
  // S4 的「有界迭代」变体：S4 唯一失败项是单轮 15min 决策超时，根因是 agent 一轮里
  // 反复 wb_publish_workflow 23 次（并触发 64 次人审回执）。这里把迭代次数写死，
  // 用来判定「是能力不够，还是 agent 迭代失控」。
  s4b:
    '请用 wb_build_workflow 新建（或同名版本化更新）一个 **MiniMax H3 文生视频** app，要求：' +
    '(1) 暴露 prompt(textarea) 与 width/height(int，默认 1344/768)；' +
    '(2) 用本地已有模型：diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors、' +
    'vae/minimax_h3_video_vae_int8_convrot.safetensors、vae/minimax_h3_audio_vae_fp32.safetensors、' +
    'loras/minimax_h3_fl2v_turbo_8step_v1.0_768p_comfyui_bf16.safetensors、' +
    'text_encoders/qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors（⚠️ 必须用它：H3 的 fl2va 模型配的是这个 32B convrot 编码器；' +
    'qwen3-vl-4b-heretic_fp8_e4m3fn 与之维度不配对，KSampler 会报 19x2560 vs 5120x5376）；' +
    '(3) 输出走 SaveVideo + SaveAudio。' +
    '**硬性约束：wb_validate_workflow 最多 3 次、wb_publish_workflow 最多 1 次**（同名即版本化更新）。' +
    '发布后立刻用 wb_execute_template 真跑一次：prompt="a cat walking on a sunny beach", width=1344, height=768；' +
    '再用 wb_get_outputs 取产物，最后简要报告产物文件名与规格。**不要反复重建或微调工作流**。',
  // S7「自愈/修复」：app 的模板被写坏了（接线错误），让 agent 自己定位、修复、重新发布并验证。
  // 与 S3/S4b 的区别：目标不是从零创建，而是**修一个已存在但不能用的 app**。
  s7:
    '模板「MiniMax H3 文生视频」现在跑不起来：执行会在 KSampler 报 ' +
    '"mat1 and mat2 shapes cannot be multiplied (19x2560 and 5120x5376)"。' +
    '已知根因是它的 CLIPLoader 用了 qwen3-vl-4b-heretic_fp8_e4m3fn.safetensors，' +
    '与 diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors 不配对。' +
    '请把该 CLIPLoader 的 clip_name 改为 ' +
    'qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors（type 保持 minimax），' +
    '**其余一律不动**，用 wb_publish_workflow 同名重新发布（版本化更新），' +
    '然后用 wb_execute_template 真跑一次（prompt="a cat walking on a sunny beach", width=1344, height=768），' +
    '确认能出片后用 wb_get_outputs 取产物并报告文件名与规格。'
}

// ───────── S5 前置：记录目标 app 的版本基线 ─────────
// 口径（见项目记忆）：app_versions 存**被替换的旧态**，生效版本 = 最大快照号 + 1。
let versionBefore = null
let versionAppId = null
if (SCENARIO === 's5') {
  const { DatabaseSync } = await import('node:sqlite')
  const tpls0 = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
  const target = tpls0.find((t) => t.name === VERSION_APP)
  if (!target) throw new Error(`模板库缺少「${VERSION_APP}」`)
  versionAppId = target.appId || target.id.replace(/^app:/, '')
  const db = new DatabaseSync(join(process.env.APPDATA, 'artify-desktop', 'gallery.db'))
  const row = db
    .prepare(
      'select coalesce(max(version), 0) as v, count(*) as c from app_versions where app_id = ?'
    )
    .get(versionAppId)
  versionBefore = { maxSnapshot: Number(row.v), snapshots: Number(row.c) }
  db.close()
  console.log(
    `ℹ️  S5 基线：${VERSION_APP}(${versionAppId}) 快照数=${versionBefore.snapshots} 最大快照号=${versionBefore.maxSnapshot}（生效版本=${versionBefore.maxSnapshot + 1}）`
  )
}

const results = []
const record = (n, ok, ev) => {
  results.push({ name: n, pass: ok, evidence: ev ?? '' })
  console.log(`${ok ? '✅' : '❌'} ${n}${ev ? ' — ' + ev : ''}`)
}
const info = (m) => console.log(`   · ${m}`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const jpost = async (p, b) =>
  (
    await fetch(APP + p, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(b)
    })
  ).json()

async function probeImage(dataUrl) {
  const browser = await chromium.launch({ headless: true })
  try {
    const page = await browser.newPage()
    return await page.evaluate(async (src) => {
      const img = new Image()
      await new Promise((res, rej) => {
        img.onload = res
        img.onerror = () => rej(new Error('decode failed'))
        img.src = src
      })
      const c = document.createElement('canvas')
      c.width = img.naturalWidth
      c.height = img.naturalHeight
      const g = c.getContext('2d')
      g.drawImage(img, 0, 0)
      const d = g.getImageData(0, 0, c.width, c.height).data
      const uniq = new Set()
      let sum = 0
      let n = 0
      for (let i = 0; i < d.length; i += 4 * 37) {
        uniq.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2])
        sum += (d[i] + d[i + 1] + d[i + 2]) / 3
        n++
      }
      return {
        w: img.naturalWidth,
        h: img.naturalHeight,
        unique: uniq.size,
        luma: Math.round(sum / n)
      }
    }, dataUrl)
  } finally {
    await browser.close()
  }
}

// ───────── 跑一轮 agent ─────────
const session = (
  await jpost('/api/workbench/sessions/create', {
    title: `[verify] ${SCENARIO} ${stamp}`,
    entry: 'workbench'
  })
).data
const threadId = session.id
record(`${SCENARIO} 会话创建`, !!threadId, `threadId=${threadId}`)

const runId = `${SCENARIO}-${Date.now()}`
const instruction = INSTRUCTIONS[SCENARIO]
info(`指令：${instruction.slice(0, 120)}…`)

const res = await fetch(`${APP}/api/workbench/agent/run`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ threadId, runId, input: instruction, approvalMode: 'standard' })
})
record(`${SCENARIO} agent run 启动`, res.status === 200, `HTTP ${res.status}`)

const events = []
const toolCalls = []
const customs = []
let runError = null
let finished = false
let currentTool = null
let approved = 0
const reader = res.body.getReader()
const dec = new TextDecoder()
let buf = ''
const deadline = Date.now() + TIMEOUT_MIN * 60_000

while (Date.now() < deadline && !finished) {
  const { value, done } = await reader.read()
  if (done) break
  buf += dec.decode(value, { stream: true })
  const chunks = buf.split('\n\n')
  buf = chunks.pop() || ''
  for (const ch of chunks) {
    const line = ch.split('\n').find((l) => l.startsWith('data:'))
    if (!line) continue
    let ev
    try {
      ev = JSON.parse(line.slice(5).trim())
    } catch {
      continue
    }
    events.push({ type: ev.type, name: ev.toolCallName || ev.name, at: Date.now() })
    if (ev.type === 'TOOL_CALL_START') {
      currentTool = { name: ev.toolCallName, args: '' }
    } else if (ev.type === 'TOOL_CALL_ARGS' && currentTool) {
      currentTool.args += ev.delta || ''
      // 流式 MCP 回帧把 args 分多次给；这里累积，END 时落库
    } else if (ev.type === 'TOOL_CALL_END' && currentTool) {
      toolCalls.push(currentTool)
      info(`工具调用：${currentTool.name} ${currentTool.args.slice(0, 100)}`)
      currentTool = null
    } else if (ev.type === 'CUSTOM') {
      customs.push({ name: ev.name, value: ev.value })
      const brief =
        ev.name === 'wb_plan'
          ? JSON.stringify(ev.value?.plan ?? ev.value).slice(0, 160)
          : ev.name === 'wb_invalid'
            ? JSON.stringify(ev.value).slice(0, 160)
            : ev.name === 'wb_artifact'
              ? `promptId=${ev.value?.promptId} outputs=${JSON.stringify(ev.value?.outputs ?? []).slice(0, 80)}`
              : ''
      info(`CUSTOM ${ev.name} ${brief}`)
      // 人审门：出现待确认的交互请求 → 代表用户点「执行」
      const needsApproval =
        ev.name === 'tool_approval_required' ||
        (ev.value &&
          (ev.value.requestId || ev.value.interactionId) &&
          /approval|confirm/i.test(ev.name || ''))
      if (needsApproval) {
        const payload = {
          threadId,
          runId,
          requestId: ev.value?.requestId || ev.value?.interactionId,
          action: 'approve'
        }
        const r = await jpost('/api/workbench/agent/interaction-response', payload)
        approved++
        info(`人审门：已回执 approve（第 ${approved} 次）→ ok=${r?.ok}`)
      }
    } else if (ev.type === 'RUN_ERROR') {
      runError = ev.message || JSON.stringify(ev).slice(0, 200)
    } else if (ev.type === 'RUN_FINISHED') {
      finished = true
    }
  }
}

record(
  `${SCENARIO} run 正常结束（RUN_FINISHED 且无 RUN_ERROR）`,
  finished && !runError,
  runError || 'ok'
)
// 两条合法路径：① agent 直接调 MCP 工具；② agent 产出 wb_plan 由服务端 dispatch 执行。
// （实测 deepseek-flash 有时跳过 wb_list_* 直接给 plan，这也算「工作台在控制生成」。）
const planFrames = customs.filter((c) => c.name === 'wb_plan')
record(
  `${SCENARIO} agent 触达执行（工具调用或 plan dispatch）`,
  toolCalls.length > 0 || planFrames.length > 0,
  toolCalls.length
    ? `工具：${toolCalls.map((t) => t.name).join(' → ')}`
    : `plan dispatch：templateId=${planFrames.at(-1)?.value?.plan?.templateId}`
)

// ───────── 产物核对 ─────────
const artifactFrame = customs.filter((c) => c.name === 'wb_artifact').pop()
let promptId = artifactFrame?.value?.promptId
const builtTemplateId =
  customs.filter((c) => c.name === 'wb_plan').pop()?.value?.plan?.templateId || null

if (!promptId) {
  record(`${SCENARIO} 拿到 promptId`, false, 'wb_artifact 未带 promptId')
} else {
  record(`${SCENARIO} 拿到 promptId`, true, promptId)
  // 服务端不自己轮询回填（前端定时 poll 才回填）→ 这里对齐前端行为，**轮询到终态**。
  // 只 poll 一次会在 queued/running 时直接返回，导致会话记录停在 queued（曾误判成缺陷）。
  for (let i = 0; i < Math.max(6, (TIMEOUT_MIN * 60) / 5); i++) {
    const pr = await jpost('/api/workbench/poll', { sessionId: threadId, promptId }).catch(
      () => null
    )
    const st = pr?.data?.status
    if (st === 'success' || st === 'error' || st === 'failed') break
    await sleep(5000)
  }

  const hist = (await (await fetch(`${COMFY}/history/${promptId}`)).json())[promptId]
  const outputs = hist?.outputs || {}
  const files = []
  for (const [nid, out] of Object.entries(outputs)) {
    for (const [kind, arr] of Object.entries(out || {})) {
      for (const f of Array.isArray(arr) ? arr : []) {
        if (f?.filename)
          files.push({
            nodeId: nid,
            kind,
            filename: f.filename,
            subfolder: f.subfolder || '',
            type: f.type || 'output'
          })
      }
    }
  }
  const saved = files.filter((f) => f.type === 'output')
  record(
    `${SCENARIO} L2 ComfyUI 执行成功`,
    hist?.status?.status_str === 'success',
    `status=${hist?.status?.status_str} 产出节点=${Object.keys(outputs).length}`
  )
  record(
    `${SCENARIO} L3 存在正式保存产物（type=output）`,
    saved.length > 0,
    saved.length
      ? saved.map((f) => f.filename).join(', ')
      : `只有：${files.map((f) => `${f.filename}(${f.type})`).join(', ') || '无输出'}`
  )

  const target = saved[0] || files.find((f) => /\.(png|jpe?g|webp|mp4|webm)$/i.test(f.filename))
  if (target) {
    const isVideo = /\.(mp4|webm)$/i.test(target.filename)
    if (isVideo) {
      const local = join(
        COMFY_ROOT,
        target.type === 'output' ? 'output' : 'temp',
        target.subfolder,
        target.filename
      )
      record(
        `${SCENARIO} L3 视频产物落盘`,
        existsSync(local),
        `${local} (${existsSync(local) ? (statSync(local).size / 1024 / 1024).toFixed(1) + 'MB' : '不存在'})`
      )
      if (existsSync(local)) {
        // ffprobe 读规格（分辨率/帧率/帧数/时长）；EXPECT_SIZE 给了就断言分辨率
        const pr = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name,width,height,r_frame_rate,nb_frames,duration',
            '-of',
            'json',
            local
          ],
          { encoding: 'utf8' }
        )
        if (pr.status !== 0) {
          record(`${SCENARIO} L3 ffprobe 可解析视频`, false, String(pr.stderr || '').slice(0, 140))
        } else {
          const st = (JSON.parse(pr.stdout).streams || [])[0] || {}
          const [n, d] = String(st.r_frame_rate || '0/1')
            .split('/')
            .map(Number)
          record(
            `${SCENARIO} L3 ffprobe 可解析视频`,
            !!st.codec_name && Number(st.width) > 0,
            `${st.codec_name} ${st.width}x${st.height} ${(d ? n / d : 0).toFixed(2)}fps ${st.nb_frames}帧 ${Number(st.duration).toFixed(2)}s`
          )
          if (EXPECT_SIZE) {
            const [ew, eh] = EXPECT_SIZE.split('x').map(Number)
            record(
              `${SCENARIO} 视频分辨率 == 期望 ${EXPECT_SIZE}`,
              Number(st.width) === ew && Number(st.height) === eh,
              `实测 ${st.width}x${st.height}`
            )
          }
        }
      }
    } else {
      const local = join(
        COMFY_ROOT,
        target.type === 'output' ? 'output' : 'temp',
        target.subfolder,
        target.filename
      )
      const ext = (target.filename.split('.').pop() || 'png').toLowerCase()
      const mime = `image/${ext === 'jpg' ? 'jpeg' : ext}`
      let dataUrl
      if (existsSync(local)) {
        dataUrl = `data:${mime};base64,${readFileSync(local).toString('base64')}`
      } else {
        const v = await fetch(
          `${COMFY}/view?filename=${encodeURIComponent(target.filename)}&subfolder=${encodeURIComponent(target.subfolder)}&type=${target.type}`
        )
        dataUrl = `data:${mime};base64,${Buffer.from(await v.arrayBuffer()).toString('base64')}`
      }
      const probe = await probeImage(dataUrl)
      if (EXPECT_SIZE) {
        const [ew, eh] = EXPECT_SIZE.split('x').map(Number)
        record(
          `${SCENARIO} 产物尺寸 == 期望 ${EXPECT_SIZE}`,
          probe.w === ew && probe.h === eh,
          `实测 ${probe.w}x${probe.h}`
        )
      }
      record(
        `${SCENARIO} L3 图片可解码且非纯色`,
        probe.w >= 256 &&
          probe.h >= 256 &&
          probe.unique > 1000 &&
          probe.luma > 5 &&
          probe.luma < 250,
        `${probe.w}x${probe.h} 唯一色=${probe.unique} 平均亮度=${probe.luma}`
      )
    }
  }

  // 会话侧记账
  const sd = (await (await fetch(`${APP}/api/workbench/session/${threadId}`)).json()).data
  const exec = (sd.executions || []).find((e) => e.promptId === promptId)
  record(
    `${SCENARIO} 会话链路记账（状态/产物）`,
    !!exec && exec.status === 'success' && (exec.outputs || []).length > 0,
    `status=${exec?.status} outputs=${JSON.stringify(exec?.outputs ?? []).slice(0, 100)}`
  )
}

// 模板库侧：S3/S4 应产出新模板
// S7 专项：修复后的模板必须已把编码器纠正过来（否则修了等于没修）
if (SCENARIO === 's7') {
  const tpls2 = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
  const t2 = tpls2.find((x) => x.name === 'MiniMax H3 文生视频')
  const clip = Object.values(t2?.prompt || {}).find((v) => v.class_type === 'CLIPLoader')?.inputs
    ?.clip_name
  record(
    'S7 修复后编码器已纠正并入库',
    clip === 'qwen3vl_32b_minimax_h3_int8_convrot_uncensored-by-linjian257.safetensors',
    `clip_name=${clip}`
  )
}

if (SCENARIO === 's3' || SCENARIO === 's4') {
  const tpls = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
  const fresh = tpls.filter(
    (t) => !['app:71ee1cf3', 'app:5be61939', 'app:2515a251'].some((p) => t.id.startsWith(p))
  )
  record(
    `${SCENARIO} 新模板已入模板库`,
    tpls.length > 11,
    `模板总数=${tpls.length}；可能的新增=${
      fresh
        .map((t) => `${t.name}(${t.id})`)
        .join(', ')
        .slice(0, 200) || '无'
    }`
  )
  if (builtTemplateId) info(`plan 目标模板：${builtTemplateId}`)
}

// ───────── S5 版本化断言 ─────────
if (SCENARIO === 's5' && versionBefore) {
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(join(process.env.APPDATA, 'artify-desktop', 'gallery.db'))
  const row = db
    .prepare(
      'select coalesce(max(version), 0) as v, count(*) as c from app_versions where app_id = ?'
    )
    .get(versionAppId)
  const after = { maxSnapshot: Number(row.v), snapshots: Number(row.c) }
  // 旧态被存进快照 → 最大快照号 +1，且生效版本随之 +1
  db.close()
  record(
    `S5 版本化迭代：app_versions 新增快照且最大快照号 +1`,
    after.maxSnapshot === versionBefore.maxSnapshot + 1 &&
      after.snapshots === versionBefore.snapshots + 1,
    `快照数 ${versionBefore.snapshots}→${after.snapshots}，最大号 ${versionBefore.maxSnapshot}→${after.maxSnapshot}（生效版本 ${versionBefore.maxSnapshot + 1}→${after.maxSnapshot + 1}）`
  )
  const tplNow = ((await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []).find(
    (t) => t.name === VERSION_APP
  )
  const latentOf = (t) =>
    Object.values(t?.prompt || {}).find((n) => /Empty.*Latent/i.test(n.class_type || ''))?.inputs
  const l = latentOf(tplNow)
  record(
    `S5 新版本已生效（尺寸默认值 768）`,
    !!l && Number(l.width) === 768 && Number(l.height) === 768,
    `模板 ${VERSION_APP} 的 latent 默认 = ${l ? `${l.width}x${l.height}` : '未找到'}`
  )
}

const outTree = readdirSync('D:/Comfy-Desktop/ComfyUI-Shared/output').slice(0, 3)
info(`output/ 目录条目示例：${outTree.join(', ')}`)

writeFileSync(
  join(EVID_DIR, `${SCENARIO}-${stamp}.json`),
  JSON.stringify(
    {
      scenario: SCENARIO,
      threadId,
      runId,
      instruction,
      toolCalls,
      customs: customs.map((c) => ({
        name: c.name,
        value: JSON.stringify(c.value ?? null).slice(0, 400)
      })),
      runError,
      approved,
      eventCount: events.length
    },
    null,
    2
  )
)

console.log('\n════ 汇总 ════')
const failed = results.filter((r) => !r.pass)
console.log(
  `${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`
)
console.log(`证据：${EVID_DIR}/${SCENARIO}-${stamp}.json`)
process.exit(failed.length ? 1 : 0)
