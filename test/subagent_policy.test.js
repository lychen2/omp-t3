'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createSubagentPolicy, subagentPolicyArgs } = require('../src/subagent_policy.js');
const { adaptT3ExtensionArgs, GET_COMMANDS_MARKER, MCP_CLIENT_MARKER } = require('../src/extension_compat.js');

test('defaults accept the seven requested catalog model names and reject other models', () => {
  const policy = createSubagentPolicy({});
  for (const model of ['gpt-6-astra', 'litellm/gpt-6.1-sol',
    'litellm/gemini-3.8-flash', 'litellm/gemini-4-argon',
    'litellm/deepseek-v4.1-flash', 'litellm/gpt-6-lunag', 'LITELLM/GPT-6.1-TERRA']) {
    assert.equal(policy.checkModel(model), null, model);
  }
  for (const model of ['glm-5.3-flash', 'openrouter/anthropic/claude-opus-4.8',
    'glm-5.3', 'gemini-3.8-pro', 'gemini-3.8-flash:batch', 'gpt-6.1-sol-extra']) {
    assert.match(policy.checkModel(model), /rejected/, model);
  }
  for (const model of [undefined, null, '', '  ', ' glm-5.3-flash', 'GLM 5.3 Flash', 42]) {
    assert.match(policy.checkModel(model), /target.model explicitly/);
  }
});

test('each env list replaces its defaults, globs are anchored, and denial wins', () => {
  const policy = createSubagentPolicy({
    OMPT3_SUBAGENT_ALLOWED_MODELS: ' openrouter/google/gemini-*, glm-5.3-flash , glm-5.3-flash ',
    OMPT3_SUBAGENT_DISALLOWED_MODELS: '*pro*,glm-5.3-flash'
  });
  assert.equal(policy.allowed.length, 2);
  assert.equal(policy.checkModel('openrouter/google/gemini-3.8-flash'), null);
  for (const model of ['other/google/gemini-3.8-flash', 'openrouter/google/gemini-3.8-pro', 'glm-5.3-flash']) {
    assert.match(policy.checkModel(model), /rejected/);
  }
  const denyOnly = createSubagentPolicy({ OMPT3_SUBAGENT_ALLOWED_MODELS: '', OMPT3_SUBAGENT_DISALLOWED_MODELS: '*opus*,glm-5.3:*' });
  assert.equal(denyOnly.checkModel('new-model'), null);
  assert.match(denyOnly.checkModel('claude-opus'), /rejected/);
  assert.match(denyOnly.checkModel('glm-5.3:batch'), /rejected/);
  assert.match(denyOnly.checkModel(null), /inheritance is blocked/);
  const allowOnly = createSubagentPolicy({ OMPT3_SUBAGENT_DISALLOWED_MODELS: '' });
  assert.match(allowOnly.checkModel('new-model'), /rejected/);
  const off = createSubagentPolicy({ OMPT3_SUBAGENT_ALLOWED_MODELS: '', OMPT3_SUBAGENT_DISALLOWED_MODELS: '' });
  assert.equal(off.active, false);
  assert.match(off.checkTool('task', {}), /native task is disabled/);
  assert.equal(off.checkTool('delegate_task', {}), null);
  assert.equal(off.prompt, '');
});

test('patterns escape regex punctuation and malformed lists fail instead of disabling restrictions', () => {
  const policy = createSubagentPolicy({ OMPT3_SUBAGENT_ALLOWED_MODELS: 'model.1+test[0]', OMPT3_SUBAGENT_DISALLOWED_MODELS: '' });
  assert.equal(policy.checkModel('model.1+test[0]'), null);
  assert.match(policy.checkModel('modelx1test0'), /rejected/);
  for (const value of [',', 'model,', 'model,,other', 'GLM 5.3 Flash', 'model\nother']) {
    assert.throws(() => createSubagentPolicy({ OMPT3_SUBAGENT_ALLOWED_MODELS: value }), /OMPT3_SUBAGENT_ALLOWED_MODELS/);
    assert.throws(() => createSubagentPolicy({ OMPT3_SUBAGENT_DISALLOWED_MODELS: value }), /OMPT3_SUBAGENT_DISALLOWED_MODELS/);
  }
});

test('tool guard checks both T3 aliases, blocks native inheritance, and leaves ordinary tools alone', () => {
  const policy = createSubagentPolicy({});
  for (const name of ['delegate_task', 'mcp__t3-code__delegate_task', 'mcp__t3_code__delegate_task', 'mcp__t3_code_delegate_task']) {
    assert.match(policy.checkTool(name, {}), /target.model explicitly/);
    assert.match(policy.checkTool(name, { target: { model: 'glm-5.3' } }), /rejected/);
    assert.equal(policy.checkTool(name, { target: { model: 'gpt-6.1-sol' } }), null);
  }
  assert.match(policy.checkTool('task', { model: 'gemini-3.8-flash' }), /native task is disabled/);
  assert.equal(policy.checkTool('read', {}), null);
  assert.equal(policy.checkTool('mcp__t3_code__orchestrator_capabilities', {}), null);
});

