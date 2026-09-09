/**
 * 真机冒烟:claude transport 全链路(真实 spawn,非 mock)。
 * 用法: npx tsx scripts/smoke-claude-transport.mts  (或 vitest 单跑)
 * 两轮 turn:第一轮建立 session,第二轮验证 --resume 注入与上下文连续。
 */
import { createClaudeRuntime } from '../src/main/artifylab/agui/claude/transport'

async function runTurn(rt: ReturnType<typeof createClaudeRuntime>, label: string, input: string) {
  const run = await rt.startTurn(input)
  const events: Array<{ type: string; delta?: string }> = []
  for await (const frame of run.stream) {
    if (frame.event) {
      const e = frame.event as { type: string; delta?: string }
      events.push({ type: e.type, delta: e.delta })
    }
  }
  const types = events.map((e) => e.type)
  const text = events
    .filter((e) => e.type === 'TEXT_MESSAGE_CONTENT')
    .map((e) => e.delta ?? '')
    .join('')
  console.log(`\n=== ${label} ===`)
  console.log('事件数:', events.length)
  console.log('帧序:', [...new Set(types)].join(' → '))
  console.log('正文:', JSON.stringify(text.slice(0, 200)))
  const ok =
    types[0] === 'RUN_STARTED' && types[types.length - 1] === 'RUN_FINISHED' && text.length > 0
  console.log(ok ? '✅ 通过' : '❌ 失败(终帧或正文缺失)')
  return ok
}

const rt = await createClaudeRuntime({
  binary: 'claude',
  env: { ...process.env },
  threadId: 'smoke-thread',
  runId: 'smoke-run-1'
})

// 第一轮:喂一个暗号,要求记住
const ok1 = await runTurn(rt, '第一轮(建 session)', '请记住暗号:西瓜闪电。只回复"已记住"三个字。')
// 第二轮:--resume 后应能答出暗号
const rt2 = rt as unknown as {
  startTurn: (i: string) => Promise<{ stream: AsyncGenerator<unknown, void, unknown> }>
}
void rt2
const ok2 = await runTurn(
  rt as never,
  '第二轮(--resume 上下文连续)',
  '暗号是什么?只回复暗号本身四个字。'
)

await rt.dispose()
console.log('\n总结:', ok1 && ok2 ? '两轮全部通过 ✅' : '存在失败 ❌')
process.exit(ok1 && ok2 ? 0 : 1)
