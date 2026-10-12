/**
 * 产物缩略图回图（借鉴 ai-art-engine「多模态回图」设计，自用移植）：
 * 把 ComfyUI 产物以 MCP image content 随工具结果回给多模态客户端（codex /
 * Claude 等），agent 能直接「看」到自己生成的东西再决策——对应「四道关：
 * 肉眼开图」的自动化。
 *
 * 安全/体积约束：
 * - 只取前 4 张图片类产物（png/jpg/webp），非图片（mp4/gif）跳过；
 * - 经 Electron nativeImage 缩到最长边 512px、JPEG q70（一帧约数十 KB）；
 * - 单张失败静默跳过（缩略图是增强，不是主结果——文本清单始终完整返回）；
 * - 非 Electron 环境（单测）nativeImage 不可用 → 返回空数组，不影响文本路径。
 */
import electron from 'electron'
import { logger } from '../../utils/logger'

const MAX_IMAGES = 4

const MAX_EDGE = 512
const JPEG_QUALITY = 70

export interface McpImageContent {
  type: 'image'
  data: string
  mimeType: string
}

/** 产物文件形状（与 WorkbenchOutputFile 对齐的最小子集；容错历史 string 形态） */
export interface OutputFileRef {
  filename: string
  subfolder?: string
  type?: string
}

/** 归一化产物条目：旧记录可能存纯文件名字符串，统一成对象形态 */
function normalizeFiles(files: unknown): OutputFileRef[] {
  if (!Array.isArray(files)) return []
  return files
    .map((f): OutputFileRef | null => {
      if (typeof f === 'string') return { filename: f }
      if (f && typeof f === 'object' && typeof (f as OutputFileRef).filename === 'string') {
        return f as OutputFileRef
      }
      return null
    })
    .filter((f): f is OutputFileRef => f !== null)
}

/** 逐张取 ComfyUI /view → 缩到 512 → JPEG base64。失败逐张跳过。 */
export async function outputThumbnails(
  files: unknown,
  comfyHost: string
): Promise<McpImageContent[]> {
  const images = normalizeFiles(files)
    .filter((f) => /\.(png|jpe?g|webp)$/i.test(f.filename))
    .slice(0, MAX_IMAGES)
  if (images.length === 0) return []

  const nativeImage: typeof electron.nativeImage | undefined = (
    electron as unknown as { nativeImage?: typeof electron.nativeImage }
  ).nativeImage
  if (!nativeImage) return []

  const results = await Promise.all(
    images.map(async (f): Promise<McpImageContent | null> => {
      try {
        const qs = new URLSearchParams({
          filename: String(f.filename),
          subfolder: String(f.subfolder ?? ''),
          type: String(f.type ?? 'output')
        })
        const res = await fetch(`${comfyHost}/view?${qs}`)
        if (!res.ok) return null
        const buf = Buffer.from(await res.arrayBuffer())
        let img = nativeImage.createFromBuffer(buf)
        if (img.isEmpty()) return null
        const size = img.getSize()
        if (Math.max(size.width, size.height) > MAX_EDGE) {
          img =
            size.width >= size.height
              ? img.resize({ width: MAX_EDGE })
              : img.resize({ height: MAX_EDGE })
        }
        const jpeg = img.toJPEG(JPEG_QUALITY)
        if (jpeg.length === 0) return null
        return { type: 'image', data: jpeg.toString('base64'), mimeType: 'image/jpeg' }
      } catch (e) {
        logger.warn(`[wb] 产物缩略图获取失败: ${f.filename} ${String(e)}`)
        return null
      }
    })
  )
  return results.filter((r): r is McpImageContent => r !== null)
}

/** text + images 组装成 MCP content 数组（text 清单在前，缩略图随后） */
export function contentWithImages(
  payload: unknown,
  images: McpImageContent[]
): { content: unknown[] } {
  return {
    content: [
      { type: 'text', text: JSON.stringify(payload, null, 2) },
      ...images.map((im) => ({ type: 'image' as const, data: im.data, mimeType: im.mimeType }))
    ]
  }
}
