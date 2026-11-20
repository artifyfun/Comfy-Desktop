#!/usr/bin/env node
/**
 * inject 打包链：src/inject/index.js（模块化源）→ public/comfy_inject.js
 * （单体 IIFE，electron 主进程 extensions.ts / artifylab routes 的既有消费方
 * 不需要任何改动——它们只认 public/comfy_inject.js 与 dist/frontend/
 * comfy_inject.min.js 这两个产物文件名）。
 *
 * 为什么不是直接手写 public/comfy_inject.js：2123 行单文件无模块边界已造成
 * 三轮盲改（governor/fab/窄栏），拆模块后每次改动落在 100-700 行的文件里，
 * esbuild 打包 + terser 压缩语义与旧链完全一致。
 *
 * format=iife + 立即执行的 ()()：保持顶层 return 合法（eval/executeJavaScript
 * 上下文），幂等保护留在 index.js 的 IIFE 壳内。
 */
import { build } from 'esbuild'
import { writeFileSync, statSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const result = await build({
  entryPoints: [path.join(root, 'src/inject/index.js')],
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome120',
  minify: false,
  write: false,
  legalComments: 'none',
  logLevel: 'silent',
})

let code = result.outputFiles[0].text
// esbuild 的 iife 输出是 `(() => { ... })();` —— 顶层 return 需要真 function
// IIFE 才合法（eval/executeJavaScript 里箭头函数体一样支持 return，但与
// 原文件保持字节级习惯一致：function 形式）。统一改写为 ;(function () {...})()
code = code.replace(/^\(\(\) => \{/, ';(function () {')
if (!code.endsWith('})();')) {
  // esbuild iife 默认以 })(); 结尾 —— 正常路径不触发
  code = code.replace(/\}\)\(\);\s*$/, '})();')
}
writeFileSync(path.join(root, 'public/comfy_inject.js'), code)
const kb = Math.round(statSync(path.join(root, 'public/comfy_inject.js')).size / 1024)
console.log(`[build-inject] src/inject/*.js → public/comfy_inject.js (${kb} KB)`)
