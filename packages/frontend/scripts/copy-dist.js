#!/usr/bin/env node
import fs from 'fs'
import path from 'path'
import { rimrafSync } from 'rimraf'
import * as mkdirp from 'mkdirp'
import { fileURLToPath } from 'url'
import fsExtra from 'fs-extra'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const srcDir = path.resolve(__dirname, '../dist/frontend')
// Comfy-Desktop 新架构下 artifylab 服务层位于 src/main/artifylab
const destDir = path.resolve(__dirname, '../../Comfy-Desktop/src/main/artifylab/public/frontend')

// 删除目标目录
if (fs.existsSync(destDir)) {
  rimrafSync(destDir)
}
// 创建目标目录
mkdirp.sync(destDir)
fsExtra.copySync(srcDir, destDir, { overwrite: true })
console.log('dist/frontend 已复制到 Comfy-Desktop/src/main/artifylab/public/frontend')
