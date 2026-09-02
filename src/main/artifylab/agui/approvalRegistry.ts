/**
 * C14×C7 集成桥:审批门控单例 + MCP registry 门控包装 + HTTP 身份上下文。
 *
 * - getApprovalGate():模块级单例——routes/agui.ts(SSE notify 注册)与
 *   server.ts(交互应答端点)必须共享同一实例,pending 才能端到端闭环。
 * - mcpIdentityStorage:AsyncLocalStorage 把 /mcp HTTP 层解析出的会话身份
 *   (X-Workbench-Session header / wb_session query,F 线 C7 通道)带进
 *   CallToolRequestSchema handler——该 handler 拿不到原始 HTTP 请求,
 *   registry.handle 的身份参数因此经 ALS 传递。
 * - createApprovalGatedRegistry:在 workbench 增强 registry 外包一层门控——
 *   带身份 + 白名单工具(wb_execute_template / wb_run_workflow / wb_publish_workflow)
 *   前置 gate.intercept;reject/超时返回 isError 合成拒绝文本(waa 语义:
 *   拒绝原因注入上下文,模型自行改道),approve 时用(可能被 edit 替换的)args 执行。
 *   无身份调用(外部 MCP 客户端)完全直通——审批只约束 decide 链路内的工具执行。
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import {
  APPROVAL_MODE_DEFAULT,
  createApprovalGate,
  type ApprovalGate,
  type ToolRiskTier
} from './approvalGate'
import type { ToolRegistry } from '../mcp/tools'

/** /mcp 请求 → decide 会话身份(HTTP 层解析,CallTool handler 内读取;undefined = 外部无身份调用) */
export const mcpIdentityStorage = new AsyncLocalStorage<string | undefined>()

/**
 * B1 工具风险级表(全量 wb_* 12 工具接线默认策略):
 * - read    :只读查询/校验 → 永不弹卡(低危自动放行;wb_set_node_params 是「校验
 *             不执行」的误命名只读工具,归 read)。
 * - write   :本地写(会话模板变体/长期记忆)→ conservative 弹卡、standard 自动。
 * - execute :真实执行/外部副作用(提交 ComfyUI、直跑 workflow、固化全局 App)→ 两档都弹卡。
 * 未收录工具走 whitelist 兼容降级(read),不破坏既有语义。
 */
export const APPROVAL_TOOL_TIERS: Record<string, ToolRiskTier> = {
  // —— read:查询/校验,任何模式自动放行 ——
  wb_list_templates: 'read',
  wb_list_nodes: 'read',
  wb_set_node_params: 'read',
  wb_validate_workflow: 'read',
  wb_poll_execution: 'read',
  wb_get_outputs: 'read',
  // —— write:本地写(进程内会话数据),conservative 弹卡 ——
  wb_clone_template: 'write',
  wb_remember: 'write',
  wb_forget: 'write',
  // —— execute:真实执行/外部副作用,两档都弹卡 ——
  wb_execute_template: 'execute',
  wb_run_workflow: 'execute',
  wb_publish_workflow: 'execute'
}

let gateSingleton: ApprovalGate | null = null

/** 审批门控单例(SSE notify 注册方与 interaction-response 端点必须共用) */
export function getApprovalGate(): ApprovalGate {
  if (!gateSingleton) {
    gateSingleton = createApprovalGate({
      tiers: { ...APPROVAL_TOOL_TIERS },
      // 默认 standard = 与 C14 白名单语义等价(execute 弹卡、read/write 自动)——
      // 红线:门控升级不改变未显式选择模式的既有会话行为。
      defaultMode: APPROVAL_MODE_DEFAULT
    })
  }
  return gateSingleton
}

/** 测试用:重置单例(生产代码禁止调用) */
export function resetApprovalGateForTest(): void {
  gateSingleton = null
}

/**
 * 门控 registry 包装。白名单判断在 gate.intercept 内部(白名单外同步直通),
 * 这里只负责「无身份 → 完全直通」与「拒绝 → 合成错误文本」两个边界。
 */
export function createApprovalGatedRegistry(inner: ToolRegistry, gate: ApprovalGate): ToolRegistry {
  return {
    list: () => inner.list(),
    handle: async (name, args) => {
      const threadId = mcpIdentityStorage.getStore()
      // 无身份(外部 MCP 客户端)→ 完全直通,不传身份(保持旧单槽语义,零行为变化)
      if (!threadId) return inner.handle(name, args)
      const result = await gate.intercept(threadId, name, args)
      if (!result.approved) {
        return {
          content: [
            {
              type: 'text',
              text: `用户拒绝执行工具 ${name}。不要重复调用该工具;改用其他方式完成任务,或向用户说明需要该操作的原因并等待用户主动发起。`
            }
          ],
          isError: true
        }
      }
      // 身份必须沿链透传(C7):门控放行后把 threadId 交给增强 registry,
      // wb_* 工具的 requireSession 据此路由回发起会话——丢这一跳则并发
      // 会话时工具串到「最先 begin」的会话上执行(审批在 sB、执行落 sA)。
      return inner.handle(name, result.args ?? args ?? {}, threadId)
    },
    sync: () => inner.sync()
  }
}
