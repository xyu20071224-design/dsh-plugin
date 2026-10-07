/**
 * Guards the `user-proxy` preset against silent drift from the shipped `standard`
 * preset.
 *
 * THE PROBLEM THIS SOLVES
 *
 * A preset's `plugins` is a COMPLETE list — the Loader replaces `config` wholesale and
 * never deep-merges, so there is no "standard plus my extra row". `user-proxy` is
 * therefore a copy of `standard` with one row appended, and a copy goes stale: the day
 * `standard` gains a tool, `user-proxy` silently keeps the old set, and the expert
 * quietly loses a capability nobody will notice until it is needed.
 *
 * A comment saying "keep this in sync" is not a mechanism. This is. It compares the
 * two lists and fails with the exact difference.
 *
 * It reads the shipped `standard` patch from the asar archive rather than from a copy
 * in this repo, so it detects drift against what is ACTUALLY DEPLOYED, not against a
 * snapshot that would itself go stale.
 *
 * Run: node test/preset-drift.mjs
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ASAR = 'C:\\agent\\dsh_desktop\\resources\\app.asar'
const STANDARD_IN_ASAR = 'dsh/node_modules/@deepseek-ai/dsh-web-app/presets/standard.patch.yml'
const OUR_PATCH = path.resolve(here, '..', '..', 'dsh-user-proxy', 'cordis.patch.yml')

/** The row this preset ADDS. Everything else must match `standard`. */
const ADDED_ROW_ID = 'session-watch-proxy'

let passed = 0
let failed = 0

/** @param {string} label @param {() => void} body */
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

/**
 * Read one file out of the asar archive.
 *
 * The archive header is a small JSON directory followed by the file data, so it can
 * be parsed directly — no dependency and no extraction step.
 * @param {string} archivePath - path inside the archive, posix separators.
 * @returns {string|null} the file's text, or null when absent.
 */
function readFromAsar(archivePath) {
  const fd = fs.openSync(ASAR, 'r')
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
    for (const part of archivePath.split('/')) {
      node = node?.files?.[part]
      if (node === undefined) return null
    }
    if (node.files !== undefined) return null
    const buf = Buffer.alloc(Number(node.size))
    fs.readSync(fd, buf, 0, buf.length, dataOffset + Number(node.offset))
    return buf.toString('utf8')
  } finally {
    fs.closeSync(fd)
  }
}

/**
 * Extract the plugin rows of a preset patch as `id -> name` pairs, in order.
 *
 * Deliberately a small line scanner rather than a YAML parser: the shape here is a
 * flat list of `- id:` / `name:` pairs, and depending on a YAML library would make the
 * drift check fail for a parsing reason instead of a drift reason. Nested group
 * children are indented deeper than the plugin list, so only rows at the plugin-list
 * indentation are read as top-level tools.
 *
 * @param {string} text - the patch file's text.
 * @returns {Array<{id: string, name: string}>} the rows.
 */
