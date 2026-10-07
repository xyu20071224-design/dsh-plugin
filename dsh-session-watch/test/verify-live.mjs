/**
 * One-command verification that the WHOLE three-layer loop is live after a restart.
 *
 * WHY THIS SCRIPT EXISTS
 *
 * The two facts that matter most here cannot be seen from inside the workspace:
 *
 *   1. Whether the running Host process actually loaded the CURRENT module code.
 *      A restart is required for that (the loader caches a plugin's module by name),
 *      and "the file on disk is correct" does not imply "the process is running it".
 *      This project already shipped a bug that survived a whole test suite because
 *      the running process had stale code.
 *   2. Whether the agent preset's composition actually MOUNTED, as opposed to its
 *      declaration row merely being present and `active`.
 *
 * Both are answered here from the outside, in one pass, with a clear verdict.
 *
 * Usage: node test/verify-live.mjs
 */

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh')
/**
 * Base URL of the Host under test.
 *
 * Overridable so the PASS path can be exercised. Against the deployment's own port this
 * script can only ever be seen failing while a restart is pending, and a checker that has
 * never once been observed succeeding is not evidence that it works — it might simply be
 * unable to pass. Pointing it at an already-restarted Host (a second instance on another
 * port) proves the verdict is reachable.
 */
const URL_BASE = (process.argv[2] ?? 'http://127.0.0.1:19387') + '/session-watch/api'

/**
 * Opt-in flag for the call-level prompt check, which WRITES to a session.
 *
 * Never chosen automatically: the session id must follow the flag, so a person decides
 * which session may receive a resume prompt. See the note at the check itself.
 */
const PROBE_FLAG = '--resume-probe'
const probeIndex = process.argv.indexOf(PROBE_FLAG)
const probeTarget = probeIndex >= 0 ? process.argv[probeIndex + 1] : undefined

/** @type {string[]} */
const problems = []
/** @type {string[]} */
const notes = []

/**
 * Fetch a session-watch route.
 * @param {string} route - route suffix, e.g. `/state`.
 * @returns {Promise<{status: number, body: any}|null>} the response, or null on error.
 */
async function get(route) {
  try {
    const response = await fetch(`${URL_BASE}${route}`, { headers: { 'x-session-watch': '1' } })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  } catch (error) {
    return null
  }
}

console.log('=== 会话监视三层闭环 — 实机验证 ===\n')

// ---------------------------------------------------------------------------
// 0. Is the Host even up?
// ---------------------------------------------------------------------------
let state = await get('/state')
if (state === null) {
  console.log('✗ 无法连接 127.0.0.1:19387 —— dsh 没有在运行。')
  console.log('  先启动 dsh 应用，再重跑本脚本。')
  process.exit(1)
}
console.log(`✓ Host 在运行（/state -> HTTP ${state.status}）`)

// ---------------------------------------------------------------------------
// 1. Is the running process on CURRENT code?
//
// `/diagnostics` was added together with the two bug fixes, so its absence is a
// precise signal: the process is running a module generation from before them.
// ---------------------------------------------------------------------------
const diagnostics = await get('/diagnostics')
const codeIsCurrent = diagnostics !== null && diagnostics.status === 200
if (codeIsCurrent) {
  console.log('✓ 运行中的进程已加载当前代码（/diagnostics 存在）')
} else {
  problems.push(
    '运行中的 Host 仍是旧代码：/diagnostics 返回 '
    + `${diagnostics === null ? '连接失败' : `HTTP ${diagnostics.status}`}。`
    + ' config 会热更新但模块不会，必须重启 dsh 才能加载修复后的判定闸门与 prompt signal。',
  )
  console.log(`✗ 运行中的 Host 仍是旧代码（/diagnostics -> ${diagnostics === null ? 'ERR' : `HTTP ${diagnostics.status}`}）`)
}

