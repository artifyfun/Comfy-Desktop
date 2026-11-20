import { describe, it, expect, vi, afterEach } from 'vitest'
import { contentWithImages, outputThumbnails, type OutputFileRef } from './thumbnails'

// 输出目录/vi.mock 隔离（electron nativeImage 在 node 测试环境不可用，
// outputThumbnails 应优雅返回空数组——缩略图是增强，不阻断文本路径）
describe('thumbnails（产物回图）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('非图片/无产物 → 空数组（不做网络请求）', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    const cases: OutputFileRef[][] = [
      [],
      [{ filename: 'clip.mp4' }],
      [{ filename: 'anim.gif' }],
      [{ filename: '' }],
      undefined as unknown as OutputFileRef[]
    ]
    for (const files of cases) {
      expect(await outputThumbnails(files, 'http://127.0.0.1:8188')).toEqual([])
    }
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('非 Electron 环境（nativeImage 不可用）→ 优雅返回空数组', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(Buffer.from('png'), { status: 200 }))
    )
    const out = await outputThumbnails(
      [{ filename: 'a.png', subfolder: '', type: 'output' }],
      'http://x'
    )
    expect(out).toEqual([])
  })

  it('fetch 失败逐张跳过，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('comfy down')))
    const out = await outputThumbnails([{ filename: 'a.png' }], 'http://x')
    expect(out).toEqual([])
  })

  it('contentWithImages：text 清单在前、image content 随后', () => {
    const r = contentWithImages({ ok: true, outputs: [1] }, [
      { type: 'image', data: 'QUJD', mimeType: 'image/jpeg' }
    ])
    expect(r.content).toHaveLength(2)
    expect((r.content[0] as { type: string }).type).toBe('text')
    expect(JSON.parse((r.content[0] as { text: string }).text)).toEqual({ ok: true, outputs: [1] })
    expect(r.content[1]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' })
  })

  it('contentWithImages：无图时只有 text', () => {
    const r = contentWithImages({ ok: false }, [])
    expect(r.content).toHaveLength(1)
  })
})
