/**
 * Auto-resume policy for `@local/dsh-session-watch`.
 *
 * This module decides WHETHER and WHEN a stalled session may be nudged, and it is
 * deliberately separate from both the detector and the prompt text.
 *
 * THE ONE RULE THAT MATTERS
 *
 * Every gate here is a REFUSAL. The default answer is "do not touch it", and a
 * session is resumed only when every condition independently permits it. The
 * prompt text decides what to SAY, never whether to act — a well-written prompt
 * cannot rescue a wrong decision, and a bad one cannot cause harm on its own.
 *
 * WHY THE GATES EXIST (each maps to a real failure)
 *
 *   - verdict gate      only `stalled` is ever resumed. A session parked on an
 *                       approval prompt must not receive an answer on the user's
 *                       behalf, and an `empty` session must not have work invented
 *                       for it.
 *   - attempt cap       a genuinely broken session (a loop that dies every time)
 *                       would otherwise be nudged forever, burning tokens while
 *                       nobody watches. After `maxAttempts`, it is reported only.
 *   - backoff           immediate retries of a systemic failure (rate limit,
 *                       provider outage) all fail the same way. Waiting longer
 *                       each time spends fewer tokens on a problem that time
 *                       alone may fix.
 *   - cooldown          never pile a second nudge onto a session whose first
 *                       nudge has not had time to work. A resume is asynchronous;
 *                       judging it too early creates a nudge storm.
 *   - busy gate         a session whose agent is mid-turn is not stalled, whatever
 *                       the log tail suggests.
 *
 * The module is pure: it takes a record of past attempts and the current
 * observation, and returns a decision. It performs no I/O and calls no model, so
 * every gate is testable without a live harness.
 *
 * @module @local/dsh-session-watch/resume
 */

import { AUTO_RESUMABLE } from './detect.js'

/**
 * Why a session was or was not resumed.
 *
 * Every value except `resumed` and `resume-failed` is a deliberate REFUSAL, not an
 * error: refusing is the safe outcome, and the reason is surfaced to the user so silence
 * is never mistaken for "nothing was wrong".
 *
 * Two of these are produced by the EXECUTION step rather than by {@link decideResume}:
 * `buildSnapshot` rewrites a row's reason once it has acted, so the panel describes what
 * happened instead of what it was about to do. `host-not-ready` is the special case where
 * nothing was attempted at all, because the process had not finished starting.
 *
 * A `too-old` value was declared here and never produced by anything — dead type surface,
 * removed. An age gate would belong in `decideResume` with a real refusal beside it; until
 * such a rule exists, advertising the value only invites a consumer to branch on a state
 * that can never occur.
 *
 * @typedef {'resumed' | 'resume-failed' | 'host-not-ready' | 'not-stalled'
 *   | 'attempts-exhausted' | 'cooling-down' | 'disabled' | 'busy'} ResumeReason
 */

/**
 * Default policy. Every field is overridable from the Loader row's config.
 * @type {{enabled: boolean, maxAttempts: number, baseDelayMs: number,
 *   maxDelayMs: number, cooldownMs: number}}
 */
export const RESUME_DEFAULTS = {
  /**
   * Master switch. Defaults to OFF so that installing this version changes
   * nothing until the user has seen the detector's verdicts on real traffic.
   */
  enabled: false,
  /** Attempts allowed per session before it is only reported. */
  maxAttempts: 2,
  /** First backoff delay; doubles per attempt. */
  baseDelayMs: 2 * 60 * 1000,
  /** Backoff ceiling. */
  maxDelayMs: 30 * 60 * 1000,
  /** Silence required after a resume before another may be considered. */
  cooldownMs: 5 * 60 * 1000,
}

/**
 * Compute the backoff delay before the next attempt.
 *
 * Attempts are counted after the attempt, so the first resume has no delay and
 * the delay before attempt N (1-based, N > 1) is `baseDelayMs * 2^(N-2)`.
 * @param {number} attemptsSoFar - resumes already performed on this session.
 * @param {{baseDelayMs: number, maxDelayMs: number}} policy - the active policy.
 * @returns {number} milliseconds to wait before the next attempt.
 */
