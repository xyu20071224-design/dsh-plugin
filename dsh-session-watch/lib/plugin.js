/**
 * dsh-session-watch — Host half.
 *
 * Watches every session on this DSH host and surfaces the ones that stopped
 * silently mid-turn, so a stalled conversation cannot sit unnoticed for hours.
 *
 * WHY THIS EXISTS
 *
 * The failure the user reported is not an error. Measured across 125 real session
 * logs, no session recorded a failure event at all: `error` and `agent/error` were
 * absent, and the only anomalous events were benign `llm/retry` recoveries. What
 * actually happens is that a session's log simply STOPS mid-turn — the last event
 * is `step/start` or `tool/call`, with no `turn/end` — and the work is never lost,
 * only the driver stopped. Sending "继续" resumes it. The cost is that the user
 * must NOTICE, and with many concurrent sessions they cannot.
 *
 * DESIGN RULES (each one is a deliberate constraint)
 *
 *   1. Detection is deterministic. No model call decides whether a session is
 *      stalled; see `./detect.js`. A model asked to guess would sometimes resume a
 *      session that was deliberately parked on an approval prompt, which answers a
 *      question on the user's behalf.
 *   2. Observation never activates a session. The watcher reads logs from disk and
 *      consults the live-status registry read-only. Looking at a session must
 *      never wake it, or watching would defeat itself.
 *   3. Resume is a separate, gated, opt-in step. `./resume.js` owns every refusal,
 *      and the prompt text never influences whether a session is touched. The
 *      feature ships DISABLED so that merely installing it changes nothing.
 *   4. Every automatic action is recorded and reported. A nudge the user cannot
 *      see would be indistinguishable from the harness acting on its own.
 *
 * @module @local/dsh-session-watch
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

import { classifySession, AUTO_RESUMABLE } from './detect.js'
import { dshHome, findSessionLogs, headerOf, readSessionLog, tailEvents } from './logs.js'
import { RESUME_DEFAULTS, buildNudgeText, decideResume } from './resume.js'
import { SERVICE_NAME, publishSnapshot, readPublishedSnapshot, readProxyMount } from './shared.js'
// The ledger lives in its own module so the expert half can use it WITHOUT importing
// this file. See `./ledger.js` for why that separation is load-bearing.
import { ledgerPath, readLedger, recordAttempt, writeLedger } from './ledger.js'

// Re-exported so existing callers and tests keep working unchanged; the
// implementation and its documentation now live in `./ledger.js`.
export { readLedger, recordAttempt }

/** Loader row name. */
export const name = 'session-watch'

/**
 * `commands` renders `/watch`; `webServer` carries the route the sidebar reads;
 * `agents` supplies live status without waking anything.
 *
 * `sessionController` is deliberately NOT listed here. It is needed only by the
 * resume path, and declaring it would make the WHOLE plugin — including the
 * read-only detection layer and its route — refuse to apply on any host where
 * that service is absent or not yet ready. A plugin whose entire value is
 * observation must not be blocked by an optional capability, so the resume path
 * looks the service up at call time instead (see {@link resumeSession}).
 */
export const inject = ['commands', 'webServer', 'agents']

/** Route prefix for the sidebar and for scripts. */
const ROUTE_PREFIX = '/session-watch/api'
/** Guard header, mirroring the sibling window-pin plugin's cross-site defence. */
const GUARD_HEADER = 'x-session-watch'

/** Trailing events retained per session when classifying. */
const TAIL_LIMIT = 400

/** The agent preset that carries the expert's tools. */
const PRESET_ID = 'user-proxy'

/**
 * How long a snapshot may be reused before a read triggers a rescan.
 *
 * Deliberately much shorter than the `pollMs` background interval: this is not the scan
 * cadence, it is only a guard against a burst of reads each paying for a full scan. Two
 * seconds keeps the UI responsive while still letting an explicit reopen pick up changes
 * promptly. `/refresh` and the resume path bypass it entirely.
 */
const CACHE_MS = 2000

/** Tool names the expert's half contributes, in the order they are declared. */
const PROXY_TOOL_NAMES = ['session_roster', 'session_review', 'session_resume']

/**
 * Defaults, every one overridable from the Loader row's `config` so the
 * deployment can tune them without editing this file.
 */
const DEFAULTS = {
  /** Silence after which a running session counts as stalled. */
  stallMs: 5 * 60 * 1000,
  /** Sessions younger than this are not judged; they have not had time to stall. */
  minAgeMs: 60 * 1000,
  /** How often the snapshot is refreshed in the background. */
  pollMs: 30 * 1000,
  /** Sessions considered when building a snapshot. */
  maxSessions: 200,
}

/**
 * Cordis configuration schema: the documented defaults, plus the Standard Schema
 * contract the deployed Loader actually calls.
 *
 * WHY `~standard` IS REQUIRED (measured, not assumed)
 *
 * The deployed 0.2.0-rc.2 Cordis validates a plugin's config with
 *
 *     function resolveConfig(runtime, config) {
 *       if (!runtime.Config) return config;
 *       const result = runtime.Config["~standard"].validate(config);   // <-- cordis/lib/index.js:958
 *       if ("then" in result) throw new TypeError("Async config validation is not supported");
 *       if (result.issues) throw new ValidationError(result.issues);
 *       else return result.value;
 *     }
 *
 * so a truthy `Config` WITHOUT `~standard` throws
 * `TypeError: Cannot read properties of undefined (reading 'validate')` during
 * activation and the whole plugin row is reported as `fiberPhase: "failed"`.
 * This object previously declared only the default values, which is why the row
 * failed to activate once its module became importable again.
 *
 * The default keys are kept as own properties on purpose: the tests and callers
 * read `Config` directly as a defaults object (`{ ...Config, ...overrides }`),
 * and `resolveConfig` below reads only the keys it knows, so the extra
 * `~standard` member is inert for them.
 *
 * The `resume` block defaults to DISABLED. Installing this plugin must not change
 * the harness's behaviour until the user has looked at the detector's verdicts on
 * real traffic and opted in.
 * @type {object}
 */
