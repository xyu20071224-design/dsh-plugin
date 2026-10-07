/**
 * End-to-end test of the resume WIRING against a fake Host.
 *
 * `resume.test.mjs` proves the policy is right; this proves the plugin actually
 * OBEYS it. The distinction matters: a correct policy that is wired to the wrong
 * session, or that double-resumes, or that forgets to record an attempt, would
 * still pass the unit tests while causing real harm.
 *
 * The interface under test is `ctx.sessionController.prompt`, which is the Host's
 * "resume this Session, then admit a prompt" operation. A fake Host records every
 * call, so the assertions are about observable side effects only.
 *
 * Uses a temporary DSH_HOME, so the real ledger and real session logs are never
 * touched.
 *
 * Run: node test/resume-wiring.mjs
 *
 * @module dsh-session-watch/test/resume-wiring
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import zlib from 'node:zlib'

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

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-watch-'))
process.env.DSH_HOME = home

/**
 * Write one session log directory the way the harness persists them: a per-session
 * directory holding `session.v4.jsonl.zstd`, one zstd frame per batch.
 * @param {string} sessionId - the session id.
 * @param {object[]} events - events to persist.
 * @param {string} [cwd] - the session's working directory.
 * @returns {string} the log file path.
 */
function writeSession(sessionId, events, cwd = 'C:\\fake\\workspace') {
  const dir = path.join(home, 'sessions', 'C--fake-workspace', sessionId)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, 'session.v4.jsonl.zstd')
  const frames = events.map(event => zlib.zstdCompressSync(Buffer.from(`${JSON.stringify(event)}\n`)))
  fs.writeFileSync(file, Buffer.concat(frames))
  return file
}

const STARTED = Date.now() - 60 * 60 * 1000
/**
 * Build a session event list.
 * @param {string} sessionId - the session id.
 * @param {object[]} extra - events after the header.
 * @param {object} [header] - header overrides.
 * @returns {object[]} events.
 */
function eventsFor(sessionId, extra, header = {}) {
  return [
    { type: 'session', id: sessionId, time: STARTED, cwd: 'C:\\fake\\workspace', createdAt: STARTED, delegationDepth: 0, ...header },
    { type: 'permission/preset', time: STARTED, data: { preset: 'workspace-write' } },
    ...extra,
  ]
}

// STALLED_AT is what makes a stall fixture genuinely stalled.
//
// `silentMs` is derived from EVENT TIMESTAMPS, not from the log file's mtime. These fixtures
// previously omitted `time` entirely, so `silentMs` was 0 — and the session still classified
// as `stalled` only because the detector's `!running` branch had no silence gate. The fixture
// therefore ENCODED THE BUG: it asserted a stall while describing an event written "now".
//
// The gate now applies to both branches, so a stall fixture must actually be old. This is
// 30 minutes — twice the 15-minute default window — so the fixture stays stalled no matter
// how long the suite takes to reach it.
const STALLED_AT = Date.now() - 30 * 60 * 1000

/**
 * Stamp every event with one instant, so `silentMs` is meaningful.
 * @param {number} at - epoch ms applied to each event.
 * @param {object[]} extra - the events after the header.
 * @returns {object[]} the stamped event list.
 */
function eventsAt(at, extra) {
  return extra.map(event => ({ time: at, ...event }))
}

// One genuinely stalled session: an open turn that stopped mid-step, long enough ago that
// "silent" actually means something.
writeSession('session-stalled', eventsFor('session-stalled', eventsAt(STALLED_AT, [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 1 } },
])))
// One session parked on an approval prompt: must NEVER be resumed.
//
// The event name here is `approval/asked`, which is what this build ACTUALLY emits
// (measured: present in 10 of 178 real logs). This fixture previously used
// `approval/request` — a name that appears nowhere in any real log. That made this
// test agree with a detector bug instead of catching it: both were written from the
// upstream type names, so the suite happily verified that a fictional event was
// handled correctly while a session genuinely parked on an approval was classified
// `stalled` and resumed. A fixture must be drawn from observed data, not from what
// the code happens to expect, or it only proves the code is self-consistent.
writeSession('session-approval', eventsFor('session-approval', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'pwsh', callId: 'c1', arguments: '{}' } },
  { type: 'approval/asked', data: { id: 'approval-1', toolName: 'pwsh', callId: 'c1', reason: 'escalate sandbox' } },
]))
// One session parked on an unanswered question to the user: also must never be
// resumed. There is no event type for this state — the evidence is a tool call with
// no matching result — so it is the shape most likely to be missed.
writeSession('session-question', eventsFor('session-question', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'tool/call', data: { turn: 1, step: 1, name: 'ask_user_question', callId: 'q1', arguments: '{}' } },
]))
// One finished session: must never be resumed.
writeSession('session-idle', eventsFor('session-idle', [
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
]))
// One abandoned empty session: must never be resumed.
writeSession('session-empty', eventsFor('session-empty', []))

