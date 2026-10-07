/**
 * SAFETY PRELOAD for any scenario that invokes the /restart handler.
 *
 * WHY THIS EXISTS
 * ---------------
 * The plugin does `import { spawn } from 'node:child_process'` at module evaluation.
 * A harness that patches `require('node:child_process').spawn` afterwards does NOT
 * change that binding, so the plugin silently calls the REAL spawn. That mistake made
 * an earlier version of this harness execute a real, non-DryRun restart against the
 * live app.
 *
 * This preload runs BEFORE the plugin is imported (`node --import`), patches the CJS
 * builtin, and then calls `module.syncBuiltinESMExports()` so the ESM named binding
 * resolves to the patched function too. Verified: `import { spawn }` === patched.
 *
 * FAIL-CLOSED
 * -----------
 * A spawn that was not explicitly armed by the scenario THROWS. It never falls through
 * to the real spawn. So no scenario can start a real process by accident.
 */
import { createRequire, syncBuiltinESMExports } from 'node:module'

const require = createRequire(import.meta.url)
const childProcess = require('node:child_process')
const realSpawn = childProcess.spawn

/** Armed factory, or null. Set by the scenario immediately before it calls the handler. */
globalThis.__VR_FAKE__ = null
/** Every spawn attempt, armed or not. */
globalThis.__VR_SPAWNS__ = []
/** Spawn attempts the guard actually REFUSED (threw, nothing started). */
globalThis.__VR_REFUSED__ = []
/** Non-DryRun script invocations that were noted and then served by the armed fake. */
globalThis.__VR_NOTED_NONDRYRUN__ = []

const SCRIPT_RE = /dsh-restart\.ps1\s*$/i

childProcess.spawn = function guardedSpawn(command, args, options) {
  const argv = Array.isArray(args) ? args.map(String) : []
  const record = { command: String(command), args: argv }
  globalThis.__VR_SPAWNS__.push(record)

  // Note (do not silently allow) any real restart-script invocation. In this harness the
  // armed fake serves it, so no PowerShell process is ever created; the note exists so a
  // reviewer can see exactly what the plugin asked for.
  if (argv.some(arg => SCRIPT_RE.test(arg)) && !argv.includes('-DryRun')) {
    globalThis.__VR_NOTED_NONDRYRUN__.push(record)
  }

  if (globalThis.__VR_FAKE__ === null) {
    globalThis.__VR_REFUSED__.push({ ...record, reason: 'spawn attempted with no armed fake' })
    throw new Error(
      `SAFETY: verification preload refused an unarmed spawn (${String(command)}). ` +
      'No real process may be started from a scenario.',
    )
  }
  return globalThis.__VR_FAKE__(String(command), argv, options)
}

// Make the patch visible to `import { spawn } from 'node:child_process'`.
syncBuiltinESMExports()

// Prove the mechanism at load time so a silent regression cannot hide.
const { spawn: esmSpawn } = await import('node:child_process')
if (esmSpawn !== childProcess.spawn) {
  throw new Error('SAFETY: preload failed to rebind the ESM named export for spawn — refusing to run')
}
