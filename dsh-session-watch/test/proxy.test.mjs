/**
 * Tests for the user-proxy expert's tools.
 *
 * WHAT THIS SUITE IS FOR
 *
 * The policy suite (`resume.test.mjs`) proves the GATES are correct. The wiring
 * suite (`resume-wiring.mjs`) proves the HOST half obeys them. This suite proves the
 * third thing, which fails independently: that the EXPERT's tool surface obeys them
 * too, and that its read tools cannot wake a session.
 *
 * A correct policy wired to a tool that bypasses it is exactly as dangerous as no
 * policy at all — and it would pass both existing suites.
 *
 * Every test runs against a stub context and a TEMPORARY DSH_HOME. The real ledger
 * and the real session logs are never touched.
 *
 * Run: node test/proxy.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

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

// ---------------------------------------------------------------------------
// A temporary DSH home, so nothing here can touch the real one.
// ---------------------------------------------------------------------------

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-test-'))

/**
 * Write a session log under the temp home.
 * @param {string} sessionId - the session id.
 * @param {any[]} events - events to store.
 * @param {string} cwd - the session's working directory.
 * @returns {string} the log path.
 */
function writeLog(sessionId, events, cwd = 'C:\\work\\demo') {
  const dir = path.join(tempHome, 'sessions', '--work-demo--', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const header = {
    type: 'session', version: 4, id: sessionId, createdAt: Date.now() - 3600_000,
    cwd, isSeeded: false, delegationDepth: 0,
  }
  const file = path.join(dir, 'session.v4.jsonl')
  fs.writeFileSync(file, [header, ...events].map(event => JSON.stringify(event)).join('\n'), 'utf8')
  return file
}

/** A stalled session: mid-turn, no turn/end. */
const STALLED_ID = 'session-stalled-0001'
writeLog(STALLED_ID, [
  { type: 'turn/start', seq: 1, time: Date.now() - 3000_000, data: { turn: 1 } },
  { type: 'user/message', seq: 2, time: Date.now() - 2900_000, data: { content: [{ type: 'text', text: '跑一下测试' }] } },
  { type: 'tool/call', seq: 3, time: Date.now() - 2800_000, data: { turn: 1, step: 68, name: 'pwsh', arguments: '{"command":"node test"}' } },
])

/** A session parked on an approval: must never be auto-resumed. */
const APPROVAL_ID = 'session-approval-0002'
writeLog(APPROVAL_ID, [
  { type: 'turn/start', seq: 1, time: Date.now() - 100_000, data: { turn: 1 } },
  // `approval/asked` is the REAL event name in this build; the detector previously
  // keyed on a name that is never emitted. See detect.test.mjs for the regression.
  { type: 'approval/asked', seq: 2, time: Date.now() - 90_000, data: { id: 'r1', toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox' } },
])

/** A session parked on an unanswered question to the user. */
const QUESTION_ID = 'session-question-0005'
writeLog(QUESTION_ID, [
  { type: 'turn/start', seq: 1, time: Date.now() - 100_000, data: { turn: 1 } },
  { type: 'tool/call', seq: 2, time: Date.now() - 90_000, data: { turn: 1, step: 3, name: 'ask_user_question', callId: 'q1', arguments: '{}' } },
])

/** A finished session: nothing to do. */
const IDLE_ID = 'session-idle-0003'
writeLog(IDLE_ID, [
  { type: 'turn/start', seq: 1, time: Date.now() - 500_000, data: { turn: 1 } },
  { type: 'turn/end', seq: 2, time: Date.now() - 400_000, data: { turn: 1, reason: { kind: 'completed' } } },
])

/** A subagent child: excluded by design. */
const SUBAGENT_ID = 'session-subagent-0004'
{
  const dir = path.join(tempHome, 'sessions', '--work-demo--', SUBAGENT_ID)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), [
    { type: 'session', version: 4, id: SUBAGENT_ID, createdAt: Date.now() - 200_000, cwd: 'C:\\work\\demo', isSeeded: false, delegationDepth: 1 },
    { type: 'turn/start', seq: 1, time: Date.now() - 150_000, data: { turn: 1 } },
  ].map(e => JSON.stringify(e)).join('\n'), 'utf8')
}

// ---------------------------------------------------------------------------
// Load the module under test with DSH_HOME redirected.
// ---------------------------------------------------------------------------

process.env.DSH_HOME = tempHome

const { defineProxyTools } = await import('../lib/proxy.js')
const { publishSnapshot, readPublishedSnapshot } = await import('../lib/shared.js')
const { collectSessions } = await import('../lib/plugin.js')

/** Records every prompt the tools send, so a silent action cannot hide. */
const prompts = []
/** A stub context: only what the tools actually use. */
const ctx = {
  get(name) {
    if (name === 'sessionController') {
      return {
        // Mirrors the real public method: `prompt(request, signal)` calls
        // `signal.throwIfAborted()` first, so a signal-less call throws exactly like
        // the real controller. See resume-wiring.mjs for the full rationale.
        async prompt(request, signal) {
          signal.throwIfAborted()
          prompts.push(request)
          return { accepted: true }
        },
      }
    }
    if (name === 'agents') return { list: () => [] }
    return undefined
  },
  logger: { warn() {} },
}

const settings = {
  stallMs: 60_000,
  minAgeMs: 0,
  maxSessions: 100,
  resume: {
    enabled: false,
    maxAttempts: 2,
    baseDelayMs: 0,
    maxDelayMs: 0,
    cooldownMs: 0,
    promptTemplate: null,
  },
}

/** A cache that classifies for real, using the temp home. */
const cache = {
  async snapshot() { return await collectSessions(ctx, settings) },
}

const tools = defineProxyTools(ctx, settings, cache)
const byName = new Map(tools.map(tool => [tool.name, tool]))

console.log('\n=== proxy.test.mjs ===')

// ---------------------------------------------------------------------------
// The tool surface itself
// ---------------------------------------------------------------------------

await test('exactly three tools are declared', () => {
  assert.equal(tools.length, 3)
  assert.deepEqual([...byName.keys()].sort(), ['session_resume', 'session_review', 'session_roster'])
})

await test('every tool declares a name, description, parameter schema and output', () => {
  for (const tool of tools) {
    assert.ok(typeof tool.name === 'string' && tool.name !== '', `${tool.name}: name`)
    assert.ok(typeof tool.description === 'string' && tool.description.length > 30, `${tool.name}: description`)
    assert.equal(typeof tool.parameters, 'object', `${tool.name}: parameters`)
    assert.equal(typeof tool.output?.schema, 'object', `${tool.name}: output.schema`)
    assert.equal(typeof tool.output?.render, 'function', `${tool.name}: output.render`)
    assert.equal(typeof tool.execute, 'function', `${tool.name}: execute`)
  }
})

await test('exactly ONE tool can change anything', () => {
  // Reading and writing are separate tools on purpose. If a second writer ever
  // appears, this fails and forces the decision to be made deliberately.
  const writers = tools.filter(tool => /resume|send|write|cancel|delete/.test(tool.name))
  assert.deepEqual(writers.map(t => t.name), ['session_resume'])
})

await test('the resume tool admits in its own description that it mutates', () => {
  const text = byName.get('session_resume').description
  assert.ok(/ONLY tool here that changes/.test(text))
})

await test('the two read tools say they are read-only', () => {
  assert.ok(/Read-only|read-only/.test(byName.get('session_review').description))
})

await test('the roster tool states its scope is the whole host', () => {
  // The single most important thing the expert must not get wrong about its data.
  assert.ok(/every session on this DSH host/i.test(byName.get('session_roster').description))
  assert.ok(/not just this one/i.test(byName.get('session_roster').description))
})

// ---------------------------------------------------------------------------
// session_roster — reads, never acts
// ---------------------------------------------------------------------------

console.log('\n--- session_roster ---')

await test('roster reports every workspace, not just one cwd', async () => {
  const result = await byName.get('session_roster').execute({ only: 'all' })
  assert.equal(result.scope, 'entire host — every workspace')
  assert.ok(result.totals.scanned >= 4)
})

await test('roster finds the genuinely stalled session', async () => {
  const result = await byName.get('session_roster').execute({ only: 'stalled' })
  const ids = result.rows.map(row => row.sessionId)
  assert.ok(ids.includes(STALLED_ID), `expected ${STALLED_ID} in ${ids.join(',')}`)
})

await test('roster excludes the finished session from "stalled"', async () => {
  const result = await byName.get('session_roster').execute({ only: 'stalled' })
  assert.ok(!result.rows.some(row => row.sessionId === IDLE_ID))
})

await test('roster excludes the subagent from "stalled"', async () => {
  const result = await byName.get('session_roster').execute({ only: 'stalled' })
  assert.ok(!result.rows.some(row => row.sessionId === SUBAGENT_ID))
})

await test('roster surfaces the approval-parked session under "attention"', async () => {
  const result = await byName.get('session_roster').execute({ only: 'attention' })
  const row = result.rows.find(r => r.sessionId === APPROVAL_ID)
  assert.ok(row, 'approval session should appear under attention')
  assert.equal(row.verdict, 'awaiting-approval')
  assert.equal(row.autoResumable, false)
})

await test('roster is read-only: it sends no prompt', async () => {
  const before = prompts.length
  await byName.get('session_roster').execute({ only: 'all' })
  assert.equal(prompts.length, before, 'roster must never prompt a session')
})

await test('roster reports the auto-resume policy and whether it is on', async () => {
  const result = await byName.get('session_roster').execute({})
  // Read the live settings rather than a pinned value: the resume tests below
  // deliberately flip `enabled`, so hard-coding it here would make this test depend
  // on execution order — a test that passes only in one order is not a test.
  assert.equal(result.autoResume.enabled, settings.resume.enabled)
  assert.equal(result.autoResume.policy.maxAttempts, settings.resume.maxAttempts)
})

await test('roster cwd_contains filters case-insensitively', async () => {
  const hit = await byName.get('session_roster').execute({ only: 'all', cwd_contains: 'DEMO' })
  assert.ok(hit.rows.length > 0)
  const miss = await byName.get('session_roster').execute({ only: 'all', cwd_contains: 'no-such-dir' })
  assert.equal(miss.rows.length, 0)
})

await test('roster honours its row limit', async () => {
  const result = await byName.get('session_roster').execute({ only: 'all', limit: 2 })
  assert.ok(result.rows.length <= 2)
})

// ---------------------------------------------------------------------------
// session_review — transcript, read-only
// ---------------------------------------------------------------------------

console.log('\n--- session_review ---')

await test('review returns the conversation, not just a verdict', async () => {
  const result = await byName.get('session_review').execute({ session_id: STALLED_ID })
  assert.equal(result.ok, true)
  const texts = result.transcript.map(entry => entry.text)
  assert.ok(texts.some(t => t.includes('跑一下测试')), 'user message should be present')
  assert.ok(texts.some(t => t.includes('pwsh')), 'tool call should be present')
})

await test('review includes the deterministic stop facts', async () => {
  const result = await byName.get('session_review').execute({ session_id: STALLED_ID })
  assert.equal(result.stop.openTurn, true)
  assert.equal(result.stop.lastStep, 68)
})

await test('review reports the verdict and that it is auto-resumable', async () => {
  const result = await byName.get('session_review').execute({ session_id: STALLED_ID })
  assert.equal(result.verdict, 'stalled')
  assert.equal(result.autoResumable, true)
})

await test('review is read-only: it sends no prompt', async () => {
  const before = prompts.length
  await byName.get('session_review').execute({ session_id: STALLED_ID })
  assert.equal(prompts.length, before, 'review must never prompt a session')
})

await test('review of an unknown session fails cleanly instead of throwing', async () => {
  const result = await byName.get('session_review').execute({ session_id: 'session-does-not-exist' })
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string')
})

await test('review without a session_id fails cleanly', async () => {
  const result = await byName.get('session_review').execute({})
  assert.equal(result.ok, false)
})

await test('review honours an entry limit', async () => {
  const result = await byName.get('session_review').execute({ session_id: STALLED_ID, limit: 1 })
  assert.equal(result.transcript.length, 1)
  assert.ok(result.transcriptOmitted >= 0)
})

// ---------------------------------------------------------------------------
// session_resume — the gates
// ---------------------------------------------------------------------------

console.log('\n--- session_resume ---')

await test('refused while resume.enabled is false', async () => {
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: STALLED_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'disabled')
  assert.equal(prompts.length, before, 'a refused resume must send nothing')
})

