/**
 * The user-proxy expert's tools (`dsh-session-watch/proxy`).
 *
 * WHAT THIS IS
 *
 * The original request was for "an identity tagged as the user's proxy that has
 * every session's input and output, so a problem in any one conversation can be
 * diagnosed and continued". This module is the tool surface of that identity.
 *
 * It is mounted as a ROW INSIDE AN AGENT PRESET, which is what makes the scoping
 * fall out for free: a plugin row's `apply` runs in the preset's registry scope, so
 * `ctx.tools.register()` here is visible only to agents composed from that preset.
 * No runtime check, no allow-list, nothing to forget — a `standard` session simply
 * does not have these tools. See `_recon/IMPLEMENTATION-RECON.md` for the evidence.
 *
 * THE THREE RULES THIS MODULE FOLLOWS
 *
 *   1. DETERMINISM STAYS IN THE CODE. Whether a session is stalled is decided by
 *      `detect.js`, never by the model. These tools PRESENT facts; the expert
 *      interprets them. A model asked to guess "is this stalled" would eventually
 *      answer a pending approval on the user's behalf.
 *   2. READING AND WRITING ARE SEPARATE TOOLS. Two tools are strictly read-only.
 *      Exactly one can change anything, and it says so in its name and description.
 *   3. EVERY ACTION IS OBSERVABLE. A resume performed here goes through the same
 *      ledger as an automatic one, so the sidebar and `/watch` both report it. An
 *      action nobody can see is indistinguishable from the harness acting alone.
 *
 * @module dsh-session-watch/proxy
 */

import { classifySession, AUTO_RESUMABLE } from './detect.js'
import { findSessionLogs, headerOf, readSessionLog, tailEvents } from './logs.js'
import { buildTranscript, summarizeStop } from './transcript.js'
import { decideResume, buildNudgeText } from './resume.js'
import { SERVICE_NAME, readPublishedSnapshot, recordProxyMount } from './shared.js'

// The ledger lives in its own module rather than in `plugin.js`, so this half does NOT
// import the Host half. See `./ledger.js` for the load-time failure that coupling
// caused: a newly added export in `plugin.js` made this module fail to import against
// the loader's still-cached older copy, and a missing export is a LOAD-TIME error —
// so the entire expert half failed to mount, not one tool.
//
// `resumeSession` is the one Host-half function this half needs, and it is imported
// lazily below for the same reason: a static import of it would reintroduce exactly
// that coupling.
import { readLedger, recordAttempt, attemptsFor, dshHome } from './ledger.js'

/** Cordis plugin name. */
export const name = 'session-watch-proxy'

/**
 * Services these tools need.
 *
 * `sessionQuery` and `sessionController` are the Host's own session services. They
 * are NOT workspace-scoped for a plugin caller: `sessionQuery`'s own README states
 * "No caller authorization — this is trusted context-wide infrastructure", and the
 * agent-facing `session_query` TOOL (which IS caller-scoped) is not even installed
 * in this build. That is precisely why the expert reads through the Host service
 * and not through a model tool.
 *
 * They are looked up at CALL time rather than declared here, for the reason this
 * plugin already learned the hard way: a Cordis plugin whose `inject` cannot be
 * satisfied does not apply AT ALL, so declaring an optional capability would take
 * the whole expert offline instead of degrading one tool.
 */
export const inject = ['tools']

/** Trailing events retained when re-classifying a session for a read. */
const TAIL_LIMIT = 400

/**
 * Map every on-disk session log by the id in its HEADER.
 *
 * Keyed by header id rather than directory name on purpose: a log's directory is
 * named for the session that created it, but a seeded, forked or renamed log can
 * carry a different id in its header. Looking up by directory name alone would
 * silently miss those. Only the newest entries are indexed, because an id lookup
 * only ever targets a session recent enough to be worth reading.
 *
 * @param {number} [scanLimit] - how many recent logs to index.
 * @returns {Promise<Map<string, object>>} header id -> log descriptor.
 */
