/**
 * Scenario child: drive the REAL /restart handler with every spawn intercepted.
 *
 * Run as:  node --import ./preload.mjs handler-spawn.mjs
 *
 * The preload patches `node:child_process` BEFORE this module (and therefore before
 * index.js) is evaluated, and redirects every spawn to an armed fake. Nothing real is
 * started; an unarmed spawn throws.
 *
 * Emits one JSON document on stdout.
 */
import { EventEmitter } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TEST_DIR = dirname(dirname(fileURLToPath(import.meta.url)))   // test/scenarios -> test
const PKG_DIR = dirname(TEST_DIR)
const INDEX_JS = join(PKG_DIR, 'index.js')
const APP_EXE = 'C:\\agent\\dsh_desktop\\DeepSeek Harness.exe'
const ASAR = 'C:\\agent\\dsh_desktop\\resources\\app.asar'

const out = { ok: false, errors: [], a5: [], a7: null, spawns: [], blocked: [] }

class FakeChild extends EventEmitter {
  constructor(pid) {
    super()
    this.pid = pid
    this.stdout = new EventEmitter()
    this.stdout.setEncoding = () => {}
    this.stderr = new EventEmitter()
    this.stderr.setEncoding = () => {}
    this.on('error', () => {})   // an unhandled 'error' emit would kill the process
  }
  kill() { return true }
  emitOut(text) { this.stdout.emit('data', text) }
}

/** Extract app.asar so the REAL cordis + commands modules can be imported. */
function extractAsar() {
  const root = join(tmpdir(), 'dsh-restart-verify-asar')
  const dsh = join(root, 'dsh')
  if (existsSync(join(dsh, 'node_modules'))) return dsh
  mkdirSync(root, { recursive: true })
  const buffer = readFileSync(ASAR)
  const headerSize = buffer.readUInt32LE(12)
  const header = JSON.parse(buffer.subarray(16, 16 + headerSize).toString('utf8'))
  const dataStart = 16 + headerSize
  const walk = (node, prefix) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const p = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files !== undefined) { mkdirSync(join(root, p), { recursive: true }); walk(entry, p); continue }
      const s = dataStart + Number(entry.offset)
      writeFileSync(join(root, p), buffer.subarray(s, s + Number(entry.size)))
    }
  }
  walk(header, '')
  return dsh
}

try {
  // The plugin is imported HERE, after the preload has already patched spawn.
  const plugin = await import(pathToFileURL(INDEX_JS).href)

  const dsh = extractAsar()
  const load = p => import(pathToFileURL(p).href)
  const { Context } = await load(join(dsh, 'node_modules/@deepseek-ai/cordis/lib/index.js'))
  const commandsMod = await load(join(dsh, 'node_modules/@deepseek-ai/dsh-commands/lib/index.js'))

  const ctx = new Context()
  await ctx.plugin(commandsMod.default)
  plugin.apply(ctx, {})
  const handler = ctx.commands.find({}, 'restart')?.handler
  if (typeof handler !== 'function') throw new Error('handler not registered')

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-restart-scenario-'))

  /**
   * Drive one handler call with all spawns faked.
   * @param {string} rawInput
   * @param {{ terminal?: object | null }} options
   */
  async function drive(rawInput, options = {}) {
    const seen = []
    let restartChild = null
    let resultPath = null
    globalThis.__VR_SPAWNS__.length = 0

    globalThis.__VR_FAKE__ = (command, argv) => {
      const isRestart = argv.includes('-File')
      const child = new FakeChild(isRestart ? 7001 : 7002)
      seen.push({ command, argv, isRestart })
      if (isRestart) {
        restartChild = child
        resultPath = argv[argv.indexOf('-ResultPath') + 1] ?? null
        queueMicrotask(() => {
          child.emitOut('{"status":"launched","code":0,"detail":"handoff stub from fake launcher"}')
          child.emit('close', 0)
        })
      } else {
        // The one-off `Get-Process -Id <ppid>` query.
        queueMicrotask(() => { child.emitOut(APP_EXE + '\n'); child.emit('close', 0) })
      }
      return child
    }

    const promise = handler({ rawInput, agent: {}, attachments: [], signal: new AbortController().signal })

    // Wait for the restart spawn so the harness can act as the escaped worker.
    const deadline = Date.now() + 8000
    while (restartChild === null && Date.now() < deadline) await new Promise(r => setTimeout(r, 15))

    let terminalWritten = false
    if (restartChild !== null && resultPath !== null && options.terminal) {
      rmSync(resultPath, { force: true })
      writeFileSync(resultPath, JSON.stringify(options.terminal), 'utf8')
      terminalWritten = true
    }

    const result = await promise
    globalThis.__VR_FAKE__ = null
    return { result, seen, resultPath, terminalWritten }
  }

  // ---- A5: argument rejection (and the whitespace case, safely faked) ------
  for (const rawInput of ['--force', 'x', ' -h ', '   ']) {
    const { result, seen } = await drive(rawInput, { terminal: { status: 'quit-only', detail: 'scenario', code: 0 } })
    out.a5.push({
      rawInput,
      kind: result.kind,
      text: result.text,
      spawns: seen.length,
      spawnDetail: seen.map(s => ({ isRestart: s.isRestart, argv: s.argv })),
    })
  }

  // ---- A7: contract argv + -ResultPath round trip -------------------------
  {
    const { result, seen, resultPath, terminalWritten } = await drive('', {
      terminal: { status: 'quit-timeout', detail: 'scenario-simulated terminal status', code: 3 },
    })
    const restart = seen.find(s => s.isRestart)
    out.a7 = {
      spawnedRestart: restart !== undefined,
      argv: restart?.argv ?? null,
      resultPath,
      terminalWritten,
      hasDryRun: (restart?.argv ?? []).includes('-DryRun'),
      result: { kind: result.kind, text: result.text },
      allSpawns: seen.map(s => s.argv),
    }
  }

  out.spawns = globalThis.__VR_SPAWNS__.length
  out.refused = globalThis.__VR_REFUSED__
  out.notedNonDryRun = globalThis.__VR_NOTED_NONDRYRUN__
  // "ok" means the safety guard had to refuse nothing: every spawn the plugin attempted
  // was served by the armed fake, so no real process was ever created.
  out.ok = out.refused.length === 0 && out.errors.length === 0
  out.guardRefusedNothing = out.refused.length === 0
  out.fakeExplainsNonDryRun = out.notedNonDryRun.length > 0
} catch (error) {
  out.errors.push(String(error?.stack ?? error))
}

process.stdout.write(JSON.stringify(out))
