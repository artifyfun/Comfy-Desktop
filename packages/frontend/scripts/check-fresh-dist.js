#!/usr/bin/env node
/**
 * 防静默过期守卫：workbench/canvas 改动后若没跑 build:copy，宿主 iframe
 * 会继续跑旧 bundle（无任何报错，用户只会看到"改了没生效"）。
 * dev.mjs 在启动 electron 前跑本脚本——发现过期直接 fail，把问题留在启动时刻。
 *
 * 规则：src/{views,public} 下任一源文件的 mtime 新于部署产物的 index.html → 过期。
 * 豁免：node_modules、dist（本脚本只扫 src 两层目录，够用且快）。
 *
 * 跳过守卫：ARTIFY_SKIP_FRESH_CHECK=1（明确知道自己在做什么时，例如只调试 inject）。
 */
import { readdirSync, statSync, existsSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.env.ARTIFY_SKIP_FRESH_CHECK === '1') {
  console.log('[check-fresh-dist] ARTIFY_SKIP_FRESH_CHECK=1，跳过期检查')
  process.exit(0)
}

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const deployedIndex = path.join(
  frontendRoot,
  '..',
  '..',
  'src',
  'main',
  'artifylab',
  'public',
  'frontend',
  'index.html',
)

if (!existsSync(deployedIndex)) {
  console.error(
    '[check-fresh-dist] 部署产物缺失（src/main/artifylab/public/frontend/index.html）。',
  )
  console.error('                 先跑: pnpm --filter artifylab-frontend build:copy')
  process.exit(1)
}

const deployedMtime = statSync(deployedIndex).mtimeMs
const scanDirs = [
  path.join(frontendRoot, 'src', 'views'),
  path.join(frontendRoot, 'src', 'components'),
  path.join(frontendRoot, 'public'),
]
const exts = new Set(['.vue', '.js', '.ts', '.css'])

const stale = []
function walk(dir, depth) {
  if (depth > 4) return
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const ent of entries) {
    const p = path.join(dir, ent.name)
    if (ent.isDirectory()) {
      walk(p, depth + 1)
      continue
    }
    if (!exts.has(path.extname(ent.name))) continue
    try {
      if (statSync(p).mtimeMs > deployedMtime) stale.push(path.relative(frontendRoot, p))
    } catch {
      /* race with editor writes — ignore */
    }
  }
}
scanDirs.forEach((d) => walk(d, 0))

if (stale.length) {
  console.error('[check-fresh-dist] 部署产物过期——以下源文件新于 public/frontend/index.html:')
  stale.slice(0, 8).forEach((f) => console.error('  ' + f))
  if (stale.length > 8) console.error(`  …共 ${stale.length} 个`)
  console.error('修复: pnpm --filter artifylab-frontend build:copy')
  console.error('（确实只想改 electron 侧、不重建前端时: ARTIFY_SKIP_FRESH_CHECK=1）')
  process.exit(1)
}
console.log('[check-fresh-dist] 部署产物与源码同步 ✓')
