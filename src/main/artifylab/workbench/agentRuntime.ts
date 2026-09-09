/**
 * 会话级 agent 运行时（harness）——候选 ① 第二步：从 service.ts 抽出。
 *
 * 职责边界（单一）：codex+thread 跨消息复用的生命周期——
 * 创建（临时 CODEX_HOME / MCP 回环 / model catalog / responses→chat 代理 /
 * appserver 双通道）、复用（touch/effort 切档）、回收（空闲 reap/删除/退出）。
 *
 * 依赖注入（AgentRuntimeDeps）：appStore 配置读取与 settings 档位由 service
 * 装配时注入——本模块不 import appStore/electron，测试可裸载。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { Server as HttpServer } from 'node:http'
import { Codex } from '../agentDriver'
import type { Thread, ThreadOptions } from '../vendor/codex-sdk'
import { startWorkbenchProxy } from './workbenchProxy'
import { createAppServerRuntime, type AppServerRuntime } from './appServerRun'
import {
  findExternalTransport,
  resolveExternalBin,
  type ExternalAgentRuntime
} from './externalTransports'
import { deployWorkbenchSkills } from './skillDeploy'
import { beginWorkbenchToolContext, endWorkbenchToolContext } from '../mcp/workbenchTools'
import {
  resolveCodexBinary,
  resolveCodexBaseUrl,
  uvxAvailable,
  civitaiMcpTomlLines,
  preWarmCivitaiMcp
} from './agentEnv'
import { getServerPort } from '../server'
import { getOrCreateMcpToken } from '../mcp/auth'
import appStoreManager from '../appStore'
import { get as getSetting } from '../../settings'
import { logger } from '../utils/logger'
import type { ReasoningEffort } from './reasoningEffort'
import { toEngineEffort } from './reasoningEffort'

/** 会话级 agent 运行时状态（harness P1）：codex+thread 跨消息复用 */
export interface AgentSession {
  codex: Codex
  thread: Thread
  tempHome: string
  /** 非 deepseek 官方端点时挂的 responses→chat 转换代理（随 session 回收） */
  proxy?: { server: HttpServer; baseUrl: string }
  /** C16:app-server 通道运行时(transport=appserver 时非空,随 session 回收) */
  appServer?: AppServerRuntime
  /**
   * 外部 agent 通道运行时(transport 在 EXTERNAL_TRANSPORTS 注册表内时非空,
   * 随 session 回收)。ACP/Claude 等外部通道统一走 registry,新增通道不改本文件。
   */
  external?: ExternalAgentRuntime
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
export const AGENT_IDLE_MS = 10 * 60 * 1000

/** decide 流式进度事件（log / codex ThreadEvent 透传 / token 级 delta） */
export type DecideProgressEvent =
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

/** 进度回调（onProgress）——decide 流式事件的精确判别联合 */
export type AgentProgressCallback = (p: DecideProgressEvent) => void

/** 装配期依赖注入（service 组合根提供） */
export interface AgentRuntimeDeps {
  /** 读 workbenchAgentAccess 档位（settings → config 双读，失败回退 standard） */
  readAgentAccess(): 'standard' | 'full'
  /** MCP 可用性探测结果回写（agent session 创建时探测 server 端口） */
  onMcpAvailability?(available: boolean): void
}

export class AgentRuntime {
  private sessions = new Map<string, AgentSession>()
  private idleTimer: NodeJS.Timeout | null = null
  constructor(private readonly deps: AgentRuntimeDeps) {}

  get(id: string): AgentSession | undefined {
    return this.sessions.get(id)
  }

  has(id: string): boolean {
    return this.sessions.has(id)
  }

  get size(): number {
    return this.sessions.size
  }

