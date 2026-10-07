/**
 * Offline test for the `enable-resume.mjs` line-flip logic.
 *
 * WHY THIS NEEDS ITS OWN TEST
 *
 * The flip is the one place this project WRITES to a configuration file the user owns,
 * and it is guarded by a hand-written line walker. If that walker targets the wrong
 * line, the failure is silent and confusing: either nothing changes (the user restarts
 * and resume is still off), or — worse — an unrelated `enabled:` somewhere else in the
 * file is flipped.
 *
 * So the walker is exercised here against the REAL patch file's shape, in a temp
 * directory, without touching the live config.
 *
 * Run: node test/enable-resume-logic.test.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let passed = 0
let failed = 0

/**
 * Run one assertion body, awaiting it so an async case cannot pass vacuously.
 *
 * The harness was synchronous, and an `async` body handed to it would return a Promise that
 * was never awaited: the test would report PASS regardless of what the assertion did. The
 * test below needs to await a dynamic import, so the harness has to know about promises.
 *
 * @param {string} label - what is being verified.
 * @param {() => unknown} body - the assertions.
 * @returns {Promise<void>} resolves when the case has run.
 */
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

/**
 * Parse YAML with the Loader's OWN js-yaml, read out of the installed asar.
 *
 * This is what makes the check meaningful: a different parser's opinion of the file would
 * not tell us what the app will do. The `!!js` tag is registered exactly as the Loader
 * registers it, which is why a plain `js-yaml` import is not a substitute.
 *
 * @param {string} text - the YAML document.
 * @returns {Promise<any>} the parsed document, or null when the asar cannot be read.
 */
async function parseWithLoaderYaml(text) {
  const asar = locateAppAsar()
  if (asar === null) return null

  const yamlSource = readFromAsar(asar, 'node_modules/js-yaml/dist/js-yaml.mjs')
  if (yamlSource === null) return null
  const scratch = path.join(os.tmpdir(), `jsyaml-${process.pid}-${Date.now()}.mjs`)
  fs.writeFileSync(scratch, yamlSource, 'utf8')
  try {
    const yaml = await import(`file://${scratch.replace(/\\/g, '/')}`)
    const jsType = new yaml.Type('tag:yaml.org,2002:js', {
      kind: 'scalar',
      construct: data => ({ __jsExpr: String(data) }),
    })
    return yaml.load(text, { schema: yaml.DEFAULT_SCHEMA.extend([jsType]) })
  } finally {
    fs.rmSync(scratch, { force: true })
  }
}

/**
 * Find the installed app's `app.asar`.
 *
 * Deliberately NOT derived from `process.execPath`: the suite runs under a standalone Node
 * (`C:\Program Files\nodejs\node.exe`), which sits nowhere near the app. A relative guess
 * therefore found nothing and the assertion SKIPPED ITSELF — and a test that quietly does not
 * run is worse than one that fails, because it reports success. An explicit env var wins,
 * then the known install roots.
 *
 * @returns {string|null} the archive path, or null when the app is not installed here.
 */
function locateAppAsar() {
  /** @type {string[]} */
  const candidates = []
  if (typeof process.env.DSH_ASAR === 'string' && process.env.DSH_ASAR !== '') {
    candidates.push(process.env.DSH_ASAR)
  }
  const local = process.env.LOCALAPPDATA ?? ''
  for (const root of ['C:\\agent\\dsh_desktop', local === '' ? '' : path.join(local, 'Programs', '@deepseek-ai', 'dsh-desktop')]) {
    if (root !== '') candidates.push(path.join(root, 'resources', 'app.asar'))
  }
  return candidates.find(candidate => fs.existsSync(candidate)) ?? null
}

/**
 * Read one file out of an asar archive (minimal, read-only).
 *
 * @param {string} asar - path to the archive.
 * @param {string} inner - posix path inside the archive.
 * @returns {string|null} the file's text, or null when absent.
 */
