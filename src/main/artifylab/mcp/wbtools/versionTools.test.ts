// @vitest-environment node
/**
 * wb_app_versions 测试（模板版本历史）。
 *
 * 关注点：定位口径（app_id / 唯一同名 / 同名多个拒绝）、三种 action 的语义、
 * 当前生效版本不在快照表这一事实要说清楚，以及**恢复只回写可变字段**
 * （id/createdAt 由 store 维护，绝不能被快照覆盖）。
 * appStore 与 appAssets 全部替换为内存实现，不碰真实 gallery.db。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'

type Snap = Record<string, unknown>

const h = vi.hoisted(() => ({
  apps: [] as Array<{ id: string; name: string }>,
  byId: new Map<string, { id: string; name: string }>(),
  snapshots: new Map<string, Map<number, Snap>>(),
  current: new Map<string, number>(),
  updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
  updateReturnsNull: false
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir(), getAppPath: () => '' } }))
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
// shared.ts → workbench/service 的加载链会绕回 mcp/index → workbenchTools →
// wbtools（循环依赖，本模块初始化时导出为 undefined）。按 assetTools.test 的既有
// 隔离手法切断 service / batchRunner 两个重模块（appStore 下面按需替换）。
vi.mock('../../workbench/service', () => ({
  workbenchService: { getSession: vi.fn((id: string) => (id ? { id } : null)) }
}))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

vi.mock('../../appStore', () => ({
  default: {
    getConfig: () => ({}),
    getAppById: (id: string) => h.byId.get(id),
    findAppsByName: (name: string) => h.apps.filter((a) => a.name === name),
    updateApp: (id: string, patch: Record<string, unknown>) => {
      h.updates.push({ id, patch })
      if (h.updateReturnsNull) return null
      // 忠实模拟真实 appStore.updateApp：覆盖前快照旧版 → 生效版本号 +1
      h.current.set(id, (h.current.get(id) ?? 1) + 1)
      return { id, name: patch.name ?? '未命名' }
    }
  }
}))

vi.mock('../../appAssets', () => ({
  listAppVersions: (appId: string) =>
    [...(h.snapshots.get(appId)?.keys() ?? [])]
      .sort((a, b) => b - a)
      .map((v) => ({ version: v, created_at: 1_700_000_000_000 + v, name: '历史版' })),
  getAppVersion: (appId: string, version: number) => h.snapshots.get(appId)?.get(version) ?? null,
  currentAppVersion: (appId: string) => h.current.get(appId) ?? 1
}))

import { versionTools } from './versionTools'

const tool = versionTools.find((t) => t.tool.name === 'wb_app_versions')!

function payload(res: unknown): Record<string, unknown> {
  return JSON.parse((res as { content: Array<{ text: string }> }).content[0]!.text) as Record<
    string,
    unknown
  >
}

/** 造一个模板：current 版 + 若干历史快照 */
function seedApp(
  id: string,
  name: string,
  opts: { current?: number; snapshotVersions?: number[]; template?: Snap } = {}
) {
  const current = opts.current ?? 1
  h.apps.push({ id, name })
  h.byId.set(id, { id, name })
  h.current.set(id, current)
  const snaps = new Map<number, Snap>()
  for (const v of opts.snapshotVersions ?? []) {
    snaps.set(v, {
      id, // 快照里带 id/createdAt：恢复时必须被过滤掉
      createdAt: 1,
      name: `旧名 v${v}`,
      description: `旧描述 v${v}`,
      template: opts.template ?? {
        prompt: { '1': {}, '2': {}, '3': {} },
        paramsNodes: [
          { name: 'prompt', category: 'input' },
          { name: 'seed', category: 'input' },
          { name: 'result', category: 'output' }
        ]
      }
    })
  }
  h.snapshots.set(id, snaps)
}

beforeEach(() => {
  h.apps.length = 0
  h.byId.clear()
  h.snapshots.clear()
  h.current.clear()
  h.updates.length = 0
  h.updateReturnsNull = false
})

describe('wb_app_versions action=list', () => {
  it('列出历史版本并回报当前生效版本号', async () => {
    seedApp('app-1', '模板A', { current: 4, snapshotVersions: [3, 2, 1] })

    const out = payload(await tool.fn({ action: 'list', app_id: 'app-1' }))

    expect(out.ok).toBe(true)
    expect(out.current_version).toBe(4)
    expect((out.versions as Array<{ version: number }>).map((v) => v.version)).toEqual([3, 2, 1])
  })

  it('从未迭代过 → 明确说明没有历史（当前即第 1 版）', async () => {
    seedApp('app-1', '模板A', { current: 1, snapshotVersions: [] })

    const out = payload(await tool.fn({ action: 'list', app_id: 'app-1' }))

    expect(out.ok).toBe(true)
    expect(out.count).toBe(0)
    expect(String(out.note)).toContain('第 1 版')
  })

  it('limit 生效', async () => {
    seedApp('app-1', '模板A', { current: 6, snapshotVersions: [5, 4, 3, 2, 1] })

    const out = payload(await tool.fn({ action: 'list', app_id: 'app-1', limit: 2 }))

    expect((out.versions as unknown[]).length).toBe(2)
  })
})

