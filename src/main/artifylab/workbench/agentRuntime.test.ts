// @vitest-environment node
/**
 * 会话级 agent 运行时（harness P1）生命周期测试 —— 补 P1 §5⑦ 的测试缺口。
 *
 * 覆盖六项：
 *   1) 会话复用：同 sessionId 重复 getOrCreate 不再 spawn（codex/thread/tempHome 同引用）
 *   2) 重启降级：新实例空 Map → 重建 + turns 归零
 *   3) 推理强度切档：复用路径改写 threadOptions 引用，'auto' 撤销具名档
 *   4) runDecideTurn 双通道：rawLines 形态、usage 累计进会话预算、inFlight 语义、
 *      AbortSignal 透传
 *   5) 空闲回收：超 AGENT_IDLE_MS 销毁（删 tempHome/退工具上下文），inFlight 轮跳过
 *   6) dispose / disposeAll：清理幂等、临时 CODEX_HOME 真删盘
 *
 * mock 策略：不 spawn 真实 codex —— vi.mock 替换 agentDriver（假 Codex/thread，
 * 事件脚本可编程）、skillDeploy（不真拷 36 个技能目录）、server（MCP 端口 null →
 * 跳过 config.toml 与 token 注入）、workbenchTools（spy 记录会话上下文开关）。
 * tempHome 走真实 mkdtemp + rmSync —— dispose 断言盘上目录消失。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'

const h = vi.hoisted(() => ({
  /** 每次 startThread 产出的假 thread（含 runStreamed 调用记录） */
  threads: [] as Array<{
    threadOptions: Record<string, unknown>
    runStreamed: ReturnType<typeof vi.fn>
  }>,
  /** new Codex 次数 —— 会话复用的核心观测量 */
  codexCount: 0,
  /** 下一次 runDecideTurn 的 exec 事件脚本（字符串行 + 结构化事件混合） */
  script: [] as unknown[],
  beganned: [] as string[],
  ended: [] as string[],
  deployedHomes: [] as string[]
}))

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '',
    getPath: () => tmpdir()
  }
}))

vi.mock('../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({
      base_url: 'https://api.deepseek.com/v1',
      api_key: 'test-key',
      buildModel: 'test-model'
    })),
    on: vi.fn(),
    emit: vi.fn()
  }
}))

vi.mock('../../settings', () => ({ get: vi.fn(() => undefined) }))