export function backoffFor(attemptsSoFar, policy) {
  if (!Number.isFinite(attemptsSoFar) || attemptsSoFar <= 0) return 0
  const exponent = Math.max(0, attemptsSoFar - 1)
  // Cap the exponent before the shift so a long-lived session cannot overflow.
  const factor = 2 ** Math.min(exponent, 20)
  return Math.min(policy.baseDelayMs * factor, policy.maxDelayMs)
}

/**
 * Decide whether one stalled session may be nudged now.
 *
 * @param {object} input - the decision inputs.
 * @param {{verdict: string}} input.verdict - the detector's verdict.
 * @param {boolean} input.busy - whether the live agent is mid-turn.
 * @param {number} input.now - current epoch milliseconds.
 * @param {{attempts: number, lastAttemptAt: number|null}} input.record - past
 *   attempts for this session.
 * @param {{enabled: boolean, maxAttempts: number, baseDelayMs: number,
 *   maxDelayMs: number, cooldownMs: number}} policy - the active policy.
 * @returns {{resume: boolean, reason: ResumeReason, detail: string,
 *   nextDelayMs: number}} the decision and its justification.
 */
export function decideResume(input, policy) {
  const { verdict, busy, now, record } = input
  const attempts = Number.isFinite(record?.attempts) ? record.attempts : 0
  const lastAttemptAt = Number.isFinite(record?.lastAttemptAt) ? record.lastAttemptAt : null

  // Who spent the allowance? The cap is deliberately SHARED — every nudge counts, whichever
  // layer sent it, because the cap's job is to bound how many times a session gets poked at
  // all. Loosening that would let a session that the user nudged twice still receive two
  // more automatic nudges, which is the loop the cap exists to prevent.
  //
  // But the REASON must describe what actually happened. `history` records who sent each
  // attempt, and reporting "已自动恢复 2 次" about two MANUAL nudges is a false statement —
  // exactly the kind of "the panel says something untrue" defect this project keeps
  // finding. Measured against a real ledger: a session with `auto=0, manual=2` was refused
  // with "已自动恢复 2 次（上限 2）" while the watcher had never once touched it.
  const history = Array.isArray(record?.history) ? record.history : []
  const automatic = history.filter(entry => entry?.by === 'auto').length
  const byOthers = history.filter(entry => entry?.by !== undefined && entry.by !== 'auto').length
  /** Describe the spending accurately. @returns {string} a clause for the refusal. */
  const spending = () => {
    // With no history (an older ledger, or a caller that passed only `attempts`) say the
    // neutral thing rather than inventing a breakdown.
    if (history.length === 0) return `已尝试 ${attempts} 次`
    if (byOthers === 0) return `已自动恢复 ${automatic} 次`
    if (automatic === 0) return `已被手动/专家续跑 ${byOthers} 次（自动 0 次）`
    return `共尝试 ${attempts} 次（自动 ${automatic}、手动/专家 ${byOthers}）`
  }

  /** Refuse with a reason. @param {ResumeReason} reason @param {string} detail */
  const refuse = (reason, detail) => ({ resume: false, reason, detail, nextDelayMs: 0 })

  if (!policy.enabled) {
    return refuse('disabled', '自动恢复未启用（resume.enabled=false）；仅报告。')
  }

  // The detector is the only authority on whether a session is stalled. Anything
  // else — approval waits, user aborts, empty sessions, subagents — is refused
  // here regardless of how long it has been silent.
  if (!AUTO_RESUMABLE.has(verdict)) {
    return refuse('not-stalled', `判定为 ${verdict}，不在可自动恢复之列。`)
  }

  // A live agent mid-turn is working, not stalled.
  if (busy === true) {
    return refuse('busy', '该会话的 agent 正在运行中；不打扰。')
  }

  if (attempts >= policy.maxAttempts) {
    return refuse('attempts-exhausted',
      `${spending()}，已达上限 ${policy.maxAttempts}；转为仅报告。`)
  }

  // Backoff is measured from the last attempt, and grows with the attempt count.
  if (lastAttemptAt !== null) {
    const required = Math.max(policy.cooldownMs, backoffFor(attempts, policy))
    const elapsed = now - lastAttemptAt
    if (elapsed < required) {
      return refuse('cooling-down',
        `距上次恢复 ${Math.round(elapsed / 1000)}s，未满退避 ${Math.round(required / 1000)}s。`)
    }
  }

  return {
    resume: true,
    reason: 'resumed',
    // Same accuracy rule as the refusal above: "第 N 次自动恢复" is only true when the
    // earlier attempts were the watcher's own. After a manual nudge it would claim a
    // history that did not happen, so the count is phrased neutrally instead.
    detail: attempts === 0
      ? '首次自动恢复。'
      : (byOthers === 0
        ? `第 ${attempts + 1} 次自动恢复（此前 ${attempts} 次）。`
        : `此前已有 ${attempts} 次续跑（其中自动 ${automatic} 次），本次为自动发起。`),
    nextDelayMs: backoffFor(attempts + 1, policy),
  }
}

