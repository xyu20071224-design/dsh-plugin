/**
 * Proves the expert's DIAGNOSTIC capability end to end, against real sessions.
 *
 * WHY THIS EXISTS
 *
 * Registering three tools proves the preset mounts. It does not prove the expert can do
 * the job the objective actually asks for: read a stopped session's conversation and say
 * why it stopped. Those are different claims, and this project has repeatedly been burned
 * by treating "the wiring is present" as "the capability works".
 *
 * So this drives the same tool functions an agent under the `user-proxy` preset would
 * call, over the REAL session corpus, and asserts the output contains the things a
 * diagnosis needs:
 *
 *   - `session_roster`: which sessions stopped, and why policy will or will not act;
 *   - `session_review`: the actual conversation plus the deterministic stop facts
 *     (open turn, retries, tool failures) — this is the root-cause material.
 *
 * READ-ONLY throughout: `session_resume` is deliberately never called, because posting a
 * resume writes into a session and cannot be undone.
 *
 * Run: node test/expert-diagnosis.test.mjs
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

console.log('\n=== expert-diagnosis.test.mjs ===')

// The expert half is built to run INSIDE a host, where `ctx.get('sessionController')` and
// friends resolve. For a read-only exercise outside a host, the services it needs to REACH
// are the registry (for the roster) and the log files (for the review).
const { defineProxyTools } = await import('../lib/proxy.js')
const { collectSessions } = await import('../lib/plugin.js')
const { publishSnapshot } = await import('../lib/shared.js')

/**
 * A context exposing only what the READ path uses.
 *
 * Deliberately omits `sessionController`: that is the write path, and this script must not
 * be able to reach it even by accident.
 * @param {object} snapshot - the snapshot the roster reads.
 * @returns {object} a minimal read-only context.
 */
function readOnlyContext(snapshot) {
  return {
    get(name) {
      if (name === 'agents') return { list: () => [] }
      return undefined
    },
    logger: { warn() {} },
    // The roster reads through the shared mailbox; publishing makes it consistent with
    // what the sidebar would see.
    __snapshot: snapshot,
  }
}

const config = {
  stallMs: 900_000,
  minAgeMs: 60_000,
  maxSessions: 400,
  resume: { enabled: true, maxAttempts: 2, baseDelayMs: 120_000, maxDelayMs: 1_800_000, cooldownMs: 300_000, promptTemplate: null },
}

const snapshot = await collectSessions(readOnlyContext(null), config)
publishSnapshot(snapshot)
const ctx = readOnlyContext(snapshot)
const tools = defineProxyTools(ctx, config, { snapshot: async () => snapshot })
const roster = tools.find(tool => tool.name === 'session_roster')
const review = tools.find(tool => tool.name === 'session_review')

await test('the expert is offered exactly the three documented tools', async () => {
  assert.deepEqual(
    tools.map(tool => tool.name).sort(),
    ['session_resume', 'session_review', 'session_roster'],
  )
  // Every one must be documented well enough for a model to choose correctly.
  for (const tool of tools) {
    assert.ok(tool.description.length > 40, `${tool.name} needs a real description`)
    assert.equal(tool.parameters.type, 'object')
  }
})

await test('session_roster describes the corpus with per-session decisions', async () => {
  const result = await roster.execute({ only: 'all' })
  // NOTE: the roster reports `scope`/`totals`/`rows` rather than an `ok` flag. That is
  // deliberate — a roster that returned `ok: false` would be indistinguishable from an
  // empty corpus, and the degraded path returns an explicit `ok: false` object instead.
  assert.equal(result.scope, 'entire host — every workspace',
    'the expert must be told this is NOT a workspace-scoped view')
  // Rows are CAPPED (default 40) because the corpus far exceeds any useful prompt. The
  // totals are what convey the full scale, so both are asserted: a capped list plus an
  // honest total is the contract.
  assert.ok(result.rows.length > 0, `expected rows, got ${result.rows.length}`)
  assert.ok(result.rows.length <= 40, `default cap should be 40, got ${result.rows.length}`)
  assert.ok(result.totals.scanned > result.rows.length,
    `totals must report the whole corpus (${result.totals.scanned}) beyond the capped rows`)
  for (const row of result.rows) {
    assert.ok(typeof row.sessionId === 'string')
    assert.ok(typeof row.verdict === 'string', 'every row must carry a verdict')
    assert.ok(typeof row.why === 'string', 'and a human-readable reason')
    // The layer 2 -> 3 handoff: the expert must be able to tell "stalled" from
    // "stalled AND policy will act on it".
    assert.ok(row.resumeDecision !== undefined, 'and the resume decision')
    assert.ok('nextStep' in row, 'and whether the Host already has a next step for it')
  }
  console.log(`        (${result.rows.length} rows shown of ${result.totals.scanned} scanned)`)
})