  /** 外部 agent 配置双读(settings.json → appStore config;UI 设置面持久化在
   * config,手改文件走 settings;对齐 readAgentAccess 的双读模式)。
   * 非法值/缺省回退 fallback;settings 读取失败静默降级 config。 */
  private readExternalAgentSetting<K extends 'workbenchAgentTransport' | 'workbenchAcpAgentBin'>(
    key: K,
    fallback: string
  ): string {
    try {
      const fromSettings = getSetting(key)
      if (fromSettings !== undefined && fromSettings !== null && fromSettings !== '') {
        return String(fromSettings)
      }
    } catch {
      /* settings 不可用,走 config */
    }
    try {
      const fromConfig = appStoreManager.getConfig()[key]
      if (fromConfig !== undefined && fromConfig !== null && fromConfig !== '') {
        return String(fromConfig)
      }
    } catch {
      /* config 也不可用,回退 */
    }
    return fallback
  }

  /** 传输通道：appserver = codex app-server 子进程(JSON-RPC,token 级 delta)；
   * acp = 外部 ACP agent 子进程(Agent Client Protocol,见 agui/acp/)；
   * claude = Claude Code CLI(stream-json,见 agui/claude/)；
   * 默认 exec（零行为变化,红线:M3 默认不切） */
  private resolveAgentTransport(): 'exec' | 'appserver' | 'acp' | 'claude' {
    const t = this.readExternalAgentSetting('workbenchAgentTransport', 'exec')
    if (t === 'appserver') return 'appserver'
    if (t === 'acp') return 'acp'
    if (t === 'claude') return 'claude'
    return 'exec'
  }

