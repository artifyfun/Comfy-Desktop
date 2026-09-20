/**
 * 平台生成能力验证 —— **总入口**（S0–S6 一次跑完，逐场景汇总）。
 *
 * 把散在各处的验证脚本按场景编排起来，跑完给一张总表 + 汇总 JSON：
 *   core  （默认）S1 直连生图（含 S0 前置自检）+ S6 异常路径 + S8 真实上传路径
 *   agent         S2 自然语言→agent 跑既有 app、S3 新建生图 app、S5 版本化迭代
 *   batch         S9 批量队列真跑（排队/暂停/恢复/rerun/取消）
 *   canvas-e2e    S11 画布 AI 真实生成（前置：画布 harness 5174）
 *   video         S1v 直连生视频 768p、S4b 新建视频 app（有界迭代）、S10 新建图生视频 app（I2V）
 *   all           以上全部
 *
 * 与「浏览器验收（acceptance/*，W/C 编号）」的区别：本矩阵打的是**真应用 + 真 ComfyUI**，
 * 不看 stub，断言落在「ComfyUI history 入参 / 落盘产物 / ffprobe 规格」上。
 *
 * 用法：
 *   node scripts/wb-platform-verify-all.mjs                 # core
 *   node scripts/wb-platform-verify-all.mjs --group agent   # agent 三条
 *   node scripts/wb-platform-verify-all.mjs --group all     # 全部（含视频，耗时长）
 *   node scripts/wb-platform-verify-all.mjs --only s1,s6    # 指定场景
 *
 * 前置：应用在跑（:3008）+ ComfyUI 就绪（:8188）。应用启动姿势见 README —
 *   `env -u ELECTRON_RUN_AS_NODE pnpm dev`（本机 shell 带 ELECTRON_RUN_AS_NODE=1，
 *   不去掉它 Electron 会被当纯 Node 跑，起不来）。
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(n)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const APP = opt('--app', 'http://127.0.0.1:3008').replace(/\/$/, '')
const COMFY = opt('--comfy', 'http://127.0.0.1:8188').replace(/\/$/, '')
const GROUP = opt('--group', 'core')
const ONLY = opt('--only', '')
const EVID_DIR = opt(
  '--evid-dir',
  process.platform === 'win32' ? 'D:/artifyfun/tmp/wb-gen-verify' : '/tmp/wb-gen-verify'
)
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
mkdirSync(EVID_DIR, { recursive: true })

const H3 = 'MiniMax H3 文生视频'
// 靶 app 跨机差异：Windows 开发机有 Krea2/Anima（真模型出图）；无模型的 mac 主力机
// 用 LoadImage→SaveImage 直通 app（此前回归轮即用此口径：产物=上传图回写，断言可过）。
const IS_WIN = process.platform === 'win32'
const IMG_APP = opt('--image-app', IS_WIN ? 'Krea2文生图1024' : '文生图·测试')
const UPLOAD_APP = opt('--upload-app', IS_WIN ? 'Anima' : '文生图·测试')
// 传给子脚本的公共路径参数（子脚本各自有同款平台默认，这里显式透传保持一致）
const PATH_ARGS = ['--evid-dir', EVID_DIR, '--comfy-root', opt('--comfy-root', IS_WIN ? 'D:/Comfy-Desktop/ComfyUI-Shared' : `${process.env.HOME}/ComfyUI-Shared`)]

/** 场景表：group 决定默认编排；args 直接透传给对应脚本 */
const SCENARIOS = {
  s1: {
    group: 'core',
    title: 'S1 直连生图（含 S0 前置自检）',
    args: [
      'scripts/wb-platform-generation-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--template',
      IMG_APP,
      '--timeout-min',
      opt('--s1-timeout-min', '10'),
      ...PATH_ARGS
    ]
  },
  s6: {
    group: 'core',
    title: 'S6 异常路径（失败要失败得清楚 + 取消链路）',
    args: [
      'scripts/wb-platform-negative-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--template',
      IMG_APP,
      ...PATH_ARGS
    ]
  },
  s8: {
    group: 'core',
    title: 'S8 真实上传路径（multipart → input → 裸文件名透传执行）',
    args: [
      'scripts/wb-platform-upload-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--app-name',
      UPLOAD_APP,
      ...PATH_ARGS
    ]
  },
  s9: {
    group: 'batch',
    title: 'S9 批量队列真跑（排队/暂停/恢复/rerun/取消；⚠️ 绝不触发关机/通知）',
    args: ['scripts/wb-platform-batch-verify.mjs', '--app', APP, '--comfy', COMFY]
  },
  s11: {
    // 特殊前置：画布 harness（node acceptance/canvas/serve.mjs 5174）
    group: 'canvas-e2e',
    title: 'S11 画布 AI 真实生成→产物回画布（同源 SSE + 双人审）',
    args: ['scripts/wb-platform-canvas-e2e-verify.mjs', '--app', APP, '--comfy', COMFY]
  },
  s10: {
    group: 'video',
    title: 'S10 工作台新建图生视频 app（I2V）并真跑：首帧真被驱动',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's10',
      '--timeout-min',
      opt('--video-timeout-min', '30'),
      '--expect-size',
      '1344x768'
    ]
  },
  s2: {
    group: 'agent',
    title: 'S2 自然语言 → agent 跑既有 app（健康 app 做门禁）',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's2',
      '--app-name',
      IMG_APP,
      '--s2-prompt',
      'a red cube on a white table',
      '--timeout-min',
      '12'
    ]
  },
  s3: {
    group: 'agent',
    title: 'S3 工作台新建生图 app 并真跑',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's3',
      '--timeout-min',
      '20'
    ]
  },
  s5: {
    group: 'agent',
    title: 'S5 版本化迭代（命名重发 + 新尺寸真出图）',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's5',
      '--timeout-min',
      '20',
      '--expect-size',
      '768x768'
    ]
  },
  s1v: {
    group: 'video',
    title: 'S1v 直连生视频 768p（ffprobe + 抽帧运动）',
    args: [
      'scripts/wb-platform-generation-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--template',
      H3,
      '--params',
      '{"prompt":"a cat walking on a sunny beach","width":1344,"height":768}',
      '--expect-video-size',
      '1344x768',
      '--timeout-min',
      opt('--video-timeout-min', '30')
    ]
  },
  s4b: {
    group: 'video',
    title: 'S4b 工作台新建视频 app（有界迭代，8 分钟量级）',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's4b',
      '--timeout-min',
      '18',
      '--expect-size',
      '1344x768'
    ]
  },
  s7: {
    group: 'video',
    title: 'S7 自愈/修复：agent 修好接线错误的视频 app 并真跑',
    args: [
      'scripts/wb-platform-agent-verify.mjs',
      '--app',
      APP,
      '--comfy',
      COMFY,
      '--scenario',
      's7',
      '--timeout-min',
      '18',
      '--expect-size',
      '1344x768'
    ]
  }
}

