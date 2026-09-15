import { describe, it, expect } from 'vitest'
import {
  builtinLibrary,
  loadCustomPrompts,
  saveCustomPrompts,
  parseImportedPrompts,
  mergePrompts,
  searchPrompts,
} from './promptLibrary'

function memStorage() {
  const m = new Map()
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
    removeItem: (k) => m.delete(k),
  }
}

describe('builtinLibrary', () => {
  it('有分类且条目非空', () => {
    const lib = builtinLibrary()
    expect(lib.length).toBeGreaterThanOrEqual(4)
    for (const cat of lib) {
      expect(cat.category).toBeTruthy()
      expect(cat.items.length).toBeGreaterThan(0)
      for (const it of cat.items) expect(it.text.trim()).toBeTruthy()
    }
  })

  // 2026-09 重写：从"按词性分类"改成"按工作流分类"，五大模态必须都覆盖
  it('覆盖五类工作流（分类名可检索）', () => {
    const cats = builtinLibrary().map((c) => c.category)
    const joined = cats.join('|')
    for (const kw of ['文生图', '文生视频', '图生视频', '图生图', '图像编辑']) {
      expect(joined).toContain(kw)
    }
    // 模型分档排在最前（先定档再挑词）
    expect(cats[0]).toContain('模型分档')
  })

  it('全库无重复 text（同名条目会让面板 key 冲突）', () => {
    const texts = builtinLibrary().flatMap((c) => c.items.map((i) => i.text))
    expect(new Set(texts).size).toBe(texts.length)
  })

  it('每条都带 hint（最佳实践/适用模型就放在 hint 里）', () => {
    const missing = builtinLibrary()
      .flatMap((c) => c.items.map((i) => ({ cat: c.category, ...i })))
      .filter((i) => !(i.hint || '').trim())
    expect(missing.map((i) => i.text)).toEqual([])
  })

  it('模型分档要点在场：Flux 无负面 / Krea2 不吃质量词 / 视频负面含 motionless image', () => {
    const all = builtinLibrary()
      .flatMap((c) => c.items.map((i) => `${i.text} ${i.hint || ''}`))
      .join('\n')
    expect(all).toMatch(/Flux 没有负面/)
    expect(all).toMatch(/Krea2[\s\S]{0,80}不吃/)
    expect(all).toMatch(/motionless image/)
  })

  it('编辑类骨架在场：先锁不变项再写唯一改动', () => {
    const all = builtinLibrary()
      .flatMap((c) => c.items.map((i) => i.text))
      .join('\n')
    expect(all).toMatch(/Keep .*exactly the same/i)
    expect(all).toMatch(/Preserve exactly/)
  })

  it('有可直接填空的模板（含 {} 占位符）', () => {
    const tpl = builtinLibrary()
      .flatMap((c) => c.items)
      .filter((i) => i.text.includes('{') && i.text.includes('}'))
    expect(tpl.length).toBeGreaterThanOrEqual(8)
  })
})

describe('custom prompts storage', () => {
  it('存取 roundtrip + 坏档容忍', () => {
    const st = memStorage()
    saveCustomPrompts([{ text: 'a', hint: 'h' }, null, { text: ' ' }], st)
    expect(loadCustomPrompts(st)).toEqual([{ text: 'a', hint: 'h' }])
    st.setItem('artify.canvas.prompts.custom.v1', '{bad')
    expect(loadCustomPrompts(st)).toEqual([])
  })
  it('空 storage 安全', () => {
    expect(loadCustomPrompts(null)).toEqual([])
    expect(() => saveCustomPrompts([{ text: 'x' }], null)).not.toThrow()
  })
})

describe('parseImportedPrompts', () => {
  it('对象数组 / {prompts} / 字符串数组 三形态', () => {
    expect(parseImportedPrompts('[{"text":"a"}]')).toEqual([{ text: 'a', hint: '' }])
    expect(parseImportedPrompts('{"prompts":["x","y"]}')).toEqual([
      { text: 'x', hint: '' },
      { text: 'y', hint: '' },
    ])
    expect(parseImportedPrompts('["z"]')).toEqual([{ text: 'z', hint: '' }])
  })
  it('坏格式报错', () => {
    expect(() => parseImportedPrompts('{"x":1}')).toThrow('unrecognized')
    expect(() => parseImportedPrompts('not json')).toThrow()
  })
})

describe('mergePrompts / searchPrompts', () => {
  it('按 text 去重合并', () => {
    const merged = mergePrompts([{ text: 'a' }], [{ text: 'a' }, { text: 'b', hint: 'h' }])
    expect(merged).toEqual([{ text: 'a' }, { text: 'b', hint: 'h' }])
  })
  it('搜索 text/hint 命中并裁掉空分类', () => {
    const lib = [
      { category: 'c1', items: [{ text: '水彩画风格', hint: '水彩' }] },
      { category: 'c2', items: [{ text: '赛博朋克', hint: '' }] },
    ]
    const r = searchPrompts(lib, '水彩')
    expect(r).toHaveLength(1)
    expect(r[0].category).toBe('c1')
    expect(searchPrompts(lib, '')).toHaveLength(2)
  })
})
