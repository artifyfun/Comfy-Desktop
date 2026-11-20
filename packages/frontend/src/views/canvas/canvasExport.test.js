import { describe, it, expect } from 'vitest'
import {
  buildExportPayload,
  packExportZip,
  parseImportZip,
  parseImportJson,
  buildSelectionZip,
  selectionFileName,
} from './canvasExport'
import JSZip from 'jszip'

const PNG_1PX =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function makeProj(id, withImage) {
  return {
    id,
    title: '画布 ' + id,
    createdAt: 1,
    updatedAt: 2,
    doc: {
      version: 2,
      name: '画布 ' + id,
      viewport: { scale: 1, x: 0, y: 0 },
      objects: withImage
        ? [
            {
              id: 'img1',
              type: 'image',
              x: 0,
              y: 0,
              width: 10,
              height: 10,
              src: 'blob:x',
              persist: PNG_1PX,
            },
            { id: 'n1', type: 'note', x: 50, y: 0, width: 10, height: 10, text: 'hi' },
          ]
        : [{ id: 'n1', type: 'note', x: 0, y: 0, width: 10, height: 10, text: 'hi' }],
      links: [],
      groups: [],
    },
  }
}

describe('buildExportPayload', () => {
  it('persist dataURL 抽出为文件引用，objects 其余字段保留', () => {
    const { payload, files } = buildExportPayload([makeProj('a', true)])
    expect(files).toHaveLength(1)
    expect(files[0].name.startsWith('files/')).toBe(true)
    const img = payload.projects[0].doc.objects.find((o) => o.id === 'img1')
    expect(img.persist.startsWith('__file__:')).toBe(true)
    expect(img.src).toBe('blob:x')
    expect(payload.app).toBe('artifylab-canvas')
  })
  it('非图片/无 persist 物件不动', () => {
    const { files } = buildExportPayload([makeProj('a', false)])
    expect(files).toHaveLength(0)
  })
})

describe('zip roundtrip', () => {
  it('导出→导入还原 dataURL', async () => {
    const { payload, files } = buildExportPayload([makeProj('a', true), makeProj('b', false)])
    const blob = await packExportZip(payload, files)
    const { projects } = await parseImportZip(blob)
    expect(projects).toHaveLength(2)
    const img = projects[0].doc.objects.find((o) => o.id === 'img1')
    expect(img.persist).toBe(PNG_1PX)
    expect(projects[0].title).toBe('画布 a')
  })
  it('缺 projects.json 报错', async () => {
    const JSZip = (await import('jszip')).default
    const blob = await new JSZip().file('other.txt', 'x').generateAsync({ type: 'blob' })
    await expect(parseImportZip(blob)).rejects.toThrow('missing')
  })
  it('app 标识不符报错', async () => {
    const blob = await packExportZip({ app: 'x', projects: [] }, [])
    await expect(parseImportZip(blob)).rejects.toThrow('not an artifylab')
  })
})

describe('parseImportJson', () => {
  it('裸数组兼容', () => {
    const { projects } = parseImportJson(JSON.stringify([makeProj('a', false)]))
    expect(projects).toHaveLength(1)
  })
  it('payload 形状兼容', () => {
    const { payload } = parseImportJson(
      JSON.stringify({ app: 'artifylab-canvas', version: 1, projects: [makeProj('a', false)] }),
    )
    expect(payload.version).toBe(1)
  })
  it('坏格式报错', () => {
    expect(() => parseImportJson('{"x":1}')).toThrow('unrecognized')
  })
})

// —— 节点级导出（P2）——
describe('buildSelectionZip / selectionFileName（P2）', () => {
  const PNG1x1 =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
  const mkImg = (id, extra = {}) => ({
    id,
    type: 'image',
    persist: PNG1x1,
    x: 0,
    y: 0,
    width: 10,
    height: 10,
    ...extra,
  })

  it('无 image 节点返回 null', async () => {
    expect(await buildSelectionZip([])).toBeNull()
    expect(await buildSelectionZip([{ id: 'a', type: 'note', text: 'x' }])).toBeNull()
  })
  it('打包 persist dataURL 为 zip（可被 parseImportZip 读回 base64）', async () => {
    const blob = await buildSelectionZip([mkImg('a'), mkImg('b')])
    expect(blob).toBeTruthy()
    // blob → arrayBuffer → jszip 读条目
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const names = Object.keys(zip.files)
    expect(names).toHaveLength(2)
    expect(names.every((n) => /\.(png|jpg)$/.test(n))).toBe(true)
    const raw = await zip.file(names[0]).async('base64')
    expect(raw.length).toBeGreaterThan(10)
  })
  it('无有效源的 image（persist 空 src 空）跳过', async () => {
    const blob = await buildSelectionZip([mkImg('a', { persist: '', src: '' })])
    expect(blob).toBeNull()
  })
  it('http 源走注入 fetcher', async () => {
    const fakeBlob = new Uint8Array([1, 2, 3])
    const blob = await buildSelectionZip([mkImg('h', { persist: '', src: 'https://x/y.png' })], {
      fetcher: async () => fakeBlob,
    })
    expect(blob).toBeTruthy()
    const zip = await JSZip.loadAsync(await blob.arrayBuffer())
    const entry = Object.values(zip.files)[0]
    expect(await entry.async('uint8array')).toEqual(fakeBlob)
  })
  it('selectionFileName：prompt 净化 + mention 剥离 + 冲突序号', () => {
    const used = new Map()
    expect(selectionFileName(mkImg('a', { prompt: 'a cute cat' }), used)).toBe('a cute cat.png')
    // 同名第二张 → 序号 2
    expect(selectionFileName(mkImg('b', { prompt: 'a cute cat' }), used)).toBe('a cute cat-2.png')
    // mention 标记剥离
    const m = selectionFileName(mkImg('c', { prompt: '@[风格]{s1} sunset' }), new Map())
    expect(m).toBe('sunset.png')
    // 非法字符清洗
    const dirty = selectionFileName(mkImg('d', { prompt: 'a/b:c*d?"e' }), new Map())
    expect(dirty).toBe('a b c d e.png')
    // 无 prompt → id 保底
    expect(selectionFileName(mkImg('n9'), new Map())).toBe('canvas-n9.png')
  })
})
