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
