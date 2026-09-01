import { describe, it, expect } from 'vitest'
import {
  AGUI_EVENT_TYPES,
  encodeSseFrame,
  decodeSseData,
  runStarted,
  runFinished,
  runError,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  stateDelta,
  reasoningMessageStart,
  reasoningMessageContent,
  reasoningMessageEnd,
  custom
} from './types'

describe('AGUI_EVENT_TYPES', () => {
  it('defines exactly 21 event types matching waa AGUIEvent.EventType', () => {
    expect(AGUI_EVENT_TYPES).toHaveLength(21)
    // spot-check the families
    for (const t of [
      'RUN_STARTED',
      'TEXT_MESSAGE_CONTENT',
      'TOOL_CALL_RESULT',
      'STATE_DELTA',
      'REASONING_MESSAGE_END',
      'CUSTOM'
    ]) {
      expect(AGUI_EVENT_TYPES).toContain(t)
    }
  })
})

describe('constructors', () => {
  it('runStarted/runFinished carry threadId+runId and numeric timestamp', () => {
    const s = runStarted('t1', 'r1')
    expect(s.type).toBe('RUN_STARTED')
    expect(s.threadId).toBe('t1')
    expect(s.runId).toBe('r1')
    expect(typeof s.timestamp).toBe('number')

    const f = runFinished('t1', 'r1')
    expect(f.type).toBe('RUN_FINISHED')
    expect(f.threadId).toBe('t1')
  })

  it('runError omits code when absent', () => {
    expect(runError('boom')).toEqual({
      type: 'RUN_ERROR',
      timestamp: expect.any(Number),
      message: 'boom'
    })
    expect(runError('boom', 'RATE_LIMIT').code).toBe('RATE_LIMIT')
  })

  it('textMessage defaults role to assistant', () => {
    expect(textMessageStart('m1').role).toBe('assistant')
    expect(textMessageStart('m1', 'user').role).toBe('user')
    expect(textMessageContent('m1', 'hi').delta).toBe('hi')
  })

  it('toolCallStart omits parentMessageId when absent', () => {
    expect(toolCallStart('tc1', 'wb_execute_template')).toEqual({
      type: 'TOOL_CALL_START',
      timestamp: expect.any(Number),
      toolCallId: 'tc1',
      toolCallName: 'wb_execute_template'
    })
  })

  it('toolCallResult role is tool', () => {
    const r = toolCallResult('tc1', '{"ok":true}', 'm1')
    expect(r.role).toBe('tool')
    expect(r.messageId).toBe('m1')
    expect(toolCallResult('tc1', 'plain').messageId).toBeUndefined()
  })

  it('stateDelta carries JSON-Patch array', () => {
    const e = stateDelta([{ op: 'replace', path: '/tokenUsage/inputTokens', value: 10 }])
    expect(e.delta).toEqual([{ op: 'replace', path: '/tokenUsage/inputTokens', value: 10 }])
  })

  it('reasoning events use reasoning role', () => {
    expect(reasoningMessageStart('rm1').role).toBe('reasoning')
    expect(reasoningMessageContent('rm1', 'thinking...').delta).toBe('thinking...')
    expect(reasoningMessageEnd('rm1').type).toBe('REASONING_MESSAGE_END')
  })

  it('custom omits value when undefined', () => {
    expect(custom('keepalive')).toEqual({
      type: 'CUSTOM',
      timestamp: expect.any(Number),
      name: 'keepalive'
    })
    expect(custom('wb_plan', { intent: 'image' }).value).toEqual({ intent: 'image' })
  })
})

describe('encodeSseFrame / decodeSseData', () => {
  it('encodes as type-in-JSON SSE frame with double newline, no event: line', () => {
    const frame = encodeSseFrame(runStarted('t1', 'r1'))
    expect(frame).toMatch(/^data: /)
    expect(frame.endsWith('\n\n')).toBe(true)
    expect(frame).not.toMatch(/^event: /m)
    const payload = JSON.parse(frame.slice('data: '.length)) as { type: string }
    expect(payload.type).toBe('RUN_STARTED')
  })

  it('round-trips every constructed event through encode/decode', () => {
    const events = [
      runStarted('t', 'r'),
      runFinished('t', 'r'),
      runError('x', 'CODE'),
      textMessageStart('m1'),
      textMessageContent('m1', 'hello'),
      textMessageEnd('m1'),
      toolCallStart('tc1', 'wb_run_workflow'),
      toolCallArgs('tc1', '{"a":1}'),
      toolCallEnd('tc1'),
      toolCallResult('tc1', 'done', 'm1'),
      stateDelta([{ op: 'replace', path: '/a', value: 1 }]),
      reasoningMessageStart('rm1'),
      reasoningMessageContent('rm1', 'hmm'),
      reasoningMessageEnd('rm1'),
      custom('wb_plan', { intent: 'chat' })
    ]
    for (const ev of events) {
      const frame = encodeSseFrame(ev)
      const dataLine = frame.trim().slice('data: '.length)
      const decoded = decodeSseData(dataLine)
      expect(decoded).not.toBeNull()
      expect(decoded?.type).toBe(ev.type)
    }
  })

  it('decodeSseData rejects malformed payloads', () => {
    expect(decodeSseData('not json')).toBeNull()
    expect(decodeSseData('{"type":"UNKNOWN_TYPE"}')).toBeNull()
    expect(decodeSseData('{"noType":true}')).toBeNull()
  })
})
