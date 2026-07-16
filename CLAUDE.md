# CLAUDE.md — Ravel

Ravel is an **agentic runtime**: a team of AI agents is defined as a **folder tree**
(agents, tools, processes as files) and executed with orchestration, budgets,
scheduling, human-in-the-loop approvals, and a full audit trail. This repo is the
runtime + CLI + operator UI. It is meant to be **published** (`@runravel/ravel`,
bin `ravel`) and eventually open-sourced — keep it generic and secret-free.

## Commands

```bash
npm test                     # vitest run (full suite — keep it green)
npm run typecheck            # tsc --noEmit (strict, verbatimModuleSyntax)
npx tsx src/cli/main.ts <cmd>            # run the CLI from source
node bin/ravel.mjs <cmd>                 # run the CLI as installed (tsx loader)
ravel create <name> | validate | run | serve | chat | proposals | dashboard | watch
cd ui && npx vite build                 # operator console (React), served by `serve`
```

No build step: Ravel **ships TypeScript** and runs via `tsx`. `src/index.ts` is the
**public API** (what plugins and embedders import); deep `src/...` paths are not a
contract.

## Architecture (one screen)

```
control-plane/   compileRegistry: folder tree → RegistrySnapshot; chokidar watcher (hot reload)
schemas/         zod schemas for agent.md / tools.json / *.process.md frontmatter
platform/app.ts  App — wires everything; the embedding surface (start/runProcess/chat/proposals)
runtime/         AgentRuntime + engines: SdkEngine (Claude Agent SDK), FakeEngine (tests)
orchestrator/    LLM planner → PlannedTask[] → worker dispatch, turn/budget caps
memory/          file-backed MemoryStore (scopes: agent|team|org) + generic mem_* tools
plugins/         team plugin.ts loader (tools + gated executor actions), inheritance
trust/           audit (append-only), approvals→proposals, executor, kill switch, budgets
messaging/       inter-agent bus + inboxes
secrets/         per-agent .env chains; ${KEY} resolution for tools.json mcpServers
service/         HTTP+SSE API (server.ts) + self-pacing/cron Scheduler (scheduler.ts)
cli/             ravel create/validate/run/serve/...
ui/              operator console (Runs, Org/Config+Automation, Proposals, Memory, Chat)
```

See `docs/architecture.md` for the full map and `docs/authoring-teams.md` for the
team-file formats.

## Hard rules (do not violate)

1. **No domain code in the runtime.** Anything business-specific belongs in a team's
   `plugin.ts` (see `examples/plugin-demo`), never in `src/`. Grep gate: `src/` must
   not import from team folders.
2. **Safety is code, not prompts.** Budgets ($ + turns), single-flight scheduling,
   kill switches, and permission gating are enforced deterministically. Never move
   these into an LLM's discretion.
3. **Gated actions need an executor handler.** A tool with `policy: "ask"` becomes a
   Proposal; approval runs a registered executor action. A proposal without a handler
   is un-executable — plugins must pair a gated tool with a same-named action.
4. **ESM discipline:** relative imports use `.js` suffixes; `verbatimModuleSyntax` is
   on (use `import type`). Node >= 22.
5. **Public API via `src/index.ts` only.** Adding a symbol consumers need? Export it
   there deliberately — it's the versioned contract.
6. **Tests are the safety net.** `test/` uses `FakeEngine` (scripted turns, no API
   key) + fixture teams under `test/fixtures/`. New engine behavior needs a test.
7. **Config format is versioned.** Any change to the declarative team surface
   (`agent.md`/`tools.json`/`processes`/`ravel.json` fields or semantics) bumps the
   runtime minor version and adds a row to `docs/config-format.md` + a CHANGELOG
   entry. Keep additions backward-compatible (optional fields, warnings not errors).

## Key seams (where things plug in)

- **`AgentEngine`** (`runtime/engine.ts`) — the LLM backend interface. `SdkEngine` is
  production (Claude Agent SDK); `FakeEngine` for tests; a future engine (other
  providers) implements the same interface.
- **Plugin contract** (`plugins/types.ts`) — `definePlugin({ name, env?, tools?,
  actions? })` default-exported from a team-root `plugin.ts`; inherited by descendant
  agents; each agent's `tools.json` grants decide which plugin tools it may call.
- **`MemoryStore`/`SecretStore`** — file-backed; hosted deployments swap the roots
  (e.g. an S3-mounted `.ravel/`), not the implementations.
- **Scheduler** (`service/scheduler.ts`) — per-process auto-run: `adaptive` (the
  orchestrator writes `next_run_minutes` to team memory; clamped to operator min/max)
  or `cron` (5-field, local time). Rails in code: single-flight, interval clamp,
  rolling-24h $ ceiling. Config: `.ravel/scheduler.json`.

## Known sharp edges

- `audit.jsonl` uses `fs.appendFile` — fine locally, **breaks on S3-mounted state**
  (no in-place append). An S3-safe audit sink is a roadmap item.
- Plugin code is imported once per process (code changes need a `serve` restart);
  config files hot-reload via the watcher.
- Runs interrupted by a restart show as `interrupted` — there is no resume yet.
- Team memory is shared **manager ↔ direct reports** only (`managerScopeOf`) — a
  sub-manager forks the scope; keep teams flat unless that's intended.

## Runtime state & secrets

`.ravel/` (gitignored) holds memory, audit, proposals, runs, scheduler config.
Secrets live in per-agent `.env` files (gitignored), referenced as `${KEY}` from
`tools.json`; resolution falls back to `process.env`. **Never commit either.**

## Roadmap context

Ravel is the runtime a hosting platform embeds (isolated worker per team repo,
git-push deploys) and the tool developers use locally. Planning docs (roadmap,
platform asks) live in `docs/internal/` — gitignored, local-only; read them if
present, but never reference them from published files.
