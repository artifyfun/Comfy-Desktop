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
 *
 * Upstream v1.2.1 adds dev-app link registration (comfy:// scheme reaching
 * this clone on macOS/Linux) before launching electron; kept below via the
 * devAppEnv() merge with the Artify panel-vite orchestration.
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join, resolve } from 'node:path'
import {
  DEV_APP,
  DEV_APP_BUNDLE_ENV,
  devAppLinksWanted,
  ensureCloneDevApp,
  unregisterDevApp
} from './dev-app/devApp.mjs'
import {
  DEV_DESKTOP_ENTRY_ENV,
  LINUX_DEV_ENTRY,
  devSandboxOff,
  ensureLinuxDevEntry,
  removeLinuxDevEntry
} from './dev-app/linuxEntry.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const root = join(__dirname, '..')
const electronViteBin = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')
const ELECTRON_VITE_ARGS = process.argv.slice(2)
const SANDBOX_OFF = await devSandboxOff(process.env, ELECTRON_VITE_ARGS, root)

function warn(message) {
  console.warn(`\n\x1b[33m⚠ ${message}\x1b[0m\n`)
}

function linuxDevEntryEnv() {
  if (process.env['COMFY_DRAFT_APP_LINKS'] === '0') {
    try {
      removeLinuxDevEntry(root)
    } catch (err) {
      warn(`Could not remove the ${LINUX_DEV_ENTRY.name} desktop entry: ${err.message}`)
    }
    return {}
  }
  if (process.env['E2E'] === '1') return {}
  try {
    return { [DEV_DESKTOP_ENTRY_ENV]: ensureLinuxDevEntry(root, process.env, SANDBOX_OFF) }
  } catch (err) {
    warn(
      `Could not set up the ${LINUX_DEV_ENTRY.name} desktop entry, so ${LINUX_DEV_ENTRY.scheme}:// links will not reach this copy. ${err.message}`
    )
    return {}
  }
}

function devAppEnv() {
  if (process.platform === 'linux') return linuxDevEntryEnv()
  if (process.platform !== 'darwin') return {}
  if (process.env['COMFY_DRAFT_APP_LINKS'] === '0') {
    try {
      unregisterDevApp(join(root, DEV_APP.dir))
    } catch (err) {
      warn(`Could not unregister ${DEV_APP.name}: ${err.message}`)
    }
    return {}
  }
  if (!devAppLinksWanted(process.platform, process.env)) return {}
  try {
    const devApp = ensureCloneDevApp(root)
    return { ELECTRON_EXEC_PATH: devApp.executable, [DEV_APP_BUNDLE_ENV]: devApp.bundle }
  } catch (err) {
    warn(
      `Could not set up ${DEV_APP.name}, so ${DEV_APP.scheme}:// links will not reach this copy. Starting plain Electron. ${err.message}`
    )
    return {}
  }
}

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
const feDir = join(root, 'packages/frontend')
const viteBin = join(feDir, 'node_modules/vite/bin/vite.js')
const viteProc = run(
  'frontend',
  process.execPath,
  [
    viteBin,
    '--config',
    join(feDir, 'vite.config.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(PANEL_PORT),
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
    const ok = await new Promise((resolveWait) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1500 }, (res) => {
        res.resume()
        resolveWait(res.statusCode === 200)
      })
      req.on('error', () => resolveWait(false))
      req.on('timeout', () => {
        req.destroy()
        resolveWait(false)
      })
    })
    if (ok) return true
    await new Promise((r) => setTimeout(r, 500))
  }
  return false
}

function electronViteCli() {
  const require = createRequire(join(root, 'package.json'))
  const packageJson = require.resolve('electron-vite/package.json')
  const { bin } = JSON.parse(readFileSync(packageJson, 'utf-8'))
  return join(dirname(packageJson), bin['electron-vite'])
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
    ARTIFY_DEV_PANEL_PORT: String(PANEL_PORT),
    ...(SANDBOX_OFF ? { NO_SANDBOX: '1' } : {}),
    ...devAppEnv()
  }
  // Some sandboxes (e.g. WorkBuddy) inject ELECTRON_RUN_AS_NODE=1 which makes
  // Electron run as a plain Node process (electron.app is undefined) — strip it
  // so the app window actually opens.
  delete electronEnv.ELECTRON_RUN_AS_NODE
  run('electron', process.execPath, [electronViteCli(), 'dev', ...ELECTRON_VITE_ARGS], {
    env: electronEnv
  })
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
