/**
 * Proves the approval-parked handoff works with a REAL fixture, not just asserted in the
 * abstract.
 *
 * The live host currently has zero approval-parked sessions, so `handoff.test.mjs` reports
 * "(0 approval-parked session(s) checked)" for that case — it passes, but vacuously. A test
 * that never exercises its own branch proves nothing, so this drives one deliberately.
 *
 * Run: node test/handoff-parked.test.mjs
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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'handoff-parked-'))
process.env.DSH_HOME = tempHome

const now = Date.now()
/** @param {string} id @param {object[]} extra @param {object} [header] */
function writeSession(id, extra, header = {}) {
  const dir = path.join(tempHome, 'sessions', '--C-probe--', id)
  fs.mkdirSync(dir, { recursive: true })
  const events = [
    { type: 'session', version: 4, id, time: now - 7_200_000, createdAt: now - 7_200_000, cwd: 'C:\\probe', delegationDepth: 0, ...header },
    { type: 'turn/start', seq: 1, time: now - 3_600_000, data: { turn: 1 } },
    ...extra.map((event, index) => ({ seq: index + 2, time: now - 3_600_000, ...event })),
  ]
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), events.map(event => JSON.stringify(event)).join('\n'), 'utf8')
}

// Parked on a real approval prompt: the user must act.
writeSession('session-park-approval', [
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh', callId: 'c1', arguments: '{}' } },
  { type: 'approval/asked', data: { turn: 1, step: 1, id: 'a1', toolName: 'pwsh', callId: 'c1' } },
])
// Parked on a question to the user.
writeSession('session-park-question', [
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'ask_user_question', callId: 'q1', arguments: '{}' } },
])
// A finished turn: healthy, needs nothing.
writeSession('session-finished', [
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
])
// A subagent: out of scope by design.
writeSession('session-child', [{ type: 'step/start', data: { turn: 1, step: 1 } }], { delegationDepth: 1 })

const { collectSessions } = await import('../lib/plugin.js')

console.log('\n=== handoff-parked.test.mjs ===')

const snapshot = await collectSessions({ get: () => undefined, logger: { warn() {} } }, {
  stallMs: 900_000, minAgeMs: 0, maxSessions: 50,
  resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 },
})
/** @param {string} id @returns {object|undefined} */
const row = id => snapshot.sessions.find(session => session.sessionId === id)

await test('the fixture really produced a parked-on-approval session', async () => {
  // Guard against the whole file passing vacuously: if the fixture stopped classifying as
  // `awaiting-approval`, the assertions below would be trivially true.
  assert.equal(row('session-park-approval')?.verdict, 'awaiting-approval',
    `got ${row('session-park-approval')?.verdict}`)
  assert.equal(row('session-park-question')?.verdict, 'awaiting-approval',
    `got ${row('session-park-question')?.verdict}`)
})

await test('a parked session carries advice, and it says the session is WAITING', async () => {
  const parked = row('session-park-approval')
  assert.ok(parked.handoff, 'a parked session must carry a handoff')
  assert.equal(parked.handoff.kind, 'needs-human')
  assert.match(parked.handoff.text, /等/, parked.handoff.text)
})

await test('a parked session is NEVER advertised as resumable', async () => {
  // Offering "手动续跑" here would invite the user to answer a question on the session's
  // behalf — the exact harm the approval gate exists to prevent.
  for (const id of ['session-park-approval', 'session-park-question']) {
    const parked = row(id)
    assert.ok(!/手动续跑/.test(parked.handoff.text),
      `${id} must not be advertised as resumable: ${parked.handoff.text}`)
    assert.equal(parked.resume.willResume, false, `${id} must never be auto-resumed`)
  }
})

await test('a healthy session carries NO advice', async () => {
  assert.equal(row('session-finished')?.verdict, 'idle', String(row('session-finished')?.verdict))
  assert.equal(row('session-finished')?.handoff, undefined,
    'a session that finished its turn needs nothing')
})

await test('a subagent carries NO advice', async () => {
  assert.equal(row('session-child')?.verdict, 'subagent', String(row('session-child')?.verdict))
  assert.equal(row('session-child')?.handoff, undefined,
    'subagents are the parent session\'s business')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
process.exit(failed > 0 ? 1 : 0)
