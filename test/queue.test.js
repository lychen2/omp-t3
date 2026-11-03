'use strict';

const test = require('node:test');
const assert = require('node:assert');
const {
  QueueCompatAdapter,
  clearQueueData,
  restoredTexts
} = require('../src/queue.js');
const { createProxyPipeline } = require('../src/proxy.js');
const { createMockStreams, collectLines } = require('./helpers.js');

const IDLE_MODEL_MANAGER = {
  handleUpstreamFrame: () => ({ intercepted: false }),
  handleDownstreamFrame: () => ({ handled: false })
};

const tick = () => new Promise((resolve) => setImmediate(resolve));

function json(line) {
  return JSON.parse(line);
}

function makeHarness(options = {}) {
  const events = [];
  const toOmp = [];
  const toClient = [];
  const replayed = [];
  const settlementCalls = [];
  const marks = [];
  const settleEmit = options.settleEmit;
  const settlementTracker = {
    handleUpstreamFrame(line) {
      marks.push('settlement');
      settlementCalls.push(json(line));
      if (settleEmit === undefined) return null;
      return { emit: settleEmit };
    }
  };
  const adapter = new QueueCompatAdapter({
    writeToOmp(line) {
      marks.push('omp');
      toOmp.push(line);
      events.push({ kind: 'omp', frame: json(line) });
    },
    writeToClient(line) {
      toClient.push(line);
      events.push({ kind: 'client', frame: json(line) });
    },
    replayDownstream(line) {
      replayed.push(line);
      events.push({ kind: 'replay', frame: json(line) });
    },
    settlementTracker
  });
  return { adapter, events, toOmp, toClient, replayed, settlementCalls, marks };
}

function restoreId(harness) {
  assert.strictEqual(harness.toOmp.length, 1);
  return json(harness.toOmp[0]).id;
}

test('new T3 clear_queue maps to one atomic restore and answers with original id and text', () => {
  const h = makeHarness();

  assert.deepStrictEqual(
    h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}'),
    { handled: true }
  );
  const request = json(h.toOmp[0]);
  assert.strictEqual(request.type, 'abort_and_restore_queue');
  assert.match(request.id, /^ompt3-queue-\d+$/);
  assert.deepStrictEqual(h.settlementCalls, [{ type: 'abort' }]);
  assert.deepStrictEqual(h.marks, ['settlement', 'omp']);
  assert.deepStrictEqual(h.toClient, []);

  // omp emits these before it answers the atomic RPC; all stay held.
  assert.strictEqual(
    h.adapter.handleDownstreamFrame('{"type":"queue_update","steering":[],"followUp":[],"liveSteered":0}').handled,
    true
  );
  assert.strictEqual(h.adapter.handleDownstreamFrame('{"type":"agent_end"}').handled, true);
  assert.deepStrictEqual(h.toClient, []);
  assert.deepStrictEqual(h.replayed, []);

  assert.deepStrictEqual(
    h.adapter.handleDownstreamFrame(JSON.stringify({
      id: request.id,
      type: 'response',
      command: 'abort_and_restore_queue',
      success: true,
      data: {
        steering: [{ text: 'steer-one' }, { text: '', images: [{ type: 'image' }] }],
        followUp: [{ text: 'follow-one' }, { text: 'steer-one' }]
      }
    })),
    { handled: true }
  );

  // Clear is answered before the turn is finalized so T3 can render it.
  assert.strictEqual(h.toClient.length, 1);
  const cleared = json(h.toClient[0]);
  assert.deepStrictEqual(cleared, {
    type: 'response',
    command: 'clear_queue',
    id: 't3-1',
    success: true,
    data: {
      steering: ['steer-one', ''],
      followUp: ['follow-one', 'steer-one']
    }
  });
  assert.deepStrictEqual(h.replayed, [], 'abort frames stay held until T3 sends abort');

  assert.deepStrictEqual(
    h.adapter.handleUpstreamFrame('{"type":"abort","id":"t3-2"}'),
    { handled: true }
  );
  assert.deepStrictEqual(h.replayed, [
    '{"type":"queue_update","steering":[],"followUp":[],"liveSteered":0}',
    '{"type":"agent_end"}'
  ]);
  assert.strictEqual(h.toClient.length, 2);
  assert.deepStrictEqual(json(h.toClient[1]), {
    type: 'response',
    command: 'abort',
    id: 't3-2',
    success: true
  });
  assert.strictEqual(h.toOmp.length, 1, 'the follow-up abort must not abort omp twice');
  assert.strictEqual(h.settlementCalls.length, 1, 'the abort must not reach the tracker twice');
  assert.deepStrictEqual(h.events.map((event) => event.kind), [
    'omp',
    'client',
    'replay',
    'replay',
    'client'
  ]);
  assert.strictEqual(h.events[1].frame.command, 'clear_queue');
  assert.strictEqual(h.events[4].frame.command, 'abort');
});

