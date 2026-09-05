// scripts/clean-dist-resources.mjs
//
// 打包前清掉 dist/win-unpacked/resources 下由 extraResources 拷贝进去的目录，
// 避免历史产物（典型：前端 hash chunk）在多次打包后累积。
//
// 触发方式：electron-builder.yml 的 `beforeBuild` 钩子 —— 对
// `electron-builder --dir / --win / --mac / --linux` 全部生效，打包时会重新复制。
//
// 只删「每次必定重新复制的纯拷贝目录」：
//   - frontend        ← src/main/artifylab/public/frontend（vite --emptyOutDir 产物）
//   - design-system   ← src/main/artifylab/public/design-system
//   - workbench-skills← src/main/artifylab/public/workbench-skills
// 刻意不碰 codex-bin（~374MB 原生二进制，重拷代价高且文件名不带 hash，覆盖即可）
// 以及 resources 下的其余运行时配置。
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// 安全基座：只允许删 dist/<output>/resources 内的白名单目录
const RESOURCES_DIR = resolve(ROOT, 'dist/win-unpacked/resources')
const TARGETS = ['frontend', 'design-system', 'workbench-skills']

function countFiles(dir) {
  let n = 0
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = resolve(dir, e.name)
    if (e.isDirectory()) n += countFiles(p)
    else n += 1
  }
  return n
}

let removed = 0
for (const name of TARGETS) {
  const abs = resolve(RESOURCES_DIR, name)
  // 越界防护：解析后必须仍在基座内（防路径穿越 / 误配绝对路径）
  if (abs === RESOURCES_DIR || !abs.startsWith(RESOURCES_DIR + sep)) {
    console.error(`[clean-dist] 拒绝删除越界路径: ${abs}`)
    process.exitCode = 1
    continue
  }
  if (!existsSync(abs)) continue
  if (!statSync(abs).isDirectory()) {
    console.error(`[clean-dist] 目标不是目录，跳过: ${abs}`)
    continue
  }
  const n = countFiles(abs)
  rmSync(abs, { recursive: true, force: true })
  removed += n
  console.log(`[clean-dist] 已清理 resources/${name}（${n} 个文件）`)
}

if (removed === 0) console.log('[clean-dist] 无历史产物，跳过')
