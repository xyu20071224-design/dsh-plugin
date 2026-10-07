/**
 * dsh-restart — `/restart` for the DSH desktop app.
 *
 * WHY THE RESTART IS DELEGATED TO AN EXTERNAL SCRIPT
 * --------------------------------------------------
 * The Web GUI is a CHILD of the Electron desktop shell, and the shell supervises
 * it over a private IPC channel that a Cordis plugin cannot recreate:
 *
 *   spawn(this.node, [...], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
 *
 * `app.relaunch()` exists only behind the crash-recovery dialog, the packaged
 * update path, and a development-only menu — none of them reachable from a
 * plugin. So this plugin cannot quit or relaunch the app, and it does not
 * pretend to: it delegates to `script/dsh-restart.ps1`, which drives the app
 * from OUTSIDE (quit, wait for full exit, start again). The script is not part
 * of `app.asar`, so app updates never overwrite it.
 *
 * WHAT THIS PLUGIN OWNS
 * ---------------------
 *   * the `/restart` command (registered inside `ctx.effect`, so unload disposes it);
 *   * argument validation — `/restart` takes no arguments;
 *   * resolving the interpreter, the script, and the shell executable to restart;
 *   * spawning the script exactly as the interface contract specifies, and
 *     honestly reporting what came back.
 *
 * THE HONESTY RULE
 * ----------------
 * The script hands off to an escaped worker and returns almost immediately, so
 * its answer is "launched", not "restarted" — and this plugin is about to be
 * killed by the restart it just started. The final status therefore lands in
 * `-ResultPath`, which this plugin polls every 250 ms. A missing file, or a
 * `launched` status, is interim: it is NEVER reported as "the restart
 * succeeded". Only a terminal status written by the worker is reported as fact.
 *
 * @module @local/dsh-restart
 */

import { spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Loader row name; also the command name. */
export const name = 'restart'

/** The command registry renders `/restart`; hard dependency on that service. */
export const inject = ['commands']

/**
 * Cordis plugin configuration schema.
 *
 * Deliberately accepts nothing useful. Every flag the restart script receives is
 * fixed by the interface contract, and a configurable flag could change a
 * safety-relevant invocation (for example by turning a graceful quit into a
 * forced kill) from a patch row, where the user would never see it.
 *
 * This MUST be a Standard Schema, not a plain object. Measured in the deployed
 * runtime (`@deepseek-ai/cordis/lib/index.js:956-962`), a truthy `Config` whose
 * value has no `~standard.validate` throws
 * `TypeError: Cannot read properties of undefined (reading 'validate')` during
 * activation — so `export const Config = {}` makes the whole row fail to load,
 * even though the schema is empty. The object below implements just enough of
 * the Standard Schema contract (sync `validate` → `{value}` or `{issues}`) to
 * validate an empty row without pulling in a validation library the package does
 * not depend on.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-restart',
    validate(value) {
      if (value === undefined || value === null) return { value: {} }
      if (typeof value !== 'object' || Array.isArray(value)) {
        return { issues: [{ message: 'restart config must be an object', path: [] }] }
      }
      return { value: { ...value } }
    },
  },
}

/** `index.js` sits at the package root, so this is `<pkgDir>`. */
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

/** The script is a sibling of this module: `<pkgDir>\script\dsh-restart.ps1`. */
const SCRIPT_DIR = 'script'
const SCRIPT_FILE = 'dsh-restart.ps1'

/** The worker's result is polled at this cadence, per the interface contract. */
const POLL_INTERVAL_MS = 250

/**
 * How long this plugin waits for a terminal status before answering "started,
 * unconfirmed".
 *
 * The wait is irrelevant to the happy path — the plugin is killed by the
 * restart long before this expires. It matters in the cases where the app does
 * NOT go away: the script's own quit window is 45 s, so a wait that covers that
 * window plus the handoff is what lets a genuine failure (`quit-timeout`) be
 * reported as the real status instead of a vague "started".
 */
const RESULT_WAIT_MS = 60_000

/** Bound on the one-off `Get-Process` query used to resolve the shell path. */
const APP_QUERY_TIMEOUT_MS = 10_000

/** Rejection text for any argument, per the interface contract. */
const NO_ARGUMENTS_TEXT = '用法：/restart（无需参数）'

/**
 * Process images this plugin refuses to pass as `-AppPath`.
 *
 * The script's terminate set is "every process whose image path equals
 * `-AppPath`" (contract §4). When the plugin runs inside the real desktop shell
 * the parent image IS the shell, so this guard never fires. But when the same
 * code runs under a plain interpreter (a test harness, a CLI host), the parent
 * image is one of these — and passing it along would make the script terminate
 * an entire family of unrelated processes. Omitting `-AppPath` instead lets the
 * script use its own, narrower auto-detection.
 */
const NON_SHELL_IMAGES = new Set([
  'node.exe',
  'pwsh.exe',
  'powershell.exe',
  'cmd.exe',
  'conhost.exe',
  'wscript.exe',
  'cscript.exe',
  'wmiprvse.exe',
])

/**
 * Absolute path the bundled script is expected at.
 * @param {string} packageDir - package root; overridable for tests.
 * @returns {string} the expected script path (which may not exist).
 */
function expectedScriptPath(packageDir = PACKAGE_DIR) {
  return join(packageDir, SCRIPT_DIR, SCRIPT_FILE)
}

/**
 * Locate the bundled restart script.
 * @param {string} [packageDir] - package root; overridable for tests.
 * @returns {string | null} the absolute script path, or null when it is missing.
 */
export function resolveScript(packageDir = PACKAGE_DIR) {
  const candidate = expectedScriptPath(packageDir)
  return existsSync(candidate) ? candidate : null
}

/**
 * Locate a PowerShell interpreter capable of running the script.
 *
 * Order, per the contract: `$DSH_RESTART_POWERSHELL`, then PowerShell 7, then
 * Windows PowerShell 5.1. Both are invoked with `-NoProfile -NonInteractive`, so
 * no user profile can change behaviour and nothing can block on a prompt.
 *
 * @returns {string | null} an absolute interpreter path, or null when neither exists.
 */
export function resolvePowerShell() {
  const programFiles = process.env.ProgramFiles
  const systemRoot = process.env.SystemRoot
  const candidates = [
    process.env.DSH_RESTART_POWERSHELL,
    programFiles === undefined ? undefined : join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
    systemRoot === undefined
      ? undefined
      : join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
  ]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim() !== '' && existsSync(candidate)) return candidate
  }
  return null
}

/**
 * Run a PowerShell one-liner and capture its stdout.
 *
 * Used only for the `Get-Process` query below. The command text is built from an
 * integer this module validated, so there is no injection surface, and no shell
 * is involved (the argv array is passed verbatim).
 *
 * @param {string} interpreter - absolute PowerShell path.
 * @param {string} command - the command text.
 * @param {number} timeoutMs - hard bound.
 * @returns {Promise<string | null>} stdout, or null on error/timeout/non-zero exit.
 */
function runPowerShellCapture(interpreter, command, timeoutMs) {
  return new Promise(resolve => {
    let child
    try {
      child = spawn(interpreter, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', command], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch {
      resolve(null)
      return
    }

    let stdout = ''
    let done = false
    const finish = value => {
      if (done) return
      done = true
      clearTimeout(timer)
      resolve(value)
    }
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      finish(null)
    }, timeoutMs)

    child.stdout?.setEncoding?.('utf8')
    child.on('error', () => finish(null))
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.on('close', code => finish(code === 0 ? stdout : null))
  })
}

/**
 * Ask Windows for the image path of one process.
 * @param {string} interpreter - absolute PowerShell path.
 * @param {number} pid - target process id.
 * @returns {Promise<string | null>} the image path, or null when it cannot be read.
 */
