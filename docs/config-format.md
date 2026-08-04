# Config Format

A Ravel team is declarative config — a folder tree of Markdown + JSON. This page
is the reference for that surface and its version history. The runtime validates
it (`ravel validate`) and lints it for advisory issues (warnings) at `validate`
and `serve`.

## Files

| File | Purpose |
|---|---|
| `ravel.json` | Optional team manifest (name, description, `runtimeVersion`). |
| `agent.md` | An agent: YAML frontmatter + Markdown body (the system prompt). |
| `tools.json` | An agent's tool grants, permission policy, MCP servers, and expected env. |
| `processes/*.process.md` | A playbook the owning agent orchestrates. |
| `plugin.ts` | Optional team code tools + gated executor actions. |

## `ravel.json` (manifest)

```json
{
  "name": "my-team",
  "description": "What this team does.",
  "runtimeVersion": "^0.2"
}
```

All fields optional; the file itself is optional. `runtimeVersion` is a semver
range for the `@runravel/ravel` the team targets. It is **warn-only**: if the
installed runtime doesn't satisfy the range, `validate`/`serve` emits a warning
(config may target a different format) — it never blocks.

## `tools.json`

```json
{
  "defaultPolicy": "deny",
  "builtins": "readonly",
  "env": ["SERVICE_KEY"],
  "tools": [
    { "name": "mem_text_get", "policy": "auto", "description": "Read team memory." },
    { "name": "publish_report", "policy": "ask", "description": "Gated: queues a proposal." }
  ],
  "mcpServers": {
    "svc": { "type": "http", "url": "https://svc.example/mcp", "headers": { "Authorization": "Bearer ${SERVICE_KEY}" } }
  }
}
```

- `tools[].policy`: `auto` (runs) · `ask` (deferred approval → proposal) · `deny` (blocked).
- `defaultPolicy`: policy for any tool not listed. `builtins`: `readonly` (default,
  seeds Read/Glob/Grep) or `none`.
- **`env`** (new in 0.2): host env var names this agent expects. Declaring them lets
  the linter warn when a key is missing or a `${KEY}` in an mcpServers header is used
  without being declared. Actual use stays explicit — declare what your tools/servers rely on.

### What the linter warns about (all non-fatal)

Each warning carries a stable `code` (exported as `LINT_CODES`) so tooling can key
off it instead of parsing message text — `ravel validate`'s text output groups
repeated warnings by code, and `GET /api/validate` / `PUT /api/files` return it
in each diagnostic (`{ where, message, severity, code }`).

| Code | Fires when |
|---|---|
| `memory-write` | Granting a generic memory-mutating tool (`mem_text_set`, `mem_json_set`, `mem_json_merge`, `mem_queue_append`, `mem_queue_clear`) — prefer a typed `plugin.ts` tool for durable domain data (free-form key writes lead to memory sprawl). |
| `env-missing` | A declared (or referenced) `env` key isn't resolvable from the `.env` chain or `process.env`. |
| `env-undeclared` | A `${KEY}` used in an mcpServers header isn't declared in `tools.json`'s `env`. |
| `unknown-tool` | (serve only) A grant names no known built-in/office/memory/plugin tool — a dead grant. Suppressed when the node declares an mcpServer (the name may be a remote tool). |
| `runtime-version-mismatch` | The installed runtime doesn't satisfy the team's pinned `runtimeVersion`. |

Errors (malformed frontmatter/JSON, unresolved process owner, missing root `agent.md`)
still fail `validate` (exit 1). Warnings print but exit 0. Use `ravel validate --json`
for machine-readable output.

## Declared env inventory

`declaredEnv(snapshot)` (exported from the package root) returns every env key
a node's declarative config names it needs: `tools.json`'s own `env[]`, plus
any key its `mcpServers` reference (a stdio server's `env[]` names, or a
`${KEY}` substituted into an http/sse header) — the same "declared" set the
`env-missing`/`env-undeclared` lint checks above already treat as
authoritative. Each entry is `{ nodePath, key }`, `nodePath` root-relative
(`""` for the team root).

```json
[
  { "nodePath": "", "key": "ANTHROPIC_API_KEY" },
  { "nodePath": "growth/copywriter", "key": "BEACON_KEY" }
]
```

It is surfaced three ways, all reading the same compiled snapshot: `ravel
validate --json` and `GET /api/validate` (and `PUT /api/files`) each gain a
`declaredEnv` field, and library consumers can call `declaredEnv(snapshot)`
directly.

Two things worth stating plainly, since a hosting platform's onboarding UI
copy depends on them:

1. **This is a best-effort hint, not a complete inventory.** A plugin tool
   handler can read `process.env` directly without declaring it anywhere, so
   an empty result doesn't mean a team needs no secrets — it means the config
   declares none. Present it as "here's what we can tell you," not a
   guarantee.
2. **It does not see a plugin's own `env: string[]`** (the separate
   declaration a `plugin.ts` makes via `definePlugin`, validated at `serve`
   once the plugin is loaded — see `plugins/types.ts`). Answering that would
   require importing team code, which `compileRegistry` deliberately never
   does — the same reason `validate` runs cleanly in a checkout with no
   `node_modules` installed. `declaredEnv` reports only the declarative
   surface (`tools.json` + the `mcpServers` it names), so it works in exactly
   the bare candidate worktree a deploy pipeline hands it, before `npm ci`.

## Worker API & logs (for hosting integrators)

`GET /api/validate` and `PUT /api/files` return the **same shape** — compile
errors and lint warnings together — so a platform can gate a deploy or show
config health without scraping logs:

