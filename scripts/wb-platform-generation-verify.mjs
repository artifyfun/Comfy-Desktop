/**
 * 平台生成能力**真实验证**：S0 前置自检 + S1 直连执行生图（不经 agent）。
 *
 * 三层断言（详见 docs/workbench-generation-verify-plan.md）：
 *   L1 契约：拿到 promptId；ComfyUI history 里该 prompt 的入参 == 我们传的入参（证明真透传）
 *            —— 媒体槽**必须传 data:/http(s)**：executor 只对这两类做上传回填，
 *               本地绝对路径会被**静默忽略**（见 src/main/artifylab/mcp/executor.ts 步骤 2/3）
 *   L2 执行：history.status == success；有产出的节点都有输出；记录耗时
 *   L3 产物：优先断言存在 `type=output` 的**正式保存产物**（只有 temp 预览帧 = 不算通过），
 *            并在浏览器里解码 + 画布取样（尺寸 / 唯一色数 / 平均亮度），防纯色/黑图
 *
 * 用法：
 *   node scripts/wb-platform-generation-verify.mjs                        # 默认 Anima
 *   node scripts/wb-platform-generation-verify.mjs --template <名或id> --timeout-min 30
 *
 * 前置：应用运行版已启动（:3008）+ ComfyUI 就绪（:8188）。S1 不走 agent，与 LLM 余额无关。
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
const TEMPLATE = opt('--template', 'Anima')
const TIMEOUT_MIN = Number(opt('--timeout-min', '30'))
/** 额外入参（JSON）：用于按需覆盖模板未暴露但模板 prompt 里存在的 widget，或显式指定尺寸等 */
const EXTRA_PARAMS = (() => {
  const raw = opt('--params', '')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (e) {
    throw new Error(`--params 不是合法 JSON：${e.message}`)
  }
})()
/** 视频产物期望分辨率（如 1344x768）；给了就断言，且要求 ffprobe 可读 */
const EXPECT_VIDEO_SIZE = opt('--expect-video-size', '')
// 跨机适配：Windows 开发机走 APPDATA/D 盘；macOS 走 ~/Library/Application Support 与
// ~/ComfyUI-Shared（应用 settings.json 的共享 input/output）。--comfy-root/--evid-dir 可覆盖。
const IS_WIN = process.platform === 'win32'
const APPDATA = IS_WIN
  ? process.env.APPDATA || ''
  : `${process.env.HOME}/Library/Application Support`
const COMFY_ROOT = opt(
  '--comfy-root',
  IS_WIN ? 'D:/Comfy-Desktop/ComfyUI-Shared' : `${process.env.HOME}/ComfyUI-Shared`
)
const OUTPUT_DIR = `${COMFY_ROOT}/output`
const INPUT_DIR = `${COMFY_ROOT}/input`
const EVID_DIR = opt(
  '--evid-dir',
  IS_WIN ? 'D:/artifyfun/tmp/wb-gen-verify' : '/tmp/wb-gen-verify'
)
mkdirSync(EVID_DIR, { recursive: true })

const results = []
const record = (name, pass, evidence) => {
  results.push({ name, pass, evidence: evidence ?? '' })
  console.log(`${pass ? '✅' : '❌'} ${name}${evidence ? ' — ' + evidence : ''}`)
}
const info = (m) => console.log(`   · ${m}`)

async function req(url, opts = {}) {
  const r = await fetch(url, {
    ...opts,
    headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) }
  })
  const text = await r.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = { _raw: text.slice(0, 160) }
  }
  return { http: r.status, body }
}
const unwrap = (r) => (r.body && (r.body.data !== undefined ? r.body.data : r.body)) ?? null
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 无头浏览器解码图片并取样：尺寸 / 唯一色数 / 平均亮度（防纯色、防黑图） */
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
      const ctx = c.getContext('2d')
      ctx.drawImage(img, 0, 0)
      const d = ctx.getImageData(0, 0, c.width, c.height).data
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

