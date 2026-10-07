/**
 * Proves the config divergence between the two halves, and that the fix closes it.
 *
 * THE BUG
 *
 * The Host row and the expert row get their settings from DIFFERENT places:
 *
 *   - The Host row is a patch row in `~/.dsh/cordis.patch.yml`, which carries
 *     `config: { stallMs: 900000, resume: {...} }`.
 *   - The expert row lives inside the `user-proxy` PRESET, and that row declares no
 *     `config` at all.
 *
 * So `apply(ctx, undefined)` runs for the expert, and it falls back to its own
 * hard-coded defaults — `stallMs: 300000`, `resume.enabled: false`. The two halves then
 * disagree about the policy they are enforcing:
 *
 *   - the expert calls a session stalled after 5 minutes, the Host after 15;
 *   - the expert refuses every manual resume with `disabled` even after the user has
 *     turned Host resume ON, because it never sees that flag.
 *
 * That second one is the dangerous kind of wrong: the user enables resume, the panel
 * says enabled, and the expert still refuses — with a reason (`disabled`) that is
 * technically true of the expert's own stale copy and misleading about the deployment.
 *
 * THE FIX
 *
 * The expert reads the Host's EFFECTIVE settings from the shared snapshot rather than
 * trusting its own defaults. The Host is the single source of truth for policy, exactly
 * as it already is for verdicts.
 *
 * Run: node test/config-divergence.test.mjs
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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'config-divergence-'))
process.env.DSH_HOME = tempHome

const { defineProxyTools } = await import('../lib/proxy.js')

/** A snapshot shaped exactly like the Host's, with resume ON and the 15-minute stall. */
const HOST_SNAPSHOT = {
  ok: true,
  generatedAt: Date.now(),
  home: tempHome,
  stallMs: 900000,
  minAgeMs: 60000,
  resumeEnabled: true,
  resumePolicy: { maxAttempts: 5, baseDelayMs: 111, maxDelayMs: 222, cooldownMs: 333 },
  resumed: [],
  totals: { scanned: 0, stalled: 0, awaitingApproval: 0, empty: 0, subagent: 0, resumed: 0, resumeFailed: 0 },
  attention: [],
  sessions: [],
}

/** A stalled session on disk, so classification has something real to read. */
{
  const dir = path.join(tempHome, 'sessions', '--probe--', 'session-divergence-0001')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl'), [
    { type: 'session', version: 4, id: 'session-divergence-0001', createdAt: Date.now() - 3600_000, cwd: 'C:\\probe', isSeeded: false, delegationDepth: 0 },
    { type: 'turn/start', seq: 1, time: Date.now() - 3000_000, data: { turn: 1 } },
    { type: 'tool/call', seq: 2, time: Date.now() - 2900_000, data: { turn: 1, step: 5, name: 'pwsh', callId: 'c1', arguments: '{}' } },
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

/** What the preset row actually supplies: NOTHING. */
const NO_CONFIG = undefined

console.log('\n=== config-divergence.test.mjs ===')

await test('the expert half WITHOUT host settings falls back to its own defaults', async () => {
  // Documents the bug's mechanism, so the fix below is recognisably the difference.
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000,
    minAgeMs: 60_000,
    maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => HOST_SNAPSHOT })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({})
  // The expert reports the HOST's policy (it reads the snapshot)...
  assert.equal(result.autoResume.enabled, HOST_SNAPSHOT.resumeEnabled)
  // ...which is exactly why reading the snapshot is the right fix: the expert's own
  // defaults would have said `false` here.
  assert.equal(result.autoResume.policy.maxAttempts, HOST_SNAPSHOT.resumePolicy.maxAttempts)
})

await test('the expert derives its resume gate from the HOST snapshot', async () => {
  // The fix: the gate must use the deployment's policy, not the row's absent config.
  const tools = defineProxyTools(ctx, {
    // Deliberately stale, self-only defaults, as the preset row produces.
    stallMs: 5 * 60 * 1000,
    minAgeMs: 60_000,
    maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => HOST_SNAPSHOT })
  const resume = tools.find(tool => tool.name === 'session_resume')
  const before = prompts.length
  const result = await resume.execute({ session_id: 'session-divergence-0001' })
  assert.equal(result.ok, true, `expected the host-enabled policy to permit this resume: ${JSON.stringify(result)}`)
  assert.equal(prompts.length, before + 1, 'the resume should have been sent')
})

