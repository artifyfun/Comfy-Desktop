/**
 * MCP 工具注册表（底层 Server 方案：tools/list 返回 plain JSON Schema）。
 * 静态工具（公共）+ 动态工具（每个 app 一个 run__<id>）。
 */
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import appStoreManager from '../appStore'
import { buildAppToolInputSchema, describeParams } from './schema'
import { executeApp, getExecutionStatus, stopExecution, uploadMedia } from './executor'

const APP_TOOL_PREFIX = 'run__'

function comfyOrigin(): string {
  return appStoreManager.getConfig().comfyHost
}

function text(data: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }] }
}

export type ToolHandler = (args: Record<string, unknown>, identity?: string) => Promise<unknown>

export interface ToolRegistry {
  list(): Tool[]
  /** identity:decide 会话身份(C7),可选。门控/增强 registry 沿链透传,
   *  wb_* 工具据此路由到发起会话;无身份(外部 MCP 客户端)时工具内部
   *  回退旧单槽语义,行为与身份链引入前一致。 */
  handle(name: string, args: Record<string, unknown>, identity?: string): Promise<unknown>
  /** 重新读取 appStore 增量同步动态工具（由调用方在 change 后触发并 sendToolListChanged） */
  sync(): void
}

export function createToolRegistry(): ToolRegistry {
  const handlers = new Map<string, { tool: Tool; fn: ToolHandler }>()
  const add = (tool: Tool, fn: ToolHandler): void => {
    handlers.set(tool.name, { tool, fn })
  }

  // —— 静态工具（公共）——
  add(
    {
      name: 'list_apps',
      description: '列出所有 A UI app（id/name/description）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    async () =>
      text(
        appStoreManager
          .getAllApps()
          .map((a) => ({ id: a.id, name: a.name, description: a.description }))
      )
  )
  add(
    {
      name: 'get_app_details',
      description: '查看某 app 的详情与参数 schema',
      inputSchema: {
        type: 'object',
        properties: { app_id: { type: 'string' } },
        required: ['app_id'],
        additionalProperties: false
      }
    },
    async (args) => {
      const app = appStoreManager.getAppById(String(args.app_id))
      if (!app) return text({ error: 'app not found' })
      return text({
        id: app.id,
        name: app.name,
        description: app.description,
        params: describeParams(app.template?.paramsNodes)
      })
    }
  )
  add(
    {
      name: 'get_execution_status',
      description: '查询执行状态（success/running）与产物。run__<app> 返回 prompt_id 后用它轮询。',
      inputSchema: {
        type: 'object',
        properties: { prompt_id: { type: 'string' } },
        required: ['prompt_id'],
        additionalProperties: false
      }
    },
    async (args) => text(await getExecutionStatus(comfyOrigin(), String(args.prompt_id)))
  )
  add(
    {
      name: 'stop_execution',
      description: '中断当前 ComfyUI 执行（POST /interrupt）',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false }
    },
    async () => {
      await stopExecution(comfyOrigin())
      return text({ stopped: true })
    }
  )
  add(
    {
      name: 'upload_image',
      description: '上传图片/音频/视频到 ComfyUI，返回 {name,subfolder,type}',
      inputSchema: {
        type: 'object',
        properties: { data_url: { type: 'string', description: 'base64 data URL 或 http URL' } },
        required: ['data_url'],
        additionalProperties: false
      }
    },
    async (args) => text(await uploadMedia(comfyOrigin(), String(args.data_url)))
  )

  // —— 动态工具（每个 app 一个）——
  const sync = (): void => {
    const apps = appStoreManager.getAllApps()
    const seen = new Set<string>()
    for (const app of apps) {
      const name = `${APP_TOOL_PREFIX}${app.id}`
      seen.add(name)
      // 总是重建：app 编辑后 description / paramsNodes schema 可能变（H3，不能因已存在就跳过）
      const tool: Tool = {
        name,
        description: app.description || app.name || '执行 app',
        // schema.ts 用宽 JsonSchema 类型（properties 值 unknown），MCP Tool 要求 object；结构匹配，cast 安抚类型检查
        inputSchema: buildAppToolInputSchema(
          app.template?.paramsNodes
        ) as unknown as Tool['inputSchema']
      }
      const fn: ToolHandler = async (args) => text(await executeApp(app, args, comfyOrigin()))
      handlers.set(name, { tool, fn })
    }
    // 移除已删除的 app 工具
    for (const name of [...handlers.keys()]) {
      if (name.startsWith(APP_TOOL_PREFIX) && !seen.has(name)) handlers.delete(name)
    }
  }
  sync()

  return {
    list: () => [...handlers.values()].map((h) => h.tool),
    handle: async (name, args, _identity) => {
      // 底层静态/动态 app 工具不消费身份(仅 wb_* 需要);签名对齐接口的可选第三参
      const h = handlers.get(name)
      if (!h) throw new Error(`Unknown tool: ${name}`)
      return h.fn(args)
    },
    sync
  }
}
