#!/usr/bin/env node
/**
 * build:copy 的第二段——把 packages/frontend 的构建产物同步到 electron 主进程的
 * 静态服务目录（dev 直读 / 打包 extraResources 的源）。
 *
 * 背景（技术债修复）：此脚本曾在 package.json 中被引用但文件缺失，`npm run build:copy`
 * 静默失败（npm 只报 Node 堆栈），宿主 iframe 因此长期跑旧 bundle（2026-08 真机事故：
 * 窄栏形态塌回桌面布局）。除了补脚本，还加了 staleness 守卫（scripts/check-fresh-dist.js）
 * 让「源码新于产物」显式报错。
 *
 * 语义：
 *  1. 校验 dist/frontend 存在且含 index.html / assets / comfy_inject.min.js
 *  2. 清空目标 assets/（旧 hash chunk 会无限堆积）后整目录拷贝
 *  3. 幂等：重复执行无副作用
 */
import { existsSync, mkdirSync, rmSync, cpSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const frontendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const src = path.join(frontendRoot, 'dist', 'frontend')
// 唯一消费方：electron 主进程静态目录（dev 直读；打包时 extraResources 从这里复制）
const dst = path.join(frontendRoot, '..', '..', 'src', 'main', 'artifylab', 'public', 'frontend')

const required = ['index.html', 'assets', 'comfy_inject.min.js']
const missing = required.filter((rel) => !existsSync(path.join(src, rel)))
if (missing.length) {
  console.error(
    `[copy-dist] dist/frontend 缺少 ${missing.join(', ')}——先完整跑 "npm run build"（含 terser 压缩 inject），再执行本脚本。`,
  )
  process.exit(1)
}

// 明文 inject（dev 消费方 artifylab/index.ts 的 devUrl 走 public/comfy_inject.js，
// extensions.ts 也会读 public 目录）随产物一并同步——否则 dev 环境注入的仍是旧桥。
if (!existsSync(path.join(src, 'comfy_inject.js'))) {
  console.error(
    '[copy-dist] dist/frontend 缺少 comfy_inject.js（build:inject 产物）——先跑 "npm run build"。',
  )
  process.exit(1)
}

// 记录源产物时间戳，供 check-fresh-dist 守卫比对
const srcMtime = statSync(path.join(src, 'index.html')).mtimeMs

rmSync(path.join(dst, 'assets'), { recursive: true, force: true })
mkdirSync(dst, { recursive: true })
cpSync(src, dst, { recursive: true })

console.log(
  `[copy-dist] ${path.relative(process.cwd(), src)} → ${path.relative(process.cwd(), dst)} (index.html mtime=${Math.round(srcMtime)})`,
)
