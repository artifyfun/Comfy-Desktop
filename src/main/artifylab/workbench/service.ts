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
import appStoreManager, { type App, type ComfyPrompt, type ParamNode } from '../appStore'
import { type AppServerRuntime, createAppServerRuntime } from './appServerRun'
import { logger } from '../utils/logger'
import { templateLibrary } from './templates'
import { exportSession, importSession as importSessionCore } from './sessionTransfer'
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
import { defaultSkillLibrary, type SkillInfo } from './skillStore'
import { extractDocText, isDocumentAttachment, renderDocContext } from './docContext'
import { spawn } from 'node:child_process'
import { getCivitaiApiKey } from './modelKnowledge'

/* ------------------------------------------------------------------ */
/* civitai MCP（civitai-mcp-ultimate，uvx 托管）                        */
/* ------------------------------------------------------------------ */

/**
 * uvx 可用性探测（异步探测 + TTL 缓存）。uvx 缺失/超时 → config.toml 不写该段
 * （降级：wb_query_models action=civitai 走主进程 fetch，仍可在线搜索）。
 * 设计红线：主进程不做 spawnSync 阻塞探测（首次会话创建卡主进程 5s 不可接受）——
 * 启动时异步预热一次，同步读取只看缓存；缓存过期时后台刷新、先用旧值。
 */
const UVX_TTL_MS = 10 * 60 * 1000
let uvxCached: { value: boolean; at: number } | null = null
let uvxProbing = false

async function probeUvxAsync(): Promise<boolean> {
  if (uvxProbing) return uvxCached?.value ?? false
  uvxProbing = true
  try {
    const value = await new Promise<boolean>((resolve) => {
      let settled = false
      const done = (v: boolean) => {
        if (!settled) {
          settled = true
          resolve(v)
        }
      }
      try {
        const child = spawn('uvx', ['--version'], { stdio: 'ignore' })
        const timer = setTimeout(() => {
          try {
            child.kill()
          } catch {
            /* ignore */
          }
          done(false)
        }, 5000)
        timer.unref?.()
        child.on('error', () => {
          clearTimeout(timer)
          done(false)
        })
        child.on('exit', (code) => {
          clearTimeout(timer)
          done(code === 0)
        })
      } catch {
        done(false)
      }
    })
    uvxCached = { value, at: Date.now() }
    if (!value) logger.info('workbench: uvx 不可用，civitai MCP 跳过挂载')
    return value
  } finally {
    uvxProbing = false
  }
}

/** 启动预热：会话创建前缓存就绪，避免同步路径空转 */
void probeUvxAsync().catch(() => {})

function uvxAvailable(): boolean {
  if (uvxCached && Date.now() - uvxCached.at < UVX_TTL_MS) return uvxCached.value
  // 过期/未就绪：后台刷新，本次先用旧值（首次=按不可用降级，下个会话生效）
  void probeUvxAsync().catch(() => {})
  return uvxCached?.value ?? false
}

let civitaiMcpPreWarmed = false
/** fire-and-forget 预热 uvx 包缓存：首次运行要拉 PyPI 包（秒级下载），
 * 不预热则 codex 起 MCP 握手可能超时。spawn error 或异常退出都复位标记，
 * 后续会话创建重试；成功退出（--help 帮助即退出）不复位。 */
function preWarmCivitaiMcp(): void {
  if (civitaiMcpPreWarmed || !uvxAvailable()) return
  civitaiMcpPreWarmed = true
  try {
    const child = spawn('uvx', ['civitai-mcp-ultimate', '--help'], {
      detached: true,
      stdio: 'ignore',
      env: { ...process.env }
    })
    child.on('error', () => {
      civitaiMcpPreWarmed = false
    })
    // 非 0 退出（拉包失败/网络错误）也复位重试；0 = 预热成功
    child.on('exit', (code) => {
      if (code !== 0) civitaiMcpPreWarmed = false
    })
    child.unref()
  } catch {
    civitaiMcpPreWarmed = false
  }
}

function civitaiMcpTomlLines(): string[] {
  // key 复用 LoRA Manager settings（civitai_api_key）：无 key 也能搜（NSFW 受限）
  const envPairs = [`"CIVITAI_API_KEY" = ${JSON.stringify(getCivitaiApiKey())}`]
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || process.env.HTTP_PROXY
  if (proxy) envPairs.push(`"HTTPS_PROXY" = ${JSON.stringify(proxy)}`)
  return [
    `[mcp_servers.civitai]`,
    `command = "uvx"`,
    `args = ["civitai-mcp-ultimate"]`,
    `env = { ${envPairs.join(', ')} }`
  ]
}

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
import { getOrCreateMcpToken } from '../mcp/auth'
import {
  beginWorkbenchToolContext,
  endWorkbenchToolContext,
  peekWorkbenchToolSession
} from '../mcp/workbenchTools'
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
import { Codex, resolveCodexBaseUrl, resolveCodexBinary } from '../agentDriver'
import type { Thread, ThreadOptions } from '../vendor/codex-sdk'
import { toEngineEffort, type ReasoningEffort } from './reasoningEffort'
import { startBatch } from '../services/batchRunner'
import { deriveAttachmentKind } from './presetCore'

