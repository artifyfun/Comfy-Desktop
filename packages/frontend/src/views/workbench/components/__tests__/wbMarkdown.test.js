// views/workbench/components/__tests__/wbMarkdown.test.js — C10 WbMarkdown 增量化测试
// 覆盖：50 次 delta append 最终 innerHTML 与一次性全量渲染逐字节一致（硬验收）/
//        流式 16ms 节流（fake timers，断言渲染次数 ≪ delta 数，零真实 sleep）/
//        复制按钮在增量渲染后仍存在可点 / 非流式用法回归不变 / computeStableCut
//        边界 case（未闭合 fence、表格、松散列表、setext、缩进代码、HTML 行、
//        链接引用定义、CRLF）。
// 纯逻辑部分（computeStableCut / renderMarkdown）直测普通 <script> 导出；
// DOM/交互断言用 @vue/test-utils + happy-dom（根 devDependencies，vitest 从根解析）。
// 注意：watcher 是 pre-flush，setProps 必须 await 才会反映到 DOM。
// @vitest-environment happy-dom
import { describe, expect, it, vi, afterEach } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import WbMarkdown, { computeStableCut, renderMarkdown } from '../WbMarkdown.vue'

/** 真实 LLM 流式形态：一段含全部硬点结构的 markdown */
function buildStreamDoc() {
  const paras = []
  paras.push('# 流式标题')
  paras.push('第一段：普通文本，含 `inline code` 与 [链接](https://example.com)。')
  paras.push('```js\nconst a = 1\nconsole.log(a)\n```')
  paras.push('| 列A | 列B |\n| --- | --- |\n| a1 | b1 |')
  paras.push('- 列表项一\n- 列表项二')
  paras.push('> 引用块内容')
  paras.push('**加粗** 与 *斜体* 收尾。')
  return paras.join('\n\n')
}

/** 按可见 token 片切成 ≈n 个 delta（模拟真实流式粒度） */
function chunkIntoDeltas(doc, n) {
  const size = Math.ceil(doc.length / n)
  const out = []
  for (let i = 0; i < doc.length; i += size) out.push(doc.slice(i, i + size))
  return out
}

afterEach(() => {
  vi.useRealTimers()
})

describe('C10 — 非流式回归（既有用法零变化）', () => {
  it('默认 props：不传 streaming，渲染与旧实现等价（全量 parse+sanitize）', async () => {
    const src = buildStreamDoc()
    const wrapper = mount(WbMarkdown, { props: { source: src } })
    await flushPromises()
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown(src))
    // 代码块卡片与复制按钮仍在（旧行为）
    expect(wrapper.find('.wb-md-code').exists()).toBe(true)
    expect(wrapper.find('.wb-md-copy').exists()).toBe(true)
  })

  it('空 source 渲染为空串；source 变更即时全量重渲染（无节流）', async () => {
    const wrapper = mount(WbMarkdown, { props: { source: '' } })
    await flushPromises()
    expect(wrapper.get('.wb-md').element.innerHTML).toBe('')
    const rc = wrapper.vm.renderCount
    await wrapper.setProps({ source: '# 新内容' })
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown('# 新内容'))
    expect(wrapper.vm.renderCount).toBe(rc + 1)
  })

  it('streaming=true → false 收尾后，与一次性全量渲染逐字节一致', async () => {
    vi.useFakeTimers()
    const src = buildStreamDoc()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    await wrapper.setProps({ source: src })
    vi.advanceTimersByTime(64)
    await wrapper.setProps({ streaming: false }) // 收尾：强制全量
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown(src))
  })
})