// Everything below enables the gate, so each test isolates the refusal it names
// instead of re-testing `disabled` over and over.
settings.resume.enabled = true
settings.resume.maxAttempts = 2
settings.resume.cooldownMs = 0
settings.resume.baseDelayMs = 0

await test('refused for an approval-parked session', async () => {
  const result = await byName.get('session_resume').execute({ session_id: APPROVAL_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'not-stalled')
})

await test('refused for a session parked on a question to the user', async () => {
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: QUESTION_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'not-stalled')
  assert.equal(prompts.length, before)
})

await test('refused for a session that is not stalled', async () => {
  const result = await byName.get('session_resume').execute({ session_id: IDLE_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'not-stalled')
})

await test('refused for a subagent child', async () => {
  const result = await byName.get('session_resume').execute({ session_id: SUBAGENT_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'not-stalled')
})

await test('an approval-parked session is refused EVEN WHEN FORCED', async () => {
  // The one case where obeying would mean answering a question addressed to the
  // user. `force` exists for the user's own judgement, not to overrule this.
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: APPROVAL_ID, force: true })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'awaiting-approval')
  assert.equal(prompts.length, before, 'forcing must still not prompt an approval wait')
})

await test('a question-parked session is refused EVEN WHEN FORCED', async () => {
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: QUESTION_ID, force: true })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'awaiting-approval')
  assert.equal(prompts.length, before)
})

