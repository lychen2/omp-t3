'use strict';

const fs = require('node:fs');
const { execSync } = require('node:child_process');
const pkg = require('../package.json');
const { createSubagentPolicy, subagentPolicyArgs } = require('./subagent_policy.js');

// T3 owns delegated tasks; OMP's live tool selection stays otherwise intact.
const DELEGATION_POLICY = [
  '## Delegation policy (this session runs inside T3 Code)',
  '',
  'In-process subagents are disabled in this session. When the user asks for subagents, delegates, reviewers, or parallel workers — or when a task is large enough to delegate — use the T3 `delegate_task` MCP tool.',
  'Each delegation becomes an isolated, openable T3 thread with its own provider scope; results return to this thread automatically.',
  'Do your own quick, direct work (reads, searches, edits, short commands) with your regular tools instead of delegating.',
  'Keep at most four delegated tasks active as a scheduling convention; T3 owns their lifecycle and cancellation.',
  'Do not attempt to use an in-process `task`-style subagent tool: it is intentionally unavailable here.'
].join('\n');

function appendSystemPrompt(args, text) {
  if (!text) return;
  let found = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--append-system-prompt') {
      args[i + 1] = `${args[i + 1] ?? ''}\n\n${text}`;
      i++;
      found = true;
    } else if (args[i].startsWith('--append-system-prompt=')) {
      args[i] += `\n\n${text}`;
      found = true;
    }
  }
  if (!found) args.push('--append-system-prompt', text);
}

/**
 * Parses incoming CLI arguments and translates them for OMP execution.
 * @param {string[]} argv Raw argv slice (e.g. process.argv.slice(2))
 * @returns {{ action: string, ompArgs?: string[], options?: Record<string, any> }}
 */
function parseArgs(argv) {
  // Self-update subcommand (feature 002 US8). T3's provider maintenance calls
  // `omp-t3 update --self`; per FR2 it must NEVER surface an unknown-option
  // error, so this match runs first, the flags are conserved for the bin
  // layer to interpret, and any other position cannot shadow it.
  if (argv[0] === 'update') {
    return {
      action: 'update',
      options: {
        self: argv.includes('--self'),
        yes: argv.includes('--yes')
      }
    };
  }

  // Check for standalone helper flags
  if (argv.length === 1 || argv.length === 2) {
    if (argv.includes('--version') || argv.includes('-v')) {
      return { action: 'version' };
    }
    if (argv.includes('--help') || argv.includes('-h')) {
      return { action: 'help' };
    }
    if (argv.includes('--check')) {
      return { action: 'check' };
    }
    if (argv.includes('--setup-symlink')) {
      return { action: 'setup-symlink' };
    }
  }

  const acp = argv[0] === 'acp';
  if (acp) argv = argv.slice(1);

  // Rewrite arguments for OMP execution
  const rewritten = [];
  let modeFound = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];

    if (!acp && arg === '--mode') {
      modeFound = true;
      i++; // skip next arg

      // Always force rpc-ui mode for OMP
      rewritten.push('--mode', 'rpc-ui');
    } else if (!acp && arg.startsWith('--mode=')) {
      modeFound = true;
      rewritten.push('--mode=rpc-ui');
    } else if (arg === '--tools' || arg.startsWith('--tools=')) {
      // The routing extension removes only task from the resolved toolset.
      rewritten.push(arg);
      if (arg === '--tools' && i + 1 < argv.length) rewritten.push(argv[++i]);
    } else if (arg === '--append-system-prompt' || arg.startsWith('--append-system-prompt=')) {
      // Preserve user appendices and merge the bridge policies below.
      if (arg === '--append-system-prompt') {
        rewritten.push(arg);
        if (i + 1 < argv.length) rewritten.push(argv[++i]);
      } else {
        rewritten.push(arg);
      }
    } else {
      rewritten.push(arg);
    }
  }

  // If no --mode was specified at all, default to rpc-ui
  if (acp) {
    rewritten.push('--mode', 'acp');
  } else if (!modeFound) {
    rewritten.unshift('--mode', 'rpc-ui');
  }

  const modelPolicy = createSubagentPolicy();
  appendSystemPrompt(rewritten, modelPolicy.prompt);
  appendSystemPrompt(rewritten, DELEGATION_POLICY);
  rewritten.push(...subagentPolicyArgs(modelPolicy));

  return {
    action: acp ? 'acp' : 'proxy',
    ompArgs: rewritten
  };
}


/**
 * Resolves the path to the real omp executable.
 * @returns {string} Absolute path to omp binary
 */
function resolveOmpPath() {
  if (process.env.OMP_PATH && fs.existsSync(process.env.OMP_PATH)) {
    return process.env.OMP_PATH;
  }

  // Try which/where
  try {
    const whichCmd = process.platform === 'win32' ? 'where omp' : 'which omp';
    const resolved = execSync(whichCmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim().split('\n')[0];
    if (resolved && fs.existsSync(resolved)) {
      return resolved;
    }
  } catch {
    // Ignore and fallback to well-known locations
  }

  const commonLocations = [
    '/home/linuxbrew/.linuxbrew/bin/omp',
    '/opt/homebrew/bin/omp',
    '/usr/local/bin/omp',
    '/usr/bin/omp'
  ];

  for (const loc of commonLocations) {
    if (fs.existsSync(loc)) {
      return loc;
    }
  }

  throw new Error('Could not locate "omp" binary in PATH or standard directories. Please set OMP_PATH environment variable.');
}

/**
 * Derives the shim's version identity from package.json.
 *
 * Version scheme: `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (npm-legal
 * encoding of a 4th iteration level; npm rejects literal `1.3.0.1`). The first
 * three segments track the upstream Pi release this shim iteration targets;
 * the prerelease segment is the shim's own publish counter.
 *
 * T3's provider gate parses only the first `\d+\.\d+\.\d+` token of the
 * `--version` output, so we report the Pi base alone on line 1.
 * @param {string} [version] package.json version
 * @returns {{ piBase: string, iteration: string, full: string } | null}
 */
function shimVersionInfo(version = pkg.version) {
  const m = /^(\d+\.\d+\.\d+)(?:-(\d+))?$/.exec(version);
  if (!m) return null;
  return { piBase: m[1], iteration: m[2] || '0', full: version };
}

module.exports = {
  parseArgs,
  resolveOmpPath,
  shimVersionInfo,
  DELEGATION_POLICY
};
