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
import { existsSync, readdirSync } from 'node:fs'
import type { Dirent } from 'node:fs'
import appStoreManager, { type App, type ComfyPrompt, type ParamNode } from '../appStore'
import { logger } from '../utils/logger'
import { AgentRuntime, type AgentProgressCallback as DecideProgressCallback } from './agentRuntime'
import {
  record as recordExecution,
  markSuccess,
  markError,
  extractFiles,
  type WorkbenchExecution,
  type WorkbenchOutputFile
} from './executionLog'
export type { WorkbenchExecution, WorkbenchOutputFile } from './executionLog'
import type {
  WorkbenchMessage,
  TurnUsage,
  WorkbenchFavorite,
  SessionModelOverride,
  WorkbenchSession,
  WorkbenchDebugLog
} from './sessionTypes'

export type {
  WorkbenchMessage,
  WorkbenchMessageKind,
  TurnUsage,
  WorkbenchFavorite,
  SessionModelOverride,
  WorkbenchSession,
  WorkbenchDebugLog,
  SessionStore
} from './sessionTypes'
import { templateLibrary } from './templates'
import { toPseudoApp, type WorkflowTemplate } from './templateCore'
import {
  checkVram,
  parsePlanFromCodexText,
  validateAgainstObjectInfo,
  validateModels,
  validateNodeOverrides,
  validatePlanLocal,
  type WorkbenchPlan,
  type PlanValidationIssue
} from './plan'
import {
  assignAttachmentsToSlots,
  attachmentSummary,
  clonePreset,
  presetConstraintText,
  BUILTIN_PRESETS,
  type AttachmentKind,
  type AttachmentMeta,
  type WorkbenchPreset
} from './presetCore'
import { renderEnvSnapshot, SELF_KNOWLEDGE_TEXT, type WorkbenchEnvSnapshot } from './selfKnowledge'
import { defaultSkillLibrary, type SkillInfo } from './skillStore'
import { deployWorkbenchSkills } from './skillDeploy'
import { SessionStoreRepo } from './sessionStore'
import { resolveDecideInput } from './decideInput'
import {
  renderDecisionSpec,
  BATCH_RULE,
  TITLE_RULE,
  ORCHESTRATION_RULE,
  MEMORY_RULE,
  CANVAS_RUN_RULES,
  CANVAS_OPS_RULES
} from './specText'
import type { ReasoningEffort } from './reasoningEffort'
import { extractDocText, isDocumentAttachment, renderDocContext } from './docContext'

/* ------------------------------------------------------------------ */
/** 画布当前状态快照（/api/canvas/state 的 digest 投影，供 spec 注入） */
interface CanvasStateSnapshot {
  workflowName: string
  nodeCount: number
  models?: string[]
  keyParams?: Record<string, unknown>
  queue?: { running?: number; pending?: number }
  nodes?: Array<{ id: number | string; type: string; title?: string }>
}

/** 关键参数 → 一行摘要（seed/steps/cfg/sampler/提示词前 40 字） */
function renderKeyParams(kp?: Record<string, unknown>): string {
  if (!kp || Object.keys(kp).length === 0) return '（无）'
  const parts: string[] = []
  if (kp.seed !== undefined) parts.push(`seed=${String(kp.seed)}`)
  if (kp.steps !== undefined) parts.push(`steps=${String(kp.steps)}`)
  if (kp.cfg !== undefined) parts.push(`cfg=${String(kp.cfg)}`)
  if (kp.sampler !== undefined) parts.push(`sampler=${String(kp.sampler)}`)
  if (Array.isArray(kp.prompts))
    parts.push(`prompt=${String((kp.prompts as string[])[0] ?? '').slice(0, 40)}…`)
  if (parts.length === 0) parts.push(JSON.stringify(kp).slice(0, 100))
  return parts.join(' · ')
}
import { get as getSetting } from '../../settings'
import { peekWorkbenchToolSession } from '../mcp/workbenchTools'
import {
  applyNodeOverrides,
  executeApp,
  executePrompt,
  getExecutionStatus,
  getHistory,
  inferOutputParamNodes,
  uploadMediaBuffer,
  type ExecutionResult
} from '../mcp/executor'
import { startBatch } from '../services/batchRunner'
import { deriveAttachmentKind } from './presetCore'

/** decide 过程回调：log=阶段文本；thread_event=codex 结构化事件（透传 SSE）；
 * stream_delta=C16 token 级增量(appserver 通道,AG-UI TEXT/REASONING CONTENT) */
export type {
  DecideProgressEvent,
  AgentProgressCallback as DecideProgressCallback
} from './agentRuntime'

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

/**
 * 部署工作台技能到 codex 的 $CODEX_HOME/skills/（渐进式加载）。
 *
 * 内置（resources/workbench-skills，随包发布）+ 用户（userData/artify-skills，
 * 仅 enabled 且校验通过）整目录复制——技能目录是纯 Agent Skills 开放标准
 * （可带 scripts/references/assets）。codex 0.149.x 启动时扫描该目录，把
 * 「name + description + SKILL.md 路径」注入系统提示（## Skills 段），
 * SKILL.md 正文由模型按需完整读取。
 *
 * 不可用时（打包路径变化/复制失败）静默降级：决策提示词内的最小触发提示
 * 仍能让模型走对路径，只是少了详细指南。
 */
/* deployWorkbenchSkills 迁至 skillDeploy.ts（agentRuntime 共用） */

/**
 * 预设 skillIds 失效过滤：指向已删除/禁用/校验失败的技能时，从决策约束
 * 中剔除（运行期过滤，不落盘）。约束里提示 "read the SKILL.md first" 而
 * 目标不存在，会引导模型做无效读取浪费轮次。库不可用时原样返回。
 */
