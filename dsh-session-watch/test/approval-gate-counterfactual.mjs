/**
 * Demonstrates the COUNTERFACTUAL: that the pre-fix approval gate would have resumed a
 * session parked on an approval.
 *
 * WHY BOTHER PROVING A COUNTERFACTUAL
 *
 * The fix's justification rests on the claim "the old gate never fired for the real
 * event name, so a parked session was classified `stalled` and would have been nudged on
 * the user's behalf." That claim is the entire reason the bug mattered. Asserting it is
 * not enough — this project has already been burned by reasoning that agreed with itself.
 *
 * So this reconstructs the ORIGINAL `AWAITING_TYPES` set (the one written from upstream
 * type names) and runs the CURRENT detector's decision logic over the SAME fixtures the
 * live verification used. If the counterfactual is real, the old set must let the parked
 * sessions through as `stalled`.
 *
 * It does not import the shipped detector for the old set — it reimplements only the
 * membership test, so a future edit to the shipped set cannot silently invalidate this.
 *
 * Run: node test/approval-gate-counterfactual.mjs
 */

import assert from 'node:assert/strict'

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

/**
 * The ORIGINAL set, exactly as first written: names taken from the upstream TypeScript
 * declarations rather than from this build's actual logs.
 *
 * Measured against 178 real session logs: `approval/request`, `user/question` and
 * `plan/proposal` appear ZERO times. The real approval-request event is `approval/asked`.
 */
const OLD_AWAITING_TYPES = new Set([
  'approval/request',
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
  'user/question',
  'plan/proposal',
])

/** A session parked on an approval, using the REAL event name this build emits. */
const APPROVAL_PARKED = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 2, name: 'pwsh', callId: 'c1' } },
  { type: 'approval/asked', data: { id: 'a1', toolName: 'pwsh', callId: 'c1' } },
]

/** A turn parked on a question to the user: no dedicated event type at all. */
const QUESTION_PARKED = [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 3, name: 'ask_user_question', callId: 'q1' } },
]

/**
 * Apply a gate set to a turn tail, mirroring the detector's placement: the waiting check
 * runs while the current turn is still open, and anything it does not catch falls through
 * to `stalled` (the one auto-resumable verdict).
 *
 * @param {object[]} events - the current turn's tail.
 * @param {Set<string>} awaitingTypes - the gate set under test.
 * @returns {'awaiting-approval' | 'stalled'} the verdict.
 */
function classifyTail(events, awaitingTypes) {
  const tailTypes = new Set(events.map(event => event.type))
  for (const awaiting of awaitingTypes) {
    if (tailTypes.has(awaiting)) return 'awaiting-approval'
  }
  // Nothing caught it, so it is a silent stop — the auto-resumable verdict.
  return 'stalled'
}

const { AWAITING_TYPES } = await import('../lib/detect.js')

console.log('\n=== approval-gate-counterfactual.mjs ===')
console.log('（证明修复前的闸门确实会误恢复等待中的会话）\n')

test('the shipped gate set now contains the REAL event name', () => {
  assert.ok(AWAITING_TYPES.has('approval/asked'), 'the fix must key on the real name')
})

test('the shipped gate set no longer relies on names this build never emits', () => {
  // `approval/policy`, `permission/preset` and `sandbox/mode` are legitimately kept —
  // they DO appear in real logs. The invented three are what must be gone.
  for (const invented of ['approval/request', 'user/question', 'plan/proposal']) {
    assert.ok(!AWAITING_TYPES.has(invented), `${invented} never appears in any real log`)
  }
})

test('COUNTERFACTUAL: the OLD gate let an approval-parked session through as stalled', () => {
  assert.equal(
    classifyTail(APPROVAL_PARKED, OLD_AWAITING_TYPES),
    'stalled',
    'the old set should fail to recognise approval/asked',
  )
})

test('COUNTERFACTUAL: the OLD gate let a question-parked session through as stalled', () => {
  assert.equal(
    classifyTail(QUESTION_PARKED, OLD_AWAITING_TYPES),
    'stalled',
    'the old set had no concept of an unanswered user question',
  )
})

test('THE FIX: the shipped gate recognises the approval-parked session', () => {
  assert.equal(classifyTail(APPROVAL_PARKED, AWAITING_TYPES), 'awaiting-approval')
})

test('and `stalled` is the ONLY auto-resumable verdict', async () => {
  // This is what turns the classification bug into a safety bug: had the parked session
  // merely been *reported* differently the bug would have been cosmetic.
  const { AUTO_RESUMABLE } = await import('../lib/detect.js')
  assert.deepEqual([...AUTO_RESUMABLE], ['stalled'])
})

console.log('\n结论：修复前，一个停在审批上的会话会被判成 `stalled`，')
console.log('      而 `stalled` 是唯一会被自动恢复的判定 —— 于是插件会替你')
console.log('      往一个正在等你批准工具的会话里发一条「继续」。')
console.log('      这解释了为什么这个修复是安全性修复，而不是分类口径的微调。')

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