// Age the logs past minAgeMs without touching their content.
const old = new Date(Date.now() - 30 * 60 * 1000)
for (const sessionId of ['session-stalled', 'session-approval', 'session-question', 'session-idle', 'session-empty']) {
  fs.utimesSync(path.join(home, 'sessions', 'C--fake-workspace', sessionId, 'session.v4.jsonl.zstd'), old, old)
}

/* ── fake Cordis context ── */
const promptCalls = []
let promptFailure = null
const agentList = []
const ctx = {
  logger: { warn: (...args) => console.warn('  [warn]', ...args) },
  get(service) {
    if (service === 'agents') return { list: () => agentList }
    if (service === 'sessionController') {
      return {
        // Mirrors the REAL public service method, which is
        //   prompt(request, signal) { signal.throwIfAborted(); return this.commands.prompt(request) }
        // against an inner `async prompt(request)`. Reproducing that shape here is
        // deliberate: a stub that accepts a request alone would happily pass a
        // signal-less call, which is exactly how a real "every resume throws" bug
        // stayed invisible until auto-resume was switched on.
        async prompt(request, signal) {
          signal.throwIfAborted()
          promptCalls.push({ ...request, signal })
          if (promptFailure !== null) throw promptFailure
          return { accepted: true }
        },
      }
    }
    return undefined
  },
  effect(setup) { const r = typeof setup === 'function' ? setup() : undefined; return typeof r === 'function' ? r : () => {} },
  commands: { register: () => () => {} },
  webServer: { register: () => () => {} },
}

const plugin = await import('../lib/plugin.js')
const ON = { resume: { enabled: true, maxAttempts: 2, baseDelayMs: 1000, maxDelayMs: 60_000, cooldownMs: 0 } }
const OFF = { resume: { enabled: false } }

console.log('\n--- 关闭时绝不调用 prompt ---')
{
  const snapshot = await plugin.buildSnapshot(ctx, plugin.Config)
  check('快照标记未启用', snapshot.resumeEnabled === false)
  check('未调用 prompt', promptCalls.length === 0)
  check('stalled 会话的 willResume 为 false',
    snapshot.sessions.find(s => s.sessionId === 'session-stalled')?.resume?.willResume === false)
}

