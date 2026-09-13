// @vitest-environment node
/**
 * wb_execute_template × 创作资产挂载集成测试（对标建议 #4 端到端）。
 *
 * 链路：wb_assets 登记资产 → wb_execute_template 传 asset_ids →
 * applyAssetMount 改写 plan.params（参考图/seed/参数）→ service.execute 收到
 * 的 plan 断言。校验层用真实 validatePlanLocal（不 mock），确保挂载产物真的
 * 能通过本地白名单校验。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  file: '',
  executedPlan: null as unknown,
  templates: [] as unknown[]
}))

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }))
vi.mock('../../../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

vi.mock('../../workbench/service', () => ({
  workbenchService: {
    getSession: vi.fn((id: string) => (id ? { id } : null)),
    listTemplates: vi.fn(() => h.templates),
    markOrchestrated: vi.fn(),
    syncTemplateToCanvas: vi.fn(),
    execute: vi.fn(async (_sid: string, plan: unknown) => {
      h.executedPlan = plan
      return { promptId: 'p-1', status: 'queued' }
    }),
    pollExecution: vi.fn(async () => ({
      status: 'success',
      outputs: {},
      outputsText: 'done'
    }))
  }
}))
vi.mock('../../appStore', () => ({ default: { getConfig: () => ({}) } }))
vi.mock('../../services/batchRunner', () => ({ listBatchQueue: () => [] }))

vi.mock('../../workbench/assetsStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../workbench/assetsStore')>()
  return { ...actual, assetsStore: new actual.AssetsStore({ storePath: () => h.file }) }
})

import { templateTools } from './templateTools'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from './shared'
import { assetsStore } from '../../workbench/assetsStore'

const execTool = templateTools.find((t) => t.tool.name === 'wb_execute_template')!

/** 真实形状的模板（校验层会用它校验参数） */
function makeTemplate(): unknown {
  return {
    id: 'app:t1',
    name: '角色出图',
    description: '',
    mediaType: 'image',
    prompt: {
      '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.png' } },
      '2': { class_type: 'KSampler', inputs: { seed: 0, steps: 20 } }
    },
    paramsNodes: [
      { id: '1', name: 'image1', category: 'input', renderComponent: 'image-uploader', type: 'string' },
      { id: '2', name: 'image2', category: 'input', renderComponent: 'image-uploader', type: 'string' },
      { id: '3', name: 'seed', category: 'input', renderComponent: 'number', type: 'INT' },
      { id: '4', name: 'steps', category: 'input', renderComponent: 'number', type: 'INT' }
    ],
    source: 'app',
    appId: 't1'
  }
}

function payload(res: unknown): Record<string, unknown> {
  return JSON.parse(
    (res as { content: Array<{ text: string }> }).content[0]!.text
  ) as Record<string, unknown>
}

let dir = ''

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wb-asset-mount-'))
  h.file = join(dir, 'assets.json')
  h.executedPlan = null
  h.templates = [makeTemplate()]
  assetsStore.invalidateCacheForTest()
  endWorkbenchToolContext('s1')
  beginWorkbenchToolContext('s1')
})

afterEach(() => {
  endWorkbenchToolContext('s1')
  rmSync(dir, { recursive: true, force: true })
})

