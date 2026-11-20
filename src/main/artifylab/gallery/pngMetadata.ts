import fs from 'node:fs'
import extractChunks from 'png-chunks-extract'

/**
 * 从 ComfyUI 输出的 PNG 中读取内嵌元数据。
 *
 * ComfyUI 会把生成参数写入 PNG tEXt chunk：
 * - `prompt`  ：API 格式的完整 prompt（可直接 POST /prompt 复原生成）
 * - `workflow`：UI 格式的 workflow（可拖回 ComfyUI 画布继续编辑）
 *
 * 这样扫描入库的存量图片也能补全“复制/下载工作流”，不依赖前端上报。
 */
export function extractPngMetadata(filepath: string): { prompt?: string; workflow?: string } {
  try {
    const buf = fs.readFileSync(filepath)
    const chunks = extractChunks(buf)
    const result: { prompt?: string; workflow?: string } = {}
    for (const chunk of chunks) {
      if (chunk.name !== 'tEXt') continue
      const data = Buffer.from(chunk.data)
      const nul = data.indexOf(0)
      if (nul < 0) continue
      const keyword = data.subarray(0, nul).toString('utf8')
      const text = data.subarray(nul + 1).toString('utf8')
      if (keyword === 'prompt' && !result.prompt) {
        result.prompt = text
      } else if (keyword === 'workflow' && !result.workflow) {
        result.workflow = text
      }
    }
    return result
  } catch {
    // 非 PNG / 损坏 / 无元数据都静默，调用方已有兜底
    return {}
  }
}
