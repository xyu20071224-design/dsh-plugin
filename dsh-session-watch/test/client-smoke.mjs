/**
 * Client-half smoke test.
 *
 * Runs the REAL `lib/client.js` bundle in Node against a React stub and a fake
 * `fetch`, exactly as the window-pin plugin's test does for its own client half.
 * This covers registration, both sidebar widths, the badge counting behaviour,
 * the panel toggle, and dispose — everything except whether the framework really
 * places the button in the sidebar and whether it looks right, which only a human
 * looking at the page can judge.
 *
 * Run: node test/client-smoke.mjs
 *
 * @module @local/dsh-session-watch/test/client-smoke
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'lib', 'client.js')

/**
 * Replace `setInterval` with a capturing stub for the duration of this test.
 *
 * The bundle starts a poll timer on mount, which would keep Node alive forever.
 * Capturing instead of running the timer also proves the effect registers one,
 * which is what makes the badge update without a page reload.
 * @type {Array<{fn: Function, ms: number}>}
 */
const intervals = []
const realSetInterval = globalThis.setInterval
globalThis.setInterval = (fn, ms) => {
  intervals.push({ fn, ms })
  return intervals.length
}
globalThis.clearInterval = () => {}

let passed = 0
let failed = 0

/**
 * Assert a condition.
 * @param {string} label - what is being verified.
 * @param {boolean} condition - the observed result.
 * @param {string} [extra] - detail printed on failure.
 * @returns {void}
 */
function check(label, condition, extra = '') {
  if (condition) { passed += 1; console.log(`  PASS  ${label}`) }
  else { failed += 1; console.log(`  FAIL  ${label}${extra === '' ? '' : ` — ${extra}`}`) }
}

/* ── React stub: enough surface for createElement + hooks + function components ── */
const hookState = []
let hookCursor = 0
const react = {
  createElement(type, props, ...children) {
    const element = { type, props: props ?? {}, children: children.flat().filter(c => c !== null && c !== undefined) }
    // Render function components eagerly, the way React does when it walks the
    // tree. Without this, a `createElement(StallPanel, null)` stays an inert
    // descriptor and the panel's contents are invisible to the test — which
    // would look like a bundle bug instead of a stub limitation.
    if (typeof type === 'function') return type({ ...element.props, children: element.children })
    return element
  },
  useSyncExternalStore(subscribe, getSnapshot) {
    void subscribe
    return getSnapshot()
  },
  useEffect() {},
  useState(initial) {
    const index = hookCursor
    hookCursor += 1
    if (hookState[index] === undefined) hookState[index] = typeof initial === 'function' ? initial() : initial
    return [hookState[index], () => {}]
  },
}

/* ── capture the bundle through the module loader ── */
let captured = null
globalThis.window = {
  __ModuleLoader__: {
    load(definition) { captured = definition },
  },
  addEventListener() {},
  removeEventListener() {},
}

const code = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- running the real bundle is the point.
new Function('window', 'require', `${code}\n`)(globalThis.window, name => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
})

check('bundle 已注册到 __ModuleLoader__', captured !== null)
check('bundle id 正确', captured?.id === '@local/dsh-session-watch')

const exports_ = captured.factory(name => {
  if (name === 'react') return react
  throw new Error(`unexpected require(${name})`)
})

check('导出了 apply', typeof exports_.apply === 'function')
check('注入 slots 与 locale', JSON.stringify(exports_.inject) === JSON.stringify(['slots', 'locale']))

