/**
 * S8 验收：工作台**真实上传路径**（multipart → ComfyUI /upload/image → 裸文件名透传执行）
 *
 * 背景：S1 的媒体槽用的是 data: URL 直传；UI 真实路径是「先 POST /api/workbench/upload
 * 拿文件名，执行时媒体槽传裸文件名」——这条腿此前从未验证过。
 *
 * 场景（真应用 + 真 ComfyUI，不走 stub）：
 *   S8.1 multipart 上传本地图片 → 201，meta 含 name/type=input
 *   S8.2 文件真实落到 ComfyUI input 目录
 *   S8.3 负路径：不带 file 字段 → 400
 *   S8.4 带 sessionId 上传 → 会话登记附件（跨轮决策注入用）
 *   S8.5 用上传返回的裸文件名执行「QWEN3图片反推」（健康 app，媒体槽）→ L1:
 *         ComfyUI history 的图片 widget == 上传文件名（证明上传件真被工作流引用）
 *   S8.6 L2: 执行成功
 *   S8.7 L3: `CR Save Text To File` 的文本产物落盘且非空（反推产物是文本）
 *
 * 用法：node scripts/wb-platform-upload-verify.mjs [--app http://127.0.0.1:3008] [--comfy http://127.0.0.1:8188]
 * 前置：应用在跑（env -u ELECTRON_RUN_AS_NODE pnpm dev）+ ComfyUI 就绪
 */
import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const APP = opt('--app', 'http://127.0.0.1:3008')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188')
/** ComfyUI input 目录（应用把上传件转发到这里；路径来自本机安装布局） */
const COMFY_INPUT = 'D:/Comfy-Desktop/ComfyUI-Shared/input'
const COMFY_OUTPUT = 'D:/Comfy-Desktop/ComfyUI-Shared/output'
/**
 * 靶 app 默认 Anima（媒体槽 + 执行必成功 + PreviewImage 出真实 img2img 预览帧）。
 * 反推类 app（QWEN3图片反推等）的 CR Save Text To File 写相对路径 tags/florence/，
 * 该目录在本机不存在（节点不建父目录）→ 执行必在最后一步 FileNotFoundError（2026-09-17 实测，
 * 属模板环境依赖，非上传链路问题），故不作默认靶。
 */
const APP_NAME = opt('--app-name', 'Anima')

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

// ComfyUI 根据扩展名白名单校验上传件 → 必须是真实 JPEG。
// 用 ffmpeg testsrc2 生成**有真实纹理**的彩色测试图——纯色输入会让 img2img
// 产出退化帧（唯一色≈2），L3 的「非纯色」判据会把它当坏图（2026-09-17 实测）。
function makeTestJpeg() {
  const dst = join(tmpdir(), `wb-s8-upload-${Date.now()}.jpg`)
  const ff = spawnSync('ffmpeg', [
    '-v',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1024x680:rate=1',
    '-frames:v',
    '1',
    dst
  ])
  if (ff.status !== 0 || !existsSync(dst)) throw new Error('ffmpeg 生成测试图失败: ' + ff.stderr)
  return dst
}

