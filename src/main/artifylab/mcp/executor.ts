/**
 * 服务端 ComfyUI 执行器（自写 TS，不复用 @artifyfun/comfy-ui-client）。
 * 移植自 artifylab-frontend/src/controller/useWorkflow.js 与 src/utils/comfyui-utils/api.js。
 *
 * 审核修复：H2(失败状态读 status.status_str) M1(seed 检测/赋值一致)
 *  M2(extractOutputs 接入，prompt_id→app 映射) M3(404/5xx 区分) M4(上传文件名扩展名 + subfolder) L4(fetch 超时)。
 *
 * 依赖 Node 22 全局 fetch / FormData / Blob / structuredClone / AbortController。
 */
import { randomUUID } from 'node:crypto'
import type { App, ComfyPrompt, ParamNode } from '../appStore'
import { logger } from '../utils/logger'

export interface ExecutionResult {
  prompt_id: string
  status: 'queued' | 'running' | 'success' | 'error'
  outputs?: unknown
  error?: string
}

/** 提交后记录 prompt_id → app，供 getExecutionStatus 做输出过滤（M2） */
const promptAppMap = new Map<string, ParamNode[]>()
const MAX_PROMPT_ENTRIES = 500

/** 15 位随机整数（首位非 0），移植自 artifylab-frontend/src/utils/index.js:523-533 */
export function getSeed(n = 15): number {
  let num = ''
  for (let i = 0; i < n; i++) {
    num +=
      i === 0 ? String(Math.floor(Math.random() * 9 + 1)) : String(Math.floor(Math.random() * 10))
  }
  return Number(num)
}

/** 从 workflow prompt 推断输出节点 id（无 paramsNodes 的裸工作流执行用）：
 *  输出类节点（Save 系列 / Preview / Video / Audio）即产物出口。 */
export function inferOutputNodeIds(prompt: ComfyPrompt): string[] {
  return Object.entries(prompt)
    .filter(([, n]) => /Save|Preview|Video|Audio/i.test(n.class_type))
    .map(([id]) => id)
}

/**
 * seed 处理（M2 语义）：显式 seed 生效（未强制 randomize 时用 seed；NaN 拒绝），
 * 否则全图 seed 字段随机化。对 prompt 原地修改。
 */
function applySeed(prompt: ComfyPrompt, args: Record<string, unknown>): void {
  const hasSeed = args.seed != null
  const randomize = args.randomize_seed ?? !hasSeed
  const seedArg = hasSeed ? Number(args.seed) : null
  if (seedArg != null && !Number.isFinite(seedArg)) throw new Error('seed must be a finite number')
  for (const node of Object.values(prompt)) {
    for (const k of Object.keys(node.inputs)) {
      const isSeedField = k.toLowerCase().includes('seed') && typeof node.inputs[k] === 'number'
      if (!isSeedField) continue
      if (randomize) node.inputs[k] = getSeed()
      else if (seedArg != null) node.inputs[k] = seedArg
    }
  }
}

/**
 * 节点级参数覆盖合并（P1）：按 nodeId 覆盖任意节点的 widget 直接值。
 * 只接受"直接值"字段；链接引用（["nodeId", slot]）拒绝。返回无法合并的错误
 * 列表（可读），成功项原地写入 prompt。与 plan.validateNodeOverridesLocal
 * 同规则——这里在提交前兜底执行（防止绕过校验层直接调 executePrompt）。
 */
export function applyNodeOverrides(
  prompt: ComfyPrompt,
  nodeOverrides?: Record<string, { class_type?: string; widgetOverrides?: Record<string, unknown> }>
): string[] {
  const errors: string[] = []
  if (!nodeOverrides) return errors
  for (const [nodeId, cfg] of Object.entries(nodeOverrides)) {
    const node = prompt[nodeId]
    if (!node) {
      errors.push(`nodeOverrides: 节点不存在 ${nodeId}`)
      continue
    }
    if (cfg.class_type && node.class_type !== cfg.class_type) {
      errors.push(
        `nodeOverrides: 节点 ${nodeId} 类型不匹配（期望 ${cfg.class_type}，实际 ${node.class_type}）`
      )
      continue
    }
    for (const [k, v] of Object.entries(cfg.widgetOverrides ?? {})) {
      if (!(k in node.inputs)) {
        errors.push(`nodeOverrides: 节点 ${nodeId} 无输入 ${k}`)
        continue
      }
      if (Array.isArray(node.inputs[k])) {
        errors.push(`nodeOverrides: 字段 ${nodeId}.${k} 是链接引用，不能直接赋值（请改上游节点）`)
        continue
      }
      node.inputs[k] = v
    }
  }
  return errors
}

