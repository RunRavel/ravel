# Ravel — Architecture

How the runtime works, module by module. For team-file formats see
[authoring-teams.md](./authoring-teams.md); for agent-facing conventions see the
repo-root [CLAUDE.md](../CLAUDE.md).

## The model

A team is a **folder tree**: each folder with an `agent.md` is an agent; subfolders
are its reports; `processes/*.process.md` are the playbooks the owning agent runs.
The runtime compiles that tree into a registry, spawns an `AgentRuntime` per node,
and executes processes as **orchestrated runs**: the owner plans with an LLM,
dispatches tasks to workers, and finishes against a `definitionOfDone` under a
budget.

```
folder tree ──compile──▶ RegistrySnapshot ──apply──▶ live agents
                                                        │
   process run:  owner (planner LLM) ──PlannedTask──▶ worker.runTask ──tools──▶ …
                     ▲                                        │
                     └── task.finished (summary, usage) ──────┘
```

## Modules

### `control-plane/`
- `registry.ts` — `compileRegistry(root)`: walks the folder tree, validates
  `agent.md` / `tools.json` / processes against the zod schemas, records an optional
  team `plugin.ts` path (never imports it at compile), and produces a
  `RegistrySnapshot` (nodes with parent/child ids + processes).
- `watcher.ts` — chokidar watch → recompile → emit snapshot (hot reload of config;
  invalid edits are audited and do not take the org down).

### `schemas/`
Zod schemas + frontmatter parsing for the three file types. Key enums:
- agent `autonomy`: `orchestrated | bounded`; `model`: `opus | sonnet | haiku`.
- process `trigger`: `manual | schedule(cron) | event` (event reserved).
- tool `policy`: `auto | ask | deny`; `builtins`: `readonly | none`.

### `platform/app.ts`
`App` is the composition root and the **embedding surface**: audit, proposals,
approvals, executor, kill switch, bus, memory, plugins, secrets, lifecycle,
orchestrator, observer, watcher. Public methods: `start/stop`, `runProcess`,
`chat`, `pendingProposals/resolveProposal`, `kill/clearKill`, `dashboard`.
Note: `start()` serializes the initial snapshot apply through the same `applyChain`
the watcher uses — plugin load + action registration are settled before it returns.

### `runtime/`
- `engine.ts` — the `AgentEngine` interface (`EngineRequest` → `EngineResult`); the
  seam for LLM backends.
- `sdkEngine.ts` — production engine on the Claude Agent SDK: builds MCP servers
  (declared `mcpServers` from tools.json + in-process `office`, generic `mem`, and
  the team `plugin` server), enforces permission decisions via `canUseTool`, streams
  tool events, tracks usage/cost.
- `fakeEngine.ts` — scripted engine for tests (FIFO programs, `ctx.useTool`).
- `agent.ts` — `AgentRuntime`: per-node execution, budget slicing, abort via kill
  switch, live `activity`, task lifecycle events, plugin resolution
  (`plugins.forNode`, env resolution from the node's `.env` chain).
- `officeTools.ts` / `officeActions.ts` — built-in file/workspace tools.

### `orchestrator/`
- `planner.ts` — the owner's planning prompt → `PlannedTask[]` (assignee role, goal,
  definitionOfDone, per-task budget).
- `orchestrator.ts` — the run loop: plan → dispatch → collect → repeat until done /
  turn cap / budget; per-run shared workspace for deliverables.

### `memory/`
- `store.ts` — file-backed `MemoryStore` with scopes `agent | team | org`
  (`memory/team/<managerNodeId>/<key>.md`). Team scope is shared manager ↔ direct
  reports (`managerScopeOf`).
- `genericTools.ts` — the `mem_*` MCP tools (text / json / queue with dedup + cap) +
  helpers (`queueAppend`, `queueClear`, `resolveScope`) reused by plugins.
- `kv.ts` — in-process locks + JSON read/write primitives.

### `plugins/`
Team-provided code tools. A team root's `plugin.ts` default-exports
`definePlugin({ name, env?, tools?, actions? })`:
- `tools` become an in-process MCP server (`plugin`), gated per-agent by `tools.json`
  grants; handlers get `ctx: { memory, teamScope, nodeId, cwd, env }`.
- `actions` register on the executor — the other half of a **gated tool** (same name,
  `policy: "ask"`): tool call → Proposal → human approves → action runs.
- **Inheritance:** `PluginRegistry.forNode` walks up to the nearest ancestor that
  declares a plugin; `all()` returns owning nodes only (actions register once).
- Plugin code is imported once per process; code changes need a restart.

### `trust/`
- `audit.ts` — append-only `AuditEvent` log (JSONL on disk; in-memory for tests);
  everything flows through it. `emittingAudit.ts` tees to SSE.
- `approval.ts` / `proposals.ts` — deferred approvals: a denied-at-runtime gated call
  becomes a durable Proposal; `executor.ts` runs the registered handler on approval.
