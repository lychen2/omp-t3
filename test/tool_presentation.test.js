'use strict';

// Downstream presentation pins: todo/ask/ctx cards keep their real tool name in
// args, carry a readable alias in toolName on every phase, and leave every
// other frame, upstream argument and model-history result untouched.

const test = require('node:test');
const assert = require('node:assert/strict');
const { ToolPresentation } = require('../src/tool_presentation.js');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

const SNAPSHOT = {
  goal: { objective: 'Ship presentation layer', measure: 'Tests pass', doneWhen: 'npm test green' },
  phases: [
    {
      name: 'Build',
      items: [
        {
          title: 'Parse frames',
          explanation: 'Wire the adapter',
          status: 'completed',
          time: { kind: 'estimated', budgetId: 'b1', minutes: 12, elapsedMs: 60000, runningSince: null },
          commit: { sha: 'abcdef1234567', message: 'feat: parse', scope: { kind: 'all' } }
        },
        { title: 'Render cards', explanation: null, status: 'in_progress', time: { kind: 'missing' } },
        { title: 'Write docs', explanation: null, status: 'abandoned', time: { kind: 'missing' } },
        { title: 'Blocked step', explanation: null, status: 'blocked', time: { kind: 'missing' }, blocker: 'waiting on review' }
      ]
    },
    {
      name: 'Verify',
      items: [{ title: 'Run suite', explanation: null, status: 'pending', time: { kind: 'missing' } }]
    }
  ]
};

const TODO_INPUT = [
  '*** Begin Todo',
  'INIT "Ship presentation layer" "Tests pass" "npm test green"',
  'PHASE "Build"',
  'ADD "Parse frames" "Wire the adapter" 12',
  'ADD "Render cards" "Show status" 10',
  '*** End Todo'
].join('\n');

function todoStart(id = 'todo_1') {
  return JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: id,
    toolName: 'todo',
    args: { input: TODO_INPUT }
  });
}

function todoEnd(id = 'todo_1', extra = {}) {
  return JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: id,
    toolName: 'todo',
    result: { content: [{ type: 'text', text: 'todo-more raw result' }], details: { more: SNAPSHOT } },
    ...extra
  });
}

function apply(presentation, line) {
  const res = presentation.handleDownstreamFrame(line);
  assert.equal(res.handled, true, 'presentation owns this frame');
  return JSON.parse(res.line);
}

test('non-presentation frames stay untouched, including other tools with a title arg', () => {
  const presentation = new ToolPresentation();
  const frames = [
    JSON.stringify({ type: 'message_update', message: 'hello' }),
    JSON.stringify({ type: 'tool_execution_start', toolCallId: 'b1', toolName: 'bash', args: { title: 'Todo · fake' } }),
    JSON.stringify({ type: 'tool_execution_end', toolCallId: 'b1', toolName: 'bash', result: { content: [] } })
  ];
  for (const frame of frames) {
    assert.deepEqual(presentation.handleDownstreamFrame(frame), { handled: false, line: null });
  }
});

test('todo start: readable alias, real tool name kept in args, DSL summarized', () => {
  const presentation = new ToolPresentation();
  const start = apply(presentation, todoStart());
  assert.equal(start.toolCallId, 'todo_1');
  assert.equal(start.toolName, 'Todo · INIT Ship presentation layer · 2 steps');
  assert.deepEqual(start.args, { tool: 'todo', summary: 'INIT Ship presentation layer · 2 steps' });
});

test('todo start: incremental documents summarize their real first command', () => {
  const presentation = new ToolPresentation();
  const goals = apply(presentation, JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'g1',
    toolName: 'todo',
    args: {
      input: '*** Begin Todo\nGOAL "Ship the fix" "Regression green" "Suite passes"\nADD "Write test" "Reproduce" 5\nADD "Fix it" "Apply" 7\n*** End Todo'
    }
  }));
  assert.equal(goals.toolName, 'Todo · GOAL Ship the fix · 2 steps');

  const done = apply(presentation, JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'd1',
    toolName: 'todo',
    args: { input: '*** Begin Todo\nDONE "Write test" "test: reproduce"\n*** End Todo' }
  }));
  assert.equal(done.toolName, 'Todo · DONE Write test');
});

