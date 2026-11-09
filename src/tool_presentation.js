'use strict';

/**
 * Readable downstream cards for three OMP tools whose raw payloads are
 * unreadable in T3: `todo` (a DSL document in, a rich snapshot out), `ask`
 * (question structures) and `ctx` (recall views).
 *
 * Scope is deliberately narrow:
 * - Only `tool_execution_start` / `tool_execution_update` /
 *   `tool_execution_end` are rewritten, plus the `ask` extension RPC marker
 *   described below. Every other frame crosses byte-identically.
 * - Only `todo`, `ask` and `ctx` change their card title. T3 0.1.7 reads an
 *   ordinary dynamic tool's title from `toolName` alone, so the alias lives
 *   there; `args.tool` keeps the real name in the persisted start frame.
 *   Upstream arguments, model history and `toolCallId` stay untouched.
 * - A result with `isError: true`, an unknown tool payload or a snapshot that
 *   does not match the todo-more shape is returned unmodified.
 *
 * `ask` has no wire field for clean question text, so the ask implementation
 * packs `{title, message}` behind a marker in `title`. The marker is only
 * produced when the consumer declares OMPT3_RPC_PRESENTATION=ask-v1 (set by
 * proxy.js); this module unpacks it and never leaks the blob to the UI.
 */

const ASK_PREFIX = 'omp-t3:ask:v1\n';
const ASK_FALLBACK_TITLE = 'Ask';
/** pi's newline-delimited RPC frame ceiling, including the newline (pi-coding-agent rpc-frame.ts). */
const ASK_MAX_TITLE_BYTES = 1024 * 1024;
const ASK_UNDECODABLE_MESSAGE = 'This question could not be decoded: its text was malformed. Cancel this dialog and ask the model to try again.';
const ASK_OVERSIZED_MESSAGE = 'This question could not be decoded: its text exceeded the 1 MiB RPC frame limit. Cancel this dialog and ask the model in smaller parts.';
const ALIAS_TOOLS = new Set(['todo', 'ask', 'ctx']);
const ALIAS_LIMIT = 60;
const CURRENT_LIMIT = 32;
const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'blocked']);
const STATUS_GLYPHS = {
  completed: '✓',
  in_progress: '◉',
  pending: '○',
  blocked: '⊘',
  abandoned: '✕'
};

/** One line, trimmed, with a hard ceiling for card titles. */
function truncate(text, limit = ALIAS_LIMIT) {
  const oneLine = String(text).replace(/\s+/g, ' ').trim();
  return oneLine.length > limit ? `${oneLine.slice(0, limit - 1)}…` : oneLine;
}

/** Parses one JSON frame; malformed lines and non-objects are not ours. */
function parseFrame(line) {
  try {
    const frame = JSON.parse(line);
    return frame !== null && typeof frame === 'object' && !Array.isArray(frame) ? frame : null;
  } catch {
    return null;
  }
}

