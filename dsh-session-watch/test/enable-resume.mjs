/**
 * Enable auto-resume (layer 2), but ONLY once the running Host has the fixed code.
 *
 * WHY THIS EXISTS AS A SCRIPT RATHER THAN A DOCUMENTED ONE-LINE EDIT
 *
 * `resume.enabled` hot-reloads, but module CODE does not — the loader caches a
 * plugin's module by name. So the two orderings are not equivalent:
 *
 *   restart first, then enable   -> the new gate is in force. Safe.
 *   enable first, then restart   -> between the two, the OLD process is running with
 *                                   auto-resume ON. Its approval gate keyed on event
 *                                   names this build never emits, so a session parked
 *                                   on an approval reads as `stalled` — the one
 *                                   auto-resumable verdict — and would be nudged on
 *                                   the user's behalf.
 *
 * That second ordering is a real hazard, and it is one line away at all times. So the
 * ordering is enforced by code instead of by a warning nobody re-reads: this script
 * REFUSES to enable anything until it can prove the running process is current.
 *
 * It proves that by reading `/diagnostics`, a route added together with the two bug
 * fixes. Its absence is a precise signal, not a guess.
 *
 * Usage:
 *   node test/enable-resume.mjs            # check, then enable
 *   node test/enable-resume.mjs --check    # check only; change nothing
 */

import fs from 'node:fs'
import path from 'node:path'

const CHECK_ONLY = process.argv.includes('--check')
const home = process.env.DSH_HOME ?? path.join(process.env.USERPROFILE ?? '.', '.dsh')
const patchPath = path.join(home, 'cordis.patch.yml')
const URL_BASE = 'http://127.0.0.1:19387/session-watch/api'

/**
 * Fetch a session-watch route.
 * @param {string} route - route suffix.
 * @returns {Promise<{status: number, body: any}|null>} the response, or null on error.
 */
async function get(route) {
  try {
    // `keepalive: false` plus an explicit drain: Node's undici pool otherwise keeps a
    // socket open past `process.exit`, which surfaces as a libuv assertion
    // ("!(handle->flags & UV_HANDLE_CLOSING)") on the way out. That noise would look
    // like a script failure in a run that actually did the right thing.
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 8000)
    try {
      const response = await fetch(`${URL_BASE}${route}`, {
        headers: { 'x-session-watch': '1' },
        signal: controller.signal,
      })
      const text = await response.text()
      let body = null
      try { body = JSON.parse(text) } catch { body = text }
      return { status: response.status, body }
    } finally {
      clearTimeout(timer)
    }
  } catch {
    return null
  }
}

/**
 * Exit cleanly, letting any open socket close first.
 * @param {number} code - process exit code.
 * @returns {Promise<never>} never resolves.
 */
async function finish(code) {
  // Give undici a moment to release its pooled socket before the process ends.
  await new Promise(resolve => setTimeout(resolve, 50))
  process.exit(code)
}

console.log('=== 开启第 2 层（自动恢复） ===\n')

// ---------------------------------------------------------------------------
// 1. The Host must be up.
// ---------------------------------------------------------------------------
const state = await get('/state')
if (state === null) {
  console.log('✗ 连不上 127.0.0.1:19387 —— dsh 没在运行。先启动它。')
  await finish(1)
}
console.log(`✓ Host 在运行（/state -> HTTP ${state.status}）`)

// ---------------------------------------------------------------------------
// 2. Is the running process on CURRENT code? This is the gate.
// ---------------------------------------------------------------------------
const diagnostics = await get('/diagnostics')
if (diagnostics === null || diagnostics.status !== 200) {
  console.log(`✗ 运行中的进程仍是旧代码（/diagnostics -> ${diagnostics === null ? 'ERR' : `HTTP ${diagnostics.status}`}）`)
  console.log('')
  console.log('  拒绝开启自动恢复：在旧代码上开启，会让一个"停在审批上等你回答"的会话')
  console.log('  被判成 stalled，然后替你发一条「继续」——那正是这个闸门要防的事。')
  console.log('')
  console.log('  请先重启 dsh，然后重跑本脚本：')
  console.log('    pwsh -File C:\\agent\\dsh\\plugin\\dsh-restart\\script\\dsh-restart.ps1')
  await finish(1)
}
console.log('✓ 运行中的进程已加载当前代码')