vi.mock('../utils/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}))

/** MCP 端口 null：跳过 config.toml 写入与 token 注入（语义 = 单进程单测） */
vi.mock('../server', () => ({
  default: {},
  startServer: vi.fn(async () => null),
  getServer: vi.fn(() => null),
  getServerPort: vi.fn(() => null)
}))

vi.mock('../mcp/auth', () => ({ getOrCreateMcpToken: vi.fn(() => 'test-token') }))

vi.mock('../mcp/workbenchTools', () => ({
  decideSessions: new Set<string>(),
  beginWorkbenchToolContext: vi.fn((id: string) => {
    h.beganned.push(id)
  }),
  endWorkbenchToolContext: vi.fn((id: string) => {
    h.ended.push(id)
  })
}))

vi.mock('./skillDeploy', () => ({
  deployWorkbenchSkills: vi.fn((home: string) => {
    h.deployedHomes.push(home)
  })
}))

vi.mock('./agentEnv', () => ({
  resolveCodexBinary: vi.fn(() => 'C:/fake/codex.exe'),
  resolveCodexBaseUrl: vi.fn(({ baseUrl }: { baseUrl: string }) => baseUrl),
  uvxAvailable: vi.fn(() => false),
  civitaiMcpTomlLines: vi.fn(() => []),
  preWarmCivitaiMcp: vi.fn()
}))

/** base_url 为 deepseek 官方时本不该建代理；真被调用即说明用例前提被破坏 */
vi.mock('./workbenchProxy', () => ({
  startWorkbenchProxy: vi.fn(async () => {
    throw new Error('非法前提：deepseek 官方端点不应启动 responses→chat 代理')
  })
}))

vi.mock('./appServerRun', () => ({
  createAppServerRuntime: vi.fn(async () => ({
    startTurn: vi.fn(),
    dispose: vi.fn()
  }))
}))

vi.mock('../agentDriver', () => ({
  Codex: class {
    constructor() {
      h.codexCount++
    }
    startThread(threadOptions: Record<string, unknown>) {
      const thread = {
        threadOptions,
        runStreamed: vi.fn(async () => ({
          events: (async function* () {
            for (const event of h.script) yield event
          })()
        }))
      }
      h.threads.push(thread)
      return thread
    }
  }
}))

import { AgentRuntime, AGENT_IDLE_MS, type AgentSession } from './agentRuntime'

const runtimes: AgentRuntime[] = []
const makeRuntime = (): AgentRuntime => {
  const rt = new AgentRuntime({ readAgentAccess: () => 'standard' })
  runtimes.push(rt)
  return rt
}
const noop = () => {}

beforeEach(() => {
  h.threads.length = 0
  h.codexCount = 0
  h.script = []
  h.beganned.length = 0
  h.ended.length = 0
  h.deployedHomes.length = 0
})

afterEach(() => {
  for (const rt of runtimes) {
    try {
      rt.disposeAll()
    } catch {
      /* 清理失败不影响断言结果 */
    }
  }
  runtimes.length = 0
  vi.useRealTimers()
})

describe('harness P1 ① — 会话复用与重启降级', () => {
  it('同 sessionId 重复 getOrCreate：复用同一 codex/thread/tempHome，不重复 spawn', async () => {
    const rt = makeRuntime()
    const a1 = await rt.getOrCreate('s1', noop)
    const a2 = await rt.getOrCreate('s1', noop)

    expect(a2).toBe(a1)
    expect(h.codexCount).toBe(1)
    expect(h.threads.length).toBe(1)
    expect(a2.tempHome).toBe(a1.tempHome)
    expect(rt.size).toBe(1)
    expect(rt.has('s1')).toBe(true)
    expect(rt.get('s1')).toBe(a1)
    // 复用路径不再重复部署技能（部署在创建路径）
    expect(h.deployedHomes.length).toBe(1)
  })

  it('不同 sessionId 各自独立建 thread，互不复用', async () => {
    const rt = makeRuntime()
    const a1 = await rt.getOrCreate('s1', noop)
    const a2 = await rt.getOrCreate('s2', noop)

    expect(a1).not.toBe(a2)
    expect(h.codexCount).toBe(2)
    expect(rt.size).toBe(2)
    expect(a1.tempHome).not.toBe(a2.tempHome)
  })

  it('touch 推进 lastActiveAt（会话活性由消息驱动）', async () => {
    const rt = makeRuntime()
    const a1 = await rt.getOrCreate('s1', noop)
    const before = a1.lastActiveAt
    const spy = vi.spyOn(Date, 'now').mockReturnValue(before + 5_000)
    rt.touch('s1')
    spy.mockRestore()

    expect(a1.lastActiveAt).toBe(before + 5_000)
    // 不存在的会话静默忽略
    expect(() => rt.touch('ghost')).not.toThrow()
  })

  it('应用重启（新实例 Map 为空）→ 重建新 thread/tempHome，turns 与预算归零', async () => {
    const rt1 = makeRuntime()
    const a1 = await rt1.getOrCreate('s1', noop)
    a1.turns = 7
    a1.totalTokens = 1234
    const oldHome = a1.tempHome
    rt1.disposeAll()

    const rt2 = makeRuntime()
    expect(rt2.size).toBe(0)

    const a2 = await rt2.getOrCreate('s1', noop)
    expect(a2).not.toBe(a1)
    expect(a2.tempHome).not.toBe(oldHome)
    expect(a2.turns).toBe(0)
    expect(a2.totalTokens).toBe(0)
    expect(existsSync(a1.tempHome)).toBe(false)
  })
})

describe('harness P1 — 推理强度切档（复用路径改引用）', () => {
  it('具名档位落到 threadOptions；auto 撤销；undefined 保持现状', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop, 'high')
    expect(a.reasoningEffort).toBe('high')
    expect(a.threadOptions?.modelReasoningEffort).toBe('high')

    // undefined（请求未带）= 保持会话现状，不清档
    await rt.getOrCreate('s1', noop)
    expect(a.threadOptions?.modelReasoningEffort).toBe('high')

    // 'auto' = 显式撤销 → 回引擎默认
    await rt.getOrCreate('s1', noop, 'auto')
    expect(a.threadOptions?.modelReasoningEffort).toBeUndefined()
    expect(a.reasoningEffort).toBeUndefined()

    // 切另一档
    await rt.getOrCreate('s1', noop, 'medium')
    expect(a.threadOptions?.modelReasoningEffort).toBe('medium')
    // 全程未重建
    expect(h.codexCount).toBe(1)
  })

  it('创建路径：具名档位在 threadOptions 初始即注入', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop, 'minimal')
    expect(h.threads.length).toBe(1)
    expect(h.threads[0]!.threadOptions.modelReasoningEffort).toBe('minimal')
    expect(a.reasoningEffort).toBe('minimal')
  })
})

