/**
 * 画布项目导入导出（S2）——纯函数 + jszip
 *
 * 导出格式（ZIP）：
 *   projects.json : { app: 'artifylab-canvas', version: 1, exportedAt, projects: [...] }
 *   files/<n>.jpg : 图片物件的 persist dataURL 抽出为独立文件（瘦身 JSON），
 *                   objects[].persist 替换为 "__file__:<n>.jpg" 引用
 *
 * 导入：zip → 还原 dataURL → 逐项目 importProject 去重落地。
 * 全部纯函数可单测（Blob/URL.createObjectURL 仅在 IO 层）。
 */
import JSZip from 'jszip'

const EXPORT_APP = 'artifylab-canvas'
const FILE_PREFIX = '__file__:'

/** 项目集 → 导出 payload（persist dataURL 抽出） */
export function buildExportPayload(projects, now = new Date().toISOString()) {
  const files = [] // { name, dataUrl }
  const outProjects = (projects || []).map((p) => {
    const objects = (p.doc?.objects || []).map((o) => {
      if (o?.type !== 'image' || typeof o.persist !== 'string' || !o.persist.startsWith('data:')) {
        return o
      }
      const name = `files/img-${o.id || files.length}.${extOf(o.persist)}`
      files.push({ name, dataUrl: o.persist })
      return { ...o, persist: FILE_PREFIX + name }
    })
    return { ...p, doc: { ...p.doc, objects } }
  })
  return {
    payload: { app: EXPORT_APP, version: 1, exportedAt: now, projects: outProjects },
    files,
  }
}

/** 导出 payload + 文件 → ZIP Blob */
export async function packExportZip(payload, files) {
  const zip = new JSZip()
  zip.file('projects.json', JSON.stringify(payload, null, 2))
  for (const f of files || []) {
    zip.file(f.name, dataUrlBase64(f.dataUrl), { base64: true })
  }
  return zip.generateAsync({ type: 'blob' })
}

/** ZIP Blob/ArrayBuffer/Uint8Array → { payload, projects }（文件引用还原回 dataURL） */
export async function parseImportZip(input) {
  // 归一化：Blob（浏览器）→ ArrayBuffer；node 测试环境 jszip 不识别其 Blob
  const data = input && typeof input.arrayBuffer === 'function' ? await input.arrayBuffer() : input
  const zip = await JSZip.loadAsync(data)
  const jsonFile = zip.file('projects.json')
  if (!jsonFile) throw new Error('missing projects.json')
  const parsed = JSON.parse(await jsonFile.async('string'))
  if (!parsed || parsed.app !== EXPORT_APP || !Array.isArray(parsed.projects)) {
    throw new Error('not an artifylab canvas export')
  }
  // 读全部 files/ 为 dataURL
  const fileMap = new Map()
  const entries = Object.values(zip.files).filter((f) => !f.dir && f.name.startsWith('files/'))
  for (const entry of entries) {
    const base64 = await entry.async('base64')
    const mime = mimeOfName(entry.name)
    fileMap.set(entry.name, `data:${mime};base64,${base64}`)
  }
  const projects = parsed.projects.map((p) => {
    if (!p?.doc || !Array.isArray(p.doc.objects)) return p
    const objects = p.doc.objects.map((o) => {
      if (typeof o?.persist === 'string' && o.persist.startsWith(FILE_PREFIX)) {
        const name = o.persist.slice(FILE_PREFIX.length)
        const restored = fileMap.get(name)
        return restored ? { ...o, persist: restored } : { ...o, persist: '' }
      }
      return o
    })
    return { ...p, doc: { ...p.doc, objects } }
  })
  return { payload: parsed, projects }
}

/** 兼容裸 projects.json（非 zip）：对象直接当 payload */
export function parseImportJson(text) {
  const parsed = JSON.parse(text)
  if (Array.isArray(parsed)) {
    return {
      payload: { app: EXPORT_APP, version: 1, exportedAt: '', projects: parsed },
      projects: parsed,
    }
  }
  if (parsed && Array.isArray(parsed.projects)) {
    return { payload: parsed, projects: parsed.projects }
  }
  throw new Error('unrecognized import format')
}

function extOf(dataUrl) {
  if (dataUrl.startsWith('data:image/png')) return 'png'
  if (dataUrl.startsWith('data:image/webp')) return 'webp'
  return 'jpg'
}
function dataUrlBase64(dataUrl) {
  const i = dataUrl.indexOf(',')
  return i >= 0 ? dataUrl.slice(i + 1) : dataUrl
}
function mimeOfName(name) {
  if (name.endsWith('.png')) return 'image/png'
  if (name.endsWith('.webp')) return 'image/webp'
  return 'image/jpeg'
}
