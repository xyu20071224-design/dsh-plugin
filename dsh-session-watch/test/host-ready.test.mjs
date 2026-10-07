/**
 * Proves a resume blocked by an unready Host does NOT consume a session's allowance.
 *
 * THE BUG (measured, not theorised)
 *
 * The watcher's first scan runs about a second after the process starts. At that moment
 * `sessionController` may still be initializing — it waits on `workspaceRegistry`, which
 * reads the session corpus from disk. So an early resume returns `no-controller`.
 *
 * The old code recorded that exactly like any other failure, which means:
 *
 *   - a session that happened to be stalled at boot lost one of its (by default, two)
 *     allowances to a nudge that was never sent;
 *   - after two restarts it would be reported as `attempts-exhausted` — the panel would
 *     claim the watcher had tried twice and given up, when in fact it had never sent
 *     anything at all.
 *
 * `no-controller` is a fact about the PROCESS, not about the session, so it must be
 * reported and retried without being counted.
 *
 * Run: node test/host-ready.test.mjs
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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'host-ready-'))
process.env.DSH_HOME = tempHome

const STALLED_ID = 'session-hostready-0001'
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

/** A context whose controller is absent, as during startup. */
function unreadyContext() {
  return {
    get(name) {
      if (name === 'agents') return { list: () => [] }
      // No sessionController yet.
      return undefined
    },
    logger: { warn() {} },
  }
}

/** A context whose controller works. */
function readyContext(prompts) {
  return {
    get(name) {
      if (name === 'sessionController') {
        return { async prompt(request, signal) { signal.throwIfAborted(); prompts.push(request); return { accepted: true } } }
      }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    logger: { warn() {} },
  }
}

const config = {
  stallMs: 60_000,
  minAgeMs: 0,
  maxSessions: 50,
  resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, promptTemplate: null },
}

const { buildSnapshot } = await import('../lib/plugin.js')
const { readLedger } = await import('../lib/ledger.js')

console.log('\n=== host-ready.test.mjs ===')

await test('an unready Host does not consume an attempt', async () => {
  const snapshot = await buildSnapshot(unreadyContext(), config)
  const record = readLedger().sessions[STALLED_ID]
  assert.equal(
    record?.attempts ?? 0,
    0,
    'nothing was sent, so nothing may be counted',
  )
  assert.equal(snapshot.totals.resumed, 0)
  assert.equal(snapshot.totals.resumeFailed, 0, 'and it is not reported as a failure either')
})

await test('the row says the Host was not ready, rather than that it failed', async () => {
  const snapshot = await buildSnapshot(unreadyContext(), config)
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.equal(row.resume.reason, 'host-not-ready')
  assert.equal(row.resume.willResume, false)
  assert.ok(/尚未就绪/.test(row.resume.detail), `detail should explain: ${row.resume.detail}`)
  // It retries on its own, so it must not be handed to a person as something to fix.
  assert.equal(row.handoff, undefined, 'a self-retrying state needs no handoff')
})

await test('a READY Host still performs and counts the resume', async () => {
  // The control: the fix must not have disabled the normal path.
  const prompts = []
  const snapshot = await buildSnapshot(readyContext(prompts), config)
  assert.equal(prompts.length, 1, 'the prompt should have been sent')
  assert.equal(readLedger().sessions[STALLED_ID]?.attempts, 1, 'and counted')
  assert.equal(snapshot.totals.resumed, 1)
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.equal(row.resume.reason, 'resumed')
  assert.equal(row.resume.lastAttemptBy, 'auto')
})

await test('the allowance survives repeated unready scans', async () => {
  // Three unready scans in a row must still leave the full allowance intact — this is the
  // scenario that produced the misreport, since each restart runs one early scan.
  fs.writeFileSync(
    path.join(tempHome, 'session-watch.json'),
    JSON.stringify({ version: 1, sessions: {} }),
    'utf8',
  )
  for (let i = 0; i < 3; i += 1) await buildSnapshot(unreadyContext(), config)
  assert.equal(readLedger().sessions[STALLED_ID]?.attempts ?? 0, 0)

  // And once the Host is ready, the session still gets its FULL allowance.
  const prompts = []
  await buildSnapshot(readyContext(prompts), config)
  assert.equal(prompts.length, 1)
  assert.equal(readLedger().sessions[STALLED_ID]?.attempts, 1, 'one real attempt, not two')
})

await test('the manual HTTP route records its attempt too', async () => {
  // The manual route is exempt from the automatic GATE — a user action replaces the policy
  // checks — but exemption from the gate is not a licence to act INVISIBLY. The ledger is
  // the single account of what was tried against a session, so a resume that skips it
  // makes the panel's history wrong.
  fs.writeFileSync(
    path.join(tempHome, 'session-watch.json'),
    JSON.stringify({ version: 1, sessions: {} }),
    'utf8',
  )
  const prompts = []
  const routes = []
  const ctx = {
    get(name) {
      if (name === 'sessionController') {
        return { async prompt(request, signal) { signal.throwIfAborted(); prompts.push(request); return { accepted: true } } }
      }
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    effect: setup => { const r = setup(); return typeof r === 'function' ? r : () => {} },
    commands: { register: () => () => {} },
    webServer: { register(route) { routes.push(route); return () => {} } },
    logger: { warn() {} },
  }
  const { apply } = await import('../lib/plugin.js')
  // Auto-resume must be OFF here: `apply` starts a background scan immediately, and with
  // the gate open that scan would perform its own resume and pollute both the prompt count
  // and the ledger. The manual route is gate-exempt, so it still works — which is exactly
  // what this test is about.
  const dispose = apply(ctx, { ...config, resume: { ...config.resume, enabled: false } })
  try {
    let captured = null
    await routes[0].handler(
      { method: 'POST', url: `/session-watch/api/resume?sessionId=${STALLED_ID}`, headers: { 'x-session-watch': '1' } },
      {
        headersSent: false,
        writeHead() { this.headersSent = true },
        end(payload) { captured = JSON.parse(payload) },
        destroy() {},
      },
    )
    assert.equal(captured?.ok, true, `the manual resume should succeed: ${JSON.stringify(captured)}`)
    assert.equal(prompts.length, 1, 'and send exactly one prompt (the manual one)')

    // The text written into the session must NOT claim to be automatic. It is permanent
    // content in someone's conversation, and misattributing it leaves their own log saying
    // the harness acted alone — exactly the uncertainty this project exists to remove.
    const sentText = String(prompts[0]?.content?.[0]?.text ?? '')
    assert.ok(sentText.length > 0, 'the manual route must send text')
    assert.ok(!sentText.includes('自动续跑'),
      `the manual nudge must not call itself automatic: ${sentText.split('\n')[0]}`)
    assert.ok(sentText.includes('你本人发起'),
      `and must say the user sent it: ${sentText.split('\n')[0]}`)

    const record = readLedger().sessions[STALLED_ID]
    assert.equal(record?.attempts, 1, 'the manual attempt must be recorded')
    assert.equal(record.history.at(-1).by, 'manual', 'and attributed to the manual route')
  } finally {
    if (typeof dispose === 'function') dispose()
  }
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
// `apply` starts a poll interval, and a live interval keeps the event loop alive even
// after every test has finished — the suite would hang instead of reporting. So the exit
// is explicit rather than implicit.
process.exit(failed > 0 ? 1 : 0)