function isMediaRender(rc?: string): boolean {
  return rc === 'image-uploader' || rc === 'audio-uploader' || rc === 'video-uploader'
}

/** 带超时的 fetch（L4：避免无响应 URL 挂死工具调用） */
function fetchTimeout(url: string, init: RequestInit = {}, ms = 60000): Promise<Response> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), ms)
  return fetch(url, { ...init, signal: ctrl.signal }).finally(() => clearTimeout(timer))
}

/** 媒体来源白名单（H1：阻断 SSRF）——仅 data: URL 或本机 http(s) */
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
const MAX_MEDIA_BYTES = 200 * 1024 * 1024

export function assertSafeMediaUrl(url: string): void {
  if (url.startsWith('data:')) return
  if (/^https?:/i.test(url)) {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new Error('invalid media URL')
    }
    if (!LOCAL_HOSTS.has(u.hostname)) throw new Error(`media URL host not allowed: ${u.hostname}`)
    return
  }
  throw new Error('media must be a data: URL or a localhost http(s) URL')
}

function mimeToExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('audio')) return 'wav'
  if (mime.includes('video')) return 'mp4'
  return 'bin'
}

/** POST /prompt → prompt_id */
export async function queuePrompt(
  comfyOrigin: string,
  prompt: ComfyPrompt,
  clientId: string
): Promise<string> {
  const res = await fetchTimeout(`${comfyOrigin}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ prompt, client_id: clientId })
  })
  if (!res.ok) throw new Error(`queuePrompt HTTP ${res.status}: ${await res.text()}`)
  const json = (await res.json()) as { prompt_id?: string; error?: unknown }
  if (json.error) throw new Error(`queuePrompt error: ${JSON.stringify(json.error)}`)
  if (!json.prompt_id) throw new Error('queuePrompt: response missing prompt_id')
  return json.prompt_id
}

/**
 * GET /history/{prompt_id}。
 * 404 / 无 entry → null（仍排队/运行中）；5xx → throw（M3：避免永远误判 running）。
 */
export async function getHistory(
  comfyOrigin: string,
  promptId: string
): Promise<Record<string, unknown> | null> {
  const res = await fetchTimeout(`${comfyOrigin}/history/${promptId}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`getHistory HTTP ${res.status}`)
  const json = (await res.json()) as Record<string, unknown>
  return (json[promptId] as Record<string, unknown>) ?? null
}

/** POST /upload/image → { name(含 subfolder 前缀), subfolder, type }（M4：文件名扩展名 + subfolder） */
export async function uploadMedia(
  comfyOrigin: string,
  dataUrl: string
): Promise<{ name: string; subfolder: string; type: string }> {
  assertSafeMediaUrl(dataUrl)
  const blobRes = await fetchTimeout(dataUrl)
  if (!blobRes.ok) throw new Error(`fetch media HTTP ${blobRes.status}`)
  const blob = await blobRes.blob()
  if (blob.size > MAX_MEDIA_BYTES)
    throw new Error(`media too large: ${blob.size} bytes (max ${MAX_MEDIA_BYTES})`)
  return uploadMediaBlob(comfyOrigin, blob, `upload.${mimeToExt(blob.type)}`)
}

/**
 * 工作台附件上传：Buffer 直传 ComfyUI，保留原始文件名（LoadImage/VHS 等
 * widget 按文件名引用）。图/视频/音频统一走 /upload/image——ComfyUI 依据
 * 已注册的输入扩展名白名单校验（装了 VHS 后 mp4/webm 等均可），不支持
 * 的环境会收到 400 并向上抛。
 */
export async function uploadMediaBuffer(
  comfyOrigin: string,
  data: Buffer,
  filename: string,
  mime = 'application/octet-stream'
): Promise<{ name: string; subfolder: string; type: string }> {
  if (data.length > MAX_MEDIA_BYTES)
    throw new Error(`media too large: ${data.length} bytes (max ${MAX_MEDIA_BYTES})`)
  return uploadMediaBlob(comfyOrigin, new Blob([new Uint8Array(data)], { type: mime }), filename)
}

