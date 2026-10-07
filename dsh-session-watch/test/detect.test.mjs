/**
 * Regression tests for the stalled-session detector.
 *
 * Every fixture here encodes a real log shape measured in the user's own session
 * history, because each one caught a genuine misclassification during
 * development. The counts are deliberately exact: the detector's whole value is
 * that it fires on silent stops and stays quiet on deliberate ones, so a test
 * that only checks "some verdict was produced" would not protect anything.
 *
 * Run: node test/detect.test.mjs
 *
 * @module @local/dsh-session-watch/test/detect
 */

import { classifySession, isIntentionalEnd, AUTO_RESUMABLE } from '../lib/detect.js'

let passed = 0
let failed = 0

/**
 * Assert one classification result.
 * @param {string} label - what is being verified.
 * @param {any} actual - the produced verdict.
 * @param {string} expected - the expected verdict name.
 * @returns {void}
 */
function expectVerdict(label, actual, expected) {
  if (actual.verdict === expected) {
    passed += 1
    console.log(`  PASS  ${label} -> ${expected}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${label} -> got ${actual.verdict}, want ${expected}\n        detail: ${actual.detail}`)
  }
}

/** Build a session header event. */
const header = (extra = {}) => ({ type: 'session', createdAt: 1_000_000, ...extra })
/** Build a turn/start event. */
const turnStart = (turn, time) => ({ type: 'turn/start', seq: 1, time, data: { turn } })
/** Build a turn/end event. */
const turnEnd = (turn, reason, time) => ({ type: 'turn/end', seq: 2, time, data: { turn, reason } })
/** A long-ago timestamp, so silence gates open. */
const OLD = 1_000_000
const NOW = 10_000_000

console.log('\n--- isIntentionalEnd ---')
{
  const cases = [
    [{ kind: 'aborted', reason: { kind: 'user' } }, true, 'user cancel (nested)'],
    [{ kind: 'aborted' }, true, 'bare abort'],
    [{ kind: 'completed' }, false, 'normal completion'],
    [{ kind: 'error', error: {} }, false, 'machine-reported error'],
    [undefined, false, 'missing reason'],
  ]
  for (const [input, expected, label] of cases) {
    const actual = isIntentionalEnd(input)
    if (actual === expected) { passed += 1; console.log(`  PASS  ${label}`) }
    else { failed += 1; console.log(`  FAIL  ${label} -> got ${actual}, want ${expected}`) }
  }
}

console.log('\n--- the silent stop: the bug this plugin exists to catch ---')
// Measured shape: a live session whose log stops mid-turn with no `turn/end`
// and no error event at all. This MUST be `stalled`.
{
  const events = [
    header(),
    turnStart(1, OLD + 10),
    { type: 'step/start', seq: 3, time: OLD + 20, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 4, time: OLD + 30, data: { turn: 1, step: 1 } },
  ]
  expectVerdict('running + log stops at tool/call',
    classifySession({ events, running: true, now: NOW, stallMs: 60_000, minAgeMs: 0 }), 'stalled')
  expectVerdict('idle + log stops at tool/call',
    classifySession({ events, running: false, now: NOW, stallMs: 60_000, minAgeMs: 0 }), 'stalled')
}
// A running session inside the silence window is still progress, not a stall.
expectVerdict('running but recently active',
  classifySession({
    events: [header(), turnStart(1, NOW - 5_000), { type: 'step/start', seq: 3, time: NOW - 5_000, data: { turn: 1, step: 1 } }],
    running: true, now: NOW, stallMs: 600_000, minAgeMs: 0,
  }), 'idle')