async function queryImagePath(interpreter, pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  const stdout = await runPowerShellCapture(interpreter, `(Get-Process -Id ${pid} -ErrorAction Stop).Path`, APP_QUERY_TIMEOUT_MS)
  if (stdout === null) return null
  const path = stdout
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line !== '')
    .pop()
  if (path === undefined || !existsSync(path)) return null
  return path
}

/**
 * Resolve the desktop shell executable to restart.
 *
 * The host process is the shell's child, so `process.ppid` IS the shell pid: the
 * normal path is `Get-Process -Id <ppid>` → `.Path`. `$DSH_DESKTOP_APP_PATH` is
 * honoured as a fallback (it is the second entry of the contract's own
 * auto-detection order); the remaining known locations are left to the script,
 * so no machine-specific install path is baked into this plugin.
 *
 * The first parameter accepts either an interpreter path (string) or a pid
 * (number), so the function is usable from a test without the parent process.
 *
 * @param {string | number | null} [interpreterOrPpid] - interpreter path, or the pid to inspect.
 * @param {number} [ppid] - parent pid; defaults to this process's parent.
 * @returns {Promise<string | null>} the absolute shell image path, or null when unresolved.
 */
export async function resolveAppPath(interpreterOrPpid = null, ppid = process.ppid) {
  let interpreter = null
  if (typeof interpreterOrPpid === 'number') ppid = interpreterOrPpid
  else if (typeof interpreterOrPpid === 'string' && interpreterOrPpid.trim() !== '') interpreter = interpreterOrPpid

  const resolved = interpreter ?? resolvePowerShell()
  if (resolved !== null) {
    const fromParent = await queryImagePath(resolved, ppid)
    if (fromParent !== null) return fromParent
  }

  const configured = process.env.DSH_DESKTOP_APP_PATH
  if (typeof configured === 'string' && configured.trim() !== '' && existsSync(configured)) return configured
  return null
}

/**
 * Drop an `-AppPath` that must not become the script's terminate set.
 * @param {string | null} appPath - the resolved candidate.
 * @returns {string | null} the path to pass, or null to let the script decide.
 */
function restartTarget(appPath) {
  if (appPath === null) return null
  if (NON_SHELL_IMAGES.has(basename(appPath).toLowerCase())) return null
  return appPath
}

/**
 * Parse the last JSON object in a blob of text.
 *
 * The script prints one compact object per `-Json` invocation, but a partial
 * read of a file being written, or leading noise on stdout, must not be
 * mistaken for a result. Returns null when nothing parses.
 *
 * @param {string} text - raw text, possibly with noise or partial content.
 * @returns {object | null} the parsed object, or null.
 */
function parseJsonOutput(text) {
  const trimmed = text.trim()
  if (trimmed === '') return null
  try {
    const whole = JSON.parse(trimmed)
    if (typeof whole === 'object' && whole !== null) return whole
  } catch {
    // Not one complete object; fall through to a line scan.
  }
  const lines = trimmed.split(/\r?\n/)
  for (let index = lines.length - 1; index >= 0; index--) {
    const candidate = lines[index].trim()
    if (!candidate.startsWith('{')) continue
    try {
      const parsed = JSON.parse(candidate)
      if (typeof parsed === 'object' && parsed !== null) return parsed
    } catch {
      // Not the result line.
    }
  }
  return null
}

/**
 * Read a TERMINAL status from the worker's result file.
 *
 * A missing file, unparseable content, or the `launched` handoff stub all mean
 * "not yet" — the worker is still working, or has not written its outcome. This
 * is the distinction the whole design turns on: the stub must never be mistaken
 * for the answer.
 *
 * @param {string} resultFile - the path passed to the script as `-ResultPath`.
 * @returns {object | null} the parsed terminal result, or null while interim.
 */