await test('the attempt cap comes from the host policy, not the expert default', async () => {
  const { recordAttempt } = await import('../lib/ledger.js')
  // Spend the HOST's allowance (5), which exceeds the expert's own default (2).
  for (let i = 0; i < 5; i += 1) {
    recordAttempt('session-divergence-0001', { at: Date.now(), ok: true, by: 'auto' })
  }
  const tools = defineProxyTools(ctx, NO_CONFIG === undefined ? {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  } : NO_CONFIG, { snapshot: async () => HOST_SNAPSHOT })
  const resume = tools.find(tool => tool.name === 'session_resume')
  const result = await resume.execute({ session_id: 'session-divergence-0001' })
  assert.equal(result.ok, false)
  assert.equal(result.refused, 'attempts-exhausted',
    `expected the HOST cap (5) to be the binding one, got ${result.refused}`)
})

await test('the expert reports the host stall window, not its own', async () => {
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => HOST_SNAPSHOT })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({})
  assert.equal(result.stallMs, 900000, 'the roster must report the deployment stall window')
})

await test('with NO snapshot at all, the expert still refuses rather than guessing', async () => {
  // Degrade safe: absent policy means "do not resume", never "use a lenient default".
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => { throw new Error('host unavailable') } })
  const resume = tools.find(tool => tool.name === 'session_resume')
  const before = prompts.length
  const result = await resume.execute({ session_id: 'session-divergence-0001' })
  assert.equal(result.ok, false)
  assert.equal(prompts.length, before, 'a missing policy must never produce a prompt')
})

await test('session_roster DEGRADES instead of throwing when the host is unreachable', async () => {
  // A tool must never throw at the model. A thrown error becomes an opaque failure the
  // expert cannot reason about, and for the tool it calls FIRST that means the expert
  // is left with nothing and no way to tell "host is down" from "nothing to report".
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => { throw new Error('host unreachable') } })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({})
  assert.equal(result.ok, false, 'a failed read must be reported as a failure')
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'it must say what went wrong')
  assert.ok(typeof result.hint === 'string', 'it must say what to do next')
  // The critical distinction: "I could not read" is NOT "there are no problems".
  assert.deepEqual(result.rows, [], 'no rows may be invented')
  assert.equal(result.totals, null, 'no totals may be invented')
  assert.ok(/不要把空结果当成一切正常/.test(result.hint), 'the hint must warn against reading empty as healthy')
})

await test('the failure of one tool does not disable the others', async () => {
  // `session_review` reads logs directly and does not need the host snapshot, so it
  // must keep working while the roster is degraded. Losing the whole expert because one
  // data source is down would be a worse outcome than losing one tool.
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => { throw new Error('host unreachable') } })
  const review = tools.find(tool => tool.name === 'session_review')
  const result = await review.execute({ session_id: 'session-divergence-0001' })
  assert.equal(result.ok, true, `review should still read the log: ${JSON.stringify(result)}`)
  assert.ok(Array.isArray(result.transcript), 'and still return a transcript')
})

await test('the expert reports WHY it is degraded, not just that it is', async () => {
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => { throw new Error('host unreachable') } })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({})
  // The underlying reason must survive to the model, or the expert cannot tell the user
  // whether the host is restarting, the plugin is broken, or something else happened.
  assert.ok(/host unreachable/.test(String(result.detail)), `detail should carry the cause: ${result.detail}`)
})

await test('the roster exposes the PER-SESSION auto-resume decision (layer 2 -> layer 3)', async () => {
  // Objective requirement: a stalled session is diagnosed by the expert, then the POLICY
  // decides whether to resume — and the whole chain must be visible. For the expert to
  // explain "why was this not resumed", the Host's per-session decision has to reach it.
  // A roster that showed only verdicts would leave the expert guessing at policy.
  const snapshot = {
    ...HOST_SNAPSHOT,
    resumeEnabled: false,
    sessions: [{
      sessionId: 'session-divergence-0001',
      cwd: 'C:\\probe',
      verdict: 'stalled',
      detail: '轮次中途停止',
      turn: 1,
      step: 5,
      lastType: 'tool/call',
      silentMs: 3_000_000,
      running: false,
      isSubagent: false,
      autoResumable: true,
      eventCount: 2,
      resume: {
        willResume: false,
        reason: 'disabled',
        detail: '自动恢复未启用（resume.enabled=false）；仅报告。',
        attempts: 0,
        lastAttemptAt: null,
        nextDelayMs: 0,
        lastAttemptBy: null,
      },
    }],
    attention: [],
  }
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: false, maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000, promptTemplate: null },
  }, { snapshot: async () => snapshot })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({ only: 'all' })
  const row = result.rows.find(entry => entry.sessionId === 'session-divergence-0001')
  assert.ok(row, 'the session should be listed')
  assert.ok(row.resumeDecision, 'the per-session resume decision must reach the expert')
  assert.equal(row.resumeDecision.reason, 'disabled', 'and carry the refusal reason')
  assert.equal(row.resumeDecision.willResume, false)
  assert.ok(typeof row.resumeDecision.detail === 'string' && row.resumeDecision.detail.length > 0,
    'and a human-readable explanation of the refusal')
})

