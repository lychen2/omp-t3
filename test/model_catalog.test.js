'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { ModelCatalogManager, modelDiscoveryContext } = require('../src/model_catalog.js');

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Writes an executable stand-in for the omp binary that records the argv, cwd,
 * and catalog-relevant env it was invoked with, then prints `stdout` and exits
 * with `code`.
 */
function writeFakeOmp(dir, { stdout = '{"models":[]}', stderr = '', code = 0 } = {}) {
  const file = path.join(dir, 'fake-omp');
  const record = path.join(dir, 'record.json');
  fs.writeFileSync(file, `#!/usr/bin/env node
const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(record)}, JSON.stringify({
  argv: process.argv.slice(2),
  cwd: process.cwd(),
  agentDir: process.env.PI_CODING_AGENT_DIR || null,
  profile: process.env.OMP_PROFILE || null
}));
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${code});
`);
  fs.chmodSync(file, 0o755);
  return {
    ompPath: file,
    readRecord: () => JSON.parse(fs.readFileSync(record, 'utf8'))
  };
}

const RAW_MODELS = [
  {
    provider: 'zai',
    id: 'glm-5.3-flash',
    selector: 'zai/glm-5.3-flash',
    name: 'GLM 5.3 Flash',
    contextWindow: 1048576,
    maxTokens: 131072,
    reasoning: true,
    thinking: ['low', 'high', 'max'],
    cost: { input: 0.1, output: 0.2 },
    pricingStatus: 'fixed'
  },
  {
    provider: 'anthropic',
    id: 'claude-3-5-sonnet',
    selector: 'anthropic/claude-3-5-sonnet',
    name: 'Claude 3.5 Sonnet',
    contextWindow: 200000,
    maxTokens: 8192,
    reasoning: true,
    thinking: ['high'],
    cost: { input: 3, output: 15 },
    pricingStatus: 'fixed'
  }
];

test('ModelCatalogManager prunes models safely and keeps required fields', () => {
  const manager = new ModelCatalogManager();

  const pruned = manager.pruneModels(RAW_MODELS);
  assert.equal(pruned.length, 2);

  const m1 = pruned[0];
  assert.equal(m1.id, 'glm-5.3-flash');
  assert.equal(m1.name, 'GLM 5.3 Flash');
  assert.equal(m1.provider, 'zai');
  assert.equal(m1.contextWindow, 1048576);
  assert.equal(m1.maxTokens, 131072);
  assert.equal(m1.reasoning, true);
  assert.deepEqual(m1.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: null, high: 'high', xhigh: null, max: 'max'
  });
  assert.equal(m1.thinking, undefined); // boolean form is ignored by T3; map emitted instead
  assert.equal(m1.cost, undefined); // pruned
  assert.equal(m1.pricingStatus, undefined); // pruned
});

test('live RPC effort capabilities retain xhigh and max without offering unsupported levels', () => {
  const manager = new ModelCatalogManager();
  const result = manager.handleDownstreamFrame(JSON.stringify({
    id: 'effort-catalog',
    type: 'response',
    command: 'get_available_models',
    success: true,
    data: { models: [{
      provider: 'litellm',
      id: 'gpt-6.1-sol',
      reasoning: true,
      thinking: {
        mode: 'effort',
        efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
        defaultLevel: 'low'
      }
    }] }
  }));
  const model = JSON.parse(result.line).data.models[0];
  assert.deepEqual(model.thinkingLevelMap, {
    off: null, minimal: null, low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', max: 'max'
  });
});

