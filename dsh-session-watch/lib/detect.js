/**
 * Stalled-session detection — the deterministic core of `dsh-session-watch`.
 *
 * WHY THIS IS A SEPARATE, PURE MODULE
 *
 * Deciding "this session has silently stopped" is a judgement with two failure
 * modes that both cost the user real time:
 *
 *   false positive — we resume a session that was deliberately waiting (most
 *                    often on an approval prompt), which answers a question on
 *                    the user's behalf. That is worse than doing nothing.
 *   false negative — we stay quiet while a session is genuinely dead, which is
 *                    exactly the loss this plugin exists to prevent.
 *
 * Neither is acceptable, so this module contains NO model calls and no heuristics
 * that guess: every verdict is derived from durable events already written to the
 * session log. Callers may attach a prompt to a resume, but the prompt never
 * decides WHETHER to resume — that is decided here, by rules.
 *
 * The observed failure shape (measured across 125 real session logs) is a log
 * that simply STOPS mid-turn: the final event is `step/start` or `tool/call`,
 * with no `turn/end`. Crucially, those logs contain no error event at all — the
 * turn does not fail loudly, it stops. That is why detection keys on log
 * ADVANCE over time rather than on the presence of an error.
 *
 * @module dsh-session-watch/detect
 */

/**
 * Why a session is not simply "running normally". A `null` verdict means the
 * session is healthy and must not be touched.
 * @typedef {'stalled' | 'awaiting-approval' | 'aborted-by-user' | 'empty'
 *   | 'idle' | 'too-young' | 'subagent' | 'unreadable'} WatchVerdict
 */

/**
 * Event types that prove the session is blocked on a HUMAN decision rather than
 * dead. When one of these sits in the current turn's tail, a long silence is
 * expected and resuming would answer the user's question for them.
 *
 * CORRECTED AGAINST REAL LOGS (this list was previously wrong in a dangerous way)
 *
 * The first version of this set was written from the upstream type names and
 * contained `approval/request`, `user/question` and `plan/proposal`. A survey of the
 * complete event vocabulary across all 178 session logs on this host shows that
 * **none of those three names is ever emitted**. The real approval request event is
 * called **`approval/asked`**.
 *
 * The consequence was that the gate never fired for its most important case: a
 * session parked on an approval was classified `stalled`, and since `stalled` is the
 * one auto-resumable verdict, enabling auto-resume would have sent a "继续" into a
 * turn that was waiting for the user to approve a tool — answering on the user's
 * behalf. That is precisely the harm this gate exists to prevent, so the fix is
 * load-bearing rather than cosmetic.
 *
 * Real vocabulary, measured (sessions containing the event, out of 178):
 *   `approval/asked` 10 · `approval/decided` 10 · `approval/policy` 178
 *   `permission/preset` 170 · `sandbox/mode` 178
 *
 * `approval/policy`, `permission/preset` and `sandbox/mode` are emitted when a
 * setting changes, which normally happens during session setup — so they only
 * matter here if one lands inside the current turn's tail. Keeping them is the
 * conservative direction: a false `awaiting-approval` merely declines to act, while
 * a missed one acts on the user's behalf. `approval/decided` is deliberately absent:
 * it *resolves* a wait, so treating it as a wait would be backwards.
 *
 * @type {ReadonlySet<string>}
 */
export const AWAITING_TYPES = new Set([
  // The real approval-request event. Without this the gate was dead.
  'approval/asked',
  'approval/policy',
  'permission/preset',
  'sandbox/mode',
])

/**
 * Tool names that PARK a turn until the user answers.
 *
 * An answered `ask_user_question` is followed by a `tool/result`; an unanswered one
 * means the model asked something and the turn is sitting there waiting. There is no
 * event type for that state — the evidence is the ABSENCE of a result — so it has to
 * be recognised from the call itself.
 *
 * Measured: `ask_user_question` is called 40 times across this host's logs, so this
 * is a real path, not a hypothetical one.
 * @type {ReadonlySet<string>}
 */
const AWAITING_TOOL_NAMES = new Set([
  'ask_user_question',
  'exit_plan_mode',
])

/**
 * Events that represent actual turn progress. A session whose log contains none
 * of these never began work, so it is an abandoned or unused session rather than
 * a stalled one — resuming it would start work the user never asked for.
 * @type {ReadonlySet<string>}
 */
const TURN_PROGRESS_TYPES = new Set([
  'turn/start',
  'step/start',
  'step/end',
  'assistant/message',
  'assistant/chunk',
  'tool/call',
  'tool/result',
  'user/message',
  'agent/inbox/spliced',
])

