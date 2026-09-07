/**
 * workbenchApi —— 工作台 HTTP 调用层（workbench 六域 19 端点的唯一 home）。
 *
 * 此前 26 处 fetch 散在 index.vue（拼 URL/res.json/错误形状各写一遍）；
 * 现统一为每域窄 interface。语义约定与原调用保持一致：
 *   - 返回 { ok, status, json }（不 throw——调用方原有 res.ok / json.success 判定零改动）
 *   - json 解析失败时 json 为 null
 */
import { resolveBaseUrl } from '@/utils/apiClient'

let cachedOrigin = null
let originPromise = null

/**
 * 工作台 origin：index.vue 的 origin ref（appStore config / embed query param）
 * 由页面注入一次（setWorkbenchOrigin(getter)），此后本层自取。
 */
let originGetter = null
export function setWorkbenchOrigin(getter) {
  originGetter = getter
  cachedOrigin = null
}

async function base() {
  if (typeof cachedOrigin === 'string') return cachedOrigin
  if (originGetter) {
    const o = originGetter()
    if (o) {
      cachedOrigin = o
      return o
    }
  }
  if (!originPromise) originPromise = resolveBaseUrl('')
  return originPromise
}

async function req(path, options = {}) {
  const origin = await base()
  const res = await fetch(`${origin}${path}`, options)
  const json = await res.json().catch(() => null)
  return { ok: res.ok, status: res.status, json }
}

const jsonBody = (body) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
})

// ---------------- sessions 域 ----------------
export const sessionsApi = {
  list: (archived = false) => req(`/api/workbench/sessions?archived=${archived}`),
  get: (id) => req(`/api/workbench/session/${id}`),
  create: ({ presetId, title, entry }) =>
    req('/api/workbench/sessions/create', jsonBody({ presetId, title, entry })),
  update: (patch) => req('/api/workbench/sessions/update', jsonBody(patch)),
  remove: (id) => req('/api/workbench/sessions/delete', jsonBody({ id })),
  branch: (sessionId, { messageIdx, variant }) =>
    req(`/api/workbench/session/${sessionId}/branch`, jsonBody({ messageIdx, variant })),
  exportUrl: (id, kind = 'json') => `${kind === 'bundle' ? 'export-bundle' : 'export'}`,
}

// ---------------- presets/templates 域 ----------------
export const presetsApi = {
  list: () => req('/api/workbench/presets'),
}

export const templatesApi = {
  list: () => req('/api/workbench/templates'),
  clone: (payload) => req('/api/workbench/clone-template', jsonBody(payload)),
  runWorkflow: (payload) => req('/api/workbench/run-workflow', jsonBody(payload)),
}

// ---------------- execute/poll 域 ----------------
export const executeApi = {
  execute: (payload) => req('/api/workbench/execute', jsonBody(payload)),
  poll: (sessionId, promptId) =>
    req('/api/workbench/poll', jsonBody({ sessionId, promptId })),
  batchStatus: (promptId) => req(`/api/batch/status?id=${encodeURIComponent(promptId)}`),
}

// ---------------- runtime/env 域 ----------------
export const runtimeApi = {
  info: () => req('/api/workbench/runtime'),
  env: () => req('/api/workbench/env'),
  debugLast: (sessionId) =>
    req(`/api/workbench/debug/last?sessionId=${encodeURIComponent(sessionId)}`),
  canvasDebug: (payload) => req('/api/canvas/debug', jsonBody(payload)),
}

// ---------------- 其他（收藏/发布/上传） ----------------
export const miscApi = {
  favorite: (payload) => req('/api/workbench/favorites', jsonBody(payload)),
  publish: (payload) => req('/api/workbench/publish', jsonBody(payload)),
  /** 上传：FormData（不能带 Content-Type，浏览器自动 multipart 边界） */
  upload: async (sessionId, form) =>
    req(`/api/workbench/upload?sessionId=${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      body: form,
    }),
}
