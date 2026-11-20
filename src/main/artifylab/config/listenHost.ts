/**
 * server 监听地址解析（Phase 0 安全加固）。
 *
 * 历史问题：`app.listen(port)` 未指定 host = 绑 0.0.0.0，整个 A UI server
 * （含需要 Bearer token 的 /mcp）暴露在局域网，与 mcp-server-usage.md 声称的
 * "仅监听本机回环"不符。
 *
 * 现行为：默认 127.0.0.1；config.listenHost 显式配置（如 '0.0.0.0'）可放开。
 * 纯函数无副作用，独立成模块以便单测（server.ts 顶层有静态资源初始化，不宜被测试导入）。
 */

export const DEFAULT_LISTEN_HOST = '127.0.0.1'

/** 从 appStore config 解析监听地址；缺省/非法值回退回环。 */
export function resolveListenHost(config: Record<string, unknown> | null | undefined): string {
  const v = config?.listenHost
  if (typeof v === 'string' && v.trim()) return v.trim()
  return DEFAULT_LISTEN_HOST
}

/** 是否回环地址（用于日志提示：非回环监听时告警 token 暴露面）。 */
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1'
}