/* ── fake host state driving the fetch responses ── */
let hostState = {
  ok: true,
  stallMs: 300000,
  resumeEnabled: true,
  resumePolicy: { maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000 },
  // Layer 3's externally visible state. "Installed" and "mounted" are different facts.
  expert: { mounted: true, tools: ['session_roster', 'session_review', 'session_resume'], mountedAt: Date.now(), staleFromPid: null },
  resumed: [{ sessionId: 'session-aaaa-bbbb', at: Date.now(), ok: true, error: null, code: null, turn: 2, step: 41 }],
  totals: { scanned: 10, stalled: 2, awaitingApproval: 1, empty: 0, subagent: 5, resumed: 1, resumeFailed: 0 },
  attention: [
    { sessionId: 'session-aaaa-bbbb', cwd: 'C:\\agent\\dsh\\plugin', lastType: 'tool/call', silentMs: 420000, turn: 2, step: 41,
      resume: { willResume: true, reason: 'resumed', detail: '首次自动恢复。', attempts: 0, lastAttemptAt: null, nextDelayMs: 120000 } },
    { sessionId: 'session-cccc-dddd', cwd: 'C:\\\\work\\\\example', lastType: 'step/start', silentMs: 360000, turn: 9, step: 10,
      resume: { willResume: false, reason: 'attempts-exhausted', detail: '已自动恢复 2 次（上限 2）；转为仅报告。', attempts: 2, lastAttemptAt: 1, nextDelayMs: 0,
        // The panel must attribute the last attempt: the watcher acting on its own
        // and the user-proxy expert acting for the user are different events.
        lastAttemptBy: 'user-proxy', lastAttemptOk: false, lastAttemptCode: 'session/model-unavailable',
        history: [{ at: 1, by: 'auto', ok: true, code: null }, { at: 2, by: 'user-proxy', ok: false, code: 'session/model-unavailable' }] },
      // Policy has stopped acting, so this row must carry a next step.
      handoff: { kind: 'attempts-exhausted', text: '已用满自动恢复次数。建议用用户代理专家读它的输入输出找根因（session_review），或手动续跑。' } },
  ],
}
let fetchCalls = []
globalThis.fetch = async (url, options = {}) => {
  fetchCalls.push({ url, method: options.method ?? 'GET', headers: options.headers ?? {} })
  return { ok: true, status: 200, json: async () => hostState }
}

/* ── fake Cordis client context ── */
const registered = []
const effects = []
let localeListener = null
const clientCtx = {
  locale: {
    getSnapshot: () => ({ active: 'zh' }),
    subscribe(listener) { localeListener = listener; return () => {} },
  },
  effect(setup, label) {
    effects.push(label)
    const produced = typeof setup === 'function' ? setup() : undefined
    return typeof produced === 'function' ? produced : () => {}
  },
  slots: {
    inject(name, factory) {
      check('注入的插槽是 sidebar.footer.action', name === 'sidebar.footer.action', `got ${name}`)
      const disposer = factory()
      return disposer
    },
    register(options, component) {
      registered.push({ options, component })
      return () => {}
    },
  },
}

exports_.apply(clientCtx)

check('注册了恰好一个插槽占用者', registered.length === 1, `got ${registered.length}`)
check('插槽 id 正确', registered[0]?.options?.id === 'session-watch')
check('label 是可解析函数', typeof registered[0]?.options?.label === 'function')
check('未使用不存在的 visible 选项', registered[0]?.options?.visible === undefined)
check('注册了 locale 与轮询 effect', effects.length === 2, effects.join(' | '))
check('轮询间隔为 20s', intervals.some(i => i.ms === 20000), JSON.stringify(intervals.map(i => i.ms)))

// Let the initial refresh settle.
await new Promise(resolve => setTimeout(resolve, 10))
check('启动后读取了 Host 状态', fetchCalls.some(c => c.url.endsWith('/state')))
check('每次请求都带守卫头', fetchCalls.every(c => c.headers['x-session-watch'] === '1'),
  JSON.stringify(fetchCalls.map(c => c.headers)))

/* ── render wide ── */
hookCursor = 0
const component = registered[0].component
const wideTree = component({ wide: true })
/**
 * Flatten a rendered tree into its text content.
 * @param {any} node - a rendered element.
 * @returns {string} concatenated text.
 */
function textOf(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  return (node.children ?? []).map(textOf).join('')
}
const wideText = textOf(wideTree)
check('宽栏显示停滞数量', wideText.includes('2'), wideText)
check('宽栏徽标为告警态', wideTree.children[0]?.props?.['data-stalled'] === '2')
/* ── render collapsed rail ── */
hookCursor = 0
const railTree = component({ wide: false })
const railButton = railTree.children[0]
check('导轨宽度为 32', railButton?.props?.style?.width === 32)
check('导轨仍显示数字角标', textOf(railTree).includes('2'), textOf(railTree))
check('面板默认收起', railTree.children.length === 1, `children=${railTree.children.length}`)

/* ── click opens the panel, listing both sessions ── */
hookCursor = 0
railButton.props.onClick()
await new Promise(resolve => setTimeout(resolve, 10))
hookCursor = 0
const openTree = component({ wide: true })
check('点击后面板出现', openTree.children.length === 2, `children=${openTree.children.length}`)
const openText = textOf(openTree)
check('面板列出两个会话',
  openText.includes('session-aaaa-bbbb'.slice(0, 18)) && openText.includes('session-cccc-dddd'.slice(0, 18)),
  openText)
