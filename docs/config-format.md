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

## Version history

| Config version | Runtime | Changes |
|---|---|---|
| — | 0.1.x | Initial format: agent.md, tools.json, processes, plugin.ts. `ravel.json` present but unread. |
| **0.2** | 0.2.x | `ravel.json` `runtimeVersion` now read + checked (warn). `tools.json` gains `env[]`. Advisory lint added (memory-write, env, unknown-tool warnings). All additive — 0.1 teams validate unchanged. |
| **0.2** | 0.3.x | **No config-format change.** A team is now an npm package: `ravel create` scaffolds a `package.json` depending on `@runravel/ravel`, and the recommended workflow is `npm install` / `npm run dev`. The runtime still compiles the same declarative surface; `package.json` is not parsed by it. |

The **config version** (the declarative schema the runtime parses) is distinct from
the **package version** — the format can stay stable across runtime releases, as 0.3.x
shows.

**Rule:** any change to this declarative surface (new field, new file, changed
semantics) bumps the runtime minor version and adds a row here + a CHANGELOG entry.