export const Config = {
  stallMs: DEFAULTS.stallMs,
  minAgeMs: DEFAULTS.minAgeMs,
  pollMs: DEFAULTS.pollMs,
  maxSessions: DEFAULTS.maxSessions,
  resume: { ...RESUME_DEFAULTS },
  '~standard': {
    version: 1,
    vendor: 'dsh-session-watch',
    /**
     * Accept any partial block and hand it back unchanged: `resolveConfig` below
     * is the single place that fills defaults, and it already tolerates missing
     * keys, so duplicating that logic here would create two sources of truth.
     * @param {unknown} value - the row's raw `config`.
     * @returns {{value: object} | {issues: object[]}} the validated config.
     */
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'session-watch config must be an object', path: [] }] }
      }
      return { value: { ...value } }
    },
  },
}

/**
 * Resolve the effective configuration, tolerating a partially supplied block.
 * @param {any} config - the Loader-supplied configuration.
 * @returns {object} a complete configuration.
 */
function resolveConfig(config) {
  const resume = config?.resume ?? {}
  /** Pick a finite number, else the default. */
  const num = (value, fallback) => (Number.isFinite(value) ? value : fallback)
  return {
    stallMs: num(config?.stallMs, DEFAULTS.stallMs),
    minAgeMs: num(config?.minAgeMs, DEFAULTS.minAgeMs),
    pollMs: num(config?.pollMs, DEFAULTS.pollMs),
    maxSessions: num(config?.maxSessions, DEFAULTS.maxSessions),
    resume: {
      enabled: resume.enabled === true,
      maxAttempts: num(resume.maxAttempts, RESUME_DEFAULTS.maxAttempts),
      baseDelayMs: num(resume.baseDelayMs, RESUME_DEFAULTS.baseDelayMs),
      maxDelayMs: num(resume.maxDelayMs, RESUME_DEFAULTS.maxDelayMs),
      cooldownMs: num(resume.cooldownMs, RESUME_DEFAULTS.cooldownMs),
      promptTemplate: typeof resume.promptTemplate === 'string' ? resume.promptTemplate : null,
    },
  }
}

/**
 * Read live Agent status and a live lookup without activating anything.
 *
 * `ctx.agents.list()` returns the agents already LIVE in this process, so this
 * read is purely observational: a session that is cold on disk simply has no
 * agent here and is treated as not running. That absence is the honest answer —
 * nothing is driving it — and it is exactly what lets the watcher judge a stalled
 * session without resuming it (resuming to observe would make watching
 * self-defeating).
 * @param {any} ctx - the Cordis context.
 * @returns {{running: Map<string, boolean>, busy: Set<string>}} live status.
 */
function liveStatus(ctx) {
  /** @type {Map<string, boolean>} */
  const running = new Map()
  try {
    const agents = ctx.get('agents')
    if (agents === undefined || agents === null) return { running, busy: new Set() }
    for (const agent of agents.list() ?? []) {
      const id = agent?.session?.id
      if (typeof id === 'string') running.set(id, agent?.status === 'running')
    }
  } catch {
    // A missing registry degrades to "nothing is running".
    //
    // DO NOT treat that as merely cosmetic. This comment used to claim it "can only cause a
    // REPORT, never a wrong automatic action" — and that was FALSE, because `running: false`
    // was one of the two ways `detect.js` reached `stalled`, and `stalled` is the only
    // auto-resumable verdict. A restart leaves EVERY session without a live agent, so the
    // degraded value fed straight into automatic nudges: measured on the live host, two
    // sessions were poked 13 s after boot with silences of 6 s and 0 s.
    //
    // The fix belongs in the detector (the silence window now applies whether or not an
    // agent is live), so this degradation is no longer sufficient on its own to act. Keep
    // it that way: if a classifier ever again derives an actionable verdict from "no agent
    // here", it will be wrong for every session in a freshly started process.
  }
  return { running, busy: new Set() }
}

/**
 * Collect and classify every watched session, WITHOUT performing any action.
 *
 * This is the single read path. Both the sidebar snapshot and the user-proxy
 * expert's tools go through it, so the verdict a person sees in the panel and the
 * verdict the expert reasons about can never drift apart — two independent
 * scanners would eventually disagree, and then neither could be trusted.
 *
 * It returns the COMPLETE snapshot shape, with `resumed` empty and the resume totals
 * zero. That matters: the expert's `session_roster` consumes a snapshot, so if this
 * function returned a different shape the expert would silently read `undefined`
 * fields instead of failing loudly. One shape, one meaning.
 *
 * It is deliberately side-effect free: it reads logs, consults live status, and
 * evaluates the resume gate so callers can EXPLAIN a refusal, but it never calls
 * `sessionController.prompt`. Only {@link buildSnapshot} does that, after this
 * returns.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} config - configuration; normalized internally.
 * @returns {Promise<object>} the classified snapshot, with no action taken.
 */
