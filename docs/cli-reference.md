# CLI Reference

All commands accept `--dir <path>` (org root; defaults to the current
directory). `.env` is loaded from both the current directory and `--dir`
before any command needs `ANTHROPIC_API_KEY` (existing exported env wins).

```
ravel create <name>
ravel validate [--dir <org>]
ravel run <process-name> [--dir <org>] [--dry-run] [--sync] [--input k=v]... [--file <path>]...
ravel chat <node-id> <message...> [--dir <org>]
ravel proposals [list|approve <id>|reject <id>] [--dir <org>]
ravel dashboard [--dir <org>]
ravel watch [--dir <org>]
ravel serve [--dir <org>] [--port 4317] [--host 127.0.0.1] [--state-dir <path>] [--read-only-config]
```

## `ravel create <name>`

Scaffolds a minimal, valid starter team at `./<name>` (fails if the folder
already exists): a `package.json` (depends on `@runravel/ravel`, with
`dev`/`validate`/`start` scripts), `ravel.json`, a lead `agent.md`, one
`assistant/` report with a `tools.json`, one `processes/hello.process.md`, and
a `.gitignore` covering `.env`, `.ravel/`, and `node_modules/`. A team is an
npm package, so the usual next step is `cd <name> && npm install && npm run dev`.
Run it without a global install via `npx @runravel/ravel create <name>`. See
[getting-started.md](./getting-started.md) for what each file contains and why.

## `ravel validate [--dir <org>]`

Compiles the folder tree (agent.md / tools.json / processes / ravel.json)
against the zod schemas and reports diagnostics — no agents run. Prints `✗`
**errors** (malformed config, unresolved process owner) and `⚠` **warnings**
(advisory lint — generic memory-write grants, missing/undeclared env, pinned
`runtimeVersion` mismatch), grouped by rule so a repeated warning across many
agents prints its explanation once. Exit `1` if any error, `0` if only warnings
(or clean). `--json` emits one JSON object (`ok`, `nodes`, `processCount`,
`diagnostics` — each with `where`/`message`/`severity`/`code` —, and
`declaredEnv` — `{ nodePath, key }[]`, every env key the config declares a
node needs) instead, for CI/scripting. Safe to run in CI. See
[config-format.md](./config-format.md) for the full warning list and the
`declaredEnv` contract.

## `ravel run <process-name> [options]`

Boots the org, runs **one process to completion** (or until its budget/turn
cap is hit), prints the result, and exits. No HTTP server, no watcher restart
loop — good for scripting and CI.

- `--input k=v` (repeatable) — a run input available to every dispatched
  task (e.g. `--input targetLanguages=fr,de`).
- `--file <path>` (repeatable) — a host file staged into the shared run
  workspace before the first task starts.
- `--dry-run` — agents still plan and call tools, but no tool actually
  executes (its handler is skipped); use this to see what a process *would*
  do without side effects.
- `--sync` — gated ("ask"-policy) tool calls block on an interactive `y/N`
  prompt right there in the terminal instead of queuing as a Proposal. Good
  for a single supervised run; `serve`'s default (deferred/async) is better
  for anything long-running or unattended.

```bash
ravel run "Resolve Ticket Batch" --dir examples/harbor \
  --file ./tickets.json --input product="Acme CRM"
```

## `ravel chat <node-id> <message...> [--dir <org>]`

Talk to one agent directly, bypassing the orchestrator (no process, no
dispatch). `node-id` is the agent's registry path (`""` for the root, or
e.g. `growth/copywriter`) — see it in `ravel dashboard` output or the
console's Org tab. `--sync` applies here too, for gated tools the agent
might call mid-conversation.

## `ravel proposals [list|approve <id>|reject <id>] [--dir <org>]`

Manage the deferred-approval queue from the terminal (`list` is the
default). Approving runs the executor action deterministically — no model
call. Equivalent to the console's Proposals tab.

## `ravel dashboard [--dir <org>]`

One-shot snapshot: total spend, per-agent state (idle/running), task counts,
and pending proposal count. Same data the console's header bar shows, without
booting a server.

## `ravel watch [--dir <org>]`

Boots the org and holds it open, hot-reloading on any folder edit (chokidar
watches `agent.md`/`tools.json`/processes) — no HTTP server. Useful for
watching a config's validity while you author it, without the API/console
overhead of `serve`.

## `ravel serve [options]`

The long-running mode: HTTP + SSE API and the operator console on one port.

- `--port <n>` — default `4317`.
- `--host <addr>` — default `127.0.0.1` (**loopback only**). The API has no
  authentication by design — pass `--host 0.0.0.0` only when you know what's
  exposing the port (a gateway, a container network) and CORS is granted to
  loopback origins only, so a browser on another machine can't drive it
  cross-origin even once it's reachable.
- `--state-dir <path>` — where runtime state (memory, audit, proposals, runs)
  lives; default `<org>/.ravel`. Separates a replaceable config checkout from
  a persistent state volume — useful for containerized/hosted workers.
- `--read-only-config` — returns `403` on `PUT /api/files` and `PUT
  /api/secrets` (config/secret writes over HTTP). `PUT`/`DELETE
  /api/scheduler` stays enabled — scheduler config is team state, not
  authoring config. For workers whose config comes from a git checkout, not
  live edits.

Shuts down gracefully on both `SIGINT` (Ctrl-C) and `SIGTERM` (what container
runtimes send on stop).

## Shared flags

| Flag | Applies to | Meaning |
|---|---|---|
| `--dir <path>` | all commands | Org root folder (default: cwd) |
| `-v`, `--verbose` | `run`, `serve` | Stream the audit trail (turns, dispatches, tool calls, proposals) to stderr |
| `--log-format <fmt>` | `run`, `serve` | `pretty` (default) or `json` — NDJSON, one object per line with a `level` (info/warn/error), for log aggregators (Datadog, CloudWatch, Loki). Implies `--verbose`. Also settable via `RAVEL_LOG_FORMAT`. |

## Exit codes

`0` on success. `1` on: invalid org (`validate`, and any command that needs a
valid org), an unknown command, a missing required argument, or an uncaught
error during a run. `serve` also exits `1` if the port is already bound —
deliberately, so a hosting platform's health check fails fast instead of a
silently-dead process.