// ---------------------------------------------------------------------------
// 3. The expert half should be mounted too (it shares this code generation).
// ---------------------------------------------------------------------------
const report = diagnostics.body
if (report?.proxyMounted === true) {
  console.log(`✓ 用户代理专家半已挂载（${(report.proxyMount?.tools ?? []).join(', ')}）`)
} else {
  console.log('⚠ 专家半未挂载；第 2 层仍可开启，但第 3 层不可用。')
  console.log('  先跑 node test/verify-live.mjs 看原因。')
}

// ---------------------------------------------------------------------------
// 4. Show what will change, and what the current state is.
// ---------------------------------------------------------------------------
console.log('')
console.log(`  当前 stallMs       : ${Math.round(state.body.stallMs / 1000)}s`)
console.log(`  当前 自动恢复      : ${state.body.resumeEnabled ? '已开启' : '未开启'}`)
console.log(`  当前 停摆会话      : ${state.body.totals.stalled}`)
console.log(`  当前 等待审批      : ${state.body.totals.awaitingApproval}`)

if (state.body.resumeEnabled === true) {
  console.log('\n自动恢复已经是开启状态，无需改动。')
  await finish(0)
}

if (CHECK_ONLY) {
  console.log('\n--check：只检查，未改动任何文件。')
  console.log('去掉 --check 即可开启。')
  await finish(0)
}

// ---------------------------------------------------------------------------
// 5. Flip the one line, preserving the file's comments.
// ---------------------------------------------------------------------------
let text
try {
  text = fs.readFileSync(patchPath, 'utf8')
} catch (error) {
  console.log(`\n✗ 读不到 ${patchPath}：${error.message}`)
  await finish(1)
}

// Target the `enabled:` line that belongs to the session-watch row's resume block.
// Walking the file keeps this from touching an unrelated `enabled:` elsewhere.
const lines = text.split('\n')
let inSessionWatch = false
let changed = false
for (let i = 0; i < lines.length; i += 1) {
  const line = lines[i]
  if (/^\s*- id:\s*session-watch\s*$/.test(line)) { inSessionWatch = true; continue }
  // Any other row id ends this row's block.
  if (/^\s*- id:\s*\S+\s*$/.test(line) && !/session-watch/.test(line)) { inSessionWatch = false; continue }
  if (inSessionWatch && /^(\s*)enabled:\s*false\s*$/.test(line)) {
    lines[i] = line.replace('enabled: false', 'enabled: true')
    changed = true
    break
  }
}

if (!changed) {
  console.log(`\n✗ 在 ${patchPath} 的 session-watch 行里没找到 \`enabled: false\`。`)
  console.log('  文件可能已被改动；请手动检查，本脚本不会猜着改。')
  await finish(1)
}

// Back up first — a config that breaks the app is worse than one that is off.
const backup = `${patchPath}.bak-before-resume-enable`
try { fs.copyFileSync(patchPath, backup) } catch { /* best effort */ }
fs.writeFileSync(patchPath, lines.join('\n'), 'utf8')
console.log(`\n✓ 已写入 ${patchPath}`)
console.log(`  备份：${backup}`)

// ---------------------------------------------------------------------------
// 6. Confirm the change actually took effect (config hot-reloads).
// ---------------------------------------------------------------------------
await new Promise(resolve => setTimeout(resolve, 2500))
const after = await get('/state')
if (after?.body?.resumeEnabled === true) {
  console.log('✓ 自动恢复已生效（config 热更新，无需再重启）')
  console.log('')
  console.log(`  每会话上限 ${after.body.resumePolicy.maxAttempts} 次，`
    + `基础退避 ${Math.round(after.body.resumePolicy.baseDelayMs / 1000)}s，`
    + `冷却 ${Math.round(after.body.resumePolicy.cooldownMs / 1000)}s`)
  console.log('  侧边栏面板与 /watch 会显示每次恢复，以及"上一次由谁发起"。')
} else {
  console.log('⚠ 文件已改，但 /state 仍显示未开启。')
  console.log('  可能是 Host 尚未重新读取配置；稍等片刻再 curl /state 确认。')
  console.log('  若始终不生效，请检查该行是否真的在 session-watch 这一行之下。')
}