// s7（自愈/修复演练）不进默认编排：它假设「app 当前是坏的」，对健康 app 是 8 分钟的空转；
// app 真坏的时候用 --only s7 单独拉起来。
const ORDER = ['s1', 's6', 's8', 's2', 's3', 's5', 's9', 's1v', 's4b', 's10', 's11']
const GROUPS = {
  core: ['s1', 's6', 's8'],
  agent: ['s2', 's3', 's5'],
  batch: ['s9'],
  'canvas-e2e': ['s11'],
  video: ['s1v', 's4b', 's10'],
  all: ORDER
}
const picked = ONLY
  ? ONLY.split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  : (GROUPS[GROUP] ?? GROUPS.core)
const unknown = picked.filter((s) => !SCENARIOS[s])
if (unknown.length) {
  console.error(`✘ 未知场景：${unknown.join(', ')}（可选：${Object.keys(SCENARIOS).join(', ')}）`)
  process.exit(2)
}
const plan = ORDER.filter((s) => picked.includes(s))

// ───────── 前置：应用 + ComfyUI 可达性（早失败，避免每个场景各报一次同样的话）─────────
const reach = async (url) => {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) })
    return r.ok || r.status < 500
  } catch {
    return false
  }
}
const appOk = await reach(`${APP}/api/config`)
const comfyOk = await reach(`${COMFY}/system_stats`)
console.log(
  `前置检查：应用 ${APP} ${appOk ? '✅' : '✘'} | ComfyUI ${COMFY} ${comfyOk ? '✅' : '✘'}`
)
if (!appOk) {
  console.error(
    '\n✘ 应用不可达。启动姿势（本机 shell 带 ELECTRON_RUN_AS_NODE=1，必须去掉，否则 Electron 被当纯 Node 跑）：\n' +
      '    cd ' +
      process.cwd() +
      ' && env -u ELECTRON_RUN_AS_NODE pnpm dev\n' +
      '  注意 dev 与打包版会抢 3008，先停掉另一个。'
  )
  process.exit(2)
}
if (!comfyOk) {
  console.error('\n✘ ComfyUI 不可达（:8188）。应用通常会拉起它；也可手工起（参数要与应用一致）。')
  process.exit(2)
}

// ───────── 逐场景执行 ─────────
console.log(`\n执行计划（${GROUP}${ONLY ? ' / --only' : ''}）：${plan.join(' → ')}\n`)
const rows = []
for (const key of plan) {
  const sc = SCENARIOS[key]
  const t0 = Date.now()
  console.log(`\n${'═'.repeat(70)}\n▶ ${key}  ${sc.title}\n${'═'.repeat(70)}`)
  const r = spawnSync(process.execPath, sc.args, { encoding: 'utf8', cwd: process.cwd() })
  const out = `${r.stdout || ''}${r.stderr || ''}`
  process.stdout.write(out)
  const m = out.match(/(\d+)\/(\d+) 通过/)
  rows.push({
    key,
    title: sc.title,
    ok: r.status === 0,
    exit: r.status,
    passed: m ? Number(m[1]) : null,
    total: m ? Number(m[2]) : null,
    sec: Math.round((Date.now() - t0) / 1000)
  })
}

// ───────── 汇总 ─────────
console.log(`\n${'═'.repeat(70)}\n════ 总表 ════\n${'═'.repeat(70)}`)
for (const r of rows) {
  const counts = r.passed != null ? ` ${r.passed}/${r.total} 断言` : ''
  const secs = r.ok ? `(${r.sec}s)` : `(${r.sec}s, exit=${r.exit})`
  console.log(`${r.ok ? '✅' : '❌'} ${r.key.padEnd(4)} ${r.title}${counts}  ${secs}`)
}
const failed = rows.filter((r) => !r.ok)
console.log(
  `\n${failed.length ? '❌' : '✅'} ${rows.length - failed.length}/${rows.length} 场景通过` +
    (failed.length ? `；失败：${failed.map((r) => r.key).join(', ')}` : '')
)
writeFileSync(
  join(EVID_DIR, `all-${stamp}.json`),
  JSON.stringify({ group: GROUP, only: ONLY, app: APP, comfy: COMFY, rows }, null, 2)
)
console.log(`汇总：${EVID_DIR}/all-${stamp}.json`)
process.exit(failed.length ? 1 : 0)
