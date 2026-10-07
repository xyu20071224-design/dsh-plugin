/**
 * Session-log reading for `@local/dsh-session-watch`.
 *
 * The watcher must judge sessions that are NOT its own, so it cannot use the
 * agent-scoped `session_query` tools: those authorize from the immutable calling
 * agent session and are therefore limited to one workspace. Reading the durable
 * logs directly is what makes a host-wide view possible.
 *
 * Two properties of the on-disk format shape this module:
 *
 *   1. Logs are Zstandard-compressed, one independently compressed frame per
 *      batch of events, so a log is many frames concatenated. `node:zlib` gained
 *      native zstd support in Node 22/24, so this needs no third-party package.
 *   2. A live session's newest frame can be TORN mid-write. That is expected, not
 *      an error: the frames already flushed are enough to judge the session, and
 *      failing here would report a healthy session as unreadable.
 *
 * @module @local/dsh-session-watch/logs
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

/** Magic bytes of a Zstandard frame. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Resolve the DSH home directory the same way the rest of the harness does.
 * @returns {string} absolute path to the Harness home.
 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return path.join(os.homedir(), '.dsh')
}

/**
 * Decompress every complete Zstandard frame in a log buffer.
 *
 * A frame that fails to decompress is skipped rather than fatal: the only frame
 * expected to fail is the torn tail of a session being written right now.
 * @param {Buffer} buffer - raw `.jsonl.zstd` bytes.
 * @returns {string} concatenated plaintext.
 */
export function decompressFrames(buffer) {
  /** @type {number[]} */
  const starts = []
  for (let i = 0; i + 3 < buffer.length; i += 1) {
    if (buffer[i] === ZSTD_MAGIC[0] && buffer[i + 1] === ZSTD_MAGIC[1]
      && buffer[i + 2] === ZSTD_MAGIC[2] && buffer[i + 3] === ZSTD_MAGIC[3]) starts.push(i)
  }
  let text = ''
  for (let k = 0; k < starts.length; k += 1) {
    const end = k + 1 < starts.length ? starts[k + 1] : buffer.length
    try {
      text += zlib.zstdDecompressSync(buffer.subarray(starts[k], end)).toString('utf8')
    } catch {
      // Torn tail frame of a session mid-write; earlier frames still count.
    }
  }
  return text
}

/**
 * Parse plaintext JSONL into events, skipping unparseable lines.
 * @param {string} text - concatenated JSONL plaintext.
 * @returns {any[]} parsed events, oldest first.
 */
export function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // A partially flushed trailing line is expected on a live session.
    }
  }
  return events
}

/**
 * Read one session log into events.
 *
 * Both encodings are supported. The shipped desktop profile writes `.jsonl.zstd`,
 * but the backend is configurable, so a plaintext `.jsonl` log must not be
 * reported as unreadable.
 * @param {string} file - absolute log path.
 * @returns {Promise<{events: any[], readable: boolean}>} the events and whether
 *   the file could be read at all.
 */
export async function readSessionLog(file) {
  try {
    const buffer = await fsp.readFile(file)
    const text = file.endsWith('.zstd') ? decompressFrames(buffer) : buffer.toString('utf8')
    return { events: parseEvents(text), readable: true }
  } catch {
    return { events: [], readable: false }
  }
}

/**
 * Discover every session log beneath a DSH home.
 *
 * Layout is `<home>/sessions/<encoded-cwd>/<session-id>/session.v4.jsonl.zstd`.
 * Walking is bounded and never throws: a permission problem on one directory must
 * not blind the watcher to every other session.
 * @param {string} [home] - Harness home; defaults to {@link dshHome}.
 * @returns {Array<{file: string, sessionId: string, dir: string, mtimeMs: number}>}
 *   discovered logs, newest-mtime last.
 */
export function findSessionLogs(home = dshHome()) {
  const root = path.join(home, 'sessions')
  /** @type {Array<{file: string, sessionId: string, dir: string, mtimeMs: number}>} */
  const found = []

  /** @type {string[]} */
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()
    if (dir === undefined) continue
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        stack.push(full)
        continue
      }
      if (!entry.isFile()) continue
      if (!entry.name.endsWith('.jsonl.zstd') && !entry.name.endsWith('.jsonl')) continue
      let mtimeMs = 0
      try {
        mtimeMs = fs.statSync(full).mtimeMs
      } catch {
        continue
      }
      found.push({ file: full, sessionId: path.basename(dir), dir, mtimeMs })
    }
  }

  found.sort((a, b) => a.mtimeMs - b.mtimeMs)
  return found
}

/**
 * Extract the facts the detector needs from a session's header event.
 * @param {any[]} events - the session's events.
 * @returns {{id: string|null, cwd: string|null, delegationDepth: number, createdAt: number|null}}
 *   header facts; absent fields are null.
 */
export function headerOf(events) {
  const header = events.find(event => event?.type === 'session')
  return {
    id: typeof header?.id === 'string' ? header.id : null,
    cwd: typeof header?.cwd === 'string' ? header.cwd : null,
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
    createdAt: typeof header?.createdAt === 'number' ? header.createdAt : null,
  }
}

/**
 * Bound a session's log to what detection actually inspects.
 *
 * Detection needs three things and nothing else:
 *   - the HEADER, for the session's identity and its `createdAt` age gate;
 *   - the current turn's `turn/start`, which can be arbitrarily far back — a
 *     long turn spans thousands of events, so a fixed tail can cut its opening
 *     off and make a CLOSED turn look open (this misfired on 13 real sessions);
 *   - the tail, for the turn's outcome and its latest activity.
 *
 * So the result is header + the current turn's opening + the tail, deduplicated
 * and in original order. `eventCount` is reported separately from the true total.
 * @param {any[]} events - the session's full event list.
 * @param {number} [limit] - how many trailing events to keep.
 * @returns {any[]} a bounded, decision-complete view of the log.
 */
export function tailEvents(events, limit = 400) {
  if (!Array.isArray(events)) return []
  if (events.length <= limit) return events

  /** @type {Set<number>} indices to retain, by original position. */
  const keep = new Set()
  for (let i = events.length - limit; i < events.length; i += 1) keep.add(i)

  // The header carries identity and the age gate.
  const headerIndex = events.findIndex(event => event?.type === 'session')
  if (headerIndex >= 0) keep.add(headerIndex)

  // The current turn's opening, however far back it is, so turn scoping works.
  for (let i = events.length - 1; i >= 0; i -= 1) {
    if (events[i]?.type === 'turn/start') { keep.add(i); break }
  }

  return [...keep].sort((a, b) => a - b).map(index => events[index])
}
