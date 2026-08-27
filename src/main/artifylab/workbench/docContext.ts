/**
 * 文档附件内容抽取:让 decide 的大模型能真正"读到"用户上传的文档。
 *
 * 设计:
 * - pdf 走 unpdf(pdf.js 的 serverless 封装,零原生依赖);txt/md/json/csv
 *   等纯文本直接按 utf-8 读
 * - 抽取在上传时执行一次,文本存内存 Map(按 attachment name 键),会话级
 *   生命周期——执行链路(ComfyUI)不消费文档,无需持久化
 * - 超限截断:单文档 MAX_DOC_CHARS,避免大文档挤爆决策 spec 上下文
 */
import { extractText, getDocumentProxy } from 'unpdf'

/** 单文档注入 spec 的最大字符数(约 12k 汉字/24k 英文 token 量级) */
const MAX_DOC_CHARS = 24_000
/** 内存缓存上限(文档数),LRU 语义由 Map 插入序近似 */
const MAX_CACHED_DOCS = 20

const docTextCache = new Map<string, string>()

const TEXT_LIKE = /\.(txt|md|markdown|json|csv|log|xml|yml|yaml)$/i

export function isDocumentAttachment(filename: string, mime?: string): boolean {
  if (TEXT_LIKE.test(filename)) return true
  if (/^text\//i.test(mime ?? '')) return true
  if (/pdf/i.test(mime ?? '') || /\.pdf$/i.test(filename)) return true
  return false
}

/** 抽取并缓存;失败返回 undefined(上传不因抽取失败而失败) */
export async function extractDocText(
  key: string,
  buffer: Buffer,
  filename: string,
  mime?: string
): Promise<string | undefined> {
  try {
    let text: string | undefined
    if (/pdf/i.test(mime ?? '') || /\.pdf$/i.test(filename)) {
      const pdf = await getDocumentProxy(new Uint8Array(buffer))
      const { text: pages } = await extractText(pdf, { mergePages: true })
      // unpdf 类型重载在 mergePages 下标记 string,但运行时需防御两种形态
      text = Array.isArray(pages) ? pages.join('\n\n') : String(pages)
    } else if (TEXT_LIKE.test(filename) || /^text\//i.test(mime ?? '')) {
      text = buffer.toString('utf-8')
    }
    if (!text) return undefined
    text = text.trim()
    if (text.length > MAX_DOC_CHARS) {
      text = text.slice(0, MAX_DOC_CHARS) + '\n…(原文过长已截断)'
    }
    docTextCache.set(key, text)
    if (docTextCache.size > MAX_CACHED_DOCS) {
      const oldest = docTextCache.keys().next().value
      if (oldest) docTextCache.delete(oldest)
    }
    return text
  } catch (e) {
    return undefined
  }
}

export function getCachedDocText(key: string): string | undefined {
  return docTextCache.get(key)
}

/** 供 decide spec 注入的文档段落 */
export function renderDocContext(
  attachments: readonly { name: string; filename: string }[]
): string {
  const parts: string[] = []
  for (const a of attachments) {
    const text = docTextCache.get(a.name)
    if (!text) continue
    parts.push(`### 文档:${a.filename}\n${text}`)
  }
  if (parts.length === 0) return ''
  return `\n## 用户上传的文档内容(可据此理解需求/提炼提示词/总结)\n${parts.join('\n\n')}`
}