export async function collectSessions(ctx, config) {
  const settings = resolveConfig(config)
  const home = dshHome()
  const logs = findSessionLogs(home)
  const { running } = liveStatus(ctx)
  const now = Date.now()
  const ledger = readLedger()

  // Newest first: the sessions worth noticing are the recent ones.
  const selected = logs.slice(-settings.maxSessions).reverse()

  /** @type {object[]} */
  const sessions = []
  for (const log of selected) {
    const { events, readable } = await readSessionLog(log.file)
    const header = headerOf(events)
    const sessionId = header.id ?? log.sessionId
    const isSubagent = header.delegationDepth > 0
    const isRunning = running.get(sessionId) === true

    const verdict = classifySession({
      events: tailEvents(events, TAIL_LIMIT),
      running: isRunning,
      isSubagent,
      now,
      stallMs: settings.stallMs,
      minAgeMs: settings.minAgeMs,
      readable,
    })

    const record = ledger.sessions[sessionId] ?? { attempts: 0, lastAttemptAt: null, history: [] }
    const last = Array.isArray(record.history) && record.history.length > 0
      ? record.history[record.history.length - 1]
      : null

    // Evaluate the resume gate for EVERY session, including ones that will be
    // refused, so the UI can explain why nothing was done. A silent refusal is
    // indistinguishable from a broken watcher.
    const decision = decideResume(
      { verdict: verdict.verdict, busy: isRunning, now, record },
      settings.resume,
    )

    sessions.push({
      sessionId,
      cwd: header.cwd,
      isSubagent,
      running: isRunning,
      autoResumable: AUTO_RESUMABLE.has(verdict.verdict),
      resume: {
        willResume: decision.resume,
        reason: decision.reason,
        detail: decision.detail,
        attempts: record.attempts,
        lastAttemptAt: record.lastAttemptAt,
        nextDelayMs: decision.nextDelayMs,
        // WHO did it, and how it went. Without this the panel can only say "resumed
        // twice" — which hides the difference between the watcher acting on its own
        // and the user-proxy expert acting on the user's behalf. Those are not the
        // same event, and an automatic action nobody can attribute is
        // indistinguishable from the harness acting alone.
        lastAttemptBy: last?.by ?? null,
        lastAttemptOk: typeof last?.ok === 'boolean' ? last.ok : null,
        lastAttemptCode: typeof last?.code === 'string' ? last.code : null,
        history: (Array.isArray(record.history) ? record.history : []).slice(-5).map(entry => ({
          at: entry?.at ?? null,
          by: entry?.by ?? null,
          ok: entry?.ok === true,
          code: typeof entry?.code === 'string' ? entry.code : null,
        })),
      },
      eventCount: events.length,
      lastActivityAt: log.mtimeMs,
      verdict: verdict.verdict,
      detail: verdict.detail,
      lastType: verdict.lastType,
      lastSeq: verdict.lastSeq,
      turn: verdict.turn,
      step: verdict.step,
      silentMs: verdict.silentMs,
    })
  }

  const attention = sessions.filter(session => session.verdict === 'stalled')

  // Report whether the EXPERT half is actually mounted, not merely installed.
  //
  // This belongs in the snapshot rather than only in `/diagnostics` because it is the
  // one fact about layer 3 the user cannot otherwise see: the preset can be installed,
  // composed, and its row `active`, while the composition still failed to activate —
  // and from the sidebar those states look identical. Keyed by PID, so a record left by
  // a PREVIOUS process cannot read as a healthy mount in this one.
  const proxyMount = readProxyMount()
  const proxyMounted = proxyMount !== null && proxyMount.pid === process.pid

  // Attach the layer-3 handoff to every session the policy has deliberately stopped
  // acting on, so the loop actually closes: detection -> policy OR expert -> next step.
  //
  // Done HERE rather than in `diagnostics` so it rides along on the snapshot the sidebar,
  // `/watch` and the expert's `session_roster` all read. (`expertMounted` is passed in
  // because whether the advice may name the expert depends on it.)
  for (const session of sessions) {
    const handoff = handoffFor(session, proxyMounted)
    if (handoff !== null) session.handoff = handoff
  }

  return {
    ok: true,
    generatedAt: now,
    home,
    stallMs: settings.stallMs,
    minAgeMs: settings.minAgeMs,
    resumeEnabled: settings.resume.enabled,
    resumePolicy: {
      maxAttempts: settings.resume.maxAttempts,
      baseDelayMs: settings.resume.baseDelayMs,
      maxDelayMs: settings.resume.maxDelayMs,
      cooldownMs: settings.resume.cooldownMs,
    },
    /** Whether the user-proxy expert's tools are live in this process. */
    expert: {
      mounted: proxyMounted,
      tools: proxyMounted && Array.isArray(proxyMount.tools) ? proxyMount.tools : [],
      mountedAt: proxyMounted ? proxyMount.mountedAt : null,
      /** A record from another process means the expert has NOT loaded here. */
      staleFromPid: proxyMount !== null && !proxyMounted ? proxyMount.pid : null,
    },
    /** Resume attempts performed by THIS scan, successful or not. */
    resumed: [],
    totals: {
      scanned: sessions.length,
      stalled: attention.length,
      awaitingApproval: sessions.filter(s => s.verdict === 'awaiting-approval').length,
      empty: sessions.filter(s => s.verdict === 'empty').length,
      subagent: sessions.filter(s => s.verdict === 'subagent').length,
      resumed: 0,
      resumeFailed: 0,
    },
    /** Sessions needing attention, most urgent first. */
    attention,
    sessions,
  }
}

/**
 * Build a full snapshot of every watched session, performing the approved resumes.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} config - resolved configuration.
 * @returns {Promise<object>} the snapshot served to the UI and the command.
 */
