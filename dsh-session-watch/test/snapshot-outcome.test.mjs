/**
 * Checks whether the snapshot DESCRIBES what happened, or what was about to happen.
 *
 * THE ISSUE
 *
 * `collectSessions` computes each session's resume decision, and `buildSnapshot` then
 * acts on it. But the row it returns still carries the PRE-ACTION values:
 *
 *   - `resume.willResume` stays `true` after the resume already fired, so the panel says
 *     "本轮将恢复" (will resume) about a session that has already been resumed;
 *   - `resume.attempts` predates the increment, so the count is one behind;
 *   - `resume.lastAttemptBy` is null on the very scan that performed the attempt.
 *
 * That is an observability defect, not a cosmetic one. The whole point of layer 2's
 * design is that every automatic action is reportable — "an action the user cannot see
 * is indistinguishable from the harness acting on its own". A panel that reports the
 * INTENT rather than the OUTCOME leaves the user unable to tell whether the nudge
 * actually happened or is still pending.
 *
 * Run: node test/snapshot-outcome.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'snapshot-outcome-'))
process.env.DSH_HOME = tempHome

/** One genuinely stalled session, aged past the minAge gate. */
const STALLED_ID = 'session-outcome-0001'
{
  const dir = path.join(tempHome, 'sessions', STALLED_ID)
  fs.mkdirSync(dir, { recursive: true })
  const now = Date.now()
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), [
    { type: 'session', version: 4, id: STALLED_ID, createdAt: now - 3_600_000, cwd: 'C:\\probe', isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 1, time: now - 3_000_000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: now - 2_900_000, data: { turn: 1, step: 9, name: 'pwsh', callId: 'c9', arguments: '{}' } },
  ].map(event => JSON.stringify(event)).join('\n'), 'utf8')
}

const prompts = []
const ctx = {
  get(name) {
    if (name === 'sessionController') {
      return { async prompt(request, signal) { signal.throwIfAborted(); prompts.push(request); return { accepted: true } } }
    }
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  logger: { warn() {} },
}

const { buildSnapshot } = await import('../lib/plugin.js')

const config = {
  stallMs: 60_000,
  minAgeMs: 0,
  maxSessions: 50,
  resume: { enabled: true, maxAttempts: 3, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, promptTemplate: null },
}

console.log('\n=== snapshot-outcome.test.mjs ===')

let snapshot = null

await test('the scan actually performed the resume', async () => {
  snapshot = await buildSnapshot(ctx, config)
  assert.equal(prompts.length, 1, 'one prompt should have been sent')
  assert.equal(snapshot.totals.resumed, 1, 'and the snapshot should count it')
  assert.equal(snapshot.resumed.length, 1)
})

await test('the session row reflects the OUTCOME, not the intent', async () => {
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.ok(row, 'the session should be in the snapshot')
  // The action already happened, so advertising it as pending is wrong.
  assert.equal(
    row.resume.willResume,
    false,
    'after the resume fired, the row must not still claim it is about to resume',
  )
})

await test('the attempt count on the row matches the ledger', async () => {
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  const { readLedger } = await import('../lib/ledger.js')
  const ledgerAttempts = readLedger().sessions[STALLED_ID]?.attempts ?? 0
  assert.equal(
    row.resume.attempts,
    ledgerAttempts,
    'the row must not report a stale attempt count',
  )
})

await test('the row names the attempt that this scan just made', async () => {
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.equal(row.resume.lastAttemptBy, 'auto', 'this scan performed an automatic attempt')
  assert.equal(row.resume.lastAttemptOk, true)
})

await test('the ledger records WHEN the automatic attempt happened', async () => {
  // REGRESSION, found on the live host after the first real automatic resume: `buildSnapshot`
  // destructured `{ now }` from a snapshot whose timestamp is named `generatedAt`, so `now`
  // was `undefined` and every AUTOMATIC history entry carried `at: null` — rendered as
  // 1970-01-01. Manual attempts were unaffected, which is why it went unseen.
  //
  // `lastAttemptAt` was fine (it falls back to Date.now()), so backoff and the cap worked
  // correctly. That is precisely the danger: the mechanism behaved and only the audit trail
  // lied — and the ledger exists to attribute actions.
  const { readLedger } = await import('../lib/ledger.js')
  const record = readLedger().sessions[STALLED_ID]
  const entry = record.history.at(-1)
  assert.equal(entry.by, 'auto')
  assert.ok(
    Number.isFinite(entry.at),
    `an automatic attempt must carry a real timestamp, got ${JSON.stringify(entry.at)}`,
  )
  // Plausible: within a minute of the test run, not 1970.
  const skew = Math.abs(Date.now() - entry.at)
  assert.ok(skew < 60_000, `timestamp should be recent, off by ${skew}ms`)
  // And it must agree with the counter's own timestamp rather than contradicting it.
  assert.ok(
    Math.abs(record.lastAttemptAt - entry.at) < 5_000,
    `history.at (${entry.at}) and lastAttemptAt (${record.lastAttemptAt}) should agree`,
  )
})

await test('the explanation says what happened, not what was planned', async () => {
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.ok(
    /已恢复|已发送|本轮已/.test(row.resume.detail),
    `detail should describe the completed action: ${row.resume.detail}`,
  )
})

await test('the /watch rendering agrees with the snapshot', async () => {
  const { renderSnapshot } = await import('../lib/plugin.js')
  const text = renderSnapshot(snapshot).text
  assert.ok(/本轮自动恢复尝试/.test(text), 'the completed attempt must be listed')
  assert.ok(!/本轮将恢复/.test(text), `must not still promise a pending resume:\n${text}`)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
if (failed > 0) process.exit(1)
