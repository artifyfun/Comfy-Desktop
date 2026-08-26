// scripts/copy-codex-bin.mjs
//
// 把 @openai/codex 平台包里的【原生 codex 二进制】拷进仓库资产目录，
// 由 electron-builder extraResources 打进应用（resources/codex-bin）。
// agentDriver 通过 Codex SDK 的 codexPathOverride 直接 spawn 这个内置 exe ——
// 用户机器无需安装 codex CLI / node，只要填 DeepSeek key 即可。
//
// 用法：
//   node scripts/copy-codex-bin.mjs            # 拷贝当前平台
//   CODEX_TARGET_TRIPLE=x86_64-pc-windows-msvc node scripts/copy-codex-bin.mjs  # 指定目标平台（跨平台打包）
import { cpSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { arch, platform } from 'node:os'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// target triple → 平台包名（与 codex 的 bin/codex.js 中 PLATFORM_PACKAGE_BY_TARGET 一致）
const PKG_BY_TRIPLE = {
  'x86_64-pc-windows-msvc': '@openai/codex-win32-x64',
  'aarch64-pc-windows-msvc': '@openai/codex-win32-arm64',
  'x86_64-apple-darwin': '@openai/codex-darwin-x64',
  'aarch64-apple-darwin': '@openai/codex-darwin-arm64',
  'x86_64-unknown-linux-musl': '@openai/codex-linux-x64',
  'aarch64-unknown-linux-musl': '@openai/codex-linux-arm64',
}
const TRIPLE_BY_TARGET = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

function detectTriple() {
  if (process.env.CODEX_TARGET_TRIPLE) return process.env.CODEX_TARGET_TRIPLE
  const triple = TRIPLE_BY_TARGET[`${platform()}-${arch()}`]
  if (!triple) {
    console.error(`[copy-codex-bin] 不支持的平台 ${platform()}-${arch()}，可用 CODEX_TARGET_TRIPLE 指定`)
    process.exit(1)
  }
  return triple
}

function resolveVendorRoot(triple) {
  const pkg = PKG_BY_TRIPLE[triple]
  if (!pkg) {
    console.error(`[copy-codex-bin] 未知 triple: ${triple}`)
    process.exit(1)
  }
  // pnpm 隔离布局下平台包挂在 @openai/codex 自己的 node_modules 下（非顶层），
  // 需先 resolve @openai/codex，再从它的上下文二次 resolve 平台包（与官方 findCodexPath 同法）
  try {
    const codexPkgJsonPath = require.resolve('@openai/codex/package.json')
    const codexRequire = createRequire(codexPkgJsonPath)
    const platformPkgJsonPath = codexRequire.resolve(`${pkg}/package.json`)
    return join(dirname(platformPkgJsonPath), 'vendor', triple)
  } catch (err) {
    console.error(`[copy-codex-bin] 找不到 ${pkg} —— 请先执行 pnpm install（需安装 optionalDependencies，含平台二进制）`)
    console.error(`  详情: ${err?.message ?? err}`)
    process.exit(1)
  }
}

function main() {
  const triple = detectTriple()
  const src = resolveVendorRoot(triple)
  const binName = platform() === 'win32' ? 'codex.exe' : 'codex'
  const exe = join(src, 'bin', binName)
  if (!existsSync(exe)) {
    console.error(`[copy-codex-bin] ${src} 中缺少 ${binName}，平台包可能不完整`)
    process.exit(1)
  }
  const dst = join(ROOT, 'src/main/artifylab/public/codex-bin', triple)
  mkdirSync(dirname(dst), { recursive: true })
  cpSync(src, dst, { recursive: true })
  const copied = existsSync(join(dst, 'bin', binName))
  const size = copied ? readFileSync(join(dst, 'bin', binName)).length : 0
  if (!copied) {
    console.error(`[copy-codex-bin] 拷贝失败: ${src} -> ${dst}`)
    process.exit(1)
  }
  console.log(`[copy-codex-bin] OK: ${triple} -> ${dst} (${(size / 1024 / 1024).toFixed(1)} MB, ${binName})`)
}

main()