async function uploadMediaBlob(
  comfyOrigin: string,
  blob: Blob,
  filename: string
): Promise<{ name: string; subfolder: string; type: string }> {
  const form = new FormData()
  form.append('image', blob, filename)
  form.append('overwrite', 'true')
  const res = await fetchTimeout(`${comfyOrigin}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`uploadMedia HTTP ${res.status}`)
  const json = (await res.json()) as {
    name: string
    subfolder: string
    type: string
    error?: unknown
  }
  if (json.error) throw new Error(`uploadMedia error: ${JSON.stringify(json.error)}`)
  // ComfyUI LoadImage 等 widget 期望 "subfolder/filename" 或 "filename"
  const filepath = json.subfolder ? `${json.subfolder}/${json.name}` : json.name
  return { name: filepath, subfolder: json.subfolder, type: json.type }
}

/**
 * 提交 app 执行（异步，决策 #7）。返回 { prompt_id, status:'queued' }。
 * 步骤：seed 处理 → media 上传 → 普通 input 合并 → 节点覆盖 → queuePrompt。
 * @param nodeOverrides 节点级参数覆盖（P1），校验失败会 throw（绕过校验层时的兜底）
 */
export async function executeApp(
  app: App,
  args: Record<string, unknown>,
  comfyOrigin: string,
  nodeOverrides?: Record<string, { class_type?: string; widgetOverrides?: Record<string, unknown> }>
): Promise<ExecutionResult> {
  const template = app.template
  if (!template?.prompt)
    throw new Error(`app ${app.id} (${app.name}) 缺少 template.prompt，无法执行`)
  const prompt: ComfyPrompt = structuredClone(template.prompt)
  const clientId = randomUUID()
  const inputs: ParamNode[] = (template.paramsNodes ?? []).filter((n) => n.category === 'input')

  // 0. 工作流切换前置清理：与上一次执行的 app 不同（或首次/外部残留）时先 /free
  //    清显存，防止不同模型叠加 OOM。free 失败不阻断本次执行。
  try {
    await freeIfWorkflowChanged(comfyOrigin, resolveWorkflowKey(app.id, prompt))
  } catch (e) {
    logger.warn('free before app execution failed', e)
  }

  // 1. seed（M2：显式 seed 生效——传了 seed 且未强制 randomize 时用 seed；NaN 拒绝）
  applySeed(prompt, args)

  // 2. media 参数：base64/URL → upload → 填回 widget（移植 useWorkflow.js:314-325）
  for (const n of inputs) {
    if (!isMediaRender(n.renderComponent)) continue
    const v = args[n.name]
    if (typeof v !== 'string' || !/^(data:|https?:)/.test(v)) continue
    const widget = n.selectedWidget?.name
    if (!widget || !prompt[n.id]?.inputs) continue
    const uploaded = await uploadMedia(comfyOrigin, v)
    prompt[n.id]!.inputs[widget] = uploaded.name
  }

  // 3. 普通 input 参数：按 node id + widget name 合并（Object.assign 语义，移植 useWorkflow.js:221-225）
  for (const n of inputs) {
    if (isMediaRender(n.renderComponent)) continue
    const v = args[n.name]
    if (v == null) continue
    const widget = n.selectedWidget?.name
    if (widget != null && prompt[n.id]?.inputs) {
      prompt[n.id]!.inputs[widget] = v
    }
  }

  // 3.5 节点级覆盖（P1）：只在本次执行副本上生效，不污染模板
  if (nodeOverrides) {
    const errors = applyNodeOverrides(prompt, nodeOverrides)
    if (errors.length > 0) throw new Error(`nodeOverrides 校验失败：\n${errors.join('\n')}`)
  }

  // 4. 提交 + 记录 app 映射（只存 paramsNodes，带上限淘汰最旧条目；H2）
  const promptId = await queuePrompt(comfyOrigin, prompt, clientId)
  promptAppMap.set(promptId, template.paramsNodes ?? [])
  if (promptAppMap.size > MAX_PROMPT_ENTRIES) {
    const oldest = promptAppMap.keys().next().value
    if (oldest != null) promptAppMap.delete(oldest)
  }
  return { prompt_id: promptId, status: 'queued' }
}

/**
 * 裸工作流执行（P1 创作能力）：直接提交任意 API 格式 prompt JSON，不依赖
 * 固化模板。seed/节点覆盖/输出节点推断与 executeApp 同一套语义。
 * @param paramsNodes 可选（产物提取白名单）；缺省时按 Save/Preview 类节点推断输出。
 */
export async function executePrompt(
  comfyOrigin: string,
  rawPrompt: ComfyPrompt,
  opts: {
    seed?: number | null
    randomizeSeed?: boolean
    nodeOverrides?: Record<
      string,
      { class_type?: string; widgetOverrides?: Record<string, unknown> }
    >
    paramsNodes?: ParamNode[]
    workflowKey?: string
  } = {}
): Promise<ExecutionResult> {
  const prompt: ComfyPrompt = structuredClone(rawPrompt)
  const clientId = randomUUID()

  try {
    await freeIfWorkflowChanged(
      comfyOrigin,
      resolveWorkflowKey(opts.workflowKey ?? 'session:custom', prompt)
    )
  } catch (e) {
    logger.warn('free before prompt execution failed', e)
  }

  applySeed(prompt, {
    seed: opts.seed,
    randomize_seed: opts.randomizeSeed
  })
  if (opts.nodeOverrides) {
    const errors = applyNodeOverrides(prompt, opts.nodeOverrides)
    if (errors.length > 0) throw new Error(`nodeOverrides 校验失败：\n${errors.join('\n')}`)
  }

  const promptId = await queuePrompt(comfyOrigin, prompt, clientId)
  // 产物提取白名单：显式 paramsNodes 优先，缺省按输出节点推断
  const outputNodes: ParamNode[] = opts.paramsNodes?.length
    ? opts.paramsNodes
    : inferOutputNodeIds(prompt).map((id) => ({
        id: Number(id) || 0,
        type: 'output',
        name: 'result',
        category: 'output' as const,
        renderComponent: 'image-uploader',
        selectedWidget: { id, name: 'images' }
      }))
  promptAppMap.set(promptId, outputNodes)
  if (promptAppMap.size > MAX_PROMPT_ENTRIES) {
    const oldest = promptAppMap.keys().next().value
    if (oldest != null) promptAppMap.delete(oldest)
  }
  return { prompt_id: promptId, status: 'queued' }
}

/**
 * 从 ComfyUI history 的 status.messages 事件数组提取 execution_error 的可读摘要：
 * `[["execution_start",…],["execution_error",{"node_type":"KSampler","node_id":"16",
 * "exception_message":"…","exception_type":"…","traceback":"…"}],…]`。
 * 直接 JSON.stringify 整数组会把执行过程噪音全倒进错误文案（前端 500 字符截断后
 * 只剩残缺 JSON）；这里只取出错节点 + 异常消息。找不到 execution_error 返回 null。
 */
export function extractExecutionError(messages: unknown[]): string | null {
  for (const entry of messages) {
    if (!Array.isArray(entry) || entry[0] !== 'execution_error') continue
    const d = entry[1]
    if (!d || typeof d !== 'object') continue
    const err = d as {
      node_type?: string
      node_id?: string
      exception_message?: string
      exception_type?: string
    }
    const where = [err.node_type, err.node_id ? `#${err.node_id}` : ''].filter(Boolean).join(' ')
    const what = err.exception_message || err.exception_type
    if (what) return where ? `${where}: ${what}` : what
    return JSON.stringify(entry)
  }
  return null
}

