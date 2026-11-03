'use strict';

const path = require('node:path');
const { spawnSync } = require('node:child_process');

// `omp models` accepts only --json/--kind/-e/--extension/--no-extensions/--config.
// Of those, only the overlays below change which models exist.
const CATALOG_FLAGS_WITH_VALUE = new Set(['-e', '--extension', '--config']);
const CATALOG_FLAGS_NO_VALUE = new Set(['--no-extensions']);

/**
 * Derives the model-catalog context of a launch: the binary, the extension and
 * config overlays that add or remove models, the directory omp resolves
 * project config and relative overlay paths against, and the environment that
 * carries the profile, the agent dir, and provider credentials.
 *
 * Flags `omp models` does not take are translated to the supported equivalent:
 * `--cwd` becomes the child's working directory and `--profile` becomes
 * `OMP_PROFILE` (documented as the same setting). Everything else (`--model`,
 * `--session-dir`, `--no-session`, ...) affects the session but not the
 * catalog, so it is not forwarded.
 *
 * @param {{ ompPath?: string, ompArgs?: string[], env?: NodeJS.ProcessEnv, cwd?: string }} [launch]
 * @returns {{ ompPath: string, discoveryArgs: string[], env: NodeJS.ProcessEnv, cwd: string }}
 */
function modelDiscoveryContext({ ompPath = 'omp', ompArgs = [], env = process.env, cwd = process.cwd() } = {}) {
  const args = Array.isArray(ompArgs) ? ompArgs.map(String) : [];
  const discoveryArgs = [];
  const discoveryEnv = { ...env };
  let discoveryCwd = cwd;

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (!arg.startsWith('-')) continue;

    const eq = arg.indexOf('=');
    let flag = eq === -1 ? arg : arg.slice(0, eq);
    let inline = eq === -1 ? null : arg.slice(eq + 1);

    if (inline === null && flag.length > 2 && flag.startsWith('-e') && !flag.startsWith('--')) {
      inline = flag.slice(2); // -e/path/to/extension.js
      flag = '-e';
    }

    if (flag === '--cwd' || flag === '--profile') {
      const value = inline === null ? args[i + 1] : inline;
      if (inline === null) i += 1;
      if (typeof value !== 'string' || value === '') continue;
      if (flag === '--cwd') discoveryCwd = path.resolve(cwd, value);
      else discoveryEnv.OMP_PROFILE = value;
      continue;
    }

    if (CATALOG_FLAGS_WITH_VALUE.has(flag)) {
      const value = inline === null ? args[i + 1] : inline;
      if (inline === null) i += 1;
      if (typeof value !== 'string' || value === '') continue;
      discoveryArgs.push(flag, value);
      continue;
    }

    if (CATALOG_FLAGS_NO_VALUE.has(flag)) discoveryArgs.push(flag);
  }

  return { ompPath, discoveryArgs, env: discoveryEnv, cwd: discoveryCwd };
}

class ModelCatalogManager {
  /**
   * A manager is scoped to exactly one launch context and never serves models
   * discovered for another: the session answer, and the standalone fallback,
   * both describe the same binary, overlays, cwd, and environment.
   *
   * @param {{
   *   onError?: ((err: Error) => void) | null,
   *   ompPath?: string,
   *   ompArgs?: string[],
   *   env?: NodeJS.ProcessEnv,
   *   cwd?: string
   * }} [options] The launch this catalog describes. `onError` is invoked when
   *   discovery cannot produce a catalog (there is no fabricated substitute).
   */
  constructor(options = {}) {
    const {
      onError = null,
      ompPath = 'omp',
      ompArgs = [],
      env = process.env,
      cwd = process.cwd()
    } = options;
    this.onError = onError;
    this.context = modelDiscoveryContext({ ompPath, ompArgs, env, cwd });
  }

  /**
   * Prunes raw OMP model list into safe, compliant ModelInfo objects.
   * Strips large schemas, pricing, and input arrays.
   * Strips redundant provider prefix from model id so T3 Code's slug builder
   * (`${provider}/${id}`) does not produce duplicate prefixes (e.g. openrouter/openrouter/...).
   * @param {any[] | { models: any[] }} rawInput 
   * @returns {any[]}
   */
  pruneModels(rawInput) {
    let list = [];
    if (Array.isArray(rawInput)) {
      list = rawInput;
    } else if (rawInput && Array.isArray(rawInput.models)) {
      list = rawInput.models;
    } else {
      return [];
    }

    return list.map((item) => {
      const provider = item.provider || 'omp';
      let id = item.id || item.selector || '';

      // If id starts with provider prefix (e.g. "openrouter/deepseek/deepseek-v4.1-flash" with provider "openrouter"),
      // strip it so T3 Code doesn't double-prefix it when building `${provider}/${id}`.
      const prefix = `${provider}/`;
      while (id.startsWith(prefix) && id.length > prefix.length) {
        id = id.slice(prefix.length);
      }

      const name = item.name || id || item.id;

      const entry = {
        id,
        name,
        provider
      };

      if (typeof item.contextWindow === 'number') {
        entry.contextWindow = item.contextWindow;
      }
      if (typeof item.maxTokens === 'number') {
        entry.maxTokens = item.maxTokens;
      }
      if (item.reasoning !== undefined) {
        entry.reasoning = Boolean(item.reasoning);
      }
      // T3 requires explicit per-model mappings to offer xhigh/max.
      // CLI discovery returns an array; live RPC returns thinking.efforts.
      const levels = Array.isArray(item.thinking)
        ? item.thinking
        : Array.isArray(item.thinking?.efforts) ? item.thinking.efforts : null;
      if (levels) {
        const map = {};
        for (const level of ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
          map[level] = levels.includes(level) ? level : null;
        }
        entry.thinkingLevelMap = map;
      } else if (item.thinking === true) {
        entry.thinkingLevelMap = { off: null, minimal: null, low: 'low', medium: 'medium', high: 'high' };
      }

      return entry;
    });
  }

