/**
 * agent 进程环境 helper——uvx 可用性探测 / civitai MCP TOML / codex 二进制定位。
 * 从 service.ts 出仓（候选 ①）：agentRuntime 与 service 共用的进程探测逻辑。
 */
import { spawn } from 'node:child_process'
import { getCivitaiApiKey } from './modelKnowledge'
import { resolveCodexBinary, resolveCodexBaseUrl } from '../agentDriver'
import { logger } from '../utils/logger'

export { resolveCodexBinary, resolveCodexBaseUrl }

/* ------------------------------------------------------------------ */
/* uvx 可用性探测                                                       */
/* ------------------------------------------------------------------ */

/**
 * uvx 可用性探测。uvx 缺失/超时 → config.toml 不写该段
 * （降级：wb_query_models action=civitai 走主进程 fetch，仍可在线搜索）。
 * 设计红线：主进程不做 spawnSync 阻塞探测（首次会话创建卡主进程 5s 不可接受）——
 * 启动时异步预热一次，同步读取只看缓存；缓存过期时后台刷新、先用旧值。
 */
const UVX_TTL_MS = 10 * 60 * 1000
let uvxCached: { value: boolean; at: number } | null = null
let uvxProbing = false

async function probeUvxAsync(): Promise<boolean> {
  if (uvxProbing) return uvxCached?.value ?? false
  uvxProbing = true
  try {
    const value = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean) => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      try {
        const child = spawn('uvx', ['--version'], { stdio: 'ignore' })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          done(false)
        }, 5000)
        timer.unref?.()
        child.on('error', () => {
          clearTimeout(timer)
          done(false)
        })
        child.on('exit', (code) => {
          clearTimeout(timer)
          done(code === 0)
        })
      } catch {
        done(false)
      }
    })
    uvxCached = { value, at: Date.now() }
    if (!value) logger.info('workbench: uvx 不可用，civitai MCP 跳过挂载')
    return value
  } finally {
    uvxProbing = false
  }
}

/** 启动预热：会话创建前缓存就绪，避免同步路径空转 */
void probeUvxAsync().catch(() => {})

export function uvxAvailable(): boolean {
  if (uvxCached && Date.now() - uvxCached.at < UVX_TTL_MS) return uvxCached.value
  // 过期/未就绪：后台刷新，本次先用旧值（首次=按不可用降级，下个会话生效）
  void probeUvxAsync().catch(() => {})
  return uvxCached?.value ?? false
}

let civitaiMcpPreWarmed = false
/** fire-and-forget 预热 uvx 包缓存：首次运行要拉 PyPI 包（秒级下载），
 * 不预热则 codex 起 MCP 握手可能超时。spawn error 或异常退出都复位标记，
 * 后续会话创建重试；成功退出（--help 帮助即退出）不复位。 */
export function preWarmCivitaiMcp(): void {
  if (civitaiMcpPreWarmed || !uvxAvailable()) return
  civitaiMcpPreWarmed = true
  try {
    const child = spawn('uvx', ['civitai-mcp-ultimate', '--help'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    })
    child.on('error', () => {
      civitaiMcpPreWarmed = false
    })
    // 非 0 退出（拉包失败/网络错误）也复位重试；0 = 预热成功
    child.on('exit', (code) => {
      if (code !== 0) civitaiMcpPreWarmed = false
    })
    child.unref()
  } catch {
    civitaiMcpPreWarmed = false
  }
}

export function civitaiMcpTomlLines(): string[] {
  // key 复用 LoRA Manager settings（civitai_api_key）：无 key 也能搜（NSFW 受限）
  const envPairs = [`"CIVITAI_API_KEY" = ${JSON.stringify(getCivitaiApiKey())}`]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
  if (proxy) envPairs.push(`"HTTPS_PROXY" = ${JSON.stringify(proxy)}`)
  return [
    `[mcp_servers.civitai]`,
    `command = "uvx"`,
    `args = ["civitai-mcp-ultimate"]`,
    `env = { ${envPairs.join(', ')} }`
  ]
}