/**
 * 轮询状态（H2 + M2 + M3）：
 * 404/无 entry → running；entry.status.status_str==='error' → error；
 * 否则 success（M2：用 extractOutputs 过滤为 app 声明的输出节点）。
 */
export async function getExecutionStatus(
  comfyOrigin: string,
  promptId: string
): Promise<ExecutionResult> {
  // H3：本进程未提交过的 prompt_id（拼错/重启后历史丢失）直接报错，避免永久 running 轮询死循环
  const paramsNodes = promptAppMap.get(promptId)
  if (!paramsNodes) {
    return {
      prompt_id: promptId,
      status: 'error',
      error: 'unknown prompt_id: not submitted by this process (ComfyUI may have restarted)'
    }
  }
  const entry = await getHistory(comfyOrigin, promptId)
  if (!entry) return { prompt_id: promptId, status: 'running' }
  const status = entry.status as { status_str?: string; messages?: unknown[] } | undefined
  if (status?.status_str === 'error') {
    const msgs = status.messages ?? []
    // 优先提取 execution_error 事件的可读摘要（节点+异常消息），整数组兜底
    const readable = extractExecutionError(msgs)
    return {
      prompt_id: promptId,
      status: 'error',
      error: readable ?? (msgs.length ? JSON.stringify(msgs) : 'ComfyUI execution error')
    }
  }
  const rawOutputs = (entry.outputs as Record<string, unknown>) ?? {}
  const outputs = extractOutputs(paramsNodes, rawOutputs)
  return { prompt_id: promptId, status: 'success', outputs }
}

