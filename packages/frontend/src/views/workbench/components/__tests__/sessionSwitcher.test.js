// @vitest-environment happy-dom
// __tests__/sessionSwitcher.test.js — C13 前置:多会话切换 UI 单测
// 覆盖:排序(未归档在前按 updatedAt 降序,归档沉底)/ switch emit 载荷 /
// new emit / archive emit / generating spinner 小标 / 空列表 / active 高亮。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import SessionSwitcher from '../SessionSwitcher.vue'

// 固定时间戳,杜绝时钟依赖(仓库零容忍 flaky 测试)
const T1 = 1700000000000
const T2 = 1700000060000
const T3 = 1700000120000

const SESSIONS = [
  { threadId: 't-b', title: '会话 B', updatedAt: T2 },
  { threadId: 't-a', title: '会话 A', updatedAt: T1 },
  { threadId: 't-old', title: '较早会话', updatedAt: T3, archived: true },
]

const mountSwitcher = (props = {}) =>
  mount(SessionSwitcher, {
    props: { sessions: SESSIONS, activeThreadId: '', generating: {}, ...props },
  })

describe('SessionSwitcher — 排序', () => {
  it('未归档在前按 updatedAt 降序,归档沉底(同段内也降序)', () => {
    const w = mountSwitcher()
    const ids = w.findAll('[data-testid^="session-item-"]').map((n) => n.attributes('data-thread-id'))
    expect(ids).toEqual(['t-b', 't-a', 't-old'])
  })

  it('归档段内多条仍按 updatedAt 降序', () => {
    const w = mountSwitcher({
      sessions: [
        { threadId: 'a1', title: '归档 1', updatedAt: T1, archived: true },
        { threadId: 'a2', title: '归档 2', updatedAt: T3, archived: true },
        { threadId: 'live', title: '活跃', updatedAt: T2 },
      ],
    })
    const ids = w.findAll('[data-testid^="session-item-"]').map((n) => n.attributes('data-thread-id'))
    expect(ids).toEqual(['live', 'a2', 'a1'])
  })

  it('updatedAt 缺失按 0 沉底(未归档段内);ISO 字符串时间可比较', () => {
    const w = mountSwitcher({
      sessions: [
        { threadId: 'no-ts', title: '无时间', updatedAt: undefined },
        { threadId: 'iso', title: 'ISO 时间', updatedAt: new Date(T1).toISOString() },
        { threadId: 'num', title: '数字时间', updatedAt: T3 },
      ],
    })
    const ids = w.findAll('[data-testid^="session-item-"]').map((n) => n.attributes('data-thread-id'))
    expect(ids).toEqual(['num', 'iso', 'no-ts'])
  })
})

describe('SessionSwitcher — emits', () => {
  it('switch 载荷为 threadId 字符串', async () => {
    const w = mountSwitcher({ activeThreadId: 't-a' })
    await w.find('[data-testid="session-item-t-b"]').trigger('click')
    expect(w.emitted('switch')).toEqual([['t-b']])
  })

  it('new:点击「+ 新会话」入口', async () => {
    const w = mountSwitcher()
    await w.find('[data-testid="session-new"]').trigger('click')
    expect(w.emitted('new')).toHaveLength(1)
  })

  it('archive:未归档项 hover 按钮发归档,载荷为 threadId', async () => {
    const w = mountSwitcher()
    await w.find('[data-testid="session-archive-t-a"]').trigger('click')
    expect(w.emitted('archive')).toEqual([['t-a']])
  })

  it('archive 同通道:归档项按钮发恢复(父级切换 archived 语义),且不冒泡成 switch', async () => {
    const w = mountSwitcher()
    const btn = w.find('[data-testid="session-archive-t-old"]')
    await btn.trigger('click')
    expect(w.emitted('archive')).toEqual([['t-old']])
    expect(w.emitted('switch')).toBeUndefined()
  })
})

describe('SessionSwitcher — generating spinner 与状态', () => {
  it('generating 映射为 true 的项显示 spinner 小标,false 不显示', () => {
    const w = mountSwitcher({ generating: { 't-b': true, 't-a': false } })
    expect(w.find('[data-testid="session-generating-t-b"]').exists()).toBe(true)
    expect(w.find('[data-testid="session-generating-t-a"]').exists()).toBe(false)
    expect(w.find('[data-testid="session-generating-t-old"]').exists()).toBe(false)
  })

  it('activeThreadId 高亮当前项且 aria-selected,其余不高亮', () => {
    const w = mountSwitcher({ activeThreadId: 't-a' })
    const active = w.find('[data-testid="session-item-t-a"]')
    const inactive = w.find('[data-testid="session-item-t-b"]')
    expect(active.classes()).toContain('is-active')
    expect(active.attributes('aria-selected')).toBe('true')
    expect(inactive.classes()).not.toContain('is-active')
    expect(inactive.attributes('aria-selected')).toBe('false')
  })
})

describe('SessionSwitcher — 空列表', () => {
  it('空列表只显示「+ 新会话」,无会话项', () => {
    const w = mountSwitcher({ sessions: [] })
    expect(w.find('[data-testid="session-new"]').exists()).toBe(true)
    expect(w.find('[data-testid^="session-item-"]').exists()).toBe(false)
    expect(w.emitted('new')).toBeUndefined()
  })
})