test('todo end: goal, progress, phase groups, budget/blocker/short sha, distinct completed vs abandoned', () => {
  const presentation = new ToolPresentation();
  const end = apply(presentation, todoEnd());
  assert.equal(end.toolName, 'Todo · [2/5] Render cards');
  const text = end.result.content[0].text;
  assert.equal(
    text,
    [
      'Objective: Ship presentation layer',
      'Measure: Tests pass',
      'Done when: npm test green',
      'Progress: 2/5 closed · 1 completed · 1 abandoned · 1 in progress · 1 blocked · 1 pending',
      'Build',
      '  ✓ Parse frames — 12 min budget, 1.0 min elapsed; abcdef1 "feat: parse" (all changes)',
      '    Wire the adapter',
      '  ◉ Render cards',
      '  ✕ Write docs',
      '  ⊘ Blocked step — blocked: waiting on review',
      'Verify',
      '  ○ Run suite'
    ].join('\n')
  );
  assert.deepEqual(end.result.details.more, SNAPSHOT, 'the snapshot is not rewritten');
});

test('todo end: commit notes and Shared worktree lines survive without replaying the old summary', () => {
  const presentation = new ToolPresentation();
  const snapshot = {
    goal: { objective: 'Ship the fix', measure: 'Green', doneWhen: 'Suite passes' },
    phases: [{
      name: 'Fix',
      items: [{
        title: 'Apply patch',
        explanation: 'Change the boundary check',
        status: 'completed',
        time: { kind: 'estimated', minutes: 10, elapsedMs: 0 },
        commit: { sha: '1234567890', message: 'fix: boundary', scope: { kind: 'paths', files: ['src/a.js', 'test/a.test.js'] } }
      }]
    }]
  };
  const rawText = [
    'Goal:',
    '  Ship the fix',
    'Remaining items: none.',
    'Overall: 1/1 done, 0 open.',
    'Active phase 1/1 "Fix" (1/1).',
    '  Fix:',
    '    - [X] Apply patch',
    '        Commit: 1234567 "fix: boundary" (src/a.js test/a.test.js)',
    '        Change the boundary check',
    '        10 min budget',
    'Shared worktree with the parent agent (/repo): this DONE committed nothing; the parent agent integrates and commits these changes.'
  ].join('\n');
  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'notes1',
    toolName: 'todo',
    result: { content: [{ type: 'text', text: rawText }], details: { more: snapshot } }
  }));
  const text = end.result.content[0].text;
  assert.ok(text.includes('1234567 "fix: boundary" (src/a.js test/a.test.js)'));
  assert.ok(text.includes('    Change the boundary check'));
  assert.ok(text.endsWith('Shared worktree with the parent agent (/repo): this DONE committed nothing; the parent agent integrates and commits these changes.'));
  assert.ok(!text.includes('Remaining items'), 'the old summary is not replayed');
  assert.ok(!text.includes('Overall:'), 'the old summary is not replayed');
});

test('alias follows toolCallId through start, update and end even when later frames carry no args', () => {
  const presentation = new ToolPresentation();
  const start = apply(presentation, todoStart('c9'));
  assert.equal(start.toolName, 'Todo · INIT Ship presentation layer · 2 steps');

  // Update without args or a snapshot: the call's alias survives.
  const update = apply(presentation, JSON.stringify({
    type: 'tool_execution_update',
    toolCallId: 'c9',
    toolName: 'todo',
    partialResult: { content: [{ type: 'text', text: 'working' }] }
  }));
  assert.equal(update.toolName, start.toolName);

  // End with no toolName field still resolves through the call id.
  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'c9',
    result: { content: [], details: { more: SNAPSHOT } }
  }));
  assert.equal(end.toolName, 'Todo · [2/5] Render cards');
  assert.ok(end.result.content[0].text.includes('Progress: 2/5 closed'));

  // The call is gone: a later frame with only that id is not ours.
  const late = presentation.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 'c9', partialResult: { content: [] }
  }));
  assert.deepEqual(late, { handled: false, line: null });
});

