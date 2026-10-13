/**
 * 宽工具面（借鉴 ai-art-engine：grab_video_frames / asset_qc 的多模态回图
 * 与资产体检设计，自用移植，ffmpeg 本地实现）。
 *
 * - wb_extract_frames：视频抽帧并**随响应回图**（最多 4 张 MCP image content
 *   直给多模态客户端）——agent 看「视频里到底发生了什么」的正路。视频来源
 *   两选一：本机绝对路径，或 ComfyUI 产物引用（filename/subfolder，经
 *   /view 代理取字节）。
 * - wb_asset_qc：图片「引擎就绪」体检（只读不改图）：透明覆盖率/半透明比/
 *   主体占比/主体贴边四指标，口径对齐 Qwen21 透明图验收（主体 40%+、
 *   半透明 <3%、贴边要报）。
 *
 * 约束：ffmpeg 缺失时明确返回 status: skipped + 提示（不静默失败）；单张
 * 帧解码失败跳过不阻断；纯分析逻辑（analyzeRgba）与解码解耦，可单测。
 */
import { spawn } from 'node:child_process'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import electron from 'electron'
import type { Tool } from '@modelcontextprotocol/sdk/types.js'
import type { WBToolFn } from './shared'
import { requireSession, text, unknownArgWarnings } from './shared'
import { logger } from '../../utils/logger'

// ==================== ffmpeg/ffprobe 探测与执行 ====================

let ffmpegProbeCache: boolean | null = null

/** ffmpeg 是否可用（探测一次缓存；--version 快速探活） */
export function hasFfmpeg(): Promise<boolean> {
  if (ffmpegProbeCache !== null) return Promise.resolve(ffmpegProbeCache)
  return new Promise((resolve) => {
    try {
      const p = spawn('ffmpeg', ['-version'], { stdio: 'ignore' })
      p.on('error', () => {
        ffmpegProbeCache = false
        resolve(false)
      })
      p.on('close', (code) => {
        ffmpegProbeCache = code === 0
        resolve(ffmpegProbeCache)
      })
    } catch {
      ffmpegProbeCache = false
      resolve(false)
    }
  })
}

function run(
  cmd: string,
  args: string[],
  timeoutMs = 60_000
): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    let stderr = ''
    const p = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] })
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs)
    p.stderr?.on('data', (d: Buffer) => {
      stderr += String(d)
      if (stderr.length > 8000) stderr = stderr.slice(-4000)
    })
    p.on('close', (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stderr })
    })
    p.on('error', (e) => {
      clearTimeout(timer)
      resolve({ code: -1, stderr: String(e) })
    })
  })
}

/** ffprobe 取视频时长秒（失败 null） */
async function probeDurationSeconds(file: string): Promise<number | null> {
  const { code, stderr } = await run('ffprobe', [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'csv=p=0',
    file
  ])
  if (code !== 0) {
    logger.warn('[media] ffprobe 失败:', stderr.slice(0, 300))
    return null
  }
  const v = parseFloat(stderr.trim().split(/\r?\n/)[0] ?? '')
  return Number.isFinite(v) && v > 0 ? v : null
}

// ==================== 视频来源解析 ====================

interface ResolvedMedia {
  /** 本机临时文件路径（ComfyUI 引用会先落到临时文件） */
  file: string
  cleanup: () => Promise<void>
}