/** POST /interrupt（移植 handlers.ts:34-45） */
export async function stopExecution(comfyOrigin: string): Promise<void> {
  await fetchTimeout(`${comfyOrigin}/interrupt`, { method: 'POST' })
}

/** 抽取 app 声明的 output 节点结果（移植 useWorkflow.js:189-207 handleResult；M6：回退分支不再 join 对象数组） */
export function extractOutputs(
  paramsNodes: ParamNode[],
  outputs: Record<string, unknown> = {}
): Record<string, unknown> {
  const outputIds = paramsNodes.filter((n) => n.category === 'output').map((n) => String(n.id))
  const response: Record<string, unknown> = {}
  for (const key of Object.keys(outputs)) {
    if (!outputIds.includes(key)) continue
    const nodeOut = outputs[key] as Record<string, unknown>
    for (const item of Object.values(nodeOut)) {
      if (Array.isArray(item)) {
        const hit = item.find(
          (it) =>
            typeof it === 'object' && it !== null && (it as { type?: string }).type === 'output'
        )
        if (hit) {
          response[key] = hit
          break
        }
      }
    }
    if (response[key] == null) {
      const arr = Object.values(nodeOut).find((v) => Array.isArray(v)) as unknown[] | undefined
      if (arr) {
        response[key] = arr
          .map((it) => (typeof it === 'string' ? it : JSON.stringify(it)))
          .join('\n')
      }
    }
  }
  return response
}

/** POST /free：卸载模型 + 释放显存（工作流切换前调用，避免不同模型叠加 OOM） */
export async function freeModels(comfyOrigin: string): Promise<void> {
  await fetchTimeout(`${comfyOrigin}/free`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ unload_models: true, free_memory: true })
  })
}

/**
 * 最近一次执行的工作流指纹（批量任务与单次执行共享同一份跟踪）：
 * - 从 C 界面（ComfyUI 原生）跑完的工作流无法感知，lastWorkflowKey 保持旧值/空，
 *   因此下一次任意来源执行都会触发一次防御性 free，避免残留模型占显存。
 * - 批量任务之间、批量与单次之间、单次与单次之间都能互相感知"上一个工作流"。
 */
let lastWorkflowKey: string | null = null

/** 工作流指纹：优先 appId（同一 app 一定是同一模板），否则退化为 prompt 结构 */
export function resolveWorkflowKey(appId: string | undefined, prompt?: ComfyPrompt): string {
  if (appId) return `app:${appId}`
  return `prompt:${JSON.stringify(prompt ?? {})}`
}

/**
 * 工作流切换前置清理：若上次执行的工作流与本次不同（含首次执行/外部残留），
 * 先 POST /free 清显存并记录本次指纹，返回 true；同工作流直接跳过返回 false。
 * free 失败会抛出，由调用方决定容错策略。
 */
export async function freeIfWorkflowChanged(
  comfyOrigin: string,
  workflowKey: string
): Promise<boolean> {
  if (lastWorkflowKey === workflowKey) return false
  await freeModels(comfyOrigin)
  lastWorkflowKey = workflowKey
  return true
}

/**
 * 无条件清理：不判断上次工作流，直接 POST /free 并记录本次指纹。
 * 用于"队列会话首个任务"等需要防御外部残留（如 C 界面跑过其他模型）的场景。
 */
export async function forceFreeAndTrack(comfyOrigin: string, workflowKey: string): Promise<void> {
  await freeModels(comfyOrigin)
  lastWorkflowKey = workflowKey
}

/** 重置工作流跟踪（测试用 / 显存状态异常时兜底） */
export function resetWorkflowKey(): void {
  lastWorkflowKey = null
}