test('error results keep their text and status verbatim', () => {
  const presentation = new ToolPresentation();
  const raw = {
    type: 'tool_execution_end',
    toolCallId: 'e1',
    toolName: 'todo',
    isError: true,
    result: { content: [{ type: 'text', text: 'Error: cannot read the todo state.' }], details: { more: SNAPSHOT } }
  };
  const end = apply(presentation, JSON.stringify(raw));
  assert.equal(end.isError, true);
  assert.deepEqual(end.result, raw.result);
  assert.equal(end.toolName, 'Todo · [2/5] Render cards');

  // omp may also mark the result itself.
  const nested = {
    content: [{ type: 'text', text: 'Error: cannot read the todo state.' }],
    details: { more: SNAPSHOT },
    isError: true
  };
  const nestedEnd = apply(presentation, JSON.stringify({
    type: 'tool_execution_end', toolCallId: 'e2', toolName: 'todo', result: nested
  }));
  assert.deepEqual(nestedEnd.result, nested);
});

test('unknown or malformed snapshots keep the original result', () => {
  const presentation = new ToolPresentation();
  const bad = {
    content: [{ type: 'text', text: 'raw' }],
    details: { more: { goal: null, phases: [{ name: 'x', items: [{ title: 't', status: 'nonsense' }] }] } }
  };
  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end', toolCallId: 'bad1', toolName: 'todo', result: bad
  }));
  assert.deepEqual(end.result, bad);

  const missing = { content: [{ type: 'text', text: 'raw' }], details: {} };
  const plain = apply(presentation, JSON.stringify({
    type: 'tool_execution_end', toolCallId: 'bad2', toolName: 'todo', result: missing
  }));
  assert.deepEqual(plain.result, missing);
});

test('non-text result blocks survive the condense', () => {
  const presentation = new ToolPresentation();
  const image = { type: 'image', data: 'AAAA', mimeType: 'image/png' };
  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'img1',
    toolName: 'todo',
    result: { content: [{ type: 'text', text: 'raw' }, image], details: { more: SNAPSHOT } }
  }));
  assert.deepEqual(end.result.content[1], image);
});

test('ask: question summary on start, formatted answers with custom text, notes and timeout', () => {
  const presentation = new ToolPresentation();
  const start = apply(presentation, JSON.stringify({
    type: 'tool_execution_start',
    toolCallId: 'ask_1',
    toolName: 'ask',
    args: { questions: [{ id: 'q1', question: 'Which storage?', options: [{ label: 'SQLite' }] }, { id: 'q2', question: 'Which OS?', options: [{ label: 'Linux' }] }] }
  }));
  assert.equal(start.toolName, 'Ask · Which storage? (+1)');
  assert.deepEqual(start.args, { tool: 'ask', summary: 'Which storage? (+1)' });

  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'ask_1',
    toolName: 'ask',
    result: {
      content: [{ type: 'text', text: 'raw answers' }],
      details: {
        results: [
          {
            id: 'q1', question: 'Which storage?', options: ['SQLite', 'Postgres'], multi: false,
            selectedOptions: ['SQLite'], customInput: 'custom: in-memory', note: 'fast', noteOption: 'SQLite'
          },
          { id: 'q2', question: 'Which OS?', options: ['Linux'], multi: false, selectedOptions: ['Linux'], timedOut: true }
        ]
      }
    }
  }));
  assert.equal(end.toolName, 'Ask · Which storage? (+1)', 'the call alias stays consistent');
  assert.equal(
    end.result.content[0].text,
    [
      'Q: Which storage?',
      'A: SQLite',
      'A (custom): custom: in-memory',
      'Note: fast (on SQLite)',
      'Q: Which OS?',
      'A: Linux',
      'Auto-selected on timeout.'
    ].join('\n')
  );
});

