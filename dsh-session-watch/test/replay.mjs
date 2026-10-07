/**
 * Offline validation of the detection rules against REAL session logs.
 *
 * This harness is read-only with respect to the user's DSH home: it decompresses
 * `session.v4.jsonl.zstd` files, replays them through `classifySession`, and
 * prints the verdict distribution. It exists to answer one question with
 * evidence rather than opinion: does the detector fire on the sessions that
 * actually stalled, and stay quiet on the ones that were waiting for a human?
 *
 * Run: node test/replay.mjs [--home <DSH_HOME>] [--stall-ms N] [--verbose]
 *
 * @module @local/dsh-session-watch/test/replay
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

import { classifySession } from '../lib/detect.js'

/** Magic bytes of a Zstandard frame: the log's physical encoding. */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Parse `--flag value` and `--flag` arguments.
 * @param {string[]} argv - process arguments after the script path.
 * @returns {{home: string, stallMs: number, verbose: boolean}} parsed options.
 */
function parseArgs(argv) {
  const options = {
    home: process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh'),
    stallMs: 5 * 60 * 1000,
    verbose: false,
  }
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--home' && argv[i + 1] !== undefined) options.home = argv[i + 1]
    else if (argv[i] === '--stall-ms' && argv[i + 1] !== undefined) options.stallMs = Number(argv[i + 1])
    else if (argv[i] === '--verbose') options.verbose = true
  }
  return options
}

/**
 * Decompress a concatenated series of Zstandard frames.
 *
 * The persistence backend writes one independently compressed frame per batch of
 * events, so a log is many frames back to back. `node:zlib` has supported zstd
 * natively since Node 22/24, which is why this needs no third-party dependency.
 * @param {Buffer} buffer - the raw `.jsonl.zstd` bytes.
 * @returns {string} the concatenated plaintext.
 */
function decompressFrames(buffer) {
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
      // A torn tail frame is expected for a session that is mid-write; the
      // events recovered so far are still enough to judge the session.
    }
  }
  return text
}

/**
 * Parse plaintext into events, skipping any unparseable line.
 * @param {string} text - concatenated JSONL plaintext.
 * @returns {any[]} parsed events, oldest first.
 */
function parseEvents(text) {
  const events = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    try {
      events.push(JSON.parse(line))
    } catch {
      // Ignore a partially written trailing line.
    }
  }
  return events
}

/**
 * Find every compressed session log beneath a DSH home.
 * @param {string} root - the `sessions` directory.
 * @returns {string[]} absolute log paths.
 */
function findLogs(root) {
  /** @type {string[]} */
  const found = []
  const walk = (dir) => {
    let entries
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }
  walk(root)
  return found
}

/**
 * Read the header row to recover a session's identity and delegation depth.
 * @param {any[]} events - the session's events.
 * @returns {{id: string, cwd: string, delegationDepth: number}} header facts.
 */
function headerOf(events) {
  const header = events.find(event => event?.type === 'session')
  return {
    id: typeof header?.id === 'string' ? header.id : '(unknown)',
    cwd: typeof header?.cwd === 'string' ? header.cwd : '(unknown)',
    delegationDepth: typeof header?.delegationDepth === 'number' ? header.delegationDepth : 0,
  }
}

const options = parseArgs(process.argv.slice(2))
const sessionsRoot = path.join(options.home, 'sessions')
const logs = findLogs(sessionsRoot)

if (logs.length === 0) {
  console.error(`没有在 ${sessionsRoot} 找到任何会话日志。`)
  process.exit(1)
}

/** @type {Record<string, any[]>} */
const byVerdict = {}
/** @type {any[]} */
const rows = []

for (const log of logs) {
  let events = []
  try {
    events = parseEvents(decompressFrames(fs.readFileSync(log)))
  } catch {
    events = []
  }
  const header = headerOf(events)
  const last = events.length > 0 ? events[events.length - 1] : null
  const lastAt = typeof last?.time === 'number' ? last.time : 0

  const verdict = classifySession({
    events,
    // Replaying history cannot know the live status, so the stricter reading is
    // used: an idle driver whose log stops mid-turn is still a silent stop.
    running: false,
    isSubagent: header.delegationDepth > 0,
    // Replay judges the log's shape, not the wall clock, so the silence gate is
    // opened by passing a zero threshold and a fixed "now".
    now: lastAt > 0 ? lastAt : Date.now(),
    stallMs: options.stallMs,
    minAgeMs: 0,
    readable: true,
  })

  byVerdict[verdict.verdict] = byVerdict[verdict.verdict] ?? []
  byVerdict[verdict.verdict].push({ log, header, verdict, eventCount: events.length, lastAt })
  rows.push({ log, header, verdict, eventCount: events.length, lastAt, lastType: verdict.lastType })
}

rows.sort((a, b) => b.lastAt - a.lastAt)

console.log(`会话日志总数: ${logs.length}`)
console.log('判定分布:')
for (const [verdict, list] of Object.entries(byVerdict).sort((a, b) => b[1].length - a[1].length)) {
  console.log(`  ${verdict.padEnd(18)} ${list.length}`)
}

// Say out loud what this number is NOT, because it is directly comparable to the
// sidebar and WILL differ from it.
//
// Replay reads files only. It cannot know which sessions currently have a live driver,
// so it passes `running: false` — the strict reading, under which "log stopped
// mid-turn" is a silent stop. A session that is simply RUNNING RIGHT NOW looks
// identical by that rule and is counted as stalled here.
//
// Measured on this host: replay reports 3 while the live panel reports 0, and the 3 are
// exactly the 3 sessions with a live agent. A number that looks alarming and means
// nothing is worse than no number, so the caveat is printed with it.
console.log('')
console.log('  ⚠ 回放没有实时状态，一律按 running=false 从严判定。')
console.log('    因此「正在运行中」的会话在这里也会计成 stalled。')
console.log('    要拿实时结论，请用侧边栏、/watch 或 GET /session-watch/api/state。')

console.log('\n最近 15 个会话的判定:')
for (const row of rows.slice(0, 15)) {
  const when = row.lastAt > 0 ? new Date(row.lastAt).toISOString().slice(0, 16).replace('T', ' ') : '(无时间)'
  console.log(`  ${when}  ${String(row.eventCount).padStart(6)} 事件  ${String(row.verdict.verdict).padEnd(18)} ${row.verdict.detail}`)
}

if (options.verbose) {
  console.log('\n所有被判定为 stalled 的会话（含正在运行的，见上方说明）:')
  for (const row of rows.filter(entry => entry.verdict.verdict === 'stalled')) {
    console.log(`  ${row.header.id}  cwd=${row.header.cwd}  事件=${row.eventCount}  最后事件=${row.lastType}`)
  }
  console.log('\n所有被判定为 awaiting-approval 的会话:')
  for (const row of rows.filter(entry => entry.verdict.verdict === 'awaiting-approval')) {
    console.log(`  ${row.header.id}  cwd=${row.header.cwd}  事件=${row.eventCount}  最后事件=${row.lastType}`)
  }
}
