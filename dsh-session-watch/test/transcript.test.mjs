/**
 * Tests for the transcript shaper and the stop summarizer.
 *
 * These two modules are what the expert actually reads, so a shaping bug here is a
 * wrong diagnosis delivered confidently — worse than no diagnosis. The fixtures are
 * modelled on the real event shapes measured in this deployment's session logs
 * (including the `tool/ptc-dispatch-start` shape that the one genuinely stalled
 * session ends on).
 *
 * Run: node test/transcript.test.mjs
 */

import assert from 'node:assert/strict'
import { buildTranscript, summarizeStop, transcribeEvent } from '../lib/transcript.js'

let passed = 0
let failed = 0

/** @param {string} label @param {() => void} body */
function test(label, body) {
  try {
    body()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${label}`)
    console.log(`        ${error.message}`)
  }
}

/** One event, with the fields the real logs carry. */
function ev(seq, type, data, time = 1000 + seq) {
  return { type, seq, time, data }
}

console.log('\n=== transcript.test.mjs ===')

// ---------------------------------------------------------------------------
// transcribeEvent — what is kept and what is dropped
// ---------------------------------------------------------------------------

test('user text is kept', () => {
  const entry = transcribeEvent(ev(1, 'user/message', {
    content: [{ type: 'text', text: '帮我看看这个问题' }],
    role: 'user',
  }))
  assert.equal(entry.role, 'user')
  assert.equal(entry.text, '帮我看看这个问题')
})

test('assistant text is kept', () => {
  const entry = transcribeEvent(ev(2, 'assistant/message', {
    turn: 1,
    step: 1,
    message: { role: 'assistant', content: [{ type: 'text', text: '我看了一下' }] },
  }))
  assert.equal(entry.role, 'assistant')
  assert.equal(entry.text, '我看了一下')
})

test('reasoning blocks are dropped from the transcript', () => {
  // Reasoning is not conversation, and including it would flood the expert's
  // context with text the model wrote to itself.
  const entry = transcribeEvent(ev(3, 'assistant/message', {
    message: {
      role: 'assistant',
      content: [{ type: 'reasoning', text: '让我想想……' }, { type: 'text', text: '结论是 X' }],
    },
  }))
  assert.equal(entry.text, '结论是 X')
  assert.ok(!entry.text.includes('让我想想'))
})

test('tool call keeps the tool name AND its arguments', () => {
  // A tool call whose arguments are hidden is precisely the case an expert cannot
  // diagnose, so this must not regress into a bare name.
  const entry = transcribeEvent(ev(4, 'tool/call', {
    turn: 1, step: 2, callId: 'c1', name: 'pwsh', arguments: '{"command":"ls"}',
  }))
  assert.equal(entry.role, 'tool-call')
  assert.ok(entry.text.includes('pwsh'))
  assert.ok(entry.text.includes('ls'))
})

test('a failed tool result is marked as a failure', () => {
  const entry = transcribeEvent(ev(5, 'tool/result', {
    turn: 1,
    step: 2,
    message: { role: 'tool', isError: true, content: [{ type: 'text', text: 'boom' }] },
    error: { name: 'Error', code: 'E_FAIL' },
  }))
  assert.equal(entry.isError, true)
  assert.ok(entry.text.includes('失败'))
  assert.ok(entry.text.includes('E_FAIL'))
})

test('a successful tool result is not marked as a failure', () => {
  const entry = transcribeEvent(ev(6, 'tool/result', {
    turn: 1, step: 2, message: { role: 'tool', content: [{ type: 'text', text: 'ok' }] },
  }))
  assert.notEqual(entry.isError, true)
})

test('turn/end records the reason kind and its cause', () => {
  const entry = transcribeEvent(ev(7, 'turn/end', {
    turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } },
  }))
  assert.equal(entry.endKind, 'aborted')
  assert.ok(entry.text.includes('aborted'))
  assert.ok(entry.text.includes('user'))
})

test('llm/retry is kept, because it explains silence without an error', () => {
  const entry = transcribeEvent(ev(8, 'llm/retry', { code: 'RATE_LIMIT', status: 429 }))
  assert.equal(entry.role, 'retry')
  assert.ok(entry.text.includes('RATE_LIMIT'))
  assert.ok(entry.text.includes('429'))
})

test('machine bookkeeping is dropped', () => {
  // This exclusion is what makes the transcript fit in a context window.
  for (const type of ['step/start', 'step/end', 'request/header', 'request/context',
    'assistant/attempt', 'tool/ptc-dispatch-start', 'session/end-seed']) {
    assert.equal(transcribeEvent(ev(9, type, {})), null, `${type} should be dropped`)
  }
})

test('an unknown event type is dropped rather than guessed at', () => {
  assert.equal(transcribeEvent(ev(10, 'some/future-event', { x: 1 })), null)
})

test('a long message is truncated and SAYS SO', () => {
  // Silently cutting text would make the expert reason about a conversation that
  // appears to stop mid-sentence — it must know the text was clipped.
  const entry = transcribeEvent(ev(11, 'user/message', {
    content: [{ type: 'text', text: 'x'.repeat(5000) }],
  }))
  assert.ok(entry.text.length < 5000)
  assert.ok(entry.text.includes('已截断'))
})

// ---------------------------------------------------------------------------
// buildTranscript — bounding
// ---------------------------------------------------------------------------

console.log('\n--- buildTranscript ---')

test('keeps the TAIL, because the end is where failure is visible', () => {
  const events = []
  for (let i = 0; i < 100; i += 1) {
    events.push(ev(i, 'user/message', { content: [{ type: 'text', text: `msg${i}` }] }))
  }
  const result = buildTranscript(events, { limit: 5 })
  assert.equal(result.entries.length, 5)
  assert.equal(result.entries.at(-1).text, 'msg99')
  assert.equal(result.total, 100)
  assert.equal(result.omitted, 95)
})

test('limit is clamped to a hard ceiling', () => {
  const events = []
  for (let i = 0; i < 600; i += 1) {
    events.push(ev(i, 'user/message', { content: [{ type: 'text', text: `m${i}` }] }))
  }
  const result = buildTranscript(events, { limit: 100000 })
  assert.ok(result.entries.length <= 400)
})

test('fromSeq filters to the current turn only', () => {
  const events = [
    ev(1, 'user/message', { content: [{ type: 'text', text: 'old' }] }),
    ev(50, 'user/message', { content: [{ type: 'text', text: 'new' }] }),
  ]
  const result = buildTranscript(events, { fromSeq: 10 })
  assert.equal(result.entries.length, 1)
  assert.equal(result.entries[0].text, 'new')
})

test('toolErrors counts failures across the whole selection, not just the tail', () => {
  const events = [
    ev(1, 'tool/result', { message: { role: 'tool', isError: true, content: [] } }),
    ev(2, 'user/message', { content: [{ type: 'text', text: 'a' }] }),
    ev(3, 'user/message', { content: [{ type: 'text', text: 'b' }] }),
  ]
  const result = buildTranscript(events, { limit: 1 })
  assert.equal(result.entries.length, 1)
  assert.equal(result.toolErrors, 1)
})

test('a non-array input is tolerated', () => {
  assert.deepEqual(buildTranscript(null).entries, [])
  assert.deepEqual(buildTranscript(undefined).entries, [])
})

// ---------------------------------------------------------------------------
// summarizeStop — the deterministic facts
// ---------------------------------------------------------------------------

console.log('\n--- summarizeStop ---')

test('an open current turn is detected', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'step/start', { turn: 1, step: 1 }),
  ]
  const stop = summarizeStop(events)
  assert.equal(stop.lastTurn, 1)
  assert.equal(stop.openTurn, true)
  assert.equal(stop.endKind, null)
})

test('a closed current turn is NOT reported as open', () => {
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'completed' } }),
  ]
  const stop = summarizeStop(events)
  assert.equal(stop.openTurn, false)
  assert.equal(stop.endKind, 'completed')
})

test('an OLDER turn/end does not close the current turn', () => {
  // This is the distinction the detector had to learn the hard way. An older
  // `aborted` must never describe the turn that is still open, or a real stall gets
  // laundered into "the user stopped it".
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }),
    ev(3, 'turn/start', { turn: 2 }),
    ev(4, 'step/start', { turn: 2, step: 1 }),
  ]
  const stop = summarizeStop(events)
  assert.equal(stop.lastTurn, 2)
  assert.equal(stop.openTurn, true)
  assert.equal(stop.endKind, null)
})

test('retries are counted', () => {
  const events = [
    ev(1, 'llm/retry', { code: 'A' }),
    ev(2, 'llm/retry', { code: 'B' }),
    ev(3, 'user/message', { content: [] }),
  ]
  assert.equal(summarizeStop(events).retries, 2)
})

test('tool failures are collected with their coordinates', () => {
  const events = [
    ev(1, 'tool/result', { turn: 1, step: 5, error: { name: 'E', code: 'C1' }, message: { role: 'tool' } }),
  ]
  const stop = summarizeStop(events)
  assert.equal(stop.toolFailures.length, 1)
  assert.equal(stop.toolFailures[0].step, 5)
  assert.equal(stop.toolFailures[0].code, 'C1')
})

test('tool failures are capped at the last five', () => {
  const events = []
  for (let i = 0; i < 20; i += 1) {
    events.push(ev(i, 'tool/result', { turn: 1, step: i, error: { code: `C${i}` }, message: { role: 'tool' } }))
  }
  const stop = summarizeStop(events)
  assert.equal(stop.toolFailures.length, 5)
  assert.equal(stop.toolFailures.at(-1).code, 'C19')
})

test('an empty log yields no invented facts', () => {
  const stop = summarizeStop([])
  assert.equal(stop.lastTurn, null)
  assert.equal(stop.openTurn, false)
  assert.equal(stop.retries, 0)
  assert.deepEqual(stop.toolFailures, [])
})

test('the real stalled-session shape is summarized as an open turn', () => {
  // Modelled on a genuinely stalled session observed on a real host:
  // it ends on `tool/ptc-dispatch-start` with no turn/end.
  const events = [
    ev(1, 'turn/start', { turn: 1 }),
    ev(2, 'tool/call', { turn: 1, step: 68, name: 'pwsh', arguments: '{}' }),
    ev(3, 'tool/ptc-dispatch-start', { turn: 1, step: 68 }),
  ]
  const stop = summarizeStop(events)
  assert.equal(stop.openTurn, true)
  assert.equal(stop.lastTurn, 1)
  assert.equal(stop.lastStep, 68)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