export async function buildSnapshot(ctx, config) {
  // Normalize here rather than trusting the caller. `buildSnapshot` is exported
  // and used by tests and scripts, so a config missing the `resume` block must
  // degrade to the (disabled) defaults instead of throwing mid-scan.
  const snapshot = await collectSessions(ctx, config)
  const settings = resolveConfig(config)
  // `collectSessions` names its timestamp `generatedAt`, NOT `now`. Destructuring `now`
  // silently yielded `undefined`, which `recordAttempt` turned into `entry.at === undefined`
  // and `JSON.stringify` turned into `null` — so every AUTOMATIC attempt carried a null
  // timestamp in the ledger's history while manual ones were fine.
  //
  // Measured on the live host after the first real automatic resume: two `by: "auto"`
  // entries both displayed as 1970-01-01. `lastAttemptAt` was unaffected (it falls back to
  // Date.now()), so backoff and the cap behaved correctly — which is exactly why this went
  // unnoticed: the mechanism worked and only the audit trail lied.
  //
  // That matters more than it sounds. The whole point of the ledger is attributing actions,
  // and a history whose timestamps are unreadable cannot answer "when did the watcher last
  // touch this?". The fallback is now explicit here rather than accidental downstream.
  const sessions = snapshot.sessions
  const now = Number.isFinite(snapshot.generatedAt) ? snapshot.generatedAt : Date.now()

  // Execute the approved nudges, in a bounded pass. This is the ONLY place the
  // watcher writes to a session, and it acts only on sessions the gate approved.
  const resumed = []
  for (const session of sessions) {
    if (session.resume.willResume !== true) continue

    // Re-check the attempt cap against the CURRENT ledger, not the one read when the
    // scan began. The expert's `session_resume` tool shares this ledger, so between
    // the scan's read and this line it may have spent an allowance. Acting on the
    // stale count would push a session past its cap — the exact loop the cap exists
    // to stop. Only the cap is re-checked; the verdict and busy gates were just
    // evaluated against fresh log and status reads.
    const live = readLedger().sessions?.[session.sessionId]
    const liveAttempts = Number.isFinite(live?.attempts) ? live.attempts : 0
    if (liveAttempts >= settings.resume.maxAttempts) continue

    // `origin: 'auto'` — this is the watcher's own nudge, the one case where the message
    // may legitimately call itself automatic.
    const outcome = await resumeSession(ctx, session, settings.resume.promptTemplate, 'auto')

    // A resume that could not even REACH the host is not an attempt against the session.
    //
    // Measured on a real boot: the first scan runs about 1 second after the process
    // starts, while `sessionController` is still initializing (it waits on
    // `workspaceRegistry`). The old code recorded `no-controller` as a normal failure, so
    // a session that happened to be stalled at boot silently lost one of its two
    // allowances to a nudge that was never sent — and after a couple of restarts it would
    // be reported as "attempts exhausted" having never actually been touched.
    //
    // `no-controller` means the harness was not ready, which is a fact about THIS PROCESS,
    // not about the session. So it is reported and retried later, but not counted.
    const hostUnavailable = outcome.code === 'no-controller'
    if (hostUnavailable) {
      ctx.logger?.warn?.(
        'session-watch: sessionController 尚未就绪，本轮跳过恢复（不计入尝试次数）',
      )
      session.resume = {
        ...session.resume,
        willResume: false,
        reason: 'host-not-ready',
        detail: 'Host 尚未就绪（sessionController 不可用）；本轮跳过，稍后重试，不计入尝试次数。',
      }
      continue
    }

    const entry = {
      sessionId: session.sessionId,
      at: now,
      ok: outcome.ok,
      error: outcome.error,
      code: outcome.code,
      by: 'auto',
      turn: session.turn,
      step: session.step,
    }
    // Recorded through the shared helper, which RE-READS the ledger before
    // incrementing. Writing the copy read at the start of the scan would clobber an
    // attempt the expert recorded in the meantime — and a lost attempt means a
    // session gets more nudges than its cap allows.
    const counters = recordAttempt(session.sessionId, entry)
    resumed.push({ ...entry, attempts: counters.attempts })

    // Rewrite the row to describe the OUTCOME rather than the intent it was built with.
    //
    // `collectSessions` computed a decision ("this will be resumed") and this loop then
    // acted on it, so the row is stale the moment the action lands. Left alone it makes
    // the panel contradict itself — measured on a real run, `/watch` printed both
    // "已发送续跑提示" and, for the same session, "本轮将恢复…（尚未自动恢复）".
    //
    // That is not cosmetic. Layer 2's whole design rests on every automatic action being
    // reportable, because an action the user cannot see is indistinguishable from the
    // harness acting on its own — and a panel that reports the PLAN while the ACTION has
    // already happened cannot be used to tell whether the nudge was sent or is pending.
    session.resume = {
      ...session.resume,
      willResume: false,
      reason: outcome.ok ? 'resumed' : 'resume-failed',
      detail: outcome.ok
        ? `本轮已发送续跑提示（turn=${session.turn ?? '?'} step=${session.step ?? '?'}）。`
        : `本轮续跑失败：${outcome.error ?? outcome.code ?? '未知原因'}`,
      attempts: counters.attempts,
      lastAttemptAt: entry.at,
      nextDelayMs: 0,
      lastAttemptBy: 'auto',
      lastAttemptOk: outcome.ok,
      lastAttemptCode: outcome.code,
      history: [...(Array.isArray(session.resume.history) ? session.resume.history : []), {
        at: entry.at,
        by: 'auto',
        ok: outcome.ok,
        code: outcome.code,
      }].slice(-5),
    }
    // The session was acted on, so any "what next" advice is now obsolete.
    delete session.handoff
  }

  return {
    ...snapshot,
    resumed,
    totals: {
      ...snapshot.totals,
      resumed: resumed.filter(entry => entry.ok).length,
      resumeFailed: resumed.filter(entry => !entry.ok).length,
    },
  }
}

/** How long a single resume admission may take before it is abandoned. */
const RESUME_TIMEOUT_MS = 30 * 1000