function pluginRows(text) {
  const lines = text.split('\n')
  const rows = []
  // Find the line that opens `plugins:` inside the preset declaration.
  let baseIndent = null
  for (const line of lines) {
    const pluginsMatch = /^(\s*)plugins:\s*$/.exec(line)
    if (pluginsMatch) {
      baseIndent = pluginsMatch[1].length
      break
    }
  }
  if (baseIndent === null) return rows

  /** @type {{id: string, name: string}|null} */
  let current = null
  for (const line of lines) {
    const rowMatch = new RegExp(`^\\s{${baseIndent + 2}}- id:\\s*(.+?)\\s*$`).exec(line)
    if (rowMatch) {
      if (current !== null) rows.push(current)
      current = { id: rowMatch[1].replace(/^['"]|['"]$/g, ''), name: '' }
      continue
    }
    if (current === null) continue
    const nameMatch = new RegExp(`^\\s{${baseIndent + 4}}name:\\s*(.+?)\\s*$`).exec(line)
    if (nameMatch) current.name = nameMatch[1].replace(/^['"]|['"]$/g, '')
  }
  if (current !== null) rows.push(current)
  return rows
}

console.log('\n=== preset-drift.mjs ===')

test('the user-proxy bundle patch exists and declares the preset', () => {
  assert.ok(fs.existsSync(OUR_PATCH), `missing ${OUR_PATCH}`)
  const text = fs.readFileSync(OUR_PATCH, 'utf8')
  assert.ok(text.includes('id: preset-user-proxy'), 'should declare preset-user-proxy')
  assert.ok(text.includes('id: user-proxy'), 'config.id should be user-proxy')
})

test('the shipped standard preset can be read from the asar', () => {
  const text = readFromAsar(STANDARD_IN_ASAR)
  assert.ok(typeof text === 'string' && text.length > 1000, 'standard.patch.yml should be readable')
})

const standardText = readFromAsar(STANDARD_IN_ASAR)
const ourText = fs.readFileSync(OUR_PATCH, 'utf8')
const standardRows = pluginRows(standardText)
const ourRows = pluginRows(ourText)

test('both presets parse to a non-trivial tool list', () => {
  assert.ok(standardRows.length >= 15, `standard rows: ${standardRows.length}`)
  assert.ok(ourRows.length >= 15, `user-proxy rows: ${ourRows.length}`)
})

test('every row of the shipped standard preset is present in user-proxy', () => {
  const ours = new Map(ourRows.map(row => [row.id, row.name]))
  const missing = []
  for (const row of standardRows) {
    if (!ours.has(row.id)) missing.push(row.id)
    else if (row.name !== '' && ours.get(row.id) !== row.name) {
      missing.push(`${row.id} (name ${ours.get(row.id)} != ${row.name})`)
    }
  }
  assert.deepEqual(missing, [], `user-proxy is missing/changed: ${missing.join(', ')}`)
})

test('user-proxy adds EXACTLY the one intended row', () => {
  const theirs = new Set(standardRows.map(row => row.id))
  const added = ourRows.filter(row => !theirs.has(row.id)).map(row => row.id)
  assert.deepEqual(added, [ADDED_ROW_ID], `unexpected extra rows: ${added.join(', ')}`)
})

test('the added row resolves to this package\'s proxy half', () => {
  const row = ourRows.find(r => r.id === ADDED_ROW_ID)
  assert.ok(row, 'the proxy row must be present')
  assert.equal(row.name, '@local/dsh-session-watch/proxy')
})

test('the proxy half is actually exported by the package manifest', () => {
  // A row pointing at a non-exported subpath fails at mount, and the failure would
  // only appear at runtime — in the preset, not in this repo.
  const manifestPath = path.resolve(here, '..', 'package.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const exported = manifest.exports?.['./proxy']
  assert.ok(exported, 'package.json must export ./proxy')
  const target = typeof exported === 'string' ? exported : exported.default
  assert.ok(fs.existsSync(path.resolve(here, '..', target)), `export target missing: ${target}`)
})

test('the preset does NOT grant the proxy tools to standard sessions', () => {
  // The whole point of putting the row in this preset rather than in `standard`.
  const standardIds = new Set(standardRows.map(row => row.id))
  assert.ok(!standardIds.has(ADDED_ROW_ID), 'the proxy row must not be in the shipped standard preset')
})

test('service-providing rows sit inside an isolate realm', () => {
  // A preset row that supplies a service without an isolate realm publishes into the
  // root realm, and the SECOND session mounting this preset collides with the first.
  // The proxy row only CONSUMES services, so it needs no realm — but if a later edit
  // adds a service row, this fails rather than shipping a preset that breaks on the
  // second session.
  const groupIsolates = (ourText.match(/isolate:/g) ?? []).length
  const groups = (ourText.match(/group: true/g) ?? []).length
  assert.ok(groups >= 2, `expected the shipped groups to be present, found ${groups}`)
  assert.ok(groupIsolates >= groups, `every group should carry an isolate: ${groupIsolates} isolates / ${groups} groups`)
})

test('the persona actually instructs the expert to USE its tools', () => {
  // The persona is load-bearing, not decoration: without it the preset is a `standard`
  // session that happens to hold three extra tools and does not know they exist.
  // Three things must be present for the expert to be useful rather than dangerous.
  for (const tool of ['session_roster', 'session_review', 'session_resume']) {
    assert.ok(ourText.includes(tool), `the persona should name ${tool}`)
  }
  // It must send the expert to the EVIDENCE before it asserts a cause.
  assert.ok(/before saying\s+why it stopped|read it with/i.test(ourText),
    'the persona must require reading a session before explaining it')
  // And it must not work around a refusal. A gate the model treats as an obstacle is
  // not a gate.
  assert.ok(/report the reason\s+rather than working around it/i.test(ourText),
    'the persona must say a refusal is a decision, not an obstacle')
  // And it must not present an unreadable result as "nothing is wrong".
  assert.ok(/Never present\s+an empty result as/i.test(ourText),
    'the persona must forbid passing an empty read off as healthy')
})

console.log(`\n通过 ${passed}，失败 ${failed}`)
if (failed > 0) process.exit(1)
