// @vitest-environment node
/**
 * wb_assets 工具层测试（对标建议 #4 接口面）。
 *
 * 关键隔离：assetsStore 模块级单例默认指向 userData（真实用户数据）——这里
 * 用 vi.mock 把它替换成指向临时目录的实例，测试绝不触碰真实资产库。
 * 关注点：四个 action 的分发与返回形状、name 解析、参数别名、错误路径（不抛错、
 * 而是把可读错误回给模型改道）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({ file: '' }))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
// shared.ts → workbench/service 的加载链会绕回 mcp/index → workbenchTools →
// wbtools/assetTools（循环依赖：本模块尚在初始化，导出为 undefined）。按既有
// planTools.test 的隔离手法切断 service/appStore/batchRunner 三个重模块。
vi.mock('../../workbench/service', () => ({
  workbenchService: { getSession: vi.fn((id: string) => (id ? { id } : null)) }
}))
vi.mock('../../appStore', () => ({ default: { getConfig: () => ({}) } }))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))
vi.mock('../../workbench/assetsStore', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../workbench/assetsStore')>()
  return {
    ...actual,
    assetsStore: new actual.AssetsStore({ storePath: () => h.file })
  }
})

import { assetTools } from './assetTools'
import { assetsStore } from '../../workbench/assetsStore'

const fn = assetTools[0]!.fn
const toolName = assetTools[0]!.tool.name

/** 抽出工具返回体里的 JSON 载荷 */
function payload(res: unknown): Record<string, unknown> {
  const r = res as { content: Array<{ text: string }> }
  return JSON.parse(r.content[0]!.text) as Record<string, unknown>
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-asset-tools-'))
  h.file = join(dir, 'assets.json')
  // 单例 store 的内存缓存跨用例残留（每个用例换临时目录）——显式失效重读
  assetsStore.invalidateCacheForTest()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('wb_assets 工具契约', () => {
  it('工具名与 action 枚举符合编排契约', () => {
    expect(toolName).toBe('wb_assets')
    const schema = assetTools[0]!.tool.inputSchema as {
      required?: string[]
      properties: Record<string, { enum?: string[] }>
    }
    expect(schema.required).toContain('action')
    expect(schema.properties.action!.enum).toEqual(['list', 'get', 'save', 'remove'])
  })
})

describe('action=list / get', () => {
  it('空库 list → total 0', async () => {
    const out = payload(await fn({ action: 'list' }))
    expect(out.ok).toBe(true)
    expect(out.total).toBe(0)
    expect(out.assets).toEqual([])
  })

  it('save 后 list 返回精简视图（refs_count/params_keys，不含完整 refs）', async () => {
    await fn({ action: 'save', name: '小美', kind: 'character', refs: ['a.png', 'b.png'], seed: 7, params: { lora: 'x' } })
    const out = payload(await fn({ action: 'list' }))
    expect(out.total).toBe(1)
    const item = (out.assets as Array<Record<string, unknown>>)[0]!
    expect(item.name).toBe('小美')
    expect(item.refs_count).toBe(2)
    expect(item.seed).toBe(7)
    expect(item.params_keys).toEqual(['lora'])
    expect(item.refs).toBeUndefined()
  })

  it('get 按 name 解析（忽略大小写），返回完整资产', async () => {
    await fn({ action: 'save', name: 'CyberPunk', kind: 'style', refs: ['s.png'] })
    const out = payload(await fn({ action: 'get', name: 'cyberpunk' }))
    expect(out.ok).toBe(true)
    expect((out.asset as { name: string }).name).toBe('CyberPunk')
    expect((out.asset as { refs: string[] }).refs).toEqual(['s.png'])
  })

  it('get 支持 asset_id / assetId 别名', async () => {
    const saved = payload(await fn({ action: 'save', name: '小美' }))
    const bySnake = payload(await fn({ action: 'get', asset_id: saved.id }))
    const byCamel = payload(await fn({ action: 'get', assetId: saved.id }))
    expect(bySnake.ok).toBe(true)
    expect(byCamel.ok).toBe(true)
  })

  it('get 未命中 → ok:false + 指向 list 的 hint（不抛错）', async () => {
    const out = payload(await fn({ action: 'get', name: '不存在' }))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('未找到资产')
    expect(String(out.hint)).toContain('action=list')
  })

  it('get 缺少 id/name → 明确报错', async () => {
    const out = payload(await fn({ action: 'get' }))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('需要 id 或 name')
  })
})

describe('action=save', () => {
  it('新建成功 → created=true 且回传 id 供后续引用', async () => {
    const out = payload(
      await fn({
        action: 'save',
        name: '小美',
        kind: 'character',
        refs: ['face.png'],
        seed: 42,
        params: { lora: 'xiaomei' },
        notes: '主角'
      })
    )
    expect(out.ok).toBe(true)
    expect(out.created).toBe(true)
    expect(typeof out.id).toBe('string')
    expect(out.refs_count).toBe(1)
    expect(out.seed).toBe(42)
    expect(out.params_keys).toEqual(['lora'])
  })

  it('校验失败（name 为空）→ ok:false + issues（模型据此改道）', async () => {
    const out = payload(await fn({ action: 'save', refs: ['a.png'] }))
    expect(out.ok).toBe(false)
    expect((out.issues as string[]).some((s) => s.includes('name 不能为空'))).toBe(true)
  })

  it('按 id 更新 → created=false，字段部分更新', async () => {
    const first = payload(await fn({ action: 'save', name: '小美', refs: ['a.png'], seed: 1 }))
    const upd = payload(await fn({ action: 'save', id: first.id, seed: 99 }))
    expect(upd.created).toBe(false)
    expect(upd.seed).toBe(99)
    expect(upd.refs_count).toBe(1)
  })

  it('磁盘写入异常 → ok:false + error（不让异常穿透到 MCP 层）', async () => {
    // 指向一个不可能创建成功的路径（把临时目录当文件用）
    h.file = join(dir, 'sub', 'assets.json')
    // 让 sub 成为文件，mkdir 失败
    const { writeFileSync } = await import('node:fs')
    writeFileSync(join(dir, 'sub'), 'x')
    const out = payload(await fn({ action: 'save', name: '小美' }))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('资产保存失败')
  })
})

describe('action=remove', () => {
  it('按 name 删除 → ok + 回传被删对象；再查已不在', async () => {
    await fn({ action: 'save', name: '小美' })
    const out = payload(await fn({ action: 'remove', name: '小美' }))
    expect(out.ok).toBe(true)
    expect(out.removed_name).toBe('小美')
    expect(payload(await fn({ action: 'list' })).total).toBe(0)
  })

  it('删除不存在的资产 → ok:false（不抛错）', async () => {
    const out = payload(await fn({ action: 'remove', name: 'ghost' }))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('未找到资产')
  })

  it('删除后同名可重建（name 引用不残留）', async () => {
    await fn({ action: 'save', name: '小美', refs: ['old.png'] })
    await fn({ action: 'remove', name: '小美' })
    const out = payload(await fn({ action: 'save', name: '小美', refs: ['new.png'] }))
    expect(out.created).toBe(true)
    expect(out.name).toBe('小美')
    expect(out.refs_count).toBe(1)
  })
})

describe('异常 action', () => {
  it('未知 action → ok:false 并列出允许值', async () => {
    const out = payload(await fn({ action: 'delete' }))
    expect(out.ok).toBe(false)
    expect(out.allowed).toEqual(['list', 'get', 'save', 'remove'])
  })

  it('action 缺失 → 不抛错，返回可读错误', async () => {
    const out = payload(await fn({}))
    expect(out.ok).toBe(false)
    expect(String(out.error)).toContain('未知 action')
  })
})

describe('存储隔离自检', () => {
  it('使用注入的临时 store（未写入真实 userData 路径）', async () => {
    await fn({ action: 'save', name: '小美' })
    expect(assetsStore.list()).toHaveLength(1)
  })
})
