/**
 * modelKnowledge Civitai seam 单测（A6）：fetch 注入后 search 不触网。
 * lmSettings 无配置时返回空 apiKey——请求照发（无 Authorization），
 * 断言焦点在 seam：fake fetch 收到请求并返回映射结果。
 */
import { describe, it, expect, afterEach } from 'vitest'
import { __setCivitaiFetchForTest, searchCivitaiModels } from './modelKnowledge'

afterEach(() => {
  __setCivitaiFetchForTest(null)
})

function okJson(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200 })
}

describe('searchCivitaiModels — civitaiFetch seam', () => {
  it('注入 fake fetch：不触网，结果映射 model_id/model_name/version', async () => {
    let seenUrl = ''
    __setCivitaiFetchForTest(async (input) => {
      seenUrl = String(input)
      return okJson({
        items: [
          {
            id: 42,
            name: 'Test LoRA',
            type: 'LORA',
            modelVersions: [{ id: 9, name: 'v1', baseModel: 'SDXL', trainedWords: ['trigger'] }]
          }
        ],
        metadata: { totalItems: 1 }
      })
    })
    const r = await searchCivitaiModels({ query: 'test-lora' })
    expect(seenUrl).toContain('/api/v1/models')
    expect(seenUrl).toContain('query=test-lora')
    expect(r.ok).toBe(true)
    expect(r.items).toHaveLength(1)
    expect(r.items[0]).toMatchObject({
      model_id: 42,
      model_name: 'Test LoRA',
      version_id: 9,
      base_models: ['SDXL']
    })
    expect(r.total).toBe(1)
  })

  it('fake 返回非 200 → ok:false + error 文案（不抛错，调用方按 ok 分支处理）', async () => {
    __setCivitaiFetchForTest(async () => new Response('boom', { status: 503 }))
    const r = await searchCivitaiModels({ query: 'x' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/civitai API 503/)
    expect(r.items).toEqual([])
  })
})