/** 解析视频来源：绝对路径直用；filename/subfolder 经 ComfyUI /view 取字节落临时文件 */
async function resolveVideoSource(
  args: Record<string, unknown>
): Promise<ResolvedMedia | { error: string }> {
  const p = args.path ? String(args.path) : ''
  if (p) {
    if (path.isAbsolute(p)) return { file: p, cleanup: async () => {} }
    return { error: 'path 必须是本机绝对路径（或改用 filename/subfolder 引用 ComfyUI 产物）' }
  }
  const filename = args.filename ? String(args.filename) : ''
  if (!filename) return { error: 'path 与 filename/subfolder 至少提供一个' }
  try {
    const { default: appStoreManager } = await import('../../appStore')
    const qs = new URLSearchParams({
      filename,
      subfolder: String(args.subfolder ?? ''),
      type: String(args.type ?? 'output')
    })
    const res = await fetch(`${appStoreManager.getConfig().comfyHost}/view?${qs}`)
    if (!res.ok) return { error: `ComfyUI /view 取媒体失败（HTTP ${res.status}）：${filename}` }
    const buf = Buffer.from(await res.arrayBuffer())
    const dir = await mkdtemp(path.join(tmpdir(), 'wb-media-'))
    const file = path.join(dir, filename.replace(/[\\/:*?"<>|]/g, '_'))
    await writeFile(file, buf)
    return {
      file,
      cleanup: async () => {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    }
  } catch (e) {
    return { error: `取媒体失败: ${String(e)}` }
  }
}

// ==================== 抽帧 ====================

const MAX_FRAMES = 8
const MAX_FRAME_IMAGES = 4
const FRAME_JPEG_QUALITY = 70
const FRAME_MAX_EDGE = 512

interface FrameResult {
  at: number
  dataUrl?: undefined
  base64?: string
  error?: string
}

/** 在 timestamps 处抽帧 → nativeImage 缩 512 → JPEG base64 */
async function extractFrames(video: string, timestamps: number[]): Promise<FrameResult[]> {
  const nativeImage: typeof electron.nativeImage | undefined = (
    electron as unknown as { nativeImage?: typeof electron.nativeImage }
  ).nativeImage
  if (!nativeImage)
    return timestamps.map((at) => ({ at, error: 'nativeImage 不可用（非 Electron 环境）' }))
  const dir = await mkdtemp(path.join(tmpdir(), 'wb-frames-'))
  try {
    const results: FrameResult[] = []
    for (let i = 0; i < timestamps.length; i++) {
      const at = timestamps[i] ?? 0
      const out = path.join(dir, `f${i}.png`)
      const { code, stderr } = await run('ffmpeg', [
        '-ss',
        String(at),
        '-i',
        video,
        '-frames:v',
        '1',
        '-y',
        out
      ])
      if (code !== 0) {
        results.push({ at, error: stderr.split('\n').slice(-1)[0]?.slice(0, 120) })
        continue
      }
      const buf = await readFile(out).catch(() => null)
      if (!buf) {
        results.push({ at, error: '帧文件读取失败' })
        continue
      }
      let img = nativeImage.createFromBuffer(buf)
      if (img.isEmpty()) {
        results.push({ at, error: '帧解码失败' })
        continue
      }
      const size = img.getSize()
      if (Math.max(size.width, size.height) > FRAME_MAX_EDGE) {
        img =
          size.width >= size.height
            ? img.resize({ width: FRAME_MAX_EDGE })
            : img.resize({ height: FRAME_MAX_EDGE })
      }
      const jpeg = img.toJPEG(FRAME_JPEG_QUALITY)
      results.push(
        jpeg.length ? { at, base64: jpeg.toString('base64') } : { at, error: '帧编码失败' }
      )
    }
    return results
  } finally {
    rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

// ==================== 资产 QC 纯分析（可单测） ====================

export interface QcReport {
  width: number
  height: number
  /** alpha>0 像素占比（0~1） */
  coverage: number
  /** 半透明像素占全部像素比（0~1，Qwen21 口径 <0.03 为佳） */
  semiRatio: number
  /** 主体（alpha>16）bbox 占画面比（0~1，Qwen21 口径 0.4+ 为佳） */
  subjectRatio: number
  /** 主体 bbox 四边距画面边的距离比例（0=贴边） */
  margins: { left: number; right: number; top: number; bottom: number }
  touchesEdge: boolean
  hasAlpha: boolean
}

/**
 * RGBA 位图体检（纯函数）。bits 为 RGBA 字节序，width*height*4。
 */
export function analyzeRgba(bits: Uint8Array, width: number, height: number): QcReport {
  const total = width * height
  let cov = 0
  let semi = 0
  let minX = width
  let maxX = -1
  let minY = height
  let maxY = -1
  let hasAlpha = false
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const a = bits[(y * width + x) * 4 + 3] ?? 0
      if (a !== 255) hasAlpha = true
      if (a > 0) cov++
      if (a > 0 && a < 255) semi++
      if (a > 16) {
        if (x < minX) minX = x
        if (x > maxX) maxX = x
        if (y < minY) minY = y
        if (y > maxY) maxY = y
      }
    }
  }
  const noSubject = maxX < 0
  const bw = noSubject ? 0 : maxX - minX + 1
  const bh = noSubject ? 0 : maxY - minY + 1
  return {
    width,
    height,
    coverage: total ? cov / total : 0,
    semiRatio: total ? semi / total : 0,
    subjectRatio: total ? (bw * bh) / total : 0,
    margins: noSubject
      ? { left: 1, right: 1, top: 1, bottom: 1 }
      : {
          left: minX / width,
          right: (width - 1 - maxX) / width,
          top: minY / height,
          bottom: (height - 1 - maxY) / height
        },
    touchesEdge:
      !noSubject && (minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1),
    hasAlpha
  }
}

/** nativeImage → RGBA bytes（失败 null） */
function imageToRgba(
  nativeImage: typeof electron.nativeImage | undefined,
  buf: Buffer
): { bits: Uint8Array; width: number; height: number } | null {
  if (!nativeImage) return null
  const img = nativeImage.createFromBuffer(buf)
  if (img.isEmpty()) return null
  const size = img.getSize()
  const bitmap = img.getBitmap() as unknown as Buffer
  // getBitmap 返回 BGRA（Windows）——alpha 在第 4 字节，与 RGBA 的 alpha 位序一致；
  // QC 只用 alpha 通道与 bbox，不涉色彩，因此无需通道重排。
  return {
    bits: new Uint8Array(bitmap.buffer, bitmap.byteOffset, bitmap.byteLength),
    width: size.width,
    height: size.height
  }
}

function qcSuggestions(r: QcReport): string[] {
  const s: string[] = []
  if (r.hasAlpha) {
    if (r.subjectRatio < 0.4)
      s.push('主体占比 <40%（Qwen21 口径：主体不饱满/贴边嫌疑，建议重新抠图或扩画幅）')
    if (r.semiRatio >= 0.03)
      s.push(`半透明像素 ${(r.semiRatio * 100).toFixed(1)}% ≥3%（边缘白边晕/抗锯齿过多）`)
    if (r.touchesEdge) s.push('主体贴边（bbox 触及画面边缘），下游合成可能裁切')
  }
  return s
}

// ==================== 工具注册 ====================

export const mediaTools: Array<{ tool: Tool; fn: WBToolFn }> = [
  {
    tool: {
      name: 'wb_extract_frames',
      description:
        '视频抽帧并随响应回图（最多 4 张 image content，多模态客户端直接看到画面）：判断「视频里发生了什么」、找可用镜头、核对生成内容时用。视频来源二选一：本机绝对路径 path，或 ComfyUI 产物引用 filename/subfolder。帧取法：默认按时长均匀取 count 张；也可显式给 timestamps（秒）。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机视频绝对路径（与 filename 二选一）' },
          filename: { type: 'string', description: 'ComfyUI 产物文件名（与 path 二选一）' },
          subfolder: { type: 'string', description: 'ComfyUI 产物子目录（可选）' },
          type: { type: 'string', description: '产物类型（默认 output）' },
          count: { type: 'number', description: '均匀抽帧数（1~8，默认 4）' },
          timestamps: {
            type: 'array',
            items: { type: 'number' },
            description: '显式抽帧时间点（秒，最多 8 个）；给了就忽略 count'
          }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const warnings = unknownArgWarnings(args, [
        'path',
        'filename',
        'subfolder',
        'type',
        'count',
        'timestamps'
      ])
      if (!(await hasFfmpeg())) {
        return text({
          ok: false,
          status: 'skipped',
          error: 'ffmpeg 不可用（PATH 中未找到）。安装 ffmpeg 后重试。'
        })
      }
      const src = await resolveVideoSource(args)
      if ('error' in src) return text({ ok: false, error: src.error })
      try {
        const duration = await probeDurationSeconds(src.file)
        if (duration == null)
          return text({ ok: false, error: 'ffprobe 读取视频时长失败（文件不是有效视频？）' })
        const ts =
          Array.isArray(args.timestamps) && args.timestamps.length > 0
            ? (args.timestamps as unknown[])
                .slice(0, MAX_FRAMES)
                .map((v) => Math.max(0, Number(v ?? 0) || 0))
            : (() => {
                const n = Math.min(Math.max(1, Number(args.count) || 4), MAX_FRAMES)
                const step = duration / (n + 1)
                return Array.from({ length: n }, (_, i) => +(step * (i + 1)).toFixed(3))
              })()
        const frames = await extractFrames(src.file, ts)
        const listed = frames.map((f) => ({ at: f.at, ...(f.error ? { error: f.error } : {}) }))
        const images = frames
          .filter((f): f is { at: number; base64: string } => !!f.base64)
          .slice(0, MAX_FRAME_IMAGES)
          .map((f) => ({ type: 'image' as const, data: f.base64, mimeType: 'image/jpeg' }))
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ok: images.length > 0,
                  video: src.file,
                  duration_sec: +duration.toFixed(2),
                  frames: listed,
                  note: '前 4 帧画面已随本结果回传（image content）；更多帧请指定 timestamps 分次取。',
                  ...(warnings.length > 0 ? { warnings } : {})
                },
                null,
                2
              )
            },
            ...images
          ]
        }
      } finally {
        await src.cleanup()
      }
    }
  },
  {
    tool: {
      name: 'wb_asset_qc',
      description:
        '图片「引擎就绪」体检（只读不改图）：宽高 / 透明覆盖率 / 半透明比 / 主体占比 / 主体贴边，附口径建议（Qwen21 透明图标准：主体占比 40%+、半透明 <3%、贴边要报）。用于透明图/抠图产物入库前的质量把关。图片来源二选一：本机绝对路径 path，或 ComfyUI 产物引用 filename/subfolder。',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '本机图片绝对路径（与 filename 二选一）' },
          filename: { type: 'string', description: 'ComfyUI 产物文件名（与 path 二选一）' },
          subfolder: { type: 'string', description: 'ComfyUI 产物子目录（可选）' },
          type: { type: 'string', description: '产物类型（默认 output）' }
        },
        additionalProperties: false
      },
      annotations: { readOnlyHint: true }
    },
    fn: async (args, identity) => {
      requireSession(identity)
      const warnings = unknownArgWarnings(args, ['path', 'filename', 'subfolder', 'type'])
      const src = await resolveVideoSource(args)
      if ('error' in src) return text({ ok: false, error: src.error })
      try {
        const nativeImage: typeof electron.nativeImage | undefined = (
          electron as unknown as { nativeImage?: typeof electron.nativeImage }
        ).nativeImage
        const buf = await readFile(src.file)
        const decoded = imageToRgba(nativeImage, buf)
        if (!decoded)
          return text({
            ok: false,
            error: '图片解码失败（nativeImage 不支持该格式或非 Electron 环境）'
          })
        const report = analyzeRgba(decoded.bits, decoded.width, decoded.height)
        const suggestions = qcSuggestions(report)
        return text({
          ok: true,
          source: src.file,
          report: {
            ...report,
            coverage_pct: +(report.coverage * 100).toFixed(1),
            semi_pct: +(report.semiRatio * 100).toFixed(1),
            subject_pct: +(report.subjectRatio * 100).toFixed(1),
            margins_pct: {
              left: +(report.margins.left * 100).toFixed(1),
              right: +(report.margins.right * 100).toFixed(1),
              top: +(report.margins.top * 100).toFixed(1),
              bottom: +(report.margins.bottom * 100).toFixed(1)
            }
          },
          suggestions,
          verdict: suggestions.length === 0 ? 'pass' : 'warn',
          ...(warnings.length > 0 ? { warnings } : {})
        })
      } catch (e) {
        return text({ ok: false, error: `读取图片失败: ${String(e)}` })
      } finally {
        await src.cleanup()
      }
    }
  }
]
