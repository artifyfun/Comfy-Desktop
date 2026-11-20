// @vitest-environment node
/**
 * 外部 agent 通道 decide 链路级集成测试(ACP/Claude def 经注册表装配)。
 *
 * 链路:externalTransports def.create(注入 mock runtime)→ AgentSession.external
 * → runDecideTurn(事件透传/正文聚合/合成行/PLAN 提取)→ dispose 回收。
 *
 * mock 策略:不走真实 spawn——用 vi.mock 替换两个 transport 工厂,让 def.create
 * 产出可编程的 mock ExternalAgentRuntime(预排 AG-UI 事件流)。electron 经
 * vi.mock 提供最小 app 面(getOrCreate 需要 tempHome)。
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { tmpdir } from 'node:os'
import type { AGUIEvent } from '../agui/types'
import { textMessageContent, textMessageStart, runFinished, runStarted } from '../agui/types'

vi.mock('electron', () => ({
  app: {
    getAppPath: () => '',
    getPath: () => tmpdir()
  }
}))

// agentRuntime → service 依赖链上的重模块按既有测试模式 mock(agui.test.ts 同款)
vi.mock('../appStore', () => ({
  default: {
    getConfig: vi.fn(() => ({ comfyHost: 'http://127.0.0.1:8188' })),
    on: vi.fn(),
    getAllApps: vi.fn(() => []),
    emit: vi.fn()
  }
}))
vi.mock('./service', () => ({ workbenchService: {} }))
vi.mock('../routes/workbench/templatesMisc', () => ({}))
// agentRuntime import ../server 会拉起整套 express 装配(mcp router 等)——
// mock 全部导出面(startServer/getServer/getServerPort,MCP 不可用路径,
// 与单进程单测语义一致;default 导出也压平,防 consumer 解构炸)
vi.mock('../server', () => ({
  default: {},
  startServer: vi.fn(async () => null),
  getServer: vi.fn(() => null),
  getServerPort: vi.fn(() => null)
}))

/** 可编程 mock 外部 runtime:startTurn 返回预排事件流 */
interface ScriptedExternal {
  startTurnCalls: string[]
  disposed: boolean
}

const scriptedExternals: ScriptedExternal[] = []
/** 下一次 def.create 产出的 startTurn 事件序列(每次 create 前置入) */
let nextScript: AGUIEvent[] = []

vi.mock('../agui/acp/transport', () => ({
  createAcpRuntime: vi.fn(async () => makeScriptedExternal())
}))
vi.mock('../agui/claude/transport', () => ({
  createClaudeRuntime: vi.fn(async () => makeScriptedExternal())
}))

function makeScriptedExternal() {
  const state: ScriptedExternal = { startTurnCalls: [], disposed: false }
  scriptedExternals.push(state)
  const script = nextScript
  return {
    startTurn: async (input: string) => {
      state.startTurnCalls.push(input)
      const stream = (async function* () {
        for (const event of script) {
          yield { event, deltas: [] }
        }
      })()
      return { stream }
    },
    dispose: async () => {
      state.disposed = true
    }
  }
}

import { AgentRuntime } from './agentRuntime'
import { EXTERNAL_TRANSPORTS, findExternalTransport } from './externalTransports'
import { parsePlanFromCodexText } from './plan'

/** 标准 happy-path 事件脚本:正文分两 chunk + 终帧 */
const happyScript = (reply: string): AGUIEvent[] => [
  runStarted('t', 'r'),
  textMessageStart('m1'),
  textMessageContent('m1', `{"intent":"chat","reply":"${reply}"}`),
  runFinished('t', 'r')
]

/** 最小 AgentRuntime 装配(注入档位读取,不触真实 settings/config) */
const makeRuntime = () =>
  new AgentRuntime({
    readAgentAccess: () => 'standard'
  })

const collectProgress = () => {
  const events: unknown[] = []
  return {
    events,
    onProgress: (p: { type: string; event?: unknown }) => {
      if (p.type === 'thread_event') events.push(p.event)
    }
  }
}

beforeEach(() => {
  scriptedExternals.length = 0
  nextScript = []
})

describe('外部通道注册表 × AgentRuntime 集成', () => {
  for (const def of EXTERNAL_TRANSPORTS) {
    it(`${def.id}: decide 全链路——事件透传/正文聚合/合成行/PLAN 提取/dispose`, async () => {
      nextScript = happyScript('集成通过')
      const rt = makeRuntime()
      // settings/config 双读都不可用时 readExternalAgentSetting 走 fallback——
      // 这里直接验证 def.create + resolveExternalBin 装配路径(与 agentRuntime
      // 内部同构),不触发真实 settings
      const bin = def.requiresBin ? 'kimi' : (def.defaultBin ?? 'claude')
      const external = await def.create({ sessionId: 'sess-1', env: {}, binary: bin })
      const { events, onProgress } = collectProgress()

      // 直接驱动 runDecideTurn 逻辑核心:external 字段语义(mock 与真实同构)
      const agent = {
        external,
        inFlight: false,
        totalTokens: 0
      } as never as Parameters<AgentRuntime['runDecideTurn']>[0]
      const rawLines = await rt.runDecideTurn(agent, 'spec', onProgress as never)

      // 事件透传:AG-UI 事件原样经 thread_event 上抛
      const types = events.map((e) => (e as { type: string }).type)
      expect(types).toContain('RUN_STARTED')
      expect(types).toContain('TEXT_MESSAGE_CONTENT')

      // 合成行:流末 item.completed + agent_message(拼接正文)
      const synth = rawLines
        .map((l) => JSON.parse(l) as { type?: string; item?: { type?: string; text?: string } })
        .filter((o) => o.type === 'item.completed' && o.item?.type === 'agent_message')
      expect(synth).toHaveLength(1)
      expect(synth[0]?.item?.text).toBe('{"intent":"chat","reply":"集成通过"}')

      // PLAN 提取:parsePlanFromCodexText 主路径命中合成行
      const plan = parsePlanFromCodexText(rawLines.join('\n'))
      expect(plan).toMatchObject({ intent: 'chat', reply: '集成通过' })

      // dispose 回收
      await external.dispose()
      expect(scriptedExternals[scriptedExternals.length - 1]?.disposed).toBe(true)
    })
  }

  it('RUN_ERROR 收口:异常脚本下 rawLines 仍完整、PLAN 提取为 null(不炸)', async () => {
    const { runError } = await import('../agui/types')
    nextScript = [runStarted('t', 'r'), runError('外部 agent 崩了')]
    const def = findExternalTransport('claude')!
    const external = await def.create({ sessionId: 's', env: {}, binary: 'claude' })
    const rt = makeRuntime()
    const { events, onProgress } = collectProgress()
    const agent = { external, inFlight: false, totalTokens: 0 } as never as Parameters<
      AgentRuntime['runDecideTurn']
    >[0]
    const rawLines = await rt.runDecideTurn(agent, 'spec', onProgress as never)
    const types = events.map((e) => (e as { type: string }).type)
    expect(types).toContain('RUN_ERROR')
    // 无 TEXT_MESSAGE_CONTENT → 无合成行 → PLAN null,decide 层落 no-plan 分支
    expect(rawLines.some((l) => l.includes('item.completed'))).toBe(false)
    expect(parsePlanFromCodexText(rawLines.join('\n'))).toBeNull()
  })
})
