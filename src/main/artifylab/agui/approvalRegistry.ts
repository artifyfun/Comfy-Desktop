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
import { APPROVAL_WHITELIST_DEFAULT, createApprovalGate, type ApprovalGate } from './approvalGate'
import type { ToolRegistry } from '../mcp/tools'

/** /mcp 请求 → decide 会话身份(HTTP 层解析,CallTool handler 内读取;undefined = 外部无身份调用) */
export const mcpIdentityStorage = new AsyncLocalStorage<string | undefined>()

let gateSingleton: ApprovalGate | null = null

/** 审批门控单例(SSE notify 注册方与 interaction-response 端点必须共用) */
export function getApprovalGate(): ApprovalGate {
  if (!gateSingleton) {
    gateSingleton = createApprovalGate({ whitelist: [...APPROVAL_WHITELIST_DEFAULT] })
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