test('ModelCatalogManager strips redundant provider prefix from model id', () => {
  const manager = new ModelCatalogManager();
  const rawModels = [
    {
      provider: 'openrouter',
      id: 'openrouter/deepseek/deepseek-v4.1-flash',
      selector: 'openrouter/deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash'
    },
    {
      provider: 'openrouter',
      id: 'deepseek/deepseek-v4.1-flash',
      selector: 'openrouter/deepseek/deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash'
    }
  ];

  const pruned = manager.pruneModels(rawModels);
  assert.equal(pruned[0].id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(pruned[0].provider, 'openrouter');
  assert.equal(pruned[1].id, 'deepseek/deepseek-v4.1-flash');
  assert.equal(pruned[1].provider, 'openrouter');
});

test('ModelCatalogManager forwards the model request to the session and prunes its answer', () => {
  const manager = new ModelCatalogManager();
  const request = '{"type": "get_available_models", "id": 7}';

  const upstream = manager.handleUpstreamFrame(request);
  assert.equal(upstream.intercepted, true);
  assert.equal(upstream.forward, request + '\n');

  const answer = JSON.stringify({
    id: 7,
    type: 'response',
    command: 'get_available_models',
    success: true,
    data: { models: RAW_MODELS }
  });
  const downstream = manager.handleDownstreamFrame(answer);
  assert.equal(downstream.handled, true);

  const response = JSON.parse(downstream.line);
  assert.equal(response.id, 7); // original JSON type is preserved: T3 correlates by value
  assert.equal(response.type, 'response');
  assert.equal(response.command, 'get_available_models');
  assert.equal(response.success, true);
  assert.deepEqual(response.models.map((m) => m.id), ['glm-5.3-flash', 'claude-3-5-sonnet']);
  assert.deepEqual(response.data.models, response.models);
  assert.equal(response.models[0].cost, undefined);
  assert.equal(response.models[0].pricingStatus, undefined);
});

test('ModelCatalogManager keeps the rewritten catalog under the frame limit', () => {
  const manager = new ModelCatalogManager();
  const raw = Array.from({ length: 100 }, (_, i) => ({
    provider: 'provider' + i,
    id: 'model-' + i,
    name: 'Model ' + i,
    contextWindow: 128000,
    maxTokens: 8192,
    reasoning: true,
    thinking: ['low', 'high'],
    cost: { input: 1, output: 2 },
    api: 'openai-completions',
    baseUrl: 'https://example.invalid/' + i
  }));
  const answer = JSON.stringify({
    id: 'req-123',
    type: 'response',
    command: 'get_available_models',
    success: true,
    data: { models: raw }
  });

  const { line } = manager.handleDownstreamFrame(answer);
  const parsed = JSON.parse(line);
  assert.equal(parsed.models.length, 100);
  assert.equal(parsed.models[0].baseUrl, undefined);
  assert.equal(parsed.models[0].api, undefined);

  const payloadSize = Buffer.byteLength(line, 'utf8');
  assert.ok(payloadSize < 500 * 1024, `Payload size ${payloadSize} should be under 500KB`);
});

test('ModelCatalogManager passes a session failure through instead of substituting models', () => {
  const manager = new ModelCatalogManager();
  const failure = JSON.stringify({
    id: 'req-9',
    type: 'response',
    command: 'get_available_models',
    success: false,
    error: 'model registry unavailable'
  });

  const result = manager.handleDownstreamFrame(failure);
  assert.equal(result.handled, true);
  assert.deepEqual(JSON.parse(result.line), JSON.parse(failure));
});

test('ModelCatalogManager answers an unrecognized catalog shape with an explicit failure', () => {
  const reported = [];
  const manager = new ModelCatalogManager({ onError: (err) => reported.push(err) });

  const result = manager.handleDownstreamFrame(JSON.stringify({
    id: 'req-10',
    type: 'response',
    command: 'get_available_models',
    success: true,
    data: {}
  }));

  assert.equal(result.handled, true);
  const response = JSON.parse(result.line);
  assert.equal(response.id, 'req-10');
  assert.equal(response.success, false);
  assert.match(response.error, /data\.models/);
  assert.equal(response.models, undefined);
  assert.equal(reported.length, 1);
  assert.match(reported[0].message, /data\.models/);
});

test('ModelCatalogManager leaves unrelated frames untouched', () => {
  const manager = new ModelCatalogManager();
  assert.deepEqual(manager.handleUpstreamFrame('{"type": "prompt", "message": "get_available_models"}'), { intercepted: false });
  assert.deepEqual(manager.handleUpstreamFrame('{"type": "set_model", "modelId": "x"}'), { intercepted: false });
  assert.deepEqual(manager.handleDownstreamFrame('{"type": "message_update", "text_delta": "hi"}'), { handled: false });
});

test('ModelCatalogManager discovers through the launch context overlays and cwd', () => {
  const dir = tempDir('omp-t3-catalog-ctx-');
  try {
    const fake = writeFakeOmp(dir, { stdout: JSON.stringify({ models: RAW_MODELS }) });
    const launchDir = path.join(dir, 'launch');
    const projectDir = path.join(dir, 'project');
    fs.mkdirSync(launchDir);
    fs.mkdirSync(projectDir);

    const manager = new ModelCatalogManager({
      ompPath: fake.ompPath,
      ompArgs: [
        '--mode', 'rpc-ui',
        '--model', 'gpt-6-astra',
        '--session-dir', path.join(dir, 'sessions'),
        '-e', './t3-extension.js',
        '--extension=./other-extension.js',
        '--no-extensions',
        '--config', './overlay.yml',
        '--cwd', projectDir,
        '--profile', 'work'
      ],
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(dir, 'agent') },
      cwd: launchDir
    });

    const models = manager.getModels();
    assert.deepEqual(models.map((m) => m.id), ['glm-5.3-flash', 'claude-3-5-sonnet']);

    const record = fake.readRecord();
    assert.deepEqual(record.argv, [
      'models', '--json',
      '-e', './t3-extension.js',
      '--extension', './other-extension.js',
      '--no-extensions',
      '--config', './overlay.yml'
    ]);
    assert.equal(record.cwd, projectDir);
    assert.equal(record.agentDir, path.join(dir, 'agent'));
    assert.equal(record.profile, 'work');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCatalogManager defaults discovery to the unmodified launch environment', () => {
  const dir = tempDir('omp-t3-catalog-default-');
  try {
    const fake = writeFakeOmp(dir, { stdout: JSON.stringify({ models: RAW_MODELS }) });
    const manager = new ModelCatalogManager({
      ompPath: fake.ompPath,
      ompArgs: ['--mode', 'rpc-ui'],
      env: { ...process.env, OMP_PROFILE: '' },
      cwd: dir
    });

    manager.getModels();
    const record = fake.readRecord();
    assert.deepEqual(record.argv, ['models', '--json']);
    assert.equal(record.cwd, dir);
    assert.equal(record.profile, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCatalogManager fails explicitly when the context has no catalog', () => {
  const dir = tempDir('omp-t3-catalog-empty-');
  try {
    const empty = writeFakeOmp(path.join(dir), { stdout: '{"models":[]}' });
    const reported = [];
    const manager = new ModelCatalogManager({
      ompPath: empty.ompPath,
      onError: (err) => reported.push(err)
    });
    assert.throws(() => manager.getModels(), /listed no models/);
    assert.equal(reported.length, 1);

    const broken = writeFakeOmp(path.join(dir), { stdout: '', stderr: 'boom\n', code: 3 });
    const brokenManager = new ModelCatalogManager({ ompPath: broken.ompPath });
    assert.throws(() => brokenManager.getModels(), /failed \(boom\)/);

    const missing = new ModelCatalogManager({ ompPath: path.join(dir, 'no-such-omp') });
    assert.throws(() => missing.getModels(), /could not run/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('ModelCatalogManager never serves one context the catalog of another', () => {
  const dir = tempDir('omp-t3-catalog-scope-');
  try {
    const good = writeFakeOmp(path.join(dir), { stdout: JSON.stringify({ models: RAW_MODELS }) });
    const discovered = new ModelCatalogManager({ ompPath: good.ompPath }).getModels();
    assert.equal(discovered.length, 2);

    const other = path.join(dir, 'other');
    fs.mkdirSync(other);
    const empty = writeFakeOmp(other, { stdout: '{"models":[]}' });
    const otherManager = new ModelCatalogManager({ ompPath: empty.ompPath });
    assert.throws(() => otherManager.getModels(), /listed no models/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('modelDiscoveryContext keeps catalog overlays and translates the rest', () => {
  const context = modelDiscoveryContext({
    ompPath: '/opt/omp',
    ompArgs: ['-e/abs/ext.js', '--config', 'a.yml', '--config=b.yml', '--no-extensions', '--cwd', 'sub', '--profile=ops'],
    env: { PATH: '/usr/bin' },
    cwd: '/work'
  });

  assert.equal(context.ompPath, '/opt/omp');
  assert.deepEqual(context.discoveryArgs, [
    '-e', '/abs/ext.js',
    '--config', 'a.yml',
    '--config', 'b.yml',
    '--no-extensions'
  ]);
  assert.equal(context.cwd, path.resolve('/work', 'sub'));
  assert.equal(context.env.OMP_PROFILE, 'ops');
  assert.equal(context.env.PATH, '/usr/bin');
});

test('ModelCatalogManager response builder requires the discovered models', () => {
  const manager = new ModelCatalogManager();
  assert.throws(() => manager.createModelResponse('r1', '/some/omp/path'), TypeError);

  const response = JSON.parse(manager.createModelResponse('r1', [{ id: 'm', name: 'M', provider: 'p' }]));
  assert.equal(response.id, 'r1');
  assert.equal(response.success, true);
  assert.deepEqual(response.models, [{ id: 'm', name: 'M', provider: 'p' }]);
});