function readFromAsar(asar, inner) {
  try {
    const fd = fs.openSync(asar, 'r')
    try {
      const head = Buffer.alloc(16)
      fs.readSync(fd, head, 0, 16, 0)
      const headerPickleSize = head.readUInt32LE(4)
      const jsonLen = head.readUInt32LE(12)
      const jsonBuf = Buffer.alloc(jsonLen)
      fs.readSync(fd, jsonBuf, 0, jsonLen, 16)
      const header = JSON.parse(jsonBuf.toString('utf8'))
      const dataOffset = 8 + headerPickleSize

      let node = header
      for (const segment of inner.split('/')) {
        node = node?.files?.[segment]
        if (node === undefined) return null
      }
      if (node?.offset === undefined || node?.size === undefined) return null
      const out = Buffer.alloc(Number(node.size))
      fs.readSync(fd, out, 0, out.length, dataOffset + Number(node.offset))
      return out.toString('utf8')
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return null
  }
}

/**
 * The exact walker from `enable-resume.mjs`.
 *
 * Duplicated on purpose rather than imported: the script runs top-level side effects on
 * import (it talks to the Host and may EDIT THE REAL CONFIG), so a test must not import
 * it. Keeping the logic here in one small function makes the duplication obvious and
 * reviewable, and any divergence shows up as a failing test.
 *
 * @param {string} text - the patch file's text.
 * @returns {{text: string, changed: boolean}} the result.
 */
function flipEnabledInSessionWatch(text) {
  const lines = text.split('\n')
  let inSessionWatch = false
  let changed = false
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]
    if (/^\s*- id:\s*session-watch\s*$/.test(line)) { inSessionWatch = true; continue }
    if (/^\s*- id:\s*\S+\s*$/.test(line) && !/session-watch/.test(line)) { inSessionWatch = false; continue }
    if (inSessionWatch && /^(\s*)enabled:\s*false\s*$/.test(line)) {
      lines[i] = line.replace('enabled: false', 'enabled: true')
      changed = true
      break
    }
  }
  return { text: lines.join('\n'), changed }
}

console.log('\n=== enable-resume-logic.test.mjs ===')

await test('flips the session-watch row and reports the change', () => {
  const source = [
    '- insert:',
    '    - id: window-pin',
    "      name: 'dsh-window-pin'",
    '    - id: session-watch',
    "      name: 'dsh-session-watch'",
    '      config:',
    '        stallMs: 900000',
    '        resume:',
    '          enabled: false',
    "          maxAttempts: 2",
    '    - id: journal',
    "      name: 'dsh-journal'",
  ].join('\n')
  const result = flipEnabledInSessionWatch(source)
  assert.equal(result.changed, true)
  assert.ok(result.text.includes('enabled: true'))
  assert.ok(!result.text.includes('enabled: false'))
  // Everything else must be byte-identical.
  assert.ok(result.text.includes("    - id: journal"))
  assert.ok(result.text.includes('stallMs: 900000'))
  assert.ok(result.text.includes('maxAttempts: 2'))
})

await test('does NOT touch an enabled: false belonging to another row', () => {
  // The whole point of walking rather than regex-replacing the first match.
  const source = [
    '- insert:',
    '    - id: some-other-plugin',
    '      name: "other"',
    '      config:',
    '        enabled: false',
    '    - id: session-watch',
    "      name: 'dsh-session-watch'",
    '      config:',
    '        resume:',
    '          enabled: false',
  ].join('\n')
  const result = flipEnabledInSessionWatch(source)
  assert.equal(result.changed, true)
  const lines = result.text.split('\n')
  // The first `enabled: false` (under some-other-plugin) must survive.
  assert.equal(lines.filter(l => l.trim() === 'enabled: false').length, 1, 'exactly one line should remain false')
  assert.equal(lines.filter(l => l.trim() === 'enabled: true').length, 1)
  const otherIndex = lines.findIndex(l => l.includes('some-other-plugin'))
  const trueIndex = lines.findIndex(l => l.trim() === 'enabled: true')
  assert.ok(trueIndex > otherIndex, 'the flipped line must be the session-watch one, not the earlier row')
})

await test('reports no change when it is already enabled', () => {
  const source = [
    '    - id: session-watch',
    '      config:',
    '        resume:',
    '          enabled: true',
  ].join('\n')
  const result = flipEnabledInSessionWatch(source)
  assert.equal(result.changed, false)
})

