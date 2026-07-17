# Ravel

An agentic runtime. Define an agentic **team** as a folder of agents, tools, and
processes — a folder hierarchy *is* the org chart — and run it with orchestration,
budgets, scheduling, and human-in-the-loop approval.

```
my-team/
  agent.md                 # the team lead (root of this org)
  tools.json
  <subagent>/agent.md …    # subordinate agents (the tree)
  processes/*.process.md   # playbooks the lead runs
  plugin.ts                # (optional) team-scoped code tools + gated actions
```

## Quick start

A team is an **npm package** that depends on the runtime — clone/scaffold,
`npm install`, `npm run dev`, the same loop as any JS project:

```bash
npx @runravel/ravel create my-team   # scaffold a team (no global install needed)
cd my-team
npm install                          # installs @runravel/ravel, pinned in package.json
npm run dev                          # → ravel serve --dir .  (operator console + API)
```

The scaffold's `package.json` pins the runtime (`"@runravel/ravel": "^0.3"`), so
your team runs against the exact version it was authored on — locally and, later,
on a hosting platform (`npm ci`). Runs on your own Anthropic key
(`ANTHROPIC_API_KEY` in the environment or a `.env`). No build step — Ravel ships
TypeScript and runs it via `tsx`.

> Prefer a global CLI? `npm i -g @runravel/ravel` then `ravel serve --dir my-team`
> works too — but the local-dependency model above is the recommended, portable
> default (a plugin.ts with real dependencies needs the team's own `node_modules`).

**Security posture:** `ravel serve` is a single-operator local tool — the API has
no authentication by design. It binds `127.0.0.1` and grants CORS only to loopback
origins; expose it beyond your machine only deliberately (`--host 0.0.0.0`) and
behind something that authenticates. Consequential agent actions are gated by tool
policy (`ask` → human approval), budgets, and the kill switch — in code, not prompts.

## Concepts

- **Agent** — a folder with `agent.md` (system prompt + frontmatter) and `tools.json`
  (granted tools + permission policy). Subfolders are subordinate agents.
- **Process** — a `processes/*.process.md` playbook the owning agent orchestrates.
- **Memory** — durable, team-scoped key/value + queues (`mem_*` tools).
- **Plugin** — an optional `plugin.ts` giving a team in-process code tools and gated
  executor actions, with its own env-resolved secrets. See `examples/plugin-demo`.
- **Approvals** — consequential actions are gated (`policy: "ask"`) and queue as
  proposals for human approval.
- **Scheduling** — processes can auto-run adaptively or on a cron.

## Programmatic use

```ts
import { App, SdkEngine } from "@runravel/ravel";
const app = new App({ root: "my-team", engine: new SdkEngine() });
await app.start();
await app.runProcess("My Process");
```

## Examples

- `examples/acme` — a small multi-agent growth org.
- `examples/harbor` — a customer-support operations firm (ticket triage → drafting → QA).
- `examples/plugin-demo` — the team-plugin mechanism (tools + a gated action).

## Docs

Full documentation: [docs/](https://github.com/RunRavel/ravel/tree/main/docs)

- [docs/getting-started.md](https://github.com/RunRavel/ravel/blob/main/docs/getting-started.md) — install, scaffold a team, validate, run, serve.
- [docs/authoring-teams.md](https://github.com/RunRavel/ravel/blob/main/docs/authoring-teams.md) — how to write a team (agents, tools, processes, plugins, scheduling).
- [docs/cli-reference.md](https://github.com/RunRavel/ravel/blob/main/docs/cli-reference.md) — every `ravel` command and flag.
- [docs/api-reference.md](https://github.com/RunRavel/ravel/blob/main/docs/api-reference.md) — embedding Ravel programmatically.
- [docs/config-format.md](https://github.com/RunRavel/ravel/blob/main/docs/config-format.md) — the declarative config surface, lint warnings, and version history.
- [docs/architecture.md](https://github.com/RunRavel/ravel/blob/main/docs/architecture.md) — how the runtime works, module by module.
- [docs/examples.md](https://github.com/RunRavel/ravel/blob/main/docs/examples.md) — walkthroughs of the three example teams.
- [CLAUDE.md](https://github.com/RunRavel/ravel/blob/main/CLAUDE.md) — conventions and hard rules for coding agents working on this repo.

## License

[Apache-2.0](./LICENSE).
