/**
 * 工作台编排服务（workbench-plan.md Phase 1）。
 *
 * 流程：收集上下文（模板清单+会话历史）→ codex 单轮决策出 PLAN →
 * PLAN 校验（本地 + object_info/models/VRAM）→ 执行（text 走 ai 链路，
 * 媒体走 executor.executeApp 伪 App 复用）→ 会话持久化。
 *
 * 会话存储：userData/workbench-sessions.json（防抖落盘，模式抄 batch-queue）。
 */
import { startWorkbenchProxy } from './workbenchProxy'
import { join } from 'node:path'
import { app } from 'electron'
import type { Server as HttpServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import appStoreManager from '../appStore'
import { logger } from '../utils/logger'
import { templateLibrary } from './templates'
import { toPseudoApp, type WorkflowTemplate } from './templateCore'
import {
  checkVram,
  parsePlanFromCodexText,
  validateAgainstObjectInfo,
  validateModels,
  validatePlanLocal,
  type WorkbenchPlan,
  type PlanValidationIssue
} from './plan'
import {
  assignAttachmentsToSlots,
  attachmentSummary,
  applyPromptTemplate,
  clonePreset,
  parseSlashToken,
  presetConstraintText,
  BUILTIN_PRESETS,
  type AttachmentKind,
  type AttachmentMeta,
  type WorkbenchPreset
} from './presetCore'
import { renderEnvSnapshot, SELF_KNOWLEDGE_TEXT, type WorkbenchEnvSnapshot } from './selfKnowledge'
import { extractDocText, isDocumentAttachment, renderDocContext } from './docContext'
import { get as getSetting } from '../../settings'
import { getOrCreateMcpToken } from '../mcp/auth'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from '../mcp/workbenchTools'
import {
  executeApp,
  getExecutionStatus,
  uploadMediaBuffer,
  type ExecutionResult
} from '../mcp/executor'
import { Codex, resolveCodexBaseUrl, resolveCodexBinary } from '../agentDriver'
import { startBatch } from '../services/batchRunner'
import { deriveAttachmentKind } from './presetCore'

/** decide 过程回调：log=阶段文本；thread_event=codex 结构化事件（透传 SSE） */
export type DecideProgressCallback = (
  p:
    | {
        type: 'log'
        text: string
      }
    | {
        type: 'thread_event'
        event: unknown
      }
) => void

export type WorkbenchMessageKind =
  | 'chat'
  | 'card'
  | 'progress'
  | 'artifact'
  | 'error'
  | 'invalid'
  | 'title'
  /** decide 过程条目(reasoning/命令/文件/搜索/todo/mcp),完整 ThreadItem 快照 */
  | 'tool_item'

export interface WorkbenchMessage {
  role: 'user' | 'agent' | 'system'
  kind: WorkbenchMessageKind
  text: string
  /** 分支树(dsh 同款):父消息在 messages[] 中的下标;-1 表示根(旧数据/首个用户消息) */
  parentId?: number
  /** 子分支下标列表(按创建序);单子时省略不存,节省存储 */
  childrenIds?: number[]
  /** 多子时当前激活的分支(决定 activePath 走向);与 childrenIds 同 length 对齐 */
  activeChildIdx?: number
  plan?: WorkbenchPlan
  promptId?: string
  outputs?: string[]
  /** v2：完整产物引用（/view 直出缩略图） */
  outputFiles?: WorkbenchOutputFile[]
  attachments?: AttachmentMeta[]
  /** kind='tool_item' 时的 codex ThreadItem 完整快照 */
  toolItem?: unknown
  createdAt: number
}

/** 单轮 token 用量（turn.completed.usage 快照） */
export interface TurnUsage {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningOutputTokens: number
  at: number
}

/** 产物文件引用（gallery /view 直出缩略图所需的完整定位） */
export interface WorkbenchOutputFile {
  filename: string
  subfolder?: string
  type?: string
}

export interface WorkbenchExecution {
  promptId: string
  templateId: string
  params: Record<string, unknown>
  /** v2：完整文件引用（含 subfolder/type，/view 直出）；旧数据为纯 filename 字符串 */
  outputs: (WorkbenchOutputFile | string)[]
  status: ExecutionResult['status']
  startedAt: number
  /** batch 编排执行:batchRunner 的 job id */
  batchJobId?: string
  /** 失败原因（轮询回填；产物卡「复制错误全文」用） */
  error?: string
}

/** 收藏的产物文件（跨会话收藏夹,落 workbench-sessions.json store 根） */
export interface WorkbenchFavorite {
  id: string
  sessionId: string
  promptId: string
  templateId: string
  file: WorkbenchOutputFile
  note?: string
  createdAt: number
}

/** 会话级模型覆盖（dsh ModelSelection 语义：per-session 可变，影响后续请求） */
export interface SessionModelOverride {
  decisionModel?: string
  buildModel?: string
}

export interface WorkbenchSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: WorkbenchMessage[]
  /** 分支(dsh 同款):当前激活叶;undefined=旧线性数据,取最后一条 */
  activeLeaf?: number
  /** 上次分支操作时间(侧栏「已编辑」徽标用,可选) */
  lastBranchAt?: number
  /** 每轮 token 用量(轮次序 append;与激活分支无关,会话级累计) */
  turnUsages?: TurnUsage[]
  executions: WorkbenchExecution[]
  /** 创建时选定，会话期锁定（dsh agent-preset 语义） */
  presetId?: string
  modelOverride?: SessionModelOverride
  /** 归档：侧栏不显示，数据保留 */
  archived?: boolean
  /** 用户手动改过标题（自动生成不覆盖） */
  titleLocked?: boolean
  /** 调试日志（每轮 decide 的完整上下文；cap 10 条防会话文件膨胀） */
  debugLogs?: WorkbenchDebugLog[]
}

/**
 * 一轮 decide 的调试快照：spec(决策提示词全文) + codex 原始输出(含思考) +
 * 解析后的 PLAN + 校验 + 执行回填。前端「复制调试信息」按钮序列化整条，
 * 便于复盘工作台到底怎么想/怎么选的模板与参数。
 */
export interface WorkbenchDebugLog {
  /** 会话内轮次序号（1 起） */
  seq: number
  ts: number
  /** 预设展开后的实际决策输入 */
  effectiveInput: string
  presetId?: string
  templateShortcut?: string
  /** 决策提示词（模板目录/会话近史/环境快照/规则），截断保护 */
  spec: string
  /** codex 原始输出（JSONL，含思考与工具调用），截断保护 */
  rawOutput: string
  plan: WorkbenchPlan | null
  issues: PlanValidationIssue[]
  remoteIssues?: PlanValidationIssue[]
  /** 执行回填（recordDebug 后由 execute/poll 补齐） */
  promptId?: string
  templateId?: string
  executionStatus?: string
  executionError?: string
  model?: string
}

interface SessionStore {
  sessions: WorkbenchSession[]
  presets?: WorkbenchPreset[]
  presetDefault?: string
  favorites?: WorkbenchFavorite[]
  /** 跨会话长期记忆(dsh memory 语义):key 幂等,工作台可自我更新 */
  memories?: Record<string, { value: string; updatedAt: number }>
}