check('面板显示目录末段', openText.includes('plugin') && openText.includes('example'), openText)
check('面板显示静默时长', openText.includes('7m'), openText) // 420000ms -> 7m
check('面板显示判定口径', openText.includes('5m'), openText) // stallMs 300000 -> 5m
check('面板显示自动恢复已启用', openText.includes('自动恢复：已启用'), openText)
check('面板显示上限次数', openText.includes('上限 2'), openText)
check('面板列出本轮恢复', openText.includes('本轮恢复'), openText)
check('面板解释为何不恢复', openText.includes('已自动恢复 2 次'), openText)
check('面板区分将恢复与不恢复', openText.includes('将恢复') && openText.includes('不恢复'), openText)
// REGRESSION: "resumed twice" without attribution hides whether the watcher acted on
// its own or the expert acted for the user. The panel must name the author.
check('面板标出上一次由谁发起', openText.includes('上一次由'), openText)
check('面板区分专家与自动', openText.includes('专家') && openText.includes('失败'), openText)
check('面板显示失败原因码', openText.includes('session/model-unavailable'), openText)

// All THREE authors must be distinguishable. A two-way "auto or expert" split reported a
// manual nudge as the expert's work — the same misattribution the nudge text itself was
// fixed for — and the panel is exactly where the user checks who touched their session.
{
  /**
   * Swap in a fixture, then return the rendered panel text.
   *
   * The badge click both toggles visibility AND re-reads the Host, so getting the panel open
   * AND freshly loaded takes care. `openPanel` already guarantees that (it reads the current
   * render instead of assuming), so it is reused here rather than re-derived — the earlier
   * attempt at hand-rolling the toggle silently rendered the badge alone.
   * @param {string} by - the `lastAttemptBy` value to install.
   * @returns {Promise<string>} the panel text.
   */
  const panelTextFor = async by => {
    hostState = {
      ...hostState,
      attention: [{
        sessionId: 'session-author', cwd: 'C:\\agent\\dsh\\plugin', lastType: 'tool/call',
        silentMs: 420000, turn: 2, step: 41,
        resume: {
          willResume: false, reason: 'attempts-exhausted', detail: 'd', attempts: 1, nextDelayMs: 0,
          lastAttemptBy: by, lastAttemptOk: true, lastAttemptCode: null,
        },
      }],
    }
    return textOf(await openPanel())
  }

  /** @param {string} by @returns {Promise<string>} the rendered author label. */
  const labelWith = async by => {
    const text = await panelTextFor(by)
    const line = text.split('\n').find(entry => entry.includes('上一次由')) ?? text
    const match = /上一次由：([^，]+)/.exec(line)
    return match === null ? `(未找到) ${line.slice(0, 60)}` : match[1]
  }

  const auto = await labelWith('auto')
  const manual = await labelWith('manual')
  const expert = await labelWith('user-proxy')
  check('面板把自动标为"自动"', auto === '自动', auto)
  check('面板把手动标为"你本人"（不是"专家"）', manual === '你本人', manual)
  check('面板把专家标为"专家"', expert.startsWith('专家'), expert)
  check('三种作者互不相同', new Set([auto, manual, expert]).size === 3, `${auto} / ${manual} / ${expert}`)
}
// FORWARD COMPATIBILITY: the first fixture has NO attribution fields at all, and it
// still renders above. That matters because the page can be refreshed (new client
// bundle) while the Host still serves the older snapshot shape — the panel must
// degrade to "no attribution line", never crash or print "undefined".
check('缺少作者字段时不渲染该行也不打印 undefined',
  !openText.includes('undefined') && !openText.includes('null'),
  openText)
// Layer 3's only externally visible state, and the fact the user cannot otherwise see:
// a preset can be installed and composed while its composition failed to activate.
check('面板显示专家已挂载', openText.includes('用户代理专家：已挂载'), openText)
check('面板列出专家工具', openText.includes('session_roster'), openText)
// The layer 2->3 handoff must reach the surface the user actually looks at. A next step
// that only appears in `/watch` would be invisible to someone who works from the sidebar.
// The first fixture carries a `handoff`; the second deliberately does not, so this pair
// also proves the line is conditional rather than always-present.
check('面板显示策略停手后的下一步', openText.includes('下一步：'), openText)
check('下一步指向专家', /下一步：.*专家/.test(openText), openText)

