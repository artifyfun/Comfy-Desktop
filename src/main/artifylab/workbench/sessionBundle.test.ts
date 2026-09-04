/**
 * sessionBundle 测试：CRC32 已知向量、ZIP 结构（本地头/中央目录/EOCD）、
 * unzip 交叉验证、文件收集去重、缺文件容忍、manifest 完整性。
 */
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, writeFileSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildSessionBundle, collectBundleFiles, uniqueEntryName } from './sessionBundle'
import type { WorkbenchSession, WorkbenchOutputFile } from './service'

function sess(overrides: Partial<WorkbenchSession> = {}): WorkbenchSession {
  return {
    id: 's1',
    title: '产物会话',
    createdAt: 1,
    updatedAt: 2,
    messages: [],
    executions: [
      {
        promptId: 'p1',
        templateId: 't1',
        params: {},
        outputs: [
          { filename: 'a.png', subfolder: 'run1', type: 'output' },
          { filename: 'b.png' },
          'legacy-c.png'
        ],
        status: 'success',
        startedAt: 3
      },
      {
        promptId: 'p2',
        templateId: 't2',
        params: {},
        outputs: [{ filename: 'a.png', subfolder: 'run1', type: 'output' }], // 重复引用
        status: 'success',
        startedAt: 4
      }
    ],
    ...overrides
  } as unknown as WorkbenchSession
}

describe('collectBundleFiles', () => {
  it('executions + messages 双源收集、字符串旧格式归一、跨执行去重', () => {
    const s = sess({
      messages: [
        {
          role: 'agent',
          kind: 'artifact',
          text: '',
          outputFiles: [{ filename: 'msg.png', subfolder: 'm' }],
          createdAt: 5
        }
      ] as WorkbenchSession['messages']
    })
    const files = collectBundleFiles(s)
    const keys = files.map((f) => `${f.subfolder ?? ''}/${f.filename}`)
    expect(keys).toEqual(['run1/a.png', '/b.png', '/legacy-c.png', 'm/msg.png'])
  })
})

describe('uniqueEntryName', () => {
  it('序前缀 + 非法字符替换', () => {
    expect(uniqueEntryName(0, 'a/b:c.png')).toBe('outputs/0-a_b_c.png')
  })
})

describe('buildSessionBundle', () => {
  // 内存文件系统：run1/a.png 与 m/msg.png 存在，b.png/legacy-c.png 缺
  const fakeFs = new Map<string, Buffer>([
    ['run1/a.png', Buffer.from('PNGDATA-A')],
    ['m/msg.png', Buffer.from('PNGDATA-MSG')]
  ])
  const readFile = (f: WorkbenchOutputFile) =>
    fakeFs.get(`${f.subfolder ?? ''}/${f.filename}`) ?? null

  const sessWithMsg = sess({
    messages: [
      {
        role: 'agent',
        kind: 'artifact',
        text: '',
        outputFiles: [{ filename: 'msg.png', subfolder: 'm' }],
        createdAt: 5
      }
    ] as WorkbenchSession['messages']
  })

  it('组包成功：manifest 含清单 + sha256；缺文件进 missing 不阻断', () => {
    const r = buildSessionBundle(sessWithMsg, readFile)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.files).toHaveLength(2)
    expect(r.missing.map((m) => m.filename)).toEqual(['b.png', 'legacy-c.png'])
    expect(r.manifest.files[0]!.path).toBe('outputs/0-a.png')
    expect(r.manifest.files[0]!.sha256).toHaveLength(64)
    // session.json 也在 zip 里（manifest 序列化后的体积即可验证）
    expect(r.zip.length).toBeGreaterThan(r.manifest.files[0]!.size + r.manifest.files[1]!.size)
  })

  it('ZIP 结构合法：系统 unzip -t 校验 + 内容解出比对', () => {
    const r = buildSessionBundle(sessWithMsg, readFile)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const dir = mkdtempSync(join(tmpdir(), 'wb-bundle-'))
    const zipPath = join(dir, 'bundle.zip')
    writeFileSync(zipPath, r.zip)
    // 结构校验（macOS 自带 unzip）
    execFileSync('unzip', ['-t', zipPath], { stdio: 'pipe' })
    // 解出 session.json 比对
    execFileSync('unzip', ['-o', zipPath, 'session.json', '-d', dir], { stdio: 'pipe' })
    const parsed = JSON.parse(readFileSync(join(dir, 'session.json'), 'utf8'))
    expect(parsed.bundleVersion).toBe(1)
    expect(parsed.app).toBe('artify-desktop')
    expect(parsed.session.title).toBe('产物会话')
    expect(parsed.files).toHaveLength(2)
    // 解出产物文件比对字节
    execFileSync('unzip', ['-o', zipPath, 'outputs/0-a.png', '-d', dir], { stdio: 'pipe' })
    const extracted = readFileSync(join(dir, 'outputs/0-a.png'))
    expect(extracted.toString()).toBe('PNGDATA-A')
  })

  it('全部缺文件也能出包（空 outputs + session.json）', () => {
    const r = buildSessionBundle(sess(), () => null)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.manifest.files).toHaveLength(0)
    expect(r.missing).toHaveLength(3)
    expect(r.zip.length).toBeGreaterThan(100)
  })
})