describe('C10 — 流式 append 硬验收：最终 HTML === 一次性全量渲染', () => {
  it('50 次 delta append + streaming 翻 false，innerHTML 逐字节等于全量渲染', async () => {
    const doc = buildStreamDoc()
    const deltas = chunkIntoDeltas(doc, 50)
    expect(deltas.length).toBeGreaterThan(40)
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    let acc = ''
    for (const d of deltas) {
      acc += d
      await wrapper.setProps({ source: acc })
      vi.advanceTimersByTime(16)
    }
    // 50 次 delta 中至少发生过一次增量渲染（不是空转到收尾才第一次渲染）
    expect(wrapper.vm.renderCount).toBeGreaterThan(1)
    await wrapper.setProps({ streaming: false })
    const streamed = wrapper.get('.wb-md').element.innerHTML
    expect(streamed).toBe(renderMarkdown(doc))
    // 结构抽检：代码卡片/表格/按钮都真的存在（marked 对单行标题不产 h1 标签）
    expect(wrapper.findAll('.wb-md-code').length).toBe(1)
    expect(wrapper.findAll('.wb-md-copy').length).toBeGreaterThan(0)
    expect(wrapper.find('table').exists()).toBe(true)
    expect(wrapper.findAll('p').length).toBeGreaterThan(0)
  })

  it('小片段高频 append（中文内容）收敛一致', async () => {
    const doc = '中文标题 #\n\n中文**正文**段落，带 `代码` 与表格：\n\n| 一 | 二 |\n| - | - |\n| 1 | 2 |'
    const deltas = chunkIntoDeltas(doc, 23)
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    let acc = ''
    for (const d of deltas) {
      acc += d
      await wrapper.setProps({ source: acc })
      vi.advanceTimersByTime(16)
    }
    await wrapper.setProps({ streaming: false })
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown(doc))
  })
})

describe('C10 — 节流：16ms 内的多次 delta 合并，渲染次数远小于 delta 数', () => {
  it('10 次 delta 在一个 flush 周期内灌入，只渲染 1 次', async () => {
    const doc = buildStreamDoc()
    const deltas = chunkIntoDeltas(doc, 10)
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    let acc = ''
    for (const d of deltas) {
      acc += d
      await wrapper.setProps({ source: acc }) // 不推进时间：全部落在第一个周期内
    }
    vi.advanceTimersByTime(16) // 唯一一次 flush
    expect(wrapper.vm.renderCount).toBe(1)
    vi.advanceTimersByTime(64) // 后续 timer 因 source 未变不会再渲染
    expect(wrapper.vm.renderCount).toBe(1)
    await wrapper.setProps({ streaming: false })
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown(doc))
  })

  it('30 次 delta 分散在 60ms 内，渲染次数 ≪ 30 且最终结果正确', async () => {
    const doc = buildStreamDoc()
    const deltas = chunkIntoDeltas(doc, 30)
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    let acc = ''
    for (const d of deltas) {
      acc += d
      await wrapper.setProps({ source: acc })
      vi.advanceTimersByTime(2) // 30 × 2ms = 60ms 灌完
    }
    // 全程零真实 sleep（fake timers），渲染次数被 16ms 周期限死
    expect(wrapper.vm.renderCount).toBeLessThan(10)
    expect(wrapper.vm.renderCount).toBeGreaterThan(0)
    vi.advanceTimersByTime(64) // 排空挂着的 flush
    await wrapper.setProps({ streaming: false })
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown(doc))
  })
})

describe('C10 — 复制按钮：增量渲染后仍存在且可点', () => {
  it('流式增量出代码块后按钮存在，点击写入剪贴板并显示「已复制」', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const docA = '前面一段\n\n'
    const docB = '```python\nprint("hi")\n```'
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    await wrapper.setProps({ source: docA })
    vi.advanceTimersByTime(16)
    await wrapper.setProps({ source: docA + docB })
    vi.advanceTimersByTime(16) // 代码块已在增量渲染中出现
    await flushPromises() // v-html patch 在 microtask，先排空再断言 DOM
    expect(wrapper.find('.wb-md-copy').exists()).toBe(true)
    await wrapper.get('.wb-md-copy').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledTimes(1)
    expect(writeText).toHaveBeenCalledWith('print("hi")')
    expect(wrapper.get('.wb-md-copy').text()).toBe('已复制')
    await wrapper.setProps({ streaming: false })
    expect(wrapper.find('.wb-md-copy').exists()).toBe(true) // 全量终态仍保留
    expect(writeText).toHaveBeenCalledTimes(1)
  })
})

