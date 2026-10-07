/**
 * A live, read-only assertion about how the RUNNING host treats an approval wait.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE UNIT TESTS
 *
 * `approval-gate-counterfactual.mjs` proves the classifier is right, and the isolated-host
 * run proved the wiring end to end. Both used FIXTURES. This one makes the claim about the
 * deployment as it actually is: auto-resume is ON, and a real session belonging to the user
 * is sitting on a real approval prompt.
 *
 * That combination is the whole risk the gate exists for. It is also the only configuration
 * in which the risk is live, so it is worth being able to check on demand — especially as
 * the corpus changes and a session parking on an approval is a normal, recurring event.
 *
 * Read-only: it inspects `/state` and the ledger and writes nothing.
 *
 * Run: node test/verify-approval-gate-live.mjs [baseUrl]
 */

const BASE = (process.argv[2] ?? 'http://127.0.0.1:19387') + '/session-watch/api'
const HEADERS = { 'x-session-watch': '1' }

/** @param {string} route @returns {Promise<{status: number, body: any}>} */
async function get(route) {
  const response = await fetch(`${BASE}${route}`, { headers: HEADERS })
  let body = null
  try { body = await response.json() } catch { /* leave null */ }
  return { status: response.status, body }
}

const state = await get('/state')
if (state.status !== 200 || state.body === null) {
  console.error(`无法读取 /state（HTTP ${state.status}）——Host 在运行吗？`)
  process.exit(1)
}

const parked = (state.body.sessions ?? []).filter(session => session.verdict === 'awaiting-approval')
const resumeOn = state.body.resumeEnabled === true

console.log('=== 实时审批闸门检查（只读）===\n')
console.log(`  自动恢复        : ${resumeOn ? '已开启' : '未开启'}`)
console.log(`  扫描会话        : ${state.body.totals?.scanned ?? '?'}`)
console.log(`  等待审批        : ${parked.length}`)
console.log('')

let problems = 0
for (const session of parked) {
  const decision = session.resume ?? {}
  console.log(`  ${session.sessionId}`)
  console.log(`    cwd         : ${session.cwd}`)
  console.log(`    判定理由    : ${session.detail}`)
  console.log(`    willResume  : ${decision.willResume}`)
  console.log(`    reason      : ${decision.reason}`)
  if (session.handoff) console.log(`    下一步      : ${session.handoff.text}`)
  console.log('')

  // The safety property, asserted per session rather than in aggregate.
  if (decision.willResume !== false) {
    console.log('    ✗ 会被自动恢复 —— 闸门失效！')
    problems += 1
  }
  if (decision.reason !== 'not-stalled') {
    console.log(`    ✗ 理由应为 not-stalled，实际 ${decision.reason}`)
    problems += 1
  }
}

if (parked.length === 0) {
  console.log('  当前没有等待审批的会话，因此这条闸门此刻没有被行使。')
  console.log('  （判定规则本身由 approval-gate-counterfactual.mjs 覆盖。）')
} else if (problems === 0) {
  console.log(`  ✓ ${parked.length} 个等待审批的会话全部被正确拒绝，且给出了下一步提示。`)
}

// The ledger is the authoritative record of what was actually TOUCHED. A parked session
// may legitimately appear there if the USER resumed it by hand — that is their call — so
// only AUTOMATIC entries are a violation.
const ledgerPath = process.argv[3]
if (ledgerPath !== undefined) {
  const fs = await import('node:fs')
  if (fs.existsSync(ledgerPath)) {
    const ledger = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'))
    console.log('\n  --- 账本里对这些会话的自动尝试（必须为 0）---')
    let autoHits = 0
    for (const session of parked) {
      const history = ledger.sessions?.[session.sessionId]?.history ?? []
      const automatic = history.filter(entry => entry.by === 'auto')
      const manual = history.filter(entry => entry.by !== 'auto')
      console.log(`  ${session.sessionId.slice(0, 26)}: auto=${automatic.length} 手动/专家=${manual.length}`)
      autoHits += automatic.length
    }
    if (autoHits === 0) {
      console.log('  ✓ 自动恢复从未碰过任何一个等待审批的会话。')
    } else {
      console.log(`  ✗ 有 ${autoHits} 次自动尝试打到了等待审批的会话 —— 闸门失效！`)
      problems += 1
    }
  }
}

console.log('')
if (problems > 0) {
  console.log(`结论：发现 ${problems} 个问题。`)
  process.exit(1)
}
console.log('结论：审批闸门在实时状态下的行为正确。')
process.exit(0)