/* ── the un-mounted state must say so, and say what to do ── */
// This is the state the deployment is in until dsh is restarted, so it is the one the
// user is most likely to see. Saying nothing would leave them wondering whether layer 3
// exists at all.
//
// The badge click TOGGLES `open`, so the panel must be closed first — clicking while it
// is already open collapses it and renders the badge alone.
hostState = { ...hostState, expert: { mounted: false, tools: [], mountedAt: null, staleFromPid: 999 } }
hookCursor = 0
const closerTree = component({ wide: true })
closerTree.children[0].props.onClick()            // open -> closed
await new Promise(resolve => setTimeout(resolve, 10))
hookCursor = 0
const openerTree = component({ wide: true })
openerTree.children[0].props.onClick()            // closed -> open, with the new state
await new Promise(resolve => setTimeout(resolve, 10))
hookCursor = 0
const unmountedTree = component({ wide: true })
const unmountedText = textOf(unmountedTree)
check('专家未挂载时面板明确说明', unmountedText.includes('用户代理专家：未挂载'), unmountedText)
check('专家未挂载时给出处置办法', unmountedText.includes('需重启 dsh 才会加载'), unmountedText)
check('专家未挂载时不列出工具名', !unmountedText.includes('session_roster'), unmountedText)
// Restore for the remaining cases.
hostState = { ...hostState, expert: { mounted: true, tools: ['session_roster', 'session_review', 'session_resume'], mountedAt: Date.now(), staleFromPid: null } }

// The badge click TOGGLES `open`, and by this point in the suite earlier cases have left
// the panel in a position that is easy to get wrong — a mismatched assumption renders the
// badge alone and makes a real assertion fail for a bogus reason (which is what happened
// the first two times this test was written).
//
// So the state is READ from the render rather than tracked in a variable: the component
// returns `[badge]` when collapsed and `[badge, panel]` when expanded. That is
// self-correcting, and it also means the test cannot drift from the component's actual
// behaviour.
/**
 * Ensure the panel is OPEN and freshly loaded from the current fixture.
 *
 * The badge click does two things at once — `patch({ open: !open })` and `refresh()` — so
 * a click both toggles visibility AND re-reads the Host. That coupling matters here: when
 * the panel is already open, clicking it would CLOSE it, so a helper that only clicks when
 * collapsed leaves the store holding whatever fixture was current at the last click. This
 * test was briefly fooled by exactly that, reading a stale `attention` list and asserting
 * against the wrong session.
 *
 * So the fresh read is guaranteed explicitly: close, then open. Two clicks always leave it
 * open AND always end with a fetch of the current `hostState`.
 *
 * @returns {Promise<any>} the rendered tree with the panel visible and current.
 */