/**
 * Ask one stalled session to continue by admitting a prompt to it.
 *
 * `ctx.sessionController.prompt` is the Host's own "resume this Session, then
 * admit a prompt" operation: it resolves (or resumes) the Agent and queues the
 * message as an ordinary follow-up turn. That is precisely the effect of a human
 * typing 继续, which is why it is used rather than any lower-level Agent call —
 * it carries the identity, model-route and attachment validation the harness
 * already requires.
 *
 * THE `signal` ARGUMENT IS MANDATORY (this was a real bug)
 *
 * The public service method is
 *
 *     prompt(request, signal) { signal.throwIfAborted(); return this.commands.prompt(request) }
 *
 * so calling it with a request alone throws
 * `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')` — before
 * any work happens. The first version of this function passed only the request, and
 * the failure was invisible until auto-resume was switched on and the ledger recorded
 * `ok: false` with exactly that message. **Every resume attempt had failed.**
 *
 * It was easy to miss because the INNER implementation is `async prompt(request)`
 * with no signal, and that is the signature the docs describe. Only the public
 * wrapper demands one.
 *
 * So a signal is always supplied. It is also load-bearing: it bounds how long a
 * single admission may hang. A watcher whose whole job is noticing stalls must not
 * itself be able to stall, so the timeout is treated as a failed attempt and counted
 * like any other.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} session - the stalled session's observation.
 * @param {string|null} template - optional custom nudge template.
 * @param {'auto' | 'manual' | 'user-proxy' | string} [origin] - who is sending this nudge.
 *   Written into the message, because the text lands in the conversation permanently and
 *   must not claim to be automatic when a person or the expert sent it.
 * @returns {Promise<{ok: boolean, error: string|null, code: string|null}>}
 *   the outcome; a failure is reported, never thrown at the caller.
 */
