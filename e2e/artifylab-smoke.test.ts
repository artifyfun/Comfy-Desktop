/**
 * ArtifyLab 前端 e2e 冒烟（第三批①）。
 *
 * 覆盖三巨石页面的「能挂载」：workbench（会话管线 + 桥接线）、
 * canvas（Konva 画布 + 项目集 composable）、batch（数据源/历史 composable）。
 * index.vue 拆分靠 vite build + 单测兜底——composable 接线的运行时错误
 * （TDZ/漏导出/模板名未暴露）只有真实挂载才暴露，本套是深拆 canvas
 * 交互核心的保护网。
 *
 * 启动形态：vite dev（5020，避开 macOS ControlCenter 占用的 5000 与
 * dev script 硬编码）+ electron（E2E=1/DEV_MODE）。webContents 直接
 * loadURL 到 vite 端口（panelMode 的 5000 仅 C 宿主面板用，与这里无关）。
 */
import { test, expect, type ElectronApplication } from '@playwright/test'
import { spawn, type ChildProcess } from 'node:child_process'
import { _electron } from 'playwright'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evalWithRetry } from './support/evalRetry'

const VITE_PORT = 5020

test.describe.configure({ mode: 'serial' })
// 启动链（vite 冷启 + electron + artifylab server）远超默认 45s
test.setTimeout(150_000)

let vite: ChildProcess | null = null
let app: ElectronApplication | null = null
let homeDir = ''
let started = false

/** 在 electron 里找/建 webContents 并 loadURL（端口/hash 经参数传，防闭包逃逸） */
async function loadPage(hash: string): Promise<void> {
  const a = app!
  await evalWithRetry(() =>
    a.evaluate(
      async ({ webContents }, args) => {
        let wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes(`localhost:${args.port}`))
        if (!wc) {
          wc = webContents.getAllWebContents().find((w) => !w.getURL().includes('panel.html'))
        }
        const target = wc ?? webContents.getAllWebContents()[0]
        if (!target) return false
        // 路由是 createWebHistory（HTML5 模式）：路径直拼，无 #
        const h = args.hash.replace(/^[#/]+/, '')
        await target.loadURL(`http://localhost:${args.port}/${h}?e2e=1`)
        return true
      },
      { port: VITE_PORT, hash }
    )
  )
}

/** 拿到加载了 vite 页面的 webContents 求值 facade */
async function pageFacade(): Promise<{ evaluate: (fn: string) => Promise<unknown> }> {
  const a = app!
  let target: number | null = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    target = await evalWithRetry(() =>
      a.evaluate(({ webContents }, port) => {
        const wc = webContents
          .getAllWebContents()
          .find((w) => w.getURL().includes(`localhost:${port}`))
        return wc ? wc.id : null
      }, VITE_PORT)
    )
    if (target) break
    await new Promise((r) => setTimeout(r, 300))
  }
  if (!target) throw new Error(`no webContents on :${VITE_PORT}`)
  const id = target
  return {
    evaluate: (fn: string) =>
      evalWithRetry(() =>
        a.evaluate(
          ({ webContents }, args) => {
            const wc = webContents.getAllWebContents().find((w) => w.id === args.id)
            if (!wc) throw new Error('webContents gone')
            return wc.executeJavaScript(`(function(){ ${args.fn} })()`)
          },
          { id, fn }
        )
      )
  }
}

async function ensureStarted(): Promise<void> {
  if (started) return
  try {
    // 1) vite dev：直接 spawn vite bin（package.json dev script 硬编码
    //    --port 5000，pnpm 传参只是位置参数；5000 又被 macOS ControlCenter 占）
    await new Promise<void>((resolve, reject) => {
      vite = spawn(
        process.execPath,
        [
          join(__dirname, '..', 'packages', 'frontend', 'node_modules', 'vite', 'bin', 'vite.js'),
          '--port',
          String(VITE_PORT),
          '--strictPort'
        ],
        {
          cwd: join(__dirname, '..', 'packages', 'frontend'),
          stdio: 'pipe',
          env: { ...process.env }
        }
      )
      vite.on('exit', (code) => {
        if (code !== null && code !== 0) reject(new Error(`vite exited ${code}`))
      })
      vite.on('error', reject)
      resolve()
    })
    // stdout ready 只是进程活；HTTP 探活到 200 才算服务就绪
    const httpOk = await (async () => {
      const deadline = Date.now() + 60_000
      while (Date.now() < deadline) {
        const ok = await fetch(`http://localhost:${VITE_PORT}/`)
          .then((r) => r.ok)
          .catch(() => false)
        if (ok) return true
        await new Promise((r) => setTimeout(r, 500))
      }
      return false
    })()
    if (!httpOk) throw new Error(`vite not serving on :${VITE_PORT} after 60s`)

    // 2) electron（E2E hooks + DEV_MODE）
    homeDir = mkdtempSync(join(tmpdir(), 'artify-e2e-'))
    app = await _electron.launch({
      args: [join(__dirname, '..', 'out', 'main', 'index.js')],
      env: {
        ...process.env,
        HOME: homeDir,
        E2E: '1',
        DEV_MODE: 'true',
        E2E_SETTINGS_SEED: JSON.stringify({ firstUseCompleted: true })
      }
    })
    // 3) artifylab server（3008）就绪
    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      const ok = await fetch('http://localhost:3008/api/workbench/templates')
        .then((r) => r.ok)
        .catch(() => false)
      if (ok) break
      await new Promise((r) => setTimeout(r, 500))
    }
    started = true
  } catch (e) {
    started = false
    throw e
  }
}