test('T3 abort may arrive before the atomic response; ack order still holds', () => {
  const h = makeHarness();
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}');
  const ompId = restoreId(h);

  h.adapter.handleDownstreamFrame('{"type":"agent_end"}');
  h.adapter.handleUpstreamFrame('{"type":"abort","id":"t3-2"}');
  assert.deepStrictEqual(h.events.map((event) => event.kind), ['omp']);
  assert.deepStrictEqual(h.toClient, []);

  h.adapter.handleDownstreamFrame(JSON.stringify({
    id: ompId,
    type: 'response',
    command: 'abort_and_restore_queue',
    success: true,
    data: { steering: [{ text: 'queued' }], followUp: [] }
  }));

  assert.deepStrictEqual(h.events.slice(1).map((event) => event.kind), [
    'client',
    'replay',
    'client'
  ]);
  assert.strictEqual(h.events[1].frame.command, 'clear_queue');
  assert.deepStrictEqual(h.events[1].frame.data, { steering: ['queued'], followUp: [] });
  assert.strictEqual(h.events[2].frame.type, 'agent_end');
  assert.strictEqual(h.events[3].frame.command, 'abort');
  assert.strictEqual(h.events[3].frame.id, 't3-2');
});

test('older T3 abort alone becomes one atomic restore and is acknowledged locally', () => {
  const h = makeHarness();
  const original = '{"type":"abort","id":7}';

  assert.deepStrictEqual(h.adapter.handleUpstreamFrame(original), { handled: true });
  assert.strictEqual(h.toOmp.length, 1);
  const request = json(h.toOmp[0]);
  assert.strictEqual(request.type, 'abort_and_restore_queue');
  assert.deepStrictEqual(h.settlementCalls, [{ type: 'abort', id: 7 }]);
  assert.deepStrictEqual(h.toClient, []);

  // No clear_queue was sent, so live output is not held.
  assert.deepStrictEqual(h.adapter.handleDownstreamFrame('{"type":"agent_end"}'), { handled: false });

  assert.deepStrictEqual(
    h.adapter.handleDownstreamFrame(JSON.stringify({
      id: request.id,
      type: 'response',
      command: 'abort_and_restore_queue',
      success: true,
      data: { steering: [{ text: 'discarded' }], followUp: [] }
    })),
    { handled: true }
  );
  assert.deepStrictEqual(h.toClient, [
    JSON.stringify({ type: 'response', command: 'abort', id: 7, success: true }) + '\n'
  ]);
  assert.strictEqual(h.toOmp.length, 1);
});

