// @vitest-environment happy-dom
// __tests__/toolCallCard.test.js — C11 通用工具卡单测
// 覆盖:三状态渲染(running spinner / done 静默 / error 红)、args 折叠展开
// (默认折叠,JSON 美化)、result 长文截断 + 展开全部、wb_* 名称原样 /
// 约定名友好化、durationMs、#result 插槽覆盖。
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import ToolCallCard from '../ToolCallCard.vue'

const mountCard = (props) => mount(ToolCallCard, { props })

describe('ToolCallCard — 状态渲染', () => {
  it('running:spinner + 默认折叠 + wb_* 名称原样', () => {
    const w = mountCard({ name: 'wb_run_workflow', status: 'running' })
    expect(w.find('[data-testid="tool-card-status-running"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-card-status-done"]').exists()).toBe(false)
    expect(w.find('[data-testid="tool-card-name"]').text()).toBe('wb_run_workflow')
    // args 默认折叠
    expect(w.find('[data-testid="tool-card-detail"]').exists()).toBe(false)
  })

  it('done:静默对勾,无 spinner', () => {
    const w = mountCard({ name: 'wb_list_nodes', status: 'done', result: 'ok' })
    expect(w.find('[data-testid="tool-card-status-done"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-card-status-running"]').exists()).toBe(false)
  })

  it('error:红色警示,卡片描边变红,名称红色', () => {
    const w = mountCard({ name: 'wb_execute_template', status: 'error', result: 'boom' })
    expect(w.find('[data-testid="tool-card-status-error"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-card-status-running"]').exists()).toBe(false)
    expect(w.classes()).toContain('border-red-500/40')
    const nameCls = w.find('[data-testid="tool-card-name"]').classes()
    expect(nameCls).toContain('text-red-300')
  })

  it('status 缺省按 running 处理(store ensureToolMessage 先建 running 消息)', () => {
    const w = mountCard({ name: 'wb_run_workflow' })
    expect(w.find('[data-testid="tool-card-status-running"]').exists()).toBe(true)
  })
})

describe('ToolCallCard — 名称友好化', () => {
  it('约定名中文化(shell/file_change/web_search),原始名保留在 title', () => {
    for (const [name, label] of [
      ['shell', '终端命令'],
      ['file_change', '文件修改'],
      ['web_search', '网络搜索'],
    ]) {
      const w = mountCard({ name, status: 'done' })
      expect(w.find('[data-testid="tool-card-name"]').text()).toBe(label)
      expect(w.find('[data-testid="tool-card-name"]').attributes('title')).toBe(name)
    }
  })
})

describe('ToolCallCard — args 折叠展开', () => {
  it('默认折叠;点击 header 展开,JSON 字符串美化展示', async () => {
    const w = mountCard({
      name: 'shell',
      status: 'done',
      args: '{"command":"ls -la","cwd":"/tmp"}',
    })
    expect(w.find('[data-testid="tool-card-args"]').exists()).toBe(false)
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    expect(w.find('[data-testid="tool-card-detail"]').exists()).toBe(true)
    const argsText = w.find('[data-testid="tool-card-args"]').text()
    // 美化:键值换行缩进,不再是单行原始串
    expect(argsText).toContain('"command": "ls -la"')
    expect(argsText).toContain('\n')
    // 再次点击收起
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    expect(w.find('[data-testid="tool-card-detail"]').exists()).toBe(false)
  })

  it('args 为对象时同样美化', async () => {
    const w = mountCard({ name: 'wb_run_workflow', status: 'done', args: { id: 'wf1' } })
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    expect(w.find('[data-testid="tool-card-args"]').text()).toContain('"id": "wf1"')
  })

  it('非 JSON 字符串 args 原样展示不抛错', async () => {
    const w = mountCard({ name: 'shell', status: 'done', args: 'ls -la --color' })
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    expect(w.find('[data-testid="tool-card-args"]').text()).toBe('ls -la --color')
  })

  it('折叠态 preview 行:argsPreview prop 优先;缺省时按工具语义推导', () => {
    const explicit = mountCard({
      name: 'shell',
      status: 'running',
      argsPreview: 'npm test',
    })
    expect(explicit.find('[data-testid="tool-card-preview"]').text()).toBe('npm test')

    const derived = mountCard({
      name: 'web_search',
      status: 'running',
      args: JSON.stringify({ query: 'comfyui api' }),
    })
    expect(derived.find('[data-testid="tool-card-preview"]').text()).toBe('comfyui api')
  })
})

describe('ToolCallCard — result 截断', () => {
  it('短结果不截断;长结果截断 + 「展开全部」按钮切换全文', async () => {
    const short = mountCard({ name: 'wb_list_nodes', status: 'done', result: 'ok' })
    await short.find('[data-testid="tool-card-header"]').trigger('click')
    expect(short.find('[data-testid="tool-card-result"]').text()).toBe('ok')
    expect(short.find('[data-testid="tool-card-result-expand"]').exists()).toBe(false)

    const longText = 'x'.repeat(1000)
    const w = mountCard({ name: 'wb_list_nodes', status: 'done', result: longText })
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    const truncated = w.find('[data-testid="tool-card-result"]').text()
    expect(truncated.length).toBeLessThan(longText.length)
    expect(truncated.endsWith('…')).toBe(true)
    expect(w.find('[data-testid="tool-card-result-full"]').exists()).toBe(false)

    await w.find('[data-testid="tool-card-result-expand"]').trigger('click')
    expect(w.find('[data-testid="tool-card-result-full"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-card-result-full"]').text()).toBe(longText)
    expect(w.find('[data-testid="tool-card-result-expand"]').exists()).toBe(false)
  })

  it('#result 具名插槽覆盖默认渲染', async () => {
    const w = mount(ToolCallCard, {
      props: { name: 'shell', status: 'done', result: 'raw' },
      slots: { result: '<b data-testid="custom-result">CUSTOM</b>' },
    })
    await w.find('[data-testid="tool-card-header"]').trigger('click')
    expect(w.find('[data-testid="custom-result"]').exists()).toBe(true)
    expect(w.find('[data-testid="tool-card-result"]').exists()).toBe(false)
  })

  it('durationMs:done 态展示耗时,running 态不展示', () => {
    const done = mountCard({ name: 'shell', status: 'done', durationMs: 1500 })
    expect(done.find('[data-testid="tool-card-duration"]').text()).toBe('1.5s')
    const ms = mountCard({ name: 'shell', status: 'done', durationMs: 250 })
    expect(ms.find('[data-testid="tool-card-duration"]').text()).toBe('250ms')
    const running = mountCard({ name: 'shell', status: 'running', durationMs: 1500 })
    expect(running.find('[data-testid="tool-card-duration"]').exists()).toBe(false)
  })
})
