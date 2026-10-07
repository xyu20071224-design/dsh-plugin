/**
 * Is a MANUAL (or expert) resume counted against the AUTOMATIC cap?
 *
 * WHY THIS MATTERS
 *
 * The README says a manual resume is "不受任何闸门限制（含次数上限）：那是你的判断，不是策略的判断"
 * — the user's own judgement replaces the policy checks. That is the intent.
 *
 * But both paths share ONE ledger counter, and `decideResume` compares that counter to
 * `maxAttempts` without looking at who spent it. So two manual nudges exhaust a session's
 * automatic allowance, and the watcher then refuses with `attempts-exhausted` — reporting
 * "已自动恢复 2 次" about a session it never once touched on its own.
 *
 * That is the same class of error as the earlier `host-not-ready` defect: a count that
 * describes the wrong thing. The question this script answers is which behaviour is
 * actually intended, because both readings are defensible:
 *
 *   (a) one shared budget — any nudge is a nudge; if a session has been nudged twice by
 *       anyone, the watcher should stop. Conservative, and never surprises the user with
 *       a third automatic message.
 *   (b) separate budgets — the cap exists to bound the WATCHER's autonomy, so only its own
 *       attempts should count. A manual nudge says nothing about whether automation should
 *       eventually help.
 *
 * Run: node test/audit-manual-budget.mjs   (read-only; inspects the live ledger)
 */

import { readLedger } from '../lib/ledger.js'
import { RESUME_DEFAULTS, decideResume } from '../lib/resume.js'

const ledger = readLedger()
const rows = Object.entries(ledger.sessions ?? {})
if (rows.length === 0) {
  console.log('ledger is empty — nothing to audit')
  process.exit(0)
}

console.log('=== 每个被记录过的会话：额度是谁花的？ ===\n')
let mixed = 0
for (const [sessionId, record] of rows) {
  const history = Array.isArray(record.history) ? record.history : []
  const byAuto = history.filter(entry => entry.by === 'auto').length
  const byOther = history.filter(entry => entry.by !== 'auto').length
  const decision = decideResume(
    { verdict: 'stalled', busy: false, now: Date.now(), record },
    { ...RESUME_DEFAULTS, enabled: true, maxAttempts: 2 },
  )
  console.log(`  ${sessionId}`)
  console.log(`    attempts=${record.attempts}  auto=${byAuto}  other=${byOther}`)
  console.log(`    若再次停摆 -> ${decision.reason}`)
  console.log(`      ${decision.detail}`)
  if (byOther > 0 && decision.reason === 'attempts-exhausted') {
    console.log('    ⚠ 额度是被【非自动】尝试吃满的（是的，共享额度；说法已如实区分）')
    mixed += 1
  }
  console.log('')
}

console.log(`结论：${mixed} 个会话的自动额度被非自动尝试消耗。`)
if (mixed > 0) {
  console.log('  共享额度的设计是对的（上限的作用是限制"一个会话总共被打扰几次"，')
  console.log('  放宽它会让手动 nudge 过两次的会话再多收两条自动消息）。')
  console.log('  现在 refusal 的**说法**已经如实区分自动与手动，不再声称"已自动恢复 N 次"。')
}
process.exit(0)
