/**
 * Verifies the expert half's `apply` — the function the preset row actually calls.
 *
 * WHY THIS IS SEPARATE FROM proxy.test.mjs
 *
 * That suite tests the three TOOLS. This one tests the MOUNT: that `apply` registers
 * exactly those tools, publishes the mount record, and cleans up after itself. Those
 * fail independently — tools can be perfect while `apply` throws on registration, and
 * a throwing `apply` is what a failed preset mount looks like from outside.
 *
 * The mount record matters because "the bundle is installed" and "the preset
 * composition mounted" are different facts, and only the second means the expert
 * exists. It is written after registration succeeds, so its presence is evidence.
 *
 * Runs against a temporary DSH_HOME; the real record is never touched.
 *
 * Run: node test/proxy-apply.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0

/** @param {string} label @param {() => any} body */
function test(label, body) {
  try {
    body()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${label}`)
    console.log(`        ${error.message}`)
  }
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), 'proxy-apply-'))
process.env.DSH_HOME = tempHome

const { apply, name, inject } = await import('../lib/proxy.js')
const { readProxyMount, mountRecordPath } = await import('../lib/shared.js')

/** A minimal Cordis-like context that records registrations and effects. */
function makeCtx() {
  const registered = []
  const effects = []
  return {
    registered,
    effects,
    tools: {
      register(definition) {
        if (registered.some(existing => existing.name === definition.name)) {
          throw new Error(`duplicate tool ${definition.name}`)
        }
        registered.push(definition)
        return () => {
          const index = registered.indexOf(definition)
          if (index >= 0) registered.splice(index, 1)
        }
      },
    },
    get() { return undefined },
    effect(callback) {
      const disposer = callback()
      effects.push(disposer)
      return disposer
    },
    logger: { warn() {} },
  }
}

console.log('\n=== proxy-apply.test.mjs ===')

test('the plugin declares the name and the tools injection', () => {
  assert.equal(name, 'session-watch-proxy')
  assert.deepEqual(inject, ['tools'])
})

test('apply registers exactly the three expert tools', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  assert.deepEqual(
    ctx.registered.map(tool => tool.name).sort(),
    ['session_resume', 'session_review', 'session_roster'],
  )
})

test('apply writes the mount record AFTER registering', () => {
  const ctx = makeCtx()
  apply(ctx, {})
  const record = readProxyMount()
  assert.ok(record !== null, `no mount record at ${mountRecordPath()}`)
  assert.equal(record.plugin, 'session-watch-proxy')
  assert.equal(record.pid, process.pid)
  assert.deepEqual(
    record.tools.sort(),
    ['session_resume', 'session_review', 'session_roster'],
  )
})

test('the mount record carries the effective policy, so a restart is diagnosable', () => {
  const ctx = makeCtx()
  apply(ctx, { stallMs: 12345, resume: { enabled: true, maxAttempts: 7 } })
  const record = readProxyMount()
  assert.equal(record.stallMs, 12345)
  assert.equal(record.resumeEnabled, true)
})

test('a registration failure does NOT leave a mount record claiming success', () => {
  // The record is evidence of a working mount. Writing it before registration — or
  // leaving a previous record in place after a failure — would make a broken mount
  // indistinguishable from a healthy one, which is the exact confusion this file was
  // added to remove.
  fs.rmSync(mountRecordPath(), { force: true })
  const ctx = makeCtx()
  // A tools registry that rejects the very first registration.
  ctx.tools.register = () => { throw new Error('registry refused') }
  assert.throws(() => apply(ctx, {}), /registry refused/)
  assert.equal(readProxyMount(), null, 'a failed mount must not leave a success record')
})

test('a failure after a partial registration unwinds what it registered', () => {
  const ctx = makeCtx()
  let calls = 0
  const original = ctx.tools.register
  ctx.tools.register = (definition) => {
    calls += 1
    if (calls === 2) throw new Error('second registration failed')
    return original.call(ctx.tools, definition)
  }
  assert.throws(() => apply(ctx, {}), /second registration failed/)
  assert.deepEqual(ctx.registered, [], 'the first registration must have been disposed')
})

test('apply returns a disposer that unregisters every tool', () => {
  const ctx = makeCtx()
  const dispose = apply(ctx, {})
  assert.equal(ctx.registered.length, 3)
  assert.equal(typeof dispose, 'function')
  dispose()
  assert.deepEqual(ctx.registered, [])
})

test('apply tolerates a missing config entirely', () => {
  const ctx = makeCtx()
  assert.doesNotThrow(() => apply(ctx))
  assert.equal(ctx.registered.length, 3)
})

test('apply tolerates a context without a logger', () => {
  const ctx = makeCtx()
  delete ctx.logger
  assert.doesNotThrow(() => apply(ctx, {}))
})

test('the expert half does NOT statically depend on the Host half', () => {
  // REGRESSION, and the reason `lib/ledger.js` exists.
  //
  // The loader caches a plugin's module by name. When the expert half imported
  // `readLedger`/`recordAttempt`/`resumeSession` from `plugin.js`, a process still
  // holding the OLDER `plugin.js` made `import('./plugin.js')` throw
  //   SyntaxError: The requested module './plugin.js' does not provide an export named ...
  // A missing export is a LOAD-TIME error, so the ENTIRE expert half failed to mount —
  // all three tools, including the two read-only ones — with a message that said
  // nothing about needing a restart.
  //
  // Sharing the ledger through its own module removes that failure mode. This test
  // asserts the coupling is not reintroduced: no STATIC import of `plugin.js` may
  // appear in the expert half. A dynamic `import()` is fine — that is exactly how the
  // one genuine dependency (`resumeSession`) is reached, so it stays lazy and can be
  // reported as an error by the tool instead of killing the module.
  const source = fs.readFileSync(new URL('../lib/proxy.js', import.meta.url), 'utf8')
  const staticImports = [...source.matchAll(/^\s*import\s[^;]*?from\s+['"]([^'"]+)['"]/gm)]
    .map(match => match[1])
  assert.ok(
    !staticImports.includes('./plugin.js'),
    `proxy.js must not statically import ./plugin.js; found: ${staticImports.join(', ')}`,
  )
  assert.ok(staticImports.includes('./ledger.js'), 'the ledger must come from ./ledger.js')
})

test('the Host half still re-exports the ledger API for existing callers', async () => {
  // `plugin.js` re-exports these so tests and scripts written against the old surface
  // keep working. Removing them would be a silent breaking change.
  const host = await import('../lib/plugin.js')
  assert.equal(typeof host.readLedger, 'function')
  assert.equal(typeof host.recordAttempt, 'function')
})

test('both halves read the SAME ledger', async () => {
  // Two counters would let a session exceed its cap simply by changing who asked.
  const { recordAttempt, readLedger } = await import('../lib/ledger.js')
  const host = await import('../lib/plugin.js')
  recordAttempt('session-shared-ledger-check', { at: Date.now(), ok: true, by: 'auto' })
  assert.equal(
    host.readLedger().sessions['session-shared-ledger-check'].attempts,
    readLedger().sessions['session-shared-ledger-check'].attempts,
  )
})

test('the diagnostics report degrades when the preset registry is absent', async () => {
  // `diagnostics` is served over HTTP and must never throw: a diagnostic endpoint that
  // fails is worse than one that reports "unknown", because it hides the very state it
  // was added to reveal.
  //
  // It is not exported, so this exercises it the way the route does — through a context
  // that lacks `agentPresets`, which is the realistic degraded case.
  const host = await import('../lib/plugin.js')
  const routes = []
  const disposers = []
  const ctx = {
    get: () => undefined,
    effect: setup => {
      const r = setup()
      const dispose = typeof r === 'function' ? r : () => {}
      disposers.push(dispose)
      return dispose
    },
    commands: { register: () => () => {} },
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
    logger: { warn() {} },
  }
  host.apply(ctx, {})
  assert.equal(routes.length, 1, 'the route should register')

  try {
    /** Minimal req/res doubles. */
    let captured = null
    const req = { method: 'GET', url: '/session-watch/api/diagnostics', headers: { 'x-session-watch': '1' } }
    const res = {
      headersSent: false,
      writeHead() { this.headersSent = true },
      end(payload) { captured = JSON.parse(payload) },
      destroy() {},
    }
    await routes[0].handler(req, res)
    assert.ok(captured !== null, 'the handler should answer')
    assert.equal(captured.ok, true)
    assert.equal(captured.proxyMounted, false, 'nothing mounted in this stub process')
    assert.ok(captured.expertScope, 'the scope report must be present even when unknown')
    assert.equal(captured.expertScope.known, false, 'and must say it does not know')
    assert.ok(typeof captured.expertScope.reason === 'string', 'and why')
  } finally {
    // `apply` also starts a poll interval. Left running it keeps the event loop alive
    // forever, so the suite would hang instead of reporting a result — which is exactly
    // what happened the first time this test was written.
    for (const dispose of disposers) {
      try { dispose() } catch { /* best effort */ }
    }
  }
})

console.log(`\n通过 ${passed}，失败 ${failed}`)

try { fs.rmSync(tempHome, { recursive: true, force: true }) } catch {}

if (failed > 0) process.exit(1)
