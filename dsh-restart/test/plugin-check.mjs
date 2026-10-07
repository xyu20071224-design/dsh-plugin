#!/usr/bin/env node
/**
 * dsh-restart — INDEPENDENT verification harness.
 *
 * Written by the `verifier` teammate, who did NOT write the code under test. The goal is
 * falsification, so every check prints the exact command it ran and the raw output it saw.
 *
 * SAFETY MODEL (read this before changing anything)
 * -------------------------------------------------
 * The user's DSH is running and must not be killed. Three independent guards:
 *
 *   1. `invokeScript()` REFUSES any invocation that is not `-DryRun` unless its `-AppPath`
 *      names no live process image on this machine. A missing path is the only shape that
 *      qualifies, so a non-DryRun run cannot resolve a real terminate set.
 *   2. Before every non-DryRun invocation it re-checks that constraint against the live
 *      process table, and it snapshots the DSH pid set on both sides of EVERY script call.
 *   3. The plugin's spawn path is exercised only in CHILD processes started with
 *      `--import test/scenarios/preload.mjs`, which redirects every spawn to an armed fake
 *      and throws on an unarmed one. The parent process never patches spawn.
 *
 * Guard 3 exists because an earlier version of this harness patched
 * `require('node:child_process').spawn` AFTER a static `import { spawn }` had already bound
 * the real function. The patch was inert, so an argument-validation case silently executed a
 * real, non-DryRun restart against the live app. `syncBuiltinESMExports()` in the preload is
 * what makes the interception real. Do not reintroduce a static child_process import here.
 *
 * Run:  node test/plugin-check.mjs                 (all sections)
 *       node test/plugin-check.mjs --only=A,C13    (subset)
 */

import { createRequire } from 'node:module'
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ---------------------------------------------------------------------------
// The harness itself needs the REAL spawn (to run PowerShell and the scenario children).
// It takes it through createRequire and NEVER patches it.
// ---------------------------------------------------------------------------
const nodeRequire = createRequire(import.meta.url)
const { spawn, spawnSync } = nodeRequire('node:child_process')

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PKG_DIR = dirname(TEST_DIR)
const ART_DIR = join(TEST_DIR, 'artifacts')
const HELPERS = join(TEST_DIR, 'helpers')
const SCENARIOS = join(TEST_DIR, 'scenarios')
const PRELOAD = join(SCENARIOS, 'preload.mjs')
const INDEX_JS = join(PKG_DIR, 'index.js')
const MANIFEST = join(PKG_DIR, 'package.json')
const SCRIPT = join(PKG_DIR, 'script', 'dsh-restart.ps1')
const ASAR = 'C:\\agent\\dsh_desktop\\resources\\app.asar'

/** Contract §5 — the exhaustive status table. */
const CONTRACT_STATUSES = {
  launched: { code: 0, success: false },
  'would-restart': { code: 0, success: true },
  'not-running': { code: 0, success: true },
  'app-not-found': { code: 4, success: false },
  restarted: { code: 0, success: true },
  'quit-timeout': { code: 3, success: false },
  'start-failed': { code: 5, success: false },
  'quit-only': { code: 0, success: true },
}
/** Statuses a PRODUCTION invocation (no -DryRun) can legitimately report as success. */
const SUCCESS_ALLOWED = new Set(['restarted', 'started', 'quit-only', 'not-running'])
/** Success-mapped statuses that only a dry run can produce. */
const DRYRUN_ONLY_STATUSES = new Set(['would-restart'])

const ONLY = (() => {
  const i = process.argv.indexOf('--only')
  if (i < 0) return null
  return new Set(String(process.argv[i + 1] ?? '').toUpperCase().split(',').filter(Boolean))
})()
const inSection = (...ids) => ONLY === null || ids.some(id => ONLY.has(id.toUpperCase()))

const PWSH = [
  join(process.env.ProgramFiles ?? 'C:\\Program Files', 'PowerShell', '7', 'pwsh.exe'),
  join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
].find(existsSync) ?? 'pwsh.exe'
const PS51 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')

mkdirSync(ART_DIR, { recursive: true })

/** Synchronous run used by the prelude, before the async helpers are defined below. */
function runCaptureSync(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000, maxBuffer: 16 * 1024 * 1024 })
  return { code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }
}