describe('wb_execute_template × asset_ids', () => {
  it('资产参考图/seed/参数自动挂载进执行参数（名字引用）', async () => {
    assetsStore.save({
      name: '小美',
      kind: 'character',
      refs: ['face.png', 'body.png'],
      seed: 2609,
      params: { steps: 30 }
    })

    const out = payload(
      await execTool.fn(
        { template_id: 'app:t1', intent: 'image', asset_ids: ['小美'], wait: true },
        's1'
      )
    )

    expect(out.ok).toBe(true)
    const plan = h.executedPlan as { params: Record<string, unknown> }
    expect(plan.params.image1).toBe('face.png')
    expect(plan.params.image2).toBe('body.png')
    expect(plan.params.seed).toBe(2609)
    expect(plan.params.steps).toBe(30)

    // 回执：模型能看到挂了什么
    const applied = out.assets as Array<Record<string, unknown>>
    expect(applied[0]!.name).toBe('小美')
    expect(applied[0]!.slots).toEqual(['image1', 'image2'])
    expect(applied[0]!.seedApplied).toBe(2609)
    expect(applied[0]!.paramsApplied).toEqual(['steps'])
  })

  it('asset_ids 支持 id 与 camelCase 别名 assetIds', async () => {
    const saved = assetsStore.save({ name: '小美', refs: ['a.png'] }).asset

    await execTool.fn({ template_id: 'app:t1', asset_ids: [saved.id], wait: true }, 's1')
    expect((h.executedPlan as { params: Record<string, unknown> }).params.image1).toBe('a.png')

    h.executedPlan = null
    await execTool.fn({ template_id: 'app:t1', assetIds: ['小美'], wait: true }, 's1')
    expect((h.executedPlan as { params: Record<string, unknown> }).params.image1).toBe('a.png')
  })

  it('逗号串写法也收（模型输出形态不一）', async () => {
    assetsStore.save({ name: '小美', refs: ['a.png'] })
    assetsStore.save({ name: '小刚', refs: ['b.png'] })

    await execTool.fn({ template_id: 'app:t1', asset_ids: '小美,小刚', wait: true }, 's1')

    const params = (h.executedPlan as { params: Record<string, unknown> }).params
    expect(params.image1).toBe('a.png')
    expect(params.image2).toBe('b.png')
  })

  it('用户显式 params 优先于资产（不被覆盖）', async () => {
    assetsStore.save({ name: '小美', refs: ['face.png'], seed: 111, params: { steps: 30 } })

    await execTool.fn(
      {
        template_id: 'app:t1',
        asset_ids: ['小美'],
        params: { seed: 999, steps: 8 },
        wait: true
      },
      's1'
    )

    const params = (h.executedPlan as { params: Record<string, unknown> }).params
    expect(params.seed).toBe(999)
    expect(params.steps).toBe(8)
    expect(params.image1).toBe('face.png')
  })

  it('未找到的资产名 → 不阻断执行，asset_issues 提示模型改道', async () => {
    const out = payload(
      await execTool.fn({ template_id: 'app:t1', asset_ids: ['不存在'], wait: true }, 's1')
    )
    expect(out.ok).toBe(true)
    expect((out.asset_issues as string[]).some((s) => s.includes('未找到资产'))).toBe(true)
  })

  it('资产参数不被模板接受时 → 合成进 asset_issues（宽松语义，不硬拦）', async () => {
    assetsStore.save({
      name: '风格包',
      kind: 'style',
      refs: ['style.png'],
      params: { lora_trigger: 'cyberpunk' }
    })

    const out = payload(
      await execTool.fn({ template_id: 'app:t1', asset_ids: ['风格包'], wait: true }, 's1')
    )

    expect(out.ok).toBe(true)
    const issues = out.asset_issues as string[]
    expect(issues.some((s) => s.includes('资产参数未被模板接受') && s.includes('lora_trigger'))).toBe(
      true
    )
    // 参数仍被传入（宽松：executor 自行忽略）
    expect((h.executedPlan as { params: Record<string, unknown> }).params.image1).toBe('style.png')
  })

  it('未传 asset_ids → 行为与挂载前一致（params 原样）', async () => {
    const out = payload(
      await execTool.fn({ template_id: 'app:t1', params: { steps: 12 }, wait: true }, 's1')
    )
    expect(out.ok).toBe(true)
    expect(out.assets).toEqual([])
    expect((h.executedPlan as { params: Record<string, unknown> }).params).toEqual({ steps: 12 })
  })

  it('资产无参考图 → 只挂 seed/params，不占素材槽', async () => {
    assetsStore.save({ name: '纯风格', kind: 'style', refs: [], seed: 5, params: { steps: 25 } })

    const out = payload(
      await execTool.fn({ template_id: 'app:t1', asset_ids: ['纯风格'], wait: true }, 's1')
    )

    const params = (h.executedPlan as { params: Record<string, unknown> }).params
    expect(params.image1).toBeUndefined()
    expect(params.seed).toBe(5)
    const applied = (out.assets as Array<Record<string, unknown>>)[0]!
    expect(applied.slots).toEqual([])
  })

  it('校验失败时不执行、不挂载（stage=validation）', async () => {
    assetsStore.save({ name: '小美', refs: ['a.png'] })
    const out = payload(await execTool.fn({ template_id: '不存在的模板', asset_ids: ['小美'] }, 's1'))
    expect(out.ok).toBe(false)
    expect(out.stage).toBe('validation')
    expect(h.executedPlan).toBeNull()
  })
})
