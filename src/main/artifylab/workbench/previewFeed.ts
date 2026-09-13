/**
 * ComfyUI 生成过程预览（对标建议 #5）——本地引擎独有的"边算边看"。
 *
 * 背景：ComfyUI 在采样过程中通过 WebSocket（`/ws?clientId=`）推送 latent 预览帧
 * （`b64_preview` JSON 帧，或旧版的二进制 JPEG 帧）。此前我们只轮询 `/history`
 * 拿终态产物，用户看不到"正在画什么"。
 *
 * 本模块做两件事，均为纯逻辑 + 可注入依赖（单测不需要真 ComfyUI）：
 *  1) `startPreviewFeed`：订阅某次执行（clientId）的预览帧，按 minIntervalMs
 *     节流后回调；终态/超时/帧数上限自动关闭，不重连（预览是尽力而为）。
 *  2) `PreviewHub`：按 promptId 缓存最新帧，供既有轮询通道（service.pollExecution）
 *     顺带取走——执行发生在 run 结束之后，跑不回原 SSE，复用轮询是最小改动。
 *
 * 为什么不做独立 SSE：AG-UI 的 run 在提交执行时就已 finishRun，预览发生在之后，
 * 前端本来就在 pollExecution（2–3s 一次），帧速与之匹配即可，零新通道。
 */
import { logger } from '../utils/logger'

/** 采集到的预览帧 */
export interface PreviewFrame {
  promptId: string
  /** 可直接给 <img src> 的 data URL */
  dataUrl: string
  /** 采集时间戳（ms） */
  at: number
}

/** 最小 WebSocket 面（便于单测注入假实现） */
export interface WebSocketLike {
  readyState: number
  close(code?: number, reason?: string): void
  onopen?: ((ev: unknown) => void) | null
  onmessage?: ((ev: { data: unknown }) => void) | null
  onerror?: ((ev: unknown) => void) | null
  onclose?: ((ev: unknown) => void) | null
}

export type WebSocketCtor = new (url: string) => WebSocketLike

export interface PreviewFeedStats {
  /** 已下发帧数 */
  frames: number
  /** 因节流或无效被丢弃的帧数 */
  dropped: number
  /** 累计下发的 data URL 字节数（粗略，用于观察开销） */
  bytes: number
}

export interface PreviewFeedHandle {
  stop(): void
  readonly stats: PreviewFeedStats
  readonly closed: boolean
}

export interface PreviewFeedOptions {
  /** ComfyUI 源（http(s)://host:port） */
  origin: string
  /** 提交 prompt 时使用的 client_id（预览帧只推给该连接） */
  clientId: string
  /** 已知的 prompt_id（提交后即知）；用于给不带 prompt_id 的帧打标 */
  promptId: string
  onFrame: (frame: PreviewFrame) => void
  /** 帧节流间隔（默认 400ms ≈ 2.5fps，够"看着在画"且开销可控） */
  minIntervalMs?: number
  /** 帧数上限（默认 900，防长任务无限采集） */
  maxFrames?: number
  /** 兜底自动关闭（默认 15min，对齐执行超时口径） */
  timeoutMs?: number
  /** 注入 WebSocket 构造器（单测）；缺省用运行时全局 WebSocket */
  WebSocketCtor?: WebSocketCtor
}

const DEFAULT_MIN_INTERVAL_MS = 400
const DEFAULT_MAX_FRAMES = 900
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

/** http(s) origin → ws(s) 预览端点（带 clientId） */
export function previewWsUrl(origin: string, clientId: string): string {
  const base = origin.replace(/\/+$/, '')
  const ws = base.replace(/^http:/i, 'ws:').replace(/^https:/i, 'wss:')
  return `${ws}/ws?clientId=${encodeURIComponent(clientId)}`
}

/** 二进制预览帧 → data URL（按magic number 判类型；ComfyUI 预览多为 JPEG） */
export function binaryFrameToDataUrl(bytes: Uint8Array): string {
  const isPng = bytes.length > 7 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e
  const mime = isPng ? 'image/png' : 'image/jpeg'
  return `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`
}

/**
 * 解析一条 WS 消息为预览帧（非预览消息返回 null，同时把 prompt_id 变化
 * 经 onPromptId 上报——b64_preview 帧自身通常不带 prompt_id）。
 */
