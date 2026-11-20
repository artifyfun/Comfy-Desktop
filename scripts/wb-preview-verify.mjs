#!/usr/bin/env node
/**
 * ComfyUI 实时预览协议验收（#5 生成过程直通预览）——手动运行，不进 CI。
 *
 * 用途：验证「工作台能看到生成过程」这条链路在**真机**上成立。单元测试能锁住
 * 帧解码与握手逻辑，但锁不住"服务端到底推不推帧"——那取决于两个进程外前提：
 *   1) ComfyUI 必须以 --preview-method latent2rgb（或 auto/taesd）启动。
 *      其默认值是 LatentPreviewMethod.NoPreviews，采样器根本不生成预览图。
 *   2) 客户端必须在连上后**第一条**消息发 feature_flags 能力声明。
 * 本脚本按服务端真实协议逐字节核对帧结构，任一前提不成立都会明确报错。
 *
 * 用法：
 *   node scripts/wb-preview-verify.mjs
 *   node scripts/wb-preview-verify.mjs --origin http://127.0.0.1:8188 --steps 8
 *   node scripts/wb-preview-verify.mjs --payload path/to/api_prompt.json
 *
 * 退出码：0 = 通过；1 = 断言失败；2 = 无法连接（请先启动 ComfyUI）。
 */
import fs from 'node:fs'
import path from 'node:path'

const PREVIEW_IMAGE = 1
const UNENCODED_PREVIEW_IMAGE = 2
const PREVIEW_IMAGE_WITH_METADATA = 4

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const ORIGIN = arg('origin', 'http://127.0.0.1:8188').replace(/\/+$/, '')
const PAYLOAD = arg(
  'payload',
  path.resolve(process.cwd(), '..', 'comfyui-deploy/02_验证payload/anima_test_payload.json')
)
const STEPS = Number(arg('steps', '8'))
const OUT_DIR = arg('out', path.resolve(process.cwd(), '..', 'tmp/preview-e2e'))

const fail = (msg) => {
  console.error(`\n✗ ${msg}`)
  process.exit(1)
}

const u32 = (b, at) => ((b[at] << 24) | (b[at + 1] << 16) | (b[at + 2] << 8) | b[at + 3]) >>> 0

const sniff = (b, at) => {
  if (at + 3 > b.length) return null
  if (b[at] === 0x89 && b[at + 1] === 0x50 && b[at + 2] === 0x4e) return 'png'
  if (b[at] === 0xff && b[at + 1] === 0xd8 && b[at + 2] === 0xff) return 'jpeg'
  return null
}

// —— 前置检查 ——
try {
  const res = await fetch(`${ORIGIN}/system_stats`, { signal: AbortSignal.timeout(5000) })
  const stats = await res.json()
  console.log(`[verify] ComfyUI ${stats.system.comfyui_version} @ ${ORIGIN}`)
} catch {
  console.error(`✗ 连不上 ${ORIGIN} —— 请先启动 ComfyUI（应用内启动，或见本文件注释）`)
  process.exit(2)
}

if (!fs.existsSync(PAYLOAD)) fail(`payload 不存在：${PAYLOAD}`)
const rawPayload = JSON.parse(fs.readFileSync(PAYLOAD, 'utf8'))
const workflow = rawPayload.prompt ?? rawPayload
const sampler = Object.values(workflow).find((n) => String(n.class_type ?? '').includes('KSampler'))
if (sampler?.inputs && STEPS > 0) sampler.inputs.steps = STEPS

const clientId = `wb-preview-verify-${Date.now()}`
const textCounts = new Map()
const binaryFrames = []
let sawServerFeatureFlags = false

const ws = new WebSocket(
  `${ORIGIN.replace(/^http/, 'ws')}/ws?clientId=${encodeURIComponent(clientId)}`
)
ws.binaryType = 'arraybuffer'