// ---------------------------------------------------------------------------
// 2. Did the expert half actually MOUNT?
// ---------------------------------------------------------------------------
if (codeIsCurrent) {
  const report = diagnostics.body
  if (report.proxyMounted === true) {
    console.log('✓ 用户代理专家半已挂载')
    console.log(`    工具：${(report.proxyMount?.tools ?? []).join(', ')}`)
    console.log(`    pid=${report.proxyMount?.pid}  mountedAt=${new Date(report.proxyMount?.mountedAt).toISOString()}`)
  } else if (report.staleProxyMount !== null && report.staleProxyMount !== undefined) {
    problems.push(
      '专家半的挂载记录来自另一个进程，说明当前进程没有加载它。'
      + ` 记录 pid=${report.staleProxyMount.pid}，当前 pid=${report.pid}。`,
    )
    console.log('✗ 专家半未在当前进程挂载（只有别的进程留下的旧记录）')
  } else {
    problems.push(
      '专家半没有挂载。检查 preset-user-proxy 的 session-watch-proxy 行是否解析成功'
      + `（proxyModule.ok=${report.proxyModule?.ok}）。`,
    )
    console.log(`✗ 专家半没有挂载（proxyModule.ok=${report.proxyModule?.ok}）`)
  }
  for (const service of report.services ?? []) {
    if (!service.present) notes.push(`服务 ${service.name} 当前不可用`)
  }
} else {
  console.log('· 专家半挂载：跳过（需要先重启）')
}

// ---------------------------------------------------------------------------
// 3. Detection sanity on the real host
// ---------------------------------------------------------------------------
if (state.status === 200 && state.body?.totals !== undefined) {
  const t = state.body.totals
  console.log(`✓ 扫描正常：${t.scanned} 个会话 — stalled ${t.stalled}，等待审批 ${t.awaitingApproval}，`
    + `空 ${t.empty}，subagent ${t.subagent}`)
  console.log(`    stallMs=${Math.round(state.body.stallMs / 1000)}s  `
    + `自动恢复=${state.body.resumeEnabled ? '已开启' : '未开启'}`)

  // This is the AUTHORITATIVE stall count: the Host knows which sessions have a live
  // driver, so it does not mistake "running right now" for "stopped". A number that
  // dwarfs the live session count means the detector is misfiring — the failure mode
  // that produced 23 false positives during development.
  if (t.stalled > 10) {
    problems.push(`stalled=${t.stalled} 数量异常偏高（实时判定），疑似误报；先跑 node test/replay.mjs --verbose 看证据。`)
  }
} else {
  problems.push(`/state 未返回可用快照（HTTP ${state.status}）。`)
}

// ---------------------------------------------------------------------------
// 3b. Does the fixed `prompt(request, signal)` call actually reach the controller?
//
// `/diagnostics` proves the module generation, but the signal bug lived in the CALL, so
// it deserves its own live check. The distinguishing evidence is the SHAPE of the reply:
// the old code fails with a raw `throwIfAborted` TypeError before entering the
// controller, while the fixed code gets a typed RemoteError back from it.
// ---------------------------------------------------------------------------
if (codeIsCurrent) {
  // `POST /resume` is a WRITE: it sends a real "continue" message into someone's session.
  //
  // This block used to pick `candidates[0]` and resume it, to prove the signal fix at the
  // call level. Against the user's own Host that injected a resume prompt into two of their
  // live sessions AND spent their auto-resume allowance, because every attempt is recorded.
  // A session can never be un-nudged, so a verification script must not do this — least of
  // all by choosing a session on the user's behalf.
  //
  // So it is now read-only unless the caller explicitly names a disposable session.
  if (probeTarget === undefined) {
    console.log('✓ 代码代次正确；调用级 signal 检查默认不做（POST /resume 是写操作）')
    notes.push(
      '未做调用级 prompt 检查：那需要真的发出一个续跑提示。',
      `  如需该证据，显式指定一个可牺牲的会话：`,
      `  node test/verify-live.mjs <baseUrl> ${PROBE_FLAG} <sessionId>`,
    )
  } else {
    let reply = null
    try {
      const response = await fetch(`${URL_BASE}/resume?sessionId=${encodeURIComponent(probeTarget)}`, {
        method: 'POST',
        headers: { 'x-session-watch': '1' },
      })
      reply = { status: response.status, body: await response.json() }
    } catch {
      reply = null
    }
    const message = String(reply?.body?.error ?? '')
    if (/throwIfAborted/.test(message)) {
      problems.push(
        'prompt 调用仍然命中 throwIfAborted —— 运行中的进程是缺 signal 的旧代码。'
        + ' 必须重启 dsh。',
      )
      console.log('✗ prompt signal 修复未生效（命中 throwIfAborted）')
    } else if (reply !== null) {
      console.log(`✓ prompt 调用进入了 controller（HTTP ${reply.status}，`
        + `code=${reply.body?.code ?? 'null'}）—— signal 已正确传入`)
      console.log(`  （已向 ${probeTarget} 发出一条续跑提示——这是你显式指定的写操作）`)
    }
  }
}

