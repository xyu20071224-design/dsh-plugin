/**
 * The durable resume ledger, shared by BOTH halves.
 *
 * WHY THIS IS ITS OWN MODULE
 *
 * The ledger was originally inside `plugin.js`. That made the expert half import the
 * whole Host half just to count attempts — and that coupling is fragile in a way this
 * project actually hit:
 *
 *   The loader caches a plugin's module BY NAME. So after adding an export to
 *   `plugin.js` and importing it from `proxy.js`, the new proxy half could not load
 *   against the still-cached OLD `plugin.js`:
 *
 *     SyntaxError: The requested module './plugin.js' does not provide an export
 *     named 'readLedger'
 *
 *   A missing export is a LOAD-TIME error, so the entire expert half fails to mount —
 *   not one tool, the whole thing — with a message that says nothing about restarts.
 *
 * Putting the ledger in a module neither half owns removes that failure mode. The
 * expert half now depends only on this file, so a stale sibling cannot break it.
 *
 * It also puts the two halves on genuinely shared ground: automatic resume and
 * expert-initiated resume MUST count against the same per-session cap. Two separate
 * counters would let a session exceed its limit simply by changing who asked.
 *
 * @module @local/dsh-session-watch/ledger
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** How many attempts are retained per session in the ledger history. */
const HISTORY_LIMIT = 20

/**
 * Resolve the Harness home directory.
 *
 * Read from the environment on every call rather than cached at module load: tests
 * point `DSH_HOME` at a temporary directory, and a cached value would let them write
 * to the real ledger.
 * @returns {string} absolute path of the Harness home.
 */
export function dshHome() {
  return process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
}

/**
 * Path of the resume ledger.
 *
 * The ledger MUST be durable. If a restart reset the attempt counts, a session that
 * kills its own turn every time would be nudged again forever — exactly the
 * token-burning loop the attempt cap exists to stop.
 * @returns {string} absolute path of the ledger document.
 */
export function ledgerPath() {
  return join(dshHome(), 'session-watch.json')
}

/**
 * Read the resume ledger, tolerating a missing or corrupt file.
 *
 * A corrupt ledger is treated as EMPTY, which is the safe direction here: an empty
 * ledger only means a session may receive its full allowance again, never that a
 * session is resumed without a decision.
 * @returns {{version: number, sessions: Record<string, {attempts: number, lastAttemptAt: number|null, history: object[]}>}}
 *   the ledger contents.
 */
export function readLedger() {
  const empty = { version: 1, sessions: {} }
  try {
    const parsed = JSON.parse(readFileSync(ledgerPath(), 'utf8'))
    if (parsed === null || typeof parsed !== 'object') return empty
    return {
      version: 1,
      sessions: (parsed.sessions !== null && typeof parsed.sessions === 'object') ? parsed.sessions : {},
    }
  } catch {
    return empty
  }
}

/**
 * Write the ledger atomically (temp file + rename), so a crash mid-write cannot leave
 * a truncated document that would reset every attempt count.
 * @param {object} ledger - the ledger to persist.
 * @returns {void}
 */
export function writeLedger(ledger) {
  const target = ledgerPath()
  const temporary = `${target}.tmp-${process.pid}`
  mkdirSync(dshHome(), { recursive: true })
  writeFileSync(temporary, JSON.stringify(ledger, null, 2), 'utf8')
  renameSync(temporary, target)
}

/**
 * Append one resume attempt to the durable ledger.
 *
 * RE-READS the ledger before incrementing. That is load-bearing: the automatic path
 * and the expert's tool can both fire in the same window, and a write based on a copy
 * read earlier would clobber the other's increment — handing the session more nudges
 * than its cap allows.
 *
 * The attempt is recorded even when it FAILED: the ledger is the record of what was
 * TRIED, and an unrecorded failure would let a permanently broken route be retried
 * forever.
 *
 * @param {string} sessionId - the session that was nudged.
 * @param {object} entry - the attempt record; `by` names its author (`auto` or
 *   `user-proxy`), which is what lets the panel attribute the action.
 * @returns {{attempts: number, lastAttemptAt: number|null}} the updated counters.
 */
export function recordAttempt(sessionId, entry) {
  const ledger = readLedger()
  const previous = ledger.sessions[sessionId] ?? { attempts: 0, lastAttemptAt: null, history: [] }
  const next = {
    attempts: (Number.isFinite(previous.attempts) ? previous.attempts : 0) + 1,
    lastAttemptAt: Number.isFinite(entry?.at) ? entry.at : Date.now(),
    history: [...(previous.history ?? []), entry].slice(-HISTORY_LIMIT),
  }
  ledger.sessions[sessionId] = next
  try {
    writeLedger(ledger)
  } catch {
    // A ledger write failure must not swallow the outcome the caller is reporting;
    // the worst case is one extra allowance after a restart.
  }
  return { attempts: next.attempts, lastAttemptAt: next.lastAttemptAt }
}

/**
 * Read one session's recorded attempts, normalized.
 * @param {string} sessionId - the session to look up.
 * @returns {{attempts: number, lastAttemptAt: number|null, history: object[]}} its record.
 */
export function attemptsFor(sessionId) {
  const record = readLedger().sessions?.[sessionId]
  return {
    attempts: Number.isFinite(record?.attempts) ? record.attempts : 0,
    lastAttemptAt: Number.isFinite(record?.lastAttemptAt) ? record.lastAttemptAt : null,
    history: Array.isArray(record?.history) ? record.history : [],
  }
}