/**
 * Configuration-only events. A log consisting solely of these plus its header is
 * a session that was opened (possibly by the GUI) and then abandoned without any
 * request. It is reported, never auto-resumed.
 * @type {ReadonlySet<string>}
 */
const SETUP_TYPES = new Set([
  'session',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'session/end-seed',
  'command/run',
  'command/done',
  'agent-preset/selected',
])

/**
 * Turn-end reasons that describe an intentional stop. `aborted` covers a user
 * cancel (`reason.kind === 'user'`), which must never be auto-resumed — the user
 * asked for it to stop.
 * @type {ReadonlySet<string>}
 */
const INTENTIONAL_END_REASONS = new Set(['aborted', 'cancelled', 'canceled', 'user', 'interrupted'])

/**
 * Read the `time` field of one event, falling back to its `seq`. Session logs
 * carry a millisecond `time` on every event; the header row carries `createdAt`.
 * @param {any} event - one raw session event.
 * @returns {number} epoch milliseconds, or 0 when the event carries no time.
 */
export function eventTime(event) {
  if (typeof event?.time === 'number' && Number.isFinite(event.time)) return event.time
  if (typeof event?.createdAt === 'number' && Number.isFinite(event.createdAt)) return event.createdAt
  return 0
}

/**
 * Decide whether a turn-end reason describes an intentional stop.
 *
 * The log spells this as `{ kind: 'aborted', reason: { kind: 'user' } }`, so the
 * check walks the nested reason objects rather than comparing one string.
 * @param {any} reason - the `data.reason` of a `turn/end` event.
 * @returns {boolean} true when stopping was a deliberate act, not a stall.
 */
export function isIntentionalEnd(reason) {
  let node = reason
  // The reason nests at most a couple of levels; bound the walk defensively.
  for (let depth = 0; depth < 4 && node !== null && typeof node === 'object'; depth += 1) {
    if (typeof node.kind === 'string' && INTENTIONAL_END_REASONS.has(node.kind)) return true
    node = node.reason
  }
  return false
}

/**
 * Classify one session from its durable log and live status.
 *
 * The order of the checks is the whole design: every "do not touch" verdict is
 * decided before `stalled` can be returned, so an uncertain session is reported
 * rather than resumed.
 *
 * @param {object} input - the observed state of one session.
 * @param {readonly any[]} input.events - its events, oldest first.
 * @param {boolean} input.running - the live Agent status (`running` vs `idle`).
 * @param {boolean} [input.isSubagent] - true for a delegated child session.
 * @param {number} [input.now] - evaluation time; defaults to `Date.now()`.
 * @param {number} [input.stallMs] - silence that counts as a stall.
 * @param {number} [input.minAgeMs] - ignore sessions younger than this.
 * @param {boolean} [input.readable] - false when the log could not be read.
 * @returns {{verdict: WatchVerdict, lastType: string|null, silentMs: number,
 *   lastSeq: number|null, turn: number|null, step: number|null, detail: string}}
 *   the verdict plus the evidence behind it.
 */
