/**
 * Transcript reading for the user-proxy expert (`dsh-session-watch/proxy`).
 *
 * WHY THIS IS A SEPARATE MODULE FROM `./logs.js`
 *
 * `logs.js` reads raw log FILES off disk. That is the right seam for detection —
 * it is fast, it needs only a bounded tail, and it works for a session whose
 * process is long gone. It is the WRONG seam for answering "what actually
 * happened in this conversation", for two reasons:
 *
 *   1. A raw event log is enormous (a single turn can be thousands of events) and
 *      most of it is machine bookkeeping. An expert asked to explain a failure
 *      needs the CONVERSATION — what the user asked, what the model answered, what
 *      tools ran — not the stream chunks that produced it.
 *   2. The live-preferred view is authoritative. `ctx.sessionQuery` reconciles a
 *      live session against its persisted log; reading files directly can miss
 *      events that are in memory but not yet flushed.
 *
 * So this module turns raw events into a bounded, human-readable transcript. The
 * expert reads THAT, which is also what keeps its context small enough to be
 * useful.
 *
 * It performs no I/O of its own and calls no model, so every shaping rule below is
 * testable offline against real logs.
 *
 * @module dsh-session-watch/transcript
 */

/** Default number of transcript entries returned. */
const DEFAULT_LIMIT = 60
/** Hard ceiling, so one call cannot return an unbounded transcript. */
const MAX_LIMIT = 400
/** Characters retained per entry before truncation. */
const ENTRY_CHARS = 1200
/** Characters retained for a tool result. */
const TOOL_CHARS = 600

/**
 * Render one content block as plain text.
 *
 * Content blocks are a union; unknown kinds are rendered by name rather than
 * dropped, because "there was an image here" is itself a fact the expert needs.
 * @param {any} block - one content block.
 * @returns {string} its text form.
 */
function blockText(block) {
  if (block === null || typeof block !== 'object') return ''
  switch (block.type) {
    case 'text':
      return typeof block.text === 'string' ? block.text : ''
    case 'reasoning':
      return ''
    case 'tool-call':
      return `[调用工具 ${block.name ?? '?'}]`
    case 'image':
      return '[图片]'
    case 'file':
      return `[文件 ${block.attachment?.name ?? '?'}]`
    default:
      return typeof block.type === 'string' ? `[${block.type}]` : ''
  }
}

/**
 * Join a message's content blocks into one line of text.
 * @param {any} message - a message carrying `content`.
 * @returns {string} the message text, trimmed.
 */
function messageText(message) {
  const content = Array.isArray(message?.content) ? message.content : []
  return content.map(blockText).filter(part => part !== '').join('\n').trim()
}

/**
 * Truncate long text while saying so, so the expert never mistakes a cut for an
 * ending. A silently truncated transcript would make the expert reason about a
 * conversation that appears to stop mid-sentence.
 * @param {string} text - the text to bound.
 * @param {number} max - maximum characters retained.
 * @returns {string} the bounded text.
 */
function clip(text, max) {
  if (typeof text !== 'string') return ''
  if (text.length <= max) return text
  return `${text.slice(0, max)}\n…（已截断，原文 ${text.length} 字符）`
}

/**
 * Summarize one event into a transcript entry, or null when it is not
 * conversation.
 *
 * The filter is deliberate and narrow. Machine bookkeeping (`step/start`,
 * `request/header`, `assistant/attempt`, stream deltas) is EXCLUDED: it is the
 * noise that makes a raw log unreadable, and its absence is what makes the
 * transcript fit in a context window. Everything that carries human or model
 * intent is INCLUDED.
 *
 * @param {any} event - one session event.
 * @returns {{seq: number, time: number, role: string, type: string, text: string} | null}
 *   the entry, or null when the event carries no conversation.
 */