function effectivePreset(preset: WorkbenchPreset | undefined): WorkbenchPreset | undefined {
  if (!preset?.skillIds?.length) return preset
  try {
    const active = new Set(
      defaultSkillLibrary()
        .list()
        .filter((s) => s.valid && s.enabled)
        .map((s) => s.name)
    )
    if (preset.skillIds.every((id) => active.has(id))) return preset
    return { ...preset, skillIds: preset.skillIds.filter((id) => active.has(id)) }
  } catch {
    return preset
  }
}

/** 单会话 agent 轮次上限（防 harness 无限循环烧 token） */
const MAX_AGENT_TURNS = 24
/** 会话 token 预算上限（spec §4.2④：轮次 + 预算双闸）。input+output 合计。 */
const MAX_SESSION_TOKENS = 2_000_000

class WorkbenchService {
  /** 持久层（候选①）：sessions/presets/favorites/memories 的 home */
  private repo: SessionStoreRepo
  /** /mcp 端点可用性（agent session 创建时探测，决定 spec 是否注入 wb_* 编排段） */
  private mcpAvailable = false
  /** 编排去重标记：decide 轮内 wb_execute_template 真实执行过 → 最终 PLAN 不再重复执行 */
  private orchestratedSessions = new Set<string>()
  /** 会话级 agent 运行时（harness）：codex+thread+tempHome+proxy 跨消息复用，模型上下文连续。
   * 候选①：生命周期收口到 AgentRuntime（agentRuntime.ts），service 为组合根。 */
  private agents = new AgentRuntime({
    readAgentAccess: () => {
      try {
        const fromSettings = getSetting('workbenchAgentAccess')
        const fromConfig = appStoreManager.getConfig().workbenchAgentAccess
        return (fromSettings ?? fromConfig) === 'full' ? 'full' : 'standard'
      } catch {
        try {
          return appStoreManager.getConfig().workbenchAgentAccess === 'full' ? 'full' : 'standard'
        } catch {
          return 'standard'
        }
      }
    },
    onMcpAvailability: (available) => {
      this.mcpAvailable = available
    }
  })

  constructor() {
    this.repo = new SessionStoreRepo({
      storePath: sessionsPath,
      presetExists: (id) => !!this.getPreset(id),
      onDelete: (id) => this.agents.dispose(id)
    })
    templateLibrary.on('change', () => this.pokeTemplates())
  }

  // ---------- agent 运行时（harness P1）：会话级 codex+thread 复用 ----------

  private pokeTemplates(): void {
    // 模板变更无需落盘（模板实时聚合），仅日志
    logger.debug('workbench: template library changed')
  }

  /** 应用退出时清理全部 agent 运行时（组合根 facade→AgentRuntime） */
  disposeAllAgents(): void {
    this.agents.disposeAll()
  }

  /** 导入件产物回填后触碰会话（updated 落盘） */
  touchSession(id: string): void {
    this.repo.touchSession(id)
  }

  /** 导出会话（纯函数核心见 sessionTransfer.ts；剥 debugLogs/batchJobId） */
  exportSession(id: string) {
    return this.repo.exportSession(id)
  }

  /**
   * 导入会话：校验 + 新 UUID 落库（防 id 冲突）。失败返回错误码。
   * duplicate 检测：同源（originId）已导入且未 force → error='duplicate' +
   * existing 摘要，前端确认后 force 重导。
   */
  importSession(
    raw: unknown,
    opts: { force?: boolean } = {}
  ): {
    ok: boolean
    session?: WorkbenchSession
    error?: string
    existing?: { id: string; title: string; updatedAt: number }
  } {
    return this.repo.importSession(raw, opts)
  }

  listSessions(archived?: boolean): WorkbenchSession[] {
    return this.repo.listSessions(archived)
  }

  getSession(id: string): WorkbenchSession | null {
    return this.repo.getSession(id)
  }

  createSession(
    opts: { title?: string; presetId?: string; entry?: WorkbenchSession['entry'] } = {}
  ): WorkbenchSession {
    return this.repo.createSession(opts)
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
    return this.repo.updateSession(id, patch)
  }

  deleteSession(id: string): boolean {
    return this.repo.deleteSession(id)
  }