export function parsePreviewMessage(
  raw: unknown,
  fallbackPromptId: string,
  onPromptId?: (id: string) => void
): { promptId: string; dataUrl: string } | null {
  // 二进制帧：旧版 ComfyUI 直接发图像字节
  if (raw instanceof ArrayBuffer || ArrayBuffer.isView(raw)) {
    const bytes =
      raw instanceof ArrayBuffer
        ? new Uint8Array(raw)
        : new Uint8Array(
            (raw as ArrayBufferView).buffer,
            (raw as ArrayBufferView).byteOffset,
            (raw as ArrayBufferView).byteLength
          )
    if (bytes.length === 0) return null
    return { promptId: fallbackPromptId, dataUrl: binaryFrameToDataUrl(bytes) }
  }
  if (typeof raw !== 'string') return null

  let msg: Record<string, unknown>
  try {
    msg = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
  const type = String(msg.type ?? '')
  const data = (msg.data ?? {}) as Record<string, unknown>

  // 跟踪当前 prompt_id（executing/progress/execution_start 都带）
  const pid = data.prompt_id ?? data.promptId
  if (typeof pid === 'string' && pid) onPromptId?.(pid)

  if (type === 'b64_preview' || type === 'preview') {
    const image = data.image
    if (typeof image !== 'string' || !image) return null
    const dataUrl = image.startsWith('data:') ? image : `data:image/jpeg;base64,${image}`
    return { promptId: typeof pid === 'string' && pid ? pid : fallbackPromptId, dataUrl }
  }
  return null
}

/**
 * 订阅一次执行的预览帧。返回的 handle 必须（在采集结束或执行结束时）调用
 * stop()，否则会等到 timeout 才释放。
 */
export function startPreviewFeed(options: PreviewFeedOptions): PreviewFeedHandle {
  const {
    origin,
    clientId,
    promptId,
    onFrame,
    minIntervalMs = DEFAULT_MIN_INTERVAL_MS,
    maxFrames = DEFAULT_MAX_FRAMES,
    timeoutMs = DEFAULT_TIMEOUT_MS
  } = options

  const stats: PreviewFeedStats = { frames: 0, dropped: 0, bytes: 0 }
  let closed = false
  let currentPromptId = promptId
  let lastEmitAt = Number.NEGATIVE_INFINITY
  let timer: NodeJS.Timeout | null = null

  const Ctor = options.WebSocketCtor ?? (globalThis as { WebSocket?: WebSocketCtor }).WebSocket
  if (!Ctor) {
    logger.warn('preview feed: 运行时不支持 WebSocket，预览不可用')
    return {
      stop: () => {},
      stats,
      get closed() {
        return true
      }
    }
  }

  let ws: WebSocketLike | null = null

  const stop = (): void => {
    if (closed) return
    closed = true
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    try {
      ws?.close()
    } catch {
      /* 关闭失败不影响（连接可能已断） */
    }
  }

  const emit = (frame: { promptId: string; dataUrl: string }): void => {
    if (closed) return
    const now = Date.now()
    if (now - lastEmitAt < minIntervalMs) {
      stats.dropped++
      return
    }
    lastEmitAt = now
    stats.frames++
    stats.bytes += frame.dataUrl.length
    try {
      onFrame({ promptId: frame.promptId, dataUrl: frame.dataUrl, at: now })
    } catch (e) {
      logger.warn('preview feed: onFrame 回调抛错', e)
    }
    if (stats.frames >= maxFrames) stop()
  }

  try {
    ws = new Ctor(previewWsUrl(origin, clientId))
  } catch (e) {
    logger.warn('preview feed: 连接失败', e)
    return {
      stop,
      stats,
      get closed() {
        return closed
      }
    }
  }

  ws.onmessage = (ev) => {
    if (closed) return
    const parsed = parsePreviewMessage(ev?.data, currentPromptId, (id) => {
      currentPromptId = id
    })
    if (parsed) emit(parsed)
  }
  // 预览是尽力而为：出错误/断开都不重连（不干扰主流程）
  ws.onerror = () => {
    /* 静默：轮询通道仍能拿到终态产物 */
  }
  ws.onclose = () => {
    /* 静默 */
  }

  timer = setTimeout(stop, timeoutMs)
  timer.unref?.()

  return {
    stop,
    stats,
    get closed() {
      return closed
    }
  }
}

/**
 * 按 promptId 缓存最新预览帧（供轮询通道取走）。
 * 容量上限防泄漏：执行结束（service 清理）或超出上限时淘汰最旧条目。
 */
export class PreviewHub {
  private latest = new Map<string, { dataUrl: string; at: number }>()

  constructor(private readonly maxEntries = 24) {}

  set(promptId: string, dataUrl: string): void {
    if (!promptId || !dataUrl) return
    // 重新 set 已有键时先删再插：Map 保序 → 末尾恒为最近使用
    this.latest.delete(promptId)
    this.latest.set(promptId, { dataUrl, at: Date.now() })
    while (this.latest.size > this.maxEntries) {
      const oldest = this.latest.keys().next().value
      if (oldest === undefined) break
      this.latest.delete(oldest)
    }
  }

  get(promptId: string): { dataUrl: string; at: number } | undefined {
    return this.latest.get(promptId)
  }

  clear(promptId: string): void {
    this.latest.delete(promptId)
  }

  clearAll(): void {
    this.latest.clear()
  }

  get size(): number {
    return this.latest.size
  }
}

/** 进程级单例（executor 写、service.pollExecution 读） */
export const previewHub = new PreviewHub()
