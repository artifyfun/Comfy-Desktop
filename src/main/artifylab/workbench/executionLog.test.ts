/**
 * executionLog 单测（候选 ② 的 test surface）：
 * record 构造约束 / markSuccess·markError 回填语义 / extractFiles 两层提取策略
 * （含修复「模板未声明输出节点 → 提取永远为空」的回归锁）。
 */
import { describe, it, expect } from 'vitest'
import {
  record,
  markSuccess,
  markError,
  extractFiles,
  MAX_EXECUTION_ERROR_CHARS
} from './executionLog'

describe('record', () => {
  it('缺省初始态：outputs=[]、status=queued、startedAt=now', () => {
    const before = Date.now()
    const e = record({ promptId: 'p1', templateId: 't1' })
    expect(e.outputs).toEqual([])
    expect(e.status).toBe('queued')
    expect(e.params).toEqual({})
    expect(e.startedAt).toBeGreaterThanOrEqual(before)
    expect(e.batchJobId).toBeUndefined()
  })

  it('显式字段透传：params/status/batchJobId', () => {
    const e = record({
      promptId: 'job-1',
      templateId: 't1',
      params: { batch: true },
      status: 'running',
      batchJobId: 'job-1'
    })
    expect(e.params).toEqual({ batch: true })
    expect(e.status).toBe('running')
    expect(e.batchJobId).toBe('job-1')
  })
})

describe('markSuccess / markError', () => {
  it('markSuccess：status=success + outputs 整体替换', () => {
    const e = record({ promptId: 'p', templateId: 't' })
    e.outputs = ['legacy-string']
    markSuccess(e, [{ filename: 'a.png', subfolder: 's', type: 'output' }])
    expect(e.status).toBe('success')
    expect(e.outputs).toEqual([{ filename: 'a.png', subfolder: 's', type: 'output' }])
  })

  it('markError：status=error + 错误截断到上限', () => {
    const e = record({ promptId: 'p', templateId: 't' })
    const long = 'x'.repeat(MAX_EXECUTION_ERROR_CHARS + 500)
    markError(e, long)
    expect(e.status).toBe('error')
    expect(e.error).toHaveLength(MAX_EXECUTION_ERROR_CHARS)
  })
})

describe('extractFiles', () => {
  const historyOutputs = {
    // 声明的输出节点（id 9）
    '9': {
      images: [
        { filename: 'img.png', subfolder: 'sub', type: 'output' },
        { filename: 'dup.png', subfolder: 'sub', type: 'output' }
      ]
    },
    // 未声明的节点（含不同键类型）
    '10': { images: [{ filename: 'extra.png' }] },
    '11': { gifs: [{ filename: 'anim.gif', subfolder: '' }] },
    '12': { audio: [{ filename: 'sfx.wav' }] },
    '13': { video: [{ filename: 'clip.mp4' }] },
    // 噪音形态：非数组/缺 filename
    '14': { images: 'not-array' },
    '15': { images: [{ subfolder: 'no-filename' }] }
  }

  it('第一层：paramsNodes 声明的输出节点优先命中', () => {
    const paramsNodes = [{ id: 9, category: 'output' as const, type: 'output', name: 'result' }]
    const files = extractFiles(paramsNodes, historyOutputs)
    expect(files.map((f) => f.filename)).toEqual(['img.png', 'dup.png'])
  })

  it('声明命中同一文件多次只保留一份（跨节点去重）', () => {
    const dupOutputs = {
      '9': { images: [{ filename: 'same.png', subfolder: 's' }] },
      '10': { images: [{ filename: 'same.png', subfolder: 's' }] }
    }
    const paramsNodes = [
      { id: 9, category: 'output' as const, type: 'output', name: 'a' },
      { id: 10, category: 'output' as const, type: 'output', name: 'b' }
    ]
    expect(extractFiles(paramsNodes, dupOutputs)).toHaveLength(1)
  })

  it('第二层（缺陷修复回归锁）：模板未声明输出 → 裸扫全部节点', () => {
    // 历史缺陷场景：paramsNodes 只声明输入（无 output 类别）→
    // 旧 extractOutputs 永远返回空 → 会话产物 0（真实事故）
    const files = extractFiles(undefined, historyOutputs)
    const names = files.map((f) => f.filename)
    expect(names).toContain('img.png')
    expect(names).toContain('extra.png')
    expect(names).toContain('anim.gif')
    expect(names).toContain('sfx.wav')
    expect(names).toContain('clip.mp4')
    // 噪音形态被忽略
    expect(names).not.toContain(undefined as unknown as string)
  })

  it('空/缺 history → 空数组', () => {
    expect(extractFiles(undefined, null)).toEqual([])
    expect(extractFiles(undefined, undefined)).toEqual([])
    expect(extractFiles(undefined, {})).toEqual([])
  })
})
