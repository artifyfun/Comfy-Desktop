// @vitest-environment node
/**
 * 模板 id 口径契约测试（2026-09-15 统一）。
 *
 * 同一实体有两种表示，此前靠各处手写 `app:${x}` 拼接，出过两次真实故障：
 *   ① `wb_app_versions` 只认裸 uuid → 模型拿 `wb_list_templates` 的 id 查版本必失败
 *      （全功能回归 R-B2 真机抓到）
 *   ② `wb_publish_workflow` / `wb_app_versions` **输出裸 uuid** → 再喂给
 *      `wb_execute_template`（它按 `templateLibrary.get` 精确匹配 `app:` 口径）会失败
 *
 * 本文件把契约钉死：**转换只走 toTemplateId/toAppId 两个函数，且任一函数产出的
 * 规范 id 必须能被模板库命中**。用真实的 `templateLibrary`（只轻量 mock appStore），
 * 所以它测的是**模块间的真实接缝**，而不是各自自洽。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { App } from '../appStore'

const h = vi.hoisted(() => ({ apps: [] as App[] }))

vi.mock('electron', () => ({ app: { getPath: () => '/tmp', getAppPath: () => '' } }))
vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))
// templates.ts 只用到 getAllApps() 与 on('change')，轻量 mock 即可驱动真实单例
vi.mock('../appStore', () => ({
  default: { getAllApps: () => h.apps, on: vi.fn() }
}))

import { APP_TEMPLATE_PREFIX, toAppId, toTemplateId, templateFromApp } from './templateCore'
import { templateLibrary } from './templates'

const UUID = '9c1f4a2e-7b3d-4e6f-8a1b-2c3d4e5f6a7b' // 真实的 appStore 键形态（裸 uuid）

function appFixture(id: string, name = '测试模板'): App {
  return {
    id,
    name,
    createdAt: 0,
    updatedAt: 0,
    template: {
      prompt: {
        '3': { class_type: 'KSampler', inputs: { seed: 1, steps: 20 } },
        '9': { class_type: 'SaveImage', inputs: { images: ['3', 0] } }
      },
      paramsNodes: [{ id: 3, category: 'input', type: 'number', name: 'seed' }]
    }
  } as unknown as App
}

beforeEach(() => {
  h.apps = []
})

describe('toTemplateId / toAppId（唯一的口径转换入口）', () => {
  it('裸 uuid → 规范模板 id', () => {
    expect(toTemplateId(UUID)).toBe(APP_TEMPLATE_PREFIX + UUID)
  })

  it('已带前缀 → 幂等（不会产出 app:app:...）', () => {
    expect(toTemplateId('app:' + UUID)).toBe('app:' + UUID)
  })

  it('空/空白 → 空串（不产出孤零零的 "app:"）', () => {
    expect(toTemplateId('')).toBe('')
    expect(toTemplateId('   ')).toBe('')
  })

  it('规范 id → 裸 uuid；无前缀原样返回', () => {
    expect(toAppId('app:' + UUID)).toBe(UUID)
    expect(toAppId(UUID)).toBe(UUID)
  })

  it('历史脏值 app:app:x 也能归一（这类双前缀真实出现过）', () => {
    expect(toAppId('app:app:' + UUID)).toBe(UUID)
  })

  it('往返一致', () => {
    expect(toAppId(toTemplateId(UUID))).toBe(UUID)
    expect(toTemplateId(toAppId('app:' + UUID))).toBe('app:' + UUID)
  })
})

describe('模板库 id 契约（工具输出必须能被模板库命中）', () => {
  it('templateFromApp 产出的 id 就是 toTemplateId(app.id)——两侧同一口径的根据', () => {
    const app = appFixture(UUID)
    const t = templateFromApp(app)!
    expect(t.id).toBe(toTemplateId(app.id))
  })

  it('规范 id 精确命中', () => {
    h.apps = [appFixture(UUID)]
    expect(templateLibrary.get(toTemplateId(UUID))?.id).toBe('app:' + UUID)
  })

  it('裸 uuid 也命中（容忍 appStore 口径/旧客户端值）', () => {
    h.apps = [appFixture(UUID)]
    expect(templateLibrary.get(UUID)?.id).toBe('app:' + UUID)
  })

  it('不存在的 id 仍返回 null（容忍不等于放行）', () => {
    h.apps = [appFixture(UUID)]
    expect(templateLibrary.get('app:nope')).toBeNull()
    expect(templateLibrary.get('nope')).toBeNull()
  })

  it('wb_execute_template 的解析路径：工具输出的 app_id → templateLibrary.get 必命中', () => {
    // 模拟 appStore 层拿到裸 uuid（publishWorkflow/createApp 的真实返回），
    // 工具按约定用 toTemplateId 包装后下发；这里断言该值一定可执行。
    h.apps = [appFixture(UUID)]
    const toolWouldReturn = toTemplateId(UUID)
    expect(templateLibrary.get(toolWouldReturn)).toBeTruthy()
  })

  it('会话级与内置命名空间不受影响（session: / builtin: 不会被误加前缀）', () => {
    // toTemplateId 只处理 app 前缀语义：非 app 值加了前缀也不会命中任何模板，
    // 因此模板库对 session:/builtin: 必须走精确匹配分支（此处验证精确分支仍在）
    h.apps = [appFixture(UUID)]
    expect(templateLibrary.get('session:s1:1')).toBeNull()
    expect(templateLibrary.get('builtin:txt2img')).toBeNull()
  })
})