// ================= S0 前置自检 =================
console.log('\n════ S0 前置自检 ════')
const cfgRes = await req(`${APP}/api/config`)
record('S0.1 应用 server 可达', cfgRes.http === 200, `${APP}/api/config → ${cfgRes.http}`)

const comfyRes = await req(`${COMFY}/system_stats`)
const comfySys = comfyRes.body?.system || {}
const gpu = (comfyRes.body?.devices || [])[0] || {}
record(
  'S0.2 ComfyUI 就绪',
  comfyRes.http === 200 && !!comfySys.comfyui_version,
  `v${comfySys.comfyui_version} | ${gpu.name || '?'} | VRAM ${(gpu.vram_total / 2 ** 30).toFixed(1)}GB`
)

const templates = unwrap(await req(`${APP}/api/workbench/templates`)) || []
const tmpl = templates.find((t) => t.id === TEMPLATE || t.name === TEMPLATE)
record(
  'S0.3 模板库可用且命中目标模板',
  Array.isArray(templates) && templates.length > 0 && !!tmpl,
  `${templates.length} 个模板；命中 ${tmpl ? `${tmpl.name} (${tmpl.id})` : '无'}`
)
record(
  'S0.4 模板 id 口径 = app:<uuid>',
  templates.every((t) => /^app:[0-9a-f-]{36}$/.test(t.id)),
  templates
    .slice(0, 2)
    .map((t) => t.id)
    .join(' , ')
)

let llm = { ok: false, note: '未测' }
try {
  const acc = JSON.parse(
    readFileSync(join(APPDATA, 'artify-desktop', 'artify-apps.json'), 'utf8')
  ).config
  const lr = await req(`${acc.base_url.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${acc.api_key}` },
    body: JSON.stringify({
      model: acc.model,
      messages: [{ role: 'user', content: 'ping' }],
      max_tokens: 4
    })
  })
  llm = { ok: lr.http === 200, note: `HTTP ${lr.http} ${JSON.stringify(lr.body).slice(0, 110)}` }
} catch (e) {
  llm = { ok: false, note: String(e).slice(0, 110) }
}
console.log(`${llm.ok ? '✅' : '⚠️ '} S0.5 LLM 供应商（仅 agent 路径需要） — ${llm.note}`)