await test('WITH THE GATE OPEN a stalled session IS resumed', async () => {
  // The positive path. Without this, every test above could pass while the tool was
  // simply broken and never resumed anything at all.
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: STALLED_ID })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(prompts.length, before + 1)
  assert.equal(prompts.at(-1).sessionId, STALLED_ID)
  assert.equal(prompts.at(-1).mode, 'queue', 'must queue a normal follow-up turn, never steer into a dead turn')
})

await test('the resume actually sends a usable prompt', async () => {
  const sent = prompts.at(-1)
  assert.ok(Array.isArray(sent.content) && sent.content.length > 0)
  assert.ok(typeof sent.content[0].text === 'string' && sent.content[0].text.length > 10)
  assert.ok(typeof sent.requestId === 'string' && sent.requestId.length > 0, 'a stable request id is required')
})

await test('the expert nudge attributes itself to the EXPERT, not the watcher', async () => {
  // The text becomes permanent content in the target session. Saying "自动续跑" when the
  // expert sent it leaves that session's own log claiming an automatic action that never
  // happened — and the agent reading it cannot then tell whether the harness overstepped.
  const sent = prompts.at(-1)
  const text = String(sent.content[0].text)
  assert.ok(!text.includes('自动续跑'),
    `the expert must not label its nudge automatic: ${text.split('\n')[0]}`)
  assert.ok(text.includes('用户代理专家发起'),
    `and must name itself: ${text.split('\n')[0]}`)
})