test('routing preserves live tools across session transitions independently of model restrictions', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const previous = process.env.XDG_CACHE_HOME;
  process.env.XDG_CACHE_HOME = dir;
  try {
    const args = subagentPolicyArgs(createSubagentPolicy({}));
    const source = fs.readFileSync(args[1], 'utf8');
    for (const env of [{}, { OMPT3_SUBAGENT_ALLOWED_MODELS: '', OMPT3_SUBAGENT_DISALLOWED_MODELS: '' }]) {
      const hooks = new Map();
      let tools = ['read', 'task', 'custom-plugin', 'mcp__t3-code__delegate_task'];
      const pi = {
        on: (name, fn) => hooks.set(name, fn),
        getActiveTools: () => tools,
        setActiveTools: async next => { tools = next; }
      };
      vm.runInNewContext(source.replace('export default function', 'function') + '\nompT3SubagentPolicy(pi);', { process: { env }, pi });
      for (const event of ['session_start', 'session_tree', 'before_agent_start']) {
        tools = ['read', 'task', 'custom-plugin', 'mcp__t3-code__delegate_task'];
        await hooks.get(event)();
        assert.deepEqual(tools, ['read', 'custom-plugin', 'mcp__t3-code__delegate_task']);
      }
      const hook = hooks.get('tool_call');
      assert.equal(hook({ toolName: 'task', input: {} }).block, true);
      assert.equal(hook({ toolName: 'mcp__t3_code__delegate_task', input: { target: { model: 'gemini-3.8-flash' } } }), undefined);
    }
  } finally {
    if (previous === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = previous;
  }
});

// An executable bridge fixture exercises the actual transformed call boundary,
// including calls from scripts that invoke registered execute handlers directly.
function bridgeFixture() {
  return [
    'function createMcpClient() { return { callTool: async (...args) => { calls.push(args); return { content: [], structuredContent: { ok: true } }; } }; }',
    'async function start() {',
    '  const endpoint = "mock", token = "mock";',
    '  const pi = { getCommands: () => [], on: () => {} };',
    `  ${GET_COMMANDS_MARKER}`,
    `  ${MCP_CLIENT_MARKER}`,
    '  return client;',
    '}',
    'start();'
  ].join('\n');
}

test('adapted bridge rejects before the MCP call and preserves allowed targets and options', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-bridge-policy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'pi-t3-mcp-extension.ts');
  const cachePath = path.join(dir, 'compat.ts');
  fs.writeFileSync(original, bridgeFixture());
  for (const flags of [['--extension', original], ['-e', original], ['--extension=' + original], ['--hook', original], ['--hook=' + original]]) {
    const adapted = await adaptT3ExtensionArgs(flags, { cachePath, policy: createSubagentPolicy({}) });
    assert.equal(adapted.extensionPath, cachePath);
    assert.ok(adapted.args.some(arg => arg.endsWith(cachePath)));
  }
  const calls = [];
  const client = await vm.runInNewContext(fs.readFileSync(cachePath, 'utf8'), { process: { env: {} }, calls });
  for (const params of [{}, { target: {} }, { target: { model: null } }, { target: { model: 'glm-5.3' } }, { target: { model: 'claude-opus' } }]) {
    const result = await client.callTool('delegate_task', params);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /Subagent model policy/);
  }
  assert.equal(calls.length, 0, 'blocked requests must not reach MCP');
  const params = { task: 'work', target: { providerInstanceId: 'pi', model: 'litellm/gpt-6.1-sol', options: { thinking: 'max' } }, isolation: 'worktree' };
  const signal = new AbortController().signal;
  const result = await client.callTool('delegate_task', params, signal);
  assert.equal(result.structuredContent.ok, true);
  assert.equal(calls[0][1], params, 'model and options must not be silently rewritten');
  assert.equal(calls[0][2], signal);
  await client.callTool('task_status', {});
  assert.equal(calls.length, 2);
  assert.equal(fs.readFileSync(original, 'utf8'), bridgeFixture());
});

test('enforcement refuses drift, unreadable source and an unwritable cache; skill drift keeps the model guard', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ompt3-policy-drift-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const original = path.join(dir, 'pi-t3-mcp-extension.ts');
  const options = { cachePath: path.join(dir, 'compat.ts'), policy: createSubagentPolicy({}), log: () => {} };
  await assert.rejects(adaptT3ExtensionArgs(['--extension', original], options), /cannot read T3 extension/);
  for (const source of [GET_COMMANDS_MARKER, MCP_CLIENT_MARKER + MCP_CLIENT_MARKER]) {
    fs.writeFileSync(original, source);
    await assert.rejects(adaptT3ExtensionArgs(['--extension', original], options), /refusing an unguarded launch/);
  }
  fs.writeFileSync(original, bridgeFixture().replace(GET_COMMANDS_MARKER, 'const commands = [];'));
  const adapted = await adaptT3ExtensionArgs(['--extension', original], options);
  assert.equal(adapted.extensionPath, options.cachePath);
  fs.writeFileSync(original, bridgeFixture());
  await assert.rejects(adaptT3ExtensionArgs(['--extension', original], { ...options, cachePath: path.join(original, 'compat.ts') }), /cannot write T3 extension/);
});
