// 替代原 copy-dist.js + build 内联 terser 步骤：
// vite build 已直接输出到 src/main/artifylab/public/frontend，
// 这里仅压缩 comfy_inject.js（保持与旧 build 脚本一致的产物形态）。
import { execSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.resolve(__dirname, '../../../src/main/artifylab/public/frontend')
execSync(
  'npx terser ' + outDir + '/comfy_inject.js -o ' + outDir + '/comfy_inject.min.js --compress --mangle',
  { stdio: 'inherit' }
)
fs.rmSync(path.join(outDir, 'comfy_inject.js'))
console.log('frontend 产物已输出到 src/main/artifylab/public/frontend')