console.log('\n--- 启用后：只碰 stalled，且只碰一次 ---')
promptCalls.length = 0
{
  const snapshot = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...ON })
  check('恰好调用一次 prompt', promptCalls.length === 1, `got ${promptCalls.length}`)
  const call = promptCalls[0]
  check('目标正是 stalled 会话', call?.sessionId === 'session-stalled', String(call?.sessionId))
  check('模式为 queue', call?.mode === 'queue', String(call?.mode))
  check('requestId 是 UUID', /^[0-9a-f-]{36}$/.test(String(call?.requestId)), String(call?.requestId))
  // REGRESSION: the public `sessionController.prompt(request, signal)` calls
  // `signal.throwIfAborted()` on its FIRST line, so omitting the signal throws
  // `TypeError: Cannot read properties of undefined (reading 'throwIfAborted')`
  // before any work happens. The stub below fails the same way a real controller
  // does, so a missing signal can never pass unnoticed again.
  check('传入了 AbortSignal（缺它会让 prompt 直接抛错）',
    typeof call?.signal?.throwIfAborted === 'function',
    `signal=${typeof call?.signal}`)
  check('正文是文本段', call?.content?.[0]?.type === 'text', JSON.stringify(call?.content?.[0]))
  check('正文提到停止位置', String(call?.content?.[0]?.text ?? '').includes('turn=1'))
  // The text lands in the conversation permanently, so it must attribute the action to the
  // sender that actually sent it. The auto path is the one case where "自动续跑" is true;
  // the manual route and the expert's tool are covered in their own suites, and this asserts
  // the shared helper's default did not silently drift.
  check('自动路径的正文自称自动续跑',
    String(call?.content?.[0]?.text ?? '').startsWith('（自动续跑）'),
    String(call?.content?.[0]?.text ?? '').split('\n')[0])
  check('等待审批的会话未被触碰', !promptCalls.some(c => c.sessionId === 'session-approval'))
  check('等待用户回答的会话未被触碰', !promptCalls.some(c => c.sessionId === 'session-question'))
  check('已完成的会话未被触碰', !promptCalls.some(c => c.sessionId === 'session-idle'))
  check('空会话未被触碰', !promptCalls.some(c => c.sessionId === 'session-empty'))
  check('快照记录了恢复', snapshot.totals.resumed === 1 && snapshot.resumed[0]?.ok === true,
    JSON.stringify(snapshot.totals))
  check('恢复记录写入磁盘', fs.existsSync(path.join(home, 'session-watch.json')))
}

console.log('\n--- 已用满上限时给出"已达上限"而非"冷却中" ---')
promptCalls.length = 0
{
  // Rewrite the ledger so the session already used its full allowance. The cap
  // must win over backoff, so the reported reason is the cap: a user who sees
  // "cooling down" would expect a later retry that will never come.
  fs.writeFileSync(path.join(home, 'session-watch.json'), JSON.stringify({
    version: 1,
    sessions: { 'session-stalled': { attempts: 2, lastAttemptAt: Date.now(), history: [] } },
  }))
  const snapshot = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...ON })
  check('用满上限后不再调用 prompt', promptCalls.length === 0, `got ${promptCalls.length}`)
  const stalled = snapshot.sessions.find(s => s.sessionId === 'session-stalled')
  check('原因为已达上限', stalled?.resume?.reason === 'attempts-exhausted', String(stalled?.resume?.reason))
  check('明确不恢复', stalled?.resume?.willResume === false)
  check('记录了 2 次尝试', stalled?.resume?.attempts === 2, String(stalled?.resume?.attempts))
}

console.log('\n--- 退避未过时拒绝，退避过后允许第二次 ---')
{
  // First attempt just happened: an immediate second scan must be refused as
  // cooling down, with a real (non-zero) baseDelayMs.
  fs.writeFileSync(path.join(home, 'session-watch.json'), JSON.stringify({ version: 1, sessions: {} }))
  promptCalls.length = 0
  const policy = { ...plugin.Config, resume: { ...ON.resume, baseDelayMs: 60_000, cooldownMs: 0 } }
  const first = await plugin.buildSnapshot(ctx, policy)
  const immediately = await plugin.buildSnapshot(ctx, policy)
  check('首次恢复', first.totals.resumed === 1, JSON.stringify(first.totals))
  check('紧接着的一轮因退避而拒绝', immediately.totals.resumed === 0, JSON.stringify(immediately.totals))
  const stalled = immediately.sessions.find(s => s.sessionId === 'session-stalled')
  check('原因标注为冷却中', stalled?.resume?.reason === 'cooling-down', String(stalled?.resume?.reason))

  // Backdate the attempt past the backoff: the second (and final) attempt must run.
  const ledger = JSON.parse(fs.readFileSync(path.join(home, 'session-watch.json'), 'utf8'))
  ledger.sessions['session-stalled'].lastAttemptAt = Date.now() - 120_000
  fs.writeFileSync(path.join(home, 'session-watch.json'), JSON.stringify(ledger))
  promptCalls.length = 0
  const second = await plugin.buildSnapshot(ctx, policy)
  check('退避过后允许第二次', second.totals.resumed === 1, JSON.stringify(second.totals))
  check('共 2 次调用', promptCalls.length === 1, String(promptCalls.length))

  // And now the cap stops it for good.
  const third = await plugin.buildSnapshot(ctx, policy)
  check('上限 2 次后停止', third.totals.resumed === 0, JSON.stringify(third.totals))
  check('停止原因是已达上限',
    third.sessions.find(s => s.sessionId === 'session-stalled')?.resume?.reason === 'attempts-exhausted')
}

