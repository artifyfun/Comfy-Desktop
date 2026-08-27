import { Codex } from './vendor/codex-sdk'
import { mkdtempSync, readFileSync, rmSync, existsSync, cpSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app } from 'electron'

/**
 * agentDriver —— 用 OpenAI Codex 官方 SDK（vendored @openai/codex-sdk@0.149.1，见 ../vendor/codex-sdk）驱动「构建应用」。
 *
 * 设计要点：
 * - 官方 SDK 本质是 `codex exec` 的客户端包装（内部 spawn 原生 codex 二进制），
 *   我们通过 `codexPathOverride` 直接指向【应用内置的 exe】（resources/codex-bin，
 *   由 scripts/copy-codex-bin.mjs 从 @openai/codex-<platform> 平台包拷入）。
 *   因此用户机器【无需安装 codex CLI / node】——只要填 DeepSeek key 就能构建。
 * - SDK 自带：stdin 传 spec、stdout 逐行 JSON 事件流、AbortSignal 取消子进程、
 *   --cd 工作目录、--sandbox workspace-write 沙箱、config override（--config）。
 * - provider 配置：非 openai 时用 configOverrides 传 model_provider（等价 --provider deepseek），
 *   环境变量注入 provider 专属 key（DEEPSEEK_API_KEY 等）。
 *
 * 设计体系注入（提升出图质感，替代原本固化硬规则）：
 * - 构建前把打包进 app 的「设计体系」资产（ui-ux-pro-max 设计智能 + minimalist-ui 极简反 slop 协议）
 *   拷入 build 目录的 design-system/ 子目录，由 buildSpec 指示 Codex 先读再生成。
 * - 只拷文本指引（SKILL.md / references/*.md），不拷 data/*.csv 与 scripts/*.py，
 *   因此 Codex 无法直接执行其检索脚本，也不会触发 Gen 评估里标出的脚本执行风险；沙箱本身也禁网。
 */

export type CodexProvider =
  | 'deepseek'
  | 'openai'
  | 'openrouter'
  | 'azure'
  | 'ollama'
  | 'gemini'
  | 'xai'
  | 'groq'

export interface BuildAppInput {
  appId: string
  name: string
  description?: string
  paramsNodes?: Array<{
    name?: string
    category?: string
    type?: string
    description?: string
    [k: string]: any
  }>
  style?: string
  provider?: CodexProvider
  apiKey?: string
  model?: string
  maxTurns?: number
}

export interface BuildProgress {
  type: 'log' | 'done' | 'error'
  text: string
}

// 不同 provider 的默认模型（agent loop 用 chat 类模型，不用 reasoner）
const DEFAULT_MODEL: Record<CodexProvider, string> = {
  deepseek: 'deepseek-v4-flash',
  openai: 'gpt-5',
  openrouter: 'deepseek/deepseek-chat',
  azure: 'gpt-5',
  ollama: 'deepseek-coder-v2',
  gemini: 'gemini-2.5-pro',
  xai: 'grok-4',
  groq: 'llama-3.3-70b'
}

// 各 provider 的 OpenAI 兼容 base_url（codex 无内置第三方 provider 定义，
// 统一走 openai 兼容路由：openai_base_url + CODEX_API_KEY，用户只填 key 即可）
const API_BASE_URL: Partial<Record<CodexProvider, string>> = {
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  gemini: 'https://generativelanguage.googleapis.com/v1beta/openai/',
  xai: 'https://api.x.ai/v1',
  groq: 'https://api.groq.com/openai/v1',
  ollama: 'http://localhost:11434/v1'
  // azure: 需用户填专属 base_url，走 openai 兼容路由需在 UI 传入
}

// target triple → 平台包/目录名，与 codex 的 PLATFORM_PACKAGE_BY_TARGET 一致
const TRIPLE_BY_TARGET: Record<string, string> = {
  'win32-x64': 'x86_64-pc-windows-msvc',
  'win32-arm64': 'aarch64-pc-windows-msvc',
  'darwin-x64': 'x86_64-apple-darwin',
  'darwin-arm64': 'aarch64-apple-darwin',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl'
}

function currentTriple(): string | null {
  return TRIPLE_BY_TARGET[`${process.platform}-${process.arch}`] ?? null
}

// 解析打包/开发环境下内置的 codex 原生二进制。
// 生产：electron-builder extraResources 把 src/main/artifylab/public/codex-bin 拷到 resources/codex-bin。
// 开发：源码目录 public/codex-bin（scripts/copy-codex-bin.mjs 生成）。
function resolveCodexBinary(): string | null {
  const triple = currentTriple()
  if (!triple) return null
  const exeName = process.platform === 'win32' ? 'codex.exe' : 'codex'
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'codex-bin', triple, 'bin', exeName) : '',
    join(app.getAppPath(), 'src/main/artifylab/public/codex-bin', triple, 'bin', exeName)
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

// 解析打包/开发环境下的「设计体系」资产目录。
// 生产：electron-builder extraResources 把 src/main/artifylab/public/design-system 拷到 resources/design-system。
// 开发：agentDriver 源码位于 src/main/artifylab，public/design-system 与其同级。
function resolveDesignSystemDir(): string | null {
  const candidates = [
    process.resourcesPath ? join(process.resourcesPath, 'design-system') : '',
    join(app.getAppPath(), 'src/main/artifylab/public/design-system')
  ].filter(Boolean)
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  return null
}