const MAX_SESSIONS = 50
const FLUSH_DEBOUNCE_MS = 500
/** 会话内保留的最大调试日志条数（每条 ~10KB，防 workbench-sessions.json 膨胀） */
const MAX_DEBUG_LOGS = 10
/** 调试日志字段截断：spec 决策提示词 / codex 原始输出 */
const DEBUG_SPEC_LIMIT = 4000
const DEBUG_RAW_LIMIT = 8000

/** 递归收集模型文件名（去重，cap 80，仅常见权重扩展） */
function collectModelNames(dir: string, out: string[], depth: number): void {
  if (depth > 3 || out.length >= 80) return
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const e of entries) {
    if (out.length >= 80) return
    const full = join(dir, e.name)
    if (e.isDirectory()) collectModelNames(full, out, depth + 1)
    else if (/\.(safetensors|ckpt|pt|bin|gguf)$/i.test(e.name)) {
      if (!out.includes(e.name)) out.push(e.name)
    }
  }
}

/** renderComponent → 该输入位可接受的素材类型（宽松匹配，兼容自绘组件命名） */
function acceptKindsFor(renderComponent: string): AttachmentKind[] {
  const rc = renderComponent.toLowerCase()
  if (rc.includes('video')) return ['video', 'image'] // VHS 等视频位常可吃图
  if (rc.includes('audio')) return ['audio']
  if (rc.includes('image')) return ['image']
  return ['image', 'video', 'audio'] // 未知上传器：全类型
}

function sessionsPath(): string {
  return join(app.getPath('userData'), 'workbench-sessions.json')
}

class WorkbenchService {
  private store: SessionStore = { sessions: [] }
  private flushTimer: NodeJS.Timeout | null = null
  /** decide 期间按需起的内嵌 responses→chat 转换代理（用完即关） */
  private proxyServer?: HttpServer
  /** /mcp 端点可用性（decide 前探测，决定 spec 是否注入 wb_* 编排段） */
  private mcpAvailable = false
  /** 编排去重标记：decide 轮内 wb_execute_template 真实执行过 → 最终 PLAN 不再重复执行 */
  private orchestratedSessions = new Set<string>()

  constructor() {
    this.load()
    templateLibrary.on('change', () => this.pokeTemplates())
  }

  private pokeTemplates(): void {
    // 模板变更无需落盘（模板实时聚合），仅日志
    logger.debug('workbench: template library changed')
  }

  private load(): void {
    try {
      const p = sessionsPath()
      if (existsSync(p)) this.store = JSON.parse(readFileSync(p, 'utf8')) as SessionStore
    } catch (e) {
      logger.warn('workbench: load sessions failed', e)
    }
  }