describe('wb_app_versions action=get', () => {
  it('给出该版摘要（节点数 / 可填输入参数 / 输出数）', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'get', app_id: 'app-1', version: 2 }))

    expect(out.ok).toBe(true)
    expect(out.version).toBe(2)
    expect(out.name).toBe('旧名 v2')
    expect(out.node_count).toBe(3)
    expect(out.input_params).toEqual(['prompt', 'seed'])
    expect(out.output_count).toBe(1)
  })

  it('查当前生效版本 → 说明它不在快照表里（避免误以为数据丢了）', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'get', app_id: 'app-1', version: 3 }))

    expect(out.ok).toBe(true)
    expect(out.current_version).toBe(3)
    expect(String(out.note)).toContain('当前生效版本')
  })

  it('版本不存在 → 报错并给出可用范围', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'get', app_id: 'app-1', version: 99 }))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('v1–v2')
  })

  it('缺 version → 报错', async () => {
    seedApp('app-1', '模板A', { current: 2, snapshotVersions: [1] })

    const out = payload(await tool.fn({ action: 'get', app_id: 'app-1' }))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('version')
  })
})

describe('wb_app_versions action=restore', () => {
  it('回滚：写入快照内容，且**只回写可变字段**（不得覆盖 id/createdAt）', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'restore', app_id: 'app-1', version: 2 }))

    expect(out.ok).toBe(true)
    expect(out.restored_from).toBe(2)
    expect(out.previous_version).toBe(3)
    expect(h.updates).toHaveLength(1)
    const patch = h.updates[0]!.patch
    expect(h.updates[0]!.id).toBe('app-1')
    expect(patch.name).toBe('旧名 v2')
    expect(patch.description).toBe('旧描述 v2')
    expect(patch.template).toBeTruthy()
    // 关键不变量：身份/创建时间由 store 维护，快照里的这些字段必须被过滤
    expect('id' in patch).toBe(false)
    expect('createdAt' in patch).toBe(false)
    expect('updatedAt' in patch).toBe(false)
  })

  it('回滚后给出「撤销本次回滚」的指引（回滚本身可再撤销）', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'restore', app_id: 'app-1', version: 2 }))

    // 回滚前是 v3，updateApp 又把它快照进来 → 生效版本升到 v4
    expect(out.previous_version).toBe(3)
    expect(out.current_version).toBe(4)
    expect(String(out.undo_hint)).toContain('version=3')
  })

  it('回滚到当前版本 → 拒绝且不写（无意义的写操作）', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })

    const out = payload(await tool.fn({ action: 'restore', app_id: 'app-1', version: 3 }))

    expect(out.ok).toBe(false)
    expect(h.updates).toHaveLength(0)
  })

  it('updateApp 返回 null（模板已不存在等）→ 如实报错', async () => {
    seedApp('app-1', '模板A', { current: 3, snapshotVersions: [2, 1] })
    h.updateReturnsNull = true

    const out = payload(await tool.fn({ action: 'restore', app_id: 'app-1', version: 2 }))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('恢复失败')
  })
})

describe('wb_app_versions 定位口径', () => {
  it('按唯一同名定位可用', async () => {
    seedApp('app-1', '唯一模板', { current: 2, snapshotVersions: [1] })

    const out = payload(await tool.fn({ action: 'list', name: '唯一模板' }))

    expect(out.ok).toBe(true)
    expect(out.app_id).toBe('app-1')
  })

  it('同名多个 → 拒绝并要求传 app_id（不猜）', async () => {
    seedApp('app-1', '撞名', { current: 1 })
    seedApp('app-2', '撞名', { current: 1 })

    const out = payload(await tool.fn({ action: 'list', name: '撞名' }))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('2 个同名')
    expect(String(out.hint)).toContain('app-1')
  })

  it('app_id 不存在 → 报错并指向 wb_list_templates', async () => {
    const out = payload(await tool.fn({ action: 'list', app_id: 'nope' }))

    expect(out.ok).toBe(false)
    expect(String(out.hint)).toContain('wb_list_templates')
  })

  it('既无 app_id 也无 name → 报错', async () => {
    const out = payload(await tool.fn({ action: 'list' }))

    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('定位')
  })

  it('未知 action → 列出允许值', async () => {
    seedApp('app-1', '模板A', { current: 1 })

    const out = payload(await tool.fn({ action: 'oops', app_id: 'app-1' }))

    expect(out.ok).toBe(false)
    expect(out.allowed).toEqual(['list', 'get', 'restore'])
  })
})
