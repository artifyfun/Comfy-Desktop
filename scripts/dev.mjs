/**
 * Dev orchestrator: frontend vite + electron main/renderer.
 *
 * Panel URL correctness (2026-09 fix): macOS ControlCenter (AirPlay) holds
 * IPv4 *:5000 indefinitely. The old `vite --port 5000` bound only [::1]:5000
 * while electron's Chromium resolves localhost preferentially to IPv4 → the
 * A-UI panel loaded the system process → blank canvas page; reload never
 * helped because the URL itself hit the wrong stack. Now vite is pinned to
 * 127.0.0.1:5100 with --strictPort (a collision fails loudly instead of
 * drifting), the port is injected via ARTIFY_DEV_PANEL_PORT, and panelMode
 * reads that env. DEV_PANEL_PORT=x overrides the port for debugging.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const electronViteBin = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')

const viteOverride = Number(process.env.DEV_PANEL_PORT)
const PANEL_PORT = Number.isInteger(viteOverride) && viteOverride > 0 ? viteOverride : 5100

/** @type {import('node:child_process').ChildProcess[]} */
const children = []

function run(name, command, args, options = {}) {
  console.log(`[dev] starting ${name}: ${command} ${args.join(' ')}`)
  const child = spawn(command, args, {
    stdio: options.stdio ?? 'inherit',
    shell: process.platform === 'win32',
    cwd: options.cwd,
    env: options.env ?? process.env
  })
  children.push(child)
  child.on('error', (err) => {
    console.error(`[dev] ${name} failed to start:`, err.message)
  })
  child.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited (code=${code}, signal=${signal})`)
  })
  return child
}

// ---- 1) Frontend vite dev server, pinned to 127.0.0.1:PANEL_PORT ----
// 直接 spawn vite bin：pnpm filter 的 `--` 透传会变成位置参数被 vite 忽略。
const feDir = join(root, 'packages/frontend')
const viteBin = join(feDir, 'node_modules/vite/bin/vite.js')
const viteProc = run(
  'frontend',
  process.execPath,
  [
    viteBin,
    '--config', join(feDir, 'vite.config.js'),
    '--host', '127.0.0.1',
    '--port', String(PANEL_PORT),
    '--strictPort'
  ],
  {
    stdio: ['inherit', 'pipe', 'inherit'],
    cwd: feDir,
    env: { ...process.env }
  }
)
viteProc.stdout?.on('data', (chunk) => process.stdout.write(`[vite] ${chunk}`))
viteProc.stderr?.on('data', (chunk) => process.stderr.write(`[vite:err] ${chunk}`))

// ---- 2) Wait for vite to accept connections, then start electron ----
async function waitForVite(port, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const ok = await new Promise((resolve) => {
      const req = http.get(
        { host: '127.0.0.1', port, path: '/', timeout: 1500 },
        (res) => {
          res.resume()
          resolve(res.statusCode === 200)
        }
      )
      req.on('error', () => resolve(false))
      req.on('timeout', () => {
        req.destroy()
        resolve(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

async function main() {
  const ready = await waitForVite(PANEL_PORT)
  if (!ready) {
    console.error(
      `[dev] ERROR: vite not reachable on 127.0.0.1:${PANEL_PORT} — aborting electron launch (port busy? DEV_PANEL_PORT to override)`
    )
    process.exit(1)
  }
  console.log(`[dev] panel vite ready on http://127.0.0.1:${PANEL_PORT} — launching electron`)

  const electronEnv = {
    ...process.env,
    DEV_MODE: 'true',
    ARTIFY_DEV_PANEL_PORT: String(PANEL_PORT)
  }
  // Some sandboxes (e.g. WorkBuddy) inject ELECTRON_RUN_AS_NODE=1 which makes
  // Electron run as a plain Node process (electron.app is undefined) — strip it
  // so the app window actually opens.
  delete electronEnv.ELECTRON_RUN_AS_NODE
  run('electron', process.execPath, [electronViteBin, 'dev'], { env: electronEnv })
}

main().catch((err) => {
  console.error('[dev] orchestration failed:', err)
  process.exit(1)
})

let tearingDown = false
function teardown(signal) {
  if (tearingDown) return
  tearingDown = true
  console.log(`\n[dev] received ${signal}, shutting down...`)
  for (const child of children) {
    if (child && !child.killed) {
      try {
        child.kill()
      } catch {
        /* already gone */
      }
    }
  }
  setTimeout(() => process.exit(0), 1500).unref()
  process.on('exit', () => {
    for (const child of children) {
      if (child && !child.killed) {
        try {
          child.kill('SIGKILL')
        } catch {
          /* noop */
        }
      }
    }
  })
}

process.on('SIGINT', () => teardown('SIGINT'))
process.on('SIGTERM', () => teardown('SIGTERM'))

if (!existsSync(electronViteBin)) {
  console.error('[dev] electron-vite binary not found. Run `pnpm install` first.')
  process.exit(1)
}
