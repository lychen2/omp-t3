'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseArgs } = require('../src/cli.js');

test('enforcement: an explicit --tools list wins over the injected one', () => {
  const { ompArgs } = parseArgs(['--tools', 'read,bash', '--mode', 'rpc']);
  const lists = ompArgs.filter((a) => a === 'read,bash');
  assert.equal(lists.length, 1, 'user list kept, no injected list');
  assert.equal(ompArgs.includes('read,bash,edit,write,grep,glob,lsp,python,notebook,browser,todo,web_search,ask'), false);
});

test('enforcement: --tools=<value> form also suppresses injection', () => {
  const { ompArgs } = parseArgs(['--tools=read', '--mode', 'rpc']);
  const toolFlags = ompArgs.filter((a) => a.startsWith('--tools'));
  assert.equal(toolFlags.length, 1, 'exactly one tools flag');
  assert.equal(toolFlags[0], '--tools=read', 'user list kept verbatim');
});

test('enforcement: a user appendix is preserved and the policy is merged into one flag', () => {
  const { ompArgs } = parseArgs(['--append-system-prompt', 'be terse', '--mode', 'rpc']);
  const idx = ompArgs.indexOf('--append-system-prompt');
  assert.notEqual(idx, -1);
  const value = ompArgs[idx + 1];
  assert.ok(value.startsWith('be terse'), 'user appendix first');
  assert.ok(value.includes('Delegation policy'), 'policy merged after it');
  assert.equal(ompArgs.filter((a) => a === '--append-system-prompt').length, 1, 'single flag');
});

test('enforcement: --append-system-prompt=<value> form is merged too', () => {
  const { ompArgs } = parseArgs(['--append-system-prompt=be terse', '--mode', 'rpc']);
  const prompts = ompArgs.filter((a) => a.startsWith('--append-system-prompt'));
  assert.equal(prompts.length, 1, 'exactly one appendix flag');
  const value = prompts[0].slice('--append-system-prompt='.length);
  assert.ok(value.startsWith('be terse'), 'user appendix preserved');
  assert.ok(value.includes('Delegation policy'), 'policy merged');
});