// ---------------------------------------------------------------------------
// 4. The preset must be in the composed profile
// ---------------------------------------------------------------------------
const bundleManifest = path.join(home, 'profiles', 'desktop', 'package.json')
try {
  const manifest = JSON.parse(fs.readFileSync(bundleManifest, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? []
  if (bundles.includes('@local/dsh-user-proxy')) {
    console.log('✓ user-proxy bundle 已在 profile 的 bundles 列表里')
  } else {
    problems.push('@local/dsh-user-proxy 不在 profile 的 dsh.profile.bundles 里，preset 不会装配。')
    console.log('✗ user-proxy bundle 不在 bundles 列表里')
  }
} catch (error) {
  problems.push(`无法读取 profile 清单 ${bundleManifest}：${error.message}`)
}

// ---------------------------------------------------------------------------
// 5. Test suite and real-log replay
// ---------------------------------------------------------------------------
console.log('\n--- 测试套件 ---')
const suite = spawnSync(process.execPath, [path.join(here, 'run-all.mjs')], {
  encoding: 'utf8',
  cwd: path.join(here, '..'),
})
const suiteLine = (suite.stdout ?? '').split('\n')
  .filter(line => /^(通过 \d+，失败 \d+|全部测试通过|\d+ 个套件失败)/.test(line.trim()))
if (suite.status === 0) {
  const total = (suite.stdout.match(/^通过 (\d+)，失败 0$/gm) ?? [])
    .reduce((sum, line) => sum + Number(line.match(/(\d+)/)[1]), 0)
  console.log(`✓ 全部测试通过（${total} 项断言）`)
} else {
  problems.push('测试套件未全绿；先修好再谈自动恢复。')
  console.log('✗ 测试套件未全绿')
  for (const line of suiteLine.slice(-4)) console.log(`    ${line.trim()}`)
}

console.log('\n--- 真实日志 replay（形状检查） ---')
const replay = spawnSync(process.execPath, [path.join(here, 'replay.mjs')], {
  encoding: 'utf8',
  cwd: path.join(here, '..'),
})
const distribution = (replay.stdout ?? '').split('\n')
  .filter(line => /^\s{2}(stalled|awaiting-approval|idle|empty|subagent|aborted-by-user|too-young|unreadable)\s+\d+/.test(line))
for (const line of distribution) console.log(`  ${line.trim()}`)
// NOT used as a false-positive gate. Replay has no live status, so it counts
// currently-running sessions as stalled (see the caveat it prints). The live numbers
// above come from the Host, which DOES know; that is the authority. Replay's value here
// is showing the SHAPE of the corpus, and catching a change large enough to be a
// detector regression rather than a fact about what is running.
const stalledLine = distribution.find(line => line.trim().startsWith('stalled'))
const stalledCount = stalledLine === undefined ? null : Number(stalledLine.trim().split(/\s+/)[1])
if (stalledCount !== null && stalledCount > 25) {
  problems.push(
    `replay 判定 stalled=${stalledCount}，远超"正在运行的会话数"这一解释范围，疑似判定回归；`
    + '先跑 node test/replay.mjs --verbose 看证据。',
  )
}

// ---------------------------------------------------------------------------
// Verdict
// ---------------------------------------------------------------------------
console.log(`\n${'='.repeat(56)}`)
if (notes.length > 0) {
  console.log('备注：')
  for (const note of notes) console.log(`  · ${note}`)
}
if (problems.length === 0) {
  console.log('结论：三层闭环已就绪。')
  console.log('  第 1 层（发现）、第 3 层（专家）可用。')
  if (state.body?.resumeEnabled !== true) {
    console.log('  第 2 层（自动恢复）仍关闭 —— 现在可以开启：')
    console.log('    node test/enable-resume.mjs')
    console.log('  （该脚本会先复核运行中的进程确实是当前代码，再改配置；')
    console.log('    在旧代码上开启会让审批闸门失效，所以这个顺序由脚本强制。）')
  } else {
    console.log(`  第 2 层（自动恢复）已开启，每会话上限 ${state.body.resumePolicy?.maxAttempts} 次。`)
  }
  process.exit(0)
}
console.log('结论：还有问题需要处理：')
for (const problem of problems) console.log(`  ✗ ${problem}`)
process.exit(1)
