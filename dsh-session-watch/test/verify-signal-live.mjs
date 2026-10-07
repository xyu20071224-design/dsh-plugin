/**
 * Proves the `prompt(request, signal)` fix against the REAL sessionController.
 *
 * WHY THIS NEEDS A LIVE HOST
 *
 * `resume-wiring.mjs` uses a STUB controller that mimics the real two-layer signature.
 * That is a good regression test, but it is still my own model of the contract — and this
 * project has already been burned twice by tests that agreed with the implementation
 * instead of with reality.
 *
 * The one thing a stub cannot establish is that the REAL `sessionController.prompt`
 * accepts the call. So this script runs it against a real Host and reads the SHAPE of the
 * answer, which distinguishes the two generations unambiguously:
 *
 *   OLD code (no signal)  -> a raw `TypeError: Cannot read properties of undefined
 *                            (reading 'throwIfAborted')`, thrown BEFORE the controller is
 *                            entered. It carries no `code`.
 *   NEW code (signal sent) -> a typed `RemoteError` from the controller itself, e.g.
 *                            `code: 'session/not-found'`. Reaching that point REQUIRES
 *                            `prompt()` to have been entered, which requires a
 *                            non-aborted signal.
 *
 * The `not-found` outcome is therefore a PASS, not a failure: it means the call travelled
 * all the way into `resolveAgent`. Whether the session happens to exist is a property of
 * the host under test, not of the fix.
 *
 * Usage: node test/verify-signal-live.mjs [baseUrl]
 */

const BASE = process.argv[2] ?? 'http://127.0.0.1:19387'
const GUARD = { 'x-session-watch': '1' }

/**
 * Call a route and return status plus parsed body.
 * @param {string} route - route suffix.
 * @param {object} [init] - fetch options.
 * @returns {Promise<{status: number, body: any}|null>} the response, or null on transport error.
 */
async function call(route, init = {}) {
  try {
    const response = await fetch(`${BASE}/session-watch/api${route}`, {
      headers: GUARD,
      ...init,
    })
    const text = await response.text()
    let body = null
    try { body = JSON.parse(text) } catch { body = text }
    return { status: response.status, body }
  } catch {
    return null
  }
}

console.log(`=== 验证 prompt 的 signal 修复（对真实 controller） ===`)
console.log(`host: ${BASE}\n`)

/**
 * Exit cleanly after letting undici release its pooled socket.
 *
 * Without this, Node can tear the process down while the HTTP handle is still closing
 * and print a libuv assertion (`!(handle->flags & UV_HANDLE_CLOSING)`), which reads like
 * a crash in a run that actually reached a correct verdict.
 * @param {number} code - exit code.
 * @returns {Promise<never>} never resolves.
 */
async function finish(code) {
  await new Promise(resolve => setTimeout(resolve, 60))
  process.exit(code)
}

const state = await call('/state')
if (state === null) {
  console.log(`✗ 连不上 ${BASE}。先启动 dsh。`)
  await finish(2)
}
if (state.status !== 200) {
  console.log(`✗ /state -> HTTP ${state.status}`)
  await finish(2)
}
console.log(`✓ Host 在运行，扫描到 ${state.body.totals.scanned} 个会话`)

// Pick ANY session the host knows about, preferring a stalled one. Which session it is
// does not matter: the test is about how the CALL fails, not whether it succeeds.
const candidates = [
  ...(state.body.attention ?? []),
  ...(state.body.sessions ?? []),
].map(row => row.sessionId)

if (candidates.length === 0) {
  console.log('✗ 没有可用会话可测。至少需要一个会话 id。')
  await finish(2)
}

const target = candidates[0]
console.log(`✓ 用会话 ${target} 试一次手动恢复\n`)

const resumed = await call(`/resume?sessionId=${encodeURIComponent(target)}`, { method: 'POST' })
if (resumed === null) {
  console.log('✗ 请求失败（传输层）。')
  await finish(2)
}

console.log(`  HTTP ${resumed.status}`)
console.log(`  body: ${JSON.stringify(resumed.body)}\n`)

const body = resumed.body ?? {}
const message = String(body.error ?? '')
const code = body.code

// The distinguishing question: did the call REACH the controller?
if (/throwIfAborted/.test(message)) {
  console.log('✗ 未通过：命中 throwIfAborted。这正是缺 signal 的旧代码的签名——')
  console.log('  运行中的进程仍在跑修复前的模块，需要重启 dsh。')
  await finish(1)
}

if (typeof code === 'string' && code !== 'no-controller') {
  console.log(`✓ 通过：controller 返回了带类型的错误 code=${code}`)
  console.log('  这说明 prompt() 真的被进入了（signal 存在且未中止）。')
  console.log('  会话是否存在与本修复无关——`session/not-found` 也是通过。')
  await finish(0)
}

if (body.ok === true) {
  console.log('✓ 通过：恢复被接受（ok=true）。prompt() 进入并完成了入队。')
  await finish(0)
}

if (code === 'no-controller') {
  console.log('✗ 未通过：controller 不可用（no-controller）。此 Host 没有 sessionController。')
  await finish(1)
}

console.log(`? 无法判定：既不是 throwIfAborted，也没有可识别的 code。`)
console.log('  请人工查看上面的 body。')
await finish(2)
