/**
 * 工作台领域类型——形状唯一 home（候选 ① 第一步）。
 *
 * 审查背景：WorkbenchSession 等类型原定义在 service.ts 内部，兄弟模块
 * （sessionTransfer/sessionBundle/importRestore）只能 type-only 循环 import
 * 回 service。类型出仓到本模块后，循环依赖消失；service.ts re-export 保持
 * 外部 import 路径兼容。
 */
import type { ExecutionResult } from '../mcp/executor'
import type { WorkbenchPlan, PlanValidationIssue } from './plan'
import type { WorkbenchExecution, WorkbenchOutputFile } from './executionLog'
import type { AttachmentMeta, WorkbenchPreset } from './presetCore'

export type { AttachmentMeta, WorkbenchPreset } from './presetCore'

export type { WorkbenchExecution, WorkbenchOutputFile } from './executionLog'

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
  /** 分支(dsh 同款):当前激活叶;undefined=旧数据,取最后一条 */
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
  /** codex 原始输出（JSONL，含思考）），截断保护 */
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

/** 持久化 store 根（workbench-sessions.json） */
export interface SessionStore {
  sessions: WorkbenchSession[]
  presets?: WorkbenchPreset[]
  presetDefault?: string
  favorites?: WorkbenchFavorite[]
  /** 跨会话长期记忆(dsh memory 语义):key 幂等,工作台可自我更新 */
  memories?: Record<string, { value: string; updatedAt: number }>
}

export type { ExecutionResult }