// 给 Codex agent 的任务说明 + SKILL 约束（产出单文件 index.html，按 paramsNodes 生成控件）
function buildSpec(input: BuildAppInput, hasDesignSystem: boolean): string {
  const params =
    input.paramsNodes && input.paramsNodes.length
      ? input.paramsNodes
          .map(
            (p) =>
              `- ${p.name || p.type || 'param'}（${p.category || p.type || 'input'}）：${p.description || ''}`
          )
          .join('\n')
      : '- （该应用无显式参数，生成纯展示 / 交互界面即可）'
  const designSystemSection = hasDesignSystem
    ? `
## 设计体系参考（构建前必读并严格应用）
工作目录下已附带设计指引文件，请**先阅读再生成**，直接将其原则用于本页面（不要运行任何脚本、不要联网）：
- design-system/ui-ux-pro-max/SKILL.md —— 设计智能：优先级表（可访问性 > 触控交互 > 性能 > 风格 > 响应式 > 排版色彩 > 动画 > 表单 > 导航）、HTML/CSS 栈实现准则
- design-system/ui-ux-pro-max/quick-reference.md —— 119 条 UX 准则全文，按需查阅对应章节
- design-system/minimalist-ui/SKILL.md —— 极简美学协议（禁用渐变 / 重阴影 / 通用 SaaS 风 / Inter·Roboto；用编辑式排版、bento 网格、克制配色，杜绝「AI 模板感」）

应用目标：产出的 index.html 必须具备专业设计感、非通用模板、可访问、响应式；禁止 emoji 作图标、禁止占位名（John Doe / Acme）、禁止 AI 套话（Elevate / Seamless / Next-Gen 等）。`
    : ''
  return `你是一个前端代码生成 agent，为 ComfyUI 应用「${input.name}」生成自包含的 Web UI。
${designSystemSection}
## 约束
1. 只在工作目录下生成 index.html，必须自包含（内联 CSS 与 JS；除公共 CDN 字体 / 图标外不引用外部资源）。
2. 该应用暴露以下参数，请为每个生成对应控件（文本输入 / 滑块 / 开关 / 下拉 / 文件上传）：
${params}
3. 用户点击「生成」时调用 window.artifySubmit({ 参数key: 值 })，不要自行请求 ComfyUI 或任何后端；无对应控件时可省略。
4. 视觉风格：${input.style || '现代科技风'}。页面在浏览器直接打开即可用，移动端自适应。
5. 不要输出任何解释文字、Markdown 代码块包裹或思考过程，只产出单个 index.html 文件。

## 完成标准
工作目录存在可读的 index.html，且包含反映上述参数的交互控件。`
}

export async function buildAppCode(
  input: BuildAppInput,
  on: (p: BuildProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const dir = mkdtempSync(join(tmpdir(), `artify-build-${input.appId}-`))
  // 注入设计体系：把打包资产拷入 build 目录，让 Codex 在 sandbox 内能读到
  let hasDesignSystem = false
  const dsDir = resolveDesignSystemDir()
  if (dsDir) {
    try {
      cpSync(dsDir, join(dir, 'design-system'), { recursive: true })
      hasDesignSystem = true
    } catch {
      hasDesignSystem = false
    }
  }
  try {
    await runCodex(dir, input, on, signal, hasDesignSystem)
    const htmlPath = join(dir, 'index.html')
    if (!existsSync(htmlPath)) {
      throw new Error('Codex 未生成 index.html（构建可能失败或被中断）')
    }
    const html = readFileSync(htmlPath, 'utf8')
    on({ type: 'done', text: html })
    return html
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

async function runCodex(
  dir: string,
  input: BuildAppInput,
  on: (p: BuildProgress) => void,
  signal?: AbortSignal,
  hasDesignSystem?: boolean
): Promise<void> {
  const provider = input.provider || 'deepseek'
  const model = input.model || DEFAULT_MODEL[provider] || 'deepseek-v4-flash'
  const spec = buildSpec(input, !!hasDesignSystem)

  const binary = resolveCodexBinary()
  if (!binary) {
    throw new Error(
      '未找到内置的 codex 二进制（resources/codex-bin 或 public/codex-bin 缺失）。' +
        '请先执行 `node scripts/copy-codex-bin.mjs`（依赖 pnpm install 装好 @openai/codex 平台包）'
    )
  }

  const codex = new Codex({
    // 内置二进制：生产走 resources/codex-bin，开发走 public/codex-bin；
    // 恒传 codexPathOverride（vendor SDK 不做 node_modules 兜底解析）
    codexPathOverride: binary,
    // OpenAI 兼容路由：baseUrl → openai_base_url，apiKey → CODEX_API_KEY，
    // 用户只填 key 即可，无需 ~/.codex/config.toml 自定义 provider
    baseUrl: API_BASE_URL[provider],
    apiKey: input.apiKey
  })

  const thread = codex.startThread({
    model,
    sandboxMode: 'workspace-write',
    workingDirectory: dir,
    skipGitRepoCheck: true
  })

  const { events } = await thread.runStreamed(spec, { signal })
  for await (const event of events) {
    let text: string
    try {
      text = typeof event === 'string' ? event : JSON.stringify(event)
    } catch {
      text = String(event)
    }
    on({ type: 'log', text })
  }
}
