/**
 * Tests for the auto-resume policy.
 *
 * These gates are the only thing standing between "helpful" and "the harness
 * answered an approval prompt on the user's behalf", so every refusal is tested
 * explicitly rather than assumed. The policy is pure, so no live harness is
 * needed.
 *
 * Run: node test/resume.test.mjs
 *
 * @module dsh-session-watch/test/resume
 */

import { RESUME_DEFAULTS, backoffFor, buildNudgeText, decideResume } from '../lib/resume.js'
import { readFileSync } from 'node:fs'

let passed = 0
let failed = 0

/**
 * Assert a condition.
 * @param {string} label - what is being verified.
 * @param {boolean} condition - the observed result.
 * @param {string} [extra] - detail printed on failure.
 * @returns {void}
 */
function check(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`) }
}

const ON = { ...RESUME_DEFAULTS, enabled: true }
const NOW = 10_000_000
const fresh = { attempts: 0, lastAttemptAt: null }

console.log('\n--- 默认必须是关闭的 ---')
check('RESUME_DEFAULTS.enabled 为 false', RESUME_DEFAULTS.enabled === false)
check('关闭时不恢复',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: fresh }, RESUME_DEFAULTS).reason === 'disabled')

console.log('\n--- 只有 stalled 会被恢复 ---')
for (const verdict of ['awaiting-approval', 'aborted-by-user', 'empty', 'subagent', 'unreadable', 'idle', 'too-young']) {
  const decision = decideResume({ verdict, busy: false, now: NOW, record: fresh }, ON)
  check(`拒绝对 ${verdict} 自动恢复`, decision.resume === false && decision.reason === 'not-stalled',
    `${decision.reason}: ${decision.detail}`)
}
check('允许对 stalled 自动恢复',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: fresh }, ON).resume === true)

console.log('\n--- 正在运行的 agent 不打扰 ---')
check('busy 时拒绝',
  decideResume({ verdict: 'stalled', busy: true, now: NOW, record: fresh }, ON).reason === 'busy')

console.log('\n--- 次数上限 ---')
check('未达上限时允许',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: { attempts: 1, lastAttemptAt: 0 } }, ON).resume === true)
check('达到上限时拒绝',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: { attempts: 2, lastAttemptAt: 0 } }, ON).reason === 'attempts-exhausted')
check('超过上限时仍拒绝',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: { attempts: 9, lastAttemptAt: 0 } }, ON).reason === 'attempts-exhausted')
check('maxAttempts=0 时永不恢复',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: fresh }, { ...ON, maxAttempts: 0 }).resume === false)

console.log('\n--- 退避与冷却 ---')
{
  const policy = { ...ON, baseDelayMs: 120_000, maxDelayMs: 1_200_000, cooldownMs: 0 }
  // attempts=1 -> delay 120s; attempts=2 -> 240s; attempts=3 -> 480s.
  check('退避: 第 2 次前等 1x', backoffFor(1, policy) === 120_000, String(backoffFor(1, policy)))
  check('退避: 第 3 次前等 2x', backoffFor(2, policy) === 240_000, String(backoffFor(2, policy)))
  check('退避: 第 4 次前等 4x', backoffFor(3, policy) === 480_000, String(backoffFor(3, policy)))
  check('退避: 首次无延迟', backoffFor(0, policy) === 0)
  check('退避: 受上限约束', backoffFor(20, policy) === 1_200_000, String(backoffFor(20, policy)))
  // Cooling down while inside the window, allowed once past it.
  check('冷却中拒绝',
    decideResume({ verdict: 'stalled', busy: false, now: 100_000, record: { attempts: 1, lastAttemptAt: 100_000 } }, policy).reason === 'cooling-down')
  check('冷却结束后允许',
    decideResume({ verdict: 'stalled', busy: false, now: 100_000 + 120_000, record: { attempts: 1, lastAttemptAt: 100_000 } }, policy).resume === true)
}
{
  // cooldownMs must dominate when it is larger than the backoff.
  const policy = { ...ON, baseDelayMs: 1_000, maxDelayMs: 1_000, cooldownMs: 600_000 }
  check('冷却下限大于退避时以后者为准',
    decideResume({ verdict: 'stalled', busy: false, now: 100_000, record: { attempts: 1, lastAttemptAt: 100_000 } }, policy).reason === 'cooling-down')
}
{
  // A refusal must never carry a nonzero delay, or callers might schedule work.
  const refused = decideResume({ verdict: 'idle', busy: false, now: NOW, record: fresh }, ON)
  check('拒绝时 nextDelayMs 为 0', refused.nextDelayMs === 0)
  const allowed = decideResume({ verdict: 'stalled', busy: false, now: NOW, record: fresh }, ON)
  check('允许时给出下次退避', allowed.nextDelayMs > 0, String(allowed.nextDelayMs))
}

console.log('\n--- 防御性：缺失/损坏的记录 ---')
check('缺失 record 视为 0 次',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: undefined }, ON).resume === true)
check('NaN attempts 视为 0 次',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: { attempts: NaN, lastAttemptAt: null } }, ON).resume === true)
check('lastAttemptAt 非数字时忽略冷却',
  decideResume({ verdict: 'stalled', busy: false, now: NOW, record: { attempts: 1, lastAttemptAt: null } }, ON).resume === true)

console.log('\n--- 催促文案 ---')
{
  const text = buildNudgeText({ turn: 3, step: 7, lastType: 'tool/call' })
  check('默认文案提到停止位置', text.includes('turn=3') && text.includes('step=7'))
  check('默认文案要求从中断处继续', text.includes('继续'))
  // The instruction must still forbid re-planning. The old form asserted the exact phrase
  // "不要重新解释", which broke when a clause was inserted between the two words — the
  // requirement is the PROHIBITION, not one particular phrasing of it.
  check('默认文案禁止重做与重述计划',
    /不要重做/.test(text) && /不要.{0,12}重新解释/.test(text), text)
  const custom = buildNudgeText({ turn: 1, step: 2, lastType: 'x' }, '继续 {turn}/{step} after {lastType}')
  check('自定义模板占位符被替换', custom === '继续 1/2 after x', custom)
  check('空白模板回落到默认', buildNudgeText({ turn: 1 }, '   ').includes('自动续跑'))
}

console.log('\n--- 催促文案必须写明是谁发的 ---')
{
  // This text is written INTO the conversation and becomes permanent. Calling a manual or
  // expert nudge "自动续跑" records a false statement in the user's own log — the same
  // defect class as reporting "已自动恢复 N 次" for manual attempts.
  //
  // It also has a sharper consequence, observed live: a nudge sent by a manual probe
  // arrived in a session whose agent then had to ask whether the harness had acted on its
  // own. That is exactly the uncertainty this project exists to remove.
  const session = { turn: 9, step: 5, lastType: 'tool/call' }

  check('auto 说自动', buildNudgeText(session, null, 'auto').startsWith('（自动续跑）'))
  // The default must stay 'auto' so every existing caller keeps its meaning.
  check('不传 origin 时默认为 auto',
    buildNudgeText(session, null).startsWith('（自动续跑）'))

  const manual = buildNudgeText(session, null, 'manual')
  check('manual 不得自称自动', !manual.includes('自动续跑'), manual.split('\n')[0])
  check('manual 明确说是本人发起', manual.includes('你本人发起'), manual.split('\n')[0])

  const expert = buildNudgeText(session, null, 'user-proxy')
  check('user-proxy 不得自称自动', !expert.includes('自动续跑'), expert.split('\n')[0])
  check('user-proxy 署名为专家', expert.includes('用户代理专家'), expert.split('\n')[0])

  // The rest of the message must not change with the origin: only the attribution does.
  const rest = text => text.split('\n').slice(1).join('\n')
  check('除首行外内容一致', rest(manual) === rest(buildNudgeText(session, null, 'auto')))

  // A custom template can place the origin itself, so a user's own wording stays accurate.
  check('自定义模板支持 {origin}',
    buildNudgeText(session, '继续（{origin}）turn={turn}', 'manual') === '继续（手动续跑 — 你本人发起）turn=9',
    buildNudgeText(session, '继续（{origin}）turn={turn}', 'manual'))

  // An unrecognised origin must still be reported, never silently relabelled as automatic.
  const unknown = buildNudgeText(session, null, 'cron')
  check('未知来源不被冒充为自动', !unknown.includes('自动续跑') && unknown.includes('cron'),
    unknown.split('\n')[0])
}

console.log('\n--- 催促文案必须承认自己可能迟到 ---')
{
  // MEASURED TWICE, on this project's own author. A nudge is queued as an ordinary
  // follow-up turn, so it can arrive long after it was composed. Two nudges recorded at
  // 21:02:57 and 21:05:01 — both describing turn=9 — were delivered when the session had
  // already reached turn=11, two turns past the position they claimed had stopped.
  //
  // Both times the receiving agent had to work out for itself that the instruction was
  // obsolete. A message asserting "you stopped here" while the recipient is demonstrably
  // past that point is false, and the recipient cannot tell a real stall from a stale
  // queue entry unless the message says so.
  const session = { turn: 9, step: 15, lastType: 'tool/call' }
  const text = buildNudgeText(session, null, 'auto')

  check('说明了观测到的位置', text.includes('turn=9') && text.includes('step=15'), text)
  check('承认可能已经过期', /过期/.test(text), text)
  check('明确允许忽略', /忽略/.test(text), text)
  // It must not merely warn — it must give the escape hatch, because otherwise the
  // recipient is left choosing between obeying a false instruction and ignoring a real one.
  check('给出"若已继续则忽略"的判据', /若你已经继续过/.test(text), text)
  // And the core instruction survives: continue, but only if it really did stop there.
  check('仍然要求从中断处继续', /若确实停在那里/.test(text), text)
  check('仍然禁止重做与重述计划',
    /不要重做/.test(text) && /不要.{0,12}重新解释/.test(text), text)
  // The wording must no longer assert flatly that the turn stopped: it reports an
  // OBSERVATION, since by delivery time that claim may be untrue.
  check('不再断言"上一轮停止了"', !text.includes('上一轮在你的步骤执行中途停止了'), text)
}

console.log('\n--- 类型声明与真实产出必须一致 ---')

/**
 * The value list in the `ResumeReason` typedef, read from the source.
 *
 * A declared-but-never-produced value is not harmless: it invites a consumer to branch on
 * a state that cannot occur, and it turns the type into a description of intent rather than
 * of behaviour. `'too-old'` sat in this list for several rounds with nothing producing it,
 * which is exactly how such drift goes unnoticed.
 * @returns {Set<string>} the declared values.
 */
function declaredReasons() {
  const source = readFileSync(new URL('../lib/resume.js', import.meta.url), 'utf8')
  const block = /@typedef \{([^}]*)\} ResumeReason/.exec(source)
  if (block === null) throw new Error('ResumeReason typedef not found')
  return new Set([...block[1].matchAll(/'([a-z-]+)'/g)].map(match => match[1]))
}

// Every reason the code can actually put on a row: the six `decideResume` returns, plus
// the two the execution step writes after it acts.
const producible = new Set([
  'disabled', 'not-stalled', 'busy', 'attempts-exhausted', 'cooling-down', 'resumed',
  'resume-failed', 'host-not-ready',
])
const declared = declaredReasons()

{
  const stale = [...declared].filter(reason => !producible.has(reason))
  check('没有"声明了却永不产出"的 reason', stale.length === 0, stale.join(', ') || '(none)')
}
{
  const undeclared = [...producible].filter(reason => !declared.has(reason))
  check('没有"产出了却没声明"的 reason', undeclared.length === 0, undeclared.join(', ') || '(none)')
}

// And spot-check that the two ends really do line up, rather than trusting the two lists
// above to have been typed correctly.
check('decideResume 真的会返回 disabled',
  decideResume({ verdict: 'stalled', busy: false, now: 1, record: { attempts: 0, lastAttemptAt: null } },
    { ...RESUME_DEFAULTS, enabled: false }).reason === 'disabled')
check('decideResume 真的会返回 attempts-exhausted',
  decideResume({ verdict: 'stalled', busy: false, now: 1, record: { attempts: 9, lastAttemptAt: null } },
    { ...RESUME_DEFAULTS, enabled: true, maxAttempts: 2 }).reason === 'attempts-exhausted')
check('decideResume 真的会返回 not-stalled',
  decideResume({ verdict: 'awaiting-approval', busy: false, now: 1, record: { attempts: 0, lastAttemptAt: null } },
    { ...RESUME_DEFAULTS, enabled: true }).reason === 'not-stalled')
check('decideResume 真的会返回 busy',
  decideResume({ verdict: 'stalled', busy: true, now: 1, record: { attempts: 0, lastAttemptAt: null } },
    { ...RESUME_DEFAULTS, enabled: true }).reason === 'busy')

console.log('\n--- 上限的"说法"必须与实际花费一致 ---')

// The cap is deliberately SHARED (every nudge counts, whichever layer sent it), but the
// explanation must not claim "已自动恢复 N 次" about nudges the watcher never sent.
// Measured on a real ledger: a session with auto=0, manual=2 was refused with
// "已自动恢复 2 次（上限 2）" while automation had never touched it — a false statement
// shown to the user, which is the exact defect class this project keeps running into.
{
  const policy = { ...RESUME_DEFAULTS, enabled: true, maxAttempts: 2 }
  /** @param {object} record @returns {string} the refusal detail. */
  const detailFor = record => decideResume(
    { verdict: 'stalled', busy: false, now: 1, record }, policy,
  ).detail

  const allAuto = detailFor({ attempts: 2, history: [{ by: 'auto' }, { by: 'auto' }] })
  check('全自动时可以说"已自动恢复"', /已自动恢复 2 次/.test(allAuto), allAuto)

  const allManual = detailFor({ attempts: 2, history: [{ by: 'manual' }, { by: 'manual' }] })
  check('全手动时不得说"已自动恢复"', !/已自动恢复/.test(allManual), allManual)
  check('全手动时说明额度是手动花的', /手动\/专家续跑 2 次（自动 0 次）/.test(allManual), allManual)

  const mixed = detailFor({ attempts: 2, history: [{ by: 'auto' }, { by: 'user-proxy' }] })
  check('混合时给出两个数目', /自动 1、手动\/专家 1/.test(mixed), mixed)

  const noHistory = detailFor({ attempts: 2 })
  check('没有历史时用中性说法，不编造归因',
    /已尝试 2 次/.test(noHistory) && !/自动/.test(noHistory), noHistory)

  // The SAFETY property must be unchanged: the cap still counts every attempt, so a
  // session the user nudged twice does not also get two automatic nudges.
  const stillCapped = decideResume(
    { verdict: 'stalled', busy: false, now: 1, record: { attempts: 2, history: [{ by: 'manual' }, { by: 'manual' }] } },
    policy,
  )
  check('共享额度仍然生效（手动也算数）', stillCapped.resume === false, String(stillCapped.resume))
  check('因此仍然汇报为 attempts-exhausted', stillCapped.reason === 'attempts-exhausted', stillCapped.reason)
}

console.log('\n--- 允许恢复时，说法同样不得编造历史 ---')

// The same rule applies on the ALLOW path. "第 N 次自动恢复（此前 N 次）" is only true when
// the earlier attempts were the watcher's own; after a manual nudge it would claim a
// history that never happened.
{
  const policy = { ...RESUME_DEFAULTS, enabled: true, maxAttempts: 5, baseDelayMs: 0, maxDelayMs: 0, cooldownMs: 0 }
  /** @param {object} record @returns {string} the allow detail. */
  const allowDetail = record => decideResume(
    { verdict: 'stalled', busy: false, now: 1, record }, policy,
  ).detail

  check('首次是"首次自动恢复。"', allowDetail({ attempts: 0, history: [] }) === '首次自动恢复。',
    allowDetail({ attempts: 0, history: [] }))
  check('全自动历史时可以数第几次',
    /第 2 次自动恢复（此前 1 次）/.test(allowDetail({ attempts: 1, history: [{ by: 'auto' }] })),
    allowDetail({ attempts: 1, history: [{ by: 'auto' }] }))
  const afterManual = allowDetail({ attempts: 1, history: [{ by: 'manual' }] })
  check('手动之后不得说"第 2 次自动恢复"', !/第 2 次自动恢复/.test(afterManual), afterManual)
  check('手动之后如实说明此前是手动', /此前已有 1 次续跑（其中自动 0 次）/.test(afterManual), afterManual)
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