test('ask: cancelled and timed-out answers keep the result.ts wording instead of reading as no answer', () => {
  const presentation = new ToolPresentation();
  const cancelled = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'ask_cancel',
    toolName: 'ask',
    result: {
      content: [{ type: 'text', text: 'User answers:\nq1: (cancelled)\nq2: (cancelled)' }],
      details: {
        results: [
          { id: 'q1', question: 'Keep it?', options: ['Yes', 'No'], multi: false, selectedOptions: [] },
          { id: 'q2', question: 'Ship it?', options: ['Yes', 'No'], multi: false, selectedOptions: [] }
        ]
      }
    }
  }));
  assert.equal(
    cancelled.result.content[0].text,
    ['Q: Keep it?', 'A: (cancelled)', 'Q: Ship it?', 'A: (cancelled)'].join('\n')
  );

  const timedOut = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'ask_timeout',
    toolName: 'ask',
    result: {
      content: [{
        type: 'text',
        text: 'User answers:\nq1: yes\nq2: (timed out: the user did not answer; decide it yourself with your best judgment)'
      }],
      details: {
        results: [
          { id: 'q1', question: 'Keep it?', options: ['yes', 'no'], multi: false, selectedOptions: ['yes'] },
          { id: 'q2', question: 'Ship it?', options: ['yes', 'no'], multi: false, selectedOptions: [] }
        ]
      }
    }
  }));
  assert.equal(
    timedOut.result.content[0].text,
    [
      'Q: Keep it?',
      'A: yes',
      'Q: Ship it?',
      'A: (timed out: the user did not answer; decide it yourself with your best judgment)'
    ].join('\n')
  );
});

test('ask: chat redirect and unanswered questions keep their meaning', () => {
  const presentation = new ToolPresentation();
  const redirect = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'ask_2',
    toolName: 'ask',
    result: { content: [{ type: 'text', text: 'raw' }], details: { chatRedirect: true, questions: ['Why?'] } }
  }));
  assert.equal(redirect.result.content[0].text, 'Chat about this instead of answering.\nQ: Why?');

  const unanswered = apply(presentation, JSON.stringify({
    type: 'tool_execution_end',
    toolCallId: 'ask_3',
    toolName: 'ask',
    result: { content: [], details: { results: [{ id: 'q1', question: 'Q?', options: [], multi: false, selectedOptions: [] }] } }
  }));
  assert.equal(unanswered.result.content[0].text, 'Q: Q?\nA: (no answer)');
});

test('ctx: input is summarized, the recall text passes through unchanged', () => {
  const presentation = new ToolPresentation();
  const start = apply(presentation, JSON.stringify({
    type: 'tool_execution_start', toolCallId: 'ctx_1', toolName: 'ctx', args: { op: 'show', id: 'build-1' }
  }));
  assert.equal(start.toolName, 'Ctx · show build-1');
  assert.deepEqual(start.args, { tool: 'ctx', summary: 'show build-1' });

  const raw = { content: [{ type: 'text', text: '# full recall\nline two' }], details: { truncated: false } };
  const end = apply(presentation, JSON.stringify({
    type: 'tool_execution_end', toolCallId: 'ctx_1', result: raw
  }));
  assert.equal(end.toolName, 'Ctx · show build-1');
  assert.deepEqual(end.result, raw);
});

test('ask RPC marker: clean title/message replace the blob, other fields survive', () => {
  const presentation = new ToolPresentation();
  const blob = JSON.stringify({ title: 'Pick a model', message: 'Choose a model for the run' });
  const frame = {
    type: 'extension_ui_request',
    id: 'r1',
    method: 'select',
    title: `omp-t3:ask:v1\n${blob}`,
    message: 'raw encoded blob',
    options: ['a', 'b'],
    optionDetails: [{ label: 'a' }],
    timeout: 30000
  };
  const decoded = apply(presentation, JSON.stringify(frame));
  assert.equal(decoded.title, 'Pick a model');
  assert.equal(decoded.message, 'Choose a model for the run');
  assert.equal(decoded.id, 'r1');
  assert.deepEqual(decoded.options, ['a', 'b']);
  assert.deepEqual(decoded.optionDetails, [{ label: 'a' }]);
  assert.equal(decoded.timeout, 30000);
});

