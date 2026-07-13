# Getting Started

This walks through installing Ravel, scaffolding a team, and running your
first process. For the concepts behind what you're looking at (agents,
processes, tools, memory), see [authoring-teams.md](./authoring-teams.md).

## Prerequisites

- **Node.js ≥ 22**.
- An **Anthropic API key** — export `ANTHROPIC_API_KEY`, put it in a `.env`
  next to your team folder (or the directory you run `ravel` from), or run
  `ant auth login`. Ravel warns but doesn't stop without one; you'll need it
  the moment an agent actually runs.

## Install

```bash
npm i -g @runravel/ravel
```

No build step — Ravel ships TypeScript and runs it via `tsx`. `ravel` is the
installed command from here on.

## Scaffold a team

```bash
ravel create my-team
```

This creates a minimal, valid starter:

```
my-team/
  ravel.json                 # manifest: name, runtimeVersion, description
  agent.md                   # the team lead — owns the Hello process
  assistant/
    agent.md                 # a report the lead delegates to
    tools.json                # grants: mem_text_get/set, defaultPolicy "ask"
  processes/
    hello.process.md          # the one playbook: write a greeting to memory
  .gitignore                 # ignores .env and .ravel/
```

The lead's `agent.md` sets `autonomy: orchestrated` and a budget (`usd: 2`,
`turns: 6`); the assistant has no budget of its own, so it inherits whatever
the orchestrator hands it per task. This is the smallest complete shape a team
can take — one owner, one report, one process.

## Validate

```bash
ravel validate --dir my-team
```

Compiles the folder tree against the agent/tools/process schemas without
running anything. You'll see this fail loudly (with a `where`/`message` per
diagnostic) if `agent.md` frontmatter is malformed, a process names a
non-existent owner, or `tools.json` references bad policy values. Run this
after any manual edit — it's also what the operator console calls before
saving a config edit.

## Run a process once (no server)

```bash
ravel run "Hello" --dir my-team --input who=Ravel
```

This boots the org in-process, runs exactly one process to completion (or
budget/turn exhaustion), prints the result, and exits. Good for scripting and
CI; the [CLI reference](./cli-reference.md#ravel-run-process-name-options)
covers `--file`, `--dry-run`, and `--sync`.

## Serve (console + API, long-running)

```bash
ravel serve --dir my-team
```

```
Ravel service on http://127.0.0.1:4317  (org: my-team)
Operator console: http://127.0.0.1:4317/
Proposals queue is async — review at /api/proposals or in the console. Ctrl-C to stop.
```

Open `http://127.0.0.1:4317/` — the operator console has **Runs** (live
activity, deliverables, stop), **Org/Config** (edit agents/processes, wire up
scheduling), **Proposals** (approve/reject gated actions), **Memory** (browse
the team's `mem_*` state), and **Chat** (talk to any one agent directly).

Trigger the same process from the console's Runs tab (or `POST
/api/processes/Hello/run`), and watch it complete. Note the banner: `serve` by
default binds **loopback only** (`127.0.0.1`) — the API has no
authentication, by design (see the [README's security
posture](https://github.com/RunRavel/ravel#readme)). Use `--host 0.0.0.0`
only when you know what's exposing it (a gateway, a container).

## What "proposals" means

`assistant/tools.json` grants `mem_text_set` as `auto` (runs immediately) but
its `defaultPolicy` is `"ask"` — anything not explicitly listed is gated. A
gated tool call doesn't fail; it's denied at runtime and queued as a
**Proposal**. Approve it (`ravel proposals approve <id>`, or the console) and
the matching executor action runs deterministically — no model call involved
in the approval step itself. This is the human-in-the-loop mechanism
throughout Ravel: consequential actions always have a name a human can see
and a yes/no to make.

## Next steps

- [authoring-teams.md](./authoring-teams.md) — the full reference for
  `agent.md`, `tools.json`, processes, plugins, memory, and scheduling.
- [examples.md](./examples.md) — three complete teams to read or run:
  a small multi-agent org, a support-ops firm, and the minimal plugin
  mechanism.
- [cli-reference.md](./cli-reference.md) — every command and flag.
- [api-reference.md](./api-reference.md) — embedding Ravel programmatically
  (`App`, engines, memory, plugins) instead of via the CLI.