async function indexLogsByHeaderId(scanLimit = 200) {
  /** @type {Map<string, object>} */
  const byId = new Map()
  const recent = findSessionLogs(dshHome()).slice(-Math.max(1, scanLimit))
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const log = recent[i]
    if (byId.has(log.sessionId)) continue
    // Index the directory name immediately, then let a header read refine it.
    byId.set(log.sessionId, log)
    const { events, readable } = await readSessionLog(log.file)
    if (!readable) continue
    const headerId = headerOf(events).id
    if (typeof headerId === 'string' && !byId.has(headerId)) byId.set(headerId, log)
  }
  return byId
}

/**
 * Resolve a session's identity to its on-disk log, if it still exists.
 * @param {string} sessionId - the durable session id.
 * @returns {Promise<object|null>} the log descriptor, or null when no log matches.
 */
async function findLogFor(sessionId) {
  const byId = await indexLogsByHeaderId()
  return byId.get(sessionId) ?? null
}

/**
 * Read one session's events through the best available seam.
 *
 * Prefers `ctx.sessionQuery` (live-preferred and authoritative); falls back to the
 * raw log file when the service is absent. The fallback is not a nicety: without
 * it, a deployment that does not mount `sessionQuery` would make the expert blind
 * rather than merely slightly staler.
 *
 * @param {any} ctx - the Cordis context.
 * @param {string} sessionId - the session to read.
 * @returns {Promise<{events: any[], source: string, readable: boolean}>} the events.
 */
async function readEvents(ctx, sessionId) {
  const query = ctx.get('sessionQuery')
  if (query !== undefined && query !== null) {
    try {
      // `readSession` replay-validates the complete logical log without making the
      // session live — reading must never wake a stalled conversation.
      const snapshot = await query.readSession(sessionId)
      if (snapshot !== undefined && Array.isArray(snapshot.events)) {
        return { events: snapshot.events, source: 'sessionQuery', readable: true }
      }
    } catch {
      // Fall through to the file seam; a query failure must not become a blind spot.
    }
  }
  const log = await findLogFor(sessionId)
  if (log === null) return { events: [], source: 'none', readable: false }
  const { events, readable } = await readSessionLog(log.file)
  return { events, source: 'log', readable }
}

/**
 * Classify one session right now, using the same detector the panel uses.
 * @param {any} ctx - the Cordis context.
 * @param {string} sessionId - the session to classify.
 * @param {object} settings - resolved config.
 * @returns {Promise<object|null>} the classification, or null when unreadable.
 */
async function classifyOne(ctx, sessionId, settings) {
  const { events, source, readable } = await readEvents(ctx, sessionId)
  if (!readable) return null
  const header = headerOf(events)
  let running = false
  try {
    const agents = ctx.get('agents')
    for (const agent of agents?.list?.() ?? []) {
      if (agent?.session?.id === sessionId) running = agent?.status === 'running'
    }
  } catch {
    running = false
  }
  const verdict = classifySession({
    events: tailEvents(events, TAIL_LIMIT),
    running,
    isSubagent: header.delegationDepth > 0,
    now: Date.now(),
    stallMs: settings.stallMs,
    minAgeMs: settings.minAgeMs,
    readable,
  })
  return { events, header, running, verdict, source }
}

/**
 * Render a JSON value as a tool result.
 * @param {unknown} value - the value to return.
 * @returns {{content: object[]}} the tool result content.
 */
function jsonResult(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] }
}

/**
 * Resolve the EFFECTIVE settings for the expert's tools.
 *
 * THE BUG THIS EXISTS TO PREVENT
 *
 * The two halves get their settings from different places, and that divergence is
 * silent:
 *
 *   - the Host row is a patch row in `~/.dsh/cordis.patch.yml`, carrying
 *     `config: { stallMs: 900000, resume: {...} }`;
 *   - the expert row lives inside the `user-proxy` preset and declares NO `config`,
 *     so `apply` receives `undefined` and falls back to the hard-coded defaults below.
 *
 * The halves then enforce DIFFERENT policies. Two consequences, one merely confusing
 * and one actively misleading:
 *
 *   1. the expert calls a session stalled after 5 minutes, the Host after 15 — so the
 *      expert's own view of "what is stalled" disagrees with the panel it is meant to
 *      explain;
 *   2. the expert refuses EVERY resume with reason `disabled` even after the user has
 *      turned Host resume ON, because it never sees that flag. The panel then says
 *      "enabled" while the expert says "disabled" — and `disabled` is technically true
 *      of the expert's stale copy and a lie about the deployment.
 *
 * So policy is read from the HOST snapshot, which is the deployment's single source of
 * truth for it — exactly as it already is for verdicts. The row's own `config` is still
 * honoured for anything the snapshot does not carry, so a preset that WANTS different
 * settings can still say so.
 *
 * @param {object} settings - the settings derived from the row's own config.
 * @param {object|null} snapshot - the Host's latest snapshot, or null.
 * @returns {object} the effective settings.
 */
