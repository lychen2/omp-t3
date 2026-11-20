<img src="assets/icon.svg" width="64" height="64" alt="omp-t3 icon">

# omp-t3

Run Oh My Pi inside T3 Code. This fork uses T3-owned child threads for all delegated work.

T3 Code includes a provider for upstream Pi. Pointing that provider directly at `omp` breaks three things:

1. Turn settlement. `omp` sends `session_settled` when code generation ends, but T3 Code waits for `agent_settled`. Turns stay stuck in an active state.
2. Tool approvals. T3 Code spawns agents with `--mode rpc`. That flag mutes interactive confirmation dialogs in `omp`, so bash and file approval prompts never appear.
3. Model discovery. `omp` lists more than 500 models across 60 providers in a single RPC response. That payload blows past the 1 MB frame limit and kills the connection.

`omp-t3` translates OMP's stdio protocol for T3's Pi provider: settlement, compaction, approvals, command menus, model discovery, and queue control. T3 creates and persists delegated child threads; the shim preserves OMP's active tools except the native `task` spawner.

---

## Installation

Install this fork directly from GitHub:

```bash
npm install -g github:lychen2/omp-t3
```

For a local checkout:

```bash
git clone https://github.com/lychen2/omp-t3.git
cd omp-t3
npm install -g .
```

The executable remains `omp-t3`. `update --self` reports update instructions;
`update --self --yes` installs from this fork.

---

## Setup in T3 Code

1. Open **Settings** -> **Providers** -> **Pi**.
2. Set **Binary Path** to `omp-t3` (or the full path from `which omp-t3`).
3. Leave **Arguments** blank. `omp-t3` defaults to `--mode rpc-ui` automatically.
4. Click **Refresh** to populate your configured models.
5. Select your model and send a message.

### Native todo list through ACP

In T3 Code, add a local ACP provider with **Command Path** set to the absolute path to `omp-t3` and **Command Arguments** set to `acp`. Open a new thread with this provider. OMP publishes `todo` updates on its native ACP connection, and T3 displays them in its built-in checklist. Existing Pi threads continue using the Pi provider.

---

## Verify your environment

Run the built-in diagnostic check:

```bash
omp-t3 --check
```

The check verifies that:
- The `omp` binary exists in your `$PATH` and responds to CLI queries.
- Model discovery runs and produces a payload well below the 1 MB transport ceiling.
- The session directory link between `~/.pi/agent/sessions` and `~/.omp/agent/sessions` is active, allowing T3 Code's usage view to read historical token metrics.

---

## How it works

```text
+---------------------------------------------+
|                   T3 Code                   |
|  (packages/provider-pi/src/server/adapter)  |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                   omp-t3                    |
|  - Rewrites --mode rpc to --mode rpc-ui     |
|  - Translates session_settled to            |
|    agent_settled (+ pendingMessageCount)    |
|  - Intercepts get_available_models, prunes  |
|    heavy schemas, persists last-known list  |
|  - Answers get_commands discovery probes    |
|  - Strips duplicate provider slugs          |
|  - Maps auto-compaction + synthesizes       |
|    manual /compact event cards              |
|  - Bridges subagent frames into live cards  |
|  - Watches for contract drift (watchdog)    |
|  - Passes diffs, tokens, and bash logs      |
|    through as raw bytes                     |
+---------------------------------------------+
                      ^
                      | stdio (JSONL lines)
                      v
+---------------------------------------------+
|                     omp                     |
|               (local binary)                |
+---------------------------------------------+
```

### Protocol translation