/** The persisted todo-more snapshot, or null when the shape is not one we can render. */
function validSnapshot(snapshot) {
  if (snapshot === null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return false;
  const { goal, phases } = snapshot;
  if (goal !== null) {
    if (goal === undefined || typeof goal !== 'object') return false;
    for (const key of ['objective', 'measure', 'doneWhen']) {
      if (typeof goal[key] !== 'string') return false;
    }
  }
  if (!Array.isArray(phases)) return false;
  for (const phase of phases) {
    if (phase === null || typeof phase !== 'object' || typeof phase.name !== 'string') return false;
    if (!Array.isArray(phase.items)) return false;
    for (const item of phase.items) {
      if (item === null || typeof item !== 'object' || typeof item.title !== 'string') return false;
      if (!TODO_STATUSES.has(item.status)) return false;
    }
  }
  return true;
}

/** Progress over the whole list: closed is completed + abandoned, never merged. */
function countsOf(snapshot) {
  const counts = { completed: 0, abandoned: 0, in_progress: 0, pending: 0, blocked: 0 };
  let total = 0;
  let current = null;
  for (const phase of snapshot.phases) {
    for (const item of phase.items) {
      total += 1;
      counts[item.status] += 1;
      if (current === null && item.status === 'in_progress') current = item.title;
    }
  }
  return { counts, total, closed: counts.completed + counts.abandoned, current };
}

/** One item line: status glyph, title, then budget, blocker and commit with its scope. */
function itemLine(item) {
  const extras = [];
  if (item.time !== null && typeof item.time === 'object' && item.time.kind === 'estimated') {
    const elapsed = item.time.elapsedMs > 0 ? `, ${(item.time.elapsedMs / 60000).toFixed(1)} min elapsed` : '';
    extras.push(`${item.time.minutes} min budget${elapsed}`);
  }
  if (typeof item.blocker === 'string' && item.blocker !== '') extras.push(`blocked: ${item.blocker}`);
  if (item.commit !== null && typeof item.commit === 'object' && typeof item.commit.sha === 'string' && item.commit.sha !== '') {
    const message = typeof item.commit.message === 'string' ? ` ${JSON.stringify(item.commit.message)}` : '';
    const scope = item.commit.scope;
    const where = scope !== null && typeof scope === 'object' && scope.kind === 'paths' && Array.isArray(scope.files)
      ? ` (${scope.files.join(' ')})`
      : ' (all changes)';
    extras.push(`${item.commit.sha.slice(0, 7)}${message}${where}`);
  }
  return `  ${STATUS_GLYPHS[item.status]} ${item.title}${extras.length > 0 ? ` — ${extras.join('; ')}` : ''}`;
}

/** The whole todo card body, grouped by phase, with the result's own commit/git notes. */
function todoText(snapshot, notes) {
  const { counts, total, closed } = countsOf(snapshot);
  const lines = [];
  if (snapshot.goal === null) {
    lines.push('Goal: (missing)');
  } else {
    lines.push(`Objective: ${snapshot.goal.objective}`);
    lines.push(`Measure: ${snapshot.goal.measure}`);
    lines.push(`Done when: ${snapshot.goal.doneWhen}`);
  }
  const parts = [];
  for (const status of ['completed', 'abandoned', 'in_progress', 'blocked', 'pending']) {
    if (counts[status] > 0) parts.push(`${counts[status]} ${status.replace('_', ' ')}`);
  }
  lines.push(`Progress: ${closed}/${total} closed${parts.length > 0 ? ` · ${parts.join(' · ')}` : ''}`);
  const phases = snapshot.phases.filter((phase) => phase.items.length > 0);
  if (phases.length === 0) {
    lines.push('The list is empty.');
  }
  for (const phase of phases) {
    lines.push(phase.name);
    for (const item of phase.items) {
      lines.push(itemLine(item));
      if (typeof item.explanation === 'string' && item.explanation !== '') {
        for (const line of item.explanation.split('\n')) lines.push(`    ${line}`);
      }
    }
  }
  lines.push(...notes);
  return lines.join('\n');
}

/** The result text's own trailing notes (committed, inert, Shared worktree); the summary itself is rebuilt. */
function todoNotes(payload) {
  const block = Array.isArray(payload.content)
    ? payload.content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string')
    : null;
  if (block === undefined) return [];
  const summaryLine = /^(?:Errors:|Goal:|Remaining items|Overall:|Active phase|Items without an explanation|Todo list is empty\.|Todo list cleared\.)/;
  const lines = block.text.split('\n');
  let boundary = -1;
  for (const [index, line] of lines.entries()) {
    if (/^\s/.test(line) || summaryLine.test(line)) boundary = index;
  }
  if (boundary === -1) return [];
  return lines.slice(boundary + 1).filter((line) => line.trim() !== '');
}

/** The card title for a todo result: closed/total plus the running item. */
function todoAlias(payload) {
  const snapshot = payload !== null && typeof payload === 'object' && payload.details !== null && typeof payload.details === 'object'
    ? payload.details.more
    : null;
  if (!validSnapshot(snapshot)) return null;
  const { closed, total, current } = countsOf(snapshot);
  return `Todo · [${closed}/${total}]${current === null ? '' : ` ${truncate(current, CURRENT_LIMIT)}`}`;
}

/** The model-visible answer text per question id from the result content. */
function askAnswers(payload) {
  const answers = new Map();
  const block = Array.isArray(payload.content)
    ? payload.content.find((entry) => entry !== null && typeof entry === 'object' && entry.type === 'text' && typeof entry.text === 'string')
    : null;
  if (block === undefined) return answers;
  for (const line of block.text.split('\n').slice(1)) {
    const at = line.indexOf(': ');
    if (at > 0) answers.set(line.slice(0, at), line.slice(at + 2));
  }
  return answers;
}

/** Answer lines for one question; custom input stays verbatim, cancellation and timeout keep their wording. */
function answerLines(entry, resultText) {
  const lines = [];
  const selected = Array.isArray(entry.selectedOptions)
    ? entry.selectedOptions.filter((option) => typeof option === 'string')
    : [];
  if (selected.length > 0) lines.push(`A: ${selected.join(', ')}`);
  const custom = typeof entry.customInput === 'string' && entry.customInput !== '';
  if (custom) lines.push(`A (custom): ${entry.customInput}`);
  if (selected.length === 0 && !custom) {
    lines.push(`A: ${typeof resultText === 'string' && resultText !== '' ? resultText : '(no answer)'}`);
  }
  if (typeof entry.note === 'string' && entry.note !== '') {
    const target = typeof entry.noteOption === 'string' && entry.noteOption !== '' ? ` (on ${entry.noteOption})` : '';
    lines.push(`Note: ${entry.note}${target}`);
  }
  if (entry.timedOut === true) lines.push('Auto-selected on timeout.');
  return lines;
}

/** The ask card body: one Q/A block per question. */
function askText(details, answers = new Map()) {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  if (details.chatRedirect === true) {
    const questions = Array.isArray(details.questions)
      ? details.questions.filter((question) => typeof question === 'string')
      : [];
    return ['Chat about this instead of answering.', ...questions.map((question) => `Q: ${question}`)].join('\n');
  }
  const entries = Array.isArray(details.results) ? details.results : [details];
  const lines = [];
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object' || typeof entry.question !== 'string') return null;
    lines.push(`Q: ${entry.question}`);
    lines.push(...answerLines(entry, answers.get(entry.id)));
  }
  return lines.length > 0 ? lines.join('\n') : null;
}