// ================= S1 直连执行生图 =================
console.log('\n════ S1 直连执行生图（既有 app，三层断言）════')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const evidence = { stamp, templateId: tmpl?.id, llm }
if (!tmpl) {
  record('S1 目标模板存在', false, `未找到 ${TEMPLATE}`)
} else {
  const param = (tmpl.paramsNodes || [])[0]
  const nodeId = param?.id
  // widget 名取 selectedWidget.name（参数名≠widget 名很常见：如参数叫 prompt、widget 叫 text）。
  // 用参数名去读 history 会读空 → L1 恒假（2026-09-17 H3 场景实测）。
  const paramName = param?.name // execute 的 params 键 = 参数名（executor 按 args[param.name] 取）
  const widget = param?.selectedWidget?.name || paramName // history 里读的是 widget 名（两者可以不同）
  const defVal = String(tmpl.prompt?.[nodeId]?.inputs?.[widget] ?? '').replace(/^"|"$/g, '')
  const isMediaSlot = /image|video|audio|-uploader$/i.test(param?.renderComponent ?? '')
  info(`参数：node ${nodeId} (${param?.type}) widget=${widget} render=${param?.renderComponent}`)
  info(`模板默认值：${defVal}`)

  // L1 要有意义，就必须传一个**非空且唯一**的值：文本类参数一律用探针串。
  // 曾经的做法是「非媒体槽就沿用模板默认值」，而很多模板的 prompt 默认值是空串
  // → `history === '' === paramValue` 恒真，断言全绿但其实什么都没验（2026-09-17 发现）。
  // 若调用方用 `--params` 显式覆盖了该 widget，则以调用方给的值为准（那才是 L1 该断言的东西）。
  const PROBE = `wb-l1-probe-${Date.now().toString(36)}`
  const override = EXTRA_PARAMS[paramName]
  let paramValue = override !== undefined ? String(override) : defVal
  if (override !== undefined) {
    info(`该 widget 被 --params 覆盖 → L1 以覆盖值为准：${String(override).slice(0, 60)}`)
  } else if (isMediaSlot) {
    // 媒体槽默认值是裸文件名（已在 input/ 里）时上传回填不会发生 → L1 的「值被改写」
    // 断言不成立。按优先级找一张本机真实图片构造 data URL：高熵探针图优先（L3 的
    // 「非纯色」断言需要唯一色 >1000，模板默认图常是深色低熵图过不了）→ 模板默认值
    // 路径 → input/ 里现成的图（无模型机口径：直通 app 的产物=上传图回写）。
    const candidates = [
      join(INPUT_DIR, 'wb_rich_probe.png'),
      defVal,
      join(INPUT_DIR, defVal),
      join(INPUT_DIR, 'artify_verify.png'),
      join(INPUT_DIR, 'bridge-test.png')
    ].filter(Boolean)
    const src = candidates.find((c) => existsSync(c))
    if (src) {
      const ext = (src.split('.').pop() || 'jpg').toLowerCase()
      const buf = readFileSync(src)
      paramValue = `data:image/${ext === 'jpg' ? 'jpeg' : ext};base64,${buf.toString('base64')}`
      info(
        `构造新入参：源图 ${src}（${(buf.length / 1024).toFixed(0)}KB）→ data URL（${paramValue.length} 字符）`
      )
    } else {
      info(`媒体参数默认值不是本机文件（${defVal || '空'}）→ 该场景 L1 不再成立`)
    }
  } else {
    paramValue = PROBE
    info(`构造文本探针值：${PROBE}（L1 将断言 history 精确命中它）`)
  }

  const outBefore = new Set(readdirSync(OUTPUT_DIR))
  const inBefore = new Set(readdirSync(INPUT_DIR))

  const session = unwrap(
    await req(`${APP}/api/workbench/sessions/create`, {
      method: 'POST',
      body: JSON.stringify({ title: `[verify] S1 ${stamp}`, entry: 'workbench' })
    })
  )
  const sessionId = session?.id || session?.sessionId
  record('S1.1 会话创建', !!sessionId, `sessionId=${sessionId}`)

  const t0 = Date.now()
  const eRes = await req(`${APP}/api/workbench/execute`, {
    method: 'POST',
    body: JSON.stringify({
      sessionId,
      templateId: tmpl.id,
      params: { [paramName]: paramValue, ...EXTRA_PARAMS }
    })
  })
  const promptId = unwrap(eRes)?.promptId
  record('S1.2 提交执行拿到 promptId（L1）', !!promptId, `HTTP ${eRes.http} promptId=${promptId}`)

  if (promptId) {
    let status = 'unknown'
    const deadline = Date.now() + TIMEOUT_MIN * 60_000
    let lastLog = 0
    while (Date.now() < deadline) {
      const p = unwrap(
        await req(`${APP}/api/workbench/poll`, {
          method: 'POST',
          body: JSON.stringify({ sessionId, promptId })
        })
      )
      status = p?.status || 'unknown'
      const el = Math.round((Date.now() - t0) / 1000)
      if (el - lastLog >= 20) {
        info(`[${el}s] status=${status}`)
        lastLog = el
      }
      if (['success', 'error', 'failed'].includes(status)) break
      await sleep(5000)
    }
    const elapsedSec = Math.round((Date.now() - t0) / 1000)

    const hist = (await req(`${COMFY}/history/${promptId}`)).body?.[promptId]
    const histVal = String(hist?.prompt?.[2]?.[nodeId]?.inputs?.[widget] ?? '').replace(
      /^"|"$/g,
      ''
    )

    const inAfter = readdirSync(INPUT_DIR).filter((f) => !inBefore.has(f))
    record(
      'S1.3 L1 入参真透传（history 精确命中我们传的值）',
      isMediaSlot ? !!histVal && histVal !== defVal : !!paramValue && histVal === paramValue,
      `传=${paramValue.slice(0, 44)} | history=${histVal.slice(0, 70)} | input 新增=${
        inAfter.join(', ') || '无'
      }`
    )

    const outputs = hist?.outputs || {}
    const nodeIds = Object.keys(outputs)
    const emptyNode = nodeIds.find((k) => !outputs[k] || Object.keys(outputs[k]).length === 0)
    record(
      'S1.4 L2 执行成功且产出节点都有输出',
      status === 'success' && nodeIds.length > 0 && !emptyNode,
      `status=${hist?.status?.status_str || status} 产出节点=${nodeIds.length} 耗时=${elapsedSec}s`
    )

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
    const media = files.filter((f) => /\.(png|jpe?g|webp|mp4|webm)$/i.test(f.filename))
    record(
      'S1.5 L3 存在正式保存产物（type=output）',
      saved.length > 0,
      saved.length
        ? saved.map((f) => f.filename).join(', ')
        : `只有临时预览帧：${files.map((f) => `${f.filename}(${f.type})`).join(', ') || '无任何输出'}`
    )

    const added = readdirSync(OUTPUT_DIR).filter((f) => !outBefore.has(f))
    info(`输出目录新增 ${added.length} 项：${added.slice(0, 5).join(', ') || '无'}`)

    const target = saved[0] || media[0]
    const isVideoTarget = !!target && /\.(mp4|webm|mov)$/i.test(target.filename)
    if (target && isVideoTarget) {
      // ── 视频产物：用 ffprobe 读规格 + 抽帧量化「画面真的在动」（不是静态图拼的）──
      const local = join(
        COMFY_ROOT,
        target.type === 'output' ? 'output' : 'temp',
        target.subfolder,
        target.filename
      )
      record('S1.6 L3 视频产物落盘', existsSync(local), `${local}`)
      if (existsSync(local)) {
        info(`大小 ${(statSync(local).size / 1024 / 1024).toFixed(2)}MB`)
        const pr = spawnSync(
          'ffprobe',
          [
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=codec_name,width,height,r_frame_rate,nb_frames,duration',
            '-show_entries',
            'format=duration,size,format_name',
            '-of',
            'json',
            local
          ],
          { encoding: 'utf8' }
        )
        if (pr.status !== 0) {
          record('S1.7 L3 ffprobe 可解析视频', false, String(pr.stderr || '').slice(0, 160))
        } else {
          const j = JSON.parse(pr.stdout)
          const st = (j.streams || [])[0] || {}
          const [num, den] = String(st.r_frame_rate || '0/1')
            .split('/')
            .map(Number)
          const fps = den ? num / den : 0
          const dur = Number(j.format?.duration ?? st.duration ?? 0)
          const frames = Number(st.nb_frames) || Math.round(dur * fps)
          record(
            'S1.7 L3 ffprobe 可解析视频（编码/分辨率/时长/帧数）',
            !!st.codec_name && Number(st.width) > 0 && dur > 0.3,
            `${st.codec_name} ${st.width}x${st.height} ${fps.toFixed(2)}fps ${frames}帧 ${dur.toFixed(2)}s`
          )
          if (EXPECT_VIDEO_SIZE) {
            const [ew, eh] = EXPECT_VIDEO_SIZE.split('x').map(Number)
            record(
              `S1.8 L3 视频分辨率 == 期望 ${EXPECT_VIDEO_SIZE}`,
              Number(st.width) === ew && Number(st.height) === eh,
              `实测 ${st.width}x${st.height}`
            )
          }
          // 抽帧 → 灰度 → 相邻帧平均像素差（纯色/静止视频差值≈0）
          const raw = join(EVID_DIR, `motion-${stamp}.raw`)
          const ff = spawnSync(
            'ffmpeg',
            [
              '-v',
              'error',
              '-y',
              '-i',
              local,
              '-vf',
              'fps=6,scale=160:-2',
              '-pix_fmt',
              'gray',
              '-f',
              'rawvideo',
              raw
            ],
            { encoding: 'utf8' }
          )
          if (ff.status !== 0 || !existsSync(raw)) {
            record(
              'S1.9 L3 抽帧量化画面运动',
              false,
              String(ff.stderr || 'ffmpeg 失败').slice(0, 160)
            )
          } else {
            const bytes = readFileSync(raw)
            const W = 160
            const frameH = Math.max(
              2,
              Math.round(((Number(st.height) / Number(st.width)) * W) / 2) * 2
            )
            const fs = W * frameH
            const n = Math.floor(bytes.length / fs)
            let sum = 0
            let pairs = 0
            let maxDiff = 0
            for (let i = 1; i < n; i++) {
              let d = 0
              for (let k = 0; k < fs; k += 7) {
                d += Math.abs(bytes[i * fs + k] - bytes[(i - 1) * fs + k])
              }
              const mean = d / Math.ceil(fs / 7)
              sum += mean
              maxDiff = Math.max(maxDiff, mean)
              pairs++
            }
            const avg = pairs ? sum / pairs : 0
            record(
              'S1.9 L3 抽帧量化画面运动（非静止/非纯色）',
              pairs >= 2 && avg > 1,
              `${n} 帧采样，相邻帧平均像素差=${avg.toFixed(2)}（最大 ${maxDiff.toFixed(2)}，阈值 >1）`
            )
          }
        }
      }
    } else if (target) {
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
        info(`分析本地产物：${local}（${(statSync(local).size / 1024).toFixed(0)}KB）`)
      } else {
        const v = await fetch(
          `${COMFY}/view?filename=${encodeURIComponent(target.filename)}&subfolder=${encodeURIComponent(target.subfolder)}&type=${target.type}`
        )
        const b = Buffer.from(await v.arrayBuffer())
        dataUrl = `data:${mime};base64,${b.toString('base64')}`
        info(
          `本地产物不存在（${target.type} 已清理），改经 /view 取字节：${(b.length / 1024).toFixed(0)}KB`
        )
      }
      const probe = await probeImage(dataUrl)
      record(
        'S1.6 L3 产物可解码且非纯色',
        probe.w >= 256 &&
          probe.h >= 256 &&
          probe.unique > 1000 &&
          probe.luma > 5 &&
          probe.luma < 250,
        `${probe.w}x${probe.h} 唯一色=${probe.unique} 平均亮度=${probe.luma}`
      )
    }

    // 应用侧登记（正确端点：/api/workbench/session/:id，单数）
    const sd = unwrap(await req(`${APP}/api/workbench/session/${sessionId}`)) || {}
    const exec = (sd.executions || []).find((e) => e.promptId === promptId)
    const artMsg = (sd.messages || []).some((m) => m.kind === 'artifact')
    record(
      'S1.7 执行与产物被会话链路登记',
      !!exec && artMsg,
      `params=${JSON.stringify(exec?.params || {}).slice(0, 80)} | 产物消息=${artMsg} | outputs=${JSON.stringify(exec?.outputs || []).slice(0, 80)}`
    )

    Object.assign(evidence, {
      sessionId,
      paramName: widget,
      paramKind: isMediaSlot ? 'media' : 'plain',
      promptId,
      status,
      elapsedSec,
      files,
      addedInOutput: added
    })
  }
}

writeFileSync(join(EVID_DIR, `s1-${stamp}.json`), JSON.stringify(evidence, null, 2))
console.log('\n════ 汇总 ════')
const failed = results.filter((r) => !r.pass)
console.log(
  `${failed.length ? '❌' : '✅'} ${results.length - failed.length}/${results.length} 通过`
)
if (!llm.ok) console.log(`⚠️  阻塞项：LLM 供应商不可用（${llm.note}）→ S2/S3/S4 无法执行`)
console.log(`证据：${EVID_DIR}/s1-${stamp}.json`)
process.exit(failed.length ? 1 : 0)
