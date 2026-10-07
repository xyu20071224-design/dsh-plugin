/**
 * Tests for log reading and bounded views.
 *
 * The `tailEvents` contract is load-bearing and was learned from a real
 * regression: a plain trailing window cut off the current turn's `turn/start`,
 * which made CLOSED turns look open and reported 15 finished sessions as
 * stalled. These tests pin the fix.
 *
 * Run: node test/logs.test.mjs
 *
 * @module @local/dsh-session-watch/test/logs
 */

import zlib from 'node:zlib'

import { decompressFrames, parseEvents, headerOf, tailEvents, dshHome } from '../lib/logs.js'

let passed = 0
let failed = 0

/**
 * Assert a condition.
 * @param {string} label - what is being verified.
 * @param {boolean} condition - the observed result.
 * @param {string} [extra] - detail printed on failure.
 * @returns {void}
 */
function check(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`) }
}

console.log('\n--- zstd frame decoding ---')
{
  // The persistence backend writes one independently compressed frame per batch,
  // so a log is many frames back to back. Decoding must handle the concatenation.
  const frames = [
    zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n')),
    zlib.zstdCompressSync(Buffer.from('{"type":"turn/start","data":{"turn":1}}\n')),
    zlib.zstdCompressSync(Buffer.from('{"type":"turn/end","data":{"turn":1}}\n')),
  ]
  const text = decompressFrames(Buffer.concat(frames))
  const events = parseEvents(text)
  check('三帧拼接后可解出 3 个事件', events.length === 3, `got ${events.length}`)
  check('事件顺序保持', events[0]?.type === 'session' && events[2]?.type === 'turn/end')
}
{
  // A live session's newest frame can be torn mid-write; earlier frames still count.
  const good = zlib.zstdCompressSync(Buffer.from('{"type":"session","id":"s1"}\n'))
  const torn = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x00, 0x01, 0x02])
  const events = parseEvents(decompressFrames(Buffer.concat([good, torn])))
  check('撕裂的尾帧被跳过而非致命', events.length === 1, `got ${events.length}`)
}
check('空缓冲不抛异常', parseEvents(decompressFrames(Buffer.alloc(0))).length === 0)

console.log('\n--- header extraction ---')
{
  const events = [
    { type: 'session', id: 'session-x', cwd: 'C:\\w', delegationDepth: 0, createdAt: 111 },
    { type: 'turn/start', data: { turn: 1 } },
  ]
  const header = headerOf(events)
  check('id 正确', header.id === 'session-x')
  check('cwd 正确', header.cwd === 'C:\\w')
  check('createdAt 正确', header.createdAt === 111)
  check('缺失头时字段为 null', headerOf([]).id === null && headerOf([]).createdAt === null)
}

console.log('\n--- tailEvents: the truncation regression ---')
{
  // A long turn: its `turn/start` sits far beyond a plain trailing window.
  const events = [{ type: 'session', id: 's1', createdAt: 1 }]
  events.push({ type: 'turn/start', seq: 1, data: { turn: 7 } })
  for (let i = 0; i < 1000; i += 1) {
    events.push({ type: 'tool/call', seq: 2 + i, time: 1000 + i, data: { turn: 7, step: i } })
  }
  events.push({ type: 'turn/end', seq: 5000, time: 9999, data: { turn: 7, reason: { kind: 'completed' } } })

  const bounded = tailEvents(events, 400)
  check('保留了 header', bounded.some(e => e?.type === 'session'))
  check('保留了当前轮的 turn/start（关键回归点）', bounded.some(e => e?.type === 'turn/start'),
    'a plain tail window would drop it and make a closed turn look open')
  check('保留了 turn/end', bounded.some(e => e?.type === 'turn/end'))
  check('结果有界', bounded.length <= 402, `got ${bounded.length}`)
  // Order must stay chronological, or the turn-scoped scan walks backwards.
  let ordered = true
  for (let i = 1; i < bounded.length; i += 1) {
    if ((bounded[i].seq ?? 0) < (bounded[i - 1].seq ?? 0)) ordered = false
  }
  check('保持时间顺序', ordered)
}
{
  // Short logs are returned untouched.
  const events = [{ type: 'session' }, { type: 'turn/start' }]
  check('未超限时原样返回', tailEvents(events, 400).length === 2)
  check('非数组输入安全', tailEvents(null, 400).length === 0)
}

console.log('\n--- dshHome resolution ---')
{
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = 'C:\\custom-home'
  check('DSH_HOME 优先', dshHome() === 'C:\\custom-home')
  process.env.DSH_HOME = '   '
  check('空白 DSH_HOME 回落到主目录', dshHome().endsWith('.dsh'))
  if (previous === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previous
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
