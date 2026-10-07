/**
 * Inspect the tail of specific sessions by id fragment, to adjudicate whether a
 * `stalled` verdict is a true positive or an artifact of the replay harness.
 *
 * Run: node test/tail.mjs <id-fragment> [<id-fragment> ...]
 *
 * @module dsh-session-watch/test/tail
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd]

/**
 * Decompress every complete Zstandard frame in a log.
 * @param {Buffer} buffer - raw log bytes.
 * @returns {string} concatenated plaintext.
 */
function decompressFrames(buffer) {
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
    } catch { /* torn tail frame */ }
  }
  return text
}

/**
 * Find every compressed session log beneath a root.
 * @param {string} root - directory to walk.
 * @returns {string[]} absolute log paths.
 */
function findLogs(root) {
  const found = []
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.endsWith('.jsonl.zstd')) found.push(full)
    }
  }
  walk(root)
  return found
}

const home = process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
const fragments = process.argv.slice(2)
const logs = findLogs(path.join(home, 'sessions'))

for (const fragment of fragments) {
  const match = logs.find(log => log.includes(fragment))
  if (match === undefined) {
    console.log(`\n=== ${fragment}: 未找到 ===`)
    continue
  }
  const events = decompressFrames(fs.readFileSync(match)).split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
  const header = events.find(event => event?.type === 'session')

  console.log(`\n=== ${fragment} ===`)
  console.log(`文件: ${match}`)
  console.log(`cwd: ${header?.cwd}  事件数: ${events.length}  agentPreset: ${header?.agentPreset}`)
  console.log(`最后 10 条事件:`)
  for (const event of events.slice(-10)) {
    const when = typeof event.time === 'number' ? new Date(event.time).toISOString().slice(11, 23) : '??'
    const data = JSON.stringify(event.data ?? {})
    console.log(`  ${when} seq=${String(event.seq ?? '-').padStart(6)} ${String(event.type).padEnd(22)} ${data.slice(0, 150)}`)
  }
}