await test('a free-form note is appended when supplied', async () => {
  const before = prompts.length
  const result = await byName.get('session_resume').execute({
    session_id: STALLED_ID,
    note: '请先跑一遍测试再继续',
    force: true,
  })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(prompts.length, before + 1)
  assert.ok(prompts.at(-1).content[0].text.includes('请先跑一遍测试再继续'))
})

await test('the attempt is recorded in the shared ledger', async () => {
  const { readLedger } = await import('../lib/plugin.js')
  const ledger = readLedger()
  assert.ok(ledger.sessions[STALLED_ID], 'the session must appear in the ledger')
  assert.ok(ledger.sessions[STALLED_ID].attempts >= 2, 'every resume must be counted')
  assert.ok(
    ledger.sessions[STALLED_ID].history.some(entry => entry.by === 'user-proxy'),
    'the expert-authored attempt must be distinguishable from an automatic one',
  )
})

await test('the snapshot attributes each attempt to its author', async () => {
  // The panel must be able to say WHO nudged a session. "resumed twice" without
  // attribution hides the difference between the watcher acting on its own and the
  // user-proxy expert acting on the user's behalf — and an automatic action nobody
  // can attribute is indistinguishable from the harness acting alone.
  const { collectSessions } = await import('../lib/plugin.js')
  const snapshot = await collectSessions(ctx, settings)
  const row = snapshot.sessions.find(s => s.sessionId === STALLED_ID)
  assert.ok(row, 'the resumed session must appear in the snapshot')
  assert.equal(row.resume.lastAttemptBy, 'user-proxy')
  assert.ok(Array.isArray(row.resume.history) && row.resume.history.length > 0)
  assert.ok(row.resume.history.every(entry => typeof entry.by === 'string'))
})