- `killswitch.ts` — prefix-scoped abort (`"team"` matches `team/*`; `"*"` = all),
  sticky until cleared.
- `observability.ts` — dashboard snapshot (usage, per-agent state, runs, proposals).
- `budget.ts` / `domain/pricing.ts` — $ + turn metering per task/run.

### `messaging/`
- `bus.ts` — inter-agent message bus: routes structured messages along the org
  topology (parent ↔ child), audits every send, and dead-letters anything
  unroutable. `inbox.ts` — per-agent durable inboxes (optionally persisted under
  the runtime dir).

### `service/`
- `server.ts` — the local HTTP+SSE API: org, dashboard, processes/run, runs (+events,
  files, stop/dismiss), proposals, chat, generic memory tree (`/api/mem/*`), secrets
  (names only), config authoring (`/api/files` + validate), scheduler CRUD. Non-`/api`
  GETs serve the built operator console (`ui/dist`) when it exists — one port for API
  + console. UI development uses the Vite dev server (`cd ui && npm run dev`) instead.
- **Worker contract** (what a hosting platform may rely on): the server only
  starts listening after `App.start()` completes, so a 2xx from `GET /api/health`
  means the org is compiled, plugins are loaded, and runs can be accepted. A fatal
  boot error exits non-zero (it never hangs). `SIGTERM` and `SIGINT` both shut
  down gracefully (close server, `app.stop()`). `--state-dir` separates runtime
  state from the config checkout; `--read-only-config` disables `PUT /api/files`
  and `PUT /api/secrets` (403) for workers whose config plane is git. The server
  binds `127.0.0.1` by default (the API is auth-free); containerized workers
  behind a gateway pass `--host 0.0.0.0`. CORS is granted to loopback origins only.
  `GET /api/validate` and `PUT /api/files` return **both** compile errors and
  advisory lint warnings — `{ ok, diagnostics: [{ where, message, severity?, code? }] }`
  (see [config-format.md](./config-format.md)) — so a platform can gate a deploy
  or surface config health without scraping logs. `--log-format json` (or
  `RAVEL_LOG_FORMAT=json`) makes the `-v` stream, and every line the process
  itself emits (startup banner, warnings, the crash guard), NDJSON with a
  `level` — the shape a log aggregator (Datadog/CloudWatch/Loki) expects from
  a long-running service. `ravel.json`'s `runtimeVersion` is checked against
  the installed runtime and warns (never blocks) on a mismatch.
- **Observability surface** (so consumers needn't reconstruct): `GET /api/health`
  reports worker identity `{ ok, name, version, apiVersion }`; `GET /api/audit`
  is a filtered read of the trail (`since`/`nodeId`/`runId`/`type`/`limit`);
  `RunSummary` carries a `tasks` status breakdown + `toolCalls` (a `completed`
  run can still contain recovered task failures); `AgentMetric` carries
  `tasksFailed`/`p50Ms`/`meanMs`; and the trail records tool `input`
  (`tool.started`) and `output` (`tool.finished`).
- `scheduler.ts` — per-process auto-run. Modes: **adaptive** (after each run, reads
  the orchestrator's `next_run_minutes` hint from team memory, clamped to operator
  `[min,max]`) and **cron** (standard 5-field, local time). Code-enforced rails:
  single-flight per process, interval clamp, optional rolling-24h USD ceiling
  (pauses, doesn't fail). Config: `.ravel/scheduler.json`.

### `secrets/`
Per-agent `.env` chains (org root → node; deepest wins), so a sibling agent can't
read another's key. `${KEY}` references in `tools.json` `mcpServers` resolve from the
chain, then `process.env`. Key possession *is* the capability boundary (e.g. only the
writer agent holds a write key).

### `cli/` + `ui/`
`ravel create` (scaffold a valid starter team + `ravel.json` manifest), `validate`,
`run`, `serve` (HTTP API + operator console), `chat`, `proposals`, `dashboard`,
`watch`. The UI (React/Vite, proxies `/api`) has Runs (live activity, deliverables,
team memory sidebar, stop), Org/Config (edit agents/processes, per-process
**Automation** card, per-agent credentials), Proposals, Memory, Chat.

## Trust flow (the part that makes it a business tool)

```
agent calls tool ──policy?──▶ auto: run          deny: blocked
                              ask (deferred): Proposal ──human approves──▶ executor action
every step ──▶ audit.jsonl ──▶ SSE ──▶ operator console
budgets/kill switch abort the run mid-flight; state (queues) makes re-runs idempotent
```

## Runtime state layout (`.ravel/`, gitignored)

```
.ravel/
  audit.jsonl          append-only event log (rehydrates runs/chats on restart)
  proposals.json       durable proposal queue
  scheduler.json       auto-run config
  memory/{agent|team|org}/...   the MemoryStore tree
  runs/<runId>/shared/          per-run deliverables workspace
  agents/…             per-agent working dirs
```
