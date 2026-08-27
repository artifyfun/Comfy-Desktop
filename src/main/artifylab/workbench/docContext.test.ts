import { describe, it, expect } from 'vitest'
import { extractDocText, isDocumentAttachment, renderDocContext } from './docContext'

describe('docContext', () => {
  it('识别文档类附件', () => {
    expect(isDocumentAttachment('a.pdf')).toBe(true)
    expect(isDocumentAttachment('b.txt')).toBe(true)
    expect(isDocumentAttachment('c.md')).toBe(true)
    expect(isDocumentAttachment('d.json', 'application/json')).toBe(true)
    expect(isDocumentAttachment('e.png', 'image/png')).toBe(false)
    expect(isDocumentAttachment('f.mp4')).toBe(false)
  })

  it('txt 抽取 + 缓存 + spec 渲染', async () => {
    const buf = Buffer.from('赛博朋克风格的猫，霓虹灯下雨夜街道', 'utf-8')
    await extractDocText('docs/t.txt', buf, 't.txt')
    const ctx = renderDocContext([{ name: 'docs/t.txt', filename: 't.txt' }])
    expect(ctx).toContain('赛博朋克风格的猫')
    expect(ctx).toContain('用户上传的文档内容')
  })

  it('大文档截断', async () => {
    const big = Buffer.from('x'.repeat(30000), 'utf-8')
    await extractDocText('docs/big.txt', big, 'big.txt')
    const ctx = renderDocContext([{ name: 'docs/big.txt', filename: 'big.txt' }])
    expect(ctx).toContain('原文过长已截断')
    expect(ctx.length).toBeLessThan(30000)
  })

  it('图片类不进文档上下文', async () => {
    await extractDocText('docs/p.png', Buffer.from([1, 2, 3]), 'p.png')
    expect(renderDocContext([{ name: 'docs/p.png', filename: 'p.png' }])).toBe('')
  })

  it('坏 pdf 不抛错返回 undefined', async () => {
    const r = await extractDocText(
      'docs/bad.pdf',
      Buffer.from('not a pdf'),
      'bad.pdf',
      'application/pdf'
    )
    expect(r).toBeUndefined()
  })
})