export function resolveEffectiveSettings(settings, snapshot) {
  if (snapshot === null || snapshot === undefined) return settings
  const policy = snapshot.resumePolicy
  return {
    ...settings,
    stallMs: Number.isFinite(snapshot.stallMs) ? snapshot.stallMs : settings.stallMs,
    minAgeMs: Number.isFinite(snapshot.minAgeMs) ? snapshot.minAgeMs : settings.minAgeMs,
    resume: {
      ...settings.resume,
      enabled: snapshot.resumeEnabled === true,
      maxAttempts: Number.isFinite(policy?.maxAttempts) ? policy.maxAttempts : settings.resume.maxAttempts,
      baseDelayMs: Number.isFinite(policy?.baseDelayMs) ? policy.baseDelayMs : settings.resume.baseDelayMs,
      maxDelayMs: Number.isFinite(policy?.maxDelayMs) ? policy.maxDelayMs : settings.resume.maxDelayMs,
      cooldownMs: Number.isFinite(policy?.cooldownMs) ? policy.cooldownMs : settings.resume.cooldownMs,
    },
  }
}

/**
 * Declare the tool definitions. Kept as a factory so the plugin can pass its
 * resolved configuration and the shared cache in, and so tests can call it with a
 * stub context.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} settings - resolved configuration.
 * @param {{snapshot?: () => Promise<object>}} cache - access to the sidebar snapshot.
 * @returns {object[]} tool definitions, ready for `ctx.tools.register`.
 */