test('atomic failure answers clear_queue with a real failure and forwards the original abort', () => {
  const h = makeHarness();
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}');
  const ompId = restoreId(h);

  h.adapter.handleDownstreamFrame(JSON.stringify({
    id: ompId,
    type: 'response',
    command: 'abort_and_restore_queue',
    success: false,
    error: 'Unknown command: abort_and_restore_queue'
  }));

  assert.strictEqual(h.toClient.length, 1);
  assert.deepStrictEqual(json(h.toClient[0]), {
    type: 'response',
    command: 'clear_queue',
    id: 't3-1',
    success: false,
    error: 'Unknown command: abort_and_restore_queue'
  });

  const abortLine = '{"type":"abort","id":"t3-2"}';
  h.adapter.handleUpstreamFrame(abortLine);
  assert.strictEqual(h.toOmp.length, 2);
  assert.strictEqual(h.toOmp[1], abortLine);
  assert.strictEqual(h.toClient.length, 1, 'no synthesized abort success');

  // The forwarded abort's real response now belongs to the normal pipeline.
  assert.deepStrictEqual(
    h.adapter.handleDownstreamFrame('{"type":"response","command":"abort","id":"t3-2","success":true}'),
    { handled: false }
  );
});

test('older T3 atomic failure forwards its abort unchanged with no success frame', () => {
  const h = makeHarness();
  const abortLine = '{"type":"abort","id":9}';
  h.adapter.handleUpstreamFrame(abortLine);
  const ompId = restoreId(h);

  h.adapter.handleDownstreamFrame(JSON.stringify({
    id: ompId,
    type: 'response',
    command: 'abort_and_restore_queue',
    success: false,
    error: 'Unsupported'
  }));

  assert.deepStrictEqual(h.toClient, []);
  assert.strictEqual(h.toOmp.length, 2);
  assert.strictEqual(h.toOmp[1], abortLine);
});

test('idle-settle emitted for the synthetic abort stays held until T3 abort', () => {
  const settleEmit = JSON.stringify({ type: 'agent_settled', aborted: true }) + '\n';
  const h = makeHarness({ settleEmit });
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}');
  const ompId = restoreId(h);

  assert.deepStrictEqual(h.toClient, [], 'settle must not finalize the turn before clear lands');
  assert.deepStrictEqual(
    h.adapter.handleDownstreamFrame(JSON.stringify({
      id: ompId,
      type: 'response',
      command: 'abort_and_restore_queue',
      success: true,
      data: { steering: [], followUp: [] }
    })),
    { handled: true }
  );
  assert.strictEqual(h.toClient.length, 1);
  assert.strictEqual(json(h.toClient[0]).command, 'clear_queue');

  h.adapter.handleUpstreamFrame('{"type":"abort","id":"t3-2"}');
  assert.deepStrictEqual(h.events.slice(1).map((event) => event.kind), ['client', 'client', 'client']);
  assert.strictEqual(json(h.toClient[1]).type, 'agent_settled');
  assert.strictEqual(json(h.toClient[1]).aborted, true);
  assert.strictEqual(json(h.toClient[2]).command, 'abort');
});

test('a second Stop after completion starts a new atomic restore', () => {
  const h = makeHarness();
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}');
  h.adapter.handleDownstreamFrame(JSON.stringify({
    id: restoreId(h),
    type: 'response',
    command: 'abort_and_restore_queue',
    success: true,
    data: { steering: [], followUp: [] }
  }));
  h.adapter.handleUpstreamFrame('{"type":"abort","id":"t3-2"}');

  h.adapter.handleUpstreamFrame('{"type":"abort","id":"t3-3"}');
  assert.strictEqual(h.toOmp.length, 2);
  assert.strictEqual(json(h.toOmp[1]).type, 'abort_and_restore_queue');
  assert.deepStrictEqual(h.settlementCalls.map((call) => call.type), ['abort', 'abort']);
});

test('clear and abort ids keep their JSON type', () => {
  const h = makeHarness();
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":41}');
  h.adapter.handleDownstreamFrame(JSON.stringify({
    id: restoreId(h),
    type: 'response',
    command: 'abort_and_restore_queue',
    success: true,
    data: { steering: [], followUp: [] }
  }));
  h.adapter.handleUpstreamFrame('{"type":"abort","id":42}');

  assert.strictEqual(json(h.toClient[0]).id, 41);
  assert.strictEqual(json(h.toClient[1]).id, 42);
});

