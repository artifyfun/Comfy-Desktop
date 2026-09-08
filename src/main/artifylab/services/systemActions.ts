/**
 * 系统级动作——webhook 通知与系统关机（单一事实源）。
 *
 * 从 routes/proxy.ts 抽出（候选 ③）：/api/notify 与 /api/shutdown 的核心
 * 逻辑此前只能经 HTTP 自环调用（batchRunner fetch localhost:3008），端口
 * 未就绪/占用时静默丢通知。现在路由处理器与 batchRunner 共用同一进程内
 * 函数——SSRF 防护/平台分支/重试语义只有一份。
 */
import { exec } from 'node:child_process'
import { platform } from 'node:os'
import { logger } from '../utils/logger'
import { fetchWithRetry } from '../utils/fetch'

export interface WebhookNotification {
  url: string
  title: string
  body: string
}

/**
 * 发完成通知（Bark / Telegram / 通用 webhook）。
 * 返回 http status；校验失败返回 { error }。SSRF 防护：拒绝私网/环回/
 * 链路本地；redirect:'manual' 防止 302 跳内网绕过校验。
 */
export async function sendWebhookNotification(
  payload: WebhookNotification
): Promise<{ status: number } | { error: string }> {
  const url = String(payload.url || '').trim()
  const title = String(payload.title || '').slice(0, 200)
  const bodyText = String(payload.body || '').slice(0, 2000)
  if (!/^https:\/\//i.test(url)) {
    return { error: 'url must be a valid https webhook' }
  }
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return { error: 'invalid url' }
  }
  // SSRF 防护：拒绝私网/环回/链路本地地址
  const hostname = parsed.hostname.toLowerCase()
  const ipv4 = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/)
  if (
    hostname === 'localhost' ||
    hostname === '[::1]' ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    (ipv4 &&
      (ipv4[1] === '127' ||
        ipv4[1] === '10' ||
        (ipv4[1] === '172' && Number(ipv4[2]) >= 16 && Number(ipv4[2]) <= 31) ||
        (ipv4[1] === '192' && ipv4[2] === '168') ||
        (ipv4[1] === '169' && ipv4[2] === '254') ||
        ipv4[1] === '0'))
  ) {
    return { error: 'private network addresses are not allowed' }
  }
  let resp: Response
  // redirect: 'manual' 防止 302 跳转到 http/内网地址绕过上面的校验
  const noRedirect = { redirect: 'manual' as const }
  if (parsed.pathname.includes('/sendMessage')) {
    // Telegram Bot API
    resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: `${title}\n${bodyText}`.trim() }),
      ...noRedirect
    })
  } else if (parsed.hostname === 'api.day.app' || parsed.hostname === 'api.bark.app') {
    // Bark：路径拼接（encodeURIComponent）
    const barkUrl = `${parsed.origin}${parsed.pathname}/${encodeURIComponent(title)}/${encodeURIComponent(bodyText || 'done')}`
    resp = await fetchWithRetry(barkUrl, { method: 'GET', ...noRedirect })
  } else {
    // 通用 webhook（server酱 / 飞书 / 钉钉等）
    resp = await fetchWithRetry(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, body: bodyText }),
      ...noRedirect
    })
  }
  return { status: resp.status }
}

export interface ShutdownOptions {
  /** 延迟秒数（0-3600） */
  delay: number
  /** Windows 强制关机 */
  force: boolean
}

/**
 * 调度系统关机。平台分支（win32/darwin/linux）+ 参数校验。
 * 返回 null=成功发起；{ error }=校验失败/权限错误。
 */
export function scheduleSystemShutdown(
  opts: ShutdownOptions
): { started: true } | { error: string } {
  const { delay = 0, force = false } = opts
  if (delay < 0 || delay > 3600) {
    return { error: 'Delay must be between 0 and 3600 seconds' }
  }
  const currentPlatform = platform()
  let shutdownCommand: string
  switch (currentPlatform) {
    case 'win32': {
      const forceFlag = force ? '/f' : ''
      const delayFlag = delay > 0 ? `/t ${delay}` : ''
      shutdownCommand = `shutdown /s ${forceFlag} ${delayFlag}`.trim()
      break
    }
    case 'darwin':
      shutdownCommand =
        delay > 0 ? `sudo shutdown -h +${Math.ceil(delay / 60)}` : 'sudo shutdown -h now'
      break
    case 'linux':
      shutdownCommand =
        delay > 0 ? `sudo shutdown -h +${Math.ceil(delay / 60)}` : 'sudo shutdown -h now'
      break
    default:
      return { error: `Unsupported operating system: ${currentPlatform}` }
  }
  logger.info('Executing shutdown command', {
    platform: currentPlatform,
    command: shutdownCommand,
    delay,
    force
  })
  exec(shutdownCommand, (error, _stdout, stderr) => {
    if (error) {
      logger.error('Shutdown command failed', {
        error: error.message,
        stderr,
        platform: currentPlatform
      })
      return
    }
    logger.info('Shutdown command executed')
  })
  return { started: true }
}