/** Replaces text blocks with the rendered body and keeps non-text blocks. */
function rebuild(payload, text) {
  const kept = Array.isArray(payload.content)
    ? payload.content.filter((block) => block === null || typeof block !== 'object' || block.type !== 'text')
    : [];
  return { ...payload, content: [{ type: 'text', text }, ...kept] };
}

/** The condensed result payload, or null to leave the result untouched. */
function condense(tool, payload, frameIsError) {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (frameIsError || payload.isError === true) return null;
  if (tool === 'todo') {
    const snapshot = payload.details !== null && typeof payload.details === 'object' ? payload.details.more : null;
    return validSnapshot(snapshot) ? rebuild(payload, todoText(snapshot, todoNotes(payload))) : null;
  }
  if (tool === 'ask') {
    const text = askText(payload.details, askAnswers(payload));
    return text === null ? null : rebuild(payload, text);
  }
  return null;
}

/** One JSON-quoted literal without its quotes; a malformed escape stays as written. */
function literalValue(raw) {
  try {
    return JSON.parse(`"${raw}"`);
  } catch {
    return raw;
  }
}

/** Every JSON-quoted literal on one command line, in order. */
function literalValues(line) {
  const values = [];
  const pattern = /"((?:[^"\\]|\\.)*)"/g;
  let match;
  while ((match = pattern.exec(line)) !== null) values.push(literalValue(match[1]));
  return values;
}

/** The document's first real command, plus its step count, without re-printing the whole string. */
function todoArgsSummary(args) {
  if (args === null || typeof args !== 'object' || typeof args.input !== 'string') return null;
  const commands = [];
  for (const raw of args.input.split('\n')) {
    const line = raw.trim();
    if (line === '' || line === '*** Begin Todo' || line === '*** End Todo') continue;
    const name = /^([A-Z]+)\b/.exec(line);
    if (name === null) continue;
    commands.push({ name: name[1], literals: literalValues(line) });
  }
  if (commands.length === 0) return null;
  const adds = commands.filter((command) => command.name === 'ADD').length;
  const head = commands.find((command) => command.name === 'INIT')
    ?? commands.find((command) => command.name === 'GOAL')
    ?? commands[0];
  const detail = head.literals.length > 0 ? ` ${head.literals[0]}` : '';
  const steps = adds > 0 ? ` · ${adds} ${adds === 1 ? 'step' : 'steps'}` : '';
  return truncate(`${head.name}${detail}${steps}`);
}

/** The questions an ask call carries. */
function askArgsSummary(args) {
  const questions = args !== null && typeof args === 'object' && Array.isArray(args.questions) ? args.questions : [];
  const first = questions.find((entry) => entry !== null && typeof entry === 'object' && typeof entry.question === 'string');
  if (first === undefined) return null;
  const rest = questions.length > 1 ? ` (+${questions.length - 1})` : '';
  return truncate(`${first.question}${rest}`);
}