export function defineProxyTools(ctx, settings, cache) {
  /**
   * The settings actually in force, read fresh on every call.
   *
   * Read per call rather than captured once, because the Host's policy can change
   * while this process runs: turning auto-resume on is a config edit that hot-reloads.
   * Capturing at construction would freeze the expert on the policy that happened to be
   * in force when the preset mounted.
   *
   * @returns {Promise<object>} the effective settings.
   */
  async function effectiveSettings() {
    try {
      const snapshot = await cache.snapshot()
      return resolveEffectiveSettings(settings, snapshot)
    } catch {
      // No snapshot means no trustworthy policy. The caller's own settings are used,
      // and those default to "do not resume" — the safe direction.
      return settings
    }
  }

  /**
   * The full-host roster: every session, its verdict, and why it will or will not
   * be resumed. Read-only.
   */
  const sessionRoster = {
    name: 'session_roster',
    description:
      'List every session on this DSH host (all workspaces, not just this one) with its verdict, '
      + 'last activity, and whether automatic resume will touch it. Deterministic: the verdict comes '
      + 'from log analysis, not from model judgement. Use this first to find what needs attention.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        only: {
          type: 'string',
          enum: ['attention', 'stalled', 'all'],
          description:
            'attention (default) = stalled plus approval-parked sessions; stalled = only silent stops; all = every session.',
        },
        cwd_contains: {
          type: 'string',
          description: 'Optional case-insensitive substring filter on the session working directory.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum rows returned (default 40, max 200).',
        },
      },
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => jsonResult(value).content,
    },
    async execute(args) {
      // A tool must never THROW at the model. A thrown error surfaces as an opaque
      // failure the expert cannot reason about, and for a read-only tool that is
      // strictly worse than returning less data with the reason attached.
      //
      // This matters most for `session_roster`, which is the FIRST tool the expert
      // calls: if it throws, the expert is left with nothing at all and no way to tell
      // whether the host is down, the plugin is broken, or there is simply nothing to
      // report.
      let snapshot
      try {
        snapshot = await cache.snapshot()
      } catch (error) {
        return {
          ok: false,
          scope: 'entire host — every workspace',
          error: '无法读取会话快照（Host 半不可用）。',
          detail: String(error?.message ?? error),
          hint: 'Host 半可能在重启中或未加载。这是"读不到"，不是"没有问题"——'
            + '不要把空结果当成一切正常。',
          totals: null,
          rows: [],
        }
      }
      const only = typeof args?.only === 'string' ? args.only : 'attention'
      const limit = Number.isFinite(args?.limit) ? Math.max(1, Math.min(200, args.limit)) : 40
      const needle = typeof args?.cwd_contains === 'string' ? args.cwd_contains.toLowerCase() : null

      let rows = Array.isArray(snapshot.sessions) ? snapshot.sessions : []
      if (only === 'stalled') rows = rows.filter(row => row.verdict === 'stalled')
      else if (only === 'attention') {
        rows = rows.filter(row => row.verdict === 'stalled' || row.verdict === 'awaiting-approval')
      }
      if (needle !== null) {
        rows = rows.filter(row => String(row.cwd ?? '').toLowerCase().includes(needle))
      }

      return {
        home: snapshot.home,
        generatedAt: snapshot.generatedAt,
        // Stated explicitly so the expert never mistakes this for a workspace view.
        scope: 'entire host — every workspace',
        totals: snapshot.totals,
        // The deployment's window for "silent", so the expert reasons on the same
        // definition the panel uses instead of its own fallback.
        stallMs: snapshot.stallMs,
        minAgeMs: snapshot.minAgeMs,
        autoResume: {
          enabled: snapshot.resumeEnabled,
          policy: snapshot.resumePolicy,
        },
        rows: rows.slice(0, limit).map(row => ({
          sessionId: row.sessionId,
          cwd: row.cwd,
          verdict: row.verdict,
          why: row.detail,
          turn: row.turn,
          step: row.step,
          lastEvent: row.lastType,
          silentSeconds: Math.round((row.silentMs ?? 0) / 1000),
          running: row.running,
          isSubagent: row.isSubagent,
          autoResumable: row.autoResumable,
          resumeDecision: row.resume,
          // The Host already worked out what to do next when policy stopped acting. Passing
          // it through matters because the expert IS that next step: without it the expert
          // re-derives the same conclusion, and worse, cannot tell a session that has been
          // waiting for a human for hours from one that just stopped.
          nextStep: typeof row.handoff?.text === 'string' ? row.handoff.text : null,
          // The author of the last attempt, so the expert can tell a session the watcher
          // already nudged on its own from one nobody has touched.
          lastAttemptBy: row.resume?.lastAttemptBy ?? null,
          lastAttemptOk: typeof row.resume?.lastAttemptOk === 'boolean' ? row.resume.lastAttemptOk : null,
          eventCount: row.eventCount,
        })),
      }
    },
  }

  /**
   * Read one session's actual conversation plus the deterministic facts about how
   * it stopped. Read-only.
   */
  const sessionReview = {
    name: 'session_review',
    description:
      'Read one session\'s conversation: user messages, assistant replies, tool calls and their '
      + 'results, retries and errors — plus deterministic facts about how it stopped (open turn, '
      + 'retry count, tool failures). Read-only; this never wakes the session. Use it to find the '
      + 'root cause behind a verdict from session_roster.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'Exact session id, as returned by session_roster.',
        },
        limit: {
          type: 'integer',
          description: 'Maximum transcript entries, taken from the END of the conversation (default 60, max 400).',
        },
        from_seq: {
          type: 'integer',
          description: 'Optional: include only events at or after this sequence number.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => jsonResult(value).content,
    },
    async execute(args) {
      const sessionId = typeof args?.session_id === 'string' ? args.session_id : ''
      if (sessionId === '') {
        return { ok: false, error: 'session_id is required' }
      }
      const classified = await classifyOne(ctx, sessionId, await effectiveSettings())
      if (classified === null) {
        return {
          ok: false,
          sessionId,
          error: 'session log not found or unreadable',
          hint: 'Check the id against session_roster; a session deleted from disk cannot be read.',
        }
      }
      const { events, header, running, verdict, source } = classified
      const transcript = buildTranscript(events, {
        limit: Number.isFinite(args?.limit) ? args.limit : undefined,
        fromSeq: Number.isFinite(args?.from_seq) ? args.from_seq : undefined,
      })
      const stop = summarizeStop(events)

      return {
        ok: true,
        sessionId,
        cwd: header.cwd,
        source,
        running,
        verdict: verdict.verdict,
        verdictWhy: verdict.detail,
        autoResumable: AUTO_RESUMABLE.has(verdict.verdict),
        eventCount: events.length,
        stop,
        transcript: transcript.entries,
        transcriptOmitted: transcript.omitted,
        transcriptTotal: transcript.total,
        toolErrorCount: transcript.toolErrors,
      }
    },
  }

  /**
   * The only tool that changes anything. Deliberately separate, deliberately
   * explicit, and deliberately gated exactly like the automatic path.
   */
  const sessionResume = {
    name: 'session_resume',
    description:
      'Send a continuation prompt to one session — the same effect as the user typing "继续" there. '
      + 'This is the ONLY tool here that changes anything. It is refused unless the session is '
      + 'verdict=stalled and automatic resume permits it; pass force=true only when the user has '
      + 'explicitly asked to resume this exact session. Every attempt is recorded in the same ledger '
      + 'the sidebar reports.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        session_id: {
          type: 'string',
          description: 'Exact session id to resume.',
        },
        force: {
          type: 'boolean',
          description:
            'Bypass the automatic gate. Only for an explicit user request naming this session; '
            + 'a session parked on an approval must not be answered on the user\'s behalf.',
        },
        note: {
          type: 'string',
          description: 'Optional context appended to the continuation prompt.',
        },
      },
      required: ['session_id'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => jsonResult(value).content,
    },
    async execute(args) {
      const sessionId = typeof args?.session_id === 'string' ? args.session_id : ''
      if (sessionId === '') return { ok: false, error: 'session_id is required' }
      const force = args?.force === true

      // The DEPLOYMENT's policy, not this row's absent config. See
      // `resolveEffectiveSettings` for the divergence this closes.
      const effective = await effectiveSettings()

      const classified = await classifyOne(ctx, sessionId, effective)
      if (classified === null) {
        return { ok: false, sessionId, error: 'session log not found or unreadable' }
      }
      const { running, verdict } = classified
      const ledger = readLedger()
      const record = ledger.sessions?.[sessionId] ?? { attempts: 0, lastAttemptAt: null, history: [] }

      // The gate is evaluated even when `force` is set, purely so the refusal REASON
      // can be reported. `force` overrides the decision, never the explanation.
      const decision = decideResume(
        { verdict: verdict.verdict, busy: running, now: Date.now(), record },
        effective.resume,
      )

      if (force !== true) {
        if (!decision.resume) {
          return {
            ok: false,
            sessionId,
            verdict: verdict.verdict,
            verdictWhy: verdict.detail,
            refused: decision.reason,
            refusedWhy: decision.detail,
            attempts: record.attempts,
            hint: 'Automatic resume declined this session. Report why instead of forcing it; '
              + 'use force=true only if the user explicitly asked to resume this session.',
          }
        }
      } else if (verdict.verdict === 'awaiting-approval') {
        // Refused even under force. This is the one case where obeying would mean
        // answering a question addressed to the user.
        return {
          ok: false,
          sessionId,
          verdict: verdict.verdict,
          verdictWhy: verdict.detail,
          refused: 'awaiting-approval',
          refusedWhy:
            '该会话正在等待用户审批。即使 force=true 也不恢复——那等于替用户回答他尚未回答的问题。',
        }
      }

      const template = typeof args?.note === 'string' && args.note.trim() !== ''
        // `'user-proxy'` so the message that lands in the session says the EXPERT sent it,
        // not the watcher. This text is permanent, and misattributing it would leave the
        // session's own log claiming an automatic action that never happened.
        ? `${buildNudgeText({ turn: verdict.turn, step: verdict.step, lastType: verdict.lastType }, effective.resume.promptTemplate, 'user-proxy')}\n\n（用户代理补充）${args.note.trim()}`
        : effective.resume.promptTemplate

      // Imported lazily: `resumeSession` is the ONE thing this half needs from the
      // Host half, and a static import of it would make this module fail to load
      // against a cached older `plugin.js`. A missing export is a load-time error, so
      // that would take down all three tools — including the two read-only ones — with
      // a message that says nothing about needing a restart. Deferring the import to
      // the single tool that actually resumes keeps the blast radius to that tool, and
      // lets it report the problem instead.
      let resumeSession
      try {
        ({ resumeSession } = await import('./plugin.js'))
      } catch (error) {
        return {
          ok: false,
          sessionId,
          error: 'Host 半不可用，无法恢复（可能需要重启 dsh 以加载新代码）。',
          code: 'no-host-half',
          detail: String(error?.message ?? error),
        }
      }

      const outcome = await resumeSession(
        ctx,
        { sessionId, turn: verdict.turn, step: verdict.step, lastType: verdict.lastType },
        template,
        // The expert is not the watcher, and the message it writes into the session must
        // say so.
        'user-proxy',
      )

      // Recorded even on failure: the ledger is the record of what was TRIED, and an
      // unrecorded failure would let a broken route be retried forever.
      recordAttempt(sessionId, {
        at: Date.now(),
        ok: outcome.ok,
        error: outcome.error,
        code: outcome.code,
        by: 'user-proxy',
        turn: verdict.turn,
        step: verdict.step,
      })

      return {
        ok: outcome.ok,
        sessionId,
        verdict: verdict.verdict,
        forced: force === true,
        gate: decision.reason,
        error: outcome.error,
        code: outcome.code,
        attemptsBefore: record.attempts,
        attemptsAfter: record.attempts + 1,
      }
    },
  }

  return [sessionRoster, sessionReview, sessionResume]
}

