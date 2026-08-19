/**
 * Cross-platform `pnpm dev` launcher.
 *
 * Why this file exists:
 * The old script `pnpm --filter artifylab-frontend dev & cross-env DEV_MODE=true electron-vite dev`
 * relies on `&` which means "background" in bash (Linux/macOS) but "sequential"
 * in Windows cmd/PowerShell — so on Windows the electron-vite part never ran.
 *
 * This script spawns both processes in parallel and forwards stdin/stdout/stderr,
 * and tears them all down together on Ctrl+C / exit.
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'

const root = process.cwd()
const electronViteBin = resolve(root, 'node_modules/electron-vite/bin/electron-vite.js')

if (!existsSync(electronViteBin)) {
  console.error('[dev] electron-vite binary not found. Run "pnpm install" first.')
  process.exit(1)
}

// electron-vite wipes `out/` before building via the OS trash, which sandboxes
// (e.g. WorkBuddy) may block. Pre-clean it with an external command so the
// build always proceeds. Use spawnSync so we finish cleaning before starting.
const outDir = resolve(root, 'out')
if (existsSync(outDir)) {
  const isWin = process.platform === 'win32'
  const clean = spawnSync(
    isWin ? 'cmd' : 'rm',
    isWin ? ['/c', 'rmdir', '/s', '/q', outDir] : ['-rf', outDir],
    { stdio: 'ignore' },
  )
  if (clean.status !== 0) {
    console.warn('[dev] warning: could not fully clean out/ before build')
  }
}

/** @type {import('node:child_process').ChildProcess[]} */
const children = []

function run(name, command, args, options = {}) {
  console.log(`[dev] starting ${name}: ${command} ${args.join(' ')}`)
  const child = spawn(command, args, {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    // Use the caller-provided env as-is (it is already a full copy of
    // process.env with modifications). Merging with process.env again here
    // would resurrect variables the caller deliberately deleted.
    env: options.env ?? process.env,
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

// 1) Frontend Vite dev server (http://localhost:5000)
run('frontend', 'pnpm', ['--filter', 'artifylab-frontend', 'dev'])

// 2) Electron main + renderer dev (DEV_MODE=true)
const electronEnv = { ...process.env, DEV_MODE: 'true' }
// Some sandboxes (e.g. WorkBuddy) inject ELECTRON_RUN_AS_NODE=1 which makes
// Electron run as a plain Node process (electron.app is undefined) — strip it
// so the app window actually opens.
delete electronEnv.ELECTRON_RUN_AS_NODE
run('electron', process.execPath, [electronViteBin, 'dev'], {
  env: electronEnv,
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
  // Give children a moment to die, then hard-exit (in case of detached shells).
  setTimeout(() => process.exit(0), 800).unref()
}

process.on('SIGINT', () => teardown('SIGINT'))
process.on('SIGTERM', () => teardown('SIGTERM'))
process.on('SIGQUIT', () => teardown('SIGQUIT'))