/** decide 过程回调：log=阶段文本；thread_event=codex 结构化事件（透传 SSE）；
 * stream_delta=C16 token 级增量(appserver 通道,AG-UI TEXT/REASONING CONTENT) */
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
    | {
        type: 'stream_delta'
        delta: { kind: 'text' | 'reasoning'; itemId: string; delta: string }
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
  /** 回合分组 id：同一轮 decide（用户消息→agent 回复）的消息共享；前端据此合并气泡 */
  turnId?: number
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
  /** 本会话已上传素材（跨轮决策注入用——恢复轮/后续轮 agent 仍能看到文件名） */
  attachments?: AttachmentMeta[]
  /** 创建时选定，会话期锁定（dsh agent-preset 语义） */
  presetId?: string
  modelOverride?: SessionModelOverride
  /** 归档：侧栏不显示，数据保留 */
  archived?: boolean
  /** 用户手动改过标题（自动生成不覆盖） */
  titleLocked?: boolean
  /** 调试日志（每轮 decide 的完整上下文；cap 10 条防会话文件膨胀） */
  debugLogs?: WorkbenchDebugLog[]
  /** 回合序号（用户消息推进；agent 消息继承当前值，前端据此合并气泡） */
  turnSeq?: number
  /** 导入溯源：源会话 UUID（重复导入检测锚点；原生会话无此字段） */
  importedFrom?: string
  /** 会话入口（创建时由前端标记）：workbench=独立工作台 / comfy-sidebar=C 界面侧栏 / a-canvas=无限画布 AI 侧栏 */
  entry?: 'workbench' | 'comfy-sidebar' | 'a-canvas'
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
function deployWorkbenchSkills(codexHome: string): void {
  try {
    defaultSkillLibrary().deployTo(codexHome)
  } catch (e) {
    logger.warn('workbench skills deploy failed', e)
  }
}

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

/** 会话级 agent 运行时状态（harness P1）：codex+thread 跨消息复用 */
interface AgentSession {
  codex: Codex
  thread: Thread
  tempHome: string
  /** 非 deepseek 官方端点时挂的 responses→chat 转换代理（随 session 回收） */
  proxy?: { server: HttpServer; baseUrl: string }
  /** C16:app-server 通道运行时(transport=appserver 时非空,随 session 回收) */
  appServer?: AppServerRuntime
  lastActiveAt: number
  /** 本会话累计 agent 轮次（decide/恢复轮各 +1） */
  turns: number
  totalTokens: number
  /**
   * E1 当前会话推理强度（未指定/已撤销 = undefined，引擎默认）。
   * exec 通道靠下方 threadOptions 引用改写下轮即时生效；appserver 通道在
   * 会话创建时已注入 configArgs，中途变更需会话重建。
   */
  reasoningEffort?: ReasoningEffort
  /** startThread 入参引用（exec 通道）：E1 强度变更直接改引用字段，下轮 run 生效 */
  threadOptions?: ThreadOptions
  /** decide 流式执行中（reap 空闲回收必须跳过，防长轮中途销毁 tempHome/通道） */
  inFlight?: boolean
}

/** agent session 空闲回收：超过该时长无活动即销毁（线程/代理/tempHome） */
const AGENT_IDLE_MS = 10 * 60 * 1000
/** 单会话 agent 轮次上限（防 harness 无限循环烧 token） */
const MAX_AGENT_TURNS = 24
/** 会话 token 预算上限（spec §4.2④：轮次 + 预算双闸）。input+output 合计。 */
const MAX_SESSION_TOKENS = 2_000_000

class WorkbenchService {
  private store: SessionStore = { sessions: [] }
  private flushTimer: NodeJS.Timeout | null = null
  /** /mcp 端点可用性（agent session 创建时探测，决定 spec 是否注入 wb_* 编排段） */
  private mcpAvailable = false
  /** 编排去重标记：decide 轮内 wb_execute_template 真实执行过 → 最终 PLAN 不再重复执行 */
  private orchestratedSessions = new Set<string>()
  /** 会话级 agent 运行时（harness）：codex+thread+tempHome+proxy 跨消息复用，模型上下文连续 */
  private agentSessions = new Map<string, AgentSession>()
  private agentIdleTimer: NodeJS.Timeout | null = null

  constructor() {
    this.load()
    templateLibrary.on('change', () => this.pokeTemplates())
  }

  // ---------- agent 运行时（harness P1）：会话级 codex+thread 复用 ----------

  /**
   * C16 传输通道解析:'exec'(默认,零行为变化) | 'appserver'(token 级流)。
   * 优先级:用户设置 workbenchAgentTransport > appStore 配置 > 'exec'。
   * 红线:M3 默认 exec——appserver 是 C16 灰度通道,显式开启才生效。
   */
  private resolveAgentTransport(): 'exec' | 'appserver' {
    try {
      const fromSettings = getSetting('workbenchAgentTransport')
      if (fromSettings === 'appserver' || fromSettings === 'exec') return fromSettings
    } catch {
      /* 设置读取失败走 appStore */
    }
    try {
      const v = appStoreManager.getConfig().workbenchAgentTransport
      if (v === 'appserver' || v === 'exec') return v
    } catch {
      /* 全部失败回 exec */
    }
    return 'exec'
  }

  /**
   * 取（或建）会话级 agent 运行时。首次创建：起内嵌代理（非 deepseek 官方端点）、
   * 临时 CODEX_HOME（注册 workbench MCP，wb_* 工具回环）、spawn codex、startThread。
   * 后续复用同一 thread → 模型在多次用户消息/恢复轮之间上下文连续，能看到自己
   * 此前的工具调用与执行结果（这是「harness」的核心增益：不再是每轮重新失忆）。
   * 应用重启后 Map 为空 → 自动重建，spec 注入近史兜底（降级不阻断）。
   */
  private async getOrCreateAgentSession(
    sessionId: string,
    onProgress: DecideProgressCallback,
    /**
     * E1 本轮期望推理强度：
     * - 具名档位（minimal/low/…/xhigh）→ 新建会话随 startThread/configArgs 注入；
     *   已建会话（exec 通道）改 threadOptions 引用，下轮 run 即时生效
     * - 'auto' → 撤销具名档位回引擎默认（新建会话即无注入）
     * - undefined（请求未带/非法值被路由过滤）→ 保持会话现状，零行为变化
     */
    reasoningEffort?: ReasoningEffort
  ): Promise<AgentSession> {
    const cached = this.agentSessions.get(sessionId)
    if (cached) {
      this.touchAgentSession(sessionId)
      // E1:undefined=请求未带/非法值(旧客户端)→保持会话现状;仅显式档位或
      // 'auto'(撤销)才变更。创建路径的 auto/undefined 由 toEngineEffort 折叠。
      if (reasoningEffort !== undefined) this.applyAgentEffort(cached, reasoningEffort)
      return cached
    }
    const binary = resolveCodexBinary()
    if (!binary) throw new Error('codex binary not found (run scripts/copy-codex-bin.mjs)')
    const cfg = appStoreManager.getConfig()
    const upstreamBaseUrl = cfg.base_url || 'https://api.deepseek.com/v1'
    let codexBaseUrl = upstreamBaseUrl
    let proxy: AgentSession['proxy']
    // 内嵌 responses→chat 转换代理：上游无 /v1/responses（new-api 默认）时由
    // 应用自身兜底翻译。会话级常驻（复用），随 agent session 一起回收。
    if (!/^https:\/\/api\.deepseek\.com/.test(upstreamBaseUrl)) {
      const p = await startWorkbenchProxy({
        upstreamBaseUrl,
        upstreamApiKey: cfg.api_key || '',
        model: cfg.buildModel || 'glm-5.3-flash'
      })
      proxy = { server: p.server, baseUrl: p.baseUrl }
      codexBaseUrl = p.baseUrl
    }
    const tempHome = mkdtempSync(join(app.getPath('temp'), 'wb-codex-'))
    const { getServerPort } = await import('../server')
    const serverPort = getServerPort()
    this.mcpAvailable = serverPort != null
    if (serverPort) {
      // C7 多会话并行：会话身份融入每会话 MCP server 配置——URL query 带
      // wb_session=<sid>（codex 0.149.x 引擎对每个 [mcp_servers.*] 的
      // RawMcpServerConfig 支持 http_headers/env_http_headers，二进制 strings
      // 实测；此处同步双写 X-Workbench-Session，接收侧未来透传 header 时同构生效）。
      // wb_* 工具按该身份精确路由回本会话，多会话并行 decide 不再串号。
      const mcpUrl = `http://127.0.0.1:${serverPort}/mcp?wb_session=${encodeURIComponent(sessionId)}`
      // 模型目录注入（fallback metadata 根治）：codex 二进制内置模型表只有
      // gpt-5.x/gpt-4.x 系；第三方网关模型（glm/deepseek/自定义）查不到时
      // 退保守 fallback 元数据并刷屏警告（"Model metadata for ... not found"），
      // 上下文窗口猜小会导致过早自动压缩。把用户实际配置的模型写进目录——
      // slug 匹配 startThread 的 model 名即命中，上下文窗口取常见 128k。
      const buildModel = cfg.buildModel || 'glm-5.3-flash'
      // schema 经二进制 strings + 最小复现逐字段探明（codex 0.149.x ModelInfo）：
      // visibility: list|hide|none；truncation_policy: {limit: i64, mode: bytes|tokens}；
      // base_instructions 与 model_messages.instructions_template 二选一必填。
      // 上下文窗口取 128k（常见第三方模型档位），截断阈值 90%。
      const modelCatalog = {
        models: [
          {
            slug: buildModel,
            display_name: buildModel,
            description: 'workbench decide/build model (user configured)',
            visibility: 'list',
            supported_in_api: true,
            priority: 100,
            supported_reasoning_levels: [
              { effort: 'medium', description: 'default reasoning effort' }
            ],
            shell_type: 'unified_exec',
            support_verbosity: true,
            truncation_policy: { limit: 115200, mode: 'tokens' },
            experimental_supported_tools: [],
            base_instructions: 'You are a helpful assistant.',
            context_window: 128000,
            max_context_window: 128000,
            max_output_tokens: 16384
          }
        ]
      }
      const catalogPath = join(tempHome, 'model_catalog.json')
      writeFileSync(catalogPath, JSON.stringify(modelCatalog))
      writeFileSync(
        join(tempHome, 'config.toml'),
        [
          // 顶层键必须在任何 [section] 前（TOML 语义）——模型目录注入
          `model_catalog_json = ${JSON.stringify(catalogPath)}`,
          ``,
          `[mcp_servers.workbench]`,
          `url = "${mcpUrl}"`,
          `bearer_token_env_var = "WORKBENCH_MCP_TOKEN"`,
          `http_headers = { "X-Workbench-Session" = "${sessionId}" }`,
          // approve：exec 单轮 approval_policy=never、workspace-write 沙箱下唯一
          // 无条件放行值（codex mcp_tool_call.rs：只有 AppToolApproval::Approve
          // 不看注解直接豁免；auto/writes 对非 read-only 工具仍要弹窗→被拒）。
          // wb_* 全部经 validatePlanLocal 白名单校验、上下文绑会话，安全面可控。
          `default_tools_approval_mode = "approve"`,
          ``,
          // civitai MCP：uvx 可用时挂载 civitai-mcp-ultimate（在线搜 LoRA/
          // checkpoint、触发词、示例图生成参数、NSFW 分级；只读工具）。
          // 不可用时整段省略——wb_query_models action=civitai（主进程
          // fetch，零依赖）兜底，两条通路不互斥。
          ...(uvxAvailable() ? civitaiMcpTomlLines() : []),
          ``,
          // workspace-write 沙箱默认禁网 —— MCP(streamable HTTP) 属 executor 侧
          // 网络，不放行则每次工具调用被 sandbox network proxy 拦截（探针实测
          // "MCP tool call failed"，模型只能放弃编排）。仅放行回环 MCP 端点。
          `[sandbox_workspace_write]`,
          `network_access = true`,
          ``
        ].join('\n')
      )
      preWarmCivitaiMcp()
    }
    // 渐进式加载（skill 机制）：codex 0.149.x 原生扫描 $CODEX_HOME/skills/
    // 下每个 <name>/SKILL.md（frontmatter name/description），把「name+description
    // +路径」目录注入系统提示（## Skills 段），SKILL.md 正文按需完整读取——
    // 决策提示词只留触发提示，长规则下沉 skill，省常驻 token 且不互相干扰。
    try {
      deployWorkbenchSkills(tempHome)
    } catch (e) {
      // skill 部署失败不阻断会话创建：决策提示词内保留了最小触发提示
      logger.warn('workbench skill deploy failed', e)
    }
    beginWorkbenchToolContext(sessionId)
    // C16 传输通道分流:appserver = codex app-server 子进程(JSON-RPC,token 级
    // delta);默认 exec(零行为变化,红线:M3 默认不切)。两通道共用 tempHome
    // (MCP 配置/技能同构)与代理(provider base_url 同源)。
    const transport = this.resolveAgentTransport()
    // E1 会话级推理强度 → 引擎 config 值:具名档位原样透传,auto/缺省=undefined
    // 不注入(引擎默认,零行为变化)。appserver 通道随 configArgs 在 spawn 时注入
    // (中途变更需会话重建);exec 通道走下方 threadOptions 引用,下轮即时生效。
    const engineEffort = toEngineEffort(reasoningEffort)
    let appServer: AgentSession['appServer']
    if (transport === 'appserver') {
      appServer = await createAppServerRuntime({
        binary,
        env: {
          ...process.env,
          CODEX_HOME: tempHome,
          WORKBENCH_CODEX_API_KEY: cfg.api_key || process.env.CODEX_API_KEY || '',
          ...(serverPort ? { WORKBENCH_MCP_TOKEN: getOrCreateMcpToken() } : {})
        },
        configArgs: [
          `model="${cfg.buildModel || 'glm-5.3-flash'}"`,
          'model_provider="openai_http"',
          ...(engineEffort ? [`model_reasoning_effort="${engineEffort}"`] : []),
          `model_providers.openai_http={ name = "Artify Workbench HTTP", base_url = "${resolveCodexBaseUrl({ baseUrl: codexBaseUrl })}", env_key = "WORKBENCH_CODEX_API_KEY", wire_api = "responses", requires_openai_auth = false, supports_websockets = false }`
        ]
      })
    }
    const codex = new Codex({
      codexPathOverride: binary,
      baseUrl: resolveCodexBaseUrl({
        baseUrl: codexBaseUrl
      }),
      apiKey: cfg.api_key || process.env.CODEX_API_KEY || '',
      env: {
        ...process.env,
        CODEX_HOME: tempHome,
        // provider 用 env_key 字段读 API key（codex 0.149.x 的 provider 段
        // 没有 api_key 字段；环境变量注入是官方自定义 provider 的标准做法）
        WORKBENCH_CODEX_API_KEY: cfg.api_key || process.env.CODEX_API_KEY || '',
        ...(serverPort ? { WORKBENCH_MCP_TOKEN: getOrCreateMcpToken() } : {})
      },
      // 双保险：即使泄露进 provider 配置，也强制回内置 openai 让 baseUrl 生效。
      // code_mode/tool_search 关闭：0.149.x 新路由默认把 MCP 工具交给 JS
      // code-mode runtime / 延迟注册（deferred），exec --experimental-json 单轮
      // 下两者都不可用 → 模型调用报 "unsupported call: wb_*"（stderr 实测）。
      // 关掉走经典工具路由，MCP 工具直接注册进 router。
      config: {
        // 自定义 provider 强制 HTTPS Streaming：codex 默认先试 WebSocket
        // /v1/responses，而本机代理（mimo2codex）只实现了 POST 端点 → 每次
        // 决策都要「404 → 重连 5 次 → 回退 HTTPS」浪费十几秒。保留
        // wire_api="responses"（能力不变），supports_websockets=false 让引擎
        // 直接走 HTTPS。
        //
        // 字段名必须是 base_url + env_key（0.149.x 引擎实测：api_base_url /
        // api_key 不被识别，base_url 静默回落到 api.openai.com → 401 →
        // "Codex Exec exited with code 1"，且 401 前没有任何 WS 尝试，说明
        // supports_websockets 已生效）。
        model_provider: 'openai_http',
        'model_providers.openai_http': {
          name: 'Artify Workbench HTTP',
          base_url: resolveCodexBaseUrl({
            baseUrl: codexBaseUrl
          }),
          env_key: 'WORKBENCH_CODEX_API_KEY',
          wire_api: 'responses',
          requires_openai_auth: false,
          supports_websockets: false
        },
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
    // E1:threadOptions 保留引用——exec 通道每轮 run 从该对象读 modelReasoningEffort,
    // 中途切档直接改引用字段即可下轮生效(SDK startThread 原样持有入参对象,零拷贝)
    const threadOptions: ThreadOptions = {
      model: cfg.buildModel || 'glm-5.3-flash',
      sandboxMode: agentAccess === 'full' ? 'danger-full-access' : 'workspace-write',
      workingDirectory: process.cwd(),
      skipGitRepoCheck: true,
      ...(engineEffort ? { modelReasoningEffort: engineEffort } : {})
    }
    const thread = codex.startThread(threadOptions)
    const agent: AgentSession = {
      codex,
      thread,
      tempHome,
      proxy,
      ...(appServer ? { appServer } : {}),
      ...(engineEffort ? { reasoningEffort: engineEffort } : {}),
      threadOptions,
      lastActiveAt: Date.now(),
      turns: 0,
      totalTokens: 0
    }
    this.agentSessions.set(sessionId, agent)
    this.scheduleAgentIdleReap()
    if (proxy) {
      onProgress({
        type: 'log',
        text: `responses→chat 代理已就绪 ${proxy.baseUrl} → ${upstreamBaseUrl}`
      })
    }
    return agent
  }

  /**
   * E1 会话推理强度落 agent（调用方保证 reasoningEffort 为具名档位或 'auto'）：
   * - exec 通道：改 threadOptions 引用（SDK 每轮 spawn 前读该字段），下轮即时生效
   * - appserver 通道：effort 已在会话创建时注入 configArgs，此处仅记档——
   *   中途变更需会话重建才生效
   * - 具名档位 → 记档 + 注入；'auto' → 清档回引擎默认
   */
  private applyAgentEffort(agent: AgentSession, reasoningEffort?: ReasoningEffort): void {
    const eff = toEngineEffort(reasoningEffort)
    agent.reasoningEffort = eff
    if (agent.threadOptions) {
      if (eff) agent.threadOptions.modelReasoningEffort = eff
      else delete agent.threadOptions.modelReasoningEffort
    }
  }

  private touchAgentSession(sessionId: string): void {
    const agent = this.agentSessions.get(sessionId)
    if (agent) agent.lastActiveAt = Date.now()
  }

  /** 销毁会话级 agent 运行时：关代理、删临时 CODEX_HOME、失效 wb_* 工具上下文 */
  private disposeAgentSession(sessionId: string): void {
    const agent = this.agentSessions.get(sessionId)
    if (!agent) return
    this.agentSessions.delete(sessionId)
    if (agent.appServer) {
      void agent.appServer.dispose().catch(() => {})
    }
    try {
      agent.proxy?.server.close()
    } catch {
      /* 代理关闭失败不影响 */
    }
    try {
      rmSync(agent.tempHome, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响 */
    }
    endWorkbenchToolContext(sessionId)
  }

  /** 空闲回收：超时无活动的 agent session 销毁（线程/代理/tempHome 不常驻） */
  private scheduleAgentIdleReap(): void {
    if (this.agentIdleTimer) return
    this.agentIdleTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, agent] of this.agentSessions) {
        // decide 流式执行中不回收：SSE 总超时（15min）可超过 AGENT_IDLE_MS，
        // 此时 lastActiveAt 停留在轮起——不跳过会销毁活跃会话的 tempHome/通道
        if (agent.inFlight) continue
        if (now - agent.lastActiveAt > AGENT_IDLE_MS) this.disposeAgentSession(id)
      }
      if (this.agentSessions.size === 0 && this.agentIdleTimer) {
        clearInterval(this.agentIdleTimer)
        this.agentIdleTimer = null
      }
    }, 60_000)
    // 不 hold 事件循环退出
    this.agentIdleTimer.unref?.()
  }

  /** 应用退出时清理全部 agent 运行时 */
  disposeAllAgentSessions(): void {
    for (const id of Array.from(this.agentSessions.keys())) this.disposeAgentSession(id)
    if (this.agentIdleTimer) {
      clearInterval(this.agentIdleTimer)
      this.agentIdleTimer = null
    }
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

  /** 导入件产物回填后触碰会话（updated 落盘） */
  touchSession(id: string): void {
    const s = this.getSession(id)
    if (s) {
      s.updatedAt = Date.now()
      this.flush()
    }
  }

  /** 导出会话（纯函数核心见 sessionTransfer.ts；剥 debugLogs/batchJobId） */
  exportSession(id: string) {
    const session = this.getSession(id)
    if (!session) return null
    return exportSession(session)
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
    const existing = new Set(this.store.sessions.map((s) => s.id))
    const imported = this.store.sessions
      .filter((s) => !!s.importedFrom)
      .map((s) => ({
        importedFrom: s.importedFrom!,
        id: s.id,
        title: s.title,
        updatedAt: s.updatedAt
      }))
    const r = importSessionCore(raw, existing, { force: opts.force, imported })
    if (!r.ok || !r.session) return { ok: false, error: r.error }
    this.store.sessions.unshift(r.session)
    this.flush()
    return { ok: true, session: r.session }
  }

  listSessions(archived?: boolean): WorkbenchSession[] {
    return [...this.store.sessions]
      .filter((s) => (archived === undefined ? true : !!s.archived === archived))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }

  getSession(id: string): WorkbenchSession | null {
    return this.store.sessions.find((s) => s.id === id) ?? null
  }

  createSession(
    opts: { title?: string; presetId?: string; entry?: WorkbenchSession['entry'] } = {}
  ): WorkbenchSession {
    const session: WorkbenchSession = {
      id: randomUUID(),
      title: opts.title || '新会话',
      // 用户在建会话时显式填了标题 → 视同手动命名，防 PLAN 自动标题覆盖
      titleLocked: !!opts.title,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [],
      executions: [],
      presetId: opts.presetId,
      entry: opts.entry
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
    if (ok) {
      // 会话删除时一并销毁其 agent 运行时（线程/代理/tempHome）
      this.disposeAgentSession(id)
      this.flush()
    }
    return ok
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
    const agent0 = this.agentSessions.get(session.id)
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
    const batchRule = `
## 批量 / 记忆
用户需要多条产出（列出行/表格/N 个变体）→ batch 计划；用户表达跨会话偏好/事实 → intent=memory。
batch 字段格式与 wb_execute_template 的 batch_items/batch_shared_params 一致（items 2~200 行，行键=模板参数名，行内值优先于 params/sharedParams）。
详细规则见 wb-batch-memory skill（可用时先读 SKILL.md 再输出）。
`
    const titleRule = `
## 标题（可选）
若为首条消息，可在 JSON 中加 "title":"≤15字会话标题"。`
    // 编排能力声明：wb_* MCP 工具（decide 轮内自主多步执行的抓手）。
    // 仅在 /mcp 端点可用（server 已监听）时注入。详细指南已迁移
    // wb-orchestration skill（渐进式加载），常驻只留触发条件与工具清单。
    const orchestrationRule = this.mcpAvailable
      ? `
## 多步编排 / 工作流创作（wb_* 工具）
- **简单需求**（选一个模板出图/出视频/答一句话）直接输出 PLAN JSON，不要调工具。
- **多步需求**（先调研/生成，再基于结果继续）或**模板表达不了**（自定义节点连线/组合）或**节点级精细参数**（node_overrides）→ 读 wb-orchestration skill 后按它执行。
- 工具清单：wb_list_templates / wb_execute_template（wait=true 阻塞拿产物）/ wb_get_outputs（非阻塞查产物）/ wb_list_nodes（查节点图；无参=全量节点类型）/ wb_validate_workflow / wb_run_workflow / wb_clone_template / wb_publish_workflow / wb_remember / wb_forget。
- 链式：wb_execute_template / wb_run_workflow 传 use_previous_output=true 引用上一步产物。
`
      : ''
    // 跨会话记忆注入(dsh memory 语义):读取段 + 自我更新授权
    const memorySection = this.renderMemoryContext()
    const memoryRule = `
## 长期记忆（intent=memory）
用户表达可跨会话保留的偏好/事实（「以后都用...」「记住我喜欢...」「我的显卡是...」）→ intent=memory；要求忘掉 → action=forget。
详细格式见 wb-batch-memory skill（可用时先读 SKILL.md 再输出）。`
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
    const canvasRunRules = canvasSection
      ? `3.1 **把工作流加载到画布**（用户说「把工作流同步到画布 / 加载工作流 / 打开某模板的画布布局」）→ intent=workflow + templateId 选目标模板（模板库清单里的 id）。画布会自动开新 tab 加载该模板的布局（当前 tab 已是同一工作流时复用，不重复开）；模板未保存布局时系统会从模板参数自动生成节点布局（无连线，可手动整理）。
3.1b **模板执行自动加载画布**：intent=image/video/audio 执行模板时，系统**自动**先把该模板工作流加载到画布（新 tab；当前 tab 已是同一工作流则复用）再执行——无需额外字段。（兼容：显式带 "syncCanvasBeforeExec":true 同样生效。）
3.2 **执行画布当前工作流**（用户说「执行画布上的工作流 / 跑一下当前图 / 按画布参数生成 / 用当前画布出图」）→ intent=canvas-run（**不指定 templateId**；可带 nodeOverrides 按节点 id 覆盖 widget，如 {"16":{"widgetOverrides":{"steps":40}}}）。
3.3 **画布批量执行**（对当前画布多变体/多参数组合批量出图）→ intent=canvas-run + batch.items（每行=一组变体）。行内键用「节点id.widget名」格式（如 "16.steps":40、"9.text":"新提示词"），值=该 widget 新值；共有的固定变体放 sharedParams（同格式）。系统按行逐条执行画布当前工作流。
`
      : ''
    const canvasOpsRules =
      canvasSection && (canvasState as { surface?: string }).surface === 'a-canvas'
        ? `3.4 **A 画布 App 节点操作**（用户在 A 画布侧栏工作台说「跑一下节点 X / 新建一个 XX 应用节点 / 把节点 X 参数改成… / 连一下 A→B」）→ intent=canvas-ops + canvasOps 指令数组：
  - {"type":"run_node","nodeId":"a17…"} 触发某 App 节点运行（params 可选覆盖 {"节点id":{"widget":值}}）
  - {"type":"add_app_node","appId":"模板id","name":"…","x":…,"y":…} 在画布新建 App 节点
  - {"type":"update_node","id":"节点id","patch":{"params":{…}}} 改节点参数/位置
  - {"type":"connect_nodes","from":"上游物件id","to":"节点id"} 建数据管道（上游产物/便签喂下游）
  - {"type":"select_nodes","ids":["…"]} 选中若干节点
  「画布当前状态」段的 appNodes 清单是可用节点台账（id/name/status/params）；指令经用户画布确认卡人审后执行。
`
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
    return `${SELF_KNOWLEDGE_TEXT}${entrySection}${envSection}${canvasSection}
根据用户需求从模板库选择模板并填参数，输出**只含一个 JSON 对象**（无 markdown 代码块、无解释文字）：
{"intent":"image|video|audio|text|chat|memory|workflow|canvas-run|canvas-ops","templateId":"...","params":{...},"canvasOps":[{"type":"run_node","nodeId":"..."}],"usePreviousOutput":false,"reason":"一句话解释","reply":"chat/text/memory 时直接给用户的回复","memory":{"action":"remember|forget","key":"...","value":"remember 时必填"},"title":"仅首条消息时提供"}

规则：
1. **模板严格匹配才执行**：intent=image/video/audio 前先评估模板库——模板的
   能力/风格/模型与需求**真正匹配**才选 templateId。判断依据看 catalog 的
   **模型依赖与参数角色**（不是名字）：模板模型含 anima 系/参数是图片路径槽，
   是**动漫风格图生图**；需求「写实」却只有动漫模板 → **不匹配**；需求「图生图」
   但模板是文生图（无素材槽）→ 也不匹配。**名称像但能力不符的模板不得硬套**
   ——套了只会出错的图或执行失败。模板库无真正匹配 → 按 1.1 自组工作流。
1.1 **自组工作流（模板不匹配时的正解，不是变通）**：根据需求 + 本机模型/节点自建一个最小可执行工作流：
   - 查节点：wb_list_nodes()（不带 template_id）看全量节点类型与输入 schema；
   - 选模型：从「环境快照」模型清单挑——注意本机 checkpoints 目录可能没有
     标准底模，文生图用加载器分离组合：UNETLoader（unet/ 或 diffusion_models/
     里的 Anima-2.9B、Qwen-Image-Flash）+ CLIPLoader（text_encoders/clip/ 里的
     Qwen3 编码器）+ VAELoader（vae/）；风格用 loras/。可先 wb_list_nodes
     查 Krea2/Anima 模板的加载器结构作参考（它们本机可跑）；
   - 组图骨架（API 格式）：文生图 = UNETLoader/CheckpointLoader → CLIPTextEncode
     (正向/负向) → KSampler → VAEDecode → SaveImage；图生图 = 前面加
     LoadImage → VAEEncode；放大/ControlNet/多模型按需追加；
     负向提示词**按模型族区分**：FLUX / Krea2 系（Qwen3-VL 自然语言编码器）
     无负向通道——负向 CLIPTextEncode 传空串或直接省略，写了也不生效；
     Anima / SD 系（标签式编码器）必须写负向。模型族判定看加载器组合
     （UNETLoader+CLIPLoader=分离系走各自规则；CheckpointLoader 按
     「环境快照」模型清单里的家族名）。
   - 校验执行：wb_validate_workflow → wb_run_workflow(workflow, wait=true)；产物自动落会话；
   - 效果好可 wb_publish_workflow 固化供复用。
   自组才是「根据需求建工作流」，宁可多调几次工具，也别为了省事硬套不合适的固化模板。
1.2 **模型知识查询**（涉及 lora/模型选型或写提示词没把握时）：wb_query_models 查本机模型的 civitai 触发词/用法提示/官方示例提示词（action=search 搜清单，action=detail 拿单模型详情）——用 lora 前先看触发词与示例提示词，别凭空猜触发词；用法细则见 wb-model-knowledge skill。
2. intent=text 走纯文本生成（文案/起名/总结等），把生成结果放 reply。
3. intent=chat 用于追问澄清或闲聊，回复放 reply。
${canvasRunRules}${canvasOpsRules}4. 模板库为空或不匹配时选 chat 并说明。可跨会话保留的偏好/事实用 intent=memory（见「长期记忆」段）。
5. 用户上传了素材时，倾向选择带媒体输入参数的模板（图生图/视频驱动），参数值填素材文件名（已上传）。
5.1 **参数类型**：模板参数里的 rc（renderComponent）为 *-uploader 的是**素材文件槽**——只能传已上传素材的文件名或 data:/http(s): URL，不能传提示词文本（会导致 ComfyUI 报 No such file or directory）。参数名带「路径/文件/图片」描述或参数说明里标注了「路径」的同样视为素材槽。只有 rc=textarea/select/slider/number（或无 rc 的文本型）参数才收提示词/数值。catalog 里素材槽会显示为「参数名（素材路径）」。
5.2 **模板不合适就变通，不要盲目重试**：关键参数全是素材槽而用户要文生图时，先复盘本会话此前的工具调用与执行结果（基于事实修正而非凭空重试），然后读 wb-media-params skill（可用时）按变通路径处理：node_overrides 改节点参数 → wb_run_workflow 自组工作流 → wb_clone_template 派生变体。重试同参数只会重复同样的失败。
6. 存在「会话预设约束」段落时，其 intent 限制是**硬性规则**，违反的输出会被系统直接拒绝——你必须输出该 intent。7. 有「多步编排」段时优先按它执行；单步需求仍直接出 PLAN JSON。
8. 填 params 前若不确定某参数的类型/可选值，wb_list_templates 查完整 schema（枚举必须完全匹配可选值）。${chainHint}${constraint}${attachmentHint}${docHint}${batchRule}${shortcutHint}${titleRule}${memoryRule}${orchestrationRule}

## 模板库（清单；完整参数 schema 用 wb_list_templates 查）
${catalog}
${recent ? `\n## 会话近史（fresh thread 兜底；有此段时它就是本会话此前对话）\n${recent}\n` : ''}${memorySection}

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

    // --- 输入预处理：斜杠 token（技能=模板快捷方式，单选）> 会话预设 ---
    const slash = parseSlashToken(rawInput, [], templateLibrary.list())
    const presetId = session.presetId
    let templateShortcut: string | undefined
    let userInput = rawInput
    if (slash?.kind === 'template') {
      templateShortcut = slash.id
      userInput = slash.rest
    }
    const preset = effectivePreset((presetId ? this.getPreset(presetId) : undefined) ?? undefined)
    // 预设提示词模板展开（{input} 占位）；附件-only 输入给默认占位提示
    const baseInput = userInput.trim() || '按我上传的素材生成'
    const effectiveInput = applyPromptTemplate(preset, baseInput)

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
    const agent = await this.getOrCreateAgentSession(sessionId, onProgress, opts.reasoningEffort)
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
    // codex exec 的 JSONL 原始行（string 形态）——parsePlanFromCodex 容错解析用
    const rawLines: string[] = []
    // 流式窗口标记 inFlight：reap 空闲回收跳过本会话（finally 保证任何出口复位）
    agent.inFlight = true
    try {
      if (agent.appServer) {
        // C16 appserver 通道:token 级 delta 经 thread_event 旁路 + stream_delta
        // 上抛(路由层 mapper.feedStreamDelta 映射 AG-UI 增量帧);exec 形态事件
        // 照常 thread_event 透传,rawLines 收 JSON.stringify(PLAN 解析同构)。
        const { stream } = await agent.appServer.startTurn(spec, opts.signal)
        for await (const frame of stream) {
          for (const d of frame.deltas) {
            onProgress({ type: 'stream_delta', delta: d })
          }
          if (frame.event) {
            onProgress({ type: 'thread_event', event: frame.event })
            try {
              rawLines.push(JSON.stringify(frame.event))
            } catch {
              /* ignore */
            }
            if (
              frame.event.type === 'turn.completed' &&
              (frame.event as { usage?: unknown }).usage
            ) {
              const u = (frame.event as unknown as { usage: Record<string, number> }).usage
              agent.totalTokens += Number(u.input_tokens ?? 0) + Number(u.output_tokens ?? 0)
            }
          }
          onProgress({ type: 'log', text: 'deciding' })
        }
      } else {
        const { events } = await agent.thread.runStreamed(spec, { signal: opts.signal })
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
          // 轮级 usage 累计（预算监控：每会话 token 总量）
          if (event.type === 'turn.completed' && event.usage) {
            agent.totalTokens +=
              Number(event.usage.input_tokens ?? 0) + Number(event.usage.output_tokens ?? 0)
          }
          onProgress({ type: 'log', text: 'deciding' })
        }
      }
    } catch (e) {
      // 中断/异常也留调试日志（用户停止后「复制 debug」仍有内容可看）；
      // 仅 abort 场景记录（其他异常由上层统一处理）
      const aborted =
        !!opts.signal?.aborted || (e instanceof Error && /abort|cancel/i.test(e.message))
      if (aborted) {
        this.recordDebug(sessionId, {
          effectiveInput,
          presetId,
          templateShortcut,
          spec,
          rawOutput: rawLines.join('\n'),
          plan: null,
          issues: [{ field: 'abort', message: '用户中断（未产出 PLAN）' }],
          model: appStoreManager.getConfig().buildModel
        })
      }
      throw e
    } finally {
      agent.inFlight = false
    }
    const raw = rawLines.join('\n')
    // harness：会话保持（不关代理/不删 tempHome/不失效工具上下文）——
    // 下一次用户消息/恢复轮继续同一 thread。更新活动时间与轮次预算。
    this.touchAgentSession(sessionId)
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
    const execution: WorkbenchExecution = {
      promptId: result.prompt_id,
      templateId: opts.name ?? 'session:workflow',
      params: {},
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
    session.executions.push({
      promptId,
      templateId: name ?? 'canvas:current',
      params: {},
      outputs: [],
      status: 'queued',
      startedAt: Date.now()
    })
    this.appendMessage(sessionId, {
      role: 'agent',
      kind: 'card',
      text: `执行画布工作流${name ? `（${name}）` : ''}`,
      promptId
    })
    this.flush()
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
        exec.status = 'success'
        const files: WorkbenchOutputFile[] = []
        // 产物提取：直接扫 ComfyUI 原始 history outputs 的所有节点 images/gifs——
        // getExecutionStatus 的 extractOutputs 只挑 paramsNodes 声明的 output 节点，
        // 而模板固化时常未声明输出（Anima+槽位替换A 等只声明输入参数 prompt）→
        // 提取永远为空 → 前端「无产物文件」（真实事故：ComfyUI 已输出 2 张图，
        // 会话产物却是 0）。
        try {
          const history = await getHistory(comfyOrigin, promptId)
          const rawOutputs = (history?.outputs as Record<string, unknown>) ?? {}
          for (const v of Object.values(rawOutputs)) {
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
        } catch {
          /* history 读取失败按无产物处理（不阻断轮询返回） */
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

  /**
   * 预设捆绑模板（可执行推荐池）。内置预设不可改，返回更新后预设。
   */
  updatePresetTemplates(id: string, templateIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const list = this.store.presets ?? []
    const idx = list.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`preset not found: ${id}`)
    // 只保留真实存在的模板 id
    const valid = new Set(templateLibrary.list().map((t) => t.id))
    const next = [...new Set(templateIds)].filter((s) => valid.has(s))
    const updated = { ...list[idx]!, templateIds: next }
    this.store.presets = list.with(idx, updated)
    this.flush()
    return updated
  }

  /**
   * 预设捆绑技能（SKILL.md 知识技能 name 清单）。内置预设不可改。
   */
  updatePresetSkills(id: string, skillIds: string[]): WorkbenchPreset {
    if (BUILTIN_PRESETS.some((p) => p.id === id)) throw new Error('builtin preset is readonly')
    const list = this.store.presets ?? []
    const idx = list.findIndex((p) => p.id === id)
    if (idx === -1) throw new Error(`preset not found: ${id}`)
    const valid = new Set(
      defaultSkillLibrary()
        .list()
        .map((s) => s.name)
    )
    const next = [...new Set(skillIds)].filter((s) => valid.has(s))
    const updated = { ...list[idx]!, skillIds: next }
    this.store.presets = list.with(idx, updated)
    this.flush()
    return updated
  }

  /** 技能改名后修正所有预设的捆绑引用（改名不失效）；供路由层在 update 改名后调用 */
  fixPresetSkillRefs(oldName: string, newName: string): number {
    let changed = 0
    this.store.presets = (this.store.presets ?? []).map((p) => {
      if (!p.skillIds?.includes(oldName)) return p
      changed++
      return { ...p, skillIds: p.skillIds.map((s) => (s === oldName ? newName : s)) }
    })
    if (changed) this.flush()
    return changed
  }

  // ---------------- 技能库（Agent Skills 开放标准，SKILL.md 知识文档） ----------------

  listSkills(): SkillInfo[] {
    return defaultSkillLibrary().list()
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
    this.flush()
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
  app.once('before-quit', () => workbenchService.disposeAllAgentSessions())
} catch {
  /* 测试环境忽略 */
}
