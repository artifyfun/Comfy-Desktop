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
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import appStoreManager from '../appStore'
import { logger } from '../utils/logger'
import { templateLibrary } from './templates'
import { toPseudoApp, type WorkflowTemplate } from './templateCore'
import {
  checkVram,
  validateAgainstObjectInfo,
  validateModels,
  validatePlanLocal,
  type WorkbenchPlan,
  type PlanValidationIssue
} from './plan'
import { executeApp, getExecutionStatus, type ExecutionResult } from '../mcp/executor'
import { Codex, resolveCodexBinary, type BuildProgress } from '../agentDriver'

export type WorkbenchMessageKind = 'chat' | 'card' | 'progress' | 'artifact' | 'error'

export interface WorkbenchMessage {
  role: 'user' | 'agent' | 'system'
  kind: WorkbenchMessageKind
  text: string
  plan?: WorkbenchPlan
  promptId?: string
  outputs?: string[]
  createdAt: number
}

export interface WorkbenchExecution {
  promptId: string
  templateId: string
  params: Record<string, unknown>
  outputs: string[] // gallery 可定位的产物描述
  status: ExecutionResult['status']
  startedAt: number
}

export interface WorkbenchSession {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  messages: WorkbenchMessage[]
  executions: WorkbenchExecution[]
}

interface SessionStore {
  sessions: WorkbenchSession[]
}

const MAX_SESSIONS = 50
const FLUSH_DEBOUNCE_MS = 500

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

  listSessions(): WorkbenchSession[] {
    return [...this.store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): WorkbenchSession | null {
    return this.store.sessions.find((s) => s.id === id) ?? null
  }

  createSession(title = '新会话'): WorkbenchSession {
    const session: WorkbenchSession = {
      id: randomUUID(),
      title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      executions: []
    }
    this.store.sessions.unshift(session)
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

  /** codex 决策提示词：模板清单 + 会话近史 + 用户输入 */
  private buildDecisionSpec(userInput: string, session: WorkbenchSession): string {
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
    return `你是 Artify 工作台的调度 agent。根据用户需求从模板库选择模板并填参数，输出**只含一个 JSON 对象**（无 markdown 代码块、无解释文字）：
{"intent":"image|video|audio|text|chat","templateId":"...","params":{...},"usePreviousOutput":false,"reason":"一句话解释","reply":"chat/text 时直接给用户的回复"}

规则：
1. intent=image/video/audio 必须从下列模板中选 templateId，params 只用模板声明的参数，数值遵守 min/max，枚举必须完全匹配可选值。
2. intent=text 走纯文本生成（文案/起名/总结等），把生成结果放 reply。
3. intent=chat 用于追问澄清或闲聊，回复放 reply。
4. 模板库为空或不匹配时选 chat 并说明。
${chainHint}
## 模板库
${catalog}

## 会话近史
${recent || '（空）'}

## 用户需求
${userInput}`
  }

  /** 从 codex 原始输出提取第一个 JSON 对象（容错：markdown 包裹/前后杂文） */
  static parsePlanFromCodex(raw: string): WorkbenchPlan | null {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    if (start === -1 || end === -1 || end <= start) return null
    try {
      const obj = JSON.parse(raw.slice(start, end + 1)) as WorkbenchPlan
      if (!obj || typeof obj !== 'object' || !('intent' in obj)) return null
      return obj
    } catch {
      return null
    }
  }

  /**
   * 会话主入口：决策 → 校验 → （由调用方决定执行）。
   * 返回 PLAN 与校验结果；SSE 流与执行由路由层编排（分层：服务不持有 res）。
   */
  async decide(
    sessionId: string,
    userInput: string,
    onProgress: (p: BuildProgress) => void
  ): Promise<{ plan: WorkbenchPlan | null; issues: PlanValidationIssue[]; raw: string }> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)
    this.appendMessage(sessionId, { role: 'user', kind: 'chat', text: userInput })

    // codex 决策（复用 agentDriver 的 Codex SDK 直连；单轮，产出 JSON）
    const binary = resolveCodexBinary()
    if (!binary) throw new Error('codex binary not found (run scripts/copy-codex-bin.mjs)')
    const spec = this.buildDecisionSpec(userInput, session)
    const codex = new Codex({
      codexPathOverride: binary,
      baseUrl: 'https://api.deepseek.com/v1',
      apiKey: appStoreManager.getConfig().api_key || process.env.CODEX_API_KEY || ''
    })
    const thread = codex.startThread({
      model: appStoreManager.getConfig().buildModel || 'deepseek-v4-flash',
      sandboxMode: 'workspace-write',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true
    })
    let raw = ''
    const { events } = await thread.runStreamed(spec)
    for await (const event of events) {
      if (typeof event === 'string') raw += event
      else {
        try {
          raw += JSON.stringify(event)
        } catch {
          /* ignore */
        }
      }
      onProgress({ type: 'log', text: 'deciding' })
    }

    const plan = WorkbenchService.parsePlanFromCodex(raw)
    if (!plan) {
      return {
        plan: null,
        issues: [{ field: 'plan', message: 'codex 未输出可解析的 JSON PLAN' }],
        raw
      }
    }
    const validation = validatePlanLocal(plan, templateLibrary.list())
    return { plan, issues: validation.issues, raw }
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

  /** 执行 PLAN（媒体类）。链式：上次产物为 media 参数源。 */
  async execute(
    sessionId: string,
    plan: WorkbenchPlan,
    template: WorkflowTemplate
  ): Promise<WorkbenchExecution> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const args: Record<string, unknown> = { ...(plan.params ?? {}) }
    // 链式：把上次产物作为第一个媒体输入参数（图→视频典型）
    if (plan.usePreviousOutput) {
      const last = this.lastExecution(sessionId)
      if (last && last.outputs.length > 0) {
        const mediaInput = template.paramsNodes.find(
          (n) =>
            n.category === 'input' && /image|video|audio|-uploader$/i.test(n.renderComponent ?? '')
        )
        if (mediaInput && mediaInput.name) args[mediaInput.name] = last.outputs[0]
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
        const files: string[] = []
        for (const v of Object.values(result.outputs as Record<string, unknown>)) {
          const o = v as {
            images?: Array<{ filename?: string }>
            gifs?: Array<{ filename?: string }>
          }
          for (const key of ['images', 'gifs'] as const) {
            for (const it of o[key] ?? []) if (it.filename) files.push(it.filename)
          }
        }
        exec.outputs = files
        this.appendMessage(sessionId, {
          role: 'agent',
          kind: 'artifact',
          text: files.length ? `产物 ${files.length} 个文件` : '执行完成（无产物文件）',
          outputs: files,
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
}

export const workbenchService = new WorkbenchService()