function readTerminalResult(resultFile) {
  let text
  try {
    if (!existsSync(resultFile)) return null
    text = readFileSync(resultFile, 'utf8')
  } catch {
    return null
  }
  const parsed = parseJsonOutput(text)
  if (parsed === null) return null
  const status = typeof parsed.status === 'string' ? parsed.status.trim() : ''
  if (status === '' || status === 'launched') return null
  return parsed
}

/**
 * Spawn the restart script and collect its outcome.
 *
 * The invocation is byte-for-byte the contract's:
 *
 *   <interpreter> -NoProfile -NonInteractive -ExecutionPolicy Bypass
 *                 -File <script> -Json -ResultPath <file> [-AppPath <exe>]
 *
 * `stdio: ['ignore','pipe','pipe']` and `windowsHide: true`, and deliberately NO
 * `detached`: a detached PowerShell child was measured on this machine to exit 0
 * having done nothing at all, which for a command whose only job is to restart
 * the app is the worst possible failure. Escaping the process job is the
 * script's job (it hands off through WMI), not the spawn's.
 *
 * `-AppPath` is omitted when it could not be resolved (or was rejected by the
 * guard above): passing an empty value to a `-File` invocation is not reliably
 * parsed by Windows PowerShell 5.1, whereas omission is unambiguous and lets the
 * script fall back to its own detection.
 *
 * @param {string} interpreter - absolute PowerShell path.
 * @param {string} script - absolute script path.
 * @param {string} resultFile - absolute path the worker writes its result to.
 * @param {string | null} appPath - shell executable, or null to let the script decide.
 * @returns {Promise<object>} an outcome shaped for {@link toCommandResult}.
 */