ws.onopen = async () => {
  // 前提 2：能力声明必须是本连接第一条消息，否则服务端一帧都不推
  ws.send(JSON.stringify({ type: 'feature_flags', data: { supports_preview_metadata: true } }))
  console.log('[verify] 已发 feature_flags 握手（supports_preview_metadata）')
  const res = await fetch(`${ORIGIN}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: workflow, client_id: clientId })
  })
  const body = await res.json()
  if (!res.ok || !body.prompt_id)
    fail(`提交失败：${res.status} ${JSON.stringify(body).slice(0, 300)}`)
  console.log(`[verify] prompt_id = ${body.prompt_id}（${STEPS} 步采样）`)
  globalThis.__promptId = body.prompt_id
}

ws.onmessage = (ev) => {
  const d = ev.data
  if (typeof d === 'string') {
    let type = '?'
    try {
      type = JSON.parse(d).type ?? '?'
    } catch {
      type = 'unparsable'
    }
    textCounts.set(type, (textCounts.get(type) ?? 0) + 1)
    if (type === 'feature_flags') sawServerFeatureFlags = true
    return
  }
  const bytes =
    d instanceof ArrayBuffer
      ? new Uint8Array(d)
      : ArrayBuffer.isView(d)
        ? new Uint8Array(d.buffer, d.byteOffset, d.byteLength)
        : null
  if (bytes) binaryFrames.push(bytes)
}

ws.onerror = (e) => console.warn('[verify] WS 错误：', e?.message ?? '')

// —— 等队列跑空 ——
const promptId = await new Promise((resolve) => {
  const t0 = Date.now()
  const timer = setInterval(async () => {
    try {
      const q = await (await fetch(`${ORIGIN}/queue`)).json()
      const busy = (q.queue_running ?? []).length + (q.queue_pending ?? []).length
      if (busy === 0 && globalThis.__promptId) {
        clearInterval(timer)
        resolve(globalThis.__promptId)
        return
      }
    } catch {
      /* 忽略瞬时错误 */
    }
    if (Date.now() - t0 > 5 * 60 * 1000) {
      clearInterval(timer)
      fail('等待执行完成超时（5min）')
    }
  }, 1000)
})

await new Promise((r) => setTimeout(r, 800))
ws.close()

// —— 断言 ——
console.log(
  '\n[verify] 文本事件：',
  [...textCounts.entries()].map(([k, v]) => `${k}×${v}`).join(', ')
)
console.log(`[verify] 二进制帧：${binaryFrames.length} 个`)

if (!sawServerFeatureFlags) {
  console.warn('  ! 未收到服务端 feature_flags 回执（非致命，但能力协商可能未生效）')
}
if (binaryFrames.length === 0) {
  fail(
    '服务端一个预览帧都没推。最常见原因：ComfyUI 未以 --preview-method latent2rgb（或 auto/taesd）启动，\n' +
      '  其默认值是 NoPreviews。请在启动参数里加上该参数后重试。'
  )
}

let png = 0
let jpeg = 0
for (const [i, b] of binaryFrames.entries()) {
  const event = u32(b, 0)
  const metaLen = u32(b, 4)
  if (event !== PREVIEW_IMAGE_WITH_METADATA) {
    if (event === PREVIEW_IMAGE || event === UNENCODED_PREVIEW_IMAGE) {
      const kind = sniff(b, 8)
      if (!kind) fail(`帧#${i}：事件=${event}（旧格式）但 offset 8 处无图像 magic`)
      console.log(`  帧#${i}：旧格式（事件=${event}）${kind} ${b.length}B`)
      continue
    }
    fail(`帧#${i}：未知事件号 ${event}`)
  }
  const imageStart = 8 + metaLen
  if (imageStart >= b.length) fail(`帧#${i}：元数据长度 ${metaLen} 越界（帧共 ${b.length}B）`)
  let meta
  try {
    meta = JSON.parse(new TextDecoder().decode(b.subarray(8, imageStart)))
  } catch {
    fail(`帧#${i}：元数据不是合法 JSON`)
  }
  const kind = sniff(b, imageStart)
  if (!kind) fail(`帧#${i}：图像起始 offset ${imageStart} 处无 PNG/JPEG magic`)
  if (kind === 'png') png++
  else jpeg++
  if (i === 0 || i === binaryFrames.length - 1) {
    console.log(
      `  帧#${i}：事件=4 元数据${metaLen}B node=${meta.node_id ?? '?'} → ${kind} ${b.length - imageStart}B`
    )
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const out = path.join(OUT_DIR, `verify-frame-${i}.${kind === 'png' ? 'png' : 'jpg'}`)
  fs.writeFileSync(out, Buffer.from(b.subarray(imageStart)))
  if (i === Math.floor(binaryFrames.length / 2)) {
    console.log(`  （中间帧已落盘，可直接目视确认是"采样中的半成品"：${out}）`)
  }
}

console.log('\n[verify] 帧格式：', `PNG=${png}`, `JPEG=${jpeg}`)

// 终态产物（证明不是空跑）
const hist = await (await fetch(`${ORIGIN}/history/${promptId}`)).json()
const images = Object.values(hist[promptId]?.outputs ?? {}).flatMap((o) => o.images ?? [])
if (images.length === 0) fail('执行完成但没有终态产物，本次不是有效生成')
console.log(`[verify] 终态产物 ${images.length} 张`)

console.log('\n✓ 通过：真机预览链路正常（能力协商 → 元数据前缀二进制帧 → 图像可解）')
process.exit(0)
