# Authoring Ravel Teams

The reference for writing a team: file formats, permissions, plugins, memory, and
scheduling. Working examples: `examples/acme` (multi-agent org), `examples/harbor`
(support-ops team), `examples/plugin-demo` (plugin + gated action).

## Layout

```
my-team/
  ravel.json                 # manifest: { name, runtimeVersion, description }
  agent.md                   # the team lead (root agent)
  tools.json                 # lead's tool grants (optional)
  plugin.ts                  # optional team plugin (inherited by all agents below)
  analyst/                   # a subordinate agent
    agent.md
    tools.json
    .env                     # per-agent secrets (gitignored)
  processes/
    daily-brief.process.md   # playbooks owned by an agent in this tree
  .gitignore                 # must ignore .env and .ravel/
```

Folder tree = org chart. Every folder with an `agent.md` is an agent; its subfolders
are its direct reports. Scaffold a valid starter with `ravel create <name>`.

## `agent.md` — an agent

YAML frontmatter + a markdown body (the system prompt).

```markdown
---
name: Corpus Analyst          # display name (required)
role: corpus-analyst          # role id used by processes/planner (defaults to name)
model: sonnet                 # opus | sonnet | haiku (cost-tier your org!)
autonomy: orchestrated        # orchestrated | bounded
budget:                       # optional per-run ceiling for this agent
  usd: 8
  turns: 10
---
You mine the corpus for insights... (the system prompt — write it like a job
description: mission, how to work each turn, what good output looks like, when to
STOP.)
```

Prompt-writing rules that matter in practice:
- **Give explicit terminal conditions** ("if the queue is empty, report 'done' and
  make NO further tool calls") — spare turns are not a reason to keep working.
- **Batch tool calls** (arrays in one call) — turns are the scarce resource.
- Tell one-item-per-task workers to take exactly one item and report remaining count,
  so the orchestrator can re-dispatch per item.

## `tools.json` — grants & permission policy

An agent can only call what's granted here. Policy is the trust layer:

```json
{
  "defaultPolicy": "deny",          // policy for anything not listed: auto | ask | deny
  "builtins": "none",               // SDK built-ins: readonly | none
  "tools": [
    { "name": "mem_queue_list",  "policy": "auto", "description": "Read the inbox queue." },
    { "name": "publish_report",  "policy": "ask",  "description": "Gated: queues a proposal." }
  ],
  "mcpServers": {
    "knowledge": {
      "type": "http",               // stdio | http | sse
      "url": "https://example.com/mcp",
      "headers": { "Authorization": "Bearer ${SERVICE_KEY}" }   // ${KEY} ← .env chain
    }
  }
}
```

- `auto` = runs silently; `ask` = **deferred approval** — the call is denied at
  runtime and queued as a Proposal a human approves later; `deny` = blocked.
- **Remote MCP tools cannot be `ask`-gated** (there is no executor handler to run on
  approval) — for connected MCP servers use `defaultPolicy: "deny"` and grant the
  allowed tools `auto`. Gate consequential *plugin* tools instead (see below).
- Secrets: put `KEY=value` in the agent's `.env`; reference `${KEY}` in `mcpServers`.
  The `.env` chain merges org-root → agent (deepest wins); a sibling's `.env` is
  unreachable — **key possession is the capability boundary** (e.g. give only the
  writer agent the write key).

Built-in tool families you can grant by name: the generic memory tools
(`mem_text_get/set`, `mem_json_get/set/merge`, `mem_queue_append/list/clear`,
`mem_keys`), office/file tools, and any tools your team plugin defines.

## `processes/*.process.md` — playbooks

```markdown
---
name: Daily Brief
owner: corpus-analyst-lead     # node id / role / name of the owning agent
participants: [corpus-analyst] # roles the owner may dispatch
trigger:
  type: manual                 # manual | schedule (with cron: "0 9 * * *") | event
definitionOfDone: >
  The analyst has processed the queue until empty or budget spent, and results are
  recorded to team memory.
budget:
  usd: 8
  turns: 10
---
The playbook body: numbered steps the owner follows — who to dispatch, with what
goal and per-task budget, when to re-dispatch, and what to summarize at the end.
```

Design patterns that work:
- **Queues connect stages.** Stage A drains its inbox queue and appends to stage B's
  (`mem_queue_*` with `dedupBy` + `cap`) — stages stay decoupled, idempotent, and
  independently schedulable/debuggable.
- **Fan-out per item**: the owner dispatches one worker per item with a small budget,
  so one deep dive can't drain the run.
- **Self-pacing**: if the process will auto-run in adaptive mode, end the playbook
  with "write `next_run_minutes` (+ `next_run_reason`) via `mem_text_set` — short if
  a backlog remains, long if caught up."

## `plugin.ts` — team code tools & gated actions

A team-root `plugin.ts` default-exports the plugin; **all agents in the tree inherit
it** (their `tools.json` grants still decide who may call what).

```ts
import { z } from "zod";
import { definePlugin } from "@runravel/ravel";

export default definePlugin({
  name: "my-plugin",
  env: ["SERVICE_KEY"],                       // resolved from the agent's .env chain → ctx.env
  tools: [
    {
      name: "fetch_report",
      description: "Fetch a report from the service.",
      schema: { id: z.string() },
      handler: async (input, ctx) => {
        // ctx: { memory, teamScope, nodeId, cwd, env }
        return callService(String(input["id"]), ctx.env["SERVICE_KEY"]);
      },
    },
    {
      name: "publish_report",                 // GATED: stub returns a "proposed" value…
      description: "Propose publishing (requires human approval).",
      schema: { id: z.string() },
      handler: async (input) => ({ proposed: `publish ${input["id"]}` }),
    },
  ],
  actions: [
    {
      name: "publish_report",                 // …and the same-named action does the real
      handler: async (input, ctx) => {        // write when a human approves the proposal.
        await doPublish(input, ctx.memory, ctx.teamScope);
        return { ok: true };
      },
    },
  ],
});
```

Rules: a gated tool **must** have a same-named action (a proposal without a handler
can't execute). Plugin code loads once per process — restart `serve` after changing
it. Keep plugins domain-specific; generic capability belongs in the runtime.

## Memory

Scopes: `agent` (private), `team` (shared manager ↔ direct reports — the default),
`org` (write-gated). Team scope is keyed by the managing node, so **keep a team flat**
(workers as direct children of the lead) unless you intend to fork memory at a
sub-manager. State lives under `.ravel/memory/` — inspect it in the console's
Memory tab; never commit it.

## Scheduling (auto-run)

Configure per process in the console (Org → process → **Automation**) or
`.ravel/scheduler.json`:

- **adaptive** — the orchestrator writes `next_run_minutes` after each run; the
  scheduler clamps it to your `[minMinutes, maxMinutes]`. Best for queue-draining
  pipelines.
- **cron** — fixed 5-field schedule (local time). Best for daily scans.
- `maxUsdPerDay` — hard rolling-24h spend ceiling: auto-runs pause (visibly) at the
  cap and resume as spend rolls off. Single-flight is always enforced.

## Checklist before you run

1. `ravel validate --dir .` — the tree and processes compile.
2. `.gitignore` covers `.env` and `.ravel/`.
3. Every `ask`-gated plugin tool has a matching action.
4. Agents have terminal conditions in their prompts; processes have real
   `definitionOfDone`s and budgets.
5. Cost-tier models: haiku for triage, sonnet for work, opus for orchestration.
6. `ANTHROPIC_API_KEY` in the environment or a `.env`; then
   `ravel serve --dir .` and run a process from the console.