- **CLI rewrite:** Converts incoming `--mode rpc` to `--mode rpc-ui` so `omp` emits permission requests instead of suppressing them.
- **Version reporting:** T3's provider probe runs `--version` and requires a semver >= 0.80.5. The shim versions itself as `<pi-major>.<pi-minor>.<pi-patch>-<iteration>` (e.g. `1.3.0-1`): the first three segments track the upstream Pi release it targets, the prerelease counter is the shim's own publish iteration. `--version` prints the Pi base on line 1 (what T3's gate parses) and the full identity on line 2 — fully offline and instant.
- **Settlement mapping (session mirroring):** Captures `prompt_result` status, catches `session_settled`, and emits `agent_settled` with the right `aborted` boolean so T3 Code marks the turn complete. Injects `pendingMessageCount` (omp's `queuedMessageCount` **plus** `hasPendingAsyncWork`) into `get_state` responses, which T3's settle probe reads — pending background jobs and detached subagents hold the run open exactly as long as omp holds the session unsettled. The T3 run therefore *mirrors* the omp session: omp ends every model cycle (prompt turn, steered reply, background-wake reply) with `agent_end` but withholds `session_settled` while background work is pending, so the run stays open across the pause, the wake cycle delivers its results *into* the still-active run, and the translated `session_settled` finalizes it once drained. **Stop always wins:** an abort while a cycle is open synthesizes the terminal from that cycle's `agent_end`, and an abort of a paused run (no cycle open — no `agent_end` will ever come) synthesizes it immediately, so stopping never hangs. Whether the session's pending work survives a stop is T3's call, not the shim's: a graceful interrupt (no runtime restart) leaves it alive for the thread (verified on the wire against omp 18.12.0), while an interrupt that requests a runtime restart terminates the provider process tree and takes the pending work with it (verified live through T3's thread-interrupt API — the tree dies, no rogues remain, and the next message respawns the provider with full session continuity).
- **Compaction mapping:** Renames omp's `auto_compaction_start`/`auto_compaction_end` frames (auto-compaction mid-run) to the Pi names `compaction_start`/`compaction_end`. omp's method-cascade attempts that end `skipped:true` (no result) are dropped entirely — T3 would otherwise render each as "Context compaction failed". For **manual** `/compact`, omp emits no compaction events at all (its RPC handler answers once when done), so the shim synthesizes the `compaction_start`/`compaction_end` event pair around omp's single response — giving T3 Code a live compaction card instead of silence, and keeping omp's benign "Nothing to compact (session too small)" from failing the whole turn.
- **Session model catalog:** Requests the catalog from the running OMP session, then removes verbose schemas and pricing before forwarding it to T3. Profiles, project settings, environment, and extension-provided models are therefore the session's actual values. `--check` uses standalone discovery with its own launch environment. Discovery failures remain errors; no shared stale or fabricated fallback list is served.
- **Thinking levels:** Converts live RPC `thinking.efforts` and CLI discovery arrays into per-model `thinkingLevelMap` values. T3 offers `xhigh` and `max` when OMP advertises them and excludes unsupported levels.
- **Stop and queue restoration:** T3's `clear_queue` followed by `abort`, or an older client's lone `abort`, maps to OMP's atomic `abort_and_restore_queue`. The clear response returns withdrawn steering/follow-up texts before the aborted settlement. An acknowledged clear is not repeated, and stopped queued messages cannot execute on the next turn.
- **Contract drift watchdog:** Every cleanly settled turn records the working `omp`/shim versions to `~/.local/state/omp-t3/contract-state.json`. If OMP breaks a protocol promise (e.g. stops emitting `session_settled` after announcing settlement) or discovery dies, the shim keeps the turn alive, prints a stderr banner naming the changed side with rollback guidance, and files a rate-limited issue on GitHub with sanitized diagnostics.
- **Slug normalization:** Strips redundant provider prefixes from model IDs, preventing double-slug lookups like `openrouter/openrouter/...` during model selection.
- **Delegated tasks:** Use T3 `delegate_task` with an explicit catalog model. Returned T3 thread links open the actual child conversation. T3 owns results, single-task cancellation, parent Stop, and persisted restart state. Restored native OMP task events retain their tool-card translation.
- **Readable tool cards:** In T3 sessions, tool schemas require the model to supply a brief purpose in `i`. The shim forwards it as `intent` and `displayTitle` on tool events, with the canonical `toolName` and original arguments and results for ordinary tools. Calls without a purpose retain their existing labels. `todo`, `ask` and `ctx` keep their compact start summaries and dedicated presentations. `todo` shows objective/measure/doneWhen, completed and abandoned counts, phase-grouped items, budget, blocker and short commit SHA. `ask` summarizes the questions and formats `details.results` answers, including custom text, notes, timeout auto-selection and the chat redirect. `ctx` summarizes `op`/`id`/`all` and passes the recall text through. The ask implementation packs the clean question text behind an `omp-t3:ask:v1` marker in the extension RPC title when `OMPT3_RPC_PRESENTATION=ask-v1`. The shim decodes it and falls back to a clean `Ask` card on a malformed payload without leaking the blob.
- **Command & skill menu:** Serves T3's `get_commands` polls from OMP's live catalog (cached from OMP's startup push, refreshed on demand): builtins like `/context`, `/stats`, `/usage`, and `/dump` appear in T3's `/` menu as extension commands, and OMP's skills (already named `skill:*`) land in T3's `$` skill menu with `source:"skill"`. OMP's richer source enum is projected onto Pi's `extension`/`prompt`/`skill` enum. When a command runs, OMP's `command_output` frames are re-emitted as rendered text inside the command-only turn — ANSI-stripped and wrapped in a fenced code block, because T3 renders assistant text as markdown (bare newlines collapse; a fence preserves omp's line-oriented bar-chart layout in monospace) — and the turn is settled from OMP's `data.agentInvoked:false` completion signal, which would otherwise hang, since local-only commands never emit `session_settled` and T3's own idle probe is suppressed once output rendered.
- **T3 extension adaptation:** T3 injects its bundled MCP bridge as a pi extension (`--extension …/pi-t3-mcp-extension.ts` plus `T3_PI_MCP_EXTENSION_PATH`). That extension's `$name` skill inliner resolves skills through Pi's `command.sourceInfo.path`, while OMP's in-process commands expose the same file as `command.path`, so on stock OMP every prompt mentioning `$name` crashed the handler and the skill body was never inlined. The shim rewrites that one extension entry to a shim-managed copy under `~/.cache/omp-t3/` (identical source except `getCommands()` projects `command.path` into `sourceInfo.path`) and repoints `T3_PI_MCP_EXTENSION_PATH` at the copy, keeping the extension's tool-ownership identity checks working. If a T3 update changes the extension source so the known marker no longer matches, the original is passed through untouched with a stderr warning — `$name` inlining then degrades to the old crash instead of running stale adapted code. Other extensions and the `get_commands` menu projection are untouched.
- **T3 parent worktree metadata:** The adapted extension exposes a private `omp-t3:parent-cwd:v1` event-bus query to todo-more. Its existing caller-scoped MCP client resolves the current thread, verifies an actual `subagent` relationship, and reads only the immediate parent's worktree or project root. Top-level and forked threads stay independent; unavailable metadata never authorizes a dirty completion. Updated todo-more skips commits only when the verified parent and child share a git worktree, preserving ordinary commits in isolated worktrees. Restart existing provider sessions to load the updated extension.
- **Byte passthrough:** Everything else (token streaming deltas, diff streams, approvals, and terminal signals) passes through without JSON parsing overhead.

## Delegation enforcement

`omp-t3` routes delegated work through T3's `delegate_task`. Its extension reads OMP's actual enabled tools and removes only `task`, including after session-tree restoration and before a turn. Configured plugins, MCP tools, and explicit `--tools` selections remain OMP's responsibility. Startup launches one OMP session without a tool-list probe.

The routing hook remains active when model restrictions are cleared. The lead agent is instructed to keep at most four delegated tasks active; this is a scheduling convention, not a second queue or a shim-enforced semaphore.

### Restricting subagent models

Default allowed models: `gpt-6-astra`, `gpt-6.1-sol`, `gemini-3.8-flash`, `gemini-4-argon`, `deepseek-v4.1-flash`, `gpt-6-lunag`, and `gpt-6.1-terra`. The default denylist is empty. The parent model is unaffected.

Set either variable in the environment inherited by `omp-t3` to replace that list:

```bash
export OMPT3_SUBAGENT_ALLOWED_MODELS='gpt-6-astra,gpt-6.1-sol,gemini-3.8-flash,gemini-4-argon,deepseek-v4.1-flash,gpt-6-lunag,gpt-6.1-terra'
export OMPT3_SUBAGENT_DISALLOWED_MODELS=''
```

Values are comma-separated model IDs or patterns, with `*` as the only wildcard. Matching is case-insensitive and anchored to the whole ID. A rule containing `/` matches the full catalog ID; an unqualified rule matches the final model name. For example, `gpt-6.1-sol` matches `litellm/gpt-6.1-sol`. Deny rules take precedence. Call `orchestrator_capabilities` to select a full, available catalog ID; aliases and version variants require their own rules.

The shim appends these rules to the system prompt on every launch path. A blocking OMP extension checks direct T3 delegation calls, and the adapted T3 MCP client checks again before sending `delegate_task`, including calls through registered tool handlers in scripts. Both T3 tool-name prefixes are covered. Every delegation must set `target.model` explicitly. Omitted, denied, or unlisted models return a tool error before a child starts. Allowed calls retain their provider, model options, and other arguments without rewriting the model.

The routing hook blocks native `task` independently of model restrictions. With a model policy active, unreadable or incompatible bundled T3 extensions and guard-cache failures refuse launch rather than dropping enforcement. Skill-inlining marker drift produces a warning while preserving the model guard.

An explicitly empty value clears that list. An empty allowlist permits any explicit model except those denied; an empty denylist keeps the allowlist. Clearing both disables model restrictions but keeps T3 routing. Restart the provider session after changing its environment.

This policy covers tools in OMP sessions launched through this shim. It is not a T3 server-wide restriction on other providers, top-level conversations, or arbitrary shell commands.

### Runtime verification and limits

Verified with OMP 18.16.0: live catalog discovery, preservation of custom tools,
model-policy enforcement at the MCP boundary, atomic queue withdrawal, and
reopening a stopped session followed by an explicit new prompt. Live T3 delegation
was exercised for child creation, result delivery, and running-task cancellation.

With OMP 18.17.0 and T3 Code 0.1.7, registered tools verified readable persisted cards, original option labels, custom answers, sequential questions, cancellation, finite timeout cleanup, and shared-worktree `DONE` without staging or committing parent changes. An installed RPC error-settlement smoke observed no timer-started turn for 12 seconds while normal stop continuation remained active. Authenticated pixel rendering was not verified; the independent browser required pairing.

T3's server-wide restart recovery and parent-Stop traversal remain T3-owned and
were not exercised by restarting the live server. This shim does not recreate
cancelled children or maintain a separate task database. Current T3 displays
cleared messages in a system notice; its `clear_queue` response accepts text only,
so image attachments are not restored by that interface. Queue withdrawal needs
OMP's `abort_and_restore_queue`; unsupported versions return an error before the
adapter falls back to their plain abort behavior.

## CLI

`omp-t3` handles four helper flags and `update` locally, rewrites `--mode` to `rpc-ui`, and applies [delegation enforcement](#delegation-enforcement). Other arguments pass through to OMP:

| Command | Behavior |
|---|---|
| `omp-t3 --version` | Prints the Pi base version on line 1 (what T3's gate parses) and the full shim identity on line 2. Package-derived, offline, instant. |
| `omp-t3 --check` | Verifies `omp` is reachable, runs test model extraction, validates compatibility signals, and checks the session-directory link. |
| `omp-t3 --setup-symlink` | Creates `~/.pi/agent/sessions` -> `~/.omp/agent/sessions` for T3 Code's historical usage dashboard. |
| `omp-t3 --help` | Prints usage instructions and the T3 Code configuration guide. |

## Provider errors & retries

Occasionally a turn ends with a red **Provider error** card, typically `ECONNRESET: The socket connection was closed unexpectedly` — a mid-stream drop from the model endpoint (e.g. z.ai). What happens next:

1. omp marks the turn failed (`stopReason:"error"`) and the shim passes the failure through faithfully — by design, real failures are never suppressed.
2. T3 Code's own attempt retry re-runs the whole turn cleanly (the completed reply you see is the retry).
3. The red card remains as the thread's record of the failed attempt. It is not an ongoing problem.

omp also has its own session-scoped auto-retry, which omp-t3 deliberately leaves **off**: a mid-stream retry would re-run a response whose partial output is already committed to your thread, duplicating content. T3's attempt retry is the correct recovery layer for mid-stream drops.

## Development

Run unit and integration tests:

```bash
npm test
```

The local `omp-ask-more` and `omp-todo-more` adaptations use revision-pinned Bun patches in `~/.omp/plugins/package.json`. Keep that manifest, `bun.lock` and `patches/` together. From `~/.omp/plugins`, OMP 18.17.0's embedded Bun 1.4.4 can reinstall them without changing resolutions:

```bash
BUN_BE_BUN=1 omp install --frozen-lockfile
```

Use a Bun release that supports lockfile version 2; standalone Bun 1.3.13 does not. A plugin revision update requires a matching patch rather than reusing a patch for the previous revision.

---

## Changelog

Install the fork from GitHub or a local checkout; the npm registry package belongs to the upstream project.

### 1.4.0-6

- T3-owned delegation with independent model restrictions and seven default model choices.
- Live OMP tool selection, removing only `task`; single-session startup without fixed tool lists or native-task concurrency overlays.
- Session-authoritative model discovery and explicit errors instead of cross-context cached or fabricated catalogs.
- Atomic Stop/queue restoration, preserving T3 response IDs and queue-before-settlement ordering.
- Fork installation and explicit self-updates retain the GitHub fork source.
- **Readable `todo`/`ask`/`ctx` cards.** Downstream tool frames gain display-only aliases and readable content, with original names retained in `args.tool`. Todo explanations, commit scopes and shared-worktree notes remain visible. The versioned ask marker decodes to title/message; malformed or oversized payloads become clean, unanswerable errors. Upstream calls, tool IDs and model history stay unchanged.
- **Verified parent-worktree lookup.** The adapted T3 MCP extension answers todo-more's private parent-directory query from actual immediate subagent metadata, independently of model restrictions and without new credentials or registries.

### 1.4.0-5

- **Subagent model restrictions.** Enforces configurable allowlists (`OMPT3_SUBAGENT_ALLOWED_MODELS`) and denylists (`OMPT3_SUBAGENT_DISALLOWED_MODELS`) for subagents launched in OMP sessions, defaulting to AGENTS.md policy: allowed models are `glm-5.3-flash`, `gemini-3.8-flash`, and `deepseek-v4.1-flash`; denied models are `gpt-*sol*`, `*opus*`, `glm-5.3`, and `glm-5.3:*`.
- **Dual-layer policy enforcement.** The policy is appended to the system prompt on all launch paths, an OMP hook intercepts tool execution to block native `task` and direct `delegate_task` calls, and the adapted T3 MCP client wrapper intercepts `delegate_task` before calls leave the process. In-process native `task` is blocked while policy is active; explicit allowed `target.model` is mandatory.
- **Fail-closed adaptation & diagnostic updates.** Unresolvable extension drift or cache failure fails closed with exit code 1 instead of dropping enforcement. `omp-t3 --check` diagnostic inspects policy compilation and prints active rules; `omp-t3 --help` documents environment variables.

### 1.4.0-4

- **Launches validate OMP readiness and preserve user arguments.** Default launches disable native `task` and route delegation to T3, and now prove omp actually started: the shim probes the RPC until it answers `{"type":"ready"}` (bounded at 5000 ms per probe, at most 5 convergence rounds). Probes run in their own Unix process group and are terminated on `SIGINT`/`SIGTERM`/`SIGHUP` or timeout. User-supplied `--append-system-prompt` and `--tools` (space and `=` forms) are preserved and merged with the enforcement injection; `OMPT3_DELEGATE_TASKS=0` opts out entirely; the enforcement fallback relaunches with the caller's original argument list. See [Delegation enforcement](#delegation-enforcement).
- **Self-healing `--tools` enforcement.** The injected list no longer names tools omp rejects: `DEFAULT_TOOLS` is the host-valid 15-tool subset, and a pre-flight prune loop re-probes omp before launch, pruning exactly the names omp rejects (singular or plural, ≤5 rounds). If the list still fails, the shim degrades to stock tooling with a stderr warning — availability over enforcement.
- **Delegation enforcement restored.** The `src/cli.js` fixes (`stripInjectedDelegationArgs`, `DEFAULT_TOOLS`/`DELEGATION_POLICY` exports) lost in a worktree cleanup are re-landed, removing the latent `ReferenceError` and the omp exit-2 launch crash class.
- **Disarm seam proven end-to-end.** The e2e pin drives a pre-abort child through the provenance-scoped cancellation window — armed stragglers cancelled, the same provenance spared after the prompt disarms — so the pin fails if the disarm goes missing. Window docs state the final provenance-only semantics. Troubleshooting record: `Reviews/2026-10-24-workflow-troubleshooting.md`.

### 1.4.0-3
- **Adoption is registry-only.** Task calls the bridge never saw start (mid-turn attach, missed start frames) are adopted for attribution, registry cancellation, and hold-open bookkeeping only — no synthetic status/end frames are emitted onto an id T3 may not hold a card for. This fixes two defects introduced by the previous iteration's open-call adoption: a live status card adopted onto an already-cancelled child after the interrupt (zombie window), and an unseen active bash/wait tool being adopted as a task call, which pointed synthetic card frames at a real, unrelated tool card. Adopted ids are tracked in a separate set and can never capture parentless frames via the sole-task-call fallback. **Recorded trade-off:** mid-turn-attached children no longer render live status lines — they remain tracked, counted toward hold-open notices, and are cancelled at interrupt.
- **Cancellation window is provenance-scoped.** After an interrupt (`abort` or the combined `abort_and_prompt`), the sweep records every task-call id known at that moment; while the window is armed (until the next plain prompt), only children belonging to those pre-interrupt calls — with proven ownership — are cancelled on observation. Children of calls opened or adopted after the abort are never cancelled: adoption is not proof of age, and killing a new-turn child is worse than letting a rare old-run straggler finish (it stays tracked, counted toward hold-open, and reconciled post-settle). This fixes the previous iteration's silent no-op on `abort_and_prompt` without re-introducing over-cancellation. A proxy-layer pin drives the seam end-to-end: armed-window stragglers are cancelled, and the same provenance is spared after the prompt disarms.
- **Hygiene:** unpredictable overlay `.tmp` names with cleanup on every failure path; `childIn` stream error listener so a late window-cancel can never kill the shim; `resolveCallId`/`adoptUnseenCall` doc blocks rewritten to the current trust rule; README historical entries reworded. (The `Number.isSafeInteger` cap guard ships in 1.4.0-2, not here.)

### 1.4.0-2

- **Unseen-parent adoption (later superseded).** Task calls the bridge never saw start (shim attached mid-turn) were adopted with open-call rendering and interrupt coverage. Superseded in 1.4.0-3 by registry-only adoption — same tracking and cancellation, without synthesizing frames onto unverified ids.
- **Post-abort cancellation window.** Straggler children surfacing after the interrupt sweep are cancelled on observation instead of running to completion.
- **Hygiene:** `Number.isSafeInteger` cap guard, stderr-warning test coverage, stale comment/doc fixes.

### 1.4.0-1

- **Quick tasks render as tool cards, not fake agents.** omp's `task` subagents no longer masquerade as T3 subagent cards: the `task`→`subagent` rename and `details.results[]` synthesis are gone (task frames pass through byte-identical), and each `task` call instead streams a compact live status line inside its own tool card (child names, models, narration, done/live counts). The interrupt sweep now closes every open task card with one synthetic `tool_execution_end` instead of per-child terminal updates — the phantom-row and zombie-row bug classes (whose root was T3's per-child subagent node keys) are structurally impossible for a generic tool card. Attribution, the live-child registry, `cancel_subagent` hard-kills, hold-open counts, and `get_subagents` reco…
- **Subagent concurrency cap (`OMPT3_MAX_SUBAGENTS`).** Opt-in `--config` overlay setting omp's `task.maxConcurrency` (native semaphore queues excess spawns; omp also tells the lead agent the limit in its system prompt). Recommended 5 — native subagents are short parallel workers; see [Limiting concurrent subagents](#limiting-concurrent-subagents). The per-value atomic overlay file (`subagent-limits-<N>.yml`, temp+rename) also ships here.

### 1.4.0

- **Interrupting a run stops its subagents — on both sides.** T3's Pi adapter finalizes a run on `agent_settled` without sweeping open subagent rows and drops every later frame, so an interrupt used to leave subagent rows `running` forever in T3's database while omp kept executing the detached children invisibly (live incident: 10 gatekeeper-panel subagents stuck as zombies after a Stop). The shim now sweeps synchronously on the upstream `abort`: every live child card is terminalized first (`finished:true, stopReason:"aborted"` → T3 renders *interrupted*) — strictly before the settle synthesis, inside the window where T3's turn still accepts frames — and omp receives one `cancel_subagent` hard-kill per live child before the abort is forwarded. This mirrors how T3's own Codex adapter propagates a parent interrupt down to child turns. Verified against omp 18.12.6 on the wire (`cancel_subagent` returns `cancelled:false` for already-dead children, so races are harmless).
- **Active subagents reconcile against omp's authoritative snapshot.** The bridge now queries `get_subagents` (single-flight, rate-limited, bridge-internal `ompt3-sub-` ids) when the subagent subscription activates, when a new `task` tool call opens, and whenever a run is held open for pending work. The snapshot merges by child id under the same parent-attribution rules as events: it heals spawns the event stream missed and keeps names, model identities, and narration current — and it can never un-finish a child an event already terminalized. All bridge-internal responses are suppressed from T3. (Card-era entry: since 1.4.0-1 these details render in the task card's status line; the registry no longer tracks mandate text or exit codes.)
- **Subagent status mapping completed.** omp's `failed` subagent status now maps to a failed outcome (`stopReason:"error"`) instead of hanging the child at *running* forever — card-era entry; since 1.4.0-1 failed children surface as "N failed/aborted" in the task card's status line.

### 1.3.0-5

- **Runs mirror the omp session instead of settling at the first cycle boundary.** The previous cycle-boundary settle (1.3.0-4) ended the T3 run while background jobs and detached subagents were still pending — and everything that keeps that work alive (the omp process tree) dies whenever T3 tears the run down: stop with runtime restart, thread close, rollback, an unsolicited-activity guard after any prior stop, or three failed settle probes. Live-verified kill test: a pending `sleep 25` background job never wrote its output after the shim was SIGTERM'd or SIGKILL'd. The shim now holds `agent_settled` until omp's real `session_settled`: `get_state` enrichment counts pending async work (`pendingMessageCount = queuedMessageCount + (hasPendingAsyncWork ? 1 : 0)`), so T3's settle probe keeps the run open across the pause, omp's wake cycle streams its results *into* the still-active run, and the drain finalizes it exactly once.
- **Stop always wins — instantly.** An abort during an active cycle synthesizes the terminal from that cycle's `agent_end` (T3 finalizes interrupted turns on `agent_settled`; omp sends no `session_settled` after an abort while work remains). An abort of a paused run — no cycle open, so no `agent_end` will ever arrive — synthesizes the terminal immediately from the upstream frame. Either way the stop is instant; verified live against omp 18.12.0 through `bin/omp-t3`. One boundary worth knowing: T3 interrupts that request a runtime restart terminate the provider process tree, so pending work dies with the tree (verified live through T3's thread-interrupt API — no rogues left behind, and the next message respawns the provider with full session continuity); only graceful interrupts leave pending work running for the thread.
- **Fallback settle tightened.** The `prompt_result`-based settle now fires only for turns whose agent frames were never observed (shim attached mid-turn) *and* only when omp does not report pending work (`sessionSettled !== false`) — turns that ran real cycles settle exactly once, from `session_settled`.

### 1.3.0-4

- **`$name` skill mentions inline instead of crashing.** T3's bundled MCP extension resolves `$name` skill mentions through `command.sourceInfo.path`, but omp's in-process commands expose the same file as `command.path`, so on stock omp every prompt mentioning a skill threw "undefined is not an object" and the skill body was never inlined. The shim now launches a content-addressed adapted copy of that extension (under `~/.cache/omp-t3/`) whose `getCommands()` view projects `command.path` into `sourceInfo.path`, and repoints `T3_PI_MCP_EXTENSION_PATH` so the extension's tool-ownership identity check keeps matching. If a T3 update drifts the extension source, the original passes through with a stderr warning instead of running stale adapted code. Verified live against omp 18.11.3; commands that already carry `sourceInfo` (omp 18.4.4) pass through untouched.
- **Runs no longer hang while background work is pending.** omp ends each model cycle with `agent_end` but only emits `session_settled` once *all* background jobs and detached subagents have drained — and it announces that condition as `prompt_result.sessionSettled:false`, which the shim's watchdog intentionally ignores (it only fires on broken promises, i.e. `sessionSettled:true` with no settle). Any turn that left a background job running (dev servers, watchers, auto-backgrounded long commands) therefore kept its T3 run active forever; steering only appeared to fix it when the pending work happened to drain. The shim now tracks omp's `agent_start`/`agent_end` cycles and synthesizes the terminal `agent_settled` at each cycle boundary, so the foreground turn completes the moment the assistant stops talking. Duplicate settles are safe: T3's settle probe is generation-guarded and finalizes once.
- **Background results reactivate the thread.** With the foreground turn settled, T3 goes idle while omp's job keeps running. When the job finishes, omp wakes with a new `agent_start` cycle; T3 buffers those events and opens a provider continuation ("Background task completed."), adopts the wake turn, and the wrap-up response streams and settles normally — end-to-end verified against live omp 18.11.3 through `bin/omp-t3` (sleep-75 background job: cycle settle at `agent_end`+0.1s, steer settled mid-window, drain → wake → settle, zero raw `session_settled`/`prompt_result` frames leaked).
- **Fallback settle for prompt-only turns.** If a turn's `prompt_result` carries `agentInvoked:true` but no `agent_end` was observed (shim attached mid-turn), the settle is synthesized from the `prompt_result` itself instead of waiting for a `session_settled` that may never come.
- Matched `agent_start`/`agent_end` by top-level type only — `subagent_event` payloads embed child `agent_end` events and must still reach the subagent bridge.

### 1.3.0-3

- **Skills in T3's `$` menu.** OMP's skill catalog (26 skills, named `skill:*`) is now served through `get_commands` with Pi's `source:"skill"`, so they appear in T3 Code's `$` skill picker and run through `prompt` like native skills. Previously the shim answered every `get_commands` with an empty list, leaving both menus empty.
- **OMP builtins in T3's `/` menu.** `/context`, `/stats`, `/usage`, `/dump`, `/jobs`, and the rest of OMP's builtin/custom/extension commands appear in T3's slash menu (mapped to Pi's `extension` source; markdown-backed `custom`/`file` commands map to `prompt`).
- **Local command output renders in T3.** OMP runs builtin slash commands locally and emits `command_output` frames T3 knows nothing about; the shim re-emits each as rendered text inside the command-only turn, ANSI-stripped and wrapped in a fenced code block so T3's markdown renderer keeps omp's aligned bar-chart layout instead of collapsing newlines into a run-on paragraph.
- **Local-only commands settle.** OMP completes local commands with `data.agentInvoked:false` on the RPC response — no `prompt_result`, no `session_settled` — and T3's own idle probe is suppressed once a turn renders output. The shim synthesizes the terminal `agent_settled` from that signal, so `/context` no longer leaves the turn active forever.
- `get_commands` answers now echo the caller's request id with its original JSON type (numeric ids were previously stringified).