export function transcribeEvent(event) {
  if (event === null || typeof event !== 'object') return null
  const type = event.type
  const data = event.data ?? {}
  const base = {
    seq: typeof event.seq === 'number' ? event.seq : -1,
    time: typeof event.time === 'number' ? event.time : 0,
  }

  switch (type) {
    case 'user/message':
      return { ...base, role: 'user', type, text: clip(messageText(data), ENTRY_CHARS) }

    case 'assistant/message':
      return { ...base, role: 'assistant', type, text: clip(messageText(data.message), ENTRY_CHARS) }

    case 'developer/message':
      return { ...base, role: 'developer', type, text: clip(messageText(data.message), ENTRY_CHARS) }

    case 'system/message':
      return { ...base, role: 'system', type, text: clip(messageText(data.message), ENTRY_CHARS) }

    case 'tool/call': {
      // The arguments are the model's intent; keep them, but bounded. A tool call
      // whose arguments are hidden is exactly the case an expert cannot diagnose.
      const name = typeof data.name === 'string' ? data.name : '?'
      const args = typeof data.arguments === 'string' ? data.arguments : ''
      return {
        ...base,
        role: 'tool-call',
        type,
        text: clip(`${name}(${args})`, ENTRY_CHARS),
        turn: data.turn,
        step: data.step,
      }
    }

    case 'tool/result': {
      const text = clip(messageText(data.message), TOOL_CHARS)
      const failed = data.message?.isError === true || data.error !== undefined
      const code = typeof data.error?.code === 'string' ? ` ${data.error.code}` : ''
      return {
        ...base,
        role: 'tool-result',
        type,
        text: failed ? `[失败${code}] ${text}` : text,
        isError: failed,
        turn: data.turn,
        step: data.step,
      }
    }

    case 'turn/start':
      return { ...base, role: 'structure', type, text: `轮次 ${data.turn} 开始`, turn: data.turn }

    case 'turn/end': {
      const kind = typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown'
      const cause = data.reason?.reason?.kind
      return {
        ...base,
        role: 'structure',
        type,
        text: `轮次 ${data.turn} 结束（reason=${kind}${typeof cause === 'string' ? `/${cause}` : ''}）`,
        turn: data.turn,
        endKind: kind,
      }
    }

    // A retry is the single most useful non-conversation event: it explains a long
    // silence without any error ever being recorded, which is this deployment's
    // entire failure mode.
    case 'llm/retry':
      return {
        ...base,
        role: 'retry',
        type,
        text: `模型调用重试${typeof data.code === 'string' ? `（${data.code}）` : ''}${
          typeof data.status === 'number' ? ` status=${data.status}` : ''}`,
      }

    case 'error':
    case 'agent/error':
      return {
        ...base,
        role: 'error',
        type,
        text: clip(
          typeof data.error?.message === 'string'
            ? data.error.message
            : JSON.stringify(data).slice(0, ENTRY_CHARS),
          ENTRY_CHARS,
        ),
        isError: true,
      }

    case 'session/title':
      return {
        ...base,
        role: 'title',
        type,
        text: typeof data.title === 'string' ? data.title : '',
      }

    default:
      return null
  }
}

/**
 * Turn a raw event list into a bounded transcript.
 *
 * @param {readonly any[]} events - the session's events, oldest first.
 * @param {object} [options] - shaping options.
 * @param {number} [options.limit] - max entries returned, from the tail.
 * @param {number} [options.fromSeq] - include only events at or after this seq.
 * @returns {{entries: object[], total: number, omitted: number, toolErrors: number}}
 *   the transcript and what was left out.
 */
export function buildTranscript(events, options = {}) {
  const list = Array.isArray(events) ? events : []
  const requested = Number.isFinite(options.limit) ? options.limit : DEFAULT_LIMIT
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.trunc(requested)))
  const fromSeq = Number.isFinite(options.fromSeq) ? options.fromSeq : null

  const selected = fromSeq === null ? list : list.filter(event => (event?.seq ?? -1) >= fromSeq)

  /** @type {object[]} */
  const all = []
  for (const event of selected) {
    const entry = transcribeEvent(event)
    if (entry !== null) all.push(entry)
  }

  // Keep the TAIL: the end of a conversation is where a failure is visible, and
  // the beginning is what a reader can most afford to lose.
  const entries = all.length > limit ? all.slice(-limit) : all

  return {
    entries,
    total: all.length,
    omitted: all.length - entries.length,
    toolErrors: all.filter(entry => entry.isError === true).length,
  }
}

/**
 * Fold a transcript into a short timeline of only the events that explain a stop.
 *
 * The expert is asked "why did this session stop", and the answer is almost always
 * one of a handful of shapes. Surfacing them directly means the expert does not
 * have to rediscover the same pattern on every call — and, more importantly, the
 * OBSERVATION stays deterministic while the interpretation stays the model's.
 *
 * @param {readonly any[]} events - the session's events, oldest first.
 * @returns {{lastTurn: number|null, lastStep: number|null, endKind: string|null,
 *   openTurn: boolean, retries: number, toolFailures: object[], lastActivity: number}}
 *   deterministic facts about how the session ended.
 */
export function summarizeStop(events) {
  const list = Array.isArray(events) ? events : []
  let lastTurn = null
  let lastStep = null
  let endKind = null
  let openTurn = false
  let retries = 0
  let lastActivity = 0
  /** @type {Map<number, string>} */
  const turnEnds = new Map()
  /** @type {object[]} */
  const toolFailures = []

  for (const event of list) {
    const type = event?.type
    const data = event?.data ?? {}
    if (typeof event?.time === 'number') lastActivity = Math.max(lastActivity, event.time)
    if (typeof data.turn === 'number') lastTurn = data.turn
    if (typeof data.step === 'number') lastStep = data.step

    if (type === 'turn/end' && typeof data.turn === 'number') {
      turnEnds.set(data.turn, typeof data.reason?.kind === 'string' ? data.reason.kind : 'unknown')
    }
    if (type === 'llm/retry') retries += 1
    if (type === 'tool/result' && (data.message?.isError === true || data.error !== undefined)) {
      toolFailures.push({
        seq: event.seq,
        turn: data.turn,
        step: data.step,
        name: typeof data.error?.name === 'string' ? data.error.name : null,
        code: typeof data.error?.code === 'string' ? data.error.code : null,
      })
    }
  }

  // Turn-scoped, not log-wide: an older `turn/end` must never describe the turn
  // that is still open. This is the same distinction the detector had to learn.
  if (lastTurn !== null) {
    openTurn = !turnEnds.has(lastTurn)
    endKind = turnEnds.get(lastTurn) ?? null
  }

  return {
    lastTurn,
    lastStep,
    endKind,
    openTurn,
    retries,
    toolFailures: toolFailures.slice(-5),
    lastActivity,
  }
}