function runRestart(interpreter, script, resultFile, appPath) {
  const argv = [
    '-NoProfile',
    '-NonInteractive',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Json',
    '-ResultPath',
    resultFile,
  ]
  if (appPath !== null) argv.push('-AppPath', appPath)

  return new Promise(resolve => {
    let stdout = ''
    let stderr = ''
    let spawnError = null
    let exitCode = null
    let exited = false
    let settled = false

    let child
    try {
      child = spawn(interpreter, argv, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      resolve({ status: '', detail: '', code: null, spawnError: String(error?.message ?? error) })
      return
    }

    const finish = outcome => {
      if (settled) return
      settled = true
      clearInterval(timer)
      resolve(outcome)
    }

    /** Decide whether a result is available yet, or whether we are still waiting. */
    const inspect = () => {
      const terminal = readTerminalResult(resultFile)
      if (terminal !== null) {
        finish({ ...terminal, stdout, stderr, spawnError: null })
        return
      }
      if (spawnError !== null) {
        finish({ status: '', detail: '', code: null, stdout, stderr, spawnError })
        return
      }
      // A non-zero caller exit with no result file is a real failure — the
      // handoff never happened, so no worker is coming.
      if (exited && exitCode !== 0) {
        finish({ status: '', detail: stderr.trim() || stdout.trim(), code: exitCode, stdout, stderr, spawnError: null })
        return
      }
      // Exit 0 with no terminal file means the handoff is in flight: keep
      // polling for the worker's own result rather than answering the stub.
      if (Date.now() >= deadline) {
        finish({ status: 'launched', detail: '', code: exitCode, stdout, stderr, spawnError: null })
      }
    }

    const deadline = Date.now() + RESULT_WAIT_MS
    const timer = setInterval(inspect, POLL_INTERVAL_MS)

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', chunk => { stdout += String(chunk) })
    child.stderr?.on('data', chunk => { stderr += String(chunk) })
    child.on('error', error => {
      spawnError = String(error?.message ?? error)
      inspect()
    })
    child.on('close', code => {
      exitCode = code
      exited = true
      inspect()
    })

    inspect()
  })
}

/**
 * Normalize anything a caller may pass to {@link toCommandResult}.
 *
 * Accepts the parsed script result (`{status, detail, code}`), a bare status
 * string, and — for callers that hold a raw process outcome — an object whose
 * `stdout` carries the script's JSON (`{code, stdout, stderr, spawnError}`).
 *
 * @param {unknown} outcome - the raw outcome.
 * @returns {{ status: string, detail: string, code: number | null, spawnError: string | null }}
 */
function normalizeOutcome(outcome) {
  const empty = { status: '', detail: '', code: null, spawnError: null }
  if (typeof outcome === 'string') return { ...empty, status: outcome.trim() }
  if (outcome === null || typeof outcome !== 'object') return empty

  const spawnError = typeof outcome.spawnError === 'string' && outcome.spawnError.trim() !== ''
    ? outcome.spawnError.trim()
    : null
  const code = Number.isInteger(outcome.code) ? outcome.code : null
  let status = typeof outcome.status === 'string' ? outcome.status.trim() : ''
  let detail = typeof outcome.detail === 'string' ? outcome.detail.trim() : ''

  if (status === '' && typeof outcome.stdout === 'string') {
    const parsed = parseJsonOutput(outcome.stdout)
    if (parsed !== null) {
      if (typeof parsed.status === 'string') status = parsed.status.trim()
      if (detail === '' && typeof parsed.detail === 'string') detail = parsed.detail.trim()
    }
  }
  if (status !== 'launched' && typeof outcome.stderr === 'string' && detail === '') {
    detail = outcome.stderr.trim()
  }
  return { status, detail, code, spawnError }
}

/**
 * Status text for every terminal status the script can write (contract §5),
 * plus the interim `launched` handoff.
 *
 * `kind` is 'success' ONLY for a status that positively means the requested
 * restart happened or was not needed. `launched` is therefore 'error', not
 * 'success': the contract states that interim state is NOT success, because the
 * plugin is about to be killed by the restart it started and has observed
 * nothing yet. The text below still describes the restart as in progress rather
 * than as a failure, so the user is not misled in the other direction either.
 */
export const STATUS_MESSAGES = {
  launched: {
    kind: 'error',
    text: [
      '重启已开始，但最终结果无法在这里确认（结果由后台进程写入，而本会话会随应用一起退出）。',
      '预期过程：dsh 退出 → 完全退出后重新启动 → 窗口自动弹出。',
      '如果屏幕上出现退出确认框，请点“退出”让它继续 —— 从会话里发起重启时，该会话本身就算“正在运行的任务”，出现确认框是正常的。',
      '约一分钟后窗口仍未出现，说明重启没有完成：可手动运行 script\\dsh-restart.ps1 查看具体原因。',
    ].join('\n'),
  },
  restarted: { kind: 'success', text: 'dsh 已重启：应用已退出，新的窗口已经出现。' },
  started: { kind: 'success', text: 'dsh 之前没有在运行，现在已经启动。' },
  'quit-only': { kind: 'success', text: 'dsh 已退出（脚本被要求只退出，不重启）。' },
  'not-running': { kind: 'success', text: 'dsh 当前没有在运行，无需重启。' },
  'would-restart': {
    kind: 'success',
    text: '（试运行）本可以重启 dsh：脚本只解析了目标并报告计划，没有退出或启动任何进程。',
  },
  'app-not-found': { kind: 'error', text: '重启失败：找不到 DeepSeek Harness 可执行文件。' },
  'quit-timeout': {
    kind: 'error',
    text: '重启失败：dsh 没有在超时时间内退出，重启已中止；屏幕上可能有退出确认框等待确认。',
  },
  'start-failed': { kind: 'error', text: '重启失败：dsh 已退出，但新窗口没有在超时时间内出现。' },
  'already-running': {
    kind: 'error',
    text: '已有一个重启正在进行，这次请求什么都没有做；等它结束后再试一次。',
  },
}

/**
 * Turn a script outcome into the command result the user sees.
 *
 * SAFETY-CRITICAL: a restart that failed, or whose outcome is unknown, must
 * never be reported as done. A spawn failure, an unrecognized status, and the
 * interim handoff each map to text that says what is actually known — nothing
 * here claims a restart that was not observed.
 *
 * Exported for testing so the mapping can be verified without quitting the app.
 *
 * @param {unknown} outcome - a parsed script result, a status string, or a raw process outcome.
 * @returns {{ kind: 'success' | 'error', text: string }} the command result.
 */
export function toCommandResult(outcome) {
  const normalized = normalizeOutcome(outcome)

  if (normalized.spawnError !== null) {
    return { kind: 'error', text: `重启失败：无法运行重启脚本。原因：${normalized.spawnError}` }
  }

  const known = Object.prototype.hasOwnProperty.call(STATUS_MESSAGES, normalized.status)
    ? STATUS_MESSAGES[normalized.status]
    : undefined

  if (known !== undefined) {
    return {
      kind: known.kind,
      text: [known.text, normalized.detail].filter(part => part !== '').join('\n'),
    }
  }

  // No status at all, or one this plugin does not know. Never a silent success:
  // the contract's rule is that an unconfirmed restart is not a successful one.
  const because = normalized.detail !== ''
    ? normalized.detail
    : `重启脚本没有返回可识别的状态（status="${normalized.status}"）。`
  const guidance = '可以手动运行 script\\dsh-restart.ps1 -Json 查看完整输出。'

  return {
    kind: 'error',
    text: [
      '重启未确认：重启脚本已结束，但返回的结果无法识别，因此无法确认是否真的重启了。',
      because,
      guidance,
    ].join('\n'),
  }
}

/**
 * Register `/restart`.
 *
 * The registration happens inside `ctx.effect(...)` so that unloading the row
 * disposes the command with it (the disposer `commands.register` returns is
 * yielded to Cordis).
 *
 * @param {object} ctx - Cordis context with the `commands` service injected.
 * @param {object} config - the row's configuration; intentionally unused.
 */
export function apply(ctx, config) {
  const handler = async invocation => {
    // `/restart` takes no arguments. `rawInput` is everything after the command
    // name, so a line like `/restart --force` is rejected here — the command
    // must not gain a hidden switch that changes how the app is terminated.
    if (String(invocation?.rawInput ?? '').trim() !== '') {
      return { kind: 'error', text: NO_ARGUMENTS_TEXT }
    }

    const script = resolveScript()
    if (script === null) {
      return {
        kind: 'error',
        text: `重启失败：找不到重启脚本。预期位置：${expectedScriptPath()}`,
      }
    }

    const interpreter = resolvePowerShell()
    if (interpreter === null) {
      return { kind: 'error', text: '重启失败：找不到 PowerShell 解释器（pwsh.exe 或 powershell.exe）。' }
    }

    const appPath = restartTarget(await resolveAppPath(interpreter))
    const resultFile = join(tmpdir(), `dsh-restart-${randomBytes(8).toString('hex')}.json`)
    // The name is unique per invocation, so a stale result can never be read as
    // this run's outcome. Clearing the (unused) path is pure defence.
    try { rmSync(resultFile, { force: true }) } catch { /* nothing to clear */ }

    ctx.logger?.info?.(
      'restart: %s -File %s -ResultPath %s%s',
      interpreter,
      script,
      resultFile,
      appPath === null ? '' : ` -AppPath ${appPath}`,
    )

    const result = toCommandResult(await runRestart(interpreter, script, resultFile, appPath))
    if (result.kind === 'error') ctx.logger?.error?.('restart: %s', result.text)
    else ctx.logger?.info?.('restart: %s', result.text)
    return result
  }

  ctx.effect(function* () {
    yield ctx.commands.register({
      name,
      description: '重启 dsh 桌面应用：由外部脚本退出应用并重新启动（窗口会关闭后自动打开）',
      handler,
    })
  }, 'restart: /restart')
}
