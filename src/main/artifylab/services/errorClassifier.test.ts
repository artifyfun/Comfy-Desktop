import { describe, expect, it } from 'vitest'

import { classifyExecutionError, type ErrorInput } from './errorClassifier'

/**
 * canvas.debug 错误分类器合同：
 * - 缺模型（value_not_in_list + ckpt/lora/unet 目录词）→ missing_model + 指引（不可自动修——下载是重操作）
 * - 参数越界（value_not_in_list 非模型 / out_of_range / invalid seed）→ bad_param + setWidget 修复 ops
 * - 结构/连接（required_input_missing / Return type mismatch / 输出缺失）→ broken_graph + 建议人工/结构修复
 * - OOM（CUDA out of memory / Unable to allocate）→ oom + 降参建议
 * - 认证（Unauthorized / login）→ auth
 * - 其余 → unknown（原文透传，不乱给建议）
 */
describe('classifyExecutionError', () => {
  const base: ErrorInput = {}

  it('缺模型：ckpt_name not in [] → missing_model + 下载指引（无自动 ops）', () => {
    const r = classifyExecutionError({
      ...base,
      error: 'Value not in list',
      nodeErrors: {
        '4': {
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
    expect(r.category).toBe('missing_model')
    expect(r.nodeType).toBe('CheckpointLoaderSimple')
    expect(r.nodeId).toBe('4')
    expect(r.modelName).toBe('v1-5-pruned-emaonly.safetensors')
    expect(r.severity).toBe('blocking')
    expect(r.suggestion.fixOps).toBeUndefined()
    expect(r.suggestion.kind).toBe('download_model')
    expect(r.suggestion.text).toContain('v1-5-pruned-emaonly.safetensors')
  })

  it('参数越界：value_not_in_list 非模型输入 → bad_param + setWidget ops', () => {
    const r = classifyExecutionError({
      ...base,
      nodeErrors: {
        '16': {
          errors: [
            {
              type: 'value_not_in_list',
              message: 'Value not in list',
              details: "sampler_name: 'euler_wrong' not in ['euler', 'heun']",
              extra_info: { input_name: 'sampler_name' }
            }
          ],
          class_type: 'KSampler'
        }
      }
    })
    expect(r.category).toBe('bad_param')
    expect(r.suggestion.kind).toBe('param_fix')
    expect(r.suggestion.fixOps).toEqual([
      { type: 'setWidget', nodeId: '16', widget: 'sampler_name', value: 'euler' }
    ])
  })

  it('数值越界 out_of_range → bad_param（无具体建议值时 fixOps 为空）', () => {
    const r = classifyExecutionError({
      ...base,
      nodeErrors: {
        '16': {
          errors: [
            {
              type: 'out_of_range',
              message: 'Value outside range',
              details: 'steps: 99999 not in [1, 150]',
              extra_info: { input_name: 'steps' }
            }
          ],
          class_type: 'KSampler'
        }
      }
    })
    expect(r.category).toBe('bad_param')
    expect(r.suggestion.kind).toBe('param_fix')
    expect(r.suggestion.fixOps).toBeUndefined()
    expect(r.suggestion.text).toContain('steps')
  })

  it('连接缺失 required_input_missing → broken_graph', () => {
    const r = classifyExecutionError({
      ...base,
      nodeErrors: {
        '2': {
          errors: [
            {
              type: 'required_input_missing',
              message: 'Required input is missing',
              details: 'image',
              extra_info: { input_name: 'image' }
            }
          ],
          class_type: 'ImageInvert'
        }
      }
    })
    expect(r.category).toBe('broken_graph')
    expect(r.suggestion.kind).toBe('graph_fix')
    expect(r.nodeId).toBe('2')
  })

  it('OOM：exception_message CUDA out of memory → oom + 降参建议', () => {
    const r = classifyExecutionError({
      ...base,
      error: 'CUDA out of memory. Tried to allocate 2.5 GiB',
      nodeType: 'KSampler',
      nodeId: '16'
    })
    expect(r.category).toBe('oom')
    expect(r.suggestion.kind).toBe('param_fix')
    expect(r.suggestion.text).toContain('分辨率')
  })

  it('认证类 Unauthorized → auth + 登录指引', () => {
    const r = classifyExecutionError({
      ...base,
      error: 'OpenAIGPTImage1 #1: Unauthorized: Please login first to use this node.'
    })
    expect(r.category).toBe('auth')
    expect(r.suggestion.kind).toBe('manual')
    expect(r.suggestion.text).toContain('登录')
  })

  it('execution_error 摘要文本（无 node_errors）兜底解析 nodeType/nodeId', () => {
    const r = classifyExecutionError({
      ...base,
      error: 'KSampler #16: some custom failure',
      nodeType: 'KSampler',
      nodeId: '16'
    })
    expect(r.nodeType).toBe('KSampler')
    expect(r.nodeId).toBe('16')
    expect(r.category).toBe('unknown')
  })

  it('完全未知错误 → unknown + 原文透传', () => {
    const r = classifyExecutionError({ ...base, error: 'some weird crash xyz' })
    expect(r.category).toBe('unknown')
    expect(r.suggestion.kind).toBe('manual')
    expect(r.message).toContain('some weird crash xyz')
  })

  it('空输入安全', () => {
    const r = classifyExecutionError({})
    expect(r.category).toBe('unknown')
    expect(r.severity).toBe('blocking')
  })
})