  /**
   * 取或建会话级 agent 运行时。
   *
   * 复用路径：touch + effort 切档。创建路径：临时 CODEX_HOME（MCP 回环/
   * model catalog/config.toml）→ deployWorkbenchSkills → 双通道 spawn →
   * startThread。应用重启后 Map 为空 → 自动重建（spec 注入近史兜底）。
   */
  async getOrCreate(
    sessionId: string,
    onProgress: AgentProgressCallback,
    reasoningEffort?: ReasoningEffort
  ): Promise<AgentSession> {
    const cached = this.sessions.get(sessionId)
    if (cached) {
      this.touch(sessionId)
      // E1:undefined=请求未带/非法值(旧客户端)→保持会话现状;仅显式档位或
      // 'auto'(撤销)才变更。创建路径的 auto/undefined 由 toEngineEffort 折叠。
      if (reasoningEffort !== undefined) this.applyEffort(cached, reasoningEffort)
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
    const serverPort = getServerPort()
    this.deps.onMcpAvailability?.(serverPort != null)
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
    // 下每个 <name>/SKILL.md（frontmatter name/desc
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
    // 外部通道 def 查表:acp/claude 等注册表条目;exec/appserver 返回 null
    // (走下方各自专用管线)
    const externalDef = findExternalTransport(transport)
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
    // 外部 agent 通道:注册表驱动(externalTransports.ts)。新增外部通道 =
    // 在注册表加一个 def,此处零改动。二进制缺失等配置错误经 resolveExternalBin
    // 显式抛出(带 UI 指引);spawn 级错误经 RUN_ERROR 透出。
    let external: AgentSession['external']
    if (externalDef) {
      const bin = resolveExternalBin(
        externalDef,
        this.readExternalAgentSetting('workbenchAcpAgentBin', '')
      )
      external = await externalDef.create({ sessionId, env: { ...process.env }, binary: bin })
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
    const agentAccess = this.deps.readAgentAccess()
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
      ...(external ? { external } : {}),
      ...(engineEffort ? { reasoningEffort: engineEffort } : {}),
      threadOptions,
      lastActiveAt: Date.now(),
      turns: 0,
      totalTokens: 0
    }
    this.sessions.set(sessionId, agent)
    this.scheduleIdleReap()
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
  private applyEffort(agent: AgentSession, reasoningEffort?: ReasoningEffort): void {
    const eff = toEngineEffort(reasoningEffort)
    agent.reasoningEffort = eff
    if (agent.threadOptions) {
      if (eff) agent.threadOptions.modelReasoningEffort = eff
      else delete agent.threadOptions.modelReasoningEffort
    }
  }

  /**
   * 跑一轮 decide 流式执行（候选 ②：从 service.decide 抽出的 harness 核心）。
   *
   * 双通道：appserver（token 级 delta + JSON-RPC 帧）或 exec（JSONL 事件流）。
   * rawLines 收 JSON.stringify 的事件（PLAN 解析同构）；turn.completed 的
   * usage 累计进会话预算；inFlight 标记 reap 空闲回收跳过（finally 复位）。
   *
   * @returns codex 原始输出行（join('\n') 后喂 parsePlanFromCodex）
   */
  async runDecideTurn(
    agent: AgentSession,
    spec: string,
    onProgress: AgentProgressCallback,
    signal?: AbortSignal
  ): Promise<string[]> {
    const rawLines: string[] = []
    agent.inFlight = true
    try {
      if (agent.external) {
        // 外部 agent 通道(注册表驱动,externalTransports.ts):mapper 直接产
        // AG-UI 事件(与 codex 通道的「exec 事件 → mapper」两跳不同,外部通道
        // 单跳直出)。rawLines 策略:PLAN 提取(parsePlanFromCodexText)认
        // 「TEXT_MESSAGE_CONTENT 事件行」——把 AG-UI 事件 JSON 原样进 rawLines,
        // 解析器兜底 extractPlanJson(raw) 可从拼接正文里提 PLAN JSON;流末再补
        // 一行 exec 形态合成事件(item.completed + agent_message.text = 拼接正文)
        // 让解析器主路径直接命中。
        const external = agent.external
        const { stream } = await external.startTurn(spec, signal)
        const textChunks: string[] = []
        for await (const frame of stream) {
          if (frame.event) {
            onProgress({ type: 'thread_event', event: frame.event })
            if (frame.event.type === 'TEXT_MESSAGE_CONTENT') {
              textChunks.push(frame.event.delta)
            }
            try {
              rawLines.push(JSON.stringify(frame.event))
            } catch {
              /* ignore */
            }
          }
          onProgress({ type: 'log', text: 'deciding' })
        }
        if (textChunks.length > 0) {
          try {
            rawLines.push(
              JSON.stringify({
                type: 'item.completed',
                item: {
                  type: 'agent_message',
                  id: 'external-synth',
                  text: textChunks.join('')
                }
              })
            )
          } catch {
            /* ignore */
          }
        }
      } else if (agent.appServer) {
        // C16 appserver 通道:token 级 delta 经 thread_event 旁路 + stream_delta
        // 上抛(路由层 mapper.feedStreamDelta 映射 AG-UI 增量帧);exec 形态事件
        // 照常 thread_event 透传,rawLines 收 JSON.stringify(PLAN 解析同构)。
        const { stream } = await agent.appServer.startTurn(spec, signal)
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
        const { events } = await agent.thread.runStreamed(spec, { signal })
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
    } finally {
      agent.inFlight = false
    }
    return rawLines
  }

  touch(sessionId: string): void {
    const agent = this.sessions.get(sessionId)
    if (agent) agent.lastActiveAt = Date.now()
  }

  /** 销毁会话级 agent 运行时：关代理、删临时 CODEX_HOME、失效 wb_* 工具上下文 */
  dispose(sessionId: string): void {
    const agent = this.sessions.get(sessionId)
    if (!agent) return
    this.sessions.delete(sessionId)
    if (agent.external) {
      void agent.external.dispose().catch(() => {})
    }
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
  private scheduleIdleReap(): void {
    if (this.idleTimer) return
    this.idleTimer = setInterval(() => {
      const now = Date.now()
      for (const [id, agent] of this.sessions) {
        // decide 流式执行中不回收：SSE 总超时（15min）可超过 AGENT_IDLE_MS，
        // 此时 lastActiveAt 停留在轮起——不跳过会销毁活跃会话的 tempHome/通道
        if (agent.inFlight) continue
        if (now - agent.lastActiveAt > AGENT_IDLE_MS) this.dispose(id)
      }
      if (this.sessions.size === 0 && this.idleTimer) {
        clearInterval(this.idleTimer)
        this.idleTimer = null
      }
    }, 60_000)
    // 不 hold 事件循环退出
    this.idleTimer?.unref?.()
  }

  /** 应用退出时清理全部 agent 运行时 */
  disposeAll(): void {
    for (const id of Array.from(this.sessions.keys())) this.dispose(id)
    if (this.idleTimer) {
      clearInterval(this.idleTimer)
      this.idleTimer = null
    }
  }
}