describe('harness P1 ② — runDecideTurn（exec 通道）', () => {
  it('rawLines 形态：字符串行原样、结构化事件 JSON 化；事件透传 + log', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    const itemEvent = { type: 'item.completed', item: { type: 'agent_message', text: 'hi' } }
    const usageEvent = { type: 'turn.completed', usage: { input_tokens: 100, output_tokens: 20 } }
    h.script = ['raw-string-line', itemEvent, usageEvent]

    const progress: Array<{ type: string }> = []
    const raw = await rt.runDecideTurn(a, 'spec', (p) => progress.push(p))

    expect(raw).toEqual(['raw-string-line', JSON.stringify(itemEvent), JSON.stringify(usageEvent)])
    expect(progress.filter((p) => p.type === 'thread_event').length).toBe(2)
    expect(progress.filter((p) => p.type === 'log').length).toBe(3)
  })

  it('turn.completed 的 usage 累加进会话预算（input + output）', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    // 先人工占一部分（模拟前几轮）
    a.totalTokens = 500
    h.script = [{ type: 'turn.completed', usage: { input_tokens: 1000, output_tokens: 200 } }]

    await rt.runDecideTurn(a, 'spec', noop)

    expect(a.totalTokens).toBe(1700)
  })

  it('usage 缺失的 turn.completed 不污染预算；畸形字段按 0 处理', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    h.script = [
      { type: 'turn.completed' },
      { type: 'turn.completed', usage: { input_tokens: 5 } }
    ]

    await rt.runDecideTurn(a, 'spec', noop)

    expect(a.totalTokens).toBe(5)
  })

  it('inFlight 全轮为 true（reap 跳过依据），结束后复位', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    h.script = [{ type: 'item.completed' }, { type: 'turn.completed' }]

    const seen: boolean[] = []
    await rt.runDecideTurn(a, 'spec', () => seen.push(a.inFlight ?? false))

    expect(seen.length).toBeGreaterThan(0)
    expect(seen.every(Boolean)).toBe(true)
    expect(a.inFlight).toBe(false)
  })

  it('AbortSignal 透传给引擎 runStreamed', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    const signal = new AbortController().signal

    await rt.runDecideTurn(a, 'spec', noop, signal)

    expect(h.threads[0]!.runStreamed).toHaveBeenCalledWith('spec', { signal })
  })

  it('引擎抛错时 inFlight 仍复位（finally 语义），异常向上抛', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    h.threads[0]!.runStreamed.mockImplementationOnce(async () => ({
      events: (async function* () {
        yield 'line-before-crash'
        throw new Error('engine boom')
      })()
    }))

    await expect(rt.runDecideTurn(a, 'spec', noop)).rejects.toThrow('engine boom')
    expect(a.inFlight).toBe(false)
  })
})

