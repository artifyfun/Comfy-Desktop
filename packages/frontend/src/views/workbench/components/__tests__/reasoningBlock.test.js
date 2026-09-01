// @vitest-environment happy-dom
// __tests__/reasoningBlock.test.js — C12 思考折叠块单测
// 覆盖:默认折叠态首行摘要、展开全文、streaming 三态
// (true→展开+流光 / true→false 自动折叠 / 手动展开不被打断)、长文滚动容器。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ReasoningBlock from '../ReasoningBlock.vue'

const mountBlock = (props) => mount(ReasoningBlock, { props })

describe('ReasoningBlock — 折叠态', () => {
  it('默认折叠:正文不渲染,header 显示首行摘要', () => {
    const w = mountBlock({ text: '第一行思考摘要\n第二行细节\n第三行细节', streaming: false })
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(false)
    expect(w.find('[data-testid="reasoning-summary"]').text()).toBe('第一行思考摘要')
  })

  it('空文本不出摘要占位;点击 header 展开全文', async () => {
    const w = mountBlock({ text: '', streaming: false })
    expect(w.find('[data-testid="reasoning-summary"]').exists()).toBe(false)
    await w.find('[data-testid="reasoning-toggle"]').trigger('click')
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(true)
    expect(w.find('[data-testid="reasoning-body"]').text()).toBe('')
  })

  it('摘要超长截断加省略号;取第一个非空行', () => {
    const long = 'y'.repeat(150)
    const w = mountBlock({ text: `\n\n${long}\n后续行`, streaming: false })
    const summary = w.find('[data-testid="reasoning-summary"]').text()
    expect(summary.length).toBe(101) // 100 字符 + …
    expect(summary.endsWith('…')).toBe(true)
  })
})

describe('ReasoningBlock — 展开全文与滚动容器', () => {
  it('展开态正文为限高滚动容器(pre-wrap)', async () => {
    const longText = Array.from({ length: 60 }, (_, i) => `思考第 ${i} 行`).join('\n')
    const w = mountBlock({ text: longText, streaming: false })
    await w.find('[data-testid="reasoning-toggle"]').trigger('click')
    const body = w.find('[data-testid="reasoning-body"]')
    expect(body.exists()).toBe(true)
    // 长文滚动:overflow-y-auto + max-h 限高类
    expect(body.classes()).toContain('overflow-y-auto')
    expect(body.classes().some((c) => c.startsWith('max-h-'))).toBe(true)
    expect(body.text()).toContain('思考第 59 行')
  })
})

describe('ReasoningBlock — streaming 三态', () => {
  it('streaming=true:自动展开、标题切「思考中…」、容器挂流光类', () => {
    const w = mountBlock({ text: '正在推理…', streaming: true })
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(true)
    expect(w.find('[data-testid="reasoning-title"]').text()).toBe('思考中…')
    expect(w.find('[data-testid="reasoning-title"]').classes()).toContain(
      'reasoning-block__shimmer',
    )
  })

  it('streaming true→false:自动折叠,标题回落「深度思考」', async () => {
    const w = mountBlock({ text: '思考完成', streaming: true })
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(true)
    await w.setProps({ streaming: false })
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(false)
    expect(w.find('[data-testid="reasoning-title"]').text()).toBe('深度思考')
    expect(w.find('[data-testid="reasoning-title"]').classes()).not.toContain(
      'reasoning-block__shimmer',
    )
  })

  it('流式结束后用户手动展开不被 streaming=false 重复赋值打断', async () => {
    const w = mountBlock({ text: 'done', streaming: true })
    await w.setProps({ streaming: false }) // 自动折叠
    await w.find('[data-testid="reasoning-toggle"]').trigger('click') // 手动展开
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(true)
    await w.setProps({ text: 'done' }) // 同值更新,不应收起
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(true)
  })

  it('非 streaming 挂载初始即折叠(历史回放)', () => {
    const w = mountBlock({ text: '历史思考', streaming: false })
    expect(w.find('[data-testid="reasoning-body"]').exists()).toBe(false)
  })
})