/**
 * Mount the expert's tools.
 *
 * Because this module is referenced by a ROW INSIDE A PRESET, this `apply` runs in
 * that preset's scope, and the registrations below are visible only to agents
 * composed from it. That is the entire isolation mechanism — there is no check
 * here to get wrong.
 *
 * @param {any} ctx - the Cordis context.
 * @param {object} [config] - Loader row configuration.
 * @returns {void}
 */
export function apply(ctx, config) {
  const settings = {
    stallMs: Number.isFinite(config?.stallMs) ? config.stallMs : 5 * 60 * 1000,
    minAgeMs: Number.isFinite(config?.minAgeMs) ? config.minAgeMs : 60 * 1000,
    maxSessions: Number.isFinite(config?.maxSessions) ? config.maxSessions : 400,
    resume: {
      enabled: config?.resume?.enabled === true,
      maxAttempts: Number.isFinite(config?.resume?.maxAttempts) ? config.resume.maxAttempts : 2,
      baseDelayMs: Number.isFinite(config?.resume?.baseDelayMs) ? config.resume.baseDelayMs : 120000,
      maxDelayMs: Number.isFinite(config?.resume?.maxDelayMs) ? config.resume.maxDelayMs : 1800000,
      cooldownMs: Number.isFinite(config?.resume?.cooldownMs) ? config.resume.cooldownMs : 300000,
      promptTemplate: typeof config?.resume?.promptTemplate === 'string'
        ? config.resume.promptTemplate
        : null,
    },
  }

  // The roster tool must show the SAME verdicts as the sidebar. It reads the Host
  // half's snapshot when that half is present, and falls back to classifying
  // directly only when it is not — so a missing Host half degrades the source, never
  // the answer.
  const cache = {
    async snapshot() {
      // The service is the lifecycle-correct seam, but the two halves are mounted as
      // separate plugin instances (a profile row and a preset row), and a preset row
      // cannot `inject` a profile row's service. So the module-level holder — which
      // both halves share, since both specifiers resolve to the same files — is the
      // path that actually carries data here. The service is tried first anyway so
      // that a future same-instance composition keeps working.
      const service = ctx.get(SERVICE_NAME)
      if (service !== undefined && service !== null && typeof service.snapshot === 'function') {
        try {
          const snapshot = await service.snapshot()
          if (snapshot !== undefined && snapshot !== null) return snapshot
        } catch {
          // Fall through to the shared holder.
        }
      }
      const published = readPublishedSnapshot()
      if (published !== null) return published
      // Last resort: classify directly. Guarded because this is the DEGRADED path —
      // if it throws, the caller loses even the ability to report *why* it has no data,
      // which is the one thing a degraded path must still be able to say.
      try {
        return await buildFallbackSnapshot(ctx, settings)
      } catch (error) {
        throw new Error(`主机快照不可用，且本地兜底扫描也失败：${String(error?.message ?? error)}`)
      }
    },
  }

  const disposers = []
  const tools = defineProxyTools(ctx, settings, cache)
  try {
    for (const tool of tools) {
      disposers.push(ctx.tools.register(tool))
    }
  } catch (error) {
    for (const dispose of disposers.reverse()) dispose()
    throw error
  }

  // Record the mount so its success is verifiable from a shell. This runs AFTER the
  // registrations succeed, which is the point: a record written before a failure
  // would report a mount that never happened.
  recordProxyMount({
    mountedAt: Date.now(),
    pid: process.pid,
    plugin: name,
    tools: tools.map(tool => tool.name),
    stallMs: settings.stallMs,
    resumeEnabled: settings.resume.enabled,
  })

  return () => {
    for (const dispose of disposers.reverse()) dispose()
  }
}