async function multipartUpload(path, filePath, sessionId) {
  const buf = readFileSync(filePath)
  const boundary = `----wbs8${Date.now().toString(36)}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filePath.split(/[\\/]/).pop()}"\r\nContent-Type: image/jpeg\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  const body = Buffer.concat([head, buf, tail])
  const res = await fetch(
    `${APP}${path}${sessionId ? `?sessionId=${encodeURIComponent(sessionId)}` : ''}`,
    {
      method: 'POST',
      headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body
    }
  )
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 留原始文本 */
  }
  return { status: res.status, json, text }
}

async function main() {
  console.log(`S8 上传路径验证 → APP=${APP} COMFY=${COMFY} 靶 app=${APP_NAME}`)
  if (!existsSync(COMFY_INPUT)) throw new Error(`ComfyUI input 目录不存在: ${COMFY_INPUT}`)

  // ── 靶模板的媒体参数（param name + 节点 id + widget 名）──
  const tpls = (await (await fetch(`${APP}/api/workbench/templates`)).json()).data || []
  const tmpl = tpls.find((t) => t.name === APP_NAME)
  if (!tmpl) throw new Error(`模板不存在: ${APP_NAME}`)
  const mediaParam = (tmpl.paramsNodes || []).find((p) =>
    String(p.renderComponent || '').startsWith('image')
  )
  if (!mediaParam) throw new Error('模板无媒体参数')
  const nodeId = String(mediaParam.id)
  const widget = mediaParam.selectedWidget?.name || mediaParam.name
  console.log(`媒体参数: param=${mediaParam.name} → node ${nodeId}.${widget}`)

  // ── S8.1 multipart 上传 ──
  const jpg = makeTestJpeg()
  const up = await multipartUpload('/api/workbench/upload', jpg)
  record(
    'S8.1 multipart 上传 → 201 + meta',
    up.status === 201 && !!up.json?.data?.name && up.json.data.type === 'input',
    `HTTP ${up.status} name=${up.json?.data?.name} type=${up.json?.data?.type}`
  )
  if (up.status !== 201) throw new Error('上传失败，后续断言无意义: ' + up.text.slice(0, 200))
  const meta = up.json.data
  const uploadedName = meta.name

  // ── S8.2 文件真实落 ComfyUI input ──
  // meta.name 可能带 subfolder 前缀（"sub/dir/file.jpg"）；input 根下按名字找
  const baseName = uploadedName.split('/').pop()
  const local = join(COMFY_INPUT, uploadedName.replace(/\//g, '\\'))
  const found = existsSync(local) || !!findInInput(COMFY_INPUT, baseName)
  record('S8.2 上传件落 ComfyUI input 目录', found, `期望 ${local}`)

  // ── S8.3 负路径：不带 file ──
  const bad = await fetch(`${APP}/api/workbench/upload`, { method: 'POST' })
  record('S8.3 无 file 字段 → 400', bad.status === 400, `HTTP ${bad.status}`)

  // ── S8.4 带 sessionId 上传 → 会话登记附件 ──
  const sid = (
    await (
      await fetch(`${APP}/api/workbench/sessions/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: '[verify] S8 上传路径', entry: 'workbench' })
      })
    ).json()
  ).data.id
  const up2 = await multipartUpload('/api/workbench/upload', jpg, sid)
  record('S8.4a 带 sessionId 上传成功', up2.status === 201, `HTTP ${up2.status}`)
  const sess = (await (await fetch(`${APP}/api/workbench/session/${sid}`)).json()).data || {}
  const atts = sess.attachments || []
  record(
    'S8.4b 会话登记附件',
    atts.length >= 1 &&
      atts.some((a) => (a.name || a.filename || '').includes(baseName.slice(0, 12))),
    `attachments=${atts.length}`
  )

  // ── S8.5–S8.7 用裸文件名执行 ──
  const exRes = await fetch(`${APP}/api/workbench/execute`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sessionId: sid,
      templateId: tmpl.id,
      params: { [mediaParam.name]: uploadedName }
    })
  })
  const ex = await exRes.json().catch(() => ({}))
  const promptId = ex?.data?.promptId
  record(
    'S8.5a 执行受理（拿到 promptId）',
    exRes.status === 200 && !!promptId,
    `HTTP ${exRes.status} promptId=${promptId}`
  )
  if (!promptId) throw new Error('执行未受理: ' + JSON.stringify(ex).slice(0, 300))

  // 轮询到终态
  let status = 'queued'
  for (let i = 0; i < 60; i++) {
    await sleep(3000)
    const pr = await (
      await fetch(`${APP}/api/workbench/poll`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sid, promptId })
      })
    ).json()
    status = pr?.data?.status
    if (status === 'success' || status === 'error' || status === 'failed') break
  }

  // L1：history 里图片 widget == 上传文件名
  const h = (await (await fetch(`${COMFY}/history/${promptId}`)).json())[promptId]
  const histInputs = h?.prompt?.[2]?.[nodeId]?.inputs || {}
  record(
    'S8.5b L1 history 引用上传件（裸文件名透传）',
    histInputs[widget] === uploadedName || String(histInputs[widget] || '').endsWith(baseName),
    `history[${nodeId}].${widget}=${String(histInputs[widget]).slice(0, 60)}`
  )

  // L2
  const statusStr = h?.status?.status_str
  record('S8.6 L2 ComfyUI 执行成功', statusStr === 'success', `status=${statusStr}`)

  // L3：产物可获取且为真实新图像/文本。
  // Anima 的正式 Save 分支因模板漂移被丢弃（已知问题，S1 已覆盖），这里只要
  // history 有产出文件（含 temp 预览帧）且解码后 ≠ 上传源图，就证明「上传件真被
  // img2img 消费并生成了新图」——这是上传链路的端到端证据。
  const outs = h?.outputs || {}
  const files = []
  for (const v of Object.values(outs)) {
    for (const arr of Object.values(v)) {
      for (const f of Array.isArray(arr) ? arr : []) {
        if (f?.filename) files.push(f)
      }
    }
  }
  const images = files.filter((f) => /\.(png|jpe?g|webp)$/i.test(f.filename))
  const texts = files.filter((f) => /\.(txt|csv)$/i.test(f.filename))
  let l3ok = false
  let l3ev = `history 产物=${files.length} 个`
  if (images.length) {
    const f = images[0]
    const v = await fetch(
      `${COMFY}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder || '')}&type=${f.type || 'temp'}`
    )
    const buf = Buffer.from(await v.arrayBuffer())
    const probe = await probeImageBuf(buf)
    const srcSha = readFileSync(jpg).toString('base64').slice(0, 256)
    const diff = buf.toString('base64').slice(0, 256) !== srcSha
    l3ok = probe.w >= 256 && probe.unique > 1000 && probe.luma > 5 && probe.luma < 250 && diff
    l3ev = `${f.type}/${f.filename} ${probe.w}x${probe.h} 唯一色=${probe.unique} 亮度=${probe.luma.toFixed(0)} ≠上传源=${diff}`
  } else if (texts.length) {
    const f = texts[0]
    const local = join(COMFY_OUTPUT, f.subfolder || '', f.filename)
    if (existsSync(local)) {
      const content = readFileSync(local, 'utf-8')
      l3ok = content.trim().length > 10
      l3ev = `${local}（${content.trim().length} 字符）`
    } else {
      l3ev = `history 记了 ${f.filename} 但磁盘上不存在: ${local}`
    }
  }
  record('S8.7 L3 产物可获取且为真实新图像/文本', l3ok, l3ev)
  if (files.length) {
    const types = files.map((f) => f.type || '?').join(',')
    console.log(
      `   ℹ️ 产物 type 分布: ${types}${types.includes('temp') && !types.includes('output') ? '（仅 temp，正式保存属模板侧已知问题）' : ''}`
    )
  }

  rmSync(jpg, { force: true })
  const passed = results.filter((r) => r.pass).length
  console.log(`\n════ S8 汇总：${passed}/${results.length} ════`)
  process.exit(passed === results.length ? 0 : 1)
}

function findInInput(root, name) {
  const stack = [root]
  const seen = new Set()
  while (stack.length) {
    const dir = stack.pop()
    if (seen.has(dir)) continue
    seen.add(dir)
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (e.isFile() && e.name === name) return join(dir, e.name)
      if (e.isDirectory() && seen.size < 200) stack.push(join(dir, e.name))
    }
  }
  return null
}

/** 用无头浏览器解码图片字节，判非纯色（与 S1/S9 同款判据） */
async function probeImageBuf(buf) {
  const dataUrl = `data:image/png;base64,${buf.toString('base64')}`
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
    return { w: c.width, h: c.height, unique: colors.size, luma: luma / (d.length / step) }
  }, dataUrl)
  await browser.close()
  return probe
}

main().catch((e) => {
  console.error('❌ S8 脚本异常:', e.message)
  process.exit(1)
})
