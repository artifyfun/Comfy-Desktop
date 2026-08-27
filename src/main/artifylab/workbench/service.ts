/**
 * 工作台编排服务（workbench-plan.md Phase 1）。
 *
 * 流程：收集上下文（模板清单+会话历史）→ codex 单轮决策出 PLAN →
 * PLAN 校验（本地 + object_info/models/VRAM）→ 执行（text 走 ai 链路，
 * 媒体走 executor.executeApp 伪 App 复用）→ 会话持久化。
 *
 * 会话存储：userData/workbench-sessions.json（防抖落盘，模式抄 batch-queue）。
 */
import { join } from 'node:path'
import { app } from 'electron'
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
import { get as getSetting } from '../../settings'
import {
  executeApp,
  getExecutionStatus,
  uploadMediaBuffer,
  type ExecutionResult
} from '../mcp/executor'
import { Codex, resolveCodexBaseUrl, resolveCodexBinary } from '../agentDriver'
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

export interface WorkbenchMessage {
  role: 'user' | 'agent' | 'system'
  kind: WorkbenchMessageKind
  text: string
  plan?: WorkbenchPlan
  promptId?: string
  outputs?: string[]
  /** v2：完整产物引用（/view 直出缩略图） */
  outputFiles?: WorkbenchOutputFile[]
  attachments?: AttachmentMeta[]
  createdAt: number
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
  executions: WorkbenchExecution[]
  /** 创建时选定，会话期锁定（dsh agent-preset 语义） */
  presetId?: string
  modelOverride?: SessionModelOverride
  /** 归档：侧栏不显示，数据保留 */
  archived?: boolean
  /** 用户手动改过标题（自动生成不覆盖） */
  titleLocked?: boolean
}

interface SessionStore {
  sessions: WorkbenchSession[]
  presets?: WorkbenchPreset[]
  presetDefault?: string
}

const MAX_SESSIONS = 50
const FLUSH_DEBOUNCE_MS = 500

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

  private appendMessage(sessionId: string, msg: Omit<WorkbenchMessage, 'createdAt'>): void {
    const session = this.getSession(sessionId)
    if (!session) return
    session.messages.push({ ...msg, createdAt: Date.now() })
    session.updatedAt = Date.now()
    this.flush()
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
    const recent = session.messages
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
    const shortcutHint = opts.templateShortcut
      ? `\n## 用户显式指定模板\n必须使用 templateId="${opts.templateShortcut}"。`
      : ''
    const titleRule = `
## 标题（可选）
若为首条消息，可在 JSON 中加 "title":"≤15字会话标题"。`
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
{"intent":"image|video|audio|text|chat","templateId":"...","params":{...},"usePreviousOutput":false,"reason":"一句话解释","reply":"chat/text 时直接给用户的回复","title":"仅首条消息时提供"}

规则：
1. intent=image/video/audio 必须从下列模板中选 templateId，params 只用模板声明的参数，数值遵守 min/max，枚举必须完全匹配可选值。
2. intent=text 走纯文本生成（文案/起名/总结等），把生成结果放 reply。
3. intent=chat 用于追问澄清或闲聊，回复放 reply。
4. 模板库为空或不匹配时选 chat 并说明。
5. 用户上传了素材时，倾向选择带媒体输入参数的模板（图生图/视频驱动），参数值填素材文件名（已上传）。${chainHint}${constraint}${attachmentHint}${shortcutHint}${titleRule}

## 模板库
${catalog}

## 会话近史
${recent || '（空）'}

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
    const codex = new Codex({
      codexPathOverride: binary,
      // 显式注入 config.base_url（new-api 网关）> deepseek 默认
      baseUrl: resolveCodexBaseUrl({
        baseUrl: appStoreManager.getConfig().base_url || undefined
      }),
      apiKey: appStoreManager.getConfig().api_key || process.env.CODEX_API_KEY || '',
      // 用户级 ~/.codex/config.toml 可能定义 model_provider="custom"（如 cliproxy），
      // provider 级 base_url 优先于 --config openai_base_url，导致 8317 劫持。
      // 强制回内置 openai provider 让 baseUrl 覆盖真正生效。
      config: { model_provider: 'openai' }
    })
    const thread = codex.startThread({
      model: appStoreManager.getConfig().buildModel || 'deepseek-v4-flash',
      sandboxMode: 'workspace-write',
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

    const plan = WorkbenchService.parsePlanFromCodex(raw)
    if (!plan) {
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
    if (preset?.intentHint && plan.intent !== preset.intentHint) {
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
        if (a.slot.param) args[a.slot.param] = a.attachment.name
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
      if (exec) exec.status = 'error'
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

  /** 固化：把模板+参数做成新 app（复用 appStore.createApp + appAssets 链路） */
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
    const decisionModel = config.buildModel || 'deepseek-v4-flash'
    models.push({ id: decisionModel, label: `${decisionModel}（决策）`, role: 'decision' })
    const buildModel = config.buildModel || decisionModel
    if (buildModel !== decisionModel) {
      models.push({ id: buildModel, label: `${buildModel}（构建）`, role: 'build' })
    }
    return models
  }

  // ---------------- 附件上传（多素材：图/视频/音频） ----------------

  /** 上传单个媒体文件到 ComfyUI，返回附件元数据 */
  async uploadAttachment(buffer: Buffer, filename: string, mime?: string): Promise<AttachmentMeta> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const uploaded = await uploadMediaBuffer(comfyOrigin, buffer, filename, mime)
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