/** The recall view a ctx call requests. */
function ctxArgsSummary(args) {
  if (args === null || typeof args !== 'object') return 'read';
  const op = typeof args.op === 'string' && args.op !== '' ? args.op : 'read';
  if (typeof args.id === 'string' && args.id !== '') return truncate(`${op} ${args.id}`);
  if (args.all === true) return `${op} all`;
  return op;
}

function summaryFor(tool, args) {
  if (tool === 'todo') return todoArgsSummary(args);
  if (tool === 'ask') return askArgsSummary(args);
  return ctxArgsSummary(args);
}

function startAlias(tool, args) {
  const summary = summaryFor(tool, args);
  const fallback = tool === 'todo' ? 'update' : tool === 'ask' ? 'question' : 'read';
  const label = tool === 'todo' ? 'Todo' : tool === 'ask' ? 'Ask' : 'Ctx';
  return `${label} · ${summary === null ? fallback : summary}`;
}

/** A dialog that carries no question: no labels stay answerable, and the message says what to do. */
function askRefusal(frame, message) {
  const refusal = { ...frame, title: ASK_FALLBACK_TITLE, message, options: [] };
  delete refusal.optionDetails;
  return refusal;
}

/** OMP packs the clean ask text behind a marker; unpack it without leaking the blob. */
function decodeAskRequest(frame) {
  if (frame.type !== 'extension_ui_request' || frame.method !== 'select') return null;
  if (typeof frame.title !== 'string' || !frame.title.startsWith(ASK_PREFIX)) return null;
  if (Buffer.byteLength(frame.title, 'utf8') > ASK_MAX_TITLE_BYTES) return askRefusal(frame, ASK_OVERSIZED_MESSAGE);
  let payload = null;
  try {
    payload = JSON.parse(frame.title.slice(ASK_PREFIX.length));
  } catch {
    payload = null;
  }
  const usable = payload !== null
    && typeof payload === 'object'
    && typeof payload.title === 'string'
    && typeof payload.message === 'string';
  if (!usable) return askRefusal(frame, ASK_UNDECODABLE_MESSAGE);
  return {
    ...frame,
    title: payload.title,
    message: payload.message
  };
}

class ToolPresentation {
  constructor() {
    /** toolCallId -> { tool, alias }: start/update/end correlation and the last alias. */
    this.calls = new Map();
  }

  /** A settled run leaves no open call aliases behind. */
  clear() {
    this.calls.clear();
  }

  /**
   * Rewrites one downstream line, or reports it as not ours.
   * @returns {{ handled: boolean, line: string|null }}
   */
  handleDownstreamFrame(line) {
    const frame = parseFrame(line);
    if (frame === null) return { handled: false, line: null };

    const decoded = decodeAskRequest(frame);
    if (decoded !== null) return { handled: true, line: JSON.stringify(decoded) + '\n' };

    if (frame.type !== 'tool_execution_start' && frame.type !== 'tool_execution_update' && frame.type !== 'tool_execution_end') {
      return { handled: false, line: null };
    }
    if (typeof frame.toolCallId !== 'string' || frame.toolCallId === '') return { handled: false, line: null };

    const call = this.calls.get(frame.toolCallId);
    const tool = ALIAS_TOOLS.has(frame.toolName) ? frame.toolName : call === undefined ? null : call.tool;
    if (tool === null) return { handled: false, line: null };

    const alias = this.aliasFor(tool, frame, call);
    const out = { ...frame, toolName: alias };

    if (frame.type === 'tool_execution_start') {
      const summary = summaryFor(tool, frame.args);
      out.args = summary === null ? { tool } : { tool, summary };
    } else if (frame.type === 'tool_execution_update') {
      const partial = condense(tool, frame.partialResult, frame.isError === true);
      if (partial !== null) out.partialResult = partial;
    } else {
      const result = condense(tool, frame.result, frame.isError === true);
      if (result !== null) out.result = result;
    }

    if (frame.type === 'tool_execution_end') {
      this.calls.delete(frame.toolCallId);
    } else if (call === undefined) {
      this.calls.set(frame.toolCallId, { tool, alias });
    } else {
      call.alias = alias;
    }

    return { handled: true, line: JSON.stringify(out) + '\n' };
  }

  /** The frame's own data wins; a frame without data reuses the call's last alias. */
  aliasFor(tool, frame, call) {
    if (tool === 'todo' && frame.type !== 'tool_execution_start') {
      const alias = todoAlias(frame.type === 'tool_execution_end' ? frame.result : frame.partialResult);
      if (alias !== null) return alias;
    }
    return call === undefined ? startAlias(tool, frame.args) : call.alias;
  }
}

module.exports = { ToolPresentation };
