/**
 * Read-only measurement: how long does a HEALTHY session actually stay quiet between
 * events *within an open turn*? Used to choose `stallMs` from data instead of guessing.
 *
 * WHY "WITHIN AN OPEN TURN" IS THE ONLY RELEVANT MEASUREMENT
 *
 * A first version of this script measured the gap between EVERY consecutive pair of
 * events and reported maximums of 14-23 HOURS. That number is real but meaningless
 * here: those gaps are the idle time BETWEEN turns, after a `turn/end` and before the
 * next `turn/start` — a session sitting unused overnight. The detector never sees
 * them, because it only judges the silence that follows the newest `turn/start`.
 *
 * So the gaps that matter are the ones a running turn can legitimately produce: a
 * slow model call, a long tool. Measuring anything else would justify raising the
 * threshold on evidence that the threshold never applies to.
 */
import { findSessionLogs, readSessionLog, dshHome } from '../lib/logs.js'

const logs = findSessionLogs(dshHome())
/** @type {number[]} */
const gaps = []
/** @type {object[]} */
const largest = []

for (const log of logs) {
  const { events, readable } = await readSessionLog(log.file)
  if (!readable || events.length < 3) continue

  // Walk the log turn by turn. Inside a turn, every consecutive gap is one a running
  // turn could show; across a turn boundary it is idle time and must be skipped.
  let inTurn = false
  let maxGap = 0
  let maxAt = null
  let turnGaps = 0
  let previousTime = null
  for (const event of events) {
    if (event?.type === 'turn/start') { inTurn = true; previousTime = null; continue }
    if (event?.type === 'turn/end') { inTurn = false; previousTime = null; continue }
    if (!inTurn) continue
    const t = event?.time
    if (typeof t !== 'number') continue
    if (previousTime !== null) {
      const gap = t - previousTime
      if (gap > 0) {
        gaps.push(gap)
        turnGaps += 1
        if (gap > maxGap) { maxGap = gap; maxAt = event }
      }
    }
    previousTime = t
  }
  if (maxGap > 0) largest.push({ sessionId: log.sessionId, maxGapMs: maxGap, at: maxAt?.type ?? '?', turnGaps })
}

gaps.sort((a, b) => a - b)
const at = (p) => gaps[Math.min(gaps.length - 1, Math.floor(gaps.length * p))] ?? 0
const sec = (ms) => (ms / 1000).toFixed(1)

console.log(`sessions measured: ${logs.length}`)
console.log(`in-turn gaps measured: ${gaps.length}\n`)
console.log('=== gap distribution (within an OPEN turn only) ===')
for (const p of [0.5, 0.9, 0.99, 0.999, 0.9999]) {
  console.log(`  p${(p * 100).toFixed(p < 0.999 ? 0 : 2).padStart(6)}  ${sec(at(p)).padStart(10)}s`)
}
console.log(`  max          ${sec(gaps.at(-1) ?? 0).padStart(10)}s`)

console.log('\n=== largest in-turn gap per session (top 12) ===')
largest.sort((a, b) => b.maxGapMs - a.maxGapMs)
for (const row of largest.slice(0, 12)) {
  console.log(`  ${sec(row.maxGapMs).padStart(8)}s  ${row.sessionId.slice(0, 30)}  before=${row.at}  (${row.turnGaps} gaps)`)
}

console.log('\n=== false-positive pressure per candidate threshold ===')
console.log('(sessions whose LARGEST healthy in-turn gap already exceeds the threshold:')
console.log(' each one is a session that COULD be misread as stalled at that setting)')
for (const minutes of [3, 5, 10, 15, 20, 30, 60]) {
  const n = largest.filter(row => row.maxGapMs > minutes * 60_000).length
  console.log(`  stallMs=${String(minutes).padStart(3)}m -> ${String(n).padStart(3)} / ${largest.length} sessions`)
}
