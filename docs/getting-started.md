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

## Scaffold a team

A Ravel team is an **npm package** — a folder of config that depends on the
runtime. Scaffold one without installing anything globally:

```bash
npx @runravel/ravel create my-team
cd my-team
npm install
```

This creates a minimal, valid starter:

```
my-team/
  package.json               # deps: @runravel/ravel (pinned); scripts: dev/validate/start
  ravel.json                 # manifest: name, runtimeVersion, description
  agent.md                   # the team lead — owns the Hello process
  assistant/
    agent.md                 # a report the lead delegates to
    tools.json                # its tool grants + permission policy
  processes/
    hello.process.md          # the one playbook: greet and report
  .gitignore                 # ignores .env, .ravel/, node_modules/
```

`package.json` pins the runtime (`"@runravel/ravel": "^0.3"`), so `npm install`
here — and `npm ci` on a hosting platform later — gets the exact version this
team was authored against. No build step — Ravel ships TypeScript and runs it
via `tsx`. The lead's `agent.md` sets `autonomy: orchestrated` and a budget
(`usd: 2`, `turns: 6`); the assistant inherits whatever the orchestrator hands
it per task. This is the smallest complete shape a team can take — one owner,
one report, one process.

> No global install needed. The scaffold's `npm run` scripts (`dev`, `validate`,
> `start`) invoke the team's own pinned `ravel`. A global `npm i -g @runravel/ravel`
> also works if you prefer typing `ravel …` directly, but the local dependency is
> the portable default.

## Validate

```bash
npm run validate           # → ravel validate --dir .
```

Compiles the folder tree against the agent/tools/process schemas without
running anything. It fails (exit 1) with a `where`/`message` per diagnostic if
`agent.md` frontmatter is malformed, a process names a non-existent owner, or
`tools.json` references bad policy values, and prints `⚠` advisory warnings
(exit 0) for lint issues like granting a generic memory-write tool. Run it
after any edit — it's also what the operator console calls before saving, and
what a hosting platform can gate a deploy on (`ravel validate --json`).

## Run a process once (no server)

```bash
npx ravel run "Hello" --dir . --input who=Ravel
```

This boots the org in-process, runs exactly one process to completion (or
budget/turn exhaustion), prints the result, and exits. Good for scripting and
CI; the [CLI reference](./cli-reference.md#ravel-run-process-name-options)
covers `--file`, `--dry-run`, and `--sync`. (Inside a team, `npx ravel` runs
the pinned local binary.)

## Serve (console + API, long-running)

```bash
npm run dev                # → ravel serve --dir .
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

The starter keeps things trivial (the assistant just composes a greeting), so
it produces no proposals. But the mechanism is central to Ravel: a tool granted
`policy: "ask"` in `tools.json` doesn't fail when called — it's denied at
runtime and queued as a **Proposal**. Approve it (`npx ravel proposals approve
<id>`, or the console) and the matching executor action runs deterministically
— no model call involved in the approval step. Consequential actions always
have a name a human can see and a yes/no to make. See
[examples.md](./examples.md) — `examples/acme` gates `send_email`, and
`examples/plugin-demo` shows a plugin's own gated action end to end.

## Next steps

- [authoring-teams.md](./authoring-teams.md) — the full reference for
  `agent.md`, `tools.json`, processes, plugins, memory, and scheduling.
- [examples.md](./examples.md) — three complete teams to read or run:
  a small multi-agent org, a support-ops firm, and the minimal plugin
  mechanism.
- [cli-reference.md](./cli-reference.md) — every command and flag.
- [api-reference.md](./api-reference.md) — embedding Ravel programmatically
  (`App`, engines, memory, plugins) instead of via the CLI.
