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

/**
 * 节点级导出（P2）：选中图片物件 → 纯图片 ZIP。
 * 只收 persist/src 为 dataURL 或 http(s) 的 image 节点；返回 null 表示无可导出内容。
 * 文件名 = 净化后的 prompt/名称（去 mention 标记）或 id，序号去重。
 */
export async function buildSelectionZip(objects, opts = {}) {
  const imgs = (objects || []).filter((o) => o?.type === 'image' && (o.persist || o.src))
  if (!imgs.length) return null
  const used = new Map()
  const zip = new JSZip()
  let added = 0
  for (const o of imgs) {
    const url = o.persist || o.src
    let entry = null
    if (typeof url === 'string' && url.startsWith('data:')) {
      entry = { data: dataUrlBase64(url), base64: true }
    } else if (opts.fetcher && typeof url === 'string') {
      // http(s)/blob：由调用方注入 fetcher（保持纯函数可测）
      const b = await opts.fetcher(url)
      entry = { data: b, base64: false }
    }
    if (!entry) continue
    const name = selectionFileName(o, used)
    zip.file(name, entry.data, { base64: entry.base64 })
    added++
  }
  if (!added) return null
  return zip.generateAsync({ type: 'blob' })
}

/** 节点 → 规范文件名：prompt 前 24 字符（去 mention 标记/控制字符/路径分隔），
 *  冲突时叠加序号；保底 canvas-<id> */
export function selectionFileName(o, usedMap) {
  const clean = (v) =>
    String(v || '')
      .replace(/@\[[^\]]*\]\{[^}]*\}/g, '')
      .replace(/[\r\n\t]/g, ' ')
      .replace(/[\\/:*?"<>|]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  let base =
    clean(o.prompt || o.name || '')
      .slice(0, 24)
      .trim() ||
    clean(String(o.text || ''))
      .slice(0, 24)
      .trim()
  if (!base) base = 'canvas-' + (o.id || 'image')
  const ext = extOf(o.persist || o.src || '')
  let name = `${base}.${ext}`
  const used = usedMap || new Map()
  const n = (used.get(base) || 0) + 1
  used.set(base, n)
  if (n > 1) name = `${base}-${n}.${ext}`
  return name
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