  /**
   * Standalone discovery for callers without a live session (`omp-t3 --check`).
   * Throws when the launch context has no usable catalog — it never returns a
   * substitute list.
   * @returns {any[]}
   */
  getModels() {
    const { ompPath, discoveryArgs, env, cwd } = this.context;
    const result = spawnSync(ompPath, ['models', '--json', ...discoveryArgs], {
      encoding: 'utf8',
      maxBuffer: 10 * 1024 * 1024,
      timeout: 8000,
      killSignal: 'SIGKILL',
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    });

    if (result.error) {
      throw this.fail(new Error(`omp models --json could not run: ${result.error.message}`));
    }
    if (result.status !== 0) {
      // omp reports the cause on an `error:` line above its stack trace.
      const stderr = String(result.stderr || '');
      const lines = stderr.split('\n').map((l) => l.trim()).filter(Boolean);
      const detail = lines.find((l) => /^error:/i.test(l)) || lines[0] || `exit ${result.status}`;
      throw this.fail(new Error(`omp models --json failed (${detail})`));
    }

    let parsed;
    try {
      parsed = JSON.parse(result.stdout);
    } catch (err) {
      throw this.fail(new Error(`omp models --json did not print JSON: ${err.message}`));
    }

    const models = this.pruneModels(parsed);
    if (models.length === 0) {
      throw this.fail(new Error('omp models --json listed no models for this context'));
    }
    return models;
  }

  /**
   * Records a discovery failure for the doctor and returns the error, so the
   * caller can throw it.
   * @param {Error} err
   * @returns {Error}
   */
  fail(err) {
    if (typeof this.onError === 'function') {
      try {
        this.onError(err);
      } catch {
        // Never let diagnostics mask the discovery error
      }
    }
    return err;
  }

  /**
   * Synthesizes a T3 Code ModelInfo response for an already discovered list.
   * Includes both data: { models } and models for maximum compatibility.
   * @param {string | number} reqId
   * @param {any[]} models
   * @returns {string} Stringified JSON response with newline
   */
  createModelResponse(reqId, models) {
    if (!Array.isArray(models)) {
      throw new TypeError('createModelResponse requires the models discovered for this context');
    }
    const payload = {
      id: reqId === undefined || reqId === null ? '1' : reqId,
      type: 'response',
      command: 'get_available_models',
      success: true,
      data: {
        models
      },
      models
    };
    return JSON.stringify(payload) + '\n';
  }

  /**
   * Translates T3 Code's get_available_models request into a request for the
   * live omp session. The session answers with the catalog of the context it
   * actually runs in, so no launch flag has to be reconstructed here.
   * @param {string} line
   * @returns {{ intercepted: boolean, forward?: string }}
   */
  handleUpstreamFrame(line) {
    if (!line.includes('get_available_models')) return { intercepted: false };

    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      return { intercepted: false };
    }
    if (!parsed || parsed.type !== 'get_available_models') return { intercepted: false };

    return { intercepted: true, forward: line.endsWith('\n') ? line : line + '\n' };
  }

  /**
   * Rewrites the session's catalog answer into the ModelInfo shape T3 Code
   * consumes. A session error passes through unchanged, and an answer that is
   * not a catalog becomes an explicit failure — never a guessed model list.
   * @param {string} line
   * @returns {{ handled: boolean, line?: string }}
   */
  handleDownstreamFrame(line) {
    if (!line.includes('get_available_models')) return { handled: false };

    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      return { handled: false };
    }
    if (!frame || frame.type !== 'response' || frame.command !== 'get_available_models') {
      return { handled: false };
    }
    if (frame.success === false) {
      return { handled: true, line: line.endsWith('\n') ? line : line + '\n' };
    }

    const raw = frame.data && frame.data.models;
    if (!Array.isArray(raw)) {
      const err = this.fail(new Error(
        `omp get_available_models response carries no data.models array (provider="${this.context.ompPath}")`
      ));
      return {
        handled: true,
        line: JSON.stringify({
          id: frame.id === undefined ? null : frame.id,
          type: 'response',
          command: 'get_available_models',
          success: false,
          error: `omp-t3: ${err.message}`
        }) + '\n'
      };
    }

    return { handled: true, line: this.createModelResponse(frame.id, this.pruneModels(raw)) };
  }
}

module.exports = {
  ModelCatalogManager,
  modelDiscoveryContext
};