export function classifySession(input) {
  const now = input.now ?? Date.now()
  const stallMs = input.stallMs ?? 5 * 60 * 1000
  const minAgeMs = input.minAgeMs ?? 60 * 1000
  const events = Array.isArray(input.events) ? input.events : []

  /** @type {{verdict: WatchVerdict, lastType: string|null, silentMs: number, lastSeq: number|null, turn: number|null, step: number|null, detail: string}} */
  const base = {
    verdict: 'idle',
    lastType: null,
    silentMs: 0,
    lastSeq: null,
    turn: null,
    step: null,
    detail: '',
  }

  // A log we cannot read must never be resumed on a guess.
  if (input.readable === false) {
    return { ...base, verdict: 'unreadable', detail: '会话日志无法读取；不做任何自动动作。' }
  }

  // Delegated children and background work legitimately go quiet for a long
  // time between their own steps, so they are out of scope for auto-resume.
  if (input.isSubagent === true) {
    return { ...base, verdict: 'subagent', detail: 'subagent 子会话；由父会话负责收敛，不自动恢复。' }
  }

  const first = events[0]
  const startedAt = eventTime(first)
  const last = events.length > 0 ? events[events.length - 1] : null
  const lastAt = eventTime(last)
  const silentMs = lastAt > 0 ? now - lastAt : 0
  const lastType = typeof last?.type === 'string' ? last.type : null
  const lastSeq = typeof last?.seq === 'number' ? last.seq : null

  // Position is carried for the UI/report; it is evidence, not a decision input.
  let turn = null
  let step = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const data = events[i]?.data
    if (turn === null && typeof data?.turn === 'number') turn = data.turn
    if (step === null && typeof data?.step === 'number') step = data.step
    if (turn !== null && step !== null) break
  }

  const carrying = { ...base, lastType, silentMs, lastSeq, turn, step }

  // Too young to judge: a freshly started session has not had time to stall.
  if (startedAt > 0 && now - startedAt < minAgeMs) {
    return { ...carrying, verdict: 'too-young', detail: '会话刚开始，暂不判定。' }
  }

  // A log with no events beyond its header never began work at all. This is the
  // "4 events and then nothing" shape seen in real logs, and it is a genuine
  // stall: the turn never opened, so silence is not progress.
  if (last === null) {
    return { ...carrying, verdict: 'stalled', detail: '会话日志为空，从未开始工作。' }
  }

  // Decide whether the session's CURRENT turn closed, and how.
  //
  // The comparison must be turn-scoped, not log-scoped. A long session contains
  // many closed turns, and an old `turn/end {aborted}` from an earlier turn must
  // not describe the turn that is open right now — reading the last `turn/end`
  // anywhere in the log made every still-running session look like a user abort.
  //
  // So: find the newest `turn/start`, then ask whether a `turn/end` for that same
  // turn number follows it. Measured real logs also append bookkeeping after a
  // closed turn (`session/end-seed`, `model/selection`, `/compact`, `/export`),
  // which is why the turn number — not the final event — is the anchor.
  let openTurnIndex = -1
  let openTurn = null
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'turn/start') continue
    const turnNumber = event?.data?.turn
    openTurnIndex = i
    openTurn = typeof turnNumber === 'number' ? turnNumber : null
    break
  }

  // Locate the `turn/end` for the open turn, if one exists.
  let openTurnEndIndex = -1
  if (openTurnIndex >= 0) {
    for (let i = events.length - 1; i > openTurnIndex; i -= 1) {
      const event = events[i]
      if (event?.type !== 'turn/end') continue
      // An untagged turn/end still closes the open turn; a tagged one must match.
      const turnNumber = event?.data?.turn
      if (openTurn === null || typeof turnNumber !== 'number' || turnNumber === openTurn) {
        openTurnEndIndex = i
        break
      }
    }
  }

  // Events after the current turn's boundary are bookkeeping, never new turn work.
  const boundary = openTurnEndIndex >= 0 ? openTurnEndIndex : openTurnIndex
  const tail = boundary >= 0 ? events.slice(boundary + 1) : events
  const trailing = openTurnEndIndex >= 0 ? tail.map(event => event?.type) : []

  // A session that never advanced a turn is not a stall. Measured shape: a log
  // holding only the header plus `permission/preset`, `sandbox/mode`,
  // `approval/policy` and `session/end-seed`. Such a session was opened and
  // abandoned before any request — resuming it would invent work for the user.
  // It is surfaced by the caller as a notice, but is never auto-resumed.
  const progressed = events.some(event => TURN_PROGRESS_TYPES.has(event?.type))
  if (!progressed) {
    const setupOnly = events.every(event => SETUP_TYPES.has(event?.type))
    return {
      ...carrying,
      verdict: 'empty',
      detail: setupOnly
        ? '只有初始化事件，从未开始任何工作；已放弃的空会话，不自动恢复。'
        : '日志中没有任何轮次推进事件；不自动恢复。',
    }
  }

  // The session's current turn CLOSED. What follows it is arbitrary bookkeeping,
  // so that turn's own outcome decides the verdict — not the final event.
  if (openTurnEndIndex >= 0) {
    const turnEnd = events[openTurnEndIndex]
    const reason = turnEnd?.data?.reason
    // An intentional stop stays stopped — the user asked for it.
    if (isIntentionalEnd(reason)) {
      return {
        ...carrying,
        lastSeq: typeof turnEnd.seq === 'number' ? turnEnd.seq : lastSeq,
        verdict: 'aborted-by-user',
        detail: '用户主动中止的轮次；不自动恢复。',
      }
    }
    // A turn that closed for any other reason — `completed`, or `error` the
    // machine already recorded and reported — is FINISHED work, not a silent
    // stop. Auto-resuming it would replay a turn the user already watched end.
    const kind = typeof reason?.kind === 'string' ? reason.kind : 'unknown'
    const detail = kind === 'error'
      ? `轮次已因错误结束（机器已记录该失败）${trailing.length > 0 ? `，其后为收尾事件 ${trailing.join(', ')}` : ''}；不属于静默停摆。`
      : `轮次已结束（reason=${kind}）${trailing.length > 0 ? `，其后为收尾事件 ${trailing.join(', ')}` : ''}。`
    return { ...carrying, verdict: 'idle', detail }
  }

  // The current turn never closed. If the log is parked on a human decision, that
  // is expected silence, not a stall — the case to exclude from auto-resume.
  //
  // Two shapes are checked, because a parked turn has two possible signatures:
  //   1. it ended on an approval event (`approval/asked` and friends), or
  //   2. it ended on a tool call that ASKS THE USER something, with no result yet.
  // The second has no event type of its own — the evidence is a missing
  // `tool/result` — so it is recognised from the call.
  const tailTypes = new Set(tail.map(event => event?.type))
  for (const awaiting of AWAITING_TYPES) {
    if (tailTypes.has(awaiting)) {
      return { ...carrying, verdict: 'awaiting-approval', detail: '正在等待审批或权限决定；不自动恢复。' }
    }
  }
  const answered = new Set(
    tail.filter(event => event?.type === 'tool/result')
      .map(event => event?.data?.message?.toolCallId ?? event?.data?.callId)
      .filter(id => typeof id === 'string'),
  )
  for (const event of tail) {
    if (event?.type !== 'tool/call') continue
    const toolName = event?.data?.name
    if (typeof toolName !== 'string' || !AWAITING_TOOL_NAMES.has(toolName)) continue
    const callId = event?.data?.callId
    // An answered question is progress, not a wait.
    if (typeof callId === 'string' && answered.has(callId)) continue
    return {
      ...carrying,
      verdict: 'awaiting-approval',
      detail: `正在等待用户回答（${toolName}）；不自动恢复。`,
    }
  }

  // THE SILENCE WINDOW APPLIES TO BOTH BRANCHES. This was a real false-positive source.
  //
  // The rule used to be asymmetric:
  //
  //   if (input.running && silentMs >= stallMs) -> stalled   // time-gated
  //   if (!input.running)                       -> stalled   // NOT gated at all
  //
  // `running` means "an agent for this session is live in THIS process". It is therefore
  // false for two very different situations:
  //
  //   1. the driver died and left the turn open — the silent stop this plugin exists for;
  //   2. this process simply has no agent for it — which is true of EVERY session on disk
  //      right after a restart.
  //
  // In case 2 the ungated branch fired immediately, so a restart classified every
  // half-finished session as `stalled` regardless of how recently it had written. Measured
  // on the live host: two sessions were auto-nudged 13 s after boot with silences of 6 s and
  // 0 s against a 900 s window, and replaying the decision showed the SAME log and the SAME
  // instant giving `stalled` for `running: false` and `idle` for `running: true`. Both
  // nudges were false positives — the watcher poked sessions that had not stalled.
  //
  // A dead driver still gets caught: it stops writing, so its silence grows past `stallMs`
  // and this branch reports it then. The window only DELAYS detection of case 1 to the point
  // where "silent" actually means something; it never loses the case.
  if (silentMs >= stallMs) {
    return {
      ...carrying,
      verdict: 'stalled',
      detail: input.running
        ? `状态为 running，但日志已 ${Math.round(silentMs / 1000)}s 无新事件（最后事件 ${lastType ?? '未知'}）。`
        : `轮次中途停止（最后事件 ${lastType ?? '未知'}），且已 ${Math.round(silentMs / 1000)}s 无新事件，未见 turn/end。`,
    }
  }

  // Silent, turn still open, but not for long enough to call it a stop. This is the state a
  // restart puts every half-finished session in, so it must NOT be reported as a stall.
  if (!input.running) {
    return {
      ...carrying,
      verdict: 'idle',
      detail: `轮次未见 turn/end，但仅 ${Math.round(silentMs / 1000)}s 无新事件，未达停摆窗口（${Math.round(stallMs / 1000)}s）；暂不判定。`,
    }
  }

  return { ...carrying, verdict: 'idle', detail: '会话运行中且日志正常推进。' }
}

/**
 * Verdicts that a caller may act on automatically. Everything else is reported
 * only, so an uncertain session is never resumed.
 * @type {ReadonlySet<WatchVerdict>}
 */
export const AUTO_RESUMABLE = new Set(['stalled'])

/**
 * Run classification over many sessions and return only the interesting ones.
 * @param {readonly object[]} sessions - per-session classification inputs.
 * @returns {object[]} verdicts whose state is not ordinary idle progress.
 */
export function scanSessions(sessions) {
  const results = []
  for (const session of Array.isArray(sessions) ? sessions : []) {
    const verdict = classifySession(session)
    if (verdict.verdict === 'idle' || verdict.verdict === 'too-young') continue
    results.push({ ...session, ...verdict })
  }
  return results
}