/**
 * 工作台执行记录（WorkbenchExecution）状态机——单一事实源（候选 ②）。
 *
 * 审查背景：此前执行记录的构造散布 4 处 push、状态回填散在 pollExecution，
 * WorkbenchExecution 形状是 service/sessionBundle/importRestore/workbenchTools/
 * routes/agui 六文件的共享知识。本模块收口：
 * - record()：四处 push 统一构造（初始态/status/时间戳约束一处保证）
 * - markSuccess()/markError()：轮询回填语义（含截断上限）
 * - extractFiles()：产物文件提取的单一实现——修复历史缺陷「模板未声明
 *   paramsNodes 输出节点 → extractOutputs 永远为空」（真实事故：ComfyUI 已
 *   输出 2 张图，会话产物 0）。策略：paramsNodes 声明的输出优先，未声明时
 *   裸扫全部节点的 images/gifs/audio/video 键。
 *
 * 类型从 service.ts 迁入（形状唯一 home），service 与兄弟模块从这里 import。
 */
import type { ExecutionResult } from '../mcp/executor'
import type { ParamNode } from '../appStore'

/** 执行产物文件引用（v2 完整引用；旧数据为纯 filename 字符串） */
export interface WorkbenchOutputFile {
  filename: string
  subfolder?: string
  type?: string
}

export interface WorkbenchExecution {
  promptId: string
  templateId: string
  params: Record<string, unknown>
  outputs: (WorkbenchOutputFile | string)[]
  status: ExecutionResult['status']
  startedAt: number
  /** batch 编排执行:batchRunner 的 job id */
  batchJobId?: string
  /** 失败原因（轮询回填；产物卡「复制错误全文」用） */
  error?: string
}

/** record() 入参：必填身份字段，batchJobId 可选 */
export interface RecordExecutionInput {
  promptId: string
  templateId: string
  params?: Record<string, unknown>
  status?: ExecutionResult['status']
  batchJobId?: string
}

/** 新建执行记录（统一初始态：outputs=[]、status 缺省 queued、startedAt=now） */
export function record(input: RecordExecutionInput): WorkbenchExecution {
  return {
    promptId: input.promptId,
    templateId: input.templateId,
    params: input.params ?? {},
    outputs: [],
    status: input.status ?? 'queued',
    startedAt: Date.now(),
    ...(input.batchJobId ? { batchJobId: input.batchJobId } : {})
  }
}

/** 落盘错误文案上限（防会话 JSON 膨胀；消息流另有 500 字符截断） */
export const MAX_EXECUTION_ERROR_CHARS = 2000

/** 轮询成功回填：status + 产物文件列表 */
export function markSuccess(exec: WorkbenchExecution, files: WorkbenchOutputFile[]): void {
  exec.status = 'success'
  exec.outputs = files
}

/** 轮询失败回填：status + 截断后的错误全文 */
export function markError(exec: WorkbenchExecution, error: string): void {
  exec.status = 'error'
  exec.error = error.slice(0, MAX_EXECUTION_ERROR_CHARS)
}

/**
 * 从 ComfyUI history entry 的 outputs 提取产物文件列表。
 *
 * 策略（两层）：
 * 1. paramsNodes 声明的 output 节点优先——模板正确声明时精确命中；
 * 2. 声明缺失/产物为空时裸扫全部节点——修复「模板只声明输入参数 → 提取
 *    永远为空」的历史缺陷（Anima+槽位替换A 等场景）。
 * 键覆盖 images/gifs/audio/video（ComfyUI 产物节点的四类输出键）。
 */
export function extractFiles(
  paramsNodes: ParamNode[] | undefined,
  historyOutputs: Record<string, unknown> | null | undefined
): WorkbenchOutputFile[] {
  if (!historyOutputs) return []
  const declared = (paramsNodes ?? [])
    .filter((n) => n.category === 'output')
    .map((n) => String(n.id))
  const files: WorkbenchOutputFile[] = []
  const seen = new Set<string>()
  const scanNode = (o: Record<string, unknown>): void => {
    for (const key of ['images', 'gifs', 'audio', 'video'] as const) {
      const arr = o[key]
      if (!Array.isArray(arr)) continue
      for (const it of arr) {
        const f = it as { filename?: string; subfolder?: string; type?: string }
        if (!f?.filename) continue
        const dedupe = `${f.subfolder ?? ''}/${f.filename}`
        if (seen.has(dedupe)) continue
        seen.add(dedupe)
        files.push({ filename: f.filename, subfolder: f.subfolder, type: f.type })
      }
    }
  }
  // 第一层：声明的输出节点
  for (const id of declared) {
    const o = historyOutputs[id] as Record<string, unknown> | undefined
    if (o) scanNode(o)
  }
  // 第二层：声明未命中（或模板未声明输出）→ 裸扫兜底
  if (files.length === 0) {
    for (const o of Object.values(historyOutputs)) {
      if (o && typeof o === 'object') scanNode(o as Record<string, unknown>)
    }
  }
  return files
}
