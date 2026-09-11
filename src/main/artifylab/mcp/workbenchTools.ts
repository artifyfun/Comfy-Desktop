/**
 * 工作台 MCP 工具（decide agent 的编排抓手，dsh 同款"agent 带工具自主跑"语义）。
 *
 * 候选②批一：13 个 wb_* 工具按域拆到 mcp/wbtools/ 下 5 个文件
 * （shared 上下文注册表 / template / workflow / lifecycle / knowledge），
 * 本文件只做注册表合并与导出装配。工具实现与安全边界不变：
 * - execute 前强制 validatePlanLocal（与 decide 快路径同一套白名单校验）；
 * - 会话归属由 decideSessions 注册表限定（C7 按请求身份精确路由）；
 * - 记忆工具同 workbench memory intent 语义（key 幂等，≤500 字）。
 */
import type { ToolRegistry } from './tools'
import { templateTools } from './wbtools/templateTools'
import { workflowTools } from './wbtools/workflowTools'
import { lifecycleTools } from './wbtools/lifecycleTools'
import { knowledgeTools } from './wbtools/knowledgeTools'
import { canvasTools } from './wbtools/canvasTools'

export {
  beginWorkbenchToolContext,
  endWorkbenchToolContext,
  decideContextSizeForTest,
  peekWorkbenchToolSession,
  resolveWorkbenchSessionFromRequest
} from './wbtools/shared'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './wbtools/shared'

const WB_TOOLS: Array<{ tool: Tool; fn: WBToolFn }> = [
  ...templateTools,
  ...workflowTools,
  ...lifecycleTools,
  ...knowledgeTools,
  ...canvasTools
]

/** 仅外部 MCP 客户端可见的 app 工具（与 wb_* 功能重叠，ListTools 按身份过滤） */
export const EXTERNAL_ONLY_TOOL_NAMES = new Set([
  'list_apps',
  'get_app_details',
  'get_execution_status',
  'stop_execution',
  'upload_image'
])

export function createWorkbenchAugmentedRegistry(base: ToolRegistry): ToolRegistry {
  return {
    list: () => [...base.list(), ...WB_TOOLS.map((w) => w.tool)],
    handle: async (name, args, identity?: string) => {
      const wb = WB_TOOLS.find((w) => w.tool.name === name)
      if (wb) return wb.fn(args ?? {}, identity)
      return base.handle(name, args)
    },
    sync: () => base.sync()
  }
}