  appendMessage(sessionId: string, msg: Omit<WorkbenchMessage, 'createdAt'>): void {
    const session = this.getSession(sessionId)
    if (!session) return
    const msgs = session.messages
    // 分支树(dsh 同款):新消息挂在当前 activeLeaf 链末端;无 activeLeaf 时挂最后一条
    const parentIdx = session.activeLeaf !== undefined ? session.activeLeaf : msgs.length - 1
    // 回合分组：用户消息推进 turnSeq（新回合开始），agent 消息继承当前回合。
    // 前端据此把一轮 decide 的过程条目/计划卡/回复/产物合并为一个视觉气泡。
    if (msg.role === 'user') {
      session.turnSeq = (session.turnSeq ?? 0) + 1
    }
    const node: WorkbenchMessage = {
      ...msg,
      createdAt: Date.now(),
      turnId:
        msg.turnId !== undefined
          ? msg.turnId
          : msg.role === 'user'
            ? session.turnSeq
            : (session.turnSeq ?? 0),
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
    this.repo.flush()
  }

  // ---------------- 跨会话长期记忆（dsh memory 语义） ----------------

  listMemories(): Record<string, { value: string; updatedAt: number }> {
    return { ...(this.repo.store.memories ?? {}) }
  }

  /** 写入/更新(幂等,同 key 覆盖);工作台自我更新与用户指令共用此口 */
  rememberMemory(key: string, value: string): void {
    const k = key.trim().slice(0, 64)
    if (!k) throw new Error('memory key 不能为空')
    this.repo.store.memories = {
      ...(this.repo.store.memories ?? {}),
      [k]: { value: value.trim().slice(0, 500), updatedAt: Date.now() }
    }
    this.repo.flush()
  }

  forgetMemory(key: string): boolean {
    if (!this.repo.store.memories || !(key in this.repo.store.memories)) return false
    const next = { ...this.repo.store.memories }
    delete next[key]
    this.repo.store.memories = next
    this.repo.flush()
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
    const entries = Object.entries(this.repo.store.memories ?? {})
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
    this.repo.flush()
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
    this.repo.flush()
    return true
  }

  /** 上一次执行的产物（链式输入源） */
  lastExecution(sessionId: string): WorkbenchExecution | null {
    const session = this.getSession(sessionId)
    if (!session || session.executions.length === 0) return null
    return session.executions[session.executions.length - 1]!
  }

  /** 画布当前状态（C 界面注入桥最近一次 digest 上报；供 M5 感知注入 agent 决策） */
  private async fetchCanvasState(): Promise<CanvasStateSnapshot | null> {
    try {
      const host = appStoreManager.getConfig().serverHost
      if (!host) return null
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 1200)
      const res = await fetch(`${host}/api/canvas/state`, { signal: ctrl.signal })
      clearTimeout(timer)
      if (!res.ok) return null
      const json = (await res.json()) as { data?: { state?: CanvasStateSnapshot | null } }
      return json?.data?.state ?? null
    } catch {
      return null
    }
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
        for (const type of [
          'checkpoints',
          'loras',
          'vae',
          'upscale_models',
          'controlnet',
          // 加载器分离型模型（UNETLoader/CLIPLoader/VAELoader 组合）——
          // 自组工作流选模型必须能看到：Krea2=unet/Qwen-Image-Flash，
          // Anima=diffusion_models/Anima-2.9B + text_encoders 编码器
          'unet',
          'diffusion_models',
          'text_encoders',
          'clip',
          'clip_vision'
        ]) {
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

    return {
      appNames,
      modelsByType,
      vramGb,
      customNodes: customNodes.slice(0, 60),
      modelDirs: (getSetting('modelsDirs') as string[] | undefined) ?? []
    }
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
    // 模板 catalog 瘦身（渐进式加载）：常驻只注入 id/name/mediaType + 参数名
    // 一行清单（让模型能判断"哪个模板大概能干这活"）；完整参数 schema
    // （类型/枚举/范围/rc）下沉到 wb_list_templates 工具按需查。
    const templates = templateLibrary.list()
    const catalog = templates
      .map((t) => {
        const params = t.paramsNodes
          .filter((p) => p.category === 'input')
          .map((p) =>
            p.renderComponent && /uploader$/i.test(p.renderComponent)
              ? `${p.name}（${p.description?.slice(0, 20) || '素材路径'}）`
              : p.name
          )
          .join(', ')
        // 模型依赖摘要：agent 据此判断模板能力/风格（anima=动漫、krea2/qwen=自然语言、
        // redcraft=…）——名字像但模型/参数能力不符的模板不得硬套
        const models = (t.requiredModels ?? []).slice(0, 3).join('、')
        return `- ${t.id}（${t.name}，${t.mediaType}）参数: ${params}${models ? `；模型: ${models}` : ''}`
      })
      .join('\n')
    // 分支树(dsh 同款):decide 历史只走当前激活分支。
    // 注：codex thread 本身跨轮复用（完整工具调用/执行结果都在上下文里），
    // 文本近史只在 fresh thread（agent 运行时被回收重建）时兜底注入一次，
    // 不再每轮拼接——重复注入同一信息既费 token 又稀释模型注意力。
    const agent0 = this.agents.get(session.id)
    const recent =
      !agent0 || agent0.turns === 0
        ? this.activePath(session.id)
            .map((i) => session.messages[i]!)
            .filter((m) => m.kind === 'chat' || m.kind === 'error')
            .slice(-8)
            .map((m) => `${m.role}: ${m.text.slice(0, 200)}`)
            .join('\n')
        : ''
    const lastExec = this.lastExecution(session.id)
    const chainHint = lastExec
      ? `\n## 上一次执行产物\n模板 ${lastExec.templateId}，promptId ${lastExec.promptId}，产物 ${lastExec.outputs.join('、') || '（无）'}。usePreviousOutput=true 时可将其作为图/视频输入。`
      : ''
    const constraint =
      opts.preset && presetConstraintText(opts.preset)
        ? `\n## 会话预设约束（必须遵守）\n${presetConstraintText(opts.preset)}`
        : ''
    // 本会话已上传素材（跨轮保留）：恢复轮/后续轮决策 agent 仍能看到文件名，
    // 避免「附件只在本轮传入、下一轮丢失 → 素材槽没值可传」的传参错乱。
    const knownMedia = [...(opts.attachments ?? [])]
    for (const a of session.attachments ?? []) {
      if (a.kind === 'file') continue
      if (!knownMedia.some((x) => x.filename === a.filename && x.subfolder === a.subfolder))
        knownMedia.push(a)
    }
    const attachmentHint = knownMedia.length
      ? `\n## 用户上传素材（已上传，可作媒体输入；素材槽参数值填下面某个文件名或 http(s)/data URL）\n${attachmentSummary(knownMedia.slice(-6))}`
      : ''
    // 文档类附件的正文内容:大模型在决策时直接阅读(pdf/txt/md/json 等)
    const docHint = opts.attachments?.length ? renderDocContext(opts.attachments) : ''
    const shortcutHint = opts.templateShortcut
      ? `\n## 用户显式指定模板\n必须使用 templateId="${opts.templateShortcut}"。`
      : ''
    // 批量编排能力声明:模型可在识别出多行数据/多变体需求时输出 batch 计划。
    // 详细规则已迁移 wb-batch-memory skill（渐进式加载），这里只留触发提示。
    const batchRule = BATCH_RULE
    const titleRule = TITLE_RULE
    // 编排能力声明：wb_* MCP 工具（decide 轮内自主多步执行的抓手）。
    // 仅在 /mcp 端点可用（server 已监听）时注入。详细指南已迁移
    // wb-orchestration skill（渐进式加载），常驻只留触发条件与工具清单。
    const orchestrationRule = this.mcpAvailable ? ORCHESTRATION_RULE : ''
    // 跨会话记忆注入(dsh memory 语义):读取段 + 自我更新授权
    const memorySection = this.renderMemoryContext()
    const memoryRule = MEMORY_RULE
    // 自我认知 + 环境快照（AGENTS.md 语义：常驻能力说明与本地环境感知）
    let envSection = ''
    try {
      const env = await this.collectEnvSnapshot()
      envSection = `\n## 环境快照\n${renderEnvSnapshot(env)}\n`
    } catch (e) {
      logger.debug('workbench env snapshot render failed', e)
    }
    // 画布当前状态（M5 感知注入）：C 界面注入桥最近一次上报的 digest（含节点清单）。
    // agent 据此知道画布当前 tab 是什么工作流、有哪些节点，才能产出可执行的
    // nodeOverrides / batch 变体（键=节点id.widget名）。
    let canvasSection = ''
    let canvasState: CanvasStateSnapshot | null = null
    try {
      canvasState = await this.fetchCanvasState()
      if (canvasState) {
        const nodesLine = (canvasState.nodes ?? [])
          .slice(0, 25)
          .map((n) => `#${n.id} ${n.type}${n.title ? `（${n.title}）` : ''}`)
          .join('、')
        // P3 A 画布 app 节点台账（A 画布侧栏模式 digest 才带；C 界面为空）
        const appNodes =
          (
            canvasState as {
              appNodes?: Array<{ id: string; name: string; status?: string; params?: string }>
            }
          ).appNodes ?? []
        const appNodesLine = appNodes.length
          ? `App 节点：${appNodes
              .slice(0, 15)
              .map(
                (a) =>
                  `${a.id}「${a.name}」${a.status ?? 'idle'}${a.params ? `（${a.params}）` : ''}`
              )
              .join('、')}`
          : ''
        // A 画布（无限画布页）digest：物件可寻址清单（canvasOps 寻址：图片/
        // 便签/app 节点的真实 id），AI 据此产 select_nodes/connect_nodes 等指令
        const aObjLine =
          (
            canvasState as {
              objects?: Array<{ id: string; kind: string; label: string; size?: string }>
            }
          ).objects ?? []
        const aObjectsLine = aObjLine.length
          ? aObjLine
              .slice(0, 30)
              .map((o) => `${o.id}(${o.kind}${o.size ? ` ${o.size}` : ''}「${o.label}」)`)
              .join('、')
          : ''
        const surface = (canvasState as { surface?: string }).surface
        const aTag = surface === 'a-canvas' ? 'A 画布（无限画布）' : 'C 界面当前激活 tab'
        canvasSection = `\n## 画布当前状态（${aTag}；无则忽略）
工作流：${canvasState.workflowName} · 节点 ${canvasState.nodeCount} 个
模型：${(canvasState.models ?? []).join('、') || '（无）'}
关键参数：${renderKeyParams(canvasState.keyParams)}
队列：running ${canvasState.queue?.running ?? 0} / pending ${canvasState.queue?.pending ?? 0}
节点清单：${nodesLine || '（空画布）'}${appNodesLine ? `\n${appNodesLine}` : ''}${
          aObjectsLine ? `\nA 画布物件（canvasOps 可用 id 寻址）：${aObjectsLine}` : ''
        }
`
      }
    } catch (e) {
      logger.debug('workbench canvas state render failed', e)
    }
    // 画布规则按上下文条件注入（无画布状态=桥未连/非画布界面时整段省略，省 ~350 tok）；
    // A 画布专属的 App 节点操作（3.4）只在 surface=a-canvas 时注入。
    const canvasRunRules = canvasSection ? CANVAS_RUN_RULES : ''
    const canvasOpsRules =
      canvasSection && (canvasState as { surface?: string }).surface === 'a-canvas'
        ? CANVAS_OPS_RULES
        : ''
    // P1 会话入口感知：agent 明确「我在哪个模式」——旧会话无 entry 时不注入，
    // 由画布段标题兜底。画布操作可用性以「画布当前状态」段是否出现为准。
    const entryLabel =
      session.entry === 'a-canvas'
        ? '无限画布 AI 侧栏'
        : session.entry === 'comfy-sidebar'
          ? 'ComfyUI 界面侧栏'
          : session.entry === 'workbench'
            ? '独立工作台'
            : ''
    const entrySection = entryLabel
      ? `\n## 当前入口\n${entryLabel}。画布协同操作（规则 3.x）仅在后文出现「画布当前状态」段时可用；该段缺失时不要假装操作了画布——改用 wb_* 自组工作流执行，或提示用户切到 ComfyUI 界面/无限画布。\n`
      : ''
    return renderDecisionSpec({
      selfKnowledge: SELF_KNOWLEDGE_TEXT,
      entrySection,
      envSection,
      canvasSection,
      canvasRunRules,
      canvasOpsRules,
      chainHint,
      constraint,
      attachmentHint,
      docHint,
      batchRule,
      shortcutHint,
      titleRule,
      memoryRule,
      orchestrationRule,
      catalog,
      recent,
      memorySection,
      userInput
    })
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
    attachments: AttachmentMeta[] = [],
    opts: { signal?: AbortSignal; reasoningEffort?: ReasoningEffort } = {}
  ): Promise<{
    plan: WorkbenchPlan | null
    issues: PlanValidationIssue[]
    raw: string
    resolved: { input: string; presetId?: string; templateShortcut?: string }
  }> {
    const session = this.getSession(sessionId)
    if (!session) throw new Error(`session not found: ${sessionId}`)

    // --- 输入预处理（候选⑤：纯函数层 decideInput.resolveDecideInput） ---
    const resolved0 = resolveDecideInput(
      rawInput,
      {
        getPreset: (id) => this.getPreset(id),
        templates: templateLibrary.list().map((t) => ({ id: t.id, name: t.name })),
        effectivePreset
      },
      { sessionPresetId: session.presetId, attachments }
    )
    const { preset, presetId, templateShortcut } = resolved0
    const effectiveInput = resolved0.input

    this.appendMessage(sessionId, {
      role: 'user',
      kind: 'chat',
      text: rawInput,
      attachments: attachments.length ? attachments : undefined
    })

    // 会话级 agent 运行时（harness P1）：codex+thread 跨消息复用，模型在多次
    // 用户消息/恢复轮之间上下文连续（能看到自己此前的工具调用与执行结果）。
    // 首次创建含代理+临时 CODEX_HOME；之后直接复用。应用重启后 Map 为空 →
    // 自动重建，spec 注入近史兜底。
    // E1:opts.reasoningEffort(路由层已枚举校验;非法值折叠为 undefined,auto 显式
    // 透传=撤销具名档位)随创建透传,exec 通道下轮即时生效。
    const agent = await this.agents.getOrCreate(sessionId, onProgress, opts.reasoningEffort)
    // 技能热刷新：每轮重部署（内置全量+用户 enabled，36 目录 cpSync 开销可忽略）
    // ——会话中途导入/启停的技能本轮即生效，不等新会话。
    deployWorkbenchSkills(agent.tempHome)
    if (agent.turns >= MAX_AGENT_TURNS) {
      throw new Error(`本会话 agent 轮次已达上限（${MAX_AGENT_TURNS} 轮），请新建会话继续`)
    }
    if (agent.totalTokens >= MAX_SESSION_TOKENS) {
      throw new Error(`本会话 token 用量已达预算上限（${MAX_SESSION_TOKENS}），请新建会话继续`)
    }
    const spec = await this.buildDecisionSpec(effectiveInput, session, {
      preset,
      attachments,
      templateShortcut
    })
    // codex exec 的 JSONL 原始行（runDecideTurn 产出，parsePlanFromCodex 用）
    let rawLines: string[] = []
    try {
      rawLines = await this.agents.runDecideTurn(agent, spec, onProgress, opts.signal)
    } catch (e) {
      // 中断/异常都留调试日志（用户停止或失败后「复制 debug」仍有内容可看）。
      // 历史上只记 abort；普通执行异常（如上游 429/超时导致 codex exit 1）不记，
      // 前端「复制调试信息」在失败轮恒报 no debug log yet → 统一补记。
      const aborted =
        !!opts.signal?.aborted || (e instanceof Error && /abort|cancel/i.test(e.message))
      const errMsg = e instanceof Error ? e.message : String(e)
      this.recordDebug(sessionId, {
        effectiveInput,
        presetId,
        templateShortcut,
        spec,
        rawOutput: rawLines.join('\n'),
        plan: null,
        issues: aborted
          ? [{ field: 'abort', message: '用户中断（未产出 PLAN）' }]
          : [{ field: 'exec', message: errMsg.slice(0, 2000) }],
        model: appStoreManager.getConfig().buildModel
      })
      // 错误消息增强：codex CLI 上游失败（HTTP 429/401 等）时 stdout JSONL 会打
      // {"type":"error","message":"exceeded retry limit, last status: 429 ..."}，
      // 而 stderr 只有 "Reading prompt from stdin..."——SDK 抛错消息对用户无意义。
      // 从已采集的 rawLines 反向取最后一条 error 事件，替代 err.message 上抛，
      // 让失败气泡/RUN_ERROR/note 呈现可读原因（429→用户自查余额/配额）。
      const enhanced =
        !aborted && e instanceof Error ? this.enhanceExecError(rawLines.join('\n')) : null
      if (enhanced) {
        const wrapped = new Error(enhanced, { cause: e })
        wrapped.name = e instanceof Error ? e.name : 'Error'
        throw wrapped
      }
      throw e
    }
    const raw = rawLines.join('\n')
    // harness：会话保持（不关代理/不删 tempHome/不失效工具上下文）——
    // 下一次用户消息/恢复轮继续同一 thread。更新活动时间与轮次预算。
    this.agents.touch(sessionId)
    agent.turns++

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
      this.repo.flush()
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
    plan: WorkbenchPlan,
    template: WorkflowTemplate | null
  ): Promise<PlanValidationIssue[]> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const issues: PlanValidationIssue[] = []
    if (template) {
      issues.push(...(await validateAgainstObjectInfo(comfyOrigin, template.prompt)))
      issues.push(...(await validateModels(comfyOrigin, template)))
      // 节点级覆盖网络校验（/object_info widget 类型/枚举/范围）
      if (plan.nodeOverrides)
        issues.push(
          ...(await validateNodeOverrides(comfyOrigin, template.prompt, plan.nodeOverrides))
        )
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
    // 素材槽值形态预检：值必须是已上传文件名或 URL——拦截「提示词文本误填路径槽」
    // （真实事故：Anima+槽位替换A 参数 prompt 收到整段提示词 → LoadImageFromPath
    // 报 No such file or directory）。长句 + 多空格/句号 = 疑似提示词。
    const suspectMedia = mediaSlots.find((m) => {
      const v = args[m.slot.param]
      if (v == null || typeof v !== 'string') return false
      if (/^(data:|https?:)/i.test(v)) return false
      return v.length > 80 && /\s{2,}|[.?!]\s/.test(v)
    })
    if (suspectMedia) {
      throw new Error(
        `参数「${suspectMedia.slot.param}」是素材路径槽，收到「${String(args[suspectMedia.slot.param]).slice(0, 50)}…」不是有效文件。请传已上传素材的文件名或 http(s)/data URL（见会话素材清单）。`
      )
    }
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
    const result = await executeApp(toPseudoApp(template), args, comfyOrigin, plan.nodeOverrides)
    const execution = recordExecution({
      promptId: result.prompt_id,
      templateId: template.id,
      params: args,
      status: result.status
    })
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

  // ---------- P1 能力：裸工作流执行 / 会话模板派生 / 固化 ----------

  /** 会话级派生模板（wb_clone_template）：模板副本 + 节点覆盖，仅本会话可见 */
  private sessionTemplates = new Map<string, WorkflowTemplate[]>()
  private sessionTemplateSeq = 0

  /** 模板解析：模板库优先，其次会话级派生模板 */
  resolveTemplate(sessionId: string, templateId: string): WorkflowTemplate | null {
    const base = templateLibrary.get(templateId)
    if (base) return base
    return this.sessionTemplates.get(sessionId)?.find((t) => t.id === templateId) ?? null
  }

  /** 校验/编排用的模板清单（模板库 + 本会话派生模板） */
  listTemplates(sessionId: string): WorkflowTemplate[] {
    return [...templateLibrary.list(), ...(this.sessionTemplates.get(sessionId) ?? [])]
  }

  /** 克隆模板为会话级变体：把 nodeOverrides 固化进新 prompt（后续可直接跑/再改/固化） */
  cloneTemplate(
    sessionId: string,
    templateId: string,
    nodeOverrides?: WorkbenchPlan['nodeOverrides']
  ): WorkflowTemplate | null {
    const base = this.resolveTemplate(sessionId, templateId)
    if (!base) return null
    const prompt = structuredClone(base.prompt)
    if (nodeOverrides) {
      const errors = applyNodeOverrides(prompt, nodeOverrides)
      if (errors.length > 0) throw new Error(`nodeOverrides 校验失败：\n${errors.join('\n')}`)
    }
    let list = this.sessionTemplates.get(sessionId)
    if (!list) {
      list = []
      this.sessionTemplates.set(sessionId, list)
    }
    const t: WorkflowTemplate = {
      ...base,
      id: `session:${sessionId}:${++this.sessionTemplateSeq}`,
      name: `${base.name} (变体)`,
      prompt,
      source: 'session',
      appId: undefined
    }
    list.push(t)
    return t
  }

  /** 裸工作流执行（wb_run_workflow）：任意 API prompt 直跑，产物落会话 */
  async executeWorkflow(
    sessionId: string,
    workflow: ComfyPrompt,
    opts: {
      name?: string
      seed?: number | null
      randomizeSeed?: boolean
      nodeOverrides?: WorkbenchPlan['nodeOverrides']
    } = {}
  ): Promise<WorkbenchExecution> {
    const comfyOrigin = appStoreManager.getConfig().comfyHost
    const result = await executePrompt(comfyOrigin, workflow, {
      seed: opts.seed,
      randomizeSeed: opts.randomizeSeed,
      nodeOverrides: opts.nodeOverrides,
      workflowKey: opts.name
    })
    const execution = recordExecution({
      promptId: result.prompt_id,
      templateId: opts.name ?? 'session:workflow',
      status: result.status
    })
    const session = this.getSession(sessionId)
    if (session) {
      session.executions.push(execution)
      this.appendMessage(sessionId, {
        role: 'agent',
        kind: 'card',
        text: `执行工作流 ${opts.name ?? '（自建）'}`,
        promptId: execution.promptId
      })
    }
    // 自组/导入工作流执行 → 同步到画布（新 tab；chat 决策期间由路由层注册
    // handler 转 SSE sync 事件 → 前端注入桥 loadWorkflow）。模板编排执行
    // （wb_execute_template）在提交前经 syncTemplateToCanvas 走同通道。
    if (this.canvasSyncHandler || this.canvasSyncHandlers.size > 0) {
      try {
        this.dispatchCanvasSync({ workflow, name: opts.name }, sessionId)
      } catch (e) {
        logger.debug('workbench canvasSyncHandler failed', e)
      }
    }
    return execution
  }

  /**
   * chat 决策期间注册的画布同步回调（路由层注册/清理；执行即上画布）。
   * C7：按会话隔离——handler 注册时带 sessionId，派发只路由到所属会话；
   * 未注册该会话时静默跳过（不误投到其他会话的流）。handler 为 null 时
   * 注销该会话。无 sessionId 的注册走旧全局兜底槽（行为与 C7 前逐字节一致，
   * 覆盖非 chat 链路的手动注册场景）。
   */
  private canvasSyncHandlers = new Map<
    string,
    (sync: { workflow: ComfyPrompt; name?: string; templateId?: string }) => void
  >()
  private canvasSyncHandler:
    | ((sync: { workflow: ComfyPrompt; name?: string; templateId?: string }) => void)
    | null = null

  setCanvasSyncHandler(
    h: ((sync: { workflow: ComfyPrompt; name?: string; templateId?: string }) => void) | null,
    sessionId?: string
  ): void {
    if (!sessionId) {
      // 旧全局语义（无会话绑定）：null 注销，非 null 覆盖
      this.canvasSyncHandler = h
      return
    }
    if (h) this.canvasSyncHandlers.set(sessionId, h)
    else this.canvasSyncHandlers.delete(sessionId)
  }

  /**
   * 派发画布同步：优先会话绑定 handler，缺失回退旧全局 handler（兼容语义）。
   * 审查修复 M-1:显式 sessionId 优先(调用方总是已知——executeWorkflow 首参/
   * syncTemplateToCanvas 的会话),仅缺省时 peek 兜底。修前恒取全局 peek
   * (最早 begin 会话),多会话并行 decide 时 B 会话的画布同步会投递给
   * A 会话注册的 SSE handler(串流)。
   */
  private dispatchCanvasSync(
    sync: {
      workflow: ComfyPrompt
      name?: string
      templateId?: string
    },
    explicitSessionId?: string
  ): void {
    const sessionId = explicitSessionId ?? peekWorkbenchToolSession()
    const h = sessionId ? this.canvasSyncHandlers.get(sessionId) : undefined
    if (h) {
      h(sync)
      return
    }
    this.canvasSyncHandler?.(sync)
  }

  /**
   * 模板编排执行前的画布同步（wb_execute_template 路径）：把目标模板的工作流
   * （有保存布局用布局，否则 prompt 兜底转换）经 canvasSyncHandler 下发（ensure-tab，
   * 桥判定当前 tab 已是同一工作流则复用）。与路由层快路径「执行前 sync」行为
   * 一致——spec 承诺 intent=image/video/audio 执行模板自动加载画布，此前编排
   * 路径缺这一步（真实事故：C 界面侧边栏跑完任务，画布不加载工作流）。
   * handler 未注册（非 chat 链路，如 /execute 直连）时静默跳过，不阻断执行。
   */
  syncTemplateToCanvas(template: WorkflowTemplate, sessionId?: string): void {
    if (!this.canvasSyncHandler && this.canvasSyncHandlers.size === 0) return
    // template.prompt 即 ComfyPrompt（API prompt 格式），与 executeWorkflow 旧路径一致：
    // 统一交给路由层 promptToWorkflowGraph 转 UI graph 下发（含 ensure-tab 与拓扑布局），
    // 不在此区分 workflow 真实布局（routes 写死走转换，传 UI graph 反而类型不符）。
    try {
      this.dispatchCanvasSync(
        {
          workflow: template.prompt,
          name: template.name,
          templateId: template.id
        },
        sessionId
      )
    } catch (e) {
      logger.debug('workbench syncTemplateToCanvas failed', e)
    }
  }

  /** 画布当前工作流执行记录（canvas-run 链路）：execution 落会话，重进会话可见产物 */
  recordCanvasExecution(sessionId: string, promptId: string, name?: string): void {
    const session = this.getSession(sessionId)
    if (!session) return
    session.executions.push(recordExecution({ promptId, templateId: name ?? 'canvas:current' }))
    this.appendMessage(sessionId, {
      role: 'agent',
      kind: 'card',
      text: `执行画布工作流${name ? `（${name}）` : ''}`,
      promptId
    })
    this.repo.flush()
  }

  /**
   * 固化为新 App（wb_publish_workflow / 前端固化）：workflow prompt + 可选
   * paramsNodes（缺省按输出节点推断）→ createApp。复用现有 publish 链路。
   */
  publishWorkflow(name: string, workflow: ComfyPrompt, paramsNodes?: ParamNode[]): App | null {
    const inferred = paramsNodes?.length ? paramsNodes : inferOutputParamNodes(workflow)
    const newApp = appStoreManager.createApp({
      name,
      description: name,
      template: { prompt: workflow, paramsNodes: inferred, workflow: undefined }
    })
    logger.info(`workbench: published app ${newApp.id} from raw workflow "${name}"`)
    return newApp
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
      if (exec) {
        // 产物提取走 executionLog.extractFiles 单一实现（候选 ②）：
        // paramsNodes 声明优先，未声明/未命中时裸扫全部节点（修复历史缺陷
        // 「模板未声明输出节点 → 提取永远为空」）。history 读取失败按无产物
        // 处理，不阻断轮询返回。
        let files: WorkbenchOutputFile[] = []
        try {
          const history = await getHistory(comfyOrigin, promptId)
          files = extractFiles(undefined, history?.outputs as Record<string, unknown> | undefined)
        } catch {
          /* history 读取失败按无产物处理（不阻断轮询返回） */
        }
        markSuccess(exec, files)
        this.appendMessage(sessionId, {
          role: 'agent',
          kind: 'artifact',
          text: files.length ? `产物 ${files.length} 个文件` : '执行完成（无产物文件）',
          outputs: files.map((f) => f.filename),
          outputFiles: files,
          promptId
        })
        this.repo.flush()
      }
    }
    if (result.status === 'error' && result.error) {
      const session = this.getSession(sessionId)
      const exec = session?.executions.find((e) => e.promptId === promptId)
      // 完整错误落执行记录（executionLog.markError 统一截断）
      if (exec) markError(exec, result.error)
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
      this.repo.flush()
    }
    return { ...result, outputsText }
  }

  /** 从 codex exec JSONL raw 里提取最后一条可读错误（codex CLI 上游失败时
   *  stdout 打 {"type":"error","message":"exceeded retry limit, last status: 429..."}，
   *  stderr 却只有无意义的 "Reading prompt from stdin..."。找不到返回 null，
   *  调用方保持原 err.message 上抛） */
  private enhanceExecError(raw: string): string | null {
    if (!raw) return null
    for (const line of raw.split('\n').reverse()) {
      const t = line.trim()
      if (!t.startsWith('{')) continue
      try {
        const obj = JSON.parse(t) as { type?: string; message?: string; item?: unknown }
        if (obj.type === 'error' && typeof obj.message === 'string' && obj.message.trim()) {
          const m = obj.message
          if (/429|Too Many Requests/i.test(m)) {
            return `${m}（上游限流或账号余额不足：请检查 API 设置里的 Key/余额，或稍后重试）`
          }
          if (/401|Unauthorized|authentication/i.test(m)) {
            return `${m}（上游认证失败：请检查 API 设置里的 Key 是否正确/有效）`
          }
          return m.slice(0, 2000)
        }
      } catch {
        /* 非 JSON 行跳过 */
      }
    }
    return null
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
    this.repo.flush()
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
    // 素材槽值形态预检（与单次 execute 一致）：拦截提示词文本误填路径槽
    const suspectMedia = mediaSlots.find((m) => {
      const v = shared[m.slot.param]
      if (v == null || typeof v !== 'string') return false
      if (/^(data:|https?:)/i.test(v)) return false
      return v.length > 80 && /\s{2,}|[.?!]\s/.test(v)
    })
    if (suspectMedia) {
      throw new Error(
        `参数「${suspectMedia.slot.param}」是素材路径槽，收到「${String(shared[suspectMedia.slot.param]).slice(0, 50)}…」不是有效文件。请传已上传素材的文件名或 http(s)/data URL（见会话素材清单）。`
      )
    }
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
    session.executions.push(
      recordExecution({ promptId: jobId, templateId, params: { batch: true }, batchJobId: jobId })
    )
    this.repo.flush()
  }

  // ---------------- 收藏（产物收藏夹，跨会话） ----------------

  listFavorites(sessionId?: string): WorkbenchFavorite[] {
    const all = this.repo.store.favorites ?? []
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
    const dup = (this.repo.store.favorites ?? []).find(
      (f) =>
        f.sessionId === fav.sessionId &&
        f.file.filename === fav.file.filename &&
        (f.file.subfolder ?? '') === (fav.file.subfolder ?? '')
    )
    if (dup) return dup
    this.repo.store.favorites = [...(this.repo.store.favorites ?? []), fav]
    this.repo.flush()
    return fav
  }

  removeFavorite(id: string): boolean {
    const before = (this.repo.store.favorites ?? []).length
    this.repo.store.favorites = (this.repo.store.favorites ?? []).filter((f) => f.id !== id)
    const changed = this.repo.store.favorites.length !== before
    if (changed) this.repo.flush()
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
    return [...BUILTIN_PRESETS, ...(this.repo.store.presets ?? [])].sort(
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
    this.repo.store.presets = [...(this.repo.store.presets ?? []), preset]
    this.repo.flush()
    return preset
  }

  /**
   * 预设捆绑模板（可执行推荐池）。内置预设不可改，返回更新后预设。
   */
  updatePresetTemplates(id: string, templateIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const list = this.repo.store.presets ?? []
    const idx = list.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`preset not found: ${id}`)
    // 只保留真实存在的模板 id
    const valid = new Set(templateLibrary.list().map((t) => t.id))
    const next = [...new Set(templateIds)].filter((s) => valid.has(s))
    const updated = { ...list[idx]!, templateIds: next }
    this.repo.store.presets = list.with(idx, updated)
    this.repo.flush()
    return updated
  }

  /**
   * 预设捆绑技能（SKILL.md 知识技能 name 清单）。内置预设不可改。
   */
  updatePresetSkills(id: string, skillIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const list = this.repo.store.presets ?? []
    const idx = list.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`preset not found: ${id}`)
    const valid = new Set(
      defaultSkillLibrary()
        .list()
        .map((s) => s.name)
    )
    const next = [...new Set(skillIds)].filter((s) => valid.has(s))
    const updated = { ...list[idx]!, skillIds: next }
    this.repo.store.presets = list.with(idx, updated)
    this.repo.flush()
    return updated
  }