describe('harness P1 ② — runDecideTurn（app-server 通道）', () => {
  it('delta 经 stream_delta 上抛；usage 累计；结构化事件 JSON 化进 rawLines', async () => {
    const rt = makeRuntime()
    const usageEvent = { type: 'turn.completed', usage: { input_tokens: 30, output_tokens: 12 } }
    const frames = [
      {
        deltas: [{ kind: 'text', itemId: 'i1', delta: '你' }],
        event: undefined
      },
      { deltas: [], event: usageEvent }
    ]
    const agent = {
      appServer: {
        startTurn: async () => ({
          stream: (async function* () {
            for (const f of frames) yield f
          })()
        })
      },
      inFlight: false,
      totalTokens: 0
    } as never as AgentSession

    const progress: Array<{ type: string }> = []
    const raw = await rt.runDecideTurn(agent, 'spec', (p) => progress.push(p))

    expect(progress.filter((p) => p.type === 'stream_delta').length).toBe(1)
    expect(agent.totalTokens).toBe(42)
    expect(raw).toEqual([JSON.stringify(usageEvent)])
  })
})

describe('harness P1 ④⑥ — 空闲回收与销毁', () => {
  it('超 AGENT_IDLE_MS 无活动 → 回收：删 tempHome、退工具上下文、Map 移除', async () => {
    vi.useFakeTimers()
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    const home = a.tempHome
    expect(existsSync(home)).toBe(true)

    // 未超时：一个 tick（60s）后仍存活
    vi.advanceTimersByTime(60_000)
    expect(rt.size).toBe(1)

    // 超时：AGENT_IDLE_MS + 一个 tick
    vi.advanceTimersByTime(AGENT_IDLE_MS + 60_000)
    expect(rt.size).toBe(0)
    expect(existsSync(home)).toBe(false)
    expect(h.ended).toContain('s1')
  })

  it('inFlight 的执行中会话跳过回收（长轮不被中途销毁）', async () => {
    vi.useFakeTimers()
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)
    a.inFlight = true

    vi.advanceTimersByTime(AGENT_IDLE_MS * 3)
    expect(rt.size).toBe(1)
    expect(existsSync(a.tempHome)).toBe(true)

    // 轮次结束后下一 tick 才回收
    a.inFlight = false
    vi.advanceTimersByTime(60_000)
    expect(rt.size).toBe(0)
  })

  it('touch 续命：活跃会话不被回收', async () => {
    vi.useFakeTimers()
    const rt = makeRuntime()
    await rt.getOrCreate('s1', noop)

    for (let i = 0; i < 8; i++) {
      vi.advanceTimersByTime(AGENT_IDLE_MS / 2)
      rt.touch('s1')
    }
    expect(rt.size).toBe(1)
  })

  it('dispose 幂等：重复调用不抛，且终态一致', async () => {
    const rt = makeRuntime()
    const a = await rt.getOrCreate('s1', noop)

    rt.dispose('s1')
    expect(rt.size).toBe(0)
    expect(rt.get('s1')).toBeUndefined()
    expect(existsSync(a.tempHome)).toBe(false)
    expect(() => rt.dispose('s1')).not.toThrow()
    expect(() => rt.dispose('never-existed')).not.toThrow()
  })

  it('disposeAll 清空全部会话并停掉回收定时器', async () => {
    vi.useFakeTimers()
    const rt = makeRuntime()
    const a1 = await rt.getOrCreate('s1', noop)
    const a2 = await rt.getOrCreate('s2', noop)

    rt.disposeAll()

    expect(rt.size).toBe(0)
    expect(existsSync(a1.tempHome)).toBe(false)
    expect(existsSync(a2.tempHome)).toBe(false)
    // 定时器已清：再推进时间不抛（无回调访问空 Map）
    expect(() => vi.advanceTimersByTime(AGENT_IDLE_MS * 2)).not.toThrow()
    // 可再次调用
    expect(() => rt.disposeAll()).not.toThrow()
  })
})
