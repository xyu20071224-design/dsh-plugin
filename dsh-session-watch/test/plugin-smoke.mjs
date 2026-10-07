/**
 * Host-half smoke test: build a real snapshot against the real DSH home.
 *
 * This exercises the actual code path the running plugin uses — log discovery,
 * zstd frame decoding, classification, and command rendering — with a stub
 * Cordis context, so the Host half can be verified without restarting the GUI.
 *
 * Run: node test/plugin-smoke.mjs [--json]
 *
 * @module dsh-session-watch/test/plugin-smoke
 */

import { apply, buildSnapshot, renderSnapshot } from '../lib/plugin.js'

const wantJson = process.argv.includes('--json')

/**
 * Minimal Cordis stand-in.
 *
 * `get` returns only the agents registry, because that is the one service the
 * snapshot builder consults; everything else the plugin registers is captured so
 * the test can assert on it.
 *
 * `effect` deliberately supports the GENERATOR form. Shipped packages register
 * commands as `ctx.effect(function* () { yield ctx.commands.register(...) })`, so
 * a stub that only called function-form setups would report "no command
 * registered" about code that works in production.
 * @returns {any} a fake context with captured registrations.
 */
function fakeContext() {
  const captured = { commands: [], routes: [], effects: 0 }
  /** Live agents in this process, mirroring `ctx.agents.list()`. */
  const liveAgents = []

  /**
   * Drive a generator effect to completion, running each yielded registration.
   * @param {Generator} generator - the effect body.
   * @returns {void}
   */
  function runGenerator(generator) {
    let step = generator.next()
    while (step.done !== true) {
      // Each `yield` is a registration call; its returned disposer is ignored
      // here because the test asserts on what got captured, not on teardown.
      step = generator.next(step.value)
    }
  }

  return {
    captured,
    liveAgents,
    logger: { warn: (...args) => console.warn('[plugin warned]', ...args) },
    get(service) {
      if (service !== 'agents') return undefined
      return { list: () => liveAgents }
    },
    effect(setup) {
      captured.effects += 1
      const produced = typeof setup === 'function' ? setup() : undefined
      if (produced !== null && typeof produced === 'object' && typeof produced.next === 'function') {
        runGenerator(produced)
        return () => {}
      }
      return typeof produced === 'function' ? produced : () => {}
    },
    commands: {
      register(definition) {
        captured.commands.push(definition)
        return () => {}
      },
    },
    webServer: {
      register(registration) {
        captured.routes.push(registration)
        return () => {}
      },
    },
  }
}

const config = { stallMs: 5 * 60 * 1000, minAgeMs: 60 * 1000, pollMs: 600_000, maxSessions: 200 }

const ctx = fakeContext()
apply(ctx, config)
const route = ctx.captured.routes[0]
/** Filled by the caching check below, asserted further down. */
let cachedFirst = null
let cachedSecond = null

console.log(`注册的命令: ${ctx.captured.commands.map(c => '/' + c.name).join(', ') || '(无)'}`)
console.log(`注册的路由: ${ctx.captured.routes.map(r => r.path).join(', ') || '(无)'}`)
console.log(`注册的 effect 数: ${ctx.captured.effects}`)

const snapshot = await buildSnapshot(ctx, config)
console.log(`\n发现会话日志: ${snapshot.totals.scanned}`)
console.log(`判定汇总: ${JSON.stringify(snapshot.totals)}`)

if (snapshot.attention.length > 0) {
  console.log('\n需要关注的会话:')
  for (const session of snapshot.attention) {
    console.log(`  ${session.sessionId}`)
    console.log(`    cwd=${session.cwd}  turn=${session.turn} step=${session.step} 事件=${session.eventCount}`)
    console.log(`    ${session.detail}`)
  }
} else {
  console.log('\n当前没有被判定为静默停摆的会话。')
}

// Exercise the /watch command handler exactly as the GUI would invoke it.
const command = ctx.captured.commands[0]
if (command !== undefined) {
  const result = await command.handler({ rawInput: '' })
  console.log(`\n--- /watch 输出 (kind=${result.kind}) ---`)
  console.log(result.text)
}

if (wantJson) {
  console.log('\n--- snapshot JSON ---')
  console.log(JSON.stringify(snapshot, null, 2).slice(0, 4000))
}

// REGRESSION: a repeat read must not pay for a full scan.
//
// The first version of the route called a `refresh()` that only collapsed CONCURRENT
// calls, so every non-overlapping poll triggered its own scan. Measured on a 190-session
// host a scan takes ~3.5s, and the sidebar polls this route — so every poll stalled the
// UI for seconds, and the background timer's work was never consumed by anyone.
//
// This drives the route twice through the real handler and asserts the second read is
// answered from the freshness window: same `generatedAt`, and effectively no elapsed time.
if (route !== undefined) {
  const callState = async () => {
    let captured = null
    const started = Date.now()
    await route.handler(
      { method: 'GET', url: '/session-watch/api/state', headers: { 'x-session-watch': '1' } },
      {
        headersSent: false,
        writeHead() { this.headersSent = true },
        end(payload) { captured = JSON.parse(payload) },
        destroy() {},
      },
    )
    return { ms: Date.now() - started, body: captured }
  }
  const first = await callState()
  const second = await callState()
  console.log(`\n--- /state 缓存 ---`)
  console.log(`  首次: ${first.ms}ms`)
  console.log(`  再次: ${second.ms}ms`)
  cachedFirst = first
  cachedSecond = second
}

// Sanity assertions, so this file is a test and not only a report.
let passed = 0
let failed = 0
const check = (label, condition) => {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}`) }
}
console.log('\n--- 断言 ---')
check('注册了 /watch 命令', ctx.captured.commands.some(c => c.name === 'watch'))
check('注册了 /session-watch/api 路由', ctx.captured.routes.some(r => r.path === '/session-watch/api'))
check('扫描到了会话', snapshot.totals.scanned > 0)
check('快照带 ok 标记', snapshot.ok === true)
check('每个会话都有判定', snapshot.sessions.every(s => typeof s.verdict === 'string'))
check('attention 全部是 stalled', snapshot.attention.every(s => s.verdict === 'stalled'))
check('可自动恢复的仅有 stalled',
  snapshot.sessions.every(s => s.autoResumable === (s.verdict === 'stalled')))
check('渲染函数可产出文本', typeof renderSnapshot(snapshot).text === 'string')
// The caching regression. Asserted on OUTCOME (same snapshot, no elapsed work) rather
// than on internals, so any implementation that serves a repeat read cheaply passes.
check('重复读取命中缓存（同一份快照）',
  cachedFirst !== null && cachedSecond !== null
  && cachedSecond.body.generatedAt === cachedFirst.body.generatedAt)
check('重复读取不做全量扫描（耗时接近于零）',
  cachedSecond !== null && cachedSecond.ms < Math.max(200, cachedFirst.ms / 4),
  `first=${cachedFirst?.ms}ms second=${cachedSecond?.ms}ms`)

// Print the count in the SAME format the other suites use. A suite that reports only
// "全部通过" cannot be summed by `run-all.mjs`'s readers or by any script totalling the
// assertions, which is how this file's 8 checks went uncounted in the project's own
// totals until it was noticed.
console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
