import { describe, it, expect } from 'vitest'
import { CANVAS_CTX_ACTIONS, ctxPredicateEnv, buildCtxItems } from './canvasActions'

const note = (id) => ({ id, type: 'note', x: 0 })
const image = (id, meta) => ({ id, type: 'image', x: 0, meta })
const app = (id) => ({ id, type: 'app', x: 0 })
const frame = (id) => ({ id, type: 'frame', x: 0 })

describe('ctxPredicateEnv（选中集 → 谓词环境）', () => {
  it('空选中：只有 always 类存活', () => {
    const env = ctxPredicateEnv([image('a')], [])
    expect(env.always).toBe(true)
    expect(env.anyImage).toBe(false)
    expect(env.multi).toBe(false)
  })

  it('单图片：anyImage ✓ / multi ✗ / multiImage ✗', () => {
    const env = ctxPredicateEnv([image('a')], ['a'])
    expect(env.anyImage).toBe(true)
    expect(env.multi).toBe(false)
    expect(env.multiImage).toBe(false)
  })

  it('双图片：multi ✓ multiImage ✓ triple ✗', () => {
    const env = ctxPredicateEnv([image('a'), image('b')], ['a', 'b'])
    expect(env.multi).toBe(true)
    expect(env.multiImage).toBe(true)
    expect(env.triple).toBe(false)
  })

  it('meta.prompt 才点亮 anyImageMeta；无 meta 不亮', () => {
    expect(ctxPredicateEnv([image('a', { prompt: 'x' })], ['a']).anyImageMeta).toBe(true)
    expect(ctxPredicateEnv([image('a')], ['a']).anyImageMeta).toBe(false)
  })

  it('singleNote/singleFrame 恰一个才亮', () => {
    expect(ctxPredicateEnv([note('a')], ['a']).singleNote).toBe(true)
    expect(ctxPredicateEnv([note('a'), note('b')], ['a', 'b']).singleNote).toBe(false)
    expect(ctxPredicateEnv([frame('f')], ['f']).singleFrame).toBe(true)
  })

  it('选中 id 在画布不存在不计入类型统计', () => {
    const env = ctxPredicateEnv([image('a')], ['a', 'ghost'])
    expect(env.anyImage).toBe(true)
    expect(env.multi).toBe(true) // multi 按 ids 数（原语义即如此）
  })
})

describe('buildCtxItems（注册表投影）', () => {
  const run = (key) => () => key

  it('单图选中：AI 组与图片动作出现，对齐/分布不出现', () => {
    const items = buildCtxItems([image('a')], ['a'], undefined, run)
    const keys = items.map((i) => i.key)
    expect(keys).toContain('gen')
    expect(keys).toContain('ai-group')
    expect(keys).not.toContain('alignL')
    expect(keys).not.toContain('distH')
    expect(keys).not.toContain('compose')
  })

  it('AI 子菜单 6 项全在', () => {
    const items = buildCtxItems([image('a')], ['a'], undefined, run)
    const grp = items.find((i) => i.key === 'ai-group')
    expect(grp.children.map((c) => c.key)).toEqual([
      'reverse',
      'enhance',
      'outpaint',
      'video',
      'char',
      'style',
    ])
  })

  it('app 选中出现 run/panel/full 三连', () => {
    const items = buildCtxItems([app('a')], ['a'], undefined, run)
    const keys = items.map((i) => i.key)
    expect(keys).toContain('app-run')
    expect(keys).toContain('app-panel')
    expect(keys).toContain('app-full')
    expect(keys).not.toContain('gen')
  })

  it('≥3 选中出现分布（distH/distV），≥2 只有对齐', () => {
    const two = buildCtxItems([note('a'), note('b')], ['a', 'b'], undefined, run).map((i) => i.key)
    const three = buildCtxItems(
      [note('a'), note('b'), note('c')],
      ['a', 'b', 'c'],
      undefined,
      run,
    ).map((i) => i.key)
    expect(two).toContain('alignL')
    expect(two).not.toContain('distH')
    expect(three).toContain('distH')
    expect(three).toContain('distV')
  })

  it('run 闭包可执行且返回 key（label 由 UI 层从 labelKey 现取）', () => {
    const items = buildCtxItems([note('a')], ['a'], undefined, run)
    const noteEdit = items.find((i) => i.key === 'note-edit')
    expect(noteEdit.labelKey).toBe('canvasMenuEditNote')
    expect(noteEdit.run()).toBe('note-edit')
  })

  it('always 项（copy/z序/del）任何选中都在，分隔线首尾收紧', () => {
    const items = buildCtxItems([note('a')], ['a'], undefined, run)
    const keys = items.map((i) => i.key)
    for (const k of ['copy', 'front', 'forward', 'backward', 'back', 'del']) {
      expect(keys).toContain(k)
    }
    expect(items[0].sep).toBeFalsy()
    expect(items[items.length - 1].sep).toBeFalsy()
  })

  it('注册表 key 唯一', () => {
    const keys = CANVAS_CTX_ACTIONS.filter((a) => !a.sep).map((a) => a.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
