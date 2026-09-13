/**
 * 创作资产工具（对标建议 #4）——wb_assets 单工具多动作。
 *
 * 设计取舍：资产是**用户级全局资源**（跨会话/跨模板复用），故不要求会话身份
 * （对比 wb_execute_template 必须落在 decide 会话内）。审批定级见
 * agui/approvalRegistry.ts（含 save/remove 写操作 → 'write'）。
 *
 * 典型编排（对齐 RHTV 角色资产设定表）：
 *   1) 用户给角色设定 → wb_assets action=save kind=character refs=[图] seed=123
 *   2) 后续任意生成 → wb_execute_template asset_ids=["小美"]（名字解析）
 *      → 参考图自动落素材槽、seed 自动填、LoRA 触发词自动并参
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { text } from './shared'
import { ASSET_KINDS, assetsStore, type AssetInput } from '../../workbench/assetsStore'

/** 精简列表视图（模型选型够用；完整 params 走 action=get） */
function summarize(a: {
  id: string
  name: string
  kind: string
  refs: string[]
  seed?: number
  params: Record<string, unknown>
  updatedAt: string
}) {
  return {
    id: a.id,
    name: a.name,
    kind: a.kind,
    refs_count: a.refs.length,
    seed: a.seed ?? null,
    params_keys: Object.keys(a.params),
    updated_at: a.updatedAt
  }
}

/** 参数别名归一（模型实测混用 snake/camel） */
function pickKey(args: Record<string, unknown>): string {
  const raw = args.id ?? args.asset_id ?? args.assetId ?? args.name ?? args.key
  return raw == null ? '' : String(raw).trim()
}

export const assetTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_assets',
      description:
        '创作资产库（角色/风格/道具的一致性锚点）：把「参考图组 + 固定 seed + 参数（LoRA 触发词等）」登记为可复用对象。此后任意生成用 wb_execute_template 的 asset_ids 引用（可写资产名或 id），参考图与 seed 会自动挂载到模板——多张图保持同一角色/风格时用它，而不是每次重新贴图。action=list 看全部、get 看详情、save 新建或更新、remove 删除。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['list', 'get', 'save', 'remove'],
            description: 'list=列全部；get=按 id/name 查详情；save=新建或更新；remove=删除'
          },
          id: {
            type: 'string',
            description: '资产 id（save 时提供=更新该资产；get/remove 可只给 id）'
          },
          name: {
            type: 'string',
            description: '资产名（人类可读；get/remove 可用名字定位；save 新建时必填）'
          },
          kind: {
            type: 'string',
            enum: [...ASSET_KINDS],
            description: '资产类型：character=角色 / style=风格 / prop=道具 / other'
          },
          refs: {
            type: 'array',
            items: { type: 'string' },
            description:
              '参考图组（已上传文件名或 http(s)/data URL），按序对应模板素材槽；多张=多参考'
          },
          seed: {
            type: 'number',
            description: '固定种子（模板有 seed 参数时自动填，保证跨轮可复现）'
          },
          params: {
            type: 'object',
            description: '附加模板参数（如 LoRA 触发词、固定风格参数）；用户显式 params 优先于这里',
            additionalProperties: true
          },
          notes: { type: 'string', description: '备注（用途/来源，供人或模型回顾）' }
        },
        required: ['action'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args) => {
      const action = String(args.action ?? '').trim()

      if (action === 'list') {
        const items = assetsStore.list()
        return text({ ok: true, total: items.length, assets: items.map(summarize) })
      }

      if (action === 'get') {
        const key = pickKey(args)
        if (!key) return text({ ok: false, error: 'get 需要 id 或 name' })
        const asset = assetsStore.resolve(key)
        if (!asset)
          return text({ ok: false, error: `未找到资产：${key}`, hint: '可用 action=list 查看全部' })
        return text({ ok: true, asset })
      }

      if (action === 'save') {
        const input: AssetInput = {
          ...(args.id != null ? { id: String(args.id) } : {}),
          ...(args.name != null ? { name: String(args.name) } : {}),
          ...(args.kind != null ? { kind: String(args.kind) } : {}),
          ...(args.refs !== undefined ? { refs: args.refs } : {}),
          ...(args.seed !== undefined ? { seed: args.seed } : {}),
          ...(args.params !== undefined ? { params: args.params } : {}),
          ...(args.notes !== undefined ? { notes: String(args.notes) } : {})
        }
        try {
          const { asset, created, issues } = assetsStore.save(input)
          return text({
            ok: issues.length === 0,
            created,
            id: asset.id,
            name: asset.name,
            kind: asset.kind,
            refs_count: asset.refs.length,
            seed: asset.seed ?? null,
            params_keys: Object.keys(asset.params),
            issues
          })
        } catch (e) {
          return text({ ok: false, error: e instanceof Error ? e.message : String(e) })
        }
      }

      if (action === 'remove') {
        const key = pickKey(args)
        if (!key) return text({ ok: false, error: 'remove 需要 id 或 name' })
        const asset = assetsStore.resolve(key)
        if (!asset) return text({ ok: false, error: `未找到资产：${key}` })
        const removed = assetsStore.remove(asset.id)
        return text({ ok: removed, removed_id: asset.id, removed_name: asset.name })
      }

      return text({
        ok: false,
        error: `未知 action：${action || '(空)'}`,
        allowed: ['list', 'get', 'save', 'remove']
      })
    }
  }
]
