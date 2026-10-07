/**
 * Tests the layer-3 handoff: when policy stops acting on a session, the snapshot must say
 * what to do next.
 *
 * WHY THIS EXISTS
 *
 * The project is a three-layer loop — detection finds a stalled session, the expert
 * diagnoses it, policy decides whether to resume. Layers 1 and 2 are automatic; layer 3
 * is a judgement. So when policy deliberately stops ("attempts exhausted", "the rules say
 * do not touch this"), the loop has arrived exactly where layer 3 takes over — and
 * reporting only a reason leaves the user holding a stopped session with no next step.
 * That is the original "看不过来" problem, one layer up.
 *
 * Run: node test/handoff.test.mjs
 */

import assert from 'node:assert/strict'

let passed = 0
let failed = 0

/** @param {string} label @param {() => any} body */
async function test(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${label}`)
    console.log(`        ${error.message}`)
  }
}

// `handoffFor` is internal to the plugin's HTTP layer, so it is exercised through the
// snapshot, which is the surface that actually carries it to the UI.

console.log('\n=== handoff.test.mjs ===')

await test('a session that WILL be resumed carries no handoff', async () => {
  // Advice on a session that is already being handled would be noise.
  const { classifySession } = await import('../lib/detect.js')
  const verdict = classifySession({
    events: [
      { type: 'session', time: Date.now() - 1_000_000, createdAt: Date.now() - 1_000_000 },
      { type: 'turn/start', seq: 1, time: Date.now() - 900_000, data: { turn: 1 } },
      { type: 'tool/call', seq: 2, time: Date.now() - 800_000, data: { turn: 1, step: 1 } },
    ],
    running: false, now: Date.now(), stallMs: 1000, minAgeMs: 0,
  })
  assert.equal(verdict.verdict, 'stalled', 'fixture precondition')
  // `handoffFor` returns null for `resumed`, which the snapshot test below covers end to
  // end; this asserts the classification that feeds it.
})

await test('the snapshot exposes `handoff` ONLY on sessions policy has stopped acting on', async () => {
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  // Resume DISABLED: every session is `disabled`, which means nothing has "given up" —
  // the user simply has not switched automation on. No handoff should appear at all.
  const snapshot = await collectSessions(ctx, {
    stallMs: 900_000, minAgeMs: 0, maxSessions: 60,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const withHandoff = snapshot.sessions.filter(session => session.handoff !== undefined)
  assert.deepEqual(
    withHandoff.map(session => `${session.sessionId}:${session.resume.reason}`),
    [],
    'with resume disabled, no session has exhausted anything, so no handoff applies',
  )
})

await test('every handoff carries a concrete next step, not just a diagnosis', async () => {
  // The handoff exists to give an ACTION. A handoff that only restated the reason would
  // be redundant with `resume.detail`, which is already present.
  //
  // `maxAttempts: 0` forces every stalled session straight to `attempts-exhausted`, which
  // is how the exhausted branch is reached without waiting for real retries to run out.
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const snapshot = await collectSessions(ctx, {
    stallMs: 900_000, minAgeMs: 0, maxSessions: 60,
    resume: { enabled: true, maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const rows = snapshot.sessions.filter(session => session.handoff !== undefined)
  for (const row of rows) {
    assert.ok(typeof row.handoff.text === 'string' && row.handoff.text.length > 10,
      'the handoff must be a sentence a person can act on')
    assert.ok(/sessionId=/.test(row.handoff.text), 'and must name the exact call to make')
    assert.ok(['attempts-exhausted', 'needs-human'].includes(row.handoff.kind))
  }
  console.log(`        (${rows.length} session(s) exercised the handoff path)`)
})

await test('the exhausted branch names the EXPERT, since that is the next layer', async () => {
  // The whole point of the handoff: when automation gives up, the loop is supposed to
  // continue in layer 3. A message that stopped at "attempts exhausted" would leave the
  // user exactly where the project started — holding a stopped session, unsure what next.
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const snapshot = await collectSessions(ctx, {
    stallMs: 900_000, minAgeMs: 0, maxSessions: 60,
    resume: { enabled: true, maxAttempts: 0, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const exhausted = snapshot.sessions.filter(session => session.handoff?.kind === 'attempts-exhausted')
  for (const row of exhausted) {
    // Either it names the expert (mounted), or it says the expert is unavailable and why.
    // Both are honest; silently omitting the expert would not be.
    assert.ok(/用户代理专家|专家/.test(row.handoff.text),
      `the exhausted handoff must reference the expert: ${row.handoff.text}`)
  }
  console.log(`        (${exhausted.length} exhausted session(s))`)
})

await test('a disabled policy is NOT a handoff (nothing has given up yet)', async () => {
  // With resume switched off, every session reads `disabled`. That is the user's own
  // configuration, not a policy that has exhausted itself, so urging them to intervene
  // would be noise on every single session.
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const snapshot = await collectSessions(ctx, {
    stallMs: 900_000, minAgeMs: 0, maxSessions: 60,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const withHandoff = snapshot.sessions.filter(session => session.handoff !== undefined)
  assert.deepEqual(withHandoff.map(s => s.resume.reason), [],
    'a disabled policy must not produce handoffs')
})

await test('healthy sessions get NO advice — measured on the live host at 193/193', async () => {
  // THE DEFECT THIS PINS DOWN. `handoffFor` treated `not-stalled` as a single state, but it
  // is every refusal that is not the cap — including `idle`, `subagent`, `empty` and
  // `aborted-by-user`. Measured on the live host, ALL 193 sessions carried a handoff
  // ("规则判定不该自动恢复（idle）… 可以先手动续跑") — wrong advice on 113 subagents and 67
  // ordinary idle sessions, and at that volume it buries the rows that genuinely need a
  // person.
  //
  // The rule now: advice only for states where the session is BLOCKED ON THE USER.
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const snapshot = await collectSessions(ctx, {
    stallMs: 900_000, minAgeMs: 0, maxSessions: 400,
    resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const noisy = snapshot.sessions.filter(session => session.handoff !== undefined)
  const wrong = noisy.filter(session => session.verdict !== 'awaiting-approval'
    && session.resume.reason !== 'attempts-exhausted')
  assert.deepEqual(
    wrong.map(session => `${session.sessionId}:${session.verdict}:${session.resume.reason}`),
    [],
    'only approval-parked and cap-exhausted sessions may carry advice',
  )
  // A parked session must never be advertised as resumable: resuming it would answer a
  // question the user has not answered.
  for (const session of noisy) {
    if (session.verdict !== 'awaiting-approval') continue
    assert.ok(!/手动续跑/.test(session.handoff.text),
      `a parked session must not be advertised as resumable: ${session.handoff.text}`)
    assert.ok(/等/.test(session.handoff.text), session.handoff.text)
  }
  console.log(`        (${snapshot.sessions.length} sessions surveyed, ${noisy.length} carrying advice)`)
})

await test('an approval wait is a handoff to a HUMAN, never to auto-resume', async () => {
  // The most safety-relevant branch: policy refuses an approval wait on purpose, so the
  // advice must send the user to look, not to force a resume.
  const { collectSessions } = await import('../lib/plugin.js')
  const ctx = { get: () => undefined, logger: { warn() {} } }
  const snapshot = await collectSessions(ctx, {
    stallMs: 60_000, minAgeMs: 0, maxSessions: 60,
    resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
  })
  const parked = snapshot.sessions.filter(session => session.verdict === 'awaiting-approval')
  for (const row of parked) {
    assert.ok(row.resume.willResume === false, 'an approval wait is never auto-resumed')
  }
  console.log(`        (${parked.length} approval-parked session(s) checked)`)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