await test('session_roster honours an explicit limit, and caps it', async () => {
  // The expert may ask for more when the default is not enough, but the cap must hold so a
  // single call cannot flood its own context.
  const small = await roster.execute({ only: 'all', limit: 3 })
  assert.equal(small.rows.length, 3)
  const huge = await roster.execute({ only: 'all', limit: 5000 })
  assert.ok(huge.rows.length <= 200, `documented max is 200, got ${huge.rows.length}`)
  console.log(`        (limit=3 -> ${small.rows.length}; limit=5000 -> ${huge.rows.length})`)
})

await test('session_roster can narrow to just what needs attention', async () => {
  const result = await roster.execute({ only: 'stalled' })
  for (const row of result.rows) {
    assert.equal(row.verdict, 'stalled', 'the filter must actually filter')
  }
  console.log(`        (${result.rows.length} stalled)`)
})

await test('session_review returns the CONVERSATION, not just metadata', async () => {
  // The objective's core claim: given a stopped session, produce a root-cause diagnosis.
  // That needs the conversation, so an empty or metadata-only transcript is a failure even
  // though the call "succeeded".
  const target = snapshot.sessions.find(session => session.eventCount > 20) ?? snapshot.sessions[0]
  assert.ok(target, 'need at least one session with events')
  const result = await review.execute({ session_id: target.sessionId })
  assert.equal(result.ok, true, `review failed: ${result.error ?? ''}`)
  assert.ok(Array.isArray(result.transcript), 'transcript must be a list')
  assert.ok(result.transcript.length > 0, 'and must not be empty for a session with events')
  // Entries carry `role` and `type` (not `kind`): enough for a model to tell a user message
  // from an assistant reply from a tool call.
  const roles = new Set(result.transcript.map(entry => entry.role ?? entry.type))
  assert.ok(roles.size > 1, `expected several entry roles, got ${[...roles].join(',')}`)
  assert.ok(result.transcriptTotal >= result.transcript.length, 'and a total for context')
  console.log(`        (${target.sessionId.slice(0, 24)}: ${result.transcript.length}/${result.transcriptTotal} entries, `
    + `roles=${[...roles].join('/')})`)
})

await test('session_review supplies the MATERIAL a diagnosis needs', async () => {
  // "Root cause" is not a feeling: the deterministic layer already extracted the facts that
  // explain a stop. If these are missing, the expert can only speculate.
  const target = snapshot.sessions.find(session => session.eventCount > 20) ?? snapshot.sessions[0]
  const result = await review.execute({ session_id: target.sessionId })
  const stop = result.stop
  assert.ok('openTurn' in stop, 'whether a turn was left open')
  assert.ok('retries' in stop, 'how many retries happened')
  assert.ok('toolFailures' in stop, 'which tools failed')
  assert.ok('endKind' in stop, 'and how the log ends')
  // The verdict travels with the conversation, so the expert does not have to re-derive it.
  assert.ok(typeof result.verdict === 'string' && result.verdict.length > 0)
  assert.ok(typeof result.verdictWhy === 'string' && result.verdictWhy.length > 0)
  assert.equal(typeof result.autoResumable, 'boolean')
  console.log(`        stop: openTurn=${JSON.stringify(stop.openTurn)} retries=${stop.retries} `
    + `toolFailures=${Array.isArray(stop.toolFailures) ? stop.toolFailures.length : stop.toolFailures} verdict=${result.verdict}`)
})

await test('session_review FAILS CLEANLY on an unknown session', async () => {
  // The expert will guess ids. A throw would abort its whole turn and lose the diagnosis
  // it had already formed for other sessions.
  const result = await review.execute({ session_id: 'session-does-not-exist-0000' })
  assert.equal(result.ok, false)
  assert.ok(typeof result.error === 'string' && result.error.length > 0, 'and must say why')
})

await test('the write tool exists but is never invoked here', async () => {
  // A guard on this script itself: the diagnostic proof above must stay read-only, because
  // a resume writes into a session and cannot be undone.
  const resume = tools.find(tool => tool.name === 'session_resume')
  assert.ok(resume, 'the write tool should still be registered for real use')
  assert.ok(/force/i.test(JSON.stringify(resume.parameters)),
    'and must document the override it honours, so the expert knows it exists')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
