// @vitest-environment happy-dom
// components/__tests__/progressCard.test.js — P1-B3 plan/进度任务卡单测
// 覆盖:todo 原生清单(勾选/计数/终态)/ activity 合成步骤(spinner/计数/detail
// 行级展开)/ running→auto open / 手动折叠 toggle / 空 items 兜底。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ProgressCard from '../ProgressCard.vue'

const mountCard = (props) => mount(ProgressCard, { props })

describe('ProgressCard — todo 原生清单模式', () => {
  const TODO_ITEMS = [
    { text: '选模板', completed: true },
    { text: '执行', completed: false },
  ]

  it('running 时自动展开,逐行 checkbox 语义,计数 done/total', () => {
    const w = mountCard({
      mode: 'todo',
      running: true,
      title: '任务进度',
      items: TODO_ITEMS,
    })
    expect(w.find('[data-testid="progress-body"]').exists()).toBe(true)
    const rows = w.findAll('[data-testid="progress-row"]')
    expect(rows).toHaveLength(2)
    // 完成的打勾 + 删除线,未完成空圈
    const checks = rows.map((r) => r.find('[data-testid="progress-todo-check"]').classes())
    expect(checks[0]).toContain('fa-circle-check')
    expect(checks[1]).toContain('fa-circle')
    expect(w.find('[data-testid="progress-count"]').text()).toBe('1/2')
    expect(w.find('[data-testid="progress-spinner"]').exists()).toBe(true)
  })

  it('done 兼容字段(done:true)与 completed:true 同语义;终态(全勾+非 running)header 出对勾', async () => {
    const w = mountCard({
      mode: 'todo',
      running: false,
      title: '任务进度',
      items: [
        { text: 'a', done: true },
        { text: 'b', completed: true },
      ],
    })
    // 非 running 挂载 → 默认折叠,header 显示全勾 + 2/2
    expect(w.find('[data-testid="progress-body"]').exists()).toBe(false)
    expect(w.find('[data-testid="progress-count"]').text()).toBe('2/2')
    expect(w.find('[data-testid="progress-header"]').find('.fa-check').exists()).toBe(true)
    expect(w.find('[data-testid="progress-spinner"]').exists()).toBe(false)
    // 点 header 展开正文,两行都打勾
    await w.find('[data-testid="progress-header"]').trigger('click')
    const checks = w
      .findAll('[data-testid="progress-row"]')
      .map((r) => r.find('[data-testid="progress-todo-check"]').classes())
    expect(checks.every((c) => c.includes('fa-circle-check'))).toBe(true)
  })

  it('空 items:计数 0/0,running 默认展开显示兜底文案不报错', () => {
    const w = mountCard({ mode: 'todo', running: true, title: '任务进度', items: [] })
    expect(w.find('[data-testid="progress-body"]').exists()).toBe(true) // running → 默认展开
    expect(w.find('[data-testid="progress-empty"]').exists()).toBe(true)
    expect(w.find('[data-testid="progress-count"]').text()).toBe('0/0')
  })

  it('手动折叠:running 态点击 header 收起,不再自动弹开', async () => {
    const w = mountCard({
      mode: 'todo',
      running: true,
      title: '任务进度',
      items: TODO_ITEMS,
    })
    await w.find('[data-testid="progress-header"]').trigger('click')
    expect(w.find('[data-testid="progress-body"]').exists()).toBe(false)
  })
})

describe('ProgressCard — activity 合成步骤模式', () => {
  const STEPS = [
    { label: '深度思考', icon: 'fa-brain', status: 'completed' },
    { label: 'ls -la', icon: 'fa-terminal', status: 'completed' },
    { label: 'npm test', icon: 'fa-terminal', status: 'in_progress', detail: 'running…' },
  ]

  it('completed 行对勾、in_progress 行 spinner;计数含在途', () => {
    const w = mountCard({
      mode: 'activity',
      running: true,
      title: '执行过程',
      steps: STEPS,
    })
    const labels = w.findAll('[data-testid="progress-step-label"]').map((x) => x.text())
    expect(labels).toEqual(['深度思考', 'ls -la', 'npm test'])
    expect(w.findAll('.animate-spin')).toHaveLength(2) // 头部运行态 1 + 当前步 1
    expect(w.find('[data-testid="progress-count"]').text()).toBe('2/3')
  })

  it('带 detail 的行点击展开 <pre>;无 detail 行点击不产生 detail', async () => {
    const w = mountCard({ mode: 'activity', running: true, title: '执行过程', steps: STEPS })
    // 点第 1 行(无 detail):无展开
    await w.findAll('[data-testid="progress-step-label"]')[0].trigger('click')
    expect(w.find('[data-testid="progress-step-detail"]').exists()).toBe(false)
    // 点第 3 行(有 detail):展开
    await w.findAll('[data-testid="progress-step-label"]')[2].trigger('click')
    const detail = w.find('[data-testid="progress-step-detail"]')
    expect(detail.exists()).toBe(true)
    expect(detail.text()).toBe('running…')
  })
})
