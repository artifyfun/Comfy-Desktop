/**
 * sessionTransfer 纯函数测试：导出剥离、导入校验/新 UUID/防撞/兜底。
 * 不触 Electron/IO——service 薄壳由路由层浏览器实测覆盖。
 */
import { describe, it, expect } from 'vitest'
import {
  exportSession,
  importSession,
  validateSessionFile,
  SESSION_EXPORT_SCHEMA_VERSION
} from './sessionTransfer'
import type { WorkbenchSession } from './service'
import type { SessionExportFile } from './sessionTransfer'

function buildSession(): WorkbenchSession {
  return {
    id: 'src-id-1',
    title: '测试会话',
    createdAt: 1700000000000,
    updatedAt: 1700000001000,
    messages: [
      {
        role: 'user',
        kind: 'chat',
        text: '画一只猫',
        turnId: 1,
        parentId: -1,
        createdAt: 1700000000100
      },
      {
        role: 'agent',
        kind: 'chat',
        text: '好的，这是计划…',
        turnId: 1,
        parentId: 0,
        createdAt: 1700000000500
      }
    ],
    executions: [
      {
        promptId: 'p1',
        templateId: 't1',
        params: { a: 1 },
        outputs: [{ filename: 'out.png', subfolder: 'x', type: 'output' }],
        status: 'success',
        startedAt: 1700000000200,
        batchJobId: 'job-9'
      }
    ],
    attachments: [{ name: 'ref.png', kind: 'image', size: 1234 }],
    presetId: 'preset-a',
    turnUsages: [
      {
        inputTokens: 10,
        cachedInputTokens: 2,
        outputTokens: 5,
        reasoningOutputTokens: 1,
        at: 1700000000800
      }
    ],
    debugLogs: [
      {
        seq: 1,
        ts: 1700000000900,
        effectiveInput: 'in',
        spec: 'spec'.repeat(1000),
        rawOutput: 'raw'.repeat(2000),
        plan: null,
        issues: []
      }
    ],
    turnSeq: 1,
    activeLeaf: 1
  } as unknown as WorkbenchSession
}

describe('exportSession', () => {
  it('剥离 debugLogs 与 batchJobId，保留会话主体与分支树', () => {
    const file = exportSession(buildSession())
    expect(file.schema).toBe(SESSION_EXPORT_SCHEMA_VERSION)
    expect(file.app).toBe('artify-desktop')
    expect(file.session.debugLogs).toBeUndefined()
    expect(file.session.executions[0]!.batchJobId).toBeUndefined()
    expect(file.session.messages).toHaveLength(2)
    expect(file.session.activeLeaf).toBe(1)
    expect(file.session.turnUsages).toHaveLength(1)
    expect(file.session.attachments).toHaveLength(1)
  })

  it('导出是深拷贝：改导出件不影响原对象', () => {
    const src = buildSession()
    const file = exportSession(src)
    file.session.title = '篡改'
    file.session.messages.length = 0
    expect(src.title).toBe('测试会话')
    expect(src.messages).toHaveLength(2)
  })
})

describe('validateSessionFile', () => {
  it('合法导出件通过', () => {
    expect(validateSessionFile(exportSession(buildSession()))).not.toBeNull()
  })
  it('非会话文件 / 缺骨架字段 / 未来 schema 版本 → null', () => {
    expect(validateSessionFile(null)).toBeNull()
    expect(validateSessionFile('{"foo":1}')).toBeNull()
    expect(validateSessionFile({ app: 'other', schema: 1, session: {} })).toBeNull()
    const future = exportSession(buildSession())
    ;(future as { schema: number }).schema = SESSION_EXPORT_VERSION_UNREACHABLE
    expect(validateSessionFile(future)).toBeNull()
  })
})

// 不可达的未来版本号（比当前 schema 大即可触发拒绝路径）
const SESSION_EXPORT_VERSION_UNREACHABLE = SESSION_EXPORT_SCHEMA_VERSION + 1

describe('importSession', () => {
  it('导入生成新 UUID、刷新 updatedAt、剥离本机态', () => {
    const file = exportSession(buildSession())
    const r = importSession(file, new Set())
    expect(r.ok).toBe(true)
    expect(r.session!.id).not.toBe('src-id-1')
    expect(r.session!.updatedAt).toBeGreaterThanOrEqual(file.exportedAt)
    expect(r.session!.debugLogs).toBeUndefined()
    expect(r.session!.executions[0]!.batchJobId).toBeUndefined()
    expect(r.session!.messages).toHaveLength(2)
    expect(r.session!.title).toBe('测试会话')
  })

  it('existingIds 防撞：导入多个同源文件 id 各不相同', () => {
    const file = exportSession(buildSession())
    const seen = new Set<string>()
    const a = importSession(file, seen)
    const b = importSession(file, seen)
    expect(a.ok && b.ok).toBe(true)
    expect(a.session!.id).not.toBe(b.session!.id)
  })

  it('缺 messages 骨架 → 校验拒绝（防导入畸形件）', () => {
    const file = exportSession(buildSession())
    delete (file.session as unknown as Record<string, unknown>).messages
    const r = importSession(file, new Set())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('not_session_file')
  })

  it('createdAt 缺失兜底：归一为导入时刻', () => {
    const file = exportSession(buildSession())
    ;(file.session as unknown as Record<string, unknown>).createdAt = 'bad' as unknown as number
    const r = importSession(file, new Set())
    expect(r.ok).toBe(true)
    expect(typeof r.session!.createdAt).toBe('number')
  })

  it('重复导入检测：同源已导入且未 force → duplicate + existing 摘要', () => {
    const file = exportSession(buildSession())
    const imported = [
      { importedFrom: file.originId, id: 'local-x', title: '已导入过', updatedAt: 123 }
    ]
    const r = importSession(file, new Set(), { imported })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('duplicate')
    expect(r.existing?.id).toBe('local-x')
    expect(r.existing?.title).toBe('已导入过')
  })

  it('force 重导放行：同源 force=true 正常生成新会话', () => {
    const file = exportSession(buildSession())
    const imported = [
      { importedFrom: file.originId, id: 'local-x', title: '已导入过', updatedAt: 123 }
    ]
    const r = importSession(file, new Set(), { force: true, imported })
    expect(r.ok).toBe(true)
    expect(r.session?.id).not.toBe('local-x')
  })

  it('导入件打 importedFrom 溯源（导出再导入后新会话可被检测）', () => {
    const file = exportSession(buildSession())
    const r = importSession(file, new Set())
    expect(r.ok).toBe(true)
    expect(r.session?.importedFrom).toBe(file.originId)
  })

  it('老导出件无 originId：validate 兜底 session.id 作锚点', () => {
    const file = exportSession(buildSession())
    const legacy = { ...file }
    delete (legacy as Partial<SessionExportFile>).originId
    const validated = validateSessionFile(legacy)
    expect(validated?.originId).toBe(file.session.id)
  })

  it('非法输入 → not_session_file，不落库', () => {
    expect(importSession({ nonsense: true }, new Set()).error).toBe('not_session_file')
  })
})
