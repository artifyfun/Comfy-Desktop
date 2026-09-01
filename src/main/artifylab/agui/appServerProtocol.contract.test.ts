// @vitest-environment node
/**
 * C16 — codex app-server 协议契约测试(真二进制,codex 升级跑板)。
 *
 * 与 appServerRun.test.ts(ScriptedClient mock,测自家翻译逻辑)互补:本文件
 * spawn **真实** codex app-server 二进制,验证我们写死的协议形状约定在当前
 * 版本下仍然成立。app-server 协议标 experimental——codex 一次小版本升级
 * 就可能改形状,此文件是升级时的第一道门。
 *
 * **门控**:默认跳过(不进 CI/日常回归),仅 `CODEX_PROTOCOL_CONTRACT=1` 时跑:
 *   CODEX_PROTOCOL_CONTRACT=1 npx vitest run src/main/artifylab/agui/appServerProtocol.contract.test.ts
 *
 * **不烧 token**:provider base_url 指向死端口(127.0.0.1:9)——协议握手/
 * thread/turn 往返不需要真 LLM;delta 通知只验方法名会到达(turn 必然以
 * error/completed 收口,不影响形状断言)。
 *
 * 升级流程见 docs/workbench-agui-migration.md「codex 升级流程」。
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { startAppServerClient, type AppServerNotification } from './appServerClient'

const RUN = process.env.CODEX_PROTOCOL_CONTRACT === '1'
const require = createRequire(__filename)

/** 仓库资产里的真二进制(生产 resolveCodexBinary 同源:copy-codex-bin.mjs 产物) */
function resolveRepoBinary(): string | null {
  const triple =
    process.platform === 'darwin'
      ? process.arch === 'arm64'
        ? 'aarch64-apple-darwin'
        : 'x86_64-apple-darwin'
      : null
  if (!triple) return null
  const exe = join(
    __dirname,
    '../public/codex-bin',
    triple,
    'bin',
    process.platform === 'win32' ? 'codex.exe' : 'codex'
  )
  return existsSync(exe) ? exe : null
}

/** 依赖声明的 codex 版本(package.json 精确 pin,与本测试跑板基准一致) */
function declaredVersion(): string {
  const pkg = require('@openai/codex/package.json') as { version: string }
  return pkg.version
}

describe.skipIf(!RUN)('codex app-server 协议契约(真二进制)', () => {
  let binary: string
  let codexHome: string
  let notifications: AppServerNotification[]
  let client: ReturnType<typeof startAppServerClient>
  let threadId: string

  beforeAll(async () => {
    const b = resolveRepoBinary()
    if (!b) throw new Error(`本平台无 codex 资产(跑 node scripts/copy-codex-bin.mjs)`)
    binary = b
    // 隔离 CODEX_HOME:写最小 config(无任何 provider——provider 由 -c 覆盖注入,
    // 这是 spike 坑位#1:app-server 不读 config.toml 的 model_provider 段)
    codexHome = mkdtempSync(join(tmpdir(), 'codex-contract-'))
    writeFileSync(
      join(codexHome, 'config.toml'),
      [
        `model = "contract-test"`,
        `model_provider = "deadport"`,
        ``,
        `[model_providers.deadport]`,
        `name = "deadport"`,
        `base_url = "http://127.0.0.1:9/v1"`,
        `env_key = "CONTRACT_TEST_KEY"`,
        `wire_api = "responses"`
      ].join('\n')
    )
    notifications = []
    client = startAppServerClient({
      binary,
      env: { ...process.env, CODEX_HOME: codexHome, CONTRACT_TEST_KEY: 'sk-dead' },
      // -c 覆盖:与生产 service.ts 装配同构(provider 注入走命令行)
      configArgs: ['model_provider=deadport', 'model="contract-test"'],
      requestTimeoutMs: 30_000,
      onNotification: (n) => notifications.push(n)
    })
  })

  afterAll(async () => {
    await client?.dispose?.()
    if (codexHome) rmSync(codexHome, { recursive: true, force: true })
  })

  it('契约基准版本记录(0.149.x 形状)', () => {
    // 升级跑板第一眼:版本对不上时,下面的形状断言就要逐条重验
    console.log(`[contract] codex ${declaredVersion()} @ ${binary}`)
    expect(declaredVersion()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('initialize 往返:userAgent/codexHome/platform 字段存在(坑位:不发 initialize 后续请求被静默丢弃)', async () => {
    const res = (await client.request('initialize', {
      clientInfo: { name: 'artify-contract', title: 'test', version: '1.0' }
    })) as Record<string, unknown>
    // 0.149.x 实测形状(probe 落盘):{ userAgent, codexHome, platformFamily, platformOs }
    // 注意:无 serverInfo 字段——若未来版本出现形状变化,此处即第一道告警
    expect(typeof res?.userAgent).toBe('string')
    expect(res?.userAgent).toContain(declaredVersion())
    expect(typeof res?.codexHome).toBe('string')
    expect(typeof res?.platformFamily).toBe('string')
  })

  it('thread/start 响应:thread.id 存在(坑位:params 有嵌套形态)', async () => {
    const res = (await client.request('thread/start', { params: {} })) as {
      thread?: { id?: string }
    }
    expect(res?.thread?.id).toBeTruthy()
    threadId = res.thread!.id!
  })

  it('turn/start 响应:turn.id 存在(坑位:params 平铺 + text_elements 必填)', async () => {
    const res = (await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: 'ping', text_elements: [] }]
    })) as { turn?: { id?: string } }
    expect(res?.turn?.id).toBeTruthy()
  })

  it('通知流:turn 生命周期方法名到达(item/* 系通知在死端口下不保证有 delta,但 turn 级必有)', async () => {
    // 死端口 provider → turn 必然以 error 项收口;等通知静置(确定性:轮询
    // notification 谓词,无固定 sleep,zero-flake)
    const turnish = (n: AppServerNotification): boolean => /(^|\/)(turn|thread|item)/.test(n.method)
    for (let i = 0; i < 600 && !notifications.some(turnish); i++) {
      await new Promise((r) => setTimeout(r, 50))
    }
    const methods = notifications.map((n) => n.method)
    console.log('[contract] notifications:', JSON.stringify(methods.slice(0, 20)))
    // 0.149.x 形状:thread/turn 生命周期通知是 snake_case 斜杠路径
    // (error/started/completed 三态至少其一;名字变了 = 协议改了 = translator 要跟)
    expect(
      methods.some((m) => /thread\/|turn\//.test(m) || /error|started|completed/.test(m))
    ).toBe(true)
  })

  it('turn/interrupt 契约:无活动 turn 时返回 JSON-RPC 错误 -32600(生产链路靠 try/catch 兜住,升级时此码漂移要盯)', async () => {
    // 0.149.x 实测:对不存在/已收口的 turn interrupt → error -32600
    // "no active turn to interrupt"。生产 appServerRun.interruptActive 有
    // try/catch,协议层面"幂等可用"的真实含义是:错误不杀连接——后续请求仍可发。
    await expect(
      client.request('turn/interrupt', { threadId, turnId: 'nonexistent' })
    ).rejects.toThrow(/-32600|no active turn/)
    // 错误后连接仍活着:再发一个请求验证(JSON-RPC 错误 ≠ 进程死)
    const res = (await client.request('thread/start', { params: {} })) as {
      thread?: { id?: string }
    }
    expect(res?.thread?.id).toBeTruthy()
  })
})
