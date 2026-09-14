/**
 * #5「生成过程直通预览」前端渲染链路验收（playwright 无头 Chromium，与用户 Chrome 隔离）。
 *
 * 为什么单独有这个脚本：`scripts/wb-preview-verify.mjs` 验的是**协议与画面数据**
 * （真机 ComfyUI → 能力协商 → 二进制帧解码），而预览最终要由前端渲染出来。
 * 这两段之间是 AG-UI 事件 → aguiBridge → 消息 → 工具卡 <img> 的前端链路，
 * 单测覆盖不到"真的画出来了"，所以用本仓库既有的 acceptance 三件套
 * （acceptance/workbench：serve + stub + 截图）跑一次真实浏览器。
 *
 * 前置：
 *   pnpm run build:frontend
 *   node acceptance/workbench/serve.mjs 5175
 *
 * 断言：工具卡出现 → [data-testid=exec-preview] 出现 → 该 <img> **真的解码成功**
 * （naturalWidth > 0）且 src 是 data:image/* → 无页面级报错。
 */
import { chromium } from 'playwright'
import { fileURLToPath } from 'node:url'

const BASE = process.argv[2] || 'http://127.0.0.1:5175'
const SHOT_DIR = fileURLToPath(new URL('../acceptance/workbench/screenshots/', import.meta.url))

// 触发消息可换（默认命中 stub 的 withPreview 场景）；WB_EXPECT=0 时只观测不断言
// ——用于对照实验：换成一条不命中任何场景的消息，看报错/兜底是否与预览链路相关。
const MSG = process.env.WB_MSG || '我要看实时预览'
const EXPECT = process.env.WB_EXPECT !== '0'
// 截图基名可换：换 WB_MSG 做别的场景回归时不会覆盖预览那张证据
const SHOT = process.env.WB_SHOT || 'w9-preview'

const errors = []
let failed = false

const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } })
const page = await context.newPage()
page.on('pageerror', (e) => errors.push('pageerror: ' + String(e).slice(0, 200)))
page.on('console', (m) => {
  if (m.type() === 'error') errors.push('console.error: ' + m.text().slice(0, 200))
})
// SPA fallback 把 index.html 返给 /api/* 请求时，前端 JSON.parse 会炸成
// "Unexpected token '<'"——记录下来便于区分「stub 未覆盖的端点」与真实前端 bug
const htmlForApi = []
page.on('response', (r) => {
  const ct = String(r.headers()['content-type'] || '')
  if (ct.includes('text/html') && /\/api\//.test(r.url())) htmlForApi.push(r.url().slice(-70))
})

try {
  await page.goto(`${BASE}/workbench`, { waitUntil: 'load', timeout: 30000 })
  await page.waitForTimeout(3500)
  console.log('✓ 页面加载:', page.url())

  if (!page.url().includes('/workbench')) {
    throw new Error(`路由守卫把页面重定向走了（stub 未生效？）：${page.url()}`)
  }

  // 关掉可能的引导浮层（headless 全新配置常见）
  for (let i = 0; i < 3; i++) {
    const close = page.locator('.ant-modal-close, [role="dialog"] button:has(i.fa-times)').first()
    if (!(await close.count())) break
    await close.click().catch(() => {})
    await page.waitForTimeout(500)
  }
  await page.keyboard.press('Escape').catch(() => {})

  // 发消息：命中 stub 的 withPreview 场景（/预览|preview/）
  const ta = page.locator('textarea:visible').first()
  await ta.fill(MSG, { timeout: 15000 })
  await page.waitForTimeout(300)
  const send = page
    .locator('button:has(i.fa-arrow-up), button[title="发送"], button[title="Send"]')
    .first()
  await send.click()
  console.log('✓ 已发送触发消息')

  // 等工具卡 + 预览图
  let stats = null
  for (let i = 0; i < 15; i++) {
    await page.waitForTimeout(1000)
    stats = await page.evaluate(() => {
      const imgs = [...document.querySelectorAll('[data-testid="exec-preview"]')]
      return {
        cards: document.querySelectorAll('.tool-card, [data-testid="tool-card"]').length,
        previewCount: imgs.length,
        decoded: imgs.filter((im) => im.complete && im.naturalWidth > 0).length,
        naturalWidth: imgs[0] ? imgs[0].naturalWidth : 0,
        naturalHeight: imgs[0] ? imgs[0].naturalHeight : 0,
        srcHead: imgs[0] ? imgs[0].getAttribute('src').slice(0, 32) : null,
        // 通用探针：换个 WB_MSG 就能顺带回归其它场景（改共享 stub 后尤其需要）
        todoRows: document.querySelectorAll('.progress-card--todo [data-testid=progress-row]')
          .length,
        streamInterrupted: document.body.innerText.includes('对话流中断'),
      }
    })
    if (stats.previewCount > 0 && stats.decoded > 0) break
  }

  console.log('--- 渲染统计 ---')
  console.log(JSON.stringify(stats, null, 2))

  await page.screenshot({ path: SHOT_DIR + SHOT + '.png' })
  console.log('✓ 截图:', SHOT_DIR + SHOT + '.png')

  // —— 断言 ——
  if (!EXPECT) {
    console.log('\n（观测模式 WB_EXPECT=0：只输出统计，不做断言）')
  } else {
    if (!stats || stats.previewCount === 0) {
      throw new Error('未渲染出 [data-testid=exec-preview]：preview_frame 没有落到工具卡上')
    }
    if (stats.decoded === 0) {
      throw new Error(
        `预览图上屏但未解码成功（naturalWidth=${stats.naturalWidth}）——data URL 可能损坏`
      )
    }
    if (!String(stats.srcHead).startsWith('data:image/')) {
      throw new Error(`预览图 src 不是 data:image/*：${stats.srcHead}`)
    }
    if (stats.naturalWidth <= 1 || stats.naturalHeight <= 1) {
      throw new Error(`解码尺寸异常 ${stats.naturalWidth}x${stats.naturalHeight}（疑似占位 1x1）`)
    }
    console.log(
      `\n✓ 通过：预览帧经 AG-UI → aguiBridge → 工具卡渲染成功（${stats.previewCount} 张，已解码，尺寸 ${stats.naturalWidth}x${stats.naturalHeight}）`
    )
  }
} catch (e) {
  failed = true
  console.log('\n❌ 失败：' + (e instanceof Error ? e.message : String(e)))
  await page.screenshot({ path: SHOT_DIR + SHOT + '-failed.png' }).catch(() => {})
} finally {
  if (htmlForApi.length) {
    console.log('\n⚠️ /api/* 被 SPA fallback 兜成 HTML（stub 未覆盖的端点，前端会 JSON.parse 失败）:')
    ;[...new Set(htmlForApi)].slice(0, 6).forEach((u) => console.log('   ' + u))
  }
  if (errors.length) {
    console.log('\n⚠️ 页面报错（前 5 条）:')
    errors.slice(0, 5).forEach((x) => console.log('   ' + x))
  } else {
    console.log('\n✓ 无页面级报错')
  }
  await browser.close()
}

process.exit(failed ? 1 : 0)
