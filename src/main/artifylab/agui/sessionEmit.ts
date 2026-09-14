/**
 * 会话级 AG-UI 事件通道（SSE 桥）注册表。
 *
 * 为什么要抽共享：工具层（MCP 回环）在 run 生命周期内需要把事件推给前端，但
 * 它拿不到 SSE 的 res。做法是路由层在 run 开始时注册 emit、结束时注销
 * （见 `routes/agui.ts`），工具层按会话 id 取用。原先这张表是 planTools 私有的，
 * 现在至少有两个工具域要用同一条通道：
 *   - `planTools`（wb_propose_plan 计划卡 / 拍板）
 *   - `wbtools/shared`（wb_execute_template wait 模式的生成过程预览 #5）
 *
 * **必须单表**：同一会话只有一条 SSE 流，各自维护一张表会让后注册者覆盖前者。
 *
 * 无通道时（外部 MCP 客户端直调、单测）`emitSessionCustom` 返回 false 而不抛错——
 * 调用方据此降级（对齐 planTools「无 SSE 通道则不挂起直接返回」的既有语义）。
 */
import type { AGUIEvent } from './types'

export type SessionEmit = (event: AGUIEvent) => void

const emits = new Map<string, SessionEmit>()

/** run 开始时注册（routes/agui.ts） */
export function registerSessionEmit(sessionId: string, emit: SessionEmit): void {
  emits.set(sessionId, emit)
}

/** run 结束/异常时注销 */
export function unregisterSessionEmit(sessionId: string): void {
  emits.delete(sessionId)
}

/** 仅测试可见：清空注册表 */
export function clearSessionEmitsForTest(): void {
  emits.clear()
}

/** 取该会话的 emit 通道（undefined = 无 SSE 通道） */
export function sessionEmitFor(sessionId: string): SessionEmit | undefined {
  return emits.get(sessionId)
}

/** 推一条 CUSTOM 事件；返回是否推送成功（无通道 → false） */
export function emitSessionCustom(sessionId: string, name: string, value: unknown): boolean {
  const emit = emits.get(sessionId)
  if (!emit) return false
  emit({ type: 'CUSTOM', name, value } as AGUIEvent)
  return true
}