```bash
curl http://127.0.0.1:4317/api/validate
```
```json
{
  "ok": true,
  "diagnostics": [
    { "where": "growth/copywriter/tools.json", "severity": "warning",
      "code": "memory-write", "message": "grants generic memory write \"mem_text_set\" — ..." }
  ],
  "declaredEnv": [
    { "nodePath": "growth/copywriter", "key": "BEACON_KEY" }
  ]
}
```

`ok` is `false` only when a diagnostic has no `severity` or `severity: "error"`
— warnings never flip it. Full HTTP surface: [architecture.md](./architecture.md#service).

For logs, `ravel serve --log-format json` (or `RAVEL_LOG_FORMAT=json`) emits
NDJSON — one `{ "at", "level", ... }` object per line, covering the audit
stream *and* the process's own startup/warning/crash-guard output — the shape
a log aggregator (Datadog, CloudWatch, Loki) expects from a service. See
[cli-reference.md](./cli-reference.md#ravel-serve-options).

Observability reads (so you needn't reconstruct from the raw trail):
- `GET /api/health` → `{ ok, name, version, apiVersion }` — worker identity;
  `version` is the *running* runtime, `apiVersion` the HTTP-contract handle.
- `GET /api/audit?since=&nodeId=&runId=&type=&limit=` — one filtered read of
  the trail instead of N `runs/:id/events` calls.
- `GET /api/runs` `RunSummary` carries `tasks: {total,failed,aborted,
  budget_exhausted}` + `toolCalls` — a `completed` run can still contain
  recovered task failures.
- `GET /api/dashboard` `AgentMetric` carries `tasksFailed`/`p50Ms`/`meanMs`.
- The trail records tool `input` (`tool.started`) and `output`
  (`tool.finished`).
- `AgentMetric.usage` and `totalUsage` include the owning agent's own planning
  turns (`process.turn` events now carry `usage`), not just dispatched tasks —
  previously the planner's cost (often the majority of a run's spend) was
  attributed to no agent and excluded from the team-wide total. `tasksRun` is
  unaffected — a planning turn is not a dispatched task.
- `GET /api/processes` includes `budget`, `participants`, and `approvals` for each
  process (ask #18) — the platform no longer has to parse a process file's YAML
  frontmatter to display a declared cap.
- `GET/PUT/DELETE /api/limits` — an operator-set spend-ceiling document (ask #23),
  persisted at `.ravel/limits.json`. This is **team state, like `scheduler.json`,
  not declarative config** — it doesn't touch `agent.md`/`tools.json`/`ravel.json`
  and isn't part of the config-format version history below. When set, it governs a
  process's per-run budget completely (`ProcessSpec.budget` is ignored outright, no
  merge — DEC-013) and gates every launch against its rolling-window entries before
  the orchestrator starts. See [architecture.md](./architecture.md#service) for the
  full shape and semantics.
- `GET /api/runs/:id/transcript` — the opt-in per-run record of every turn's
  agent-authored text (ask #25), not just a task's final ~8000-character summary.
  **Team state, like `scheduler.json`/`limits.json`, not declarative config** — the
  flag that turns it on (`AppOptions.captureTranscripts` / `--capture-transcripts`)
  is a runtime-embedding option, not something authored in a team's checkout. Off by
  default; with it on, written to `.ravel/runs/<runId>/transcript.jsonl`, never
  `audit.jsonl`. See [architecture.md](./architecture.md#service) for why.

## Version history

| Config version | Runtime | Changes |
|---|---|---|
| — | 0.1.x | Initial format: agent.md, tools.json, processes, plugin.ts. `ravel.json` present but unread. |
| **0.2** | 0.2.x | `ravel.json` `runtimeVersion` now read + checked (warn). `tools.json` gains `env[]`. Advisory lint added (memory-write, env, unknown-tool warnings). All additive — 0.1 teams validate unchanged. |
| **0.2** | 0.3.x | **No config-format change.** A team is now an npm package: `ravel create` scaffolds a `package.json` depending on `@runravel/ravel`, and the recommended workflow is `npm install` / `npm run dev`. The runtime still compiles the same declarative surface; `package.json` is not parsed by it. |
| **0.2** | 0.4.x | **No config-format change.** Observability surface only (`GET /api/health`, `GET /api/audit`, run/agent metrics, tool input/output in the audit trail). |
| **0.2** | 0.5.x | **No config-format change.** `declaredEnv` reports the existing `tools.json` `env[]`/`mcpServers` surface back to callers in a new shape (`ravel validate --json`, `GET /api/validate`, and a `declaredEnv(snapshot)` export) — no new field, file, or semantics in the declarative schema itself. |
| **0.2** | 0.6.x | **No config-format change.** `GET /api/processes` now serializes existing `ProcessSpec` fields (`budget`/`participants`/`approvals`) it previously withheld. The new `.ravel/limits.json` (`GET/PUT/DELETE /api/limits`) is operator-set team state, not declarative config — same category as `scheduler.json`, which also isn't tracked here. |
| **0.2** | 0.7.x | **No config-format change.** The opt-in `.ravel/runs/<runId>/transcript.jsonl` (`GET /api/runs/:id/transcript`) and its `captureTranscripts` toggle are runtime-embedding options and run state — nothing in `agent.md`/`tools.json`/`ravel.json`/`processes/*.process.md` changes. `task.finished.summary`'s cap moved 2000 → 8000 chars, and `process.finished` now also carries the run's own final summary — both existing event *shapes*, not new declarative fields. |

The **config version** (the declarative schema the runtime parses) is distinct from
the **package version** — the format can stay stable across runtime releases, as 0.3.x
shows.

**Rule:** any change to this declarative surface (new field, new file, changed
semantics) bumps the runtime minor version and adds a row here + a CHANGELOG entry.
