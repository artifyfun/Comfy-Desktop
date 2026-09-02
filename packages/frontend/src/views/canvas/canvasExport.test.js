import { describe, it, expect } from 'vitest'
import { buildExportPayload, packExportZip, parseImportZip, parseImportJson } from './canvasExport'

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
