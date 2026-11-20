/**
 * 外部 agent 传输注册表 —— 声明式通道定义(对齐 OpenDesign runtimes/defs 模式,
 * 见 docs/research-external-agent-integration.md §5.1)。
 *
 * 每个外部通道一个 def:纯数据(id/描述/二进制要求)+ 工厂(create)。新增一个
 * 外部通道 = 在 EXTERNAL_TRANSPORTS 加一个 def,agentRuntime 的选择/驱动/
 * 回收零改动。
 *
 * 现有条目:
 * - acp   : Agent Client Protocol host(40+ agent 生态,二进制必填)
 * - claude: Claude Code CLI stream-json(二进制缺省 'claude' 走 PATH)
 *
 * 内置通道(exec/appserver)走 codex 专用管线,不经此注册表——它们没有
 * 「外部二进制」概念,语义不同;注册表只收敛「外部子进程 agent」家族。
 */
import { createAcpRuntime, type AcpRuntime, type AcpMcpServerInput } from '../agui/acp/transport'
import { createClaudeRuntime, type ClaudeRuntime } from '../agui/claude/transport'
import { getApprovalGate } from '../agui/approvalRegistry'
import type { AGUIEvent } from '../agui/types'

/** 外部通道运行时的最小公共面:startTurn + dispose(两个实现同构) */
export type ExternalAgentRuntime = AcpRuntime | ClaudeRuntime

/** 单 turn 驱动输出帧(ACP/Claude 同构:event 即 AG-UI 事件,deltas 恒空) */
export type ExternalRunFrame = { event: AGUIEvent | null; deltas: never[] }

/** 会话上下文(工厂入参——由 agentRuntime 统一装配) */
export interface ExternalTransportContext {
  /** AG-UI threadId(= workbench sessionId) */
  sessionId: string
  /** 进程环境(主进程 env 透传) */
  env: NodeJS.ProcessEnv
  /** 已解析的外部二进制(requiresBin 时由 resolveBin 保证非空) */
  binary: string
  /**
   * 工作台 wb_* MCP server 描述(http 回环端点 + 会话身份)。
   * 缺省/undefined = MCP 不可用,通道优雅降级(外部 agent 无工作台工具)。
   * 仅支持 MCP server 注入的通道消费(acp);claude CLI 无此面,忽略。
   */
  workbenchMcpServer?: AcpMcpServerInput
}

export interface ExternalTransportDef {
  /** 通道 id(settings.workbenchAgentTransport 的合法值之一) */
  id: 'acp' | 'claude'
  /** 通道显示名(日志/报错用) */
  label: string
  /** 二进制是否必填(acp: 是——没有合理缺省;claude: 否——缺省走 PATH) */
  requiresBin: boolean
  /** 二进制缺省值(requiresBin=false 时使用) */
  defaultBin?: string
  /** 二进制未配置时的报错指引(供 agentRuntime 抛错) */
  missingBinHint?: string
  /** 运行时工厂 */
  create(ctx: ExternalTransportContext): Promise<ExternalAgentRuntime>
}

export const EXTERNAL_TRANSPORTS: readonly ExternalTransportDef[] = [
  {
    id: 'acp',
    label: 'ACP 通用协议',
    requiresBin: true,
    missingBinHint:
      'ACP 通道未配置 agent 二进制:请在 设置 → 外部 Agent 接入 中填写(如 "kimi" / "/usr/local/bin/qwen")',
    create: (ctx) =>
      createAcpRuntime({
        binary: ctx.binary,
        args: [],
        env: ctx.env,
        threadId: ctx.sessionId,
        runId: ctx.sessionId,
        approvalGate: getApprovalGate(),
        // wb_* 工具面注入(session/new 带 http 回环端点 + bearer/会话身份
        // headers);MCP 不可用时 undefined → 空数组,外部 agent 降级纯对话
        ...(ctx.workbenchMcpServer ? { mcpServers: [ctx.workbenchMcpServer] } : {})
      })
  },
  {
    id: 'claude',
    label: 'Claude Code',
    requiresBin: false,
    defaultBin: 'claude',
    create: (ctx) =>
      createClaudeRuntime({
        binary: ctx.binary,
        env: ctx.env,
        threadId: ctx.sessionId,
        runId: ctx.sessionId
      })
  }
]

/** 按 id 查 def;未知 id 返回 null(调用方决定回退) */
export function findExternalTransport(id: string): ExternalTransportDef | null {
  return EXTERNAL_TRANSPORTS.find((d) => d.id === id) ?? null
}

/**
 * 解析外部二进制:requiresBin 且空值时抛带指引的错(missingBinHint);
 * 否则返回 trim 后的二进制(defaultBin 兜底)。
 */
export function resolveExternalBin(def: ExternalTransportDef, rawBin: string): string {
  const bin = rawBin.trim()
  if (def.requiresBin && !bin) {
    throw new Error(def.missingBinHint ?? `${def.label} 通道未配置 agent 二进制`)
  }
  return bin || def.defaultBin || ''
}
