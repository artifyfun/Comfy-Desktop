// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import express from 'express'
import { createCanvasRouter, type CanvasDigestStore, type CheckpointStore } from './canvas'

/**
 * M4 canvas.debug 端点：POST /api/canvas/debug 纯分类无副作用。
 * 合同：error/nodeErrors 二选一必填；分类结果透传 errorClassifier。
 * 全部走本地临时端口 + 全局 fetch（与 canvas.ops.test.ts 同款，确定性无竞态）。
 */
describe('POST /api/canvas/debug', () => {
  let server: http.Server
  let baseUrl = ''
  // 声明即初始化：beforeEach 只重置字段不换对象（路由持有旧引用）
  const digestStore: CanvasDigestStore = { latest: null }
  const checkpointStore: CheckpointStore = { items: [], nextId: 1, rollbackTo: null, audit: [] }

  async function post(path: string, body?: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  }

  beforeAll(async () => {
    const app = express()
    app.use(express.json())
    app.use(createCanvasRouter(digestStore, checkpointStore))
    server = http.createServer(app)
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const addr = server.address() as AddressInfo
    baseUrl = `http://127.0.0.1:${addr.port}`
  })

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  beforeEach(() => {
    digestStore.latest = null
    checkpointStore.items = []
    checkpointStore.nextId = 1
    checkpointStore.rollbackTo = null
    checkpointStore.audit = []
  })

  it('缺模型 nodeErrors → missing_model + 下载指引', async () => {
    const res = await post('/api/canvas/debug', {
      nodeErrors: {
        4: {
          errors: [
            {
              type: 'value_not_in_list',
              message: 'Value not in list',
              details: "ckpt_name: 'v1-5-pruned-emaonly.safetensors' not in []",
              extra_info: { input_name: 'ckpt_name' }
            }
          ],
          class_type: 'CheckpointLoaderSimple'
        }
      }
    })
    expect(res.status).toBe(200)
    const d = (await res.json()).data
    expect(d.category).toBe('missing_model')
    expect(d.modelName).toBe('v1-5-pruned-emaonly.safetensors')
    expect(d.suggestion.kind).toBe('download_model')
  })

  it('error 文本 OOM → oom + 降参建议', async () => {
    const res = await post('/api/canvas/debug', {
      error: 'CUDA out of memory. Tried to allocate 2.5 GiB'
    })
    expect(res.status).toBe(200)
    expect((await res.json()).data.category).toBe('oom')
  })

  it('error 与 nodeErrors 都缺 → 400', async () => {
    const res = await post('/api/canvas/debug', {})
    expect(res.status).toBe(400)
  })

  it('bad_param 建议带 fixOps（可一键确认走 M2 通道）', async () => {
    const res = await post('/api/canvas/debug', {
      nodeErrors: {
        16: {
          errors: [
            {
              type: 'value_not_in_list',
              message: 'Value not in list',
              details: "sampler_name: 'nope' not in ['euler', 'heun']",
              extra_info: { input_name: 'sampler_name' }
            }
          ],
          class_type: 'KSampler'
        }
      }
    })
    expect(res.status).toBe(200)
    const d = (await res.json()).data
    expect(d.category).toBe('bad_param')
    expect(d.suggestion.fixOps).toEqual([
      { type: 'setWidget', nodeId: '16', widget: 'sampler_name', value: 'euler' }
    ])
  })

  it('枚举截断（list of length N）+ comfyOrigin → 反查 object_info 补 fixOps', async () => {
    // mock 一个最小 ComfyUI /object_info 服务
    const mock = http.createServer((req, res) => {
      if (req.url?.startsWith('/object_info/KSampler')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            KSampler: { input: { required: { sampler_name: [['euler', 'heun', 'dpm_2'], {}] } } }
          })
        )
        return
      }
      res.statusCode = 404
      res.end('{}')
    })
    await new Promise<void>((resolve) => mock.listen(0, '127.0.0.1', resolve))
    const mockAddr = mock.address() as AddressInfo

    try {
      const res = await post('/api/canvas/debug', {
        nodeErrors: {
          1: {
            errors: [
              {
                type: 'value_not_in_list',
                message: 'Value not in list',
                details: "sampler_name: 'nope_sampler' not in (list of length 44)",
                extra_info: { input_name: 'sampler_name' }
              }
            ],
            class_type: 'KSampler'
          }
        },
        comfyOrigin: `http://127.0.0.1:${mockAddr.port}`
      })
      expect(res.status).toBe(200)
      const d = (await res.json()).data
      expect(d.category).toBe('bad_param')
      expect(d.suggestion.fixOps).toEqual([
        { type: 'setWidget', nodeId: '1', widget: 'sampler_name', value: 'euler' }
      ])
      expect(d.suggestion.text).toContain('euler')
    } finally {
      await new Promise<void>((resolve) => mock.close(() => resolve()))
    }
  })

  it('枚举截断但 object_info 反查失败 → 保留纯文本建议不炸', async () => {
    const res = await post('/api/canvas/debug', {
      nodeErrors: {
        1: {
          errors: [
            {
              type: 'value_not_in_list',
              message: 'Value not in list',
              details: "sampler_name: 'nope_sampler' not in (list of length 44)",
              extra_info: { input_name: 'sampler_name' }
            }
          ],
          class_type: 'KSampler'
        }
      },
      comfyOrigin: 'http://127.0.0.1:1' // 不可达端口
    })
    expect(res.status).toBe(200)
    const d = (await res.json()).data
    expect(d.category).toBe('bad_param')
    expect(d.suggestion.fixOps).toBeUndefined()
  })
})
