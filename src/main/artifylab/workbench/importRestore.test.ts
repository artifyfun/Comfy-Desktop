/**
 * importRestore 纯函数测试：写回路径安全（穿越拒绝）、引用回填、
 * 防覆盖前缀、缺 manifest 条目兜底。
 */
import { describe, it, expect } from 'vitest'
import path from 'node:path'
import { restoreBundleFiles, restoreOne, parseZipStore } from './importRestore'
import type { WorkbenchSession } from './service'

function sess(): WorkbenchSession {
  return {
    id: 'a1b2c3d4-xxxx',
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    messages: [
      {
        role: 'agent',
        kind: 'artifact',
        text: '',
        outputFiles: [{ filename: 'art.png', subfolder: 'run1' }],
        createdAt: 3
      }
    ],
    executions: [
      {
        promptId: 'p',
        templateId: 't',
        params: {},
        outputs: [{ filename: 'art.png', subfolder: 'run1', type: 'output' }, 'plain.png'],
        status: 'success',
        startedAt: 4
      }
    ]
  } as unknown as WorkbenchSession
}

describe('restoreOne', () => {
  it('合法路径：前缀 + 子目录 + 引用返回', () => {
    const writes: [string, Buffer][] = []
    const r = restoreOne(
      '/out',
      'wb-import-a1b2c3d4',
      { filename: 'a.png', subfolder: 'run1' },
      'outputs/0-a.png',
      Buffer.from('X'),
      (f, d) => writes.push([f, d]),
      () => {}
    )
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.target.subfolder).toBe('wb-import-a1b2c3d4/run1')
      expect(r.target.filename).toBe('a.png')
      expect(writes).toHaveLength(1)
      // 写回路径经 resolve 归一化（win32 下 '/out' 会吃当前盘符），期望值同构构造
      expect(writes[0]![0]).toBe(path.resolve('/out', 'wb-import-a1b2c3d4', 'run1', 'a.png'))
    }
  })
  it('路径穿越拒绝：manifest 注入 .. 的 subfolder', () => {
    const r = restoreOne(
      '/out',
      'wb-p',
      { filename: 'a.png', subfolder: '../../etc' },
      'outputs/0-a.png',
      Buffer.from('X'),
      () => {},
      () => {}
    )
    expect(r.ok).toBe(false)
  })
})

describe('restoreBundleFiles', () => {
  it('写回 + executions/messages 双向引用回填 + plain 字符串引用不动', () => {
    const s = sess()
    const written: string[] = []
    const entries = new Map<string, Buffer>([
      ['outputs/0-art.png', Buffer.from('PNG')],
      ['session.json', Buffer.from('{}')] // 非产物条目跳过
    ])
    const rr = restoreBundleFiles(
      s,
      '/out',
      [{ path: 'outputs/0-art.png', filename: 'art.png', subfolder: 'run1' }],
      entries,
      (f) => written.push(f),
      () => {}
    )
    expect(rr.restored).toHaveLength(1)
    expect(rr.skipped).toBe(0)
    expect(written).toEqual([path.resolve('/out', 'wb-import-a1b2c3d4', 'run1', 'art.png')])
    // 回填：executions.outputs 指向新位置；字符串引用原样
    const ex = s.executions[0]!
    expect(ex.outputs[0]).toEqual({
      filename: 'art.png',
      subfolder: 'wb-import-a1b2c3d4/run1',
      type: 'output'
    })
    expect(ex.outputs[1]).toBe('plain.png')
    // messages.outputFiles 同步回填
    expect(s.messages[0]!.outputFiles![0]).toEqual({
      filename: 'art.png',
      subfolder: 'wb-import-a1b2c3d4/run1',
      type: 'output'
    })
  })
  it('manifest 无对应条目（孤儿产物文件）：entryName 兜底命名仍写回', () => {
    const s = sess()
    const entries = new Map([['outputs/9-orphan.png', Buffer.from('O')]])
    const rr = restoreBundleFiles(
      s,
      '/out',
      [],
      entries,
      () => {},
      () => {}
    )
    expect(rr.restored).toHaveLength(1)
    expect(rr.restored[0]!.filename).toBe('orphan.png')
  })
  it('写失败计入 skipped 不中断', () => {
    const s = sess()
    const entries = new Map([
      ['outputs/0-a.png', Buffer.from('A')],
      ['outputs/1-b.png', Buffer.from('B')]
    ])
    const rr = restoreBundleFiles(
      s,
      '/out',
      [
        { path: 'outputs/0-a.png', filename: 'a.png' },
        { path: 'outputs/1-b.png', filename: 'b.png' }
      ],
      entries,
      () => {
        throw new Error('disk full')
      },
      () => {}
    )
    expect(rr.restored).toHaveLength(0)
    expect(rr.skipped).toBe(2)
  })
})

// ---------- parseZipStore（A6：路由内联 ZIP 解析移入后的单测） ----------

/** 手工拼最小合法 STORE ZIP：本地头+数据 + 中央目录 + EOCD */
function buildStoreZip(entries: Array<[string, Buffer]>): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8')
    // 本地头（30B）：sig/version/flags/method/time/date/crc/csize/usize/namelen/extralen
    const lh = Buffer.alloc(30)
    lh.writeUInt32LE(0x04034b50, 0)
    lh.writeUInt16LE(20, 4)
    lh.writeUInt16LE(0, 6)
    lh.writeUInt16LE(0, 8) // STORE
    lh.writeUInt16LE(0, 10)
    lh.writeUInt16LE(0, 12)
    lh.writeUInt32LE(0, 14) // crc 略
    lh.writeUInt32LE(data.length, 18)
    lh.writeUInt32LE(data.length, 22)
    lh.writeUInt16LE(nameBuf.length, 26)
    lh.writeUInt16LE(0, 28)
    locals.push(lh, nameBuf, data)
    // 中央目录（46B）
    const ch = Buffer.alloc(46)
    ch.writeUInt32LE(0x02014b50, 0)
    ch.writeUInt16LE(20, 4)
    ch.writeUInt16LE(20, 6)
    ch.writeUInt16LE(0, 8)
    ch.writeUInt16LE(0, 10) // STORE
    ch.writeUInt32LE(0, 16)
    ch.writeUInt32LE(data.length, 20)
    ch.writeUInt32LE(data.length, 24)
    ch.writeUInt16LE(nameBuf.length, 28)
    ch.writeUInt16LE(0, 30)
    ch.writeUInt16LE(0, 32)
    ch.writeUInt32LE(offset, 42)
    centrals.push(ch, nameBuf)
    offset += 30 + nameBuf.length + data.length
  }
  const cd = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(cd.length, 12)
  eocd.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, eocd])
}

describe('parseZipStore', () => {
  it('合法 STORE zip：条目名→数据 完整解出', () => {
    const zip = buildStoreZip([
      ['session.json', Buffer.from('{"a":1}')],
      ['outputs/1-1.png', Buffer.from([1, 2, 3, 4])]
    ])
    const m = parseZipStore(zip)
    expect(m).not.toBeNull()
    expect(m!.get('session.json')?.toString()).toBe('{"a":1}')
    expect(Array.from(m!.get('outputs/1-1.png')!)).toEqual([1, 2, 3, 4])
  })

  it('非 zip / 过短输入 → null', () => {
    expect(parseZipStore(Buffer.from('hello world not a zip'))).toBeNull()
    expect(parseZipStore(Buffer.alloc(10))).toBeNull()
  })
})