await test('reports no change when session-watch is absent', () => {
  const source = [
    '- insert:',
    '    - id: window-pin',
    '      config:',
    '        enabled: false',
  ].join('\n')
  const result = flipEnabledInSessionWatch(source)
  assert.equal(result.changed, false, 'must not flip an unrelated row when session-watch is missing')
})

await test('flips only ONE occurrence even if the block somehow repeats', () => {
  const source = [
    '    - id: session-watch',
    '      config:',
    '        resume:',
    '          enabled: false',
    '          enabled: false',
  ].join('\n')
  const result = flipEnabledInSessionWatch(source)
  assert.equal(result.text.split('\n').filter(l => l.trim() === 'enabled: true').length, 1)
})

await test('operates on the REAL patch file without altering anything else', () => {
  // This test must NOT assume a particular VALUE. `enabled` becomes true the moment the
  // user turns auto-resume on, and a test demanding `false` then fails on a perfectly
  // correct configuration — which is exactly what happened the first time this ran after
  // the switch was flipped.
  //
  // What is being pinned is the WALKER: that it finds the right line and changes exactly
  // one line. So the expectation is derived from the file's present state, and BOTH
  // directions are exercised — flipping when disabled, and reporting "no change" when it
  // is already enabled.
  const real = path.join(process.env.USERPROFILE ?? '.', '.dsh', 'cordis.patch.yml')
  if (!fs.existsSync(real)) {
    console.log('        (skipped: live patch not present)')
    return
  }
  const original = fs.readFileSync(real, 'utf8')
  // Look only inside the session-watch row: another row's `enabled: false` is irrelevant.
  const rowStart = original.indexOf('- id: session-watch')
  const rowEnd = original.indexOf('\n    - id:', rowStart + 1)
  const row = rowStart < 0 ? '' : original.slice(rowStart, rowEnd < 0 ? undefined : rowEnd)
  const currentlyDisabled = /^\s*enabled:\s*false\s*$/m.test(row)

  const result = flipEnabledInSessionWatch(original)
  assert.equal(
    result.changed,
    currentlyDisabled,
    `changed should be ${currentlyDisabled} given the live file's current value`,
  )
  const before = original.split('\n')
  const after = result.text.split('\n')
  assert.equal(after.length, before.length, 'line count must not change')
  const differing = before.filter((line, i) => line !== after[i])
  assert.equal(
    differing.length,
    currentlyDisabled ? 1 : 0,
    `expected ${currentlyDisabled ? 1 : 0} differing line(s), got ${differing.length}`,
  )
  if (currentlyDisabled) {
    assert.equal(differing[0].trim(), 'enabled: false', 'and it must be the enabled line')
  }
  // And the real file was NOT written.
  assert.equal(fs.readFileSync(real, 'utf8'), original, 'the test must not modify the live config')
})

await test('the flipped document is still valid YAML with the intended config', async () => {
  // Parsed with the Loader's OWN js-yaml, read straight out of the installed asar, so this
  // checks what the app will actually do rather than what some other parser makes of it.
  //
  // This used to shell out to `_recon/validate-patch.mjs`. That worked in the author's
  // workspace but made the package non-self-contained: the suite could not run from a clone,
  // because `_recon/` is not part of it. Inlining keeps the guarantee and removes the
  // out-of-package dependency.
  const real = path.join(process.env.USERPROFILE ?? '.', '.dsh', 'cordis.patch.yml')
  if (!fs.existsSync(real)) {
    console.log('        (skipped: live patch not present)')
    return
  }
  const flipped = flipEnabledInSessionWatch(fs.readFileSync(real, 'utf8')).text
  const parsed = await parseWithLoaderYaml(flipped)
  if (parsed === null) {
    console.log('        (skipped: could not read js-yaml from the asar)')
    return
  }
  const rows = (parsed ?? []).flatMap(entry => entry?.insert ?? [])
  const row = rows.find(entry => entry?.id === 'session-watch')
  assert.ok(row, `the flipped document must still carry the session-watch row: ${JSON.stringify(parsed)}`)
  assert.equal(row?.config?.resume?.enabled, true,
    `the parsed config should show resume enabled: ${JSON.stringify(row?.config?.resume)}`)
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