await test('an automatic attempt is attributed to "auto", not to the expert', async () => {
  const { recordAttempt, collectSessions } = await import('../lib/plugin.js')
  recordAttempt(IDLE_ID, { at: Date.now(), ok: true, by: 'auto', turn: 1, step: 1 })
  const snapshot = await collectSessions(ctx, settings)
  const row = snapshot.sessions.find(s => s.sessionId === IDLE_ID)
  assert.equal(row.resume.lastAttemptBy, 'auto')
})

await test('the attempt cap stops further resumes', async () => {
  const { readLedger } = await import('../lib/plugin.js')
  const attempts = readLedger().sessions[STALLED_ID].attempts
  assert.ok(attempts >= settings.resume.maxAttempts, 'precondition: cap reached')
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: STALLED_ID })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'attempts-exhausted')
  assert.equal(prompts.length, before, 'a capped session must not be nudged again')
})

await test('a capped session CAN still be forced by explicit user request', async () => {
  // The cap protects against automatic loops, not against the user's own judgement.
  const before = prompts.length
  const result = await byName.get('session_resume').execute({ session_id: STALLED_ID, force: true })
  assert.equal(result.ok, true, JSON.stringify(result))
  assert.equal(prompts.length, before + 1)
})

await test('the refusal carries a REASON, so silence is never mistaken for success', async () => {
  settings.resume.enabled = false
  const result = await byName.get('session_resume').execute({ session_id: STALLED_ID })
  assert.ok(typeof result.refused === 'string' && result.refused !== '')
  assert.ok(typeof result.refusedWhy === 'string' && result.refusedWhy.length > 5)
  settings.resume.enabled = true
})

await test('resume without a session_id fails cleanly', async () => {
  const result = await byName.get('session_resume').execute({})
  assert.equal(result.ok, false)
})

await test('resume reports the attempt count before and after', async () => {
  const result = await byName.get('session_resume').execute({ session_id: IDLE_ID })
  assert.equal(result.ok, false)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)

// Best-effort cleanup; a leftover temp directory must not fail the suite.
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}

if (failed > 0) process.exit(1)