console.log('\n--- 停摆窗口对两种 running 状态一视同仁（真实误报的回归）---')
// MEASURED FALSE POSITIVE. The rule used to be asymmetric: `running && silentMs >= stallMs`
// reported a stall, but `!running` reported one with NO silence gate at all.
//
// `running` means "an agent for this session is live in THIS process", so it is false for
// every session on disk right after a restart. On the live host that produced two automatic
// nudges 13 s after boot, with silences of 6 s and 0 s against a 900 s window. Replaying the
// decision made it unambiguous: the SAME log at the SAME instant gave `stalled` for
// `running: false` and `idle` for `running: true`.
//
// So both directions are pinned here: a fresh open turn is idle either way, and a genuinely
// old one is stalled either way. The window delays detection of a dead driver until silence
// means something; it must never lose the case.
{
  const recent = [
    header(),
    turnStart(1, NOW - 3_000),
    { type: 'step/start', seq: 3, time: NOW - 3_000, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 4, time: NOW - 3_000, data: { turn: 1, step: 1 } },
  ]
  expectVerdict('刚写过的日志 + running=false 不是停摆（重启后的常态）',
    classifySession({ events: recent, running: false, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'idle')
  expectVerdict('同一份日志 + running=true 也不是停摆',
    classifySession({ events: recent, running: true, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'idle')

  // The control: the SAME shape, aged past the window, is a stall in both states. Without
  // this the fix could "pass" by never reporting a stall at all.
  const aged = recent.map(event => ({ ...event, time: (event.time ?? 0) - 3_600_000 }))
  expectVerdict('同样的形状、静默超窗 + running=false 仍是停摆',
    classifySession({ events: aged, running: false, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'stalled')
  expectVerdict('同样的形状、静默超窗 + running=true 仍是停摆',
    classifySession({ events: aged, running: true, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'stalled')

  // And the boundary is exact, so the comparison stays `>=` rather than drifting.
  //
  // These are built from `NOW` directly rather than by shifting the fixture above: that one
  // is stamped at `NOW - 3_000`, so subtracting 899_999 from it lands at 903s of silence —
  // past the window, not just inside it. Arithmetic on a fixture whose offset you have to
  // remember is how a boundary test silently stops testing the boundary.
  const edge = silence => [
    header(),
    turnStart(1, NOW - silence),
    { type: 'step/start', seq: 3, time: NOW - silence, data: { turn: 1, step: 1 } },
    { type: 'tool/call', seq: 4, time: NOW - silence, data: { turn: 1, step: 1 } },
  ]
  expectVerdict('静默正好等于 stallMs 判为停摆（边界含等号）',
    classifySession({ events: edge(900_000), running: false, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'stalled')
  expectVerdict('静默差 1ms 未达窗口时不是停摆',
    classifySession({ events: edge(899_999), running: false, now: NOW, stallMs: 900_000, minAgeMs: 0 }), 'idle')
}

console.log('\n--- a closed turn is finished work, whatever follows it ---')
// Measured: `turn/end {completed}` then `session/end-seed`, `model/selection`.
expectVerdict('completed turn + trailing session/end-seed',
  classifySession({
    events: [header(), turnStart(1, OLD), turnEnd(1, { kind: 'completed' }, OLD + 10),
      { type: 'session/end-seed', seq: 3, time: OLD + 20, data: {} },
      { type: 'model/selection', seq: 4, time: OLD + 30, data: {} }],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'idle')
// Measured: a turn ended by a 429 usage limit, then `/compact` and `/export`.
// The machine already recorded and reported this failure; it is not a silent stop.
expectVerdict('error turn + trailing /compact and /export',
  classifySession({
    events: [header(), turnStart(1, OLD),
      turnEnd(1, { kind: 'error', error: { message: '429 usage limit' } }, OLD + 10),
      { type: 'session/end-seed', seq: 3, time: OLD + 20, data: {} },
      { type: 'command/run', seq: 4, time: OLD + 30, data: { name: 'exports' } },
      { type: 'command/done', seq: 5, time: OLD + 31, data: { kind: 'success' } }],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'idle')

console.log('\n--- turn scoping: an OLD abort must not describe the CURRENT turn ---')
// Measured shape of the two live sessions: an earlier turn was aborted, then a
// later turn opened and silently stopped. Reading the last `turn/end` anywhere
// reported these as `aborted-by-user` and hid a real stall.
{
  const events = [
    header(),
    turnStart(1, OLD),
    turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }, OLD + 10),
    turnStart(2, OLD + 20),
    { type: 'step/start', seq: 5, time: OLD + 30, data: { turn: 2, step: 1 } },
  ]
  expectVerdict('old abort, then a current turn stalls',
    classifySession({ events, running: false, now: NOW, stallMs: 60_000, minAgeMs: 0 }), 'stalled')
}
// And when the CURRENT turn is the aborted one, it must stay untouched.
expectVerdict('current turn aborted by the user',
  classifySession({
    events: [header(), turnStart(1, OLD), turnEnd(1, { kind: 'aborted', reason: { kind: 'user' } }, OLD + 10)],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'aborted-by-user')

console.log('\n--- sessions that must never be auto-resumed ---')
// Measured shape: header + setup events only, never a request. Resuming one of
// these would invent work the user never asked for.
expectVerdict('setup-only abandoned session',
  classifySession({
    events: [header(), { type: 'permission/preset', seq: 0, time: OLD, data: {} },
      { type: 'sandbox/mode', seq: 1, time: OLD, data: {} },
      { type: 'approval/policy', seq: 2, time: OLD, data: {} },
      { type: 'session/end-seed', seq: 3, time: OLD, data: {} }],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'empty')
// A delegated child legitimately goes quiet between its own steps.
expectVerdict('subagent child session',
  classifySession({
    events: [header({ delegationDepth: 1 }), turnStart(1, OLD),
      { type: 'step/start', seq: 3, time: OLD, data: { turn: 1, step: 1 } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 0, isSubagent: true,
  }), 'subagent')
// An unreadable log is never a reason to act.
expectVerdict('unreadable log',
  classifySession({ events: [], running: true, now: NOW, readable: false }), 'unreadable')
// A brand-new session has not had time to stall. The header's `createdAt` is the
// session's real start, which is what the age gate reads — not its first turn.
expectVerdict('session younger than minAgeMs',
  classifySession({
    events: [header({ createdAt: NOW - 1_000 }), turnStart(1, NOW - 1_000),
      { type: 'step/start', seq: 3, time: NOW - 1_000, data: { turn: 1, step: 1 } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 600_000,
  }), 'too-young')
// A session parked on an approval decision is waiting for the user, not dead.
expectVerdict('parked on an approval decision',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 1 } },
      { type: 'approval/policy', seq: 4, time: OLD + 20, data: { policy: 'ask' } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'awaiting-approval')

// REGRESSION: the real approval-request event is `approval/asked`, and the gate
// previously keyed on `approval/request`, which this build never emits. That made
// the gate dead for its most important case: a session waiting for the user to
// approve a tool was classified `stalled`, and `stalled` is the one auto-resumable
// verdict — so enabling auto-resume would have answered the user's approval for
// them. Measured: `approval/asked` appears in 10 of 178 real logs.
expectVerdict('parked on an approval/asked (the REAL event name)',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 2, name: 'pwsh', callId: 'c1' } },
      { type: 'approval/asked', seq: 4, time: OLD + 20, data: { id: 'a1', toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox' } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'awaiting-approval')

// The same wait must also be caught while the agent has already gone idle, because
// a parked turn stops the driver — which is exactly the shape that looks stalled.
expectVerdict('approval/asked with an idle agent',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 2, name: 'pwsh', callId: 'c1' } },
      { type: 'approval/asked', seq: 4, time: OLD + 20, data: { id: 'a1', toolName: 'pwsh', callId: 'c1' } }],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'awaiting-approval')

// REGRESSION: a turn parked on a question to the user has NO event type of its own —
// the evidence is a tool call with no matching result. Measured: `ask_user_question`
// is called 40 times across this host's logs.
expectVerdict('parked on an unanswered ask_user_question',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 3, name: 'ask_user_question', callId: 'q1', arguments: '{}' } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'awaiting-approval')

// ...and the mirror image: once that question IS answered, the turn is progressing
// again and must not stay parked in the awaiting state. The result is stamped RECENT
// on purpose: the point under test is that an answered question is not a wait, so
// the fixture must not also be silent enough to trip the stall rule.
expectVerdict('an ANSWERED ask_user_question is not a wait',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 3, name: 'ask_user_question', callId: 'q1', arguments: '{}' } },
      { type: 'tool/result', seq: 4, time: NOW - 1_000, data: { turn: 1, step: 3, message: { role: 'tool', toolCallId: 'q1', content: [{ type: 'text', text: 'yes' }] } } }],
    running: true, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'idle')

// The gate must not become a blanket false positive: an ordinary tool call with no
// result yet is what a genuinely stalled session looks like, and it must still be
// classified as stalled.
expectVerdict('a normal tool call with no result is still a stall',
  classifySession({
    events: [header(), turnStart(1, OLD),
      { type: 'tool/call', seq: 3, time: OLD + 10, data: { turn: 1, step: 68, name: 'pwsh', callId: 'c9', arguments: '{}' } },
      { type: 'tool/ptc-dispatch-start', seq: 4, time: OLD + 11, data: { turn: 1, step: 68 } }],
    running: false, now: NOW, stallMs: 60_000, minAgeMs: 0,
  }), 'stalled')

console.log('\n--- the auto-resume gate ---')
if (AUTO_RESUMABLE.size === 1 && AUTO_RESUMABLE.has('stalled')) {
  passed += 1
  console.log('  PASS  only `stalled` is auto-resumable')
} else {
  failed += 1
  console.log(`  FAIL  AUTO_RESUMABLE = ${[...AUTO_RESUMABLE].join(', ')}`)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