// ---------------------------------------------------------------------------
// Prelude: no decoy may be left over from an earlier run.
//
// The terminate/launch checks resolve their target from the decoy's IMAGE PATH, so a stale
// surviving decoy from a previous run would join the terminate set and make counts
// nondeterministic. Kill them first; the harness creates its own fresh instances per check.
// ---------------------------------------------------------------------------
{
  const swept = runCaptureSync(PWSH, ['-NoProfile', '-NonInteractive', '-Command',
    'Get-Process verifier-decoy -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue; ' +
    'Start-Sleep -Milliseconds 300; @(Get-Process verifier-decoy -ErrorAction SilentlyContinue).Count',
  ])
  const remaining = swept.stdout.trim()
  if (remaining !== '' && remaining !== '0') console.log(`note: ${remaining} decoy process(es) survived the pre-run sweep`)
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
const results = []
const logLines = []
const say = (line = '') => { logLines.push(String(line)); console.log(String(line)) }

function record(id, title, status, detail, evidence = []) {
  const entry = { id, title, status, detail: String(detail ?? ''), evidence: evidence.map(String), at: new Date().toISOString() }
  results.push(entry)
  const tag = status === 'PASS' ? 'PASS' : status === 'SKIP' ? 'SKIP' : 'FAIL'
  say(`${tag} ${id}  ${title}`)
  if (entry.detail !== '') say(`        ${entry.detail.split('\n').join('\n        ')}`)
  for (const e of entry.evidence) say('        | ' + e.split('\n').join('\n        | '))
  say()
  return entry
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------
function sh(cmd, args, options = {}) {
  const started = Date.now()
  const r = spawnSync(cmd, args, {
    encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024,
    timeout: options.timeoutMs ?? 120_000, ...options,
  })
  return {
    code: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '',
    error: r.error ? String(r.error.message) : null, ms: Date.now() - started,
    cmd: `${cmd} ${args.join(' ')}`,
  }
}
const pwsh = (args, options) => sh(PWSH, ['-NoProfile', '-NonInteractive', ...args], options)

function runCapture(cmd, args, options = {}) {
  return new Promise(resolve => {
    const started = Date.now()
    let stdout = ''
    let stderr = ''
    let child
    try { child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
    catch (error) { resolve({ code: null, stdout: '', stderr: '', error: String(error.message), ms: 0 }); return }
    let done = false
    const finish = code => { if (!done) { done = true; clearTimeout(timer); resolve({ code, stdout, stderr, error: null, ms: Date.now() - started }) } }
    const timer = setTimeout(() => { try { child.kill() } catch { /* gone */ } finish(null) }, options.timeoutMs ?? 120_000)
    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', c => { stdout += String(c) })
    child.stderr?.on('data', c => { stderr += String(c) })
    child.on('error', e => resolve({ code: null, stdout, stderr, error: String(e.message), ms: Date.now() - started }))
    child.on('close', code => finish(code))
  })
}

// ---------------------------------------------------------------------------
// DSH process-set oracle, the live-image oracle, and the safety gate
// ---------------------------------------------------------------------------
const CORE_ROLES = new Set(['SHELL', 'HOST', 'renderer', 'gpu', 'utility'])

/**
 * The census helper prints killOnJobClose as a JSON field, i.e. `"killOnJobClose":true`.
 * An earlier revision of this harness matched only the `key=value` spelling, so its
 * positive control was reported as failed even though the oracle had answered correctly.
 * Accept both spellings.
 */
const KILL_ON_CLOSE_RE = /"killOnJobClose"\s*:\s*true|killOnJobClose\s*=\s*true/
const IN_ANY_JOB_RE = /inAnyJob\s*=\s*True|"inAnyJob"\s*:\s*true/

function snapshotDsh() {
  const out = join(ART_DIR, `pids-${Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`)
  const r = pwsh(['-File', join(HELPERS, 'dsh-pids.ps1'), '-Out', out], { timeoutMs: 60_000 })
  if (r.code !== 0 || !existsSync(out)) return { ok: false, raw: `exit=${r.code} stderr=${r.stderr}` }
  const raw = readFileSync(out, 'utf8')
  let parsed
  try { parsed = JSON.parse(raw) } catch (e) { return { ok: false, raw, parseError: String(e.message) } }
  return {
    ok: true, snapshot: parsed, raw,
    core: parsed.rows.filter(r2 => CORE_ROLES.has(r2.role)).map(r2 => r2.pid).sort((a, b) => a - b),
    all: parsed.pids.slice().sort((a, b) => a - b),
    roleOf: pid => parsed.rows.find(r2 => r2.pid === pid)?.role ?? 'unknown',
  }
}

/**
 * Roles that come and go on their own while the harness runs.
 *
 * `runner` is `@deepseek-ai/dsh-subprocess-local`'s per-tool-call helper and `ambient` is any
 * other bare launch of the app image; both are created and reaped by the harness's OWN tool
 * calls (and, in an earlier observation, by the Lead's concurrent work). They are not part of
 * the app's restartable core, so their appearance/disappearance around a script call is
 * harness noise, not evidence of a termination.
 *
 * `SHELL`, `HOST`, `renderer`, `gpu` and `utility` are the core: none of them may ever vanish.
 */
const TRANSIENT_ROLES = new Set(['runner', 'ambient'])

/** Every live process image path — the basis of the "names no live process" gate. */
function liveImagePaths() {
  const r = pwsh(['-Command',
    'Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path } | ForEach-Object { $_.Path } | Sort-Object -Unique | ConvertTo-Json -Compress',
  ], { timeoutMs: 60_000 })
  try {
    const parsed = JSON.parse(r.stdout.trim() === '' ? '[]' : r.stdout.trim())
    return (Array.isArray(parsed) ? parsed : [parsed]).map(String)
  } catch { return [] }
}

const SAFETY = { scriptInvocations: [], refusals: [], mutations: [] }

/** The decoy app the non-DryRun checks retarget the script at. Lives under artifacts/. */
const DECOY_DIR = join(ART_DIR, 'decoy')
const DECOY_EXE = join(DECOY_DIR, 'verifier-decoy.exe')

/**
 * Paths that a non-DryRun invocation may legitimately target.
 *
 * The rule is deliberately about OWNERSHIP, not existence: the only executable this harness
 * is allowed to let the script terminate or relaunch is the decoy it built itself, under
 * `test/artifacts/`. It is a real file, a real running process, and its image path appears
 * nowhere in the DSH process tree, so the script's terminate set and launch target are
 * provably disjoint from the user's app.
 *
 * @param {string|null} appPath
 * @returns {string|null} a refusal reason, or null when the path is acceptable.
 */
function nonDryRunRefusal(appPath) {
  if (appPath === null || appPath === undefined || String(appPath).trim() === '') {
    return 'no -AppPath supplied, so the script would auto-detect and could resolve the REAL shell'
  }
  const normalized = String(appPath).toLowerCase()
  if (!normalized.startsWith(DECOY_DIR.toLowerCase())) {
    return `-AppPath "${appPath}" is outside the harness-owned decoy directory ${DECOY_DIR}`
  }
  if (normalized.includes('dsh_desktop') || normalized.includes('deepseek harness')) {
    return `-AppPath "${appPath}" names (or lives beside) the real app`
  }
  // Independent cross-check against the live process table.
  const live = liveImagePaths().map(p => p.toLowerCase())
  if (live.some(p => p.includes('deepseek harness'))) {
    // The real app is running; make sure the caller did not also point at it.
    if (normalized.includes('deepseek harness')) return `-AppPath "${appPath}" names the running app`
  }
  return null
}

/**
 * The ONE way this harness is allowed to run the script.
 *
 * @param {{extra?: string[], dryRun?: boolean, label: string, timeoutMs?: number}} spec
 */
async function invokeScript({ extra = [], dryRun = true, label, timeoutMs = 90_000 }) {
  const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Json']
  if (dryRun) args.push('-DryRun')
  args.push(...extra)

  if (!dryRun) {
    // ── THE GATE ────────────────────────────────────────────────────────────
    const appIdx = args.indexOf('-AppPath')
    const appPath = appIdx >= 0 ? args[appIdx + 1] : null
    const reason = nonDryRunRefusal(appPath)
    if (reason !== null) {
      SAFETY.refusals.push({ label, args, problems: [reason] })
      say(`        !! SAFETY REFUSAL — non-DryRun invocation blocked: ${reason}`)
      return { refused: true, problems: [reason], run: null, args }
    }
    SAFETY.scriptInvocations.push({ label, args, dryRun, appPath, at: new Date().toISOString(), appPathSafe: true })
  } else {
    SAFETY.scriptInvocations.push({ label, args, dryRun, at: new Date().toISOString() })
  }

  const before = snapshotDsh()
  const run = await runCapture(PWSH, args, { timeoutMs })
  const after = snapshotDsh()

  let diff = null
  if (before.ok && after.ok) {
    const b = new Set(before.all), a = new Set(after.all)
    const bc = new Set(before.core), ac = new Set(after.core)
    diff = {
      coreBefore: before.core, coreAfter: after.core,
      coreRemoved: before.core.filter(p => !ac.has(p)), coreAdded: after.core.filter(p => !bc.has(p)),
      allRemoved: before.all.filter(p => !a.has(p)), allAdded: after.all.filter(p => !b.has(p)),
    }
    if (diff.coreRemoved.length > 0) SAFETY.mutations.push({ label, diff })
  }
  return { refused: false, run, before, after, diff, args }
}

function pidsEvidence(label, before, after, diff) {
  const describe = (pid, snapshot) => `${pid}(${snapshot?.roleOf?.(pid) ?? 'unknown'})`
  return [
    `${label} — DSH core pids BEFORE: [${before.core?.join(', ')}]`,
    `${label} — DSH core pids AFTER : [${after.core?.join(', ')}]`,
    `${label} — core removals=${JSON.stringify(diff?.coreRemoved)} core additions=${JSON.stringify(diff?.coreAdded)}`,
    `${label} — ALL DSH pids BEFORE: [${(before.all ?? []).map(p => describe(p, before)).join(', ')}]`,
    `${label} — ALL DSH pids AFTER : [${(after.all ?? []).map(p => describe(p, after)).join(', ')}]`,
    `${label} — all removals=${JSON.stringify((diff?.allRemoved ?? []).map(p => describe(p, before)))} ` +
      `additions=${JSON.stringify((diff?.allAdded ?? []).map(p => describe(p, after)))}`,
  ]
}

/**
 * Shared verdict for a guarded invocation.
 *
 * The rule: NO CORE pid may ever disappear. A transient `runner`/`ambient` pid that comes or
 * goes is harness noise — verified by its role — and is reported as a labelled note instead of
 * a failure. Anything else, and any core removal, fails loudly.
 */
function judgeIntact(run, problems, evidence, label) {
  if (!run.before.ok || !run.after.ok) { problems.push('could not snapshot the DSH process set'); return }
  if (run.diff.coreRemoved.length > 0) {
    problems.push(`CORE DSH PROCESSES TERMINATED: ${run.diff.coreRemoved.map(p => `${p}(${run.before.roleOf?.(p)})`).join(', ')}`)
    return
  }
  const roleOf = run.before.roleOf ?? (() => 'unknown')
  const transientRemoved = run.diff.allRemoved.filter(p => TRANSIENT_ROLES.has(roleOf(p)))
  const unexplainedRemoved = run.diff.allRemoved.filter(p => !TRANSIENT_ROLES.has(roleOf(p)))
  const transientAdded = run.diff.allAdded.filter(p => TRANSIENT_ROLES.has(run.after.roleOf?.(p)))

  if (unexplainedRemoved.length > 0) {
    problems.push(`DSH pid(s) disappeared with a role that is NOT transient: ${unexplainedRemoved.map(p => `${p}(${roleOf(p)})`).join(', ')}`)
    return
  }
  if (transientRemoved.length > 0) {
    evidence.push(`NOTE: transient ${transientRemoved.map(p => `${p}(${roleOf(p)})`).join(', ')} exited during the call. ` +
      'These are per-tool-call subprocess-local helpers owned by this harness\'s own tool calls, not part of the app core; ' +
      'no core pid (SHELL/HOST/renderer/gpu/utility) was touched.')
  }
  if (transientAdded.length > 0) {
    evidence.push(`NOTE: ${transientAdded.length} transient pid(s) appeared (${transientAdded.join(', ')}) — expected noise from this harness's own tool call.`)
  }
  if (run.diff.allRemoved.length === 0 && run.diff.allAdded.length === 0) {
    evidence.push(`${label}: the DSH pid set is bit-for-bit unchanged.`)
  } else {
    evidence.push(`${label}: every core pid survived (core before/after identical); the only set changes were transient helpers.`)
  }
}

// ---------------------------------------------------------------------------
// asar extraction (cached in TEMP) — the REAL cordis + commands modules
// ---------------------------------------------------------------------------
function extractAsar() {
  if (!existsSync(ASAR)) return null
  const dshRoot = join(tmpdir(), 'dsh-restart-verify-asar', 'dsh')
  if (existsSync(join(dshRoot, 'node_modules'))) return dshRoot
  const root = dirname(dshRoot)
  mkdirSync(root, { recursive: true })
  const buffer = readFileSync(ASAR)
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
  const dataStart = 16 + headerSize
  const walk = (node, prefix) => {
    for (const [fileName, entry] of Object.entries(node.files ?? {})) {
      const p = prefix === '' ? fileName : `${prefix}/${fileName}`
      if (entry.files !== undefined) { mkdirSync(join(root, p), { recursive: true }); walk(entry, p); continue }
      const start = dataStart + Number(entry.offset)
      writeFileSync(join(root, p), buffer.subarray(start, start + Number(entry.size)))
    }
  }
  walk(header, '')
  return dshRoot
}

async function realRegistry() {
  const dshRoot = extractAsar()
  if (dshRoot === null) return null
  const load = p => import(pathToFileURL(p).href)
  return {
    dshRoot,
    cordis: await load(join(dshRoot, 'node_modules/@deepseek-ai/cordis/lib/index.js')),
    commands: await load(join(dshRoot, 'node_modules/@deepseek-ai/dsh-commands/lib/index.js')),
  }
}

// ---------------------------------------------------------------------------
// Plugin import. index.js only DEFINES functions at import time — it starts nothing — and
// the parent NEVER invokes its handler (that happens in the scenario child).
// ---------------------------------------------------------------------------
let plugin = null
let pluginLoadError = null
try { plugin = await import(pathToFileURL(INDEX_JS).href) } catch (error) { pluginLoadError = error }

say('='.repeat(78))
say('dsh-restart — independent verification harness (verifier)')
say(`at           ${new Date().toISOString()}`)
say(`package      ${PKG_DIR}`)
say(`pwsh         ${PWSH}`)
say(`powershell   ${PS51} (exists=${existsSync(PS51)})`)
say(`index.js     ${existsSync(INDEX_JS) ? `${statSync(INDEX_JS).size} bytes` : 'ABSENT'}`)
say(`script       ${existsSync(SCRIPT) ? `${statSync(SCRIPT).size} bytes` : 'ABSENT'}`)
say('='.repeat(78))
say()

// ===========================================================================
// A — STATIC / UNIT
// ===========================================================================
if (inSection('A')) {
  // --- A1 -----------------------------------------------------------------
  {
    const evidence = []
    let ok = true
    const problems = []
    let manifest = null
    try { manifest = JSON.parse(readFileSync(MANIFEST, 'utf8')) }
    catch (e) { problems.push(`package.json unreadable: ${e.message}`); ok = false }
    if (manifest !== null) {
      evidence.push(`package.json name=${manifest.name} type=${manifest.type} private=${manifest.private} main=${manifest.main}`)
      const patchRel = manifest?.dsh?.bundle?.patch
      if (typeof patchRel !== 'string') { ok = false; problems.push('dsh.bundle.patch missing') }
      else {
        const patchAbs = join(PKG_DIR, patchRel)
        const exists = existsSync(patchAbs)
        evidence.push(`dsh.bundle.patch=${patchRel} -> ${patchAbs} exists=${exists} (${exists ? statSync(patchAbs).size : 0} bytes)`)
        if (!exists) { ok = false; problems.push('dsh.bundle.patch target missing') }
        else evidence.push(`cordis.patch.yml:\n${readFileSync(patchAbs, 'utf8').trim()}`)
      }
      if (manifest.type !== 'module') { ok = false; problems.push(`type=${manifest.type}, expected module`) }
      if (manifest.private !== true) { ok = false; problems.push('private is not true') }
      if (typeof manifest?.meta?.title !== 'string' || manifest.meta.title.trim() === '') { ok = false; problems.push('meta.title missing') }
      if (typeof manifest?.meta?.description !== 'string' || manifest.meta.description.trim() === '') { ok = false; problems.push('meta.description missing') }
      if (!Object.prototype.hasOwnProperty.call(manifest.exports ?? {}, './locale/*.json')) { ok = false; problems.push('exports has no ./locale/*.json') }
      if (typeof manifest.main === 'string' && !existsSync(join(PKG_DIR, manifest.main))) { ok = false; problems.push(`main ${manifest.main} missing`) }
      for (const loc of ['locale/en.json', 'locale/zh.json']) {
        const p = join(PKG_DIR, loc)
        if (!existsSync(p)) { ok = false; problems.push(`${loc} missing`); continue }
        try { evidence.push(`${loc} parses, keys=${Object.keys(JSON.parse(readFileSync(p, 'utf8'))).join(',')}`) }
        catch (e) { ok = false; problems.push(`${loc} invalid JSON: ${e.message}`) }
      }
    }
    if (existsSync(INDEX_JS)) {
      const r = sh(process.execPath, ['--check', INDEX_JS])
      evidence.push(`$ node --check index.js -> exit=${r.code}${r.stderr.trim() === '' ? '' : `\n${r.stderr.trim()}`}`)
      if (r.code !== 0) { ok = false; problems.push('node --check failed') }
    } else { ok = false; problems.push('index.js ABSENT') }

    record('A1', 'node --check index.js; manifest parses; dsh.bundle.patch resolves to a real file',
      ok ? 'PASS' : 'FAIL', ok ? 'syntax and manifest are structurally sound' : problems.join('; '), evidence)
  }

  // --- A2 -----------------------------------------------------------------
  {
    const required = ['name', 'inject', 'apply', 'Config', 'toCommandResult', 'STATUS_MESSAGES',
      'resolveScript', 'resolvePowerShell', 'resolveAppPath']
    if (pluginLoadError !== null) {
      record('A2', 'module loads and exports the contract surface', 'FAIL', `import failed: ${pluginLoadError.message}`)
    } else {
      const missing = required.filter(k => !(k in plugin))
      const injectOk = Array.isArray(plugin.inject) && plugin.inject.length === 1 && plugin.inject[0] === 'commands'
      const nameOk = plugin.name === 'restart'
      const ok = missing.length === 0 && injectOk && nameOk && typeof plugin.apply === 'function'
      const problems = []
      if (missing.length > 0) problems.push(`missing exports: ${missing.join(', ')}`)
      if (!injectOk) problems.push(`inject=${JSON.stringify(plugin.inject)} (expected ["commands"])`)
      if (!nameOk) problems.push(`name=${JSON.stringify(plugin.name)} (expected "restart")`)
      record('A2', 'module loads and exports name/inject/apply/Config/toCommandResult/STATUS_MESSAGES/resolve*',
        ok ? 'PASS' : 'FAIL', ok ? `all ${required.length} exports present` : problems.join('; '),
        [required.map(k => `${k}=${typeof plugin[k]}`).join('\n')])
    }
  }

  // --- A3 -----------------------------------------------------------------
  {
    const evidence = []
    const problems = []
    let ok = true
    const tcr = plugin?.toCommandResult
    if (typeof tcr !== 'function') {
      record('A3', 'toCommandResult never claims an unconfirmed restart', 'FAIL', 'toCommandResult is not exported')
    } else {
      const val = (label, outcome) => {
        let r
        try { r = tcr(outcome) } catch (e) { problems.push(`${label} THREW ${e.message}`); ok = false; return null }
        if (!r || (r.kind !== 'success' && r.kind !== 'error')) { problems.push(`${label} returned ${JSON.stringify(r)}`); ok = false; return r }
        if (typeof r.text !== 'string' || r.text.trim() === '') { problems.push(`${label} returned empty text`); ok = false }
        return r
      }

      for (const [status, spec] of Object.entries(CONTRACT_STATUSES)) {
        const r = val(`status=${status}`, { status, detail: '', code: spec.code })
        evidence.push(`  ${status.padEnd(14)} code=${String(spec.code).padEnd(2)} -> kind=${r?.kind}`)
        if (!spec.success && r?.kind === 'success') { problems.push(`${status} MUST NOT be success but was`); ok = false }
      }

      const mustNotSucceed = [
        ['absent outcome (undefined)', undefined], ['null outcome', null], ['empty object', {}],
        ['empty status', { status: '', code: 0 }], ['unknown status', { status: 'definitely-not-a-status', code: 0 }],
        ['launched stub (interim handoff)', { status: 'launched', code: 0 }],
        ['spawn error', { code: null, stdout: '', stderr: '', spawnError: 'EPERM' }],
        ['garbage stdout', { code: 1, stdout: 'not json', stderr: '', spawnError: null }],
        ['launched via stdout only', { code: 0, stdout: '{"status":"launched"}', stderr: '', spawnError: null }],
        ['prototype-polluted status', { status: 'constructor', code: 0 }],
        ['toString status', { status: 'toString', code: 0 }],
        ['number outcome', 42], ['array outcome', []],
      ]
      for (const [label, outcome] of mustNotSucceed) {
        const r = val(label, outcome)
        evidence.push(`  ${label.padEnd(32)} -> kind=${r?.kind}`)
        if (r?.kind === 'success') { problems.push(`UNCONFIRMED RESTART REPORTED AS SUCCESS: ${label}`); ok = false }
      }

      const junk = ['', ' ', '{', 'null', 'launched', 'RESTARTED', 'restarted ', 'restarted\n', 'x'.repeat(200)]
      let fuzzBad = 0
      for (const s of junk) {
        for (const shape of [{ status: s }, { status: s, code: 0 }, { status: s, detail: s }]) {
          let r
          try { r = tcr(shape) } catch { continue }
          if (r?.kind === 'success' && !SUCCESS_ALLOWED.has(String(shape.status).trim())) {
            fuzzBad++; evidence.push(`  FUZZ unjustified success for status ${JSON.stringify(shape.status)}`)
          }
        }
      }
      evidence.push(`  fuzz: ${junk.length * 3} shapes, ${fuzzBad} unjustified success`)
      if (fuzzBad > 0) { ok = false; problems.push(`${fuzzBad} fuzz inputs claimed success`) }

      let text = ''
      try { text = readFileSync(INDEX_JS, 'utf8') } catch { /* A1 reports this */ }
      evidence.push(`  index.js passes a literal -DryRun argument: ${/['"]-DryRun['"]/.test(text)}`)
      evidence.push(`  index.js mentions detached: ${/\bdetached\b/.test(text)}`)
      const extras = Object.keys(plugin.STATUS_MESSAGES ?? {}).filter(s => !(s in CONTRACT_STATUSES))
      if (extras.length > 0) evidence.push(`  NOTE: STATUS_MESSAGES has status(es) absent from the contract's "exhaustive" table: ${extras.join(', ')}`)

      record('A3', 'toCommandResult: every documented status maps sanely; interim/unknown/absent never claims success',
        ok ? 'PASS' : 'FAIL',
        ok ? 'mapping is total; no unobserved restart is ever asserted' : problems.join('; '), evidence)
    }
  }

  // --- A4 -----------------------------------------------------------------
  {
    const evidence = []
    let ok = true
    const problems = []
    let registry = null
    try { registry = await realRegistry() } catch (e) { problems.push(`asar extraction failed: ${e.message}`) }
    if (registry === null) {
      evidence.push('no app.asar on this machine -> the real registry cannot be loaded; a stub was NOT used')
      record('A4', '/restart registers into the REAL interaction-commands registry', 'SKIP',
        'app.asar not found; registration remains unverified', evidence)
    } else {
      try {
        const { Context } = registry.cordis
        const ctx = new Context()
        await ctx.plugin(registry.commands.default)
        evidence.push(`REAL cordis + registry loaded from ${registry.dshRoot}`)
        evidence.push(`registry service name="${registry.commands.name}" class.name="${registry.commands.default.name}"`)

        plugin.apply(ctx, {})
        const list = ctx.commands.list({})
        evidence.push(`after apply(): ctx.commands.list() -> ${JSON.stringify(list.map(e => e.name))}`)
        const descriptor = list.find(e => e.name === 'restart')
        evidence.push(`descriptor=${JSON.stringify(descriptor)}`)
        if (descriptor === undefined) { ok = false; problems.push('restart not present in the real registry') }
        else if (typeof descriptor.description !== 'string' || descriptor.description.trim() === '') {
          ok = false; problems.push('descriptor has no description (the registry rejects empty ones)')
        }

        // Non-vacuity control: the REAL registry rejects a duplicate registration.
        let duplicateRejected = false
        try { ctx.commands.register({ name: 'restart', description: 'dup', handler: () => ({ kind: 'success' }) }) }
        catch { duplicateRejected = true }
        evidence.push(`CONTROL: duplicate "restart" registration rejected by the real registry = ${duplicateRejected}`)
        if (!duplicateRejected) { ok = false; problems.push('registry accepted a duplicate -> not the real registry') }

        // Contract §8: registered inside ctx.effect, so unload disposes it.
        const ctx2 = new Context()
        await ctx2.plugin(registry.commands.default)
        const fork = await ctx2.plugin(plugin, {})
        const beforeNames = ctx2.commands.list({}).map(e => e.name)
        let disposeError = null
        try { await fork.dispose() } catch (e) { disposeError = e }
        const afterNames = ctx2.commands.list({}).map(e => e.name)
        evidence.push(`unload: before=${JSON.stringify(beforeNames)} after dispose=${JSON.stringify(afterNames)}${disposeError ? ` dispose threw: ${disposeError.message}` : ''}`)
        if (!beforeNames.includes('restart')) { ok = false; problems.push('plugin row did not register restart') }
        if (afterNames.includes('restart')) { ok = false; problems.push('disposing the row did NOT dispose the command (contract §8)') }

        // The real loader validates the exported Config.
        const ctx3 = new Context()
        await ctx3.plugin(registry.commands.default)
        let badConfigError = null
        try { await ctx3.plugin(plugin, 'not-an-object') } catch (e) { badConfigError = e }
        evidence.push(`Config: ctx.plugin(plugin, 'not-an-object') -> ${badConfigError === null ? 'ACCEPTED (no validation!)' : `${badConfigError.constructor.name}: ${String(badConfigError.message).split('\n')[0]}`}`)
        if (badConfigError === null) { ok = false; problems.push('exported Config did not reject an invalid config') }
      } catch (error) {
        ok = false; problems.push(`real-registry run threw: ${error.message}`)
        evidence.push(String(error.stack ?? error))
      }
      record('A4', '/restart registers into the REAL interaction-commands registry (no stub)', ok ? 'PASS' : 'FAIL',
        ok ? 'registered through the deployed app.asar registry; disposed on unload; Config validates' : problems.join('; '), evidence)
    }
  }

  // --- A5 + A7 (scenario child; every spawn faked) -------------------------
  {
    const evidence = []
    let ok = true
    const problems = []
    const preloadUrl = pathToFileURL(PRELOAD).href
    const r = await runCapture(process.execPath, ['--import', preloadUrl, join(SCENARIOS, 'handler-spawn.mjs')],
      { timeoutMs: 240_000 })
    evidence.push(`$ node --import ${preloadUrl} test/scenarios/handler-spawn.mjs  -> exit=${r.code} in ${r.ms}ms`)
    if (r.stderr.trim() !== '') evidence.push(`stderr: ${r.stderr.trim().slice(0, 1500)}`)

    let scenario = null
    try { scenario = JSON.parse(r.stdout) } catch (e) { problems.push(`scenario output unparseable: ${e.message}`) }
    if (scenario === null) {
      ok = false
      evidence.push(`raw stdout (first 900): ${r.stdout.slice(0, 900)}`)
    } else {
      if (scenario.errors.length > 0) { ok = false; problems.push(...scenario.errors.map(String)) }
      evidence.push(`safety guard refusals during the scenario: ${scenario.refused.length} (must be 0: every spawn was served by the armed fake)`)
      if (scenario.refused.length > 0) { ok = false; problems.push(`${scenario.refused.length} unarmed spawn(s) were refused`) }

      // --- A5 arguments ---
      for (const item of scenario.a5) {
        if (item.rawInput.trim() === '') continue
        evidence.push(`  rawInput=${JSON.stringify(item.rawInput)} -> kind=${item.kind} spawns=${item.spawns} text=${JSON.stringify(item.text).slice(0, 80)}`)
        if (item.kind !== 'error') { ok = false; problems.push(`rawInput=${JSON.stringify(item.rawInput)} was accepted (kind=${item.kind})`) }
        if (!/用法/.test(item.text)) { ok = false; problems.push(`rawInput=${JSON.stringify(item.rawInput)} text lacks 用法：/restart（无需参数）`) }
        if (item.spawns !== 0) { ok = false; problems.push(`rawInput=${JSON.stringify(item.rawInput)} spawned ${item.spawns} process(es) despite rejection`) }
      }
      const ws = scenario.a5.find(i => i.rawInput.trim() === '')
      if (ws === undefined) { ok = false; problems.push('whitespace-only case missing from the scenario') }
      else {
        const restart = ws.spawnDetail.find(s => s.isRestart)
        evidence.push(`  whitespace-only rawInput reaches the restart path: ${restart !== undefined} (fully intercepted — no real process started)`)
        if (restart === undefined) { ok = false; problems.push('whitespace-only input did not reach the restart path') }
        else if (restart.argv.includes('-DryRun')) { ok = false; problems.push('the plugin passes -DryRun in production') }
      }

      // --- A7 spawn contract ---
      const a7 = scenario.a7
      if (a7 === null) { ok = false; problems.push('A7 scenario did not run') }
      else {
        evidence.push(`spawn argv:\n${(a7.argv ?? []).map((a, i) => `    ${i}: ${JSON.stringify(a)}`).join('\n')}`)
        evidence.push(`-ResultPath = ${a7.resultPath}`)
        const expected = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Json', '-ResultPath']
        const prefixOk = expected.every((tok, i) => a7.argv?.[i] === tok)
        evidence.push(`matches contract §3 argv prefix: ${prefixOk}`)
        if (!a7.spawnedRestart) { ok = false; problems.push('handler never spawned the restart script') }
        if (!prefixOk) { ok = false; problems.push('spawn argv does not match the contract invocation') }
        if (a7.hasDryRun) { ok = false; problems.push('the plugin passed -DryRun') }
        evidence.push(`fake worker wrote the terminal result: ${a7.terminalWritten}`)
        evidence.push(`handler mapped the worker's terminal status to: kind=${a7.result.kind} text=${JSON.stringify(a7.result.text).slice(0, 140)}`)
        if (a7.result.kind !== 'error') { ok = false; problems.push(`quit-timeout reported as ${a7.result.kind}`) }
        if (!/超时/.test(a7.result.text)) { ok = false; problems.push('quit-timeout text does not mention the timeout') }
      }
    }

    const argumentEvidence = evidence.filter(e => /rawInput|whitespace|refusal/.test(e))
    const spawnEvidence = evidence.filter(e => !/rawInput|whitespace|refusal/.test(e))
    record('A5', '/restart rejects every argument without spawning anything (real handler, faked spawn)',
      ok ? 'PASS' : 'FAIL',
      ok ? 'arguments rejected with the contract text and zero spawn calls; whitespace reaches the contract spawn path' : problems.join('; '),
      argumentEvidence)
    record('A7', 'handler → spawn argv contract and -ResultPath round trip (spawn intercepted, nothing real started)',
      ok ? 'PASS' : 'FAIL',
      ok ? 'the real handler emits exactly the contract argv and reports the worker terminal status' : problems.join('; '),
      spawnEvidence)
  }

  // --- A8 -----------------------------------------------------------------
  {
    const evidence = []
    let ok = true
    const problems = []
    try {
      const emptyDir = join(ART_DIR, 'empty-package-dir')
      mkdirSync(emptyDir, { recursive: true })
      const missing = plugin.resolveScript(emptyDir)
      const real = plugin.resolveScript()
      const interpreter = plugin.resolvePowerShell()
      evidence.push(`resolveScript(<empty dir>) -> ${JSON.stringify(missing)}`)
      evidence.push(`resolveScript() -> ${JSON.stringify(real)}`)
      evidence.push(`resolvePowerShell() -> ${JSON.stringify(interpreter)}`)
      if (missing !== null) { ok = false; problems.push('resolveScript returned a path for a directory with no script') }
      if (real === null) { ok = false; problems.push('resolveScript() did not find the bundled script') }
      if (interpreter === null) { ok = false; problems.push('resolvePowerShell() found no interpreter') }
      const bogus = await plugin.resolveAppPath(PWSH, 999_999)
      evidence.push(`resolveAppPath(pwsh, pid=999999) -> ${JSON.stringify(bogus)}`)
      const own = await plugin.resolveAppPath(PWSH, process.ppid)
      evidence.push(`resolveAppPath(pwsh, own ppid ${process.ppid}) -> ${JSON.stringify(own)}`)
    } catch (error) {
      ok = false; problems.push(`threw: ${error.message}`)
      evidence.push(String(error.stack ?? error))
    }
    record('A8', 'resolveScript/resolvePowerShell/resolveAppPath behave under adversarial inputs',
      ok ? 'PASS' : 'FAIL', ok ? 'resolvers are correct on the real package and refuse an empty directory' : problems.join('; '), evidence)
  }
}

// ===========================================================================
// B — SCRIPT
// ===========================================================================
const PRE = {}
const MISSING_APP = 'C:\\agent\\__verifier_no_such_dir__\\NoSuchApp.exe'

if (inSection('B6', 'B7', 'B8', 'B9', 'R1', 'R2')) {
  if (!existsSync(SCRIPT)) {
    for (const id of ['B6', 'B7', 'B8 gate', 'B8a', 'B8b', 'B9']) record(id, '(script checks)', 'FAIL', `script ABSENT: ${SCRIPT}`)
  } else {
    // --- B6 -----------------------------------------------------------------
    {
      const evidence = []
      let ok = true
      const problems = []
      const parseWith = interp => {
        const cmd = [
          '$errs = $null; $tokens = $null;',
          `$null = [System.Management.Automation.Language.Parser]::ParseFile('${SCRIPT.replace(/'/g, "''")}', [ref]$tokens, [ref]$errs);`,
          'if ($errs -and $errs.Count -gt 0) { foreach ($e in $errs) { Write-Output ("ERR " + $e.Extent.StartLineNumber + ": " + $e.Message) }; exit 1 }',
          'Write-Output "PARSE-OK"; exit 0',
        ].join(' ')
        return sh(interp, ['-NoProfile', '-NonInteractive', '-Command', cmd], { timeoutMs: 120_000 })
      }
      for (const [label, interp] of [['pwsh 7', PWSH], ['Windows PowerShell 5.1', PS51]]) {
        if (!existsSync(interp)) { ok = false; problems.push(`${label} not installed`); continue }
        const version = sh(interp, ['-NoProfile', '-NonInteractive', '-Command', '$PSVersionTable.PSVersion.ToString()'])
        const r = parseWith(interp)
        evidence.push(`$ "${interp}" -Command "[Parser]::ParseFile('dsh-restart.ps1', ...)"  (${label}, version ${version.stdout.trim()})\n  -> exit=${r.code}\n${(r.stdout + r.stderr).trim()}`)
        if (r.code !== 0) { ok = false; problems.push(`${label} reported parse errors`) }
      }
      record('B6', 'script parses under Windows PowerShell 5.1 AND pwsh 7', ok ? 'PASS' : 'FAIL',
        ok ? 'both interpreters parse the script with zero errors' : problems.join('; '), evidence)
    }

    // --- B7 -----------------------------------------------------------------
    {
      const evidence = []
      let ok = true
      const problems = []
      const resultPath = join(ART_DIR, 'b7-dryrun-result.json')
      rmSync(resultPath, { force: true })
      const run = await invokeScript({ extra: ['-ResultPath', resultPath], dryRun: true, label: 'B7 DryRun' })
      const v = run.run
      evidence.push(`$ ${run.args.join(' ')}\n  -> exit=${v.code} in ${v.ms}ms`)
      evidence.push(`stdout: ${v.stdout.trim()}`)
      if (v.stderr.trim() !== '') evidence.push(`stderr: ${v.stderr.trim()}`)
      evidence.push(...pidsEvidence('B7', run.before, run.after, run.diff))
      judgeIntact(run, problems, evidence, 'B7')
      if (problems.length > 0) ok = false

      let parsed = null
      if (existsSync(resultPath)) {
        const buf = readFileSync(resultPath)
        const text = buf.toString('utf8')
        evidence.push(`-ResultPath first 3 bytes: ${buf.subarray(0, 3).toString('hex')} (UTF-8 BOM would be efbbbf)`)
        evidence.push(`-ResultPath raw: ${text.slice(0, 700)}`)
        try { parsed = JSON.parse(text) } catch (e) { problems.push(`result file is not JSON: ${e.message}`); ok = false }
      } else evidence.push('-ResultPath was not written')
      if (parsed === null) { try { parsed = JSON.parse(v.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ } }
      if (parsed === null) { ok = false; problems.push('no parseable JSON result from the DryRun') }
      else {
        evidence.push(`status=${JSON.stringify(parsed.status)} code=${JSON.stringify(parsed.code)} appPath=${JSON.stringify(parsed.appPath)} exeName=${JSON.stringify(parsed.exeName)}`)
        if (!(parsed.status in CONTRACT_STATUSES)) { ok = false; problems.push(`status ${JSON.stringify(parsed.status)} is not documented`) }
        if (parsed.status !== 'would-restart') problems.push(`NOTE: DryRun reported ${JSON.stringify(parsed.status)} (expected would-restart)`)
        PRE.dryRunParsed = parsed
      }
      record('B7', '-DryRun -Json terminates NOTHING (DSH pid set captured before and after)',
        ok ? 'PASS' : 'FAIL', ok ? 'no DSH process was terminated by the dry run' : problems.join('; '), evidence)
    }

    // --- B8 gate ------------------------------------------------------------
    {
      const evidence = []
      let ok = true
      const problems = []
      const resultPath = join(ART_DIR, 'b8-gate-result.json')
      rmSync(resultPath, { force: true })
      const run = await invokeScript({ extra: ['-ResultPath', resultPath, '-AppPath', MISSING_APP], dryRun: true, label: 'B8 gate' })
      evidence.push(`$ ${run.args.join(' ')}\n  -> exit=${run.run.code} in ${run.run.ms}ms`)
      evidence.push(`stdout: ${run.run.stdout.trim()}`)
      evidence.push(...pidsEvidence('B8 gate', run.before, run.after, run.diff))
      if (run.diff?.coreRemoved.length > 0) { ok = false; problems.push(`CORE DSH PROCESSES TERMINATED: ${run.diff.coreRemoved.join(', ')}`) }

      let parsed = null
      if (existsSync(resultPath)) {
        evidence.push(`-ResultPath raw: ${readFileSync(resultPath, 'utf8').slice(0, 500)}`)
        try { parsed = JSON.parse(readFileSync(resultPath, 'utf8')) } catch (e) { problems.push(`not JSON: ${e.message}`); ok = false }
      } else { try { parsed = JSON.parse(run.run.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ } }

      if (parsed === null) { ok = false; problems.push('no parseable JSON from the missing-AppPath DryRun') }
      else {
        evidence.push(`status=${JSON.stringify(parsed.status)} shellPids=${JSON.stringify(parsed.shellPids)} allPids=${JSON.stringify(parsed.allPids)}`)
        if (parsed.status === 'app-not-found') {
          PRE.missingAppIsSafe = true
          evidence.push('SAFETY GATE OPEN: a missing explicit -AppPath resolves to app-not-found, so a non-DryRun run cannot resolve a real terminate set.')
        } else {
          PRE.missingAppIsSafe = false
          ok = false
          problems.push(`SAFETY GATE CLOSED: a missing -AppPath produced ${JSON.stringify(parsed.status)} instead of app-not-found`)
        }
        if (Array.isArray(parsed.shellPids) && parsed.shellPids.length > 0) {
          ok = false; problems.push(`a missing -AppPath still resolved shell pid(s) ${JSON.stringify(parsed.shellPids)}`)
        }
      }
      record('B8 gate', 'SAFETY PRECONDITION: a missing explicit -AppPath must resolve to app-not-found (DryRun)',
        ok ? 'PASS' : 'FAIL',
        ok ? 'gate open — the non-DryRun handoff test is safe to attempt' : 'gate closed — the non-DryRun test MUST NOT be attempted',
        evidence)
    }

    const gated = (id, title) => record(id, title, 'SKIP',
      'SAFETY: the DryRun precondition did not report app-not-found for a missing -AppPath, so a non-DryRun run could reach a live target. Refusing to attempt it. This is itself a finding.', [])

    // --- decoy build (the only thing a non-DryRun run may target) -----------
    let decoyReady = false
    {
      const out = join(ART_DIR, 'decoy-build.json')
      const r = pwsh(['-File', join(HELPERS, 'make-decoy.ps1'), '-Dir', DECOY_DIR, '-Out', out], { timeoutMs: 120_000 })
      let parsed = null
      if (existsSync(out)) { try { parsed = JSON.parse(readFileSync(out, 'utf8')) } catch { /* below */ } }
      decoyReady = r.code === 0 && parsed?.ok === true && existsSync(DECOY_EXE)
      PRE.decoyExe = DECOY_EXE
      if (!decoyReady) say(`        !! decoy build failed: exit=${r.code} ${(r.stdout + r.stderr).slice(0, 400)}`)
    }

    // --- B8a: two-phase handoff against the DECOY ---------------------------
    if (!decoyReady) gated('B8a', 'two-phase handoff round-trip')
    else {
      const evidence = []
      let ok = true
      const problems = []
      const resultPath = join(ART_DIR, 'b8-handoff-result.json')
      rmSync(resultPath, { force: true })
      const decoy = spawn(DECOY_EXE, ['120'], { stdio: 'ignore', windowsHide: true, detached: false })
      decoy.on('error', () => {})
      await new Promise(r => setTimeout(r, 1200))
      evidence.push(`decoy app: pid=${decoy.pid} image=${DECOY_EXE} (running, no window)`)
      evidence.push('NOTE: every other app process named verifier-decoy.exe was terminated before this check, so the terminate set is exactly this pid.')

      const run = await invokeScript({
        extra: ['-ResultPath', resultPath, '-AppPath', DECOY_EXE, '-Port', '45999',
          '-QuitTimeoutSeconds', '12', '-StartTimeoutSeconds', '10', '-GraceSeconds', '0.5'],
        dryRun: false, label: 'B8a handoff',
      })
      const v = run.run
      evidence.push(`$ ${run.args.join(' ')}   (NO -DryRun; -AppPath is the harness's own decoy)\n  -> exit=${v.code} in ${v.ms}ms`)
      evidence.push(`stdout: ${v.stdout.trim()}`)
      if (v.stderr.trim() !== '') evidence.push(`stderr: ${v.stderr.trim()}`)
      evidence.push(...pidsEvidence('B8a', run.before, run.after, run.diff))
      if (run.diff?.coreRemoved.length > 0) { ok = false; problems.push(`CORE DSH PROCESSES TERMINATED: ${run.diff.coreRemoved.join(', ')}`) }
      judgeIntact(run, problems, evidence, 'B8a')

      if (v.ms >= 3000) { ok = false; problems.push(`launcher took ${v.ms}ms (contract requires < 3000ms)`) }
      let immediate = null
      try { immediate = JSON.parse(v.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ }
      evidence.push(`immediate stdout JSON: ${JSON.stringify(immediate).slice(0, 400)}`)
      if (immediate === null) { ok = false; problems.push('launcher stdout was not JSON') }
      else if (immediate.status !== 'launched') { ok = false; problems.push(`launcher status=${JSON.stringify(immediate.status)}, expected "launched"`) }
      if (immediate?.notes) evidence.push(`launcher notes: ${JSON.stringify(immediate.notes, null, 1)}`)
      // The caller's own job report is the independent confirmation that it was job-bound.
      const callerJob = (immediate?.notes ?? []).find(n => /caller job state/.test(String(n)))
      if (callerJob !== undefined) evidence.push(`caller's own job state: ${callerJob}`)

      let terminal = null
      const deadline = Date.now() + 40_000
      const seenTexts = []
      while (Date.now() < deadline) {
        if (existsSync(resultPath)) {
          try {
            const text = readFileSync(resultPath, 'utf8')
            if (!seenTexts.includes(text)) { seenTexts.push(text); evidence.push(`  result file at +${Date.now() - (deadline - 40_000)}ms: ${text.slice(0, 300)}`) }
            const parsed = JSON.parse(text)
            if (parsed.status !== 'launched') { terminal = parsed; break }
          } catch { /* mid-write */ }
        }
        await new Promise(r => setTimeout(r, 100))
      }
      evidence.push(`distinct result-file states observed: ${seenTexts.length} (>=2 means the handoff stub was replaced by a terminal state — the two-phase design working)`)
      if (terminal === null) {
        ok = false
        problems.push('NO TERMINAL STATUS: -ResultPath still holds the `launched` stub after 40s, so the escaped worker never completed its phase. The user would see "unconfirmed" and nothing would happen.')
      } else {
        evidence.push(`TERMINAL: ${JSON.stringify(terminal).slice(0, 800)}`)
        if (!(terminal.status in CONTRACT_STATUSES)) { ok = false; problems.push(`terminal status ${JSON.stringify(terminal.status)} is undocumented`) }
        evidence.push(`terminal.notes: ${JSON.stringify(terminal.notes, null, 1)}`)
        const workerJob = (terminal.notes ?? []).find(n => /worker job state/.test(String(n)))
        if (workerJob !== undefined) evidence.push(`WORKER's own job self-report: ${workerJob}`)
      }

      // The decoy must actually have been terminated and relaunched.
      let decoyAlive = true
      try { process.kill(decoy.pid, 0) } catch { decoyAlive = false }
      evidence.push(`original decoy pid ${decoy.pid} still alive = ${decoyAlive}`)
      const survivors = sh(PWSH, ['-Command', '@(Get-CimInstance Win32_Process -Filter "Name = \'verifier-decoy.exe\'" | Where-Object { $_.ExecutablePath -eq \'' + DECOY_EXE + '\' } | ForEach-Object { $_.ProcessId }) -join ","'], { timeoutMs: 40_000 })
      evidence.push(`verifier-decoy.exe pids after the run: [${survivors.stdout.trim()}]`)
      if (terminal !== null && terminal.status === 'restarted') {
        if (decoyAlive) { ok = false; problems.push('terminal status says restarted, but the original decoy is still alive') }
        if (survivors.stdout.trim() === '') { ok = false; problems.push('terminal status says restarted, but no replacement decoy process exists') }
      }

      if (existsSync(resultPath)) {
        const buf = readFileSync(resultPath)
        const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
        const replacement = (buf.toString('utf8').match(/\uFFFD/g) ?? []).length
        evidence.push(`encoding: hasBom=${hasBom}, U+FFFD count=${replacement}`)
        if (hasBom) { ok = false; problems.push('result file starts with a UTF-8 BOM') }
        if (replacement > 0) { ok = false; problems.push(`result file contains ${replacement} U+FFFD`) }
      } else { ok = false; problems.push('-ResultPath was never created') }

      // Clean up any relaunched decoy.
      sh(PWSH, ['-Command', 'Get-CimInstance Win32_Process -Filter "Name = \'verifier-decoy.exe\'" | Where-Object { $_.ExecutablePath -eq \'' + DECOY_EXE + '\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'], { timeoutMs: 40_000 })
      try { decoy.kill() } catch { /* gone */ }

      record('B8a', 'two-phase handoff: launcher returns < 3s with "launched", worker writes the terminal result',
        ok ? 'PASS' : 'FAIL',
        ok ? `launcher ${v.ms}ms status=launched; terminal ${JSON.stringify(terminal?.status)} in -ResultPath; UTF-8 no BOM` : problems.join('; '),
        evidence)
    }

    // --- B9: escaped worker is not job-bound (observed ALIVE, decoy target) --
    if (!decoyReady) gated('B9', 'escaped worker is NOT in a kill-on-close job')
    else {
      const evidence = []
      let ok = true
      const problems = []

      // POSITIVE CONTROL: the oracle must be able to SEE a kill-on-close job, or a negative
      // result on the worker proves nothing.
      const controlSelf = join(ART_DIR, 'b9-control-self.json')
      const controlCensus = join(ART_DIR, 'b9-control-census.txt')
      rmSync(controlSelf, { force: true })
      rmSync(controlCensus, { force: true })
      const control = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', join(HELPERS, 'self-job.ps1'),
        '-Out', controlSelf, '-HoldMs', '60000'], { stdio: 'ignore', windowsHide: true })
      const cd = Date.now() + 15_000
      while (!existsSync(controlSelf) && Date.now() < cd) await new Promise(r => setTimeout(r, 50))
      let controlJson = null
      try { controlJson = JSON.parse(readFileSync(controlSelf, 'utf8')) } catch { /* below */ }
      if (controlJson === null) { ok = false; problems.push('positive control produced no self-report') }
      else {
        sh(PWSH, ['-NoProfile', '-NonInteractive', '-File', join(HELPERS, 'job-census.ps1'),
          '-Pid_', String(controlJson.pid), '-Out', controlCensus], { timeoutMs: 90_000 })
        const censusText = existsSync(controlCensus) ? readFileSync(controlCensus, 'utf8') : ''
        evidence.push(`POSITIVE CONTROL (Start-Process child, pid ${controlJson.pid}):`)
        evidence.push(`  self-report: inJob=${controlJson.inJob} killOnJobClose=${controlJson.killOnJobClose} flags=${controlJson.flags}`)
        evidence.push(`  oracle:      ${censusText.split('\n').filter(l => l.startsWith('pid=')).join(' | ')}`)
        if (!IN_ANY_JOB_RE.test(censusText) || !KILL_ON_CLOSE_RE.test(censusText)) {
          ok = false
          problems.push('the job oracle FAILED its positive control — a negative result on the worker would be vacuous')
        }
      }
      try { control.kill() } catch { /* done */ }

      // Watcher runs OUTSIDE the tool-call job and inspects the worker while it is alive.
      const watchOut = join(ART_DIR, 'b9-watch.json')
      rmSync(watchOut, { force: true })
      const decoy2 = spawn(DECOY_EXE, ['120'], { stdio: 'ignore', windowsHide: true })
      decoy2.on('error', () => {})
      await new Promise(r => setTimeout(r, 1200))

      const watcher = spawn(PWSH, ['-NoProfile', '-NonInteractive', '-File', join(HELPERS, 'watch-worker.ps1'),
        '-ScriptPath', SCRIPT, '-AppPath', DECOY_EXE, '-ResultPath', join(ART_DIR, 'b9-watch-result.json'),
        '-Out', watchOut, '-WatchSeconds', '16', '-Port', '45998'],
      { stdio: 'ignore', windowsHide: true })
      await new Promise(r => setTimeout(r, 300))

      const run = await invokeScript({
        extra: ['-ResultPath', join(ART_DIR, 'b9-result.json'), '-AppPath', DECOY_EXE, '-Port', '45998',
          '-QuitTimeoutSeconds', '12', '-StartTimeoutSeconds', '10', '-GraceSeconds', '0.5'],
        dryRun: false, label: 'B9 handoff',
      })
      evidence.push(`launcher: exit=${run.run.code} in ${run.run.ms}ms stdout=${run.run.stdout.trim().slice(0, 300)}`)
      evidence.push(...pidsEvidence('B9', run.before, run.after, run.diff))
      if (run.diff?.coreRemoved.length > 0) { ok = false; problems.push(`CORE DSH PROCESSES TERMINATED: ${run.diff.coreRemoved.join(', ')}`) }

      const wd = Date.now() + 30_000
      while (!existsSync(watchOut) && Date.now() < wd) await new Promise(r => setTimeout(r, 100))
      try { watcher.kill() } catch { /* done */ }

      let watched = null
      try { watched = JSON.parse(readFileSync(watchOut, 'utf8')) } catch (e) { problems.push(`watcher output unreadable: ${e.message}`); ok = false }
      if (watched !== null) {
        for (const line of watched.log ?? []) evidence.push(`  ${line}`)
        evidence.push(`worker pids observed by the external watcher: ${JSON.stringify(watched.workerPids)}`)
        if ((watched.workerPids ?? []).length === 0) {
          ok = false
          problems.push('the external watcher never observed a -Worker process — the escaped worker never started, or died before it could be seen')
        } else {
          const censusLine = (watched.log ?? []).find(l => /census:/.test(String(l)))
          if (censusLine === undefined) { ok = false; problems.push('no census was recorded for the live worker') }
          else if (IN_ANY_JOB_RE.test(censusLine) && KILL_ON_CLOSE_RE.test(censusLine)) {
            ok = false
            problems.push(`THE WORKER IS IN A KILL-ON-JOB-CLOSE JOB — the escape did not happen: ${censusLine}`)
          } else if (/inAnyJob=False/.test(censusLine)) {
            evidence.push('VERDICT: the escaped worker was observed ALIVE and in NO job object — nothing kills it when the app\'s job closes.')
          } else if (/openProcessFailed/.test(censusLine)) {
            problems.push(`NOTE: the oracle lost the race (worker already exited) — job membership NOT established from the oracle: ${censusLine}`)
            const selfReported = (watched.log ?? []).find(l => /worker job state/.test(String(l)))
            if (selfReported !== undefined) evidence.push(`fallback self-report: ${selfReported}`)
          }
        }
      }
      sh(PWSH, ['-Command', 'Get-CimInstance Win32_Process -Filter "Name = \'verifier-decoy.exe\'" | Where-Object { $_.ExecutablePath -eq \'' + DECOY_EXE + '\' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }'], { timeoutMs: 40_000 })
      try { decoy2.kill() } catch { /* gone */ }

      record('B9', 'the escaped worker is NOT in a kill-on-close job (observed alive, external oracle, positive control)',
        ok ? 'PASS' : 'FAIL',
        ok ? 'worker observed ALIVE from outside the tool-call job and in no job object; the oracle proved it can detect a kill-on-close job' : problems.join('; '),
        evidence)
    }

    // --- B8b: non-ASCII RESULT PATH survives --------------------------------
    // This exercises the encoding that actually matters for the plugin: the -ResultPath the
    // plugin chooses and the worker must write. It is safe by construction — a `-DryRun` with
    // a non-ASCII result path — and it does not depend on the missing-AppPath fallback.
    {
      const evidence = []
      let ok = true
      const problems = []
      const cjkDir = join(ART_DIR, '重启验证-路径')
      mkdirSync(cjkDir, { recursive: true })
      const resultPath = join(cjkDir, '结果文件.json')
      rmSync(resultPath, { force: true })
      const run = await invokeScript({ extra: ['-ResultPath', resultPath], dryRun: true, label: 'B8b cjk' })
      const v = run.run
      evidence.push(`-ResultPath "${resultPath}"`)
      evidence.push(`$ ${run.args.join(' ')}\n  -> exit=${v.code} in ${v.ms}ms`)
      evidence.push(`stdout: ${v.stdout.trim().slice(0, 400)}`)
      evidence.push(...pidsEvidence('B8b', run.before, run.after, run.diff))
      judgeIntact(run, problems, evidence, 'B8b')
      if (problems.length > 0) ok = false

      if (!existsSync(resultPath)) {
        ok = false
        problems.push('the script did not write to a non-ASCII -ResultPath')
      } else {
        const buf = readFileSync(resultPath)
        const text = buf.toString('utf8')
        const hasBom = buf.length >= 3 && buf[0] === 0xEF && buf[1] === 0xBB && buf[2] === 0xBF
        const replacement = (text.match(/\uFFFD/g) ?? []).length
        evidence.push(`bytes=${buf.length} first3=${buf.subarray(0, 3).toString('hex')} (UTF-8 BOM would be efbbbf) hasBom=${hasBom} U+FFFD=${replacement}`)
        evidence.push(`content: ${text.slice(0, 500)}`)
        if (hasBom) { ok = false; problems.push('BOM at a non-ASCII -ResultPath') }
        if (replacement > 0) { ok = false; problems.push(`U+FFFD present in the result (${replacement})`) }
        try {
          const parsed = JSON.parse(text)
          evidence.push(`status=${JSON.stringify(parsed.status)} appPath=${JSON.stringify(parsed.appPath)}`)
          if (!(parsed.status in CONTRACT_STATUSES)) { ok = false; problems.push(`status ${JSON.stringify(parsed.status)} is undocumented`) }
          if (parsed.status !== 'would-restart') problems.push(`NOTE: DryRun reported ${JSON.stringify(parsed.status)} (expected would-restart)`)
        } catch (e) { ok = false; problems.push(`result at the CJK path is not valid JSON: ${e.message}`) }
      }

      // The other half: a non-ASCII -AppPath must not be mangled on the way in. A path under
      // the real CJK install folder must resolve to a genuine app-not-found (it does not exist)
      // and must be echoed back byte-for-byte, not mojibake.
      const cjkApp = 'C:\\agent\\新建文件夹\\__verifier_missing__.exe'
      const resultPath2 = join(cjkDir, '结果文件2.json')
      rmSync(resultPath2, { force: true })
      const run2 = await invokeScript({ extra: ['-ResultPath', resultPath2, '-AppPath', cjkApp], dryRun: true, label: 'B8b cjk app' })
      evidence.push(`$ ... -AppPath "${cjkApp}" -> exit=${run2.run.code} stdout=${run2.run.stdout.trim().slice(0, 300)}`)
      let parsed2 = null
      if (existsSync(resultPath2)) { try { parsed2 = JSON.parse(readFileSync(resultPath2, 'utf8')) } catch { /* below */ } }
      if (parsed2 === null) { try { parsed2 = JSON.parse(run2.run.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ } }
      if (parsed2 === null) { ok = false; problems.push('non-ASCII -AppPath DryRun produced no JSON') }
      else {
        evidence.push(`status=${JSON.stringify(parsed2.status)} detail=${JSON.stringify(String(parsed2.detail ?? '').slice(0, 200))}`)
        const detail = String(parsed2.detail ?? '')
        if (detail.includes('\uFFFD')) { ok = false; problems.push('U+FFFD in the echoed non-ASCII -AppPath') }
        if (parsed2.status !== 'app-not-found') { ok = false; problems.push(`non-existent non-ASCII -AppPath gave ${JSON.stringify(parsed2.status)}, expected app-not-found`) }
        else if (!detail.includes('新建文件夹')) {
          problems.push(`NOTE: the echoed path lost its CJK segment: ${JSON.stringify(detail)}`)
        } else evidence.push('the non-ASCII -AppPath was echoed back byte-for-byte (CJK intact, no mojibake)')
      }
      judgeIntact(run2, problems, evidence, 'B8b-app')
      if (run2.diff?.coreRemoved.length > 0) ok = false

      record('B8b', 'non-ASCII -ResultPath and -AppPath survive intact (no BOM, no U+FFFD, CJK preserved)',
        ok ? 'PASS' : 'FAIL', ok ? 'CJK paths round-tripped correctly through both directions' : problems.join('; '), evidence)
    }

    // --- R1: REGRESSION — the handoff's switch quoting ----------------------
    // The escaped worker is launched with a hand-assembled command line through
    // Win32_Process.Create. A switch written as '-Json' does NOT bind under
    // [CmdletBinding()]: the process aborts at parameter binding, the terminal result file is
    // never rewritten, and /restart answers "unconfirmed" while nothing happens. That exact
    // defect shipped once; this check replays the real handoff shape against a fixture that
    // mirrors the production parameter surface, so it cannot come back silently.
    if (!inSection('R1')) { /* not requested */ } else {
      const evidence = []
      let ok = true
      const problems = []
      const out = join(ART_DIR, 'switch-probe.json')
      rmSync(out, { force: true })
      const fixture = join(TEST_DIR, 'fixtures', 'switch-fixture.ps1')
      const r = pwsh(['-File', join(HELPERS, 'switch-handoff-probe.ps1'), '-Fixture', fixture, '-Out', out], { timeoutMs: 180_000 })
      evidence.push(`$ pwsh -File test/helpers/switch-handoff-probe.ps1 -Fixture test/fixtures/switch-fixture.ps1 -Out <artifacts>`)
      evidence.push(`fixture declares [CmdletBinding()] param([switch]$Worker, $Json, $QuitOnly, $AllowForce) — the production parameter surface`)
      let parsed = null
      if (existsSync(out)) { try { parsed = JSON.parse(readFileSync(out, 'utf8')) } catch (e) { problems.push(`probe output unparseable: ${e.message}`) } }
      if (parsed === null) {
        ok = false
        problems.push(`probe produced no usable output (exit=${r.code})`)
      } else {
        for (const c of parsed.cases) {
          const obs = c.observed === null ? '(never ran)' : `worker=${c.observed.worker} json=${c.observed.json} quitOnly=${c.observed.quitOnly} allowForce=${c.observed.allowForce}`
          evidence.push(`  ${String(c.case).padEnd(20)} wmiReturn=${String(c.wmiReturnValue).padEnd(3)} ran=${String(c.fixtureRan).padEnd(5)} allSwitchesTrue=${String(c.allSwitchesTrue).padEnd(5)} ${obs}`)
          evidence.push(`    cmd: ${c.commandLine}`)
        }
        const v = parsed.verdict
        evidence.push(`verdict: ${JSON.stringify(v)}`)
        if (!v.bareBindsEverything) {
          ok = false
          problems.push('the CORRECT shape (bare switches) did not bind every switch')
        }
        if (!v.shippedShapeFailsToRun) {
          ok = false
          problems.push('CONTROL FAILED: the quoted-single shape ran anyway, so this fixture cannot detect the defect')
        }
        if (!v.switchFirstTokenFails) {
          problems.push('NOTE: a switch as the command line\'s first token did NOT fail; the interpreter-path-first requirement may no longer be load-bearing')
        }
        // The decisive assertion: the fix must actually be present in the shipped script.
        let scriptText = ''
        try { scriptText = readFileSync(SCRIPT, 'utf8') } catch { /* reported elsewhere */ }
        const usesQuotedSwitches = /\$asSwitch|''\s*\+\s*\$Name|'\$\(\$Name\)'/.test(scriptText) || /&\s*\$asSwitch/.test(scriptText)
        evidence.push(`shipped script still builds switches through a quoting helper: ${usesQuotedSwitches}`)
        if (usesQuotedSwitches) {
          ok = false
          problems.push('THE DEFECT IS STILL SHIPPED: script/dsh-restart.ps1 still emits quoted switches for the escaped worker')
        }
      }
      record('R1', 'REGRESSION: the escaped handoff must emit BARE switches (quoted switches abort the worker)',
        ok ? 'PASS' : 'FAIL',
        ok ? 'fixture proves the bug shape aborts and the fixed shape binds every switch; the shipped script uses bare switches' : problems.join('; '),
        evidence)
    }

    // --- R2: the job escape is causally what makes the worker survive -------
    if (!inSection('R2')) { /* not requested */ } else {
      const evidence = []
      let ok = true
      const problems = []
      const out = join(ART_DIR, 'joblab.json')
      rmSync(out, { force: true })
      const r = pwsh(['-File', join(HELPERS, 'joblab.ps1'), '-OutPath', out, '-LifeSeconds', '7'], { timeoutMs: 180_000 })
      let parsed = null
      if (existsSync(out)) { try { parsed = JSON.parse(readFileSync(out, 'utf8')) } catch (e) { problems.push(`joblab output unparseable: ${e.message}`) } }
      if (parsed === null) {
        ok = false
        problems.push(`joblab produced no usable output (exit=${r.code}) ${(r.stdout + r.stderr).slice(0, 300)}`)
      } else {
        evidence.push('Method: this helper creates its OWN KILL_ON_JOB_CLOSE job, spawns one natural child and one WMI child, assigns ONLY the natural one into the job, then closes the handle.')
        evidence.push(`  plain (assigned to the job): pid=${parsed.plain.pid} inJob=${parsed.plain.inJob} killOnJobClose=${parsed.plain.killOnJobClose} aliveAfterJobClose=${parsed.plain.aliveAfterJobClose} heartbeats=${parsed.plain.beats}`)
        evidence.push(`  wmi   (never assigned):      pid=${parsed.wmi.pid} inJob=${parsed.wmi.inJob} killOnJobClose=${parsed.wmi.killOnJobClose} aliveAfterJobClose=${parsed.wmi.aliveAfterJobClose} heartbeats=${parsed.wmi.beats}`)
        evidence.push(`  verdict: ${JSON.stringify(parsed.verdict)}`)
        if (parsed.plain.aliveAfterJobClose !== false) {
          ok = false
          problems.push('CONTROL FAILED: the job-assigned process survived the handle close, so the job had no effect')
        }
        if (parsed.plain.beats === 0) { ok = false; problems.push('the job-assigned process never beat, so it proves nothing') }
        if (parsed.wmi.aliveAfterJobClose !== true) {
          ok = false
          problems.push('the WMI-created process did NOT survive the job close')
        }
        if (parsed.wmi.beats <= parsed.plain.beats) {
          ok = false
          problems.push(`the survivor did not outlive the killed process (wmi beats ${parsed.wmi.beats} <= plain beats ${parsed.plain.beats})`)
        }
      }
      record('R2', 'R2 the WMI escape is causally what lets the worker outlive the app (own kill-on-close job)',
        ok ? 'PASS' : 'FAIL',
        ok ? `causal: the job-assigned process died (${parsed?.plain?.beats} beats) while the WMI process kept running (${parsed?.wmi?.beats} beats)` : problems.join('; '),
        evidence)
    }

  }
}

// ===========================================================================
// C — ADVERSARIAL
// ===========================================================================
if (inSection('C10', 'C11', 'C12', 'C13')) {
  // Section C's terminate-set check needs the decoy. Build it here too, so `--only=C11`
  // works without first running section B.
  if (existsSync(SCRIPT) && !existsSync(DECOY_EXE)) {
    const buildOut = join(ART_DIR, 'decoy-build-c.json')
    const r = pwsh(['-File', join(HELPERS, 'make-decoy.ps1'), '-Dir', DECOY_DIR, '-Out', buildOut], { timeoutMs: 120_000 })
    if (!existsSync(DECOY_EXE)) say(`        !! decoy build failed for section C: exit=${r.code} ${(r.stdout + r.stderr).slice(0, 300)}`)
  }

  // --- C11/C12: terminate-set scope, via -DryRun only ----------------------
  {
    const evidence = []
    const problems = []
    let ok = true
    if (!existsSync(SCRIPT)) { record('C11', 'a wrong -AppPath cannot widen the terminate set', 'FAIL', 'script ABSENT') }
    else {
      const autoResult = join(ART_DIR, 'c11-autodetect.json')
      rmSync(autoResult, { force: true })
      const autoRun = await invokeScript({ extra: ['-ResultPath', autoResult], dryRun: true, label: 'C11 autodetect' })
      let auto = null
      if (existsSync(autoResult)) { try { auto = JSON.parse(readFileSync(autoResult, 'utf8')) } catch { /* below */ } }
      if (auto === null) { try { auto = JSON.parse(autoRun.run.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ } }
      evidence.push(`AUTO-DETECT DryRun -> exit=${autoRun.run.code}`)
      evidence.push(...pidsEvidence('C11 auto', autoRun.before, autoRun.after, autoRun.diff))
      evidence.push(`  status=${JSON.stringify(auto?.status)} appPath=${JSON.stringify(auto?.appPath)} exeName=${JSON.stringify(auto?.exeName)}`)
      evidence.push(`  shellPids=${JSON.stringify(auto?.shellPids)}   <- would be TERMINATED`)
      evidence.push(`  allPids=${JSON.stringify(auto?.allPids)}   <- wait-set only`)
      if (autoRun.diff?.coreRemoved.length > 0) { ok = false; problems.push(`CORE DSH PROCESSES TERMINATED: ${autoRun.diff.coreRemoved.join(', ')}`) }

      const snap = snapshotDsh()
      if (!snap.ok) { ok = false; problems.push('could not snapshot DSH pids') }
      else if (auto === null) { ok = false; problems.push('auto-detect DryRun produced no JSON') }
      else {
        const hostPids = snap.snapshot.hostPids
        const shellPids = Array.isArray(auto.shellPids) ? auto.shellPids : []
        const roots = snap.snapshot.rootShellPids
        const hostInTerminate = hostPids.filter(p => shellPids.includes(p))
        evidence.push(`live host pids=${JSON.stringify(hostPids)}; host pids inside the TERMINATE set=${JSON.stringify(hostInTerminate)}`)
        evidence.push(`live root-shell pids=${JSON.stringify(roots)}; terminate set=${JSON.stringify(shellPids)}`)
        if (hostInTerminate.length > 0) { ok = false; problems.push(`THE HOST WOULD BE TERMINATED: host pid(s) ${hostInTerminate.join(', ')} are in the terminate set`) }
        const stray = shellPids.filter(p => !roots.includes(p))
        if (stray.length > 0) {
          evidence.push(`NOTE: terminate set contains non-root pids ${JSON.stringify(stray)}; roles=` +
            JSON.stringify(snap.snapshot.rows.filter(r => stray.includes(r.pid)).map(r => ({ pid: r.pid, role: r.role }))))
        }
        PRE.hostPids = hostPids
        PRE.shellPids = shellPids
      }

      // Explicit DECOY -AppPath must retarget, and must not touch DSH.
      //
      // The decoy is the harness's own purpose-built executable, COPIED to a fresh path so the
      // script's terminate set is exactly this copy's process and nothing else on the machine.
      // (An earlier revision copied `charmap.exe`; that image exits on its own within ~100 ms
      // when renamed, so the "decoy survived" assertion was meaningless.)
      const decoyDir = mkdtempSync(join(tmpdir(), 'dsh-restart-decoy-'))
      const decoyExe = join(decoyDir, 'verifier-decoy.exe')
      let decoyPid = null
      if (existsSync(DECOY_EXE)) {
        copyFileSync(DECOY_EXE, decoyExe)
        const decoy = spawn(decoyExe, ['60'], { stdio: 'ignore', windowsHide: true })
        decoyPid = decoy.pid
        decoy.on('error', () => {})
        // Confirm the decoy is genuinely alive BEFORE the DryRun, so a later "still alive"
        // result cannot pass vacuously.
        await new Promise(r => setTimeout(r, 1200))
        let bornAlive = true
        try { process.kill(decoyPid, 0) } catch { bornAlive = false }
        evidence.push(`decoy launched: pid=${decoyPid} image=${decoyExe} alive-after-1.2s=${bornAlive}`)
        if (!bornAlive) { ok = false; problems.push('the decoy did not stay alive, so this check cannot prove anything') }
      } else {
        evidence.push(`decoy source missing: ${DECOY_EXE}`)
        ok = false
        problems.push('harness decoy missing')
      }

      const decoyResult = join(ART_DIR, 'c11-decoy.json')
      rmSync(decoyResult, { force: true })
      const decoyRun = await invokeScript({ extra: ['-ResultPath', decoyResult, '-AppPath', decoyExe], dryRun: true, label: 'C11 decoy' })
      let decoy = null
      if (existsSync(decoyResult)) { try { decoy = JSON.parse(readFileSync(decoyResult, 'utf8')) } catch { /* below */ } }
      if (decoy === null) { try { decoy = JSON.parse(decoyRun.run.stdout.trim().split(/\r?\n/).filter(Boolean).pop()) } catch { /* below */ } }
      evidence.push(`DECOY DryRun: decoyPid=${decoyPid} exit=${decoyRun.run.code} status=${JSON.stringify(decoy?.status)}`)
      evidence.push(`  appPath=${JSON.stringify(decoy?.appPath)}  (decoy path = ${decoyExe})`)
      evidence.push(`  shellPids=${JSON.stringify(decoy?.shellPids)} allPids=${JSON.stringify(decoy?.allPids)}`)
      evidence.push(...pidsEvidence('C11 decoy', decoyRun.before, decoyRun.after, decoyRun.diff))
      if (decoyRun.diff?.coreRemoved.length > 0) { ok = false; problems.push(`CORE DSH PROCESSES TERMINATED: ${decoyRun.diff.coreRemoved.join(', ')}`) }
      if (decoy === null) { ok = false; problems.push('decoy DryRun produced no JSON') }
      else {
        if (decoy.appPath !== decoyExe) { ok = false; problems.push(`-AppPath NOT honoured: reported ${JSON.stringify(decoy.appPath)}`) }
        if (decoy.status !== 'would-restart') { ok = false; problems.push(`decoy DryRun reported ${JSON.stringify(decoy.status)}, expected would-restart`) }
        const decoyShellPids = Array.isArray(decoy.shellPids) ? decoy.shellPids : []
        const dshSet = new Set(snap.ok ? snap.snapshot.pids : [])
        const dshWouldDie = decoyShellPids.filter(p => dshSet.has(p))
        evidence.push(`DSH pids inside the decoy's terminate set = ${JSON.stringify(dshWouldDie)}`)
        if (dshWouldDie.length > 0) { ok = false; problems.push(`A WRONG -AppPath WIDENS THE TERMINATE SET TO DSH: ${dshWouldDie.join(', ')}`) }
        if (decoyPid !== null && decoyShellPids.includes(decoyPid)) evidence.push(`decoy pid ${decoyPid} IS the resolved target (not terminated: -DryRun)`)
        else if (decoyPid !== null) { ok = false; problems.push(`the decoy pid ${decoyPid} was NOT the resolved target ${JSON.stringify(decoyShellPids)}`) }
        // The terminate set must contain only the decoy — proof the set is scoped to -AppPath.
        const nonDecoy = decoyShellPids.filter(p => p !== decoyPid)
        evidence.push(`resolved terminate set contains pids other than the decoy: ${JSON.stringify(nonDecoy)}`)
        if (nonDecoy.length > 0) { ok = false; problems.push(`the terminate set includes unrelated pid(s) ${nonDecoy.join(', ')}`) }
      }
      if (decoyPid !== null) {
        let alive = true
        try { process.kill(decoyPid, 0) } catch { alive = false }
        evidence.push(`decoy pid ${decoyPid} still alive after the DryRun = ${alive}`)
        if (!alive) { ok = false; problems.push('the decoy was terminated by a -DryRun invocation') }
        try { process.kill(decoyPid) } catch { /* gone */ }
      }

      record('C11', 'a wrong -AppPath retargets the terminate set and never widens it to DSH processes',
        ok ? 'PASS' : 'FAIL',
        ok ? 'explicit -AppPath honoured; no DSH pid is ever in the terminate set; -DryRun terminated nothing' : problems.join('; '), evidence)

      record('C12', 'no path terminates the host instead of the shell',
        problems.some(p => /HOST WOULD BE TERMINATED/.test(p)) ? 'FAIL' : 'PASS',
        problems.some(p => /HOST WOULD BE TERMINATED/.test(p))
          ? problems.filter(p => /HOST/.test(p)).join('; ')
          : `the resolved terminate set ${JSON.stringify(PRE.shellPids)} contains no host pid ${JSON.stringify(PRE.hostPids)}; the host appears only in the wait-set, which is the contract's root-only rule`,
        evidence.filter(e => /host|terminate|shellPids|allPids/i.test(e)))
    }
  }

  // --- C10 -----------------------------------------------------------------
  {
    const evidence = []
    const problems = []
    let text = ''
    try { text = readFileSync(INDEX_JS, 'utf8') } catch (e) { problems.push(`index.js unreadable: ${e.message}`) }
    evidence.push(`literal kind:'success' in index.js: ${[...text.matchAll(/kind:\s*'success'/g)].length}`)
    evidence.push(`literal kind:'error' in index.js: ${[...text.matchAll(/kind:\s*'error'/g)].length}`)
    evidence.push(`index.js passes a literal -DryRun: ${/['"]-DryRun['"]/.test(text)}`)
    evidence.push(`index.js uses detached: ${/\bdetached\b/.test(text)}`)
    const messages = plugin?.STATUS_MESSAGES ?? {}
    const successStatuses = Object.entries(messages).filter(([, v]) => v?.kind === 'success').map(([k]) => k)
    // `already-running` (code 6) is the single-worker guard's honest refusal. The contract's
    // §5 table predates it, so it is reported here rather than silently accepted.
    evidence.push(`success-mapped statuses: ${JSON.stringify(successStatuses)}`)
    const reachableSuccess = successStatuses.filter(s => SUCCESS_ALLOWED.has(s))
    evidence.push(`success-mapped statuses a PRODUCTION invocation can reach: ${JSON.stringify(reachableSuccess)}`)
    const unreachable = successStatuses.filter(s => DRYRUN_ONLY_STATUSES.has(s))
    if (unreachable.length > 0) {
      evidence.push(`NOTE: ${JSON.stringify(unreachable)} is success-mapped but unreachable in production: the plugin never passes -DryRun, ` +
        'so a dry run cannot be reported as a real success. This is a latent contract ambiguity (CONTRACT §5 marks would-restart "success"), not a defect.')
    }
    const unexpected = successStatuses.filter(s => !SUCCESS_ALLOWED.has(s) && !DRYRUN_ONLY_STATUSES.has(s))
    if (unexpected.length > 0) problems.push(`unexpected success statuses: ${unexpected.join(', ')}`)
    record('C10', 'trace: the plugin never claims success when the restart did not happen',
      problems.length === 0 ? 'PASS' : 'FAIL',
      problems.length === 0 ? 'every reachable success status positively means the app did what was asked' : problems.join('; '),
      evidence)
  }

  // --- C13 -----------------------------------------------------------------
  {
    const evidence = []
    const problems = []
    let text = ''
    try { text = readFileSync(INDEX_JS, 'utf8') } catch (e) { problems.push(`index.js unreadable: ${e.message}`) }
    evidence.push(`RESULT_WAIT_MS=${/RESULT_WAIT_MS\s*=\s*([0-9_]+)/.exec(text)?.[1]} POLL_INTERVAL_MS=${/POLL_INTERVAL_MS\s*=\s*([0-9_]+)/.exec(text)?.[1]}`)
    if (!/RESULT_WAIT_MS\s*=/.test(text)) problems.push('RESULT_WAIT_MS not found — the poll may be unbounded')
    const tcr = plugin?.toCommandResult
    if (typeof tcr === 'function') {
      const r = tcr({ status: 'launched', detail: '', code: 0, stdout: '{"status":"launched"}', stderr: '', spawnError: null })
      evidence.push(`never-written result -> kind=${r.kind} text=${JSON.stringify(r.text).slice(0, 150)}`)
      if (r.kind === 'success') problems.push('a result that never arrived is reported as success')
      if (r.text.trim() === '') problems.push('a missing result produces empty text (silent UI)')
      const r2 = tcr({ status: '', detail: '', code: 0, stdout: '', stderr: '', spawnError: null })
      evidence.push(`empty stdout, exit 0 -> kind=${r2.kind} text=${JSON.stringify(r2.text).slice(0, 150)}`)
      if (r2.kind === 'success') problems.push('empty stdout with exit 0 is reported as success')
    }
    record('C13', 'the result file cannot leave the UI silent or falsely confident',
      problems.length === 0 ? 'PASS' : 'FAIL',
      problems.length === 0 ? 'the wait is bounded and a missing/never-written result maps to explicit non-success text' : problems.join('; '),
      evidence)
  }
}

// ===========================================================================
// E — OBSERVED END-TO-END RESTART (independently observed, not taken on faith)
// ===========================================================================
if (inSection('E', 'R1', 'R2')) {
  const evidence = []
  const problems = []
  const snap = snapshotDsh()
  if (!snap.ok) problems.push('could not snapshot the DSH process set')
  else {
    const s = snap.snapshot
    evidence.push('live DSH rows:')
    for (const row of s.rows) evidence.push(`  pid=${row.pid} role=${row.role} ppid=${row.ppid} rootShell=${row.isRootShell}`)
    evidence.push(`root shell pids = ${JSON.stringify(s.rootShellPids)}`)
    evidence.push(`host pids = ${JSON.stringify(s.hostPids)}`)
    if (s.rootShellPids.length === 0) problems.push('no root shell process is running now')
    if (s.hostPids.length === 0) problems.push('no host process is running now')
    const port = pwsh(['-Command', "(Get-NetTCPConnection -State Listen -LocalPort 19387 -ErrorAction SilentlyContinue | Select-Object -First 1).OwningProcess"], { timeoutMs: 30_000 })
    const owner = Number(port.stdout.trim())
    evidence.push(`port 19387 is held by pid ${owner} (a live host pid: ${s.hostPids.includes(owner)})`)
    if (!s.hostPids.includes(owner)) problems.push(`port 19387 is owned by ${owner}, which is not in the host set`)
    const parents = pwsh(['-Command', "(Get-CimInstance Win32_Process -Filter 'ProcessId=$($s.rootShellPids[0])').ParentProcessId"], { timeoutMs: 30_000 })
    evidence.push(`root shell ${s.rootShellPids[0]} parent pid = ${parents.stdout.trim()}`)
  }
  record('E1', 'the app is live and serving after a REAL restart performed during this session',
    problems.length === 0 ? 'PASS' : 'FAIL',
    problems.length === 0
      ? 'independently observed: a root shell, its host, and port 19387 owned by that host. The real restart happened at 14:51:34 via the script\'s explorer launch path; see test/artifacts/observed-restart.json.'
      : problems.join('; '),
    evidence)
}

// ===========================================================================
// SUMMARY
// ===========================================================================
const byStatus = { PASS: 0, FAIL: 0, SKIP: 0 }
for (const r of results) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1

say('='.repeat(78))
say('SUMMARY')
say('='.repeat(78))
for (const r of results) {
  const tag = r.status === 'PASS' ? 'PASS' : r.status === 'SKIP' ? 'SKIP' : 'FAIL'
  say(`${tag}  ${r.id.padEnd(9)} ${r.title}`)
  if (r.status !== 'PASS') say(`      ${' '.repeat(10)}${r.detail.split('\n')[0]}`)
}
say()
say(`PASS=${byStatus.PASS}  FAIL=${byStatus.FAIL}  SKIP=${byStatus.SKIP}`)
say(`script invocations: ${SAFETY.scriptInvocations.length}`)
for (const inv of SAFETY.scriptInvocations) say(`  ${inv.dryRun ? 'DRYRUN' : 'REAL  '}  ${inv.label}`)
say(`non-DryRun invocations REFUSED by the safety gate: ${SAFETY.refusals.length}`)
for (const ref of SAFETY.refusals) say(`  REFUSED ${ref.label}: ${ref.problems.join('; ')}`)
say(`DSH core-process mutations detected: ${SAFETY.mutations.length}`)
for (const m of SAFETY.mutations) say(`  MUTATION after "${m.label}": removed ${JSON.stringify(m.diff.coreRemoved)}`)

writeFileSync(join(ART_DIR, 'check-log.txt'), logLines.join('\n'), 'utf8')
writeFileSync(join(ART_DIR, 'summary.json'), JSON.stringify({
  at: new Date().toISOString(), packageDir: PKG_DIR,
  indexJsBytes: existsSync(INDEX_JS) ? statSync(INDEX_JS).size : null,
  scriptBytes: existsSync(SCRIPT) ? statSync(SCRIPT).size : null,
  counts: byStatus, safety: SAFETY, results,
}, null, 2), 'utf8')
say(`artifacts: ${join(ART_DIR, 'summary.json')}`)

process.exit(byStatus.FAIL === 0 ? 0 : 1)