async function openPanel() {
  // Collapse first (a no-op visually if already collapsed), then expand. The final click
  // is what performs the refresh.
  hookCursor = 0
  let tree = component({ wide: true })
  if (tree.children.length > 1) {
    tree.children[0].props.onClick()
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  hookCursor = 0
  tree = component({ wide: true })
  tree.children[0].props.onClick()
  await new Promise(resolve => setTimeout(resolve, 10))
  hookCursor = 0
  return component({ wide: true })
}

/**
 * Ensure the panel is CLOSED, driving the toggle only if needed.
 * @returns {Promise<any>} the rendered tree (badge only).
 */
async function closePanel() {
  hookCursor = 0
  let tree = component({ wide: true })
  if (tree.children.length > 1) {
    tree.children[0].props.onClick()
    await new Promise(resolve => setTimeout(resolve, 10))
    hookCursor = 0
    tree = component({ wide: true })
  }
  return tree
}

/* ── an OLD host must not break the NEW page ── */
// The client bundle is served from disk at page load, while the Host's module is cached
// per process. So refreshing the page gives a NEW client talking to an OLD host — the
// exact combination a user hits between installing this version and restarting. The old
// host sends none of `expert`, `handoff` or `lastAttemptBy`, and the panel must degrade
// to its honest "not mounted" state rather than crashing or printing `undefined`.
hostState = {
  ok: true,
  stallMs: 300000,
  resumeEnabled: true,
  resumePolicy: { maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000 },
  // deliberately NO `expert`
  resumed: [],
  totals: { scanned: 10, stalled: 1, awaitingApproval: 0, empty: 0, subagent: 5, resumed: 0, resumeFailed: 0 },
  attention: [{
    sessionId: 'session-old-host', cwd: 'C:\\agent\\dsh\\plugin', lastType: 'tool/call',
    silentMs: 420000, turn: 2, step: 41,
    // deliberately no `lastAttemptBy`, no `handoff`
    resume: { willResume: true, reason: 'resumed', detail: '首次自动恢复。', attempts: 0, lastAttemptAt: null, nextDelayMs: 120000 },
  }],
}
const oldHostTree = await openPanel()
const oldHostText = textOf(oldHostTree)
check('旧 Host + 新页面：不崩溃', oldHostTree.children.length > 0, `children=${oldHostTree.children.length}`)
check('旧 Host 缺少 expert 字段时显示未挂载',
  oldHostText.includes('用户代理专家：未挂载'), oldHostText)
check('旧 Host 不产生 undefined 字样',
  !oldHostText.includes('undefined'), oldHostText)
check('旧 Host 缺少 handoff 时不渲染下一步',
  !oldHostText.includes('下一步：'), oldHostText)

// Restore the modern fixture for the remaining cases.
hostState = {
  ok: true,
  stallMs: 300000,
  resumeEnabled: true,
  resumePolicy: { maxAttempts: 2, baseDelayMs: 120000, maxDelayMs: 1800000, cooldownMs: 300000 },
  resumed: [],
  totals: { scanned: 10, stalled: 1, awaitingApproval: 0, empty: 0, subagent: 5, resumed: 0, resumeFailed: 0 },
  attention: [{
    sessionId: 'session-modern', cwd: 'C:\\agent\\dsh\\plugin', lastType: 'tool/call',
    silentMs: 420000, turn: 2, step: 41,
    resume: { willResume: true, reason: 'resumed', detail: '首次自动恢复。', attempts: 0, lastAttemptAt: null, nextDelayMs: 120000, lastAttemptBy: null },
  }],
  expert: { mounted: true, tools: ['session_roster', 'session_review', 'session_resume'], mountedAt: Date.now(), staleFromPid: null },
}

/* ── zero-stall state must render neutral, not alarming ── */
hostState = { ...hostState, attention: [], totals: { ...hostState.totals, stalled: 0 } }
// Collapse the panel so the badge-only state can be checked.
const cleanTree = await closePanel()
check('无停摆时角标归零', cleanTree.children[0]?.props?.['data-stalled'] === '0',
  String(cleanTree.children[0]?.props?.['data-stalled']))
check('无停摆时收起面板', cleanTree.children.length === 1, `children=${cleanTree.children.length}`)
check('无停摆时不显示告警文案', !textOf(cleanTree).includes('个会话静默停摆'), textOf(cleanTree))

/* ── a broken read must not masquerade as "all clear" ── */
globalThis.fetch = async () => { throw new Error('connect ECONNREFUSED') }
// Trigger a read through the badge, then let the rejection settle before
// rendering: the store only learns about the failure once the promise rejects.
hookCursor = 0
const beforeFailTree = component({ wide: true })
beforeFailTree.children[0].props.onClick()
await new Promise(resolve => setTimeout(resolve, 10))
hookCursor = 0
const brokenTree = component({ wide: true })
const brokenProps = brokenTree.children[0]?.props ?? {}
check('读取失败时标题暴露错误',
  String(brokenProps.title ?? '').includes('ECONNREFUSED'),
  String(brokenProps.title))
check('读取失败时角标不再是"一切正常"的零计数表述',
  !String(brokenProps.title ?? '').includes('没有静默停摆的会话'),
  String(brokenProps.title))

/* ── the panel must stay current WITHOUT a click ── */
// An open panel that only updated on click would freeze a picture of a Host that is still
// scanning every 30s — so the badge would under-report stalls while the user is looking
// straight at it. The bundle registers an interval plus a focus listener; this asserts
// both exist, that the interval is usefully short, and that it is torn down cleanly.
{
  const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
  const pollMatch = /const POLL_MS = (\d+)/.exec(source)
  check('客户端自带轮询（不是只在点击时读）', pollMatch !== null, String(pollMatch))
  if (pollMatch !== null) {
    const pollMs = Number(pollMatch[1])
    check('轮询间隔 ≤ 30s（与 Host 的扫描节奏相当）', pollMs <= 30_000, `${pollMs}ms`)
  }
  check('窗口重新聚焦时也会刷新', /addEventListener\("focus"/.test(source))
  check('轮询在清理时被取消（不会泄漏）', /clearInterval\(timer\)/.test(source))
}

console.log(`\n通过 ${passed}，失败 ${failed}`)
process.exit(failed === 0 ? 0 : 1)
