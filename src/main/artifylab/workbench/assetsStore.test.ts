// @vitest-environment node
/**
 * 创作资产存储测试（对标建议 #4 数据层）。
 *
 * 关注点：落盘/重读一致性、按 id 与 name 双路解析（模型手里常只有名字）、
 * 重名自动加序号（保证 name 引用可解析）、损坏文件降级为空库不阻断工作台、
 * 输入规范化边界（非字符串 refs / 嵌套 params / 超量截断）。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

import {
  AssetsStore,
  ASSET_KINDS,
  normalizeAssetInput,
  normalizeParams,
  normalizeRefs
} from './assetsStore'

let dir = ''
let file = ''
const makeStore = () => new AssetsStore({ storePath: () => file })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-assets-test-'))
  file = join(dir, 'assets.json')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('AssetsStore 基本 CRUD', () => {
  it('save 新建 → 落盘 + list/get 可读', () => {
    const store = makeStore()
    const { asset, created, issues } = store.save({
      name: '小美',
      kind: 'character',
      refs: ['face.png'],
      seed: 123
    })

    expect(created).toBe(true)
    expect(issues).toEqual([])
    expect(asset.id).toBeTruthy()
    expect(existsSync(file)).toBe(true)

    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    expect(onDisk).toHaveLength(1)
    expect(onDisk[0].name).toBe('小美')

    expect(store.list()).toHaveLength(1)
    expect(store.get(asset.id)?.seed).toBe(123)
  })

  it('同 id 再 save = 更新（created=false，createdAt 保留）', () => {
    const store = makeStore()
    const first = store.save({ name: '小美', refs: ['a.png'] })
    const second = store.save({ id: first.asset.id, refs: ['a.png', 'b.png'], seed: 9 })

    expect(second.created).toBe(false)
    expect(second.asset.name).toBe('小美')
    expect(second.asset.refs).toHaveLength(2)
    expect(second.asset.createdAt).toBe(first.asset.createdAt)
    expect(store.list()).toHaveLength(1)
  })

  it('同名新建自动加序号（name 引用可解析、不歧义）', () => {
    const store = makeStore()
    store.save({ name: '小美' })
    const dup = store.save({ name: '小美' })

    expect(dup.asset.name).toBe('小美 2')
    expect(dup.issues.some((s) => s.includes('同名资产'))).toBe(true)
    // 第三个继续递增
    expect(store.save({ name: '小美' }).asset.name).toBe('小美 3')
  })

  it('remove 按 id 删除；重复删除返回 false', () => {
    const store = makeStore()
    const { asset } = store.save({ name: '小美' })
    expect(store.remove(asset.id)).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.remove(asset.id)).toBe(false)
  })

  it('files persist across store instances（进程重启后从盘恢复）', () => {
    const store1 = makeStore()
    const { asset } = store1.save({ name: '小美', refs: ['x.png'] })
    store1.save({ name: '赛博朋克', kind: 'style' })

    const store2 = makeStore()
    expect(store2.list()).toHaveLength(2)
    expect(store2.get(asset.id)?.refs).toEqual(['x.png'])
  })

  it('损坏 JSON → 降级空库（不抛错，工作台可用）', () => {
    writeFileSync(file, '{ this is not json')
    const store = makeStore()
    expect(() => store.list()).not.toThrow()
    expect(store.list()).toEqual([])
    // 仍可正常写入
    expect(store.save({ name: '小美' }).created).toBe(true)
  })

  it('非数组 JSON 内容同样降级为空库', () => {
    writeFileSync(file, '{"a":1}')
    expect(makeStore().list()).toEqual([])
  })
})

describe('resolve（id 优先，name 兜底，大小写不敏感）', () => {
  it('按 id 精确命中', () => {
    const store = makeStore()
    const { asset } = store.save({ name: '小美' })
    expect(store.resolve(asset.id)?.name).toBe('小美')
  })

  it('按 name 命中（忽略大小写与首尾空格）', () => {
    const store = makeStore()
    store.save({ name: 'CyberPunk' })
    expect(store.resolve('  cyberpunk ')?.name).toBe('CyberPunk')
  })

  it('未命中返回 undefined；空 key 不误命中', () => {
    const store = makeStore()
    store.save({ name: '小美' })
    expect(store.resolve('不存在')).toBeUndefined()
    expect(store.resolve('')).toBeUndefined()
    expect(store.resolve('   ')).toBeUndefined()
  })

  it('id 与 name 冲突时 id 优先', () => {
    const store = makeStore()
    const a = store.save({ name: 'x' }).asset
    // 第二个资产的名字恰好等于第一个的 id（极端情况）
    const b = store.save({ name: a.id }).asset
    expect(store.resolve(a.id)?.id).toBe(a.id)
    expect(store.resolve(a.id)?.id).not.toBe(b.id)
  })

  it('resolve 返回副本（refs/params 外部改动不污染缓存，避免脏数据落盘）', () => {
    const store = makeStore()
    const { asset } = store.save({ name: '小美', refs: ['a.png'], params: { lora: 'x' } })
    const got = store.resolve(asset.id)!
    got.refs.push('hacked.png')
    got.params.lora = 'hacked'
    expect(store.get(asset.id)?.refs).toEqual(['a.png'])
    expect(store.get(asset.id)?.params).toEqual({ lora: 'x' })

    // list/save 的返回值同样隔离
    const listed = store.list()[0]!
    listed.refs.push('hacked2.png')
    expect(store.get(asset.id)?.refs).toEqual(['a.png'])

    const saved = store.save({ id: asset.id, refs: ['a.png'] })
    saved.asset.refs.push('hacked3.png')
    expect(store.get(asset.id)?.refs).toEqual(['a.png'])
  })
})

describe('输入规范化', () => {
  it('normalizeRefs：非字符串过滤 / trim / 去重 / 上限 12', () => {
    expect(normalizeRefs([' a.png ', '', 'a.png', 123, null, 'b.png'])).toEqual(['a.png', 'b.png'])
    expect(normalizeRefs('not-array')).toEqual([])
    const many = Array.from({ length: 20 }, (_, i) => `f${i}.png`)
    expect(normalizeRefs(many)).toHaveLength(12)
  })

  it('normalizeParams：丢弃嵌套对象/数组值保留/null 丢弃/上限 40', () => {
    const out = normalizeParams({
      a: 1,
      b: 'x',
      c: { nested: true },
      d: null,
      e: [1, 2]
    })
    expect(out).toEqual({ a: 1, b: 'x', e: [1, 2] })
    const big: Record<string, number> = {}
    for (let i = 0; i < 60; i++) big[`k${i}`] = i
    expect(Object.keys(normalizeParams(big))).toHaveLength(40)
  })

  it('name 缺失 → issue（不抛错）', () => {
    const { issues } = normalizeAssetInput({ name: '  ' })
    expect(issues.some((s) => s.includes('name 不能为空'))).toBe(true)
  })

  it('refs 传了但全无效 → issue 提示格式', () => {
    const { issues } = normalizeAssetInput({ name: '小美', refs: [1, 2] })
    expect(issues.some((s) => s.includes('refs 需要至少一个非空字符串'))).toBe(true)
  })

  it('非法 seed（非数字）忽略并给 issue，不写坏值', () => {
    const { asset, issues } = normalizeAssetInput({ name: '小美', seed: 'abc' })
    expect(asset.seed).toBeUndefined()
    expect(issues.some((s) => s.includes('seed 需要是数字'))).toBe(true)
  })

  it('seed 小数取整；非法 kind 回退 character', () => {
    const a = normalizeAssetInput({ name: 'x', seed: 12.9 })
    expect(a.asset.seed).toBe(12)
    const b = normalizeAssetInput({ name: 'x', kind: 'unknown-kind' })
    expect(b.asset.kind).toBe('character')
    expect(ASSET_KINDS).toContain(b.asset.kind)
  })

  it('更新时未提供的字段沿用旧值（部分更新语义）', () => {
    const store = makeStore()
    const first = store.save({ name: '小美', kind: 'style', refs: ['a.png'], seed: 5 })
    const upd = store.save({ id: first.asset.id, notes: '改了备注' })
    expect(upd.asset.kind).toBe('style')
    expect(upd.asset.refs).toEqual(['a.png'])
    expect(upd.asset.seed).toBe(5)
    expect(upd.asset.notes).toBe('改了备注')
  })
})
