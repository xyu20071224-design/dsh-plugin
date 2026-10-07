/**
 * Read-only survey: the COMPLETE real event vocabulary across this host's session
 * logs, and whether any session is parked on an unresolved approval.
 *
 * This exists because the detector's `AWAITING_TYPES` list contains names that may
 * never appear in real logs, which would make the approval gate silently dead.
 */
import { findSessionLogs, readSessionLog, dshHome } from '../lib/logs.js'

const logs = findSessionLogs(dshHome())
console.log(`session logs: ${logs.length}\n`)

/** @type {Map<string, number>} */
const vocab = new Map()
/** @type {object[]} */
const pendingApprovals = []
/** @type {object[]} */
const awaitingShaped = []

for (const log of logs) {
  const { events, readable } = await readSessionLog(log.file)
  if (!readable) continue
  const seen = new Set()
  for (const event of events) if (event?.type) seen.add(event.type)
  for (const type of seen) vocab.set(type, (vocab.get(type) ?? 0) + 1)

  // Unresolved approval: asked with no matching decided.
  const asked = new Map()
  const decided = new Set()
  for (const event of events) {
    if (event?.type === 'approval/asked' && event.data?.id) asked.set(event.data.id, event.seq)
    if (event?.type === 'approval/decided' && event.data?.id) decided.add(event.data.id)
  }
  const open = [...asked.entries()].filter(([id]) => !decided.has(id))
  if (open.length > 0) {
    pendingApprovals.push({
      sessionId: log.sessionId,
      lastType: events.at(-1)?.type ?? null,
      openIds: open.map(([id, seq]) => `${id}@${seq}`),
    })
  }

  // Any session whose LAST event is an approval-shaped event.
  const last = events.at(-1)?.type ?? ''
  if (/approval|question|plan/.test(last)) {
    awaitingShaped.push({ sessionId: log.sessionId, last, count: events.length })
  }
}

console.log('=== complete event vocabulary (type -> #sessions containing it) ===')
for (const [type, count] of [...vocab.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  console.log(`  ${String(count).padStart(4)}  ${type}`)
}

console.log('\n=== sessions whose LAST event is approval/question/plan-shaped ===')
if (awaitingShaped.length === 0) console.log('  (none)')
for (const row of awaitingShaped) console.log(`  ${row.sessionId}  last=${row.last}  events=${row.count}`)

console.log('\n=== sessions with an UNRESOLVED approval/asked ===')
if (pendingApprovals.length === 0) console.log('  (none)')
for (const row of pendingApprovals) {
  console.log(`  ${row.sessionId}  last=${row.lastType}  open=${row.openIds.join(',')}`)
}
