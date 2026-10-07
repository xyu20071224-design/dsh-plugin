/**
 * The handoff between the Host half and the expert's tools.
 *
 * WHY THIS EXISTS
 *
 * The sidebar panel and the expert must report the SAME verdicts. If the expert
 * classified sessions independently, two scanners would eventually disagree — and
 * then neither could be trusted, which is worse than having only one.
 *
 * So the Host half publishes its most recent snapshot here, and the expert's
 * `session_roster` prefers it. Two mechanisms are provided because they fail
 * differently:
 *
 *   1. A Cordis service (`sessionWatch`), which is the correct, lifecycle-managed
 *      way for one plugin to expose an operation to another.
 *   2. A module-level holder, which works even when the two halves are mounted as
 *      separate plugin instances (they are: the Host half is a profile row, the
 *      expert's tools are a row inside an agent preset). Both specifiers resolve to
 *      the same absolute files in this package, so Node hands both the same module
 *      instance.
 *
 * The expert falls back to classifying directly if BOTH are absent. That is a
 * degraded source, never a degraded answer — and the snapshot says so, so the
 * expert can tell the user its numbers came from a fallback path.
 *
 * This module also holds the MOUNT RECORD, which answers a question this project got
 * wrong twice — see {@link recordProxyMount}.
 *
 * @module @local/dsh-session-watch/shared
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Cordis service name the Host half publishes under. */
export const SERVICE_NAME = 'sessionWatch'

/**
 * The most recent snapshot published by the Host half.
 * @type {{snapshot: object|null, publishedAt: number}}
 */
const holder = { snapshot: null, publishedAt: 0 }

/**
 * Publish a snapshot for the expert's tools to read.
 * @param {object} snapshot - a snapshot from `buildSnapshot`.
 * @returns {void}
 */
export function publishSnapshot(snapshot) {
  holder.snapshot = snapshot
  holder.publishedAt = Date.now()
}

/**
 * Read the most recently published snapshot.
 * @param {number} [maxAgeMs] - reject a snapshot older than this; omit for no limit.
 * @returns {object|null} the snapshot, or null when none is fresh enough.
 */
export function readPublishedSnapshot(maxAgeMs) {
  if (holder.snapshot === null) return null
  if (Number.isFinite(maxAgeMs) && Date.now() - holder.publishedAt > maxAgeMs) return null
  return holder.snapshot
}

/**
 * Path of the mount record.
 *
 * WHY THIS FILE EXISTS
 *
 * "The bundle is installed" and "the preset composition actually mounted" are two
 * different facts, and the second is invisible from outside the Host process. A
 * declaration row can report `fiberPhase: active` while its composition failed to
 * activate, because the registry catches that failure and stores it on the row — the
 * row still looks healthy.
 *
 * That ambiguity is what made two earlier diagnoses in this project wrong. So the
 * expert half records its own mount to a file the moment its `apply` runs. Reading
 * that file answers the question from a shell, with no Host access at all: if the
 * record is absent, the composition never mounted.
 *
 * @param {string} [home] - Harness home; defaults to `DSH_HOME`.
 * @returns {string} absolute path of the mount record.
 */
export function mountRecordPath(home) {
  const base = home ?? process.env.DSH_HOME ?? join(process.env.USERPROFILE ?? '.', '.dsh')
  return join(base, 'session-watch-proxy.json')
}

/**
 * Record that the expert half mounted, atomically.
 *
 * Never throws: a diagnostic aid must not be able to break the thing it observes.
 * @param {object} detail - what mounted.
 * @returns {void}
 */
export function recordProxyMount(detail) {
  try {
    const target = mountRecordPath()
    const temporary = `${target}.tmp-${process.pid}`
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(temporary, JSON.stringify(detail, null, 2), 'utf8')
    renameSync(temporary, target)
  } catch {
    // Losing a diagnostic record is acceptable; failing to mount is not.
  }
}

/**
 * Read the expert half's mount record.
 * @returns {object|null} the record, or null when it never mounted.
 */
export function readProxyMount() {
  try {
    const parsed = JSON.parse(readFileSync(mountRecordPath(), 'utf8'))
    return parsed !== null && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}
