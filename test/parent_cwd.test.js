'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { registerParentCwd } = require('../src/parent_cwd.js');

function fixture(own, parent, project, plainText = false) {
  const handlers = new Map();
  const pi = { events: { on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name); } }, on: () => {} };
  const calls = [];
  const client = { callTool: async (name, args) => {
    calls.push([name, args]);
    let value;
    if (name === 'orchestrator_capabilities') value = { parentThreadId: 'caller' };
    else if (name === 't3_thread_read') value = { thread: args.threadId === 'caller' ? own : parent };
    else if (name === 't3_project_read') value = project;
    else throw new Error(name);
    return plainText ? { content: [{ type: 'text', text: JSON.stringify(value) }] } : { structuredContent: value };
  } };
  registerParentCwd(pi, client, async () => {});
  return { calls, resolve: async () => {
    let result;
    await handlers.get('omp-t3:parent-cwd:v1')({ reply: value => { result = value; } });
    return result;
  } };
}

test('a top-level caller is independent even when capabilities names itself as parent', async () => {
  const f = fixture({ threadId: 'caller', relationshipToParent: null, parentThreadId: null });
  assert.deepEqual(await f.resolve(), { kind: 'top-level' });
  assert.equal(f.calls.length, 2);
});

test('a fork keeps independent commit ownership despite its lineage parent', async () => {
  const f = fixture({ threadId: 'caller', relationshipToParent: 'fork', parentThreadId: 'parent' });
  assert.deepEqual(await f.resolve(), { kind: 'top-level' });
});

test('only the actual subagent parent supplies its worktree; plain-text MCP is supported', async () => {
  const f = fixture(
    { threadId: 'caller', relationshipToParent: 'subagent', parentThreadId: 'parent' },
    { threadId: 'parent', worktreePath: '/checkout/parent' },
    undefined, true
  );
  assert.deepEqual(await f.resolve(), { kind: 'parent', cwd: '/checkout/parent' });
});

test('a root-checkout parent resolves through its own project', async () => {
  const f = fixture(
    { threadId: 'caller', relationshipToParent: 'subagent', parentThreadId: 'parent' },
    { threadId: 'parent', worktreePath: null, projectId: 'parent-project' },
    { id: 'parent-project', workspaceRoot: '/checkout/root' }
  );
  assert.deepEqual(await f.resolve(), { kind: 'parent', cwd: '/checkout/root' });
});

test('missing, self-referential and mismatched lineage cannot authorize a commit', async () => {
  for (const own of [
    { threadId: 'caller' },
    { threadId: 'caller', relationshipToParent: 'subagent', parentThreadId: 'caller' },
    { threadId: 'other', relationshipToParent: null }
  ]) assert.equal((await fixture(own).resolve()).kind, 'unavailable');
  const f = fixture(
    { threadId: 'caller', relationshipToParent: 'subagent', parentThreadId: 'parent' },
    { threadId: 'stranger', worktreePath: '/checkout/other' }
  );
  assert.equal((await f.resolve()).kind, 'unavailable');
});

test('unavailable transport returns an explicit unknown decision', async () => {
  let handler;
  registerParentCwd({ events: { on: (_name, fn) => { handler = fn; return () => {}; } }, on: () => {} }, {}, async () => { throw new Error('offline'); });
  let result;
  await handler({ reply: value => { result = value; } });
  assert.deepEqual(result, { kind: 'unavailable', message: 'offline' });
});