test('ask RPC marker: a bad payload refuses the dialog instead of offering bare options', () => {
  const presentation = new ToolPresentation();
  const res = presentation.handleDownstreamFrame(JSON.stringify({
    type: 'extension_ui_request',
    id: 'r2',
    method: 'select',
    title: 'omp-t3:ask:v1\n{not json',
    message: 'secret raw question',
    options: ['secret label']
  }));
  assert.equal(res.handled, true);
  const decoded = JSON.parse(res.line);
  assert.equal(decoded.title, 'Ask');
  assert.match(decoded.message, /could not be decoded/);
  assert.deepEqual(decoded.options, [], 'no undecoded labels stay answerable');
  assert.equal(decoded.optionDetails, undefined);
  assert.ok(!JSON.stringify(decoded).includes('not json'));
  assert.ok(!JSON.stringify(decoded).includes('secret raw question'));
  assert.ok(!JSON.stringify(decoded).includes('secret label'));
});

test('ask RPC marker: a title over the 1 MiB RPC frame limit refuses the dialog', () => {
  const presentation = new ToolPresentation();
  const huge = 'x'.repeat(1024 * 1024);
  const res = presentation.handleDownstreamFrame(JSON.stringify({
    type: 'extension_ui_request',
    id: 'r3',
    method: 'select',
    title: `omp-t3:ask:v1\n${JSON.stringify({ title: 'Huge', message: huge })}`,
    message: 'raw',
    options: ['label']
  }));
  assert.equal(res.handled, true);
  const decoded = JSON.parse(res.line);
  assert.equal(decoded.title, 'Ask');
  assert.match(decoded.message, /RPC frame limit/);
  assert.deepEqual(decoded.options, []);
});

test('ordinary dialogs are not scanned for the marker', () => {
  const presentation = new ToolPresentation();
  const plain = JSON.stringify({ type: 'extension_ui_request', id: 'd1', method: 'select', title: 'Allow bash?', message: 'Run it?' });
  const confirm = JSON.stringify({ type: 'extension_ui_request', id: 'd2', method: 'confirm', title: 'omp-t3:ask:v1\n{}', message: 'x' });
  assert.deepEqual(presentation.handleDownstreamFrame(plain), { handled: false, line: null });
  assert.deepEqual(presentation.handleDownstreamFrame(confirm), { handled: false, line: null });
});

test('settle clears the call map', () => {
  const presentation = new ToolPresentation();
  apply(presentation, todoStart('s1'));
  presentation.clear();
  const res = presentation.handleDownstreamFrame(JSON.stringify({
    type: 'tool_execution_update', toolCallId: 's1', partialResult: { content: [] }
  }));
  assert.deepEqual(res, { handled: false, line: null });
});

test('pipeline: aliases reach the consumer, unrelated frames stay byte-identical', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({ clientIn, clientOut, childIn, childOut });
  const client = collectLines(clientOut);
  pipeline.start();

  const message = JSON.stringify({ type: 'message_update', message: 'streaming' });
  const other = JSON.stringify({ type: 'tool_execution_start', toolCallId: 'x1', toolName: 'read', args: { path: 'a' } });
  childOut.write(message + '\n');
  childOut.write(other + '\n');
  childOut.write(todoStart('p1') + '\n');
  childOut.write(todoEnd('p1') + '\n');
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(client.lines[0], message, 'untouched frame crosses byte-identically');
  assert.equal(client.lines[1], other, 'other tools are never renamed');
  const start = JSON.parse(client.lines[2]);
  assert.equal(start.toolName, 'Todo · INIT Ship presentation layer · 2 steps');
  assert.equal(start.args.tool, 'todo');
  const end = JSON.parse(client.lines[3]);
  assert.equal(end.toolName, 'Todo · [2/5] Render cards');
  assert.ok(end.result.content[0].text.includes('Progress: 2/5 closed'));
  pipeline.stop();
});
