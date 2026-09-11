/**
 * C-H2 wb_build_workflow —— 模板 → 画布工作流生成器（对标 RHTV「Agent 画布内
 * 自动建节点」，docs/research-canvas-agent-benchmark.md 建议 #2）。
 *
 * 职责：输入模板 id 列表 → 产出 canvasOps（add_app_node + connect_nodes +
 * select_nodes，网格自动布局）→ 经 canvasOpsBridge 直推 AG-UI SSE
 * （wb_canvas_ops CUSTOM，前端既有确认卡人审执行）。
 *
 * 布局算法：网格排列（每行 3 个，间距 360×260），与前端 Konva 画布的
 * 节点尺寸（约 320×180）对齐；链式依赖（用户给顺序语义）用 connect_nodes 串接。
 */

import type { CanvasAgentOp } from '../../workbench/plan'
import { workbenchService } from '../../workbench/service'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text } from './shared'

// ==================== SSE 桥（threadId → emit 注册表；run 生命周期注册/注销） ====================

type CanvasOpsEmit = (ops: CanvasAgentOp[], meta: { source: string }) => void

/** threadId → emit（routes/agui.ts run 开始时注册，结束注销；与 approvalGate 同生命周期模式） */
const emits = new Map<string, CanvasOpsEmit>()

export function registerCanvasOpsEmit(threadId: string, emit: CanvasOpsEmit): void {
  emits.set(threadId, emit)
}

export function unregisterCanvasOpsEmit(threadId: string): void {
  emits.delete(threadId)
}

/** 供测试注入/清空 */
export function clearCanvasOpsEmitsForTest(): void {
  emits.clear()
}

// ==================== 布局算法 ====================

/** 网格布局参数（与前端 app 节点渲染尺寸对齐：约 320×180 + 呼吸空间） */
const GRID_COLS = 3
const CELL_W = 360
const CELL_H = 240
const ORIGIN_X = 80
const ORIGIN_Y = 80

export interface BuiltWorkflow {
  ops: CanvasAgentOp[]
  placed: Array<{ appId: string; name: string; nodeId: string }>
  missing: string[]
}

/**
 * 模板 id 列表 → canvasOps。
 * - 每个 id 一个 add_app_node（网格坐标；会话变体 id 与库 id 同样接受）
 * - 多于 1 个时按顺序 connect_nodes 成链（A→B→C），并把全部节点 select_nodes
 *   （前端确认卡应用后用户视线直接落在成品上）
 */
export function buildCanvasOpsFromTemplateIds(
  sessionId: string,
  templateIds: string[]
): BuiltWorkflow {
  const placed: BuiltWorkflow['placed'] = []
  const missing: string[] = []
  const ops: CanvasAgentOp[] = []

  templateIds.forEach((rawId, index) => {
    const id = String(rawId ?? '').trim()
    if (!id) return
    const t = workbenchService.listTemplates(sessionId).find((x) => x.id === id)
    if (!t) {
      missing.push(id)
      return
    }
    // 节点 id 用确定性前缀（前端 applyCanvasAgentOps 生成自己的对象 id，
    // 这里的 id 仅用于 ops 间引用与 select 定位语义；前端 add 后按 name 匹配）
    const col = index % GRID_COLS
    const row = Math.floor(index / GRID_COLS)
    placed.push({
      appId: t.id,
      name: t.name || t.id,
      nodeId: `wf-${index}-${t.id.slice(-8)}`
    })
    ops.push({
      type: 'add_app_node',
      appId: t.id,
      name: t.name || t.id,
      x: ORIGIN_X + col * CELL_W,
      y: ORIGIN_Y + row * CELL_H
    })
  })

  // 链式连接（≥2 个成功放置时）：按输入顺序 A→B
  for (let i = 1; i < placed.length; i++) {
    const prev = placed[i - 1]
    const cur = placed[i]
    if (!prev || !cur) continue
    ops.push({ type: 'connect_nodes', from: `app:${prev.appId}`, to: `app:${cur.appId}` })
  }
  if (placed.length > 0) {
    ops.push({ type: 'select_nodes', ids: placed.map((p) => p.nodeId) })
  }

  return { ops, placed, missing }
}

// ==================== 工具定义 ====================

export const canvasTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_build_workflow',
      description:
        '把一个或多个模板一次性铺到 A 画布上：为每个模板生成一个 App 节点（网格自动布局），按给定顺序链式连接，经画布确认卡人审后落布。用户说「把这几个模板搭到画布上/搭一条工作流/组合这几个能力」时使用。返回放置清单；用户在画布上确认前不会真正执行。',
      inputSchema: {
        type: 'object',
        properties: {
          template_ids: {
            type: 'array',
            items: { type: 'string' },
            description: '模板 id 数组（wb_list_templates 里查；按工作流顺序给出）',
            minItems: 1,
            maxItems: 12
          },
          name_prefix: {
            type: 'string',
            description: '可选：节点名前缀（默认用模板名）'
          }
        },
        required: ['template_ids'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      const sessionId = requireSession(identity)
      const ids = (Array.isArray(args.template_ids) ? args.template_ids : []).map(String)
      if (ids.length === 0) return text({ ok: false, error: 'template_ids required (1~12)' })

      const built = buildCanvasOpsFromTemplateIds(sessionId, ids)
      if (built.placed.length === 0) {
        return text({ ok: false, error: 'no valid template', missing: built.missing })
      }

      const prefix = typeof args.name_prefix === 'string' ? args.name_prefix.trim() : ''
      const ops = prefix
        ? built.ops.map((op) =>
            op.type === 'add_app_node' ? { ...op, name: `${prefix}·${op.name ?? ''}` } : op
          )
        : built.ops

      // 直推 SSE（AG-UI run 活跃时）；不在 run 中（外部 MCP 客户端）返回 ops 由调用方自取
      const emit = emits.get(sessionId)
      if (emit) {
        emit(ops, { source: 'wb_build_workflow' })
        // spec 契约：铺画布后模型输出 intent=chat 总结 PLAN（不再触发整图同步）
        return text({
          ok: true,
          dispatched: true,
          nodes: built.placed.map((p) => ({ name: p.name, template_id: p.appId })),
          missing: built.missing,
          note: '已下发画布确认卡，用户确认后落布'
        })
      }
      return text({
        ok: true,
        dispatched: false,
        ops,
        nodes: built.placed.map((p) => ({ name: p.name, template_id: p.appId })),
        missing: built.missing,
        note: '当前无活跃画布会话通道，ops 原样返回（可经 wb_canvas_ops PLAN intent 下发）'
      })
    }
  }
]