/**
 * Build the nudge text sent to a resumed session.
 *
 * The text is intentionally plain and mentions no specifics, because the watcher
 * cannot know why a session stopped. It must not pretend to know, and it must not
 * overwrite the user's own intent — it asks the agent to continue from where the
 * durable log left off, which is exactly what a human typing 继续 would do.
 *
 * WHY THE TEXT CARRIES ITS ORIGIN
 *
 * This message is written INTO the conversation and becomes permanent. Saying
 * "（自动续跑）" when a person or the expert triggered it is a false statement recorded in
 * the user's own log — the same defect class as reporting "已自动恢复 N 次" for manual
 * attempts.
 *
 * It also has a sharper consequence. Observed live: a nudge sent by a manual probe arrived
 * in a session whose agent could not tell whether the harness had acted on its own. That is
 * precisely the uncertainty this whole project exists to remove — an unattributable
 * automatic action is indistinguishable from the harness overstepping — so the label must
 * name the actual sender.
 *
 * @param {object} session - the stalled session's observation.
 * @param {string} [template] - optional custom template with `{turn}`/`{step}`/`{lastType}`/`{origin}`.
 * @param {'auto' | 'manual' | 'user-proxy' | string} [origin] - who is sending this.
 * @returns {string} the message content.
 */
export function buildNudgeText(session, template, origin = 'auto') {
  // Plain-language labels, since this lands in a conversation a human reads. Kept free of
  // parentheses of their own, because they are themselves wrapped in （…） below.
  const labels = {
    auto: '自动续跑',
    manual: '手动续跑 — 你本人发起',
    'user-proxy': '用户代理专家发起',
  }
  const label = labels[origin] ?? `续跑 — ${origin}`

  if (typeof template === 'string' && template.trim() !== '') {
    return template
      .replaceAll('{turn}', String(session?.turn ?? '?'))
      .replaceAll('{step}', String(session?.step ?? '?'))
      .replaceAll('{lastType}', String(session?.lastType ?? '?'))
      .replaceAll('{origin}', label)
  }

  // The message must admit that it can arrive LATE.
  //
  // WHY (measured twice in this project, on its own author)
  //
  // A nudge is queued as an ordinary follow-up turn, so it can be delivered long after it
  // was composed. Observed: two nudges recorded at 21:02:57 and 21:05:01, both describing
  // `turn=9`, were delivered when the session had already reached `turn=11` — two turns
  // past the position they claimed had stopped. Both times the receiving agent had to work
  // out for itself that the instruction was obsolete, and a message that says "you stopped
  // here" while the recipient is demonstrably past that point is simply false.
  //
  // The recipient can check this for itself — it knows where it is — so the text tells it
  // to, and says plainly what to do if the message is stale.
  const opening = `（${label}）检测到 turn=${session?.turn ?? '?'} step=${session?.step ?? '?'} 处没有 turn/end，日志最后事件 ${session?.lastType ?? '未知'}。`

  return [
    opening,
    '这条消息可能在你越过该处之后才送达。若你已经继续过，它就已经过期——请忽略它，'
    + '不要重做任何已完成的工作，也不要因为它而重新解释计划。',
    '若确实停在那里，请从该中断处继续未完成的工作。',
  ].join('\n')
}
