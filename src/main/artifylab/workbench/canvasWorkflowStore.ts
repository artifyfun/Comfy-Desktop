/**
 * 画布执行的工作流快照暂存（对标建议 #8 的「用户手动画布 → 沉淀为模板」接线）。
 *
 * 缺口：`/api/canvas/execute` 把前端 `graphToPrompt` 出来的 API 格式 workflow
 * 提交给 ComfyUI，但只记 promptId 不存 workflow 本体；而固化路径
 * （`publishToApp` → `templateLibrary.get(execution.templateId)`）依赖「模板库里
 * 已有的模板」——画布上临时搭出来的 workflow 没有模板，于是事后无法沉淀。
 *
 * 方案：提交时顺手按 promptId 暂存 workflow（LRU，进程内存态足够——沉淀通常
 * 发生在执行后不久）。重启后失效时可让用户重跑一次，或由前端重新 graphToPrompt。
 * 前端零改动：画布执行链路本就把 prompt 交给了服务端。
 */
import type { ComfyPrompt } from '../appStore'

/** 默认保留最近 30 次画布执行的 workflow（每次几十 KB～几 MB，够用且不失控） */
const DEFAULT_MAX_ENTRIES = 30

export class CanvasWorkflowStore {
  /** Map 保序：末尾为最近使用（LRU 淘汰最旧） */
  private entries = new Map<string, ComfyPrompt>()

  constructor(private readonly maxEntries = DEFAULT_MAX_ENTRIES) {}

  /** 暂存某次画布执行的 workflow（同 promptId 重复写入视为刷新） */
  remember(promptId: string, workflow: ComfyPrompt): void {
    if (!promptId || !workflow || typeof workflow !== 'object') return
    if (Object.keys(workflow).length === 0) return
    this.entries.delete(promptId)
    this.entries.set(promptId, workflow)
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
  }

  get(promptId: string): ComfyPrompt | undefined {
    return this.entries.get(promptId)
  }

  has(promptId: string): boolean {
    return this.entries.has(promptId)
  }

  get size(): number {
    return this.entries.size
  }

  clear(): void {
    this.entries.clear()
  }
}

/** 进程级单例（routes/canvas.ts 写、wb_publish_workflow 读） */
export const canvasWorkflowStore = new CanvasWorkflowStore()