  private flush(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      try {
        // 上限淘汰最旧会话
        if (this.store.sessions.length > MAX_SESSIONS) {
          this.store.sessions = this.store.sessions
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .slice(0, MAX_SESSIONS)
        }
        writeFileSync(sessionsPath(), JSON.stringify(this.store, null, 2))
      } catch (e) {
        logger.warn('workbench: flush sessions failed', e)
      }
    }, FLUSH_DEBOUNCE_MS)
  }

  listSessions(archived?: boolean): WorkbenchSession[] {
    return [...this.store.sessions]
      .filter((s) => (archived === undefined ? true : !!s.archived === archived))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): WorkbenchSession | null {
    return this.store.sessions.find((s) => s.id === id) ?? null
  }

  createSession(opts: { title?: string; presetId?: string } = {}): WorkbenchSession {
    const session: WorkbenchSession = {
      id: randomUUID(),
      title: opts.title || '新会话',
      // 用户在建会话时显式填了标题 → 视同手动命名，防 PLAN 自动标题覆盖
      titleLocked: !!opts.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      executions: [],
      presetId: opts.presetId
    }
    this.store.sessions.unshift(session)
    this.flush()
    return session
  }

  /** 会话元信息更新（标题/模型覆盖/归档；dsh 语义：模型可变，预设锁定） */
  updateSession(
    id: string,
    patch: {
      title?: string
      modelOverride?: SessionModelOverride
      archived?: boolean
      presetId?: string
    }
  ): WorkbenchSession | null {
    const session = this.getSession(id)
    if (!session) return null
    if (patch.title !== undefined) {
      session.title = patch.title
      session.titleLocked = true
    }
    if (patch.modelOverride !== undefined) session.modelOverride = patch.modelOverride
    if (patch.archived !== undefined) session.archived = patch.archived
    // 预设点击切换（dsh 模式）：仅接受已存在预设
    if (patch.presetId !== undefined) {
      if (patch.presetId === '' || this.getPreset(patch.presetId)) {
        session.presetId = patch.presetId || undefined
      }
    }
    session.updatedAt = Date.now()
    this.flush()
    return session
  }

  deleteSession(id: string): boolean {
    const before = this.store.sessions.length
    this.store.sessions = this.store.sessions.filter((s) => s.id !== id)
    const ok = this.store.sessions.length < before
    if (ok) this.flush()
    return ok
  }

  appendMessage(sessionId: string, msg: Omit<WorkbenchMessage, 'createdAt'>): void {
    const session = this.getSession(sessionId)
    if (!session) return
    const msgs = session.messages
    // 分支树(dsh 同款):新消息挂在当前 activeLeaf 链末端;无 activeLeaf 时挂最后一条
    const parentIdx = session.activeLeaf !== undefined ? session.activeLeaf : msgs.length - 1
    const node: WorkbenchMessage = {
      ...msg,
      createdAt: Date.now(),
      parentId: msgs.length > 0 ? parentIdx : -1
    }
    if (msgs.length > 0) {
      const parent = msgs[parentIdx]!
      if (!parent.childrenIds) parent.childrenIds = [msgs.length]
      else parent.childrenIds.push(msgs.length)
    }
    msgs.push(node)
    session.activeLeaf = msgs.length - 1
    session.updatedAt = Date.now()
    this.flush()
  }

  // ---------------- 跨会话长期记忆（dsh memory 语义） ----------------

  listMemories(): Record<string, { value: string; updatedAt: number }> {
    return { ...(this.store.memories ?? {}) }
  }

  /** 写入/更新(幂等,同 key 覆盖);工作台自我更新与用户指令共用此口 */
  rememberMemory(key: string, value: string): void {
    const k = key.trim().slice(0, 64)
    if (!k) throw new Error('memory key 不能为空')
    this.store.memories = {
      ...(this.store.memories ?? {}),
      [k]: { value: value.trim().slice(0, 500), updatedAt: Date.now() }
    }
    this.flush()
  }

  forgetMemory(key: string): boolean {
    if (!this.store.memories || !(key in this.store.memories)) return false
    const next = { ...this.store.memories }
    delete next[key]
    this.store.memories = next
    this.flush()
    return true
  }

  // ---------------- 编排去重（wb_* 工具真实执行过 → 最终 PLAN 跳过执行） ----------------

  /** wb_execute_template 提交成功后由工具层调用 */
  markOrchestrated(sessionId: string): void {
    this.orchestratedSessions.add(sessionId)
  }

  /** 读取并清除标记（decide 收尾时由路由调用，返回"本轮是否已真实执行过"） */
  consumeOrchestratedFlag(sessionId: string): boolean {
    const had = this.orchestratedSessions.has(sessionId)
    this.orchestratedSessions.delete(sessionId)
    return had
  }

  /** decide spec 的「用户长期记忆」注入段(空记忆返回空串) */
  renderMemoryContext(): string {
    const entries = Object.entries(this.store.memories ?? {})
    if (entries.length === 0) return ''
    const lines = entries
      .sort((a, b) => b[1].updatedAt - a[1].updatedAt)
      .slice(0, 20)
      .map(([k, v]) => `- ${k}: ${v.value}`)
    return `\n## 用户长期记忆（跨会话持久,可直接引用;需更新时用 intent=memory）\n${lines.join('\n')}`
  }

  /** 会话级 token 用量追加(turn.completed) */
  appendTurnUsage(sessionId: string, usage: TurnUsage): void {
    const session = this.getSession(sessionId)
    if (!session) return
    if (!session.turnUsages) session.turnUsages = []
    session.turnUsages.push(usage)
    this.flush()
  }

  /** 当前激活分支路径(根→叶下标序列);旧线性数据直接全量返回 */
  activePath(sessionId: string): number[] {
    const session = this.getSession(sessionId)
    if (!session || session.messages.length === 0) return []
    const msgs = session.messages
    // 旧数据兼容:任一节点无 parentId 视为线性
    if (msgs.every((m) => m.parentId === undefined)) return msgs.map((_, i) => i)
    const leaf = session.activeLeaf !== undefined ? session.activeLeaf : msgs.length - 1
    const path: number[] = []
    let cur: number | undefined = leaf
    const guard = new Set<number>()
    while (cur !== undefined && cur >= 0 && !guard.has(cur)) {
      guard.add(cur)
      path.push(cur)
      cur = msgs[cur]!.parentId
    }
    return path.reverse()
  }

  /**
   * 分支切换:把某消息的第 variantIdx 个子分支设为激活,activeLeaf 移到该分支的末端叶。
   * dsh 语义:切分支 = 从那个分叉点重新走另一条路到它自己的叶子。
   */
  switchBranch(sessionId: string, messageIdx: number, variantIdx: number): boolean {
    const session = this.getSession(sessionId)
    if (!session) return false
    const msgs = session.messages
    const target = msgs[messageIdx]
    if (!target?.childrenIds || variantIdx < 0 || variantIdx >= target.childrenIds.length)
      return false
    target.activeChildIdx = variantIdx
    // 沿该分支走到底:每层取 activeChildIdx(缺省 0)对应子节点
    let cur = target.childrenIds[variantIdx]!
    const guard = new Set<number>()
    while (!guard.has(cur)) {
      guard.add(cur)
      session.activeLeaf = cur
      const node = msgs[cur]!
      if (!node.childrenIds?.length) break
      const ai = node.activeChildIdx ?? 0
      const next = node.childrenIds[Math.min(ai, node.childrenIds.length - 1)]!
      cur = next
    }
    session.lastBranchAt = Date.now()
    session.updatedAt = Date.now()
    this.flush()
    return true
  }

  /** 上一次执行的产物（链式输入源） */
  lastExecution(sessionId: string): WorkbenchExecution | null {
    const session = this.getSession(sessionId)
    if (!session || session.executions.length === 0) return null
    return session.executions[session.executions.length - 1]!
  }

  /** codex 决策提示词：模板清单 + 会话近史 + 用户输入 + 预设/附件/快捷方式 */
  /**
   * 环境快照（自我认知层）：聚合已固化技能 / 本地模型 / 显存 / 自定义节点。
   * 各源独立容错——任何一路失败只影响自身段落，不阻断决策。
   */
  private async collectEnvSnapshot(): Promise<WorkbenchEnvSnapshot> {
    // 已固化技能名
    const appNames = appStoreManager
      .getAllApps()
      .map((a) => a.name)
      .filter(Boolean)
      .slice(0, 30)

    // 本地模型（modelsDirs walk，仅文件名按类型分组）
    const modelsByType: Record<string, string[]> = {}
    try {
      const dirs = (getSetting('modelsDirs') as string[] | undefined) ?? []
      for (const base of dirs) {
        for (const type of ['checkpoints', 'loras', 'vae', 'upscale_models', 'controlnet']) {
          const typeDir = join(base, type)
          if (!existsSync(typeDir)) continue
          const names = (modelsByType[type] ??= [])
          collectModelNames(typeDir, names, 0)
        }
      }
    } catch (e) {
      logger.debug('workbench env snapshot: model scan failed', e)
    }

    // VRAM + object_info 节点名（ComfyUI 未启动则跳过）
    let vramGb: number | undefined
    const customNodes: string[] = []
    try {
      const comfyOrigin = appStoreManager.getConfig().comfyHost
      const [statsRes, infoRes] = await Promise.allSettled([
        fetch(`${comfyOrigin}/system_stats`),
        fetch(`${comfyOrigin}/object_info`)
      ])
      if (statsRes.status === 'fulfilled' && statsRes.value.ok) {
        const stats = (await statsRes.value.json()) as {
          devices?: Array<{ vram_total?: number }>
        }
        const total = stats.devices?.[0]?.vram_total
        if (total) vramGb = Math.round(total / 1024 ** 3)
      }
      if (infoRes.status === 'fulfilled' && infoRes.value.ok) {
        const info = (await infoRes.value.json()) as Record<string, unknown>
        // object_info keys 含官方内置节点；筛出第三方特征（命名空间含 '/' 或非大写开头惯例不可靠，
        // 这里用「非 ComfyUI 官方前缀白名单」的轻量判定）
        const officialPrefixes =
          /^(KSampler|CheckpointLoader|VAE|CLIPTextEncode|ControlNet|EmptyLatentImage|SaveImage|LoadImage|PreviewImage|LoraLoader|Conditioning|Latent|UNet|CLIP|DualCLIPLoader|StyleModel|Upscale|ImageScale|Fixed|Flip|PadForSDXL|CLIPVision|Inpaint|SetLatentNoiseMask|DiffusersLoader|unCLIPCheckpointLoader|GLIGEN|marduk)/
        for (const key of Object.keys(info)) {
          if (!officialPrefixes.test(key)) customNodes.push(key)
        }
      }
    } catch (e) {
      logger.debug('workbench env snapshot: comfy probe failed', e)
    }

    return { appNames, modelsByType, vramGb, customNodes: customNodes.slice(0, 60) }
  }

  private async buildDecisionSpec(
    userInput: string,
    session: WorkbenchSession,
    opts: {
      preset?: WorkbenchPreset
      attachments?: readonly AttachmentMeta[]
      templateShortcut?: string
    } = {}
  ): Promise<string> {
    const templates = templateLibrary.list()
    const catalog = JSON.stringify(
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        description: t.description,
        mediaType: t.mediaType,
        chainable: t.chainable ?? false,
        params: t.paramsNodes
          .filter((p) => p.category === 'input')
          .map((p) => ({
            name: p.name,
            type: p.selectedWidget?.type ?? p.type,
            widget: p.selectedWidget?.name,
            options: p.selectedWidget?.options ?? undefined
          }))
      })),
      null,
      1
    )
    // 分支树(dsh 同款):decide 历史只走当前激活分支;
    // 过程条目(tool_item/card/progress)不回灌,只取对话语义消息,防上下文爆炸
    const recent = this.activePath(session.id)
      .map((i) => session.messages[i]!)
      .filter((m) => m.kind === 'chat' || m.kind === 'error')
      .slice(-8)
      .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
      .join('\n')
    const lastExec = this.lastExecution(session.id)
    const chainHint = lastExec
      ? `\n## 上一次执行产物\n模板 ${lastExec.templateId}，promptId ${lastExec.promptId}，产物 ${lastExec.outputs.join('、') || '（无）'}。usePreviousOutput=true 时可将其作为图/视频输入。`
      : ''
    const constraint =
      opts.preset && presetConstraintText(opts.preset)
        ? `\n## 会话预设约束（必须遵守）\n${presetConstraintText(opts.preset)}`
        : ''
    const attachmentHint = opts.attachments?.length
      ? `\n## 用户上传素材（已上传，可作媒体输入）\n${attachmentSummary(opts.attachments)}`
      : ''
    // 文档类附件的正文内容:大模型在决策时直接阅读(pdf/txt/md/json 等)
    const docHint = opts.attachments?.length ? renderDocContext(opts.attachments) : ''
    const shortcutHint = opts.templateShortcut
      ? `\n## 用户显式指定模板\n必须使用 templateId="${opts.templateShortcut}"。`
      : ''
    // 批量编排能力声明:模型可在识别出多行数据/多变体需求时输出 batch 计划
    const batchRule = `
## 批量编排（batch）
用户需要多条产出（明确列出行、给表格/清单、要求 N 个变体）时，输出 batch 字段：
"batch": { "items": [ {…参数行}, … ], "sharedParams": {…全批次共享覆盖} }
- items 每行是一个参数对象，键=模板参数名，仅写与默认值不同的键；2~200 行
- 行内值覆盖 sharedParams 覆盖模板默认值；未提到的参数用模板默认
- 例：「这两个提示词各出一张图」→ items:[{"prompt":"A"},{"prompt":"B"}]
`
    const titleRule = `
## 标题（可选）
若为首条消息，可在 JSON 中加 "title":"≤15字会话标题"。`
    // 编排能力声明：wb_* MCP 工具（decide 轮内自主多步执行的抓手）。
    // 仅在 /mcp 端点可用（server 已监听）时注入。
    const orchestrationRule = this.mcpAvailable
      ? `
## 多步编排（wb_* 工具）
简单需求（选一个模板出图/出视频/答一句话）**直接输出 PLAN JSON**，不要调工具。
**多步需求**（先调研/生成，再基于结果继续生成或写文案，如「查XX主题→文生图→图生视频→写文案」）逐步自主执行：
1. wb_list_templates 看可用模板（研究类需求可用你的 shell 联网检索，结论作为后续 prompt 输入）。
2. wb_execute_template(template_id, params, wait=true) 逐步执行；链式步骤传 use_previous_output=true 自动引用上一步产物。
3. 每步产物自动落会话（用户实时可见）；全部完成后，最终回复（agent_message）输出：完整编排总结 + 交付文案（若需要）+ 仍输出 PLAN JSON（intent 标记为最后一个生成步骤，系统会跳过重复执行）。
用户偏好/硬件等跨会话事实可用 wb_remember/wb_forget 沉淀。`
      : ''
    // 跨会话记忆注入(dsh memory 语义):读取段 + 自我更新授权
    const memorySection = this.renderMemoryContext()
    const memoryRule = `
## 长期记忆（intent=memory）
用户表达可跨会话保留的偏好/事实（「以后都用...」「记住我喜欢...」「我的显卡是...」）时：
{"intent":"memory","memory":{"action":"remember","key":"短标签(英文-kebab,如 preferred-style)","value":"一句话内容"},"reply":"向用户确认记住了什么"}
用户要求忘掉某事（「别再用...」「忘掉...」）时 action=forget（只需 key；不匹配任何键时用最接近的键并在 reply 说明）。
环境快照/会话近史与你已知记忆冲突时，以用户新表述为准主动 remember 更新同 key。`
    // 自我认知 + 环境快照（AGENTS.md 语义：常驻能力说明与本地环境感知）
    let envSection = ''
    try {
      const env = await this.collectEnvSnapshot()
      envSection = `\n## 环境快照\n${renderEnvSnapshot(env)}\n`
    } catch (e) {
      logger.debug('workbench env snapshot render failed', e)
    }
    return `${SELF_KNOWLEDGE_TEXT}${envSection}
根据用户需求从模板库选择模板并填参数，输出**只含一个 JSON 对象**（无 markdown 代码块、无解释文字）：
{"intent":"image|video|audio|text|chat|memory","templateId":"...","params":{...},"usePreviousOutput":false,"reason":"一句话解释","reply":"chat/text/memory 时直接给用户的回复","memory":{"action":"remember|forget","key":"...","value":"remember 时必填"},"title":"仅首条消息时提供"}

规则：
1. intent=image/video/audio 必须从下列模板中选 templateId，params 只用模板声明的参数，数值遵守 min/max，枚举必须完全匹配可选值。
2. intent=text 走纯文本生成（文案/起名/总结等），把生成结果放 reply。
3. intent=chat 用于追问澄清或闲聊，回复放 reply。
4. 模板库为空或不匹配时选 chat 并说明。3.5 可跨会话保留的偏好/事实用 intent=memory（见「长期记忆」段）。
5. 用户上传了素材时，倾向选择带媒体输入参数的模板（图生图/视频驱动），参数值填素材文件名（已上传）。
6. 存在「会话预设约束」段落时，其 intent 限制是**硬性规则**，违反的输出会被系统直接拒绝——你必须输出该 intent。7. 有「多步编排」段时优先按它执行；单步需求仍直接出 PLAN JSON。${chainHint}${constraint}${attachmentHint}${docHint}${batchRule}${shortcutHint}${titleRule}${memoryRule}${orchestrationRule}

## 模板库
${catalog}

## 会话近史
${recent || '（空）'}${memorySection}

## 用户需求
${userInput}`
  }

  /** 从 codex 原始输出提取第一个 JSON 对象（容错：markdown 包裹/前后杂文） */
  static parsePlanFromCodex(raw: string): WorkbenchPlan | null {
    return parsePlanFromCodexText(raw)
  }

  /**
   * 会话主入口：决策 → 校验 → （由调用方决定执行）。
   * 返回 PLAN 与校验结果；SSE 流与执行由路由层编排（分层：服务不持有 res）。
   *
   * P2：支持 attachments（多素材）/ 斜杠 token（预设/模板快捷方式）/
   * 会话预设约束注入。
   */
  async decide(
    sessionId: string,
    rawInput: string,
    onProgress: DecideProgressCallback,
    attachments: AttachmentMeta[] = []
  ): Promise<{
    plan: WorkbenchPlan | null
    issues: PlanValidationIssue[]
    raw: string
    resolved: { input: string; presetId?: string; templateShortcut?: string }
  }> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)

    // --- 输入预处理：斜杠 token（技能=模板快捷方式，单选）> 会话预设 ---
    const slash = parseSlashToken(rawInput, [], templateLibrary.list())
    const presetId = session.presetId
    let templateShortcut: string | undefined
    let userInput = rawInput
    if (slash?.kind === 'template') {
      templateShortcut = slash.id
      userInput = slash.rest
    }
    const preset = (presetId ? this.getPreset(presetId) : undefined) ?? undefined
    // 预设提示词模板展开（{input} 占位）；附件-only 输入给默认占位提示
    const baseInput = userInput.trim() || '按我上传的素材生成'
    const effectiveInput = applyPromptTemplate(preset, baseInput)

    this.appendMessage(sessionId, {
      role: 'user',
      kind: 'chat',
      text: rawInput,
      attachments: attachments.length ? attachments : undefined
    })

    // codex 决策（复用 agentDriver 的 Codex SDK 直连；单轮，产出 JSON）
    const binary = resolveCodexBinary()
    if (!binary) throw new Error('codex binary not found (run scripts/copy-codex-bin.mjs)')
    const spec = await this.buildDecisionSpec(effectiveInput, session, {
      preset,
      attachments,
      templateShortcut
    })
    // 内嵌 responses→chat 转换代理：上游无 /v1/responses（new-api 默认）时由
    // 应用自身兜底翻译，用户无需安装任何外部代理。
    const cfg = appStoreManager.getConfig()
    const upstreamBaseUrl = cfg.base_url || 'https://api.deepseek.com/v1'
    let codexBaseUrl = upstreamBaseUrl
    if (!/^https:\/\/api\.deepseek\.com/.test(upstreamBaseUrl)) {
      const proxy = await startWorkbenchProxy({
        upstreamBaseUrl,
        upstreamApiKey: cfg.api_key || '',
        model: cfg.buildModel || 'glm-5.3-flash'
      })
      this.proxyServer = proxy.server
      codexBaseUrl = proxy.baseUrl
      onProgress({
        type: 'log',
        text: `responses→chat 代理已就绪 ${proxy.baseUrl} → ${upstreamBaseUrl}`
      })
    }
    // 临时 CODEX_HOME：每次 decide 独立目录（用完即删），内含 workbench MCP server
    // 注册（stdio 归 codex 拉起；工具经 /mcp 端点回环访问本进程能力）。
    // 隔离用户级 ~/.codex/config.toml（model_provider=custom 劫持 base_url，8317 案例）。
    // 动态 import 避免 service↔server 循环依赖。
    const tempHome = mkdtempSync(join(app.getPath('temp'), 'wb-codex-'))
    const { getServerPort } = await import('../server')
    const serverPort = getServerPort()
    this.mcpAvailable = serverPort != null
    if (serverPort) {
      const mcpUrl = `http://127.0.0.1:${serverPort}/mcp`
      writeFileSync(
        join(tempHome, 'config.toml'),
        [
          `[mcp_servers.workbench]`,
          `url = "${mcpUrl}"`,
          `bearer_token_env_var = "WORKBENCH_MCP_TOKEN"`,
          // approve：exec 单轮 approval_policy=never、workspace-write 沙箱下唯一
          // 无条件放行值（codex mcp_tool_call.rs：只有 AppToolApproval::Approve
          // 不看注解直接豁免；auto/writes 对非 read-only 工具仍要弹窗→被拒）。
          // wb_* 全部经 validatePlanLocal 白名单校验、上下文绑会话，安全面可控。
          `default_tools_approval_mode = "approve"`,
          ``,
          // workspace-write 沙箱默认禁网 —— MCP(streamable HTTP) 属 executor 侧
          // 网络，不放行则每次工具调用被 sandbox network proxy 拦截（探针实测
          // "MCP tool call failed"，模型只能放弃编排）。仅放行回环 MCP 端点。
          `[sandbox_workspace_write]`,
          `network_access = true`,
          ``
        ].join('\n')
      )
    }
    beginWorkbenchToolContext(sessionId)
    const codex = new Codex({
      codexPathOverride: binary,
      // 显式注入 config.base_url（new-api 网关）> deepseek 默认
      baseUrl: resolveCodexBaseUrl({
        baseUrl: codexBaseUrl
      }),
      apiKey: cfg.api_key || process.env.CODEX_API_KEY || '',
      env: {
        ...process.env,
        CODEX_HOME: tempHome,
        ...(serverPort ? { WORKBENCH_MCP_TOKEN: getOrCreateMcpToken() } : {})
      },
      // 双保险：即使泄露进 provider 配置，也强制回内置 openai 让 baseUrl 生效。
      // code_mode/tool_search 关闭：0.149.x 新路由默认把 MCP 工具交给 JS
      // code-mode runtime / 延迟注册（deferred），exec --experimental-json 单轮
      // 下两者都不可用 → 模型调用报 "unsupported call: wb_*"（stderr 实测）。
      // 关掉走经典工具路由，MCP 工具直接注册进 router。
      config: {
        model_provider: 'openai',
        features: { code_mode: false, tool_search: false }
      }
    })
    // 沙箱档位:'standard'(默认)仅工作目录可写;'full' 完全放开(C 权限,
    // 用户显式开启)。档位读取失败一律回退 standard,宁可少权不可多权。
    let agentAccess: 'standard' | 'full' = 'standard'
    try {
      const fromSettings = getSetting('workbenchAgentAccess')
      const fromConfig = appStoreManager.getConfig().workbenchAgentAccess
      agentAccess = (fromSettings ?? fromConfig) === 'full' ? 'full' : 'standard'
    } catch {
      try {
        agentAccess =
          appStoreManager.getConfig().workbenchAgentAccess === 'full' ? 'full' : 'standard'
      } catch {}
    }
    const thread = codex.startThread({
      model: appStoreManager.getConfig().buildModel || 'glm-5.3-flash',
      sandboxMode: agentAccess === 'full' ? 'danger-full-access' : 'workspace-write',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true
    })
    const { events } = await thread.runStreamed(spec)
    // codex exec 的 JSONL 原始行（string 形态）——parsePlanFromCodex 容错解析用
    const rawLines: string[] = []
    for await (const event of events) {
      if (typeof event === 'string') {
        rawLines.push(event)
        onProgress({ type: 'log', text: 'deciding' })
        continue
      }
      // 结构化 ThreadEvent：透传给路由层（SSE item 流，前端实时渲染
      // 工具调用/文件改动/web 搜索/reasoning，抄 codex app-server 条目驱动模型）
      onProgress({ type: 'thread_event', event })
      try {
        rawLines.push(JSON.stringify(event))
      } catch {
        /* ignore */
      }
      onProgress({ type: 'log', text: 'deciding' })
    }
    const raw = rawLines.join('\n')
    // decide 单轮结束即关内嵌代理（每次 decide 按需起、用完即停，端口不常驻）
    if (this.proxyServer) {
      this.proxyServer.close()
      this.proxyServer = undefined
    }
    // wb_* 工具上下文随之失效（残留调用会得到明确错误而非落错会话）
    endWorkbenchToolContext(sessionId)
    // 临时 CODEX_HOME 用完即删（含 mcp 注册与可能的会话缓存）
    try {
      rmSync(tempHome, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响决策 */
    }

    const plan = WorkbenchService.parsePlanFromCodex(raw)
    if (!plan) {
      // 决策失败也留调试日志（原始输出最能说明模型为什么没给出 JSON）
      this.recordDebug(sessionId, {
        effectiveInput,
        presetId,
        templateShortcut,
        spec,
        rawOutput: raw,
        plan: null,
        issues: [{ field: 'plan', message: 'codex 未输出可解析的 JSON PLAN' }],
        model: appStoreManager.getConfig().buildModel
      })
      return {
        plan: null,
        issues: [{ field: 'plan', message: 'codex 未输出可解析的 JSON PLAN' }],
        raw,
        resolved: { input: effectiveInput, presetId, templateShortcut }
      }
    }
    // 模板快捷方式：强制锁定 templateId（技能语义：用户显式点名）
    if (templateShortcut) plan.templateId = templateShortcut
    // 会话预设意图约束：codex 违反时本地校验会拦（下面 validatePlanLocal 前
    // 先人工补一条 issue，给出明确错误指向预设）
    const presetIssues: PlanValidationIssue[] = []
    if (
      preset?.intentHint &&
      plan.intent !== preset.intentHint &&
      plan.intent !== 'memory' &&
      plan.intent !== 'chat' &&
      plan.intent !== 'text'
    ) {
      presetIssues.push({
        field: 'intent',
        message: `预设 ${preset.id} 锁定 intent=${preset.intentHint}，但决策为 ${plan.intent}`
      })
    }
    const validation = validatePlanLocal(plan, templateLibrary.list())
    // P2e：标题自动生成（PLAN 顺带 title 字段，用户手改过则不覆盖）
    if (plan.title && session.title !== plan.title && !session.titleLocked) {
      session.title = plan.title.slice(0, 20)
      session.updatedAt = Date.now()
      this.flush()
    }
    this.recordDebug(sessionId, {
      effectiveInput,
      presetId,
      templateShortcut,
      spec,
      rawOutput: raw,
      plan,
      issues: [...presetIssues, ...validation.issues],
      model: appStoreManager.getConfig().buildModel
    })
    return {
      plan,
      issues: [...presetIssues, ...validation.issues],
      raw,
      resolved: { input: effectiveInput, presetId, templateShortcut }
    }
  }

  /** 网络侧校验（object_info/models/VRAM），decision 后、执行前调用 */
  async validateRemote(
    _plan: WorkbenchPlan,
    template: WorkflowTemplate | null
  ): Promise<PlanValidationIssue[]> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const issues: PlanValidationIssue[] = []
    if (template) {
      issues.push(...(await validateAgainstObjectInfo(comfyOrigin, template.prompt)))
      issues.push(...(await validateModels(comfyOrigin, template)))
    }
    issues.push(...(await checkVram(comfyOrigin)))
    return issues
  }

  /** 执行 PLAN（媒体类）。链式：上次产物为 media 参数源；附件按序填充媒体输入位。 */
  async execute(
    sessionId: string,
    plan: WorkbenchPlan,
    template: WorkflowTemplate,
    attachments: AttachmentMeta[] = []
  ): Promise<WorkbenchExecution> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const args: Record<string, unknown> = { ...(plan.params ?? {}) }
    // 媒体输入位：input 类参数中渲染组件为媒体上传器的（图/视频/音频）
    const mediaSlots = template.paramsNodes
      .filter(
        (n) =>
          n.category === 'input' && /image|video|audio|-uploader$/i.test(n.renderComponent ?? '')
      )
      .map((n) => ({
        slot: { param: n.name ?? '', accept: acceptKindsFor(n.renderComponent ?? '') },
        node: n
      }))
    // 链式：把上次产物作为第一个媒体输入参数（图→视频典型）
    if (plan.usePreviousOutput) {
      const last = this.lastExecution(sessionId)
      if (last && last.outputs.length > 0) {
        const first = mediaSlots[0]
        if (first) args[first.slot.param] = last.outputs[0]
      }
    }
    // 附件按序填充剩余媒体输入位（一附件一位，多余忽略并记录）
    if (attachments.length > 0) {
      const occupied = new Set(
        mediaSlots.filter((m) => args[m.slot.param] !== undefined).map((m) => m.slot.param)
      )
      const freeSlots = mediaSlots.filter((m) => !occupied.has(m.slot.param)).map((m) => m.slot)
      const { assignments, ignored } = assignAttachmentsToSlots(attachments, freeSlots)
      for (const a of assignments) {
        if (!a.slot.param) continue
        args[a.slot.param] = this.resolveAttachmentRef(a.attachment)
      }
      if (ignored.length > 0) {
        logger.warn(
          `workbench: ${ignored.length} attachments unassigned (no free matching slot): ${ignored.map((a) => a.filename).join(', ')}`
        )
      }
    }
    const result = await executeApp(toPseudoApp(template), args, comfyOrigin)
    const execution: WorkbenchExecution = {
      promptId: result.prompt_id,
      templateId: template.id,
      params: args,
      outputs: [],
      status: result.status,
      startedAt: Date.now()
    }
    const session = this.getSession(sessionId)
    if (session) {
      session.executions.push(execution)
      this.appendMessage(sessionId, {
        role: 'agent',
        kind: 'card',
        text: `执行模板 ${template.name}`,
        plan,
        promptId: execution.promptId
      })
    }
    return execution
  }

  /** 查询执行状态并回填产物（SSE 轮询用） */
  async pollExecution(
    sessionId: string,
    promptId: string
  ): Promise<ExecutionResult & { outputsText: string }> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const result = await getExecutionStatus(comfyOrigin, promptId)
    let outputsText = ''
    if (result.status === 'success') {
      // 调试日志同步最终执行状态
      this.patchDebugExecution(sessionId, promptId, { executionStatus: 'success' })
      outputsText = JSON.stringify(result.outputs ?? {}, null, 1)
      // 回填会话
      const session = this.getSession(sessionId)
      const exec = session?.executions.find((e) => e.promptId === promptId)
      if (exec && result.outputs) {
        exec.status = 'success'
        const files: WorkbenchOutputFile[] = []
        for (const v of Object.values(result.outputs as Record<string, unknown>)) {
          const o = v as {
            images?: Array<{ filename?: string; subfolder?: string; type?: string }>
            gifs?: Array<{ filename?: string; subfolder?: string; type?: string }>
          }
          for (const key of ['images', 'gifs'] as const) {
            for (const it of o[key] ?? []) {
              if (it.filename)
                files.push({ filename: it.filename, subfolder: it.subfolder, type: it.type })
            }
          }
        }
        exec.outputs = files
        this.appendMessage(sessionId, {
          role: 'agent',
          kind: 'artifact',
          text: files.length ? `产物 ${files.length} 个文件` : '执行完成（无产物文件）',
          outputs: files.map((f) => f.filename),
          outputFiles: files,
          promptId
        })
        this.flush()
      }
    }
    if (result.status === 'error' && result.error) {
      const session = this.getSession(sessionId)
      const exec = session?.executions.find((e) => e.promptId === promptId)
      // 完整错误落执行记录（产物卡可复制全文；截断防会话文件膨胀）
      if (exec) {
        exec.status = 'error'
        exec.error = result.error.slice(0, 2000)
      }
      // 调试日志同步最终执行状态
      this.patchDebugExecution(sessionId, promptId, {
        executionStatus: 'error',
        executionError: result.error.slice(0, 2000)
      })
      this.appendMessage(sessionId, {
        role: 'agent',
        kind: 'error',
        text: `执行失败: ${result.error.slice(0, 500)}`,
        promptId
      })
      this.flush()
    }
    return { ...result, outputsText }
  }

  /** 记录一轮 decide 的调试快照（cap MAX_DEBUG_LOGS 条，字段截断保护） */
  recordDebug(
    sessionId: string,
    d: Omit<WorkbenchDebugLog, 'seq' | 'ts' | 'spec' | 'rawOutput'> & {
      spec?: string
      rawOutput?: string
    }
  ): void {
    const session = this.getSession(sessionId)
    if (!session) return
    const logs = (session.debugLogs ??= [])
    const seq = logs.length ? logs[logs.length - 1]!.seq + 1 : 1
    logs.push({
      ...d,
      spec: (d.spec ?? '').slice(0, DEBUG_SPEC_LIMIT),
      rawOutput: (d.rawOutput ?? '').slice(0, DEBUG_RAW_LIMIT),
      seq,
      ts: Date.now()
    })
    if (logs.length > MAX_DEBUG_LOGS) logs.splice(0, logs.length - MAX_DEBUG_LOGS)
    this.flush()
  }

  /** 执行结果回填到调试日志（execute 后与 poll 终态按 promptId 匹配） */
  patchDebugExecution(
    sessionId: string,
    promptId: string,
    patch: {
      promptId?: string
      templateId?: string
      executionStatus?: string
      executionError?: string
    }
  ): void {
    const session = this.getSession(sessionId)
    if (!session) return
    const logs = session.debugLogs ?? []
    // 优先按 promptId 匹配（poll 终态）；找不到时回退最后一条尚未绑定
    // promptId 的 log —— recordDebug 在 decide 阶段记录，promptId 那时还
    // 未知，execute 提交后由 routes 用本方法回填（此前只按 promptId 查
    // 永远匹配不到，调试信息里「执行」一直显示未执行）。
    let log = logs.find((l) => l.promptId === promptId)
    if (!log) log = [...logs].reverse().find((l) => !l.promptId)
    if (log) Object.assign(log, patch)
  }

  /** 最近一条调试日志（无则 null）；调试信息复制入口的数据源 */
  lastDebugLog(sessionId: string): WorkbenchDebugLog | null {
    const session = this.getSession(sessionId)
    const logs = session?.debugLogs
    if (!logs || logs.length === 0) return null
    return logs[logs.length - 1]!
  }

  /** 固化：把模板+参数做成新 app（复用 appStore.createApp + appAssets 链路） */
  /**
   * 批量编排执行:PLAN.batch 存在时把模板+数据行投进 batchRunner 队列。
   * 参数语义:模板默认参数 ← plan.params ← batch.sharedParams ← item 行
   * (后者覆盖前者同名键)。附件/链式产物作为共享输入一次性填好。
   * 返回 batch job id,进度走既有 /api/batch/status 轮询。
   */
  async executeBatch(
    sessionId: string,
    plan: WorkbenchPlan,
    template: WorkflowTemplate,
    attachments: AttachmentMeta[] = []
  ): Promise<{ jobId: string; total: number }> {
    const shared: Record<string, unknown> = {
      ...(plan.params ?? {}),
      ...(plan.batch?.sharedParams ?? {})
    }
    // 媒体槽位填充逻辑与单次 execute 完全一致(附件→槽位,链式→首槽)
    const mediaSlots = template.paramsNodes
      .filter(
        (n) =>
          n.category === 'input' && /image|video|audio|-uploader$/i.test(n.renderComponent ?? '')
      )
      .map((n) => ({
        slot: { param: n.name ?? '', accept: acceptKindsFor(n.renderComponent ?? '') },
        node: n
      }))
    if (plan.usePreviousOutput) {
      const last = this.lastExecution(sessionId)
      if (last && last.outputs.length > 0 && mediaSlots[0]) {
        shared[mediaSlots[0]!.slot.param] = last.outputs[0]
      }
    }
    if (attachments.length > 0 && mediaSlots.length > 0) {
      const occupied = new Set(
        mediaSlots.filter((m) => shared[m.slot.param] !== undefined).map((m) => m.slot.param)
      )
      const freeSlots = mediaSlots.filter((m) => !occupied.has(m.slot.param)).map((m) => m.slot)
      const { assignments } = assignAttachmentsToSlots(attachments, freeSlots)
      for (const a of assignments) {
        if (a.slot.param) shared[a.slot.param] = this.resolveAttachmentRef(a.attachment)
      }
    }
    // 数据行:行内值覆盖 shared 同名键;未知键(模板没有的参数名)丢弃并告警。
    // 行内字段名直接用参数名(valueMap.key=参数名),类型转换按参数节点声明。
    const inputNodes = template.paramsNodes.filter((n) => n.category === 'input')
    const nodeByName = new Map(inputNodes.map((n) => [n.name, n]))
    const items = (plan.batch?.items ?? []).map((row) => {
      const clean: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(row ?? {})) {
        if (nodeByName.has(k)) clean[k] = v
        else logger.warn(`workbench batch: dropping unknown param key "${k}" from item row`)
      }
      return { ...shared, ...clean }
    })
    if (items.length < 2) throw new Error('batch items must be >= 2 after merging')
    // mapping:模板的 param name → 工作流节点。valueMap.key=参数名 → buildItemPrompt
    // 从行字典取值并按 valueType 转换;行内没有的键不会被写(prompt 保留模板默认值,
    // 但我们的行是「shared 全量展开」,等价于逐行完整参数)
    const inputsMapping = inputNodes.map((n, i) => ({
      id: n.id,
      key: n.name ?? `param${i}`,
      category: 'input' as const,
      valueType: n.selectedWidget?.type ?? n.type,
      valueMap: { key: n.name ?? `param${i}` }
    }))
    const result = await startBatch({
      prompt: template.prompt,
      inputsMapping,
      items,
      appId: template.id,
      appName: `工作台批量·${template.name}`
    })
    return { jobId: result.job.id, total: items.length }
  }

  /** 批量执行入会话记录(promptId=batch jobId,供产物轮询与链式引用识别) */
  appendBatchExecution(sessionId: string, templateId: string, jobId: string, total: number): void {
    this.appendMessage(sessionId, {
      role: 'agent',
      kind: 'chat',
      text: `批量任务已入队：${total} 条（jobId ${jobId.slice(0, 8)}…），模板 ${templateId}`
    })
    const session = this.getSession(sessionId)
    if (!session) return
    session.executions = session.executions ?? []
    session.executions.push({
      promptId: jobId,
      templateId,
      params: { batch: true },
      outputs: [],
      status: 'queued',
      startedAt: Date.now(),
      batchJobId: jobId
    })
    this.flush()
  }

  // ---------------- 收藏（产物收藏夹，跨会话） ----------------

  listFavorites(sessionId?: string): WorkbenchFavorite[] {
    const all = this.store.favorites ?? []
    return sessionId ? all.filter((f) => f.sessionId === sessionId) : all
  }

  addFavorite(input: {
    sessionId: string
    executionPromptId: string
    file: WorkbenchOutputFile
    note?: string
  }): WorkbenchFavorite {
    const fav: WorkbenchFavorite = {
      id: randomUUID(),
      sessionId: input.sessionId,
      promptId: input.executionPromptId,
      templateId:
        this.getSession(input.sessionId)?.executions?.find(
          (e) => e.promptId === input.executionPromptId
        )?.templateId ?? '',
      file: input.file,
      note: input.note,
      createdAt: Date.now()
    }
    // 去重:同会话同文件重复收藏视为幂等
    const dup = (this.store.favorites ?? []).find(
      (f) =>
        f.sessionId === fav.sessionId &&
        f.file.filename === fav.file.filename &&
        (f.file.subfolder ?? '') === (fav.file.subfolder ?? '')
    )
    if (dup) return dup
    this.store.favorites = [...(this.store.favorites ?? []), fav]
    this.flush()
    return fav
  }

  removeFavorite(id: string): boolean {
    const before = (this.store.favorites ?? []).length
    this.store.favorites = (this.store.favorites ?? []).filter((f) => f.id !== id)
    const changed = this.store.favorites.length !== before
    if (changed) this.flush()
    return changed
  }

  publishToApp(
    _sessionId: string,
    execution: WorkbenchExecution,
    name: string,
    _html?: string
  ): string {
    const template = templateLibrary.get(execution.templateId)
    if (!template) throw new Error(`template not found: ${execution.templateId}`)
    // 参数快照写回 paramsNodes 默认值（决策 #6：固化值=默认值）
    const paramsNodes = structuredClone(template.paramsNodes).map((n) => n)
    const newApp = appStoreManager.createApp({
      name,
      description: template.description,
      template: {
        prompt: template.prompt,
        paramsNodes,
        workflow: undefined
      }
    })
    logger.info(`workbench: published app ${newApp.id} from ${template.id}`)
    // html 由调用方（路由）另走 build-app 存资产；此处只建骨架
    return newApp.id
  }

  // ---------------- 预设 CRUD（copy-dialog 语义） ----------------

  listPresets(): WorkbenchPreset[] {
    // dsh preset.yml order 语义：按 order 升序，缺省排 100
    return [...BUILTIN_PRESETS, ...(this.store.presets ?? [])].sort(
      (a, b) => (a.order ?? 100) - (b.order ?? 100)
    )
  }

  getPreset(id: string): WorkbenchPreset | null {
    return this.listPresets().find((p) => p.id === id) ?? null
  }

  createPreset(opts: { from?: string; id: string; name?: string }): WorkbenchPreset {
    const existing = new Set(this.listPresets().map((p) => p.id))
    const preset = clonePreset(opts.from ?? 'standard', opts.id, opts.name ?? '', existing)
    if (!preset) throw new Error('预设 id 非法或已存在')
    this.store.presets = [...(this.store.presets ?? []), preset]
    this.flush()
    return preset
  }

  /** 预设挂技能（dsh preset skills/ 语义）。内置预设不可改，返回更新后预设。 */
  updatePresetSkills(id: string, skillIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const list = this.store.presets ?? []
    const idx = list.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`preset not found: ${id}`)
    // 只保留真实存在的模板 id（技能=模板快捷方式）
    const valid = new Set(templateLibrary.list().map((t) => t.id))
    const next = [...new Set(skillIds)].filter((s) => valid.has(s))
    const updated = { ...list[idx]!, skillIds: next }
    this.store.presets = list.with(idx, updated)
    this.flush()
    return updated
  }

  deletePreset(id: string): boolean {
    // 内置不可删（dsh 同款：shipped preset 不归用户管理）
    if (BUILTIN_PRESETS.some((p) => p.id === id)) return false
    const before = this.store.presets?.length ?? 0
    this.store.presets = (this.store.presets ?? []).filter((p) => p.id !== id)
    const ok = (this.store.presets?.length ?? 0) < before
    if (ok) this.flush()
    if (this.store.presetDefault === id) this.store.presetDefault = undefined
    return ok
  }

  setDefaultPreset(id: string): boolean {
    if (!this.listPresets().some((p) => p.id === id)) return false
    this.store.presetDefault = id
    this.flush()
    return true
  }

  getDefaultPresetId(): string {
    return this.store.presetDefault ?? BUILTIN_PRESETS[0]!.id
  }

  // ---------------- 技能清单（/ 触发器用：模板快捷方式；预设是点击选择的不参与） ----------------

  /** 环境快照（前端「能力说明」可视化用，与决策注入同源） */
  async getEnvSnapshot(): Promise<WorkbenchEnvSnapshot> {
    return this.collectEnvSnapshot()
  }

  listSkills(): Array<{
    id: string
    kind: 'template'
    name: string
    description: string
    mediaType?: string
  }> {
    const templates = templateLibrary.list().map((t) => ({
      id: t.id,
      kind: 'template' as const,
      name: t.name,
      description: t.description,
      mediaType: t.mediaType
    }))
    return templates
  }

  // ---------------- 可选模型派生（config + 网关常见模型） ----------------

  listModels(): Array<{ id: string; label: string; role: 'decision' | 'build' }> {
    const config = appStoreManager.getConfig()
    const models: Array<{ id: string; label: string; role: 'decision' | 'build' }> = []
    const decisionModel = config.buildModel || 'glm-5.3-flash'
    models.push({ id: decisionModel, label: `${decisionModel}（决策）`, role: 'decision' })
    const buildModel = config.buildModel || decisionModel
    if (buildModel !== decisionModel) {
      models.push({ id: buildModel, label: `${buildModel}（构建）`, role: 'build' })
    }
    return models
  }

  // ---------------- 附件上传（多素材：图/视频/音频） ----------------

  /** 上传单个媒体文件到 ComfyUI，返回附件元数据 */
  /**
   * 附件→工作流参数值。引用类附件(localPath):同机可访问时用绝对路径直通
   * (省一次复制,配合支持绝对路径的加载器);否则回退 ComfyUI 实体名。
   * 全档位可用(B 权限不需要 full)。
   */
  private resolveAttachmentRef(a: AttachmentMeta): string {
    if (a.localPath && existsSync(a.localPath)) return a.localPath
    return a.name
  }

  async uploadAttachment(buffer: Buffer, filename: string, mime?: string): Promise<AttachmentMeta> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const uploaded = await uploadMediaBuffer(comfyOrigin, buffer, filename, mime)
    // 文档类(pdf/txt/md/json…):上传即抽取文本进内存缓存,decide 时注入 spec
    // 供大模型阅读。抽取失败不阻断上传(ComfyUI 侧文件已就位)。
    if (isDocumentAttachment(filename, mime)) {
      await extractDocText(uploaded.name, buffer, filename, mime)
    }
    return {
      name: uploaded.name,
      subfolder: uploaded.subfolder,
      type: uploaded.type,
      kind: deriveAttachmentKind(filename, mime),
      filename,
      size: buffer.length,
      mime
    }
  }
}

export const workbenchService = new WorkbenchService()