await test('the roster distinguishes "stalled" from "will actually be resumed"', async () => {
  // These are different facts and the expert must not conflate them: a session can be
  // stalled while policy refuses to touch it, and reporting it as "will be resumed"
  // would promise an action that never happens.
  const base = {
    sessionId: 'session-x', cwd: 'C:\\probe', verdict: 'stalled', detail: 'stopped',
    turn: 1, step: 1, lastType: 'tool/call', silentMs: 1000, running: false,
    isSubagent: false, autoResumable: true, eventCount: 2,
  }
  const snapshot = {
    ...HOST_SNAPSHOT,
    sessions: [
      { ...base, sessionId: 'session-will', resume: { willResume: true, reason: 'resumed', detail: 'ok', attempts: 0, lastAttemptBy: null } },
      { ...base, sessionId: 'session-wont', resume: { willResume: false, reason: 'attempts-exhausted', detail: 'capped', attempts: 2, lastAttemptBy: 'auto' } },
    ],
    attention: [],
  }
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, promptTemplate: null },
  }, { snapshot: async () => snapshot })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({ only: 'all' })
  const will = result.rows.find(entry => entry.sessionId === 'session-will')
  const wont = result.rows.find(entry => entry.sessionId === 'session-wont')
  assert.equal(will.autoResumable && will.resumeDecision.willResume, true)
  assert.equal(wont.verdict, 'stalled', 'still stalled...')
  assert.equal(wont.resumeDecision.willResume, false, '...but policy will not touch it')
  assert.equal(wont.resumeDecision.reason, 'attempts-exhausted')
})

await test('the roster hands the expert the Host\'s next-step advice', async () => {
  // The Host already computed what to do next once policy stopped. The expert IS that next
  // step, so withholding it makes the expert re-derive the same conclusion — and, worse,
  // leaves it unable to tell a session that has awaited a human for hours from one that
  // just stopped.
  const snapshot = {
    ...HOST_SNAPSHOT,
    sessions: [{
      sessionId: 'session-next', cwd: 'C:\\probe', verdict: 'stalled', detail: 'stopped',
      turn: 1, step: 1, lastType: 'tool/call', silentMs: 1000, running: false,
      isSubagent: false, autoResumable: true, eventCount: 2,
      resume: { willResume: false, reason: 'attempts-exhausted', detail: 'capped', attempts: 2, lastAttemptBy: 'auto', lastAttemptOk: false },
      handoff: { kind: 'attempts-exhausted', text: '已用满自动恢复次数。建议用专家读它的输入输出找根因。' },
    }],
    attention: [],
  }
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, promptTemplate: null },
  }, { snapshot: async () => snapshot })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({ only: 'all' })
  const row = result.rows.find(entry => entry.sessionId === 'session-next')
  assert.equal(row.nextStep, '已用满自动恢复次数。建议用专家读它的输入输出找根因。')
  // And the attribution, so the expert can tell a session the watcher already nudged
  // from one nobody has touched.
  assert.equal(row.lastAttemptBy, 'auto')
  assert.equal(row.lastAttemptOk, false)
})

await test('a session with no advice reports nextStep as null, not a placeholder', async () => {
  // A fabricated "next step" would be worse than none: the expert would act on advice
  // nobody gave.
  const snapshot = {
    ...HOST_SNAPSHOT,
    sessions: [{
      sessionId: 'session-plain', cwd: 'C:\\probe', verdict: 'stalled', detail: 'stopped',
      turn: 1, step: 1, lastType: 'tool/call', silentMs: 1000, running: false,
      isSubagent: false, autoResumable: true, eventCount: 2,
      resume: { willResume: true, reason: 'resumed', detail: 'ok', attempts: 0, lastAttemptBy: null },
    }],
    attention: [],
  }
  const tools = defineProxyTools(ctx, {
    stallMs: 5 * 60 * 1000, minAgeMs: 60_000, maxSessions: 400,
    resume: { enabled: true, maxAttempts: 2, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0, promptTemplate: null },
  }, { snapshot: async () => snapshot })
  const roster = tools.find(tool => tool.name === 'session_roster')
  const result = await roster.execute({ only: 'all' })
  assert.equal(result.rows[0].nextStep, null)
  assert.equal(result.rows[0].lastAttemptBy, null)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}
if (failed > 0) process.exit(1)
