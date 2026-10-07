/**
 * Proves the two halves share ONE in-memory snapshot holder.
 *
 * WHY THIS TEST EXISTS
 *
 * `session_roster` must report exactly the verdicts the sidebar shows. The Host half
 * publishes its snapshot into a module-level holder in `lib/shared.js`, and the expert
 * half reads it from there. That only works if Node hands BOTH halves the same module
 * instance.
 *
 * They are loaded by different specifiers:
 *
 *   Host  row: `@local/dsh-session-watch`        -> lib/plugin.js
 *   Proxy row: `@local/dsh-session-watch/proxy`  -> lib/proxy.js
 *
 * and in the real deployment both arrive through a JUNCTION under
 * `~/.dsh/profiles/desktop/node_modules/@local/`. If those resolved to different real
 * paths, the holder would exist twice and the expert would silently fall back to its own
 * scan — producing verdicts that could disagree with the panel, with nothing to indicate
 * why. That is a silent-wrong-answer failure, so it gets a test rather than an assumption.
 *
 * This check is POSSIBLE without restarting because module resolution is the same in any
 * Node process; only the plugin loading differs.
 *
 * Run: node test/shared-instance.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

let passed = 0
let failed = 0

/** @param {string} label @param {() => any} body */
async function test(label, body) {
  try {
    await body()
    passed += 1
    console.log(`  PASS  ${label}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL  ${label}`)
    console.log(`        ${error.message}`)
  }
}

const home = process.env.USERPROFILE ?? '.'
const profileDir = path.join(home, '.dsh', 'profiles', 'desktop')

/** Resolve a bare specifier the way the profile's loader would. */
function resolveFromProfile(specifier) {
  const require = createRequire(path.join(profileDir, 'package.json'))
  return require.resolve(specifier)
}

/** Turn a Windows path into a file URL. */
function toFileUrl(file) {
  return new URL(`file:///${file.replace(/\\/g, '/')}`).href
}

console.log('\n=== shared-instance.test.mjs ===')

await test('both halves are resolvable from the profile', () => {
  assert.ok(resolveFromProfile('@local/dsh-session-watch'), 'host half should resolve')
  assert.ok(resolveFromProfile('@local/dsh-session-watch/proxy'), 'proxy half should resolve')
})

await test('both specifiers resolve into the SAME real directory', () => {
  // A junction is followed to its target, so this also proves the junction does not
  // create a second module identity.
  const host = resolveFromProfile('@local/dsh-session-watch')
  const proxy = resolveFromProfile('@local/dsh-session-watch/proxy')
  assert.equal(path.dirname(host), path.dirname(proxy), 'both should live in lib/')
})

await test('importing by either specifier yields the SAME shared module instance', async () => {
  const hostUrl = toFileUrl(resolveFromProfile('@local/dsh-session-watch'))
  const proxyUrl = toFileUrl(resolveFromProfile('@local/dsh-session-watch/proxy'))
  const host = await import(hostUrl)
  const proxy = await import(proxyUrl)
  assert.ok(host && proxy, 'both halves should import')

  // The decisive check: write through one half's view of `shared.js`, read through the
  // other's. Identity of the module object is the mechanism; the read-back is the
  // observable consequence.
  const sharedUrl = toFileUrl(path.join(path.dirname(resolveFromProfile('@local/dsh-session-watch')), 'shared.js'))
  const shared = await import(sharedUrl)

  shared.publishSnapshot({ probe: 'written-by-host-half', totals: { scanned: 1 } })
  const seen = shared.readPublishedSnapshot()
  assert.ok(seen !== null, 'the holder should be readable')
  assert.equal(seen.probe, 'written-by-host-half')

  // And the expert half's own import of the same file must see it too.
  const proxySharedUrl = toFileUrl(
    path.join(path.dirname(resolveFromProfile('@local/dsh-session-watch/proxy')), 'shared.js'),
  )
  const proxyShared = await import(proxySharedUrl)
  assert.equal(proxyShared, shared, 'both halves must share one shared.js instance')
  assert.equal(
    proxyShared.readPublishedSnapshot()?.probe,
    'written-by-host-half',
    'the expert half must see the host half\'s snapshot',
  )
})

await test('the two halves do NOT resolve to a duplicated tree', () => {
  // A junction loop or a copied package would produce two real paths under different
  // directories, which is exactly the silent failure this guards.
  const host = fs.realpathSync(resolveFromProfile('@local/dsh-session-watch'))
  const proxy = fs.realpathSync(resolveFromProfile('@local/dsh-session-watch/proxy'))
  const hostRoot = host.split(path.sep).slice(0, -1).join(path.sep)
  const proxyRoot = proxy.split(path.sep).slice(0, -1).join(path.sep)
  assert.equal(hostRoot, proxyRoot, `expected one package root, got ${hostRoot} vs ${proxyRoot}`)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