/**
 * Classify every session directly, for when the Host half did not publish its
 * snapshot. Mirrors the Host half's shape so callers cannot tell the difference.
 * @param {any} ctx - the Cordis context.
 * @param {object} settings - resolved configuration.
 * @returns {Promise<object>} a snapshot.
 */
async function buildFallbackSnapshot(ctx, settings) {
  const now = Date.now()
  const logs = findSessionLogs(dshHome())
  const ledger = readLedger()
  /** @type {Map<string, boolean>} */
  const running = new Map()
  try {
    for (const agent of ctx.get('agents')?.list?.() ?? []) {
      const id = agent?.session?.id
      if (typeof id === 'string') running.set(id, agent?.status === 'running')
    }
  } catch {
    // Absence degrades to "nothing running", which can only cause a report.
  }

  const sessions = []
  const maxSessions = Number.isFinite(settings.maxSessions) ? settings.maxSessions : 400
  for (const log of logs.slice(-maxSessions).reverse()) {
    const { events, readable } = await readSessionLog(log.file)
    const header = headerOf(events)
    const sessionId = header.id ?? log.sessionId
    const isRunning = running.get(sessionId) === true
    const verdict = classifySession({
      events: tailEvents(events, TAIL_LIMIT),
      running: isRunning,
      isSubagent: header.delegationDepth > 0,
      now,
      stallMs: settings.stallMs,
      minAgeMs: settings.minAgeMs,
      readable,
    })
    const record = ledger.sessions?.[sessionId] ?? { attempts: 0, lastAttemptAt: null }
    const decision = decideResume(
      { verdict: verdict.verdict, busy: isRunning, now, record },
      settings.resume,
    )
    sessions.push({
      sessionId,
      cwd: header.cwd,
      isSubagent: header.delegationDepth > 0,
      running: isRunning,
      autoResumable: AUTO_RESUMABLE.has(verdict.verdict),
      resume: { willResume: decision.resume, reason: decision.reason, detail: decision.detail },
      eventCount: events.length,
      lastActivityAt: log.mtimeMs,
      verdict: verdict.verdict,
      detail: verdict.detail,
      lastType: verdict.lastType,
      turn: verdict.turn,
      step: verdict.step,
      silentMs: verdict.silentMs,
    })
  }

  return {
    ok: true,
    generatedAt: now,
    home: dshHome(),
    stallMs: settings.stallMs,
    minAgeMs: settings.minAgeMs,
    resumeEnabled: settings.resume.enabled,
    resumePolicy: settings.resume,
    resumed: [],
    degraded: 'Host half unavailable; classified directly by the expert tools.',
    totals: {
      scanned: sessions.length,
      stalled: sessions.filter(s => s.verdict === 'stalled').length,
      awaitingApproval: sessions.filter(s => s.verdict === 'awaiting-approval').length,
      empty: sessions.filter(s => s.verdict === 'empty').length,
      subagent: sessions.filter(s => s.verdict === 'subagent').length,
      resumed: 0,
      resumeFailed: 0,
    },
    attention: sessions.filter(s => s.verdict === 'stalled'),
    sessions,
  }
}