  /** 技能改名后修正所有预设的捆绑引用（改名不失效）；供路由层在 update 改名后调用 */
  fixPresetSkillRefs(oldName: string, newName: string): number {
    let changed = 0
    this.repo.store.presets = (this.repo.store.presets ?? []).map((p) => {
      if (!p.skillIds?.includes(oldName)) return p
      changed++
      return { ...p, skillIds: p.skillIds.map((s) => (s === oldName ? newName : s)) }
    })
    if (changed) this.repo.flush()
    return changed
  }

  // ---------------- 技能库（Agent Skills 开放标准，SKILL.md 知识文档） ----------------

  listSkills(): SkillInfo[] {
    return defaultSkillLibrary().list()
  }

  deletePreset(id: string): boolean {
    // 内置不可删（dsh 同款：shipped preset 不归用户管理）
    if (BUILTIN_PRESETS.some((p) => p.id === id)) return false
    const before = this.repo.store.presets?.length ?? 0
    this.repo.store.presets = (this.repo.store.presets ?? []).filter((p) => p.id !== id)
    const ok = (this.repo.store.presets?.length ?? 0) < before
    if (ok) this.repo.flush()
    if (this.repo.store.presetDefault === id) this.repo.store.presetDefault = undefined
    return ok
  }

  setDefaultPreset(id: string): boolean {
    if (!this.listPresets().some((p) => p.id === id)) return false
    this.repo.store.presetDefault = id
    this.repo.flush()
    return true
  }