export async function resumeSession(ctx, session, template, origin = 'auto') {
  const controller = ctx.get('sessionController')
  if (controller === undefined || controller === null) {
    return { ok: false, code: 'no-controller', error: 'sessionController 不可用，无法恢复。' }
  }
  const abort = new AbortController()
  const timer = setTimeout(() => { abort.abort(new Error('resume timed out')) }, RESUME_TIMEOUT_MS)
  try {
    const text = buildNudgeText(session, template, origin)
    await controller.prompt({
      // The Host persists this identity on the accepted user message, so it must
      // be unique per attempt or the message could be deduplicated away.
      requestId: randomUUID(),
      sessionId: session.sessionId,
      // `queue` is the ordinary follow-up turn. `steer` would be wrong: it would
      // inject into a turn that is believed dead rather than open a new one.
      mode: 'queue',
      content: [{ type: 'text', text }],
    }, abort.signal)
    return { ok: true, error: null, code: null }
  } catch (error) {
    // A typed failure here is expected and must not take down the watcher: a
    // session whose model route is unavailable (its provider dropped after a rate
    // limit) will legitimately refuse, and that is worth reporting rather than
    // retrying immediately.
    const code = typeof error?.code === 'string' ? error.code : null
    return { ok: false, code, error: String(error?.message ?? error) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Explain what to do about a session the policy has stopped acting on.
 *
 * WHY THIS IS NOT JUST COSMETIC
 *
 * The objective for this project is a three-layer loop: detection finds a stalled
 * session, the expert diagnoses it, and policy decides whether to resume. Layers 1 and 2
 * are automatic; layer 3 is a person (or the expert agent) deciding.
 *
 * So when the policy reaches a verdict of "report only" — attempts exhausted, or a wait
 * the rules refuse to touch — the loop is NOT finished: it has arrived at the point where
 * layer 3 is supposed to take over. Reporting only `reason` and stopping leaves the user
 * holding a stopped session with no next step, which is the same "看不过来" problem the
 * project exists to solve, one layer up.
 *
 * This returns the concrete next action, and names the expert only when it is actually
 * available — pointing at a tool that is not mounted would be worse than saying nothing.
 *
 * @param {object} session - the session row from the snapshot.
 * @param {boolean} expertMounted - whether the expert's tools are live in this process.
 * @returns {{kind: string, text: string}|null} the handoff, or null when none applies.
 */
function handoffFor(session, expertMounted) {
  const reason = session?.resume?.reason

  const manual = `POST /session-watch/api/resume?sessionId=${session.sessionId} 可手动续跑`

  if (reason === 'attempts-exhausted') {
    return {
      kind: 'attempts-exhausted',
      text: expertMounted
        ? `已用满自动恢复次数。建议用用户代理专家读它的输入输出找根因（session_review），或 ${manual}。`
        : `已用满自动恢复次数，且专家未挂载（需重启 dsh）。可以先${manual}，或重启后用专家看根因。`,
    }
  }

  // `not-stalled` is NOT one state — it is every refusal that is not the cap, and only ONE
  // of them needs a person. Advising on all of them was a real defect: measured on the live
  // host, ALL 193 sessions carried a handoff — including 113 subagents and 67 ordinary idle
  // sessions — each telling the user "规则判定不该自动恢复（idle）… 可以先手动续跑".
  //
  // Telling someone they may resume a session that never stopped is simply wrong advice, and
  // at that volume it buries the rows that DO need attention. So the advice is limited to
  // the genuinely parked states: a session waiting on an approval or a question is blocked
  // on the user, and only the user can unblock it.
  const NEEDS_HUMAN = new Set(['awaiting-approval'])
  if (!NEEDS_HUMAN.has(session?.verdict)) return null

  return {
    kind: 'needs-human',
    text: expertMounted
      ? `正在等你（${session.verdict}）。用用户代理专家读一下它在等什么，或直接去处理它。`
      : `正在等你（${session.verdict}）。专家未挂载（需重启 dsh 才会加载）；直接去处理它即可。`,
  }
}

/**
 * Send a JSON body.
 * @param {any} res - the HTTP response.
 * @param {number} status - HTTP status code.
 * @param {unknown} body - JSON-serializable payload.
 * @returns {void}
 */
function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

/**
 * Report what an agent composed from the `user-proxy` preset would actually SEE.
 *
 * WHY THIS IS NOT REDUNDANT WITH THE MOUNT RECORD
 *
 * The mount record proves the preset's row applied and registered three tools — in the
 * PRESET'S scope. It does not prove those registrations are visible to an agent composed
 * from that preset. That step relies on `dsh-scope`'s visibility rules (a child scope
 * inherits its ancestors' layers), which is a claim read from documentation, not observed
 * behaviour.
 *
 * "Registered somewhere" and "the agent can call it" are different facts, and this
 * project has repeatedly been burned by exactly that gap. So this reads the preset's
 * scope through the registry — the same lease mechanism the transcript presenter uses —
 * and lists the tools visible in it.
 *
 * @param {any} ctx - the Cordis context.
 * @returns {Promise<object>} the visible-tool report, or an explanation of why it is unknown.
 */
async function expertScopeReport(ctx) {
  const presets = ctx.get('agentPresets')
  const tools = ctx.get('tools')
  if (presets === undefined || presets === null || typeof presets.acquireScope !== 'function') {
    return { known: false, reason: 'agentPresets 服务不可用，无法读取 preset 作用域' }
  }
  if (tools === undefined || tools === null || typeof tools.schemas !== 'function') {
    return { known: false, reason: 'tools 服务不可用，无法读取作用域内工具' }
  }

  /**
   * Read the tool names visible inside one preset's scope.
   * @param {string} presetId - preset identity.
   * @returns {Promise<string[]>} the visible tool names.
   */
  async function visibleIn(presetId) {
    const lease = await presets.acquireScope(presetId)
    try {
      return tools.schemas(lease.key).map(schema => schema.name)
    } finally {
      try { await lease[Symbol.asyncDispose]() } catch { /* ignore */ }
    }
  }

  try {
    const inProxy = await visibleIn(PRESET_ID)
    const report = {
      known: true,
      preset: PRESET_ID,
      visibleCount: inProxy.length,
      /** The three tools this plugin contributes, as seen from inside the preset. */
      proxyToolsVisible: PROXY_TOOL_NAMES.filter(name => inProxy.includes(name)),
      proxyToolsMissing: PROXY_TOOL_NAMES.filter(name => !inProxy.includes(name)),
    }

    // The ISOLATION half of the claim, observed rather than argued.
    //
    // "The expert can see its tools" is only half of what matters; the other half is
    // that ordinary sessions CANNOT. That is the security boundary — these tools read
    // every session's conversation — and it was previously asserted only structurally
    // (the row is absent from `standard`'s patch). Reading the standard scope here makes
    // it a measurement.
    try {
      const inStandard = await visibleIn('standard')
      report.standardSeesProxyTools = PROXY_TOOL_NAMES.filter(name => inStandard.includes(name))
      report.isolatedFromStandard = report.standardSeesProxyTools.length === 0
      report.standardVisibleCount = inStandard.length
    } catch (error) {
      report.isolatedFromStandard = null
      report.isolationReason = String(error?.message ?? error)
    }

    return report
  } catch (error) {
    return { known: false, reason: String(error?.message ?? error) }
  }
}

/**
 * Report what this plugin can see about its own wiring, read-only.
 *
 * The question it answers is the one that cost this project two misdiagnoses: is the
 * preset actually MOUNTED, or merely declared? A bundle row can be present and
 * correctly resolved while the preset composition fails to activate, and from outside
 * the Host process those two states look identical.
 *
 * @param {any} ctx - the Cordis context.
 * @returns {object} the diagnostic report.
 */
async function diagnostics(ctx) {
  /** @type {object[]} */
  const services = []
  for (const name of ['tools', 'sessionQuery', 'sessionController', 'agents', SERVICE_NAME]) {
    let present = false
    try {
      present = ctx.get(name) !== undefined && ctx.get(name) !== null
    } catch {
      present = false
    }
    services.push({ name, present })
  }

  // Which tools this plugin's proxy half would contribute, and whether the module
  // resolves from here at all. A resolution failure is the single most likely reason
  // the preset row would refuse to mount.
  let proxyModule = null
  try {
    const resolved = import.meta.resolve('@local/dsh-session-watch/proxy')
    proxyModule = { resolved, ok: true }
  } catch (error) {
    proxyModule = { resolved: null, ok: false, error: String(error?.message ?? error) }
  }

  // The decisive fact: did the preset composition actually MOUNT? A bundle row can be
  // `active` while its composition failed to activate, so the row's own state cannot
  // answer this. The expert half writes a record when its `apply` runs, and its
  // absence is the proof that nothing mounted.
  //
  // The record is keyed by PID, because a record left by a PREVIOUS host process would
  // otherwise read as a healthy mount in a process where the expert never loaded — the
  // exact false positive this check exists to prevent.
  const mount = readProxyMount()
  const mountIsCurrent = mount !== null && mount.pid === process.pid

  // Report whether an agent under the preset can actually SEE the tools, which is a
  // separate fact from whether they were registered. See `expertScopeReport`.
  const scope = await expertScopeReport(ctx)

  return {
    ok: true,
    generatedAt: Date.now(),
    home: dshHome(),
    pid: process.pid,
    services,
    proxyModule,
    proxyMounted: mountIsCurrent,
    proxyMount: mountIsCurrent ? mount : null,
    /** Present but from another process — i.e. the expert half has NOT loaded here. */
    staleProxyMount: mount !== null && !mountIsCurrent ? mount : null,
    /** Whether an agent composed from the preset would see the expert's tools. */
    expertScope: scope,
    /** Tool names the expert's tools contribute, whether or not a preset mounted them. */
    proxyToolNames: PROXY_TOOL_NAMES,
    serviceName: SERVICE_NAME,
  }
}

/**
 * Render a snapshot as the text `/watch` prints.
 * @param {object} snapshot - a snapshot from {@link buildSnapshot}.
 * @returns {{kind: string, text: string}} the command result.
 */
export function renderSnapshot(snapshot) {
  const { totals } = snapshot
  const lines = [
    `已扫描 ${totals.scanned} 个会话：${totals.stalled} 个静默停摆，`
    + `${totals.awaitingApproval} 个等待审批，${totals.empty} 个空会话，${totals.subagent} 个 subagent。`,
    `判定口径：running 且日志 ${Math.round(snapshot.stallMs / 1000)}s 无推进；会话年龄需超过 ${Math.round(snapshot.minAgeMs / 1000)}s。`,
    snapshot.resumeEnabled === true
      ? `自动恢复：已启用（每会话上限 ${snapshot.resumePolicy.maxAttempts} 次，`
        + `基础退避 ${Math.round(snapshot.resumePolicy.baseDelayMs / 1000)}s，`
        + `上限 ${Math.round(snapshot.resumePolicy.maxDelayMs / 1000)}s）。`
      : '自动恢复：未启用（仅报告；需要时把 resume.enabled 设为 true）。',
    // Layer 3's only externally visible state. "Installed" and "mounted" are different
    // facts, and only the second means the expert can actually be used.
    snapshot.expert?.mounted === true
      ? `用户代理专家：已挂载（${(snapshot.expert.tools ?? []).join(', ')}）。`
      : '用户代理专家：未挂载（第 3 层不可用；装好后需要重启 dsh 才会加载）。',
  ]

  if (Array.isArray(snapshot.resumed) && snapshot.resumed.length > 0) {
    lines.push('')
    lines.push('本轮自动恢复尝试：')
    for (const entry of snapshot.resumed) {
      lines.push(entry.ok
        ? `- ${entry.sessionId}：已发送续跑提示（turn=${entry.turn ?? '?'} step=${entry.step ?? '?'}）`
        : `- ${entry.sessionId}：失败（${entry.code ?? '未知'}）${entry.error ?? ''}`)
    }
  }

  if (snapshot.attention.length === 0) {
    lines.push('当前没有被判定为静默停摆的会话。')
    return { kind: 'success', text: lines.join('\n') }
  }

  lines.push('')
  lines.push('需要关注的会话：')
  for (const session of snapshot.attention) {
    const where = session.cwd ?? '(未知目录)'
    lines.push(`- ${session.sessionId}`)
    lines.push(`  目录：${where}`)
    lines.push(`  位置：turn=${session.turn ?? '?'} step=${session.step ?? '?'}，事件数 ${session.eventCount}`)
    lines.push(`  最后事件：${session.lastType ?? '未知'}，静默 ${Math.round(session.silentMs / 1000)}s`)
    lines.push(`  判定：${session.detail}`)
    if (session.resume !== undefined) {
      const history = session.resume.attempts === 0
        ? '尚未自动恢复'
        : `已恢复 ${session.resume.attempts} 次`
      lines.push(`  自动恢复：${session.resume.willResume ? '本轮将恢复' : '不恢复'}——${session.resume.detail}（${history}）`)
      // Name the author of the last attempt. "两次" alone hides whether the watcher acted
      // on its own, the expert acted for the user, or the user did it themselves — and a
      // two-way split reported a manual nudge as the expert's work.
      if (session.resume.lastAttemptBy !== null && session.resume.lastAttemptBy !== undefined) {
        const by = session.resume.lastAttemptBy
        const who = by === 'auto'
          ? '自动'
          : by === 'manual' ? '你本人' : `专家(${by})`
        const how = session.resume.lastAttemptOk === true
          ? '成功'
          : `失败${session.resume.lastAttemptCode === null || session.resume.lastAttemptCode === undefined ? '' : `（${session.resume.lastAttemptCode}）`}`
        lines.push(`  上一次由：${who} 发起，${how}`)
      }
    }
    // The next step. Without it a stopped session is reported with no way forward, which
    // is the original problem one layer up.
    if (session.handoff !== undefined && session.handoff !== null) {
      lines.push(`  下一步：${session.handoff.text}`)
    }
  }
  return { kind: 'success', text: lines.join('\n') }
}

/**
 * Mount the Host half.
 * @param {any} ctx - the Cordis context.
 * @param {object} [config] - Loader-supplied configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const resolved = resolveConfig(config)

  // The most recent snapshot, refreshed in the background.
  /** @type {object|null} */
  let cached = null
  /** Timestamp of the snapshot in `cached`, for the freshness window. */
  let cachedAt = 0
  let refreshing = false

  /**
   * Serve the cached snapshot when it is fresh enough, else scan.
   *
   * WHY A FRESHNESS WINDOW AND NOT JUST A CACHE
   *
   * The first version of this function returned the cache only to COLLAPSE CONCURRENT
   * calls: any non-overlapping read triggered a full rescan. Measured on this host, a
   * scan takes ~3.5s for 190 sessions — and the sidebar polls this route, so every poll
   * paid that cost and the UI could sit for seconds before drawing. The background timer
   * was doing its job; nothing ever consumed what it produced.
   *
   * A short window fixes that: a read arriving within `CACHE_MS` of the last scan is
   * answered from memory, so the normal polling path is O(1) and the disk work happens on
   * the timer instead of on the user's request. `/refresh` and the auto-resume path
   * bypass the window, so an explicit refresh and a resume decision always see live data.
   *
   * @param {boolean} [force] - scan even when the cache is still fresh.
   * @returns {Promise<object>} the freshest snapshot available.
   */
  async function refresh(force = false) {
    if (force !== true && cached !== null && Date.now() - cachedAt < CACHE_MS) return cached
    if (refreshing && cached !== null) return cached
    refreshing = true
    try {
      cached = await buildSnapshot(ctx, resolved)
      cachedAt = Date.now()
      // Publish for the expert's tools, so `session_roster` reports exactly what the
      // sidebar shows instead of running a second, divergent scan.
      publishSnapshot(cached)
      return cached
    } catch (error) {
      ctx.logger?.warn?.('session-watch: 扫描失败: %s', String(error?.message ?? error))
      return cached ?? {
        ok: false,
        generatedAt: Date.now(),
        error: String(error?.message ?? error),
        totals: { scanned: 0, stalled: 0, awaitingApproval: 0, empty: 0, subagent: 0 },
        attention: [],
        sessions: [],
        stallMs: resolved.stallMs,
        minAgeMs: resolved.minAgeMs,
      }
    } finally {
      refreshing = false
    }
  }

  void refresh()
  const timer = setInterval(() => { void refresh() }, resolved.pollMs)
  ctx.effect(() => () => { clearInterval(timer) }, 'session-watch: poll timer')

  // Publish the read path as a service so the expert's tools can read the same
  // verdicts the sidebar shows. Deliberately READ-ONLY: the expert gets the
  // snapshot and can ask for a fresh scan, but resume stays behind `resumeSession`
  // and its ledger, so the two halves cannot diverge on what was attempted.
  //
  // Guarded because this is an OPTIMIZATION, not a requirement. The expert already
  // reaches the same snapshot through the module-level holder in `shared.js`; a
  // context without `provide` (a stub, an older Cordis) must lose the convenience,
  // never the plugin. Declaring it in `inject` would have been the other way to get
  // this wrong: an unsatisfiable injection stops the whole plugin from applying,
  // which is the exact failure this plugin was already burned by once.
  ctx.effect(() => {
    if (typeof ctx.provide !== 'function') return () => {}
    const dispose = ctx.provide(SERVICE_NAME, {
      /** Latest snapshot, refreshed if none has been produced yet. */
      snapshot: async () => await refresh(),
      /** Force a rescan. */
      refresh: async () => await refresh(),
      /** The service name, for diagnostics. */
      name: SERVICE_NAME,
    })
    return () => { dispose() }
  }, `session-watch: ${SERVICE_NAME} service`)

  ctx.effect(function* () {
    yield ctx.commands.register({
      name: 'watch',
      description: '列出本机所有会话中静默停摆的那些（/watch 扫描，/watch json 输出原始快照）',
      handler: async (invocation) => {
        const argument = String(invocation?.rawInput ?? '').trim().toLowerCase()
        const snapshot = await refresh()
        if (argument === 'json') return { kind: 'success', text: JSON.stringify(snapshot, null, 2) }
        if (argument !== '') {
          return { kind: 'error', text: '用法：/watch（扫描并列出）、/watch json（输出原始快照）' }
        }
        return renderSnapshot(snapshot)
      },
    })
  }, 'session-watch: /watch')

  ctx.effect(() => {
    const disposeRoute = ctx.webServer.register({
      kind: 'prefix',
      path: ROUTE_PREFIX,
      handler: async (req, res) => {
        try {
          if (req.headers[GUARD_HEADER] === undefined) {
            sendJson(res, 403, { ok: false, error: '缺少 x-session-watch 请求头（跨站请求已拒绝）' })
            return
          }
          const url = new URL(req.url ?? '/', 'http://127.0.0.1')
          const route = url.pathname.startsWith(ROUTE_PREFIX)
            ? url.pathname.slice(ROUTE_PREFIX.length)
            : url.pathname
          if (req.method === 'GET' && (route === '/state' || route === '')) {
            sendJson(res, 200, await refresh())
            return
          }
          if (req.method === 'POST' && route === '/refresh') {
            // Forced: an explicit refresh is a user asking for current data, so it must
            // not be answered from the freshness window.
            sendJson(res, 200, await refresh(true))
            return
          }
          // Read-only self-diagnosis. Exists because "the bundle is installed" and
          // "the preset actually mounted" are different facts, and the second one is
          // invisible from outside the Host process. Answering it here means a mount
          // failure is a one-command diagnosis instead of an inference.
          if (req.method === 'GET' && route === '/diagnostics') {
            sendJson(res, 200, await diagnostics(ctx))
            return
          }
          // Manual resume of ONE session by id. This is deliberately independent of
          // the automatic gate and of the attempt ledger: it is a user action, so
          // the user's own judgement replaces every policy check. It exists so the
          // resume mechanism can be exercised before automation is switched on.
          if (req.method === 'POST' && route === '/resume') {
            const sessionId = url.searchParams.get('sessionId')
            if (typeof sessionId !== 'string' || sessionId === '') {
              sendJson(res, 400, { ok: false, error: '需要 ?sessionId=<会话 id>' })
              return
            }
            // Forced: a resume decision must rest on current state, never on a snapshot
            // that might be a couple of seconds stale — the verdict is the whole basis
            // for touching the session.
            const snapshot = await refresh(true)
            const session = snapshot.sessions.find(entry => entry.sessionId === sessionId)
            if (session === undefined) {
              sendJson(res, 404, { ok: false, error: `未找到会话 ${sessionId}` })
              return
            }
            // `origin: 'manual'` — a person called this route, and the message written into
            // the session must say so rather than claiming the watcher acted alone.
            const outcome = await resumeSession(ctx, session, resolved.resume.promptTemplate, 'manual')

            // Recorded, for the same reason the expert's tool records: the ledger is the
            // single account of what was TRIED against a session, and this route is a
            // resume like any other. It is deliberately exempt from the automatic GATE
            // (a user action replaces the policy checks), but exemption from the gate is
            // not a licence to act invisibly — an unrecorded action is indistinguishable
            // from the harness acting on its own.
            //
            // Guarded like the auto path: a resume that never reached the Host says
            // nothing about the session, so it must not spend an allowance.
            if (outcome.code !== 'no-controller') {
              recordAttempt(sessionId, {
                sessionId,
                at: Date.now(),
                ok: outcome.ok,
                error: outcome.error,
                code: outcome.code,
                by: 'manual',
                turn: session.turn,
                step: session.step,
              })
            } else {
              ctx.logger?.warn?.('session-watch: 手动恢复时 sessionController 不可用（未计入尝试次数）')
            }

            sendJson(res, outcome.ok ? 200 : 502, {
              ok: outcome.ok,
              sessionId,
              verdict: session.verdict,
              code: outcome.code,
              error: outcome.error,
            })
            return
          }
          sendJson(res, 404, { ok: false, error: `未知接口：${req.method} ${url.pathname}` })
        } catch (error) {
          if (!res.headersSent) sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
          else res.destroy()
        }
      },
    })
    return () => { disposeRoute() }
  }, `session-watch: ${ROUTE_PREFIX}`)
}