test.afterAll(async () => {
  await app?.close().catch(() => {})
  vite?.kill()
  if (homeDir) {
    try {
      rmSync(homeDir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

test('workbench route loads (router match + chunk fetch + no JS errors) @windows @macos @linux', async () => {
  await ensureStarted()
  // 注入错误钩子（在首帧前）：任何模块加载/setup 抛错都会留痕
  await evalWithRetry(() =>
    app!.evaluate(
      async ({ webContents }, args) => {
        const wc =
          webContents.getAllWebContents().find((w) => !w.getURL().includes('panel.html')) ??
          webContents.getAllWebContents()[0]
        if (!wc) return false
        await wc.loadURL(args.url)
        return true
      },
      { url: `http://localhost:${VITE_PORT}/workbench?e2e=1` }
    )
  )
  const page = await pageFacade()
  // 挂载证据（网络层）：路由 chunk 真实拉取过 + URL 未被重定向 + 页面无 JS 错误
  const evidence = await page.evaluate(`
    return (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const got = (performance.getEntriesByType('resource') || []).some(
          (e) => e.name.includes('/src/views/workbench/index.vue') && e.responseStatus !== 404
        )
        if (got) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const res = (performance.getEntriesByType('resource') || []).filter((e) =>
        e.name.includes('/src/views/workbench/')
      )
      return {
        chunkLoaded: res.length > 0,
        chunk404: res.some((e) => e.responseStatus === 404),
        url: location.href,
        appAlive: !!document.querySelector('#app .ant-app'),
      }
    })()
  `)
  expect(evidence).toMatchObject({ chunkLoaded: true, chunk404: false, appAlive: true })
  expect(String((evidence as { url: string }).url)).toContain('/workbench')
})

test('canvas route loads (useCanvasProjects wiring, chunk fetch) @windows @macos @linux', async () => {
  await loadPage('#/canvas')
  const page = await pageFacade()
  const evidence = await page.evaluate(`
    return (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const got = (performance.getEntriesByType('resource') || []).some(
          (e) => e.name.includes('/src/views/canvas/index.vue') && e.responseStatus !== 404
        )
        if (got) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const res = (performance.getEntriesByType('resource') || []).filter((e) =>
        e.name.includes('/src/views/canvas/')
      )
      return {
        chunkLoaded: res.length > 0,
        chunk404: res.some((e) => e.responseStatus === 404),
        url: location.href,
        appAlive: !!document.querySelector('#app .ant-app'),
      }
    })()
  `)
  expect(evidence).toMatchObject({ chunkLoaded: true, chunk404: false, appAlive: true })
  expect(String((evidence as { url: string }).url)).toContain('/canvas')
})

test('batch route loads (useBatchSource wiring, chunk fetch) @windows @macos @linux', async () => {
  await loadPage('#/batch')
  const page = await pageFacade()
  const evidence = await page.evaluate(`
    return (async () => {
      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        const got = (performance.getEntriesByType('resource') || []).some(
          (e) => e.name.includes('/src/views/batch/index.vue') && e.responseStatus !== 404
        )
        if (got) break
        await new Promise((r) => setTimeout(r, 250))
      }
      const res = (performance.getEntriesByType('resource') || []).filter((e) =>
        e.name.includes('/src/views/batch/')
      )
      return {
        chunkLoaded: res.length > 0,
        chunk404: res.some((e) => e.responseStatus === 404),
        url: location.href,
        appAlive: !!document.querySelector('#app .ant-app'),
      }
    })()
  `)
  expect(evidence).toMatchObject({ chunkLoaded: true, chunk404: false, appAlive: true })
  expect(String((evidence as { url: string }).url)).toContain('/batch')
})