  getDefaultPresetId(): string {
    return this.repo.store.presetDefault ?? BUILTIN_PRESETS[0]!.id
  }

  // ---------------- 环境快照（前端「能力说明」可视化用，与决策注入同源） ----------------

  /** 环境快照（前端「能力说明」可视化用，与决策注入同源） */
  async getEnvSnapshot(): Promise<WorkbenchEnvSnapshot> {
    return this.collectEnvSnapshot()
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

  /** 记录本会话已上传素材（跨轮决策注入用；上限 20 防膨胀） */
  recordSessionAttachment(sessionId: string, meta: AttachmentMeta): void {
    const session = this.getSession(sessionId)
    if (!session || !meta?.filename) return
    const list = session.attachments ?? (session.attachments = [])
    if (list.some((a) => a.filename === meta.filename && a.subfolder === meta.subfolder)) return
    list.push(meta)
    if (list.length > 20) list.splice(0, list.length - 20)
    this.repo.flush()
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

// 应用退出时清理会话级 agent 运行时（codex 子进程 / 内嵌代理 / 临时 CODEX_HOME）。
// 安全包裹：测试环境的 electron mock 可能没有 once。
try {
  app.once('before-quit', () => workbenchService.disposeAllAgents())
} catch {
  /* 测试环境忽略 */
}
