#!/usr/bin/env node
// 扫描 src/utils/i18n.js 中每个语言对象内的重复键（对象字面量后写覆盖前写）
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/utils/i18n.js')
const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/)

// 顶层语言块：以两个空格 + `xx: {` 开头
const langs = []
for (let i = 0; i < lines.length; i++) {
  const m = lines[i].match(/^ {2}([A-Za-z_-]+): \{$/)
  if (m) langs.push({ lang: m[1], start: i })
}
langs.forEach((l, i) => (l.end = i + 1 < langs.length ? langs[i + 1].start - 1 : lines.length - 1))

let total = 0
for (const { lang, start, end } of langs) {
  const seen = new Map()
  for (let i = start + 1; i <= end; i++) {
    // 键只统计四空格缩进的一级键
    const m = lines[i].match(/^ {4}([A-Za-z0-9_$]+):\s*(.*)$/)
    if (!m) continue
    const [, key, val] = m
    if (seen.has(key)) {
      total++
      console.log(
        `[${lang}] 重复键 "${key}"\n    前: ${seen.get(key).line}: ${seen.get(key).val.slice(0, 60)}\n    后: ${i + 1}: ${val.slice(0, 60)}`
      )
    } else {
      seen.set(key, { line: i + 1, val })
    }
  }
}
console.log(total ? `\n共 ${total} 处重复键` : '\n未发现重复键')
process.exit(total ? 1 : 0)
