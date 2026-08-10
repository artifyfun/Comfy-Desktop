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

export interface ExecutionResult {
  prompt_id: string
  status: 'queued' | 'running' | 'success' | 'error'
  outputs?: unknown
  error?: string
}

/** 提交后记录 prompt_id → app，供 getExecutionStatus 做输出过滤（M2） */
const promptAppMap = new Map<string, App>()

/** 15 位随机整数（首位非 0），移植自 artifylab-frontend/src/utils/index.js:523-533 */
export function getSeed(n = 15): number {
  let num = ''
  for (let i = 0; i < n; i++) {
    num += i === 0 ? String(Math.floor(Math.random() * 9 + 1)) : String(Math.floor(Math.random() * 10))
  }
  return Number(num)
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
export async function queuePrompt(comfyOrigin: string, prompt: ComfyPrompt, clientId: string): Promise<string> {
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
  const blobRes = await fetchTimeout(dataUrl)
  const blob = await blobRes.blob()
  const form = new FormData()
  form.append('image', blob, `upload.${mimeToExt(blob.type)}`)
  form.append('overwrite', 'true')
  const res = await fetchTimeout(`${comfyOrigin}/upload/image`, { method: 'POST', body: form })
  if (!res.ok) throw new Error(`uploadMedia HTTP ${res.status}`)
  const json = (await res.json()) as { name: string; subfolder: string; type: string; error?: unknown }
  if (json.error) throw new Error(`uploadMedia error: ${JSON.stringify(json.error)}`)
  // ComfyUI LoadImage 等 widget 期望 "subfolder/filename" 或 "filename"
  const filepath = json.subfolder ? `${json.subfolder}/${json.name}` : json.name
  return { name: filepath, subfolder: json.subfolder, type: json.type }
}

/**
 * 提交 app 执行（异步，决策 #7）。返回 { prompt_id, status:'queued' }。
 * 步骤：seed 处理 → media 上传 → 普通 input 合并 → queuePrompt。
 */
export async function executeApp(
  app: App,
  args: Record<string, unknown>,
  comfyOrigin: string
): Promise<ExecutionResult> {
  const template = app.template
  if (!template?.prompt) throw new Error(`app ${app.id} (${app.name}) 缺少 template.prompt，无法执行`)
  const prompt: ComfyPrompt = structuredClone(template.prompt)
  const clientId = randomUUID()
  const inputs: ParamNode[] = (template.paramsNodes ?? []).filter((n) => n.category === 'input')

  // 1. seed（M1：检测与赋值一致——用户 seed 应用到所有 seed 字段；randomize=false 未传则保留原值）
  const randomize = args.randomize_seed ?? true
  const seedArg = args.seed != null ? Number(args.seed) : null
  for (const node of Object.values(prompt)) {
    for (const k of Object.keys(node.inputs)) {
      const isSeedField = k.toLowerCase().includes('seed') && typeof node.inputs[k] === 'number'
      if (!isSeedField) continue
      if (randomize) node.inputs[k] = getSeed()
      else if (seedArg != null) node.inputs[k] = seedArg
    }
  }

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

  // 4. 提交 + 记录 app 映射（M2）
  const promptId = await queuePrompt(comfyOrigin, prompt, clientId)
  promptAppMap.set(promptId, app)
  return { prompt_id: promptId, status: 'queued' }
}

/**
 * 轮询状态（H2 + M2 + M3）：
 * 404/无 entry → running；entry.status.status_str==='error' → error；
 * 否则 success（M2：用 extractOutputs 过滤为 app 声明的输出节点）。
 */
export async function getExecutionStatus(comfyOrigin: string, promptId: string): Promise<ExecutionResult> {
  const entry = await getHistory(comfyOrigin, promptId)
  if (!entry) return { prompt_id: promptId, status: 'running' }
  const status = entry.status as { status_str?: string; messages?: unknown[] } | undefined
  if (status?.status_str === 'error') {
    return {
      prompt_id: promptId,
      status: 'error',
      error: JSON.stringify(status.messages ?? 'ComfyUI execution error')
    }
  }
  const rawOutputs = (entry.outputs as Record<string, unknown>) ?? {}
  const app = promptAppMap.get(promptId)
  const outputs = app ? extractOutputs(app, rawOutputs) : rawOutputs
  return { prompt_id: promptId, status: 'success', outputs }
}

/** POST /interrupt（移植 handlers.ts:34-45） */
export async function stopExecution(comfyOrigin: string): Promise<void> {
  await fetchTimeout(`${comfyOrigin}/interrupt`, { method: 'POST' })
}

/** 抽取 app 声明的 output 节点结果（移植 useWorkflow.js:189-207 handleResult） */
export function extractOutputs(app: App, outputs: Record<string, unknown> = {}): Record<string, unknown> {
  const outputIds = (app.template?.paramsNodes ?? [])
    .filter((n) => n.category === 'output')
    .map((n) => String(n.id))
  const response: Record<string, unknown> = {}
  for (const key of Object.keys(outputs)) {
    if (!outputIds.includes(key)) continue
    const nodeOut = outputs[key] as Record<string, unknown>
    for (const item of Object.values(nodeOut)) {
      if (Array.isArray(item)) {
        const hit = item.find(
          (it) => typeof it === 'object' && it !== null && (it as { type?: string }).type === 'output'
        )
        if (hit) {
          response[key] = hit
          break
        }
      }
    }
    if (response[key] == null) {
      const arr = Object.values(nodeOut).find((v) => Array.isArray(v)) as unknown[] | undefined
      if (arr) response[key] = arr.join('\n')
    }
  }
  return response
}