describe('computeStableCut — 块边界切分纯函数', () => {
  const cut = (s) => s.slice(0, computeStableCut(s))

  it('完整段落 + 空行 + 后续内容：切在空行块边界（最后一个完整块留尾段）', () => {
    expect(cut('第一段\n\n第二段')).toBe('第一段\n')
    expect(cut('第一段\n\n第二段\n\n第三段')).toBe('第一段\n\n第二段\n')
  })

  it('未闭合 fenced code：整体不提交（cut=0）', () => {
    expect(computeStableCut('```js\nconst a = 1')).toBe(0)
    expect(cut('段落\n\n```js\nconst a = 1\n')).toBe('段落\n')
  })

  it('闭合 fenced code 之后有空行和后文：fence 作为完整块提交', () => {
    expect(cut('```js\nconst a = 1\n```\n\n下一段')).toBe('```js\nconst a = 1\n```\n')
    // fence 后无空行 → 不可作为切点
    expect(computeStableCut('```js\n1\n```\n下一段')).toBe(0)
  })

  it('fence 内的空行绝不构成切点；闭合 fence 后可提交', () => {
    const c = computeStableCut('```js\nline1\n\nline2\n```\n\n后文')
    expect(c).toBeGreaterThan(0)
    expect(cut('```js\nline1\n\nline2\n```\n\n后文')).not.toContain('后文')
    expect(cut('前段\n\n```js\nline1\n\nline2\n```\n\n后文')).toContain('```js')
    expect(cut('前段\n\n```js\nline1\n\nline2\n```\n\n后文')).not.toContain('后文')
  })

  it('表格行：不作为块尾提交（后行可能续写表格）', () => {
    expect(computeStableCut('| a | b |\n| - | - |\n\n后文')).toBe(0)
  })

  it('列表项：不提交（空行后可续成松散列表）', () => {
    expect(computeStableCut('- 项目一\n\n- 项目二')).toBe(0)
    expect(computeStableCut('1. 甲\n\n后文')).toBe(0)
  })

  it('引用行：不提交（空行后同标记可续）', () => {
    expect(computeStableCut('> 引用\n\n> 引用二')).toBe(0)
  })

  it('缩进代码 / 原生 HTML 行 / hr / setext：一律保守留尾', () => {
    expect(computeStableCut('    indented code\n\n后文')).toBe(0)
    expect(computeStableCut('<div>x</div>\n\n后文')).toBe(0)
    expect(computeStableCut('---\n\n后文')).toBe(0)
    expect(computeStableCut('标题\n===\n\n后文')).toBe(0)
  })

  it('链接引用定义行：增量整体放弃（cut=0，防前缀渲染回溯变化）', () => {
    expect(computeStableCut('[label]: https://example.com\n\n用 [label] 这里')).toBe(0)
  })

  it('仅一段且无后文：不切（尾段恒非空）', () => {
    expect(computeStableCut('只有一段')).toBe(0)
    expect(computeStableCut('段落\n\n')).toBe(0)
  })

  it('空串与 CRLF 输入安全', () => {
    expect(computeStableCut('')).toBe(0)
    expect(cut('第一段\r\n\r\n第二段')).toBe('第一段\r\n')
  })

  it('前缀单调性：append 只会让切点推进或不变（缓存前提）', () => {
    const doc = buildStreamDoc()
    const deltas = chunkIntoDeltas(doc, 25)
    let prev = 0
    let acc = ''
    for (const d of deltas) {
      acc += d
      const c = computeStableCut(acc)
      expect(c).toBeGreaterThanOrEqual(prev)
      prev = c
    }
    expect(prev).toBeGreaterThan(0)
  })
})

describe('M5 修复 — didStream 懒重渲染(历史消息零多余 parse)', () => {
  it('从未流式过的实例:streaming true→false 不触发多余渲染', async () => {
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '# 静态历史' } })
    await flushPromises()
    const rc0 = wrapper.vm.renderCount
    // 历史消息渲染完成后,run 结束把 busy 翻 false → streaming prop 变化,
    // 但本实例从未走过增量路径 → 不应重渲染
    await wrapper.setProps({ streaming: true })
    vi.advanceTimersByTime(64)
    await wrapper.setProps({ streaming: false })
    expect(wrapper.vm.renderCount).toBe(rc0 + 0)
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown('# 静态历史'))
  })

  it('真正流式过的实例:streaming 翻 false 触发终态全量重渲染', async () => {
    vi.useFakeTimers()
    const wrapper = mount(WbMarkdown, { props: { source: '', streaming: true } })
    await wrapper.setProps({ source: '# 流式' })
    vi.advanceTimersByTime(64) // flush 执行 → didStream = true
    const rc0 = wrapper.vm.renderCount
    expect(rc0).toBeGreaterThanOrEqual(1)
    await wrapper.setProps({ streaming: false })
    expect(wrapper.vm.renderCount).toBe(rc0 + 1) // 终态全量重渲染发生
    expect(wrapper.get('.wb-md').element.innerHTML).toBe(renderMarkdown('# 流式'))
  })
})
