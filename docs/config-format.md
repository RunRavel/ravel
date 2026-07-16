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

- **Generic memory writes**: granting `mem_text_set` / `mem_json_set` / `mem_json_merge`
  / `mem_queue_append` / `mem_queue_clear` warns — prefer a typed `plugin.ts` tool for
  durable domain data (free-form key writes lead to memory sprawl).
- **Env**: a declared `env` key not resolvable from the `.env` chain or `process.env`;
  or a `${KEY}` used in an mcpServers header but not declared in `env`.
- **Unknown tool grant** (serve only): a grant naming no known built-in/office/memory
  tool and no loaded plugin tool — a dead grant. Suppressed when the node declares an
  mcpServer (the name may be a remote tool).

Errors (malformed frontmatter/JSON, unresolved process owner, missing root `agent.md`)
still fail `validate` (exit 1). Warnings print but exit 0.

## Version history

| Config version | Runtime | Changes |
|---|---|---|
| — | 0.1.x | Initial format: agent.md, tools.json, processes, plugin.ts. `ravel.json` present but unread. |
| **0.2** | 0.2.x | `ravel.json` `runtimeVersion` now read + checked (warn). `tools.json` gains `env[]`. Advisory lint added (memory-write, env, unknown-tool warnings). All additive — 0.1 teams validate unchanged. |

**Rule:** any change to this declarative surface (new field, new file, changed
semantics) bumps the runtime minor version and adds a row here + a CHANGELOG entry.