test('new turn releases held frames instead of stranding them', () => {
  const h = makeHarness();
  h.adapter.handleUpstreamFrame('{"type":"clear_queue","id":"t3-1"}');
  h.adapter.handleDownstreamFrame('{"type":"agent_end"}');
  assert.deepStrictEqual(h.adapter.handleUpstreamFrame('{"type":"prompt","message":"next"}'), {
    handled: false
  });
  assert.deepStrictEqual(h.replayed, ['{"type":"agent_end"}']);
});

test('non-queue frames are left to the normal pipeline', () => {
  const h = makeHarness();
  assert.deepStrictEqual(h.adapter.handleUpstreamFrame('not json'), { handled: false });
  assert.deepStrictEqual(h.adapter.handleUpstreamFrame('{"type":"get_state","id":"s"}'), {
    handled: false
  });
  assert.deepStrictEqual(h.adapter.handleUpstreamFrame('{"type":"prompt","message":"hi"}'), {
    handled: false
  });
  assert.deepStrictEqual(h.adapter.handleDownstreamFrame('garbage'), { handled: false });
  assert.deepStrictEqual(h.adapter.handleDownstreamFrame('{"type":"message_update"}'), {
    handled: false
  });
  assert.deepStrictEqual(h.toOmp, []);
});

test('restored queue normalization keeps order and tolerates string entries', () => {
  assert.deepStrictEqual(
    restoredTexts(['plain', { text: 'object' }, { text: '' }, { images: [] }, null, 4]),
    ['plain', 'object', '']
  );
  assert.deepStrictEqual(restoredTexts(null), []);
  assert.deepStrictEqual(clearQueueData(null), { steering: [], followUp: [] });
  assert.deepStrictEqual(
    clearQueueData({ steering: [{ text: 'a' }], followUp: [{ text: 'b' }] }),
    { steering: ['a'], followUp: ['b'] }
  );
});

test('proxy wiring: clear_queue is answered before the turn settles and abort is acked locally', async () => {
  const { stdin: clientIn, stdout: clientOut } = createMockStreams();
  const { stdin: childIn, stdout: childOut } = createMockStreams();
  const pipeline = createProxyPipeline({
    clientIn,
    clientOut,
    childIn,
    childOut,
    modelManager: IDLE_MODEL_MANAGER
  });
  const clientLines = collectLines(clientOut);
  const childLines = collectLines(childIn);
  pipeline.start();

  childOut.write('{"type":"agent_start"}\n');
  await tick();

  clientIn.write('{"type":"clear_queue","id":"c1"}\n');
  await tick();

  assert.strictEqual(childLines.lines.length, 1);
  const restore = json(childLines.lines[0]);
  assert.strictEqual(restore.type, 'abort_and_restore_queue');
  assert.strictEqual(restore.id, 'ompt3-queue-1');

  childOut.write('{"type":"agent_end"}\n');
  childOut.write(JSON.stringify({
    id: restore.id,
    type: 'response',
    command: 'abort_and_restore_queue',
    success: true,
    data: { steering: [{ text: 'steer-one' }], followUp: [{ text: 'follow-one' }] }
  }) + '\n');
  await tick();

  assert.deepStrictEqual(clientLines.getJson(), [
    { type: 'agent_start' },
    {
      type: 'response',
      command: 'clear_queue',
      id: 'c1',
      success: true,
      data: { steering: ['steer-one'], followUp: ['follow-one'] }
    }
  ]);

  clientIn.write('{"type":"abort","id":"a1"}\n');
  await tick();

  const after = clientLines.getJson();
  assert.deepStrictEqual(after.map((frame) => frame.type || frame.command), [
    'agent_start',
    'response',
    'agent_end',
    'agent_settled',
    'response'
  ]);
  assert.strictEqual(after[1].command, 'clear_queue');
  assert.strictEqual(after[3].aborted, true);
  assert.strictEqual(after[4].command, 'abort');
  assert.strictEqual(after[4].id, 'a1');
  assert.strictEqual(after[4].success, true);
  assert.strictEqual(childLines.lines.length, 1, 'one atomic restore, no second abort');

  pipeline.stop();
});
