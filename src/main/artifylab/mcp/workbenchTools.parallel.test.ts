import { describe, expect, it, beforeEach, vi } from 'vitest'

/**
 * wb_* 工具上下文「会话隔离」单测（C7 多会话并行的风险核心）。
 *
 * 现状（改动前）：workbenchTools.ts 用模块级单例 currentDecideSession 绑定
 * 「当前 decide 会话」——两个会话并行 decide 时 begin/end 相互覆盖，
 * wb_* 工具经 HTTP 回环 /mcp 时全部落在第一个 begin 的会话上（串号）。
 *
 * 本测试先红后绿：
 * - 红（单例实现）：带会话身份的工具调用全部解析到同一个（最先 begin 的）会话；
 * - 绿（Map 注册表 + 身份解析）：每个工具调用按身份（URL query wb_session /
 *   X-Workbench-Session header / 会话 id 字面量）各归各会话。
 *
 * mock 手法照 workbenchTools.test.ts（避开 settings.ts 导入链在 node 测试
 * 环境崩溃的坑；service/appStore/batchRunner 全 mock）。无 sleep，确定性断言。
 */

vi.mock('../workbench/service', () => {
  const sessions = new Map<string, { id: string }>([
    ['sA', { id: 'sA' }],
    ['sB', { id: 'sB' }],
    ['s1', { id: 's1' }]
  ])
  const listTemplatesCalls: Array<{ sessionId: string }> = []
  return {
    workbenchService: {
      getSession: vi.fn((id: string) => sessions.get(id) ?? null),
      listTemplates: vi.fn((sessionId: string) => {
        listTemplatesCalls.push({ sessionId })
        return []
      }),
      __listTemplatesCalls: listTemplatesCalls,
      __sessions: sessions
    }
  }
})

vi.mock('../appStore', () => ({
  default: {
    getConfig: () => ({ comfyHost: 'http://127.0.0.1:8188' })
  }
}))

// batchRunner 拖 electron 依赖（同 workbenchTools.test.ts 的处理），工具层只读 listBatchQueue
vi.mock('../services/batchRunner', () => ({
  listBatchQueue: () => []
}))

import { workbenchService } from '../workbench/service'
import {
  beginWorkbenchToolContext,
  endWorkbenchToolContext,
  resolveWorkbenchSessionFromRequest,
  createWorkbenchAugmentedRegistry,
  decideContextSizeForTest
} from './workbenchTools'

function decideContextSize(): number {
  return decideContextSizeForTest()
}

const mocked = workbenchService as unknown as {
  __listTemplatesCalls: Array<{ sessionId: string }>
}

/** 组合 registry。identity 是 C7 新增的第三参（请求身份），ToolRegistry 公开
 * 契约仍是两参（mcp/index.ts 冻结不可触碰），故此处局部放宽句柄类型直调。 */
function registry(): {
  handle: (name: string, args: Record<string, unknown>, identity?: string) => Promise<unknown>
} {
  return createWorkbenchAugmentedRegistry({
    list: () => [],
    handle: async () => ({}),
    sync: () => {}
  }) as unknown as {
    handle: (name: string, args: Record<string, unknown>, identity?: string) => Promise<unknown>
  }
}

/** 用 wb_list_templates 作探针：经 registry.handle 走一遍真实工具链，
 * 从 mock service 收到的 sessionId 反推 requireSession 的解析结果。
 * identity 模拟工具调用来源身份：codex 引擎按 config.toml 里每会话的
 * MCP server URL 回环（wb_session 融入 query），或将来接收侧接通后的 header。 */
async function probeSession(identity?: string): Promise<string> {
  mocked.__listTemplatesCalls.length = 0
  await registry().handle('wb_list_templates', {}, identity)
  const call = mocked.__listTemplatesCalls[0]
  if (!call) throw new Error('wb_list_templates did not reach the service')
  return call.sessionId
}

function mcpUrlFor(sessionId: string): string {
  return `http://127.0.0.1:3008/mcp?wb_session=${sessionId}`
}

beforeEach(() => {
  endWorkbenchToolContext('sA')
  endWorkbenchToolContext('sB')
  endWorkbenchToolContext('s1')
})

describe('wb_* 工具上下文会话隔离（C7 多会话并行）', () => {
  it('两个并发 decide（各自 begin）：带身份的工具调用各归各会话', async () => {
    beginWorkbenchToolContext('sA')
    beginWorkbenchToolContext('sB')
    // 两个 begin 都在册（并发 decide 的稳态），逐个探测身份路由
    expect(decideContextSize()).toBe(2)
    expect(await probeSession(mcpUrlFor('sA'))).toBe('sA')
    expect(await probeSession(mcpUrlFor('sB'))).toBe('sB')
  })

  it('A/B 工具调用交错（模拟引擎轮转发）不串号', async () => {
    beginWorkbenchToolContext('sA')
    beginWorkbenchToolContext('sB')
    mocked.__listTemplatesCalls.length = 0
    const r = registry()
    for (let i = 0; i < 3; i++) {
      await r.handle('wb_list_templates', {}, mcpUrlFor('sA'))
      await r.handle('wb_list_templates', {}, mcpUrlFor('sB'))
    }
    expect(mocked.__listTemplatesCalls.map((c) => c.sessionId)).toEqual([
      'sA',
      'sB',
      'sA',
      'sB',
      'sA',
      'sB'
    ])
  })

  it('X-Workbench-Session header 解析优先于 URL query（接收侧接线面）', () => {
    expect(
      resolveWorkbenchSessionFromRequest({ 'x-workbench-session': 'sA' }, mcpUrlFor('sB'))
    ).toBe('sA')
    expect(resolveWorkbenchSessionFromRequest({}, mcpUrlFor('sB'))).toBe('sB')
    // node http 头可能是 string[]
    expect(resolveWorkbenchSessionFromRequest({ 'x-workbench-session': ['sA'] })).toBe('sA')
    expect(resolveWorkbenchSessionFromRequest({}, mcpUrlFor('sB'))).toBe('sB')
    expect(resolveWorkbenchSessionFromRequest({}, undefined)).toBeNull()
    expect(resolveWorkbenchSessionFromRequest({})).toBeNull()
  })

  it('会话 id 字面量身份（无 URL）同样精确路由', async () => {
    beginWorkbenchToolContext('sA')
    beginWorkbenchToolContext('sB')
    expect(await probeSession('sA')).toBe('sA')
    expect(await probeSession('sB')).toBe('sB')
  })

  it('无身份调用保持旧语义：解析到最外层（最先 begin）的 decide 会话', async () => {
    beginWorkbenchToolContext('sA')
    beginWorkbenchToolContext('sB')
    expect(await probeSession(undefined)).toBe('sA')
  })

  it('decide 轮外（带或不带身份）均明确拒绝', async () => {
    await expect(registry().handle('wb_list_templates', {}, mcpUrlFor('sA'))).rejects.toThrow(
      /outside decide session/
    )
    await expect(registry().handle('wb_list_templates', {})).rejects.toThrow(
      /outside decide session/
    )
  })

  it('end 只清对应会话，其余会话不受影响', async () => {
    beginWorkbenchToolContext('sA')
    beginWorkbenchToolContext('sB')
    endWorkbenchToolContext('sA')
    expect(await probeSession(mcpUrlFor('sB'))).toBe('sB')
    await expect(probeSession(mcpUrlFor('sA'))).rejects.toThrow(/outside decide session/)
    // 无身份调用：默认槽在 sA end 后由 sB 接管
    expect(await probeSession(undefined)).toBe('sB')
  })
})
