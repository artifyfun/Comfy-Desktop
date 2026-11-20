import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text } from './shared'
import {
  searchModelKnowledge,
  modelKnowledgeDetail,
  searchCivitaiModels
} from '../../workbench/modelKnowledge'

import { workbenchService } from '../../workbench/service'

export const knowledgeTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_remember',
      description:
        '写入/更新跨会话长期记忆（key 幂等；value ≤500 字）。用于沉淀用户偏好、硬件信息等。',
      inputSchema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: '短标签键，如 preferred-style' },
          value: { type: 'string', description: '记忆内容，≤500 字' }
        },
        required: ['key', 'value'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const key = String(args.key ?? '').trim()
      const value = String(args.value ?? '')
      if (!key) return text({ ok: false, error: 'key required' })
      if (!value || value.length > 500)
        return text({ ok: false, error: 'value required, ≤500 chars' })
      workbenchService.rememberMemory(key, value)
      return text({ ok: true, key })
    }
  },
  {
    tool: {
      name: 'wb_forget',
      description: '删除跨会话长期记忆（按 key）。',
      inputSchema: {
        type: 'object',
        properties: { key: { type: 'string' } },
        required: ['key'],
        additionalProperties: false
      },
      annotations: { readOnlyHint: false, destructiveHint: true }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const key = String(args.key ?? '').trim()
      const ok = key ? workbenchService.forgetMemory(key) : false
      return text({ ok, key })
    }
  },
  {
    tool: {
      name: 'wb_query_models',
      description:
        '查询模型知识与 civitai 在线搜索。action=search 搜本机清单（LoRA Manager 的 civitai 元数据：触发词/用法提示/备注），action=detail 按文件名查单模型详情+官方示例提示词，action=civitai 在线搜索 civitai 模型（触发词/版本 id/热度/页面链接，需网络）。选模型没把握、不知道某 lora 的触发词怎么写、想参考高质量示例提示词、或用户要找本机没有的模型时先调它。',
      inputSchema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'detail', 'civitai'],
            description: 'search=搜本机清单（默认）；detail=单模型详情；civitai=在线搜索'
          },
          type: {
            type: 'string',
            enum: ['loras', 'checkpoints', 'embeddings'],
            description: '模型类型，默认 loras'
          },
          query: {
            type: 'string',
            description: 'action=search/civitai：关键词（civitai 支持英文/空格分词）'
          },
          file: {
            type: 'string',
            description: 'action=detail：模型文件名（或相对路径，支持部分匹配）'
          },
          base_model: {
            type: 'string',
            description:
              'action=civitai：按基模过滤，逗号分隔，如 "Illustrious,Pony"（Flux 装不上 SDXL 的 lora，务必过滤）'
          },
          sort: {
            type: 'string',
            enum: ['Most Downloaded', 'Highest Rated', 'Newest'],
            description: 'action=civitai：排序，默认 Most Downloaded'
          },
          nsfw: {
            type: 'boolean',
            description: 'action=civitai：包含 NSFW（默认 true；false 仅 SFW）'
          },
          limit: { type: 'number', description: '返回条数上限，默认 10-15，civitai 上限 20' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const action =
        args.action === 'detail' ? 'detail' : args.action === 'civitai' ? 'civitai' : 'search'
      try {
        if (action === 'detail') {
          const file = String(args.file ?? '').trim()
          if (!file) return text({ ok: false, error: 'action=detail 需要 file 参数' })
          return text(await modelKnowledgeDetail(file, args.type as string))
        }
        if (action === 'civitai') {
          const query = String(args.query ?? '').trim()
          if (!query) return text({ ok: false, error: 'action=civitai 需要 query 参数' })
          const typeMap: Record<string, string> = {
            loras: 'LORA',
            checkpoints: 'Checkpoint',
            embeddings: 'TextualInversion'
          }
          const result = await searchCivitaiModels({
            query,
            type: typeMap[String(args.type ?? 'loras')] ?? 'LORA',
            baseModels: args.base_model
              ? String(args.base_model)
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean)
              : undefined,
            sort: args.sort ? String(args.sort) : undefined,
            nsfw: args.nsfw === false ? false : true,
            limit: typeof args.limit === 'number' ? args.limit : 10
          })
          if (!result.ok)
            return text({
              ...result,
              hint: 'civitai 不可达（网络/镜像）时不影响其它流程'
            })
          return text(result)
        }
        return text(
          await searchModelKnowledge(
            args.type as string,
            args.query ? String(args.query) : undefined,
            typeof args.limit === 'number' ? args.limit : 15
          )
        )
      } catch (e) {
        return text({
          ok: false,
          error: e instanceof Error ? e.message : String(e),
          hint: 'LoRA Manager 未运行或未安装时不可用；不影响其它流程'
        })
      }
    }
  }
]