console.log('\n--- 失败的恢复也要计数，避免重试风暴 ---')
{
  fs.writeFileSync(path.join(home, 'session-watch.json'), JSON.stringify({ version: 1, sessions: {} }))
  promptFailure = Object.assign(new Error('no adapter serves provider "x"'), { code: 'session/model-unavailable' })
  promptCalls.length = 0
  const first = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...ON })
  const second = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...ON })
  check('失败被报告而非抛出', first.totals.resumeFailed === 1, JSON.stringify(first.totals))
  check('失败原因被记录', first.resumed[0]?.code === 'session/model-unavailable', String(first.resumed[0]?.code))
  check('扫描本身仍然成功', first.ok === true)
  check('失败后不立即重试', second.totals.resumed === 0, JSON.stringify(second.totals))
  check('失败也计入尝试次数',
    second.sessions.find(s => s.sessionId === 'session-stalled')?.resume?.attempts === 1)
  promptFailure = null
}

console.log('\n--- 渲染输出包含自动恢复状态 ---')
{
  fs.writeFileSync(path.join(home, 'session-watch.json'), JSON.stringify({ version: 1, sessions: {} }))
  const snapshot = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...ON })
  const rendered = plugin.renderSnapshot(snapshot)
  check('渲染提到已启用', rendered.text.includes('自动恢复：已启用'), rendered.text.slice(0, 200))
  check('渲染列出本轮恢复尝试', rendered.text.includes('本轮自动恢复尝试'), rendered.text.slice(0, 300))
  const offSnapshot = await plugin.buildSnapshot(ctx, { ...plugin.Config, ...OFF })
  check('关闭时渲染说明仅报告',
    plugin.renderSnapshot(offSnapshot).text.includes('未启用'), plugin.renderSnapshot(offSnapshot).text.slice(0, 200))
}

console.log('\n--- 手动恢复接口的辅助函数 ---')
{
  promptCalls.length = 0
  const outcome = await plugin.resumeSession(ctx, { sessionId: 'session-idle', turn: 1, step: 1 }, null)
  check('可手动恢复任意会话（用户判断优先）', outcome.ok === true && promptCalls.length === 1)
  check('手动恢复目标正确', promptCalls[0]?.sessionId === 'session-idle')
}

console.log('\n--- 可选依赖：即便没有 sessionController，检测层也必须可用 ---')
{
  // The real failure this guards: declaring `sessionController` in `inject` made
  // the ENTIRE plugin refuse to apply on a host where that service was not ready,
  // so the sidebar button rendered but its route 404'd. Observation must never
  // depend on an optional capability, so the resume path looks the service up at
  // call time and reports its absence instead.
  const noController = {
    logger: { warn: () => {} },
    get(service) { return service === 'agents' ? { list: () => [] } : undefined },
    effect(setup) { const r = typeof setup === 'function' ? setup() : undefined; return typeof r === 'function' ? r : () => {} },
    commands: { register: () => () => {} },
    webServer: { register: () => () => {} },
  }
  const snapshot = await plugin.buildSnapshot(noController, { ...plugin.Config, ...ON })
  check('没有 sessionController 时扫描仍成功', snapshot.ok === true)
  check('仍能作出判定', snapshot.sessions.length > 0)
  const outcome = await plugin.resumeSession(noController, { sessionId: 'x' }, null)
  check('恢复明确报"不可用"而非抛错',
    outcome.ok === false && outcome.code === 'no-controller', JSON.stringify(outcome))
}

console.log('\n--- inject 不得包含可选能力 ---')
{
  check('inject 未声明 sessionController（否则整个插件会被它阻塞）',
    !plugin.inject.includes('sessionController'), JSON.stringify(plugin.inject))
  check('inject 仍包含观察所需的三个服务',
    ['commands', 'webServer', 'agents'].every(name => plugin.inject.includes(name)))
}

fs.rmSync(home, { recursive: true, force: true })
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
