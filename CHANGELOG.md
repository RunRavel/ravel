# Changelog

All notable changes to `@runravel/ravel`. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.4.0 — unreleased

Observability: the run/agent/audit surface now reports enough that a hosting
platform or the console doesn't have to scrape or reconstruct. All additive —
`apiVersion` stays `"1"`.

### Added

- **`GET /api/health` is now worker identity:** `{ ok, name: "ravel", version,
  apiVersion }`. `version` is the *running* runtime (`runtimeVersion()`); may
  differ from a checkout's installed version until the worker restarts.
  `apiVersion` is the HTTP-contract handle, bumped only on an incompatible change.
- **`GET /api/audit?since=&nodeId=&runId=&type=&limit=`** — a filtered read over
  the same events the SSE channel emits (newest-last, `limit` default 1000, cap
  5000). Collapses N `runs/:id/events` round-trips into one call.
- **`RunSummary` (`GET /api/runs`) gains `tasks: { total, failed, aborted,
  budget_exhausted }` and `toolCalls`** — "did anything break along the way" as
  a dimension separate from the run `status` (a `completed` run can contain
  recovered task failures). Not a new status enum.
- **`AgentMetric` (`GET /api/dashboard`) gains `tasksFailed`, `p50Ms`, `meanMs`**
  — per-agent error count and task latency, derived by pairing
  `task.started`↔`task.finished` on `contractId`.
- **Tool inputs/outputs in the audit trail:** `tool.started` now carries the
  tool `input`; a new **`tool.finished { tool, input, output }`** event captures
  outputs (from the SDK's tool_result stream; truncated to keep events lean).
  `EngineToolUse` gains an optional `output`; `FakeEngine`'s `ctx.useTool`
  accepts a simulated `output` for parity.

## 0.3.1 — unreleased

### Fixed

- The config watcher treated agent memory/audit writes as config edits, forcing
  a full org recompile on every write (`GET /api/org` `version` climbed
  continuously on an idle team). The default state dir is `<root>/.ravel` — inside
  the watched root — but the watcher's ignore list still named the pre-0.1
  `.businessos` and never learned the new name. It now ignores the runtime/state
  dir by **resolved (symlink-aware) path** rather than a hardcoded name, and
  ignores anything whose real location escapes the repo (a symlink out to a
  hosted `--state-dir`) — robust on both the native and polling watch backends.
  Not a correctness bug (recompiles were fingerprint-guarded no-ops), but wasted
  a full re-parse of every agent/process file per memory write. The watcher stays
  active under `--read-only-config` (the hosted hot-deploy path relies on it).

## 0.3.0 — unreleased

Team repos are npm packages.

### Changed

- **`ravel create` scaffolds a `package.json`** that depends on `@runravel/ravel`
  (pinned `^0.3`) with `dev` / `validate` / `start` scripts. The recommended
  authoring workflow is now `npx @runravel/ravel create <name>` → `npm install`
  → `npm run dev` — the same clone/install/run loop every JS project uses. A team
  now pins the runtime via its lockfile, so it runs against the exact version it
  was authored on, locally and on a hosting platform (`npm ci`). The global-CLI
  path (`npm i -g @runravel/ravel`; `ravel serve --dir`) still works and is
  documented as the alternative.
- The scaffolded starter no longer grants a generic memory-write tool (it tripped
  the 0.2 `memory-write` lint warning on a freshly created team). The Hello
  process now just composes and reports a greeting; a clean `create` → `validate`
  emits zero warnings.

This is **not** a config-format change — `package.json` is not parsed by the
runtime, and the declarative surface (`agent.md`/`tools.json`/`processes`/
`ravel.json`) is unchanged. See
[docs/config-format.md](https://github.com/RunRavel/ravel/blob/main/docs/config-format.md).

## 0.2.0 — 2026-07-17

Declarative config validation + config-format versioning.

### Added

- **Config lint** — advisory, non-fatal warnings surfaced at `ravel validate`
  and at `serve` startup (as `config.warning` audit events):
  - **Generic memory writes** (`mem_text_set`/`mem_json_set`/`mem_json_merge`/
    `mem_queue_append`/`mem_queue_clear`) warn — prefer a typed `plugin.ts` tool
    for durable domain data (guards against agent memory-key sprawl).
  - **Env**: a declared `env` key missing from the `.env` chain/`process.env`,
    or a `${KEY}` used in an mcpServers header but not declared, warns.
  - **Unknown tool grant** (serve only): a grant naming no known tool is flagged
    as dead (suppressed when the node declares an mcpServer).
- **`tools.json` `env: []`** — declare the host env keys an agent expects, so the
  linter can catch missing/undeclared keys (fixes the silent empty-`${KEY}` footgun).
- **`ravel.json` `runtimeVersion` is now read and checked** — a warn-only semver
  range check against the installed runtime (previously a dead field).
- Public API: `TOOL_CATALOG`/`BUILTIN_TOOLS`/`isCatalogTool`/`isMemoryWriteTool`,
  `lintRegistry`, `parseManifest`/`satisfiesRange`/`Manifest`, `runtimeVersion`,
  and `Diagnostic` (now with an optional `severity`).

- **`ravel validate --json`** — one JSON object (`ok`, `nodes`, `processCount`,
  `diagnostics`) instead of human-readable text, for CI/scripting.
- **`ravel serve --log-format json`** (or `RAVEL_LOG_FORMAT=json`) — the verbose
  stream emits NDJSON (one object per line, with a `level`: info/warn/error)
  instead of pretty text, for log aggregators (Datadog, CloudWatch, Loki).
  Implies `--verbose`. `AppOptions.logFormat` for embedders.
- `Diagnostic` gains an optional `code` (e.g. `"memory-write"`, `"env-missing"`)
  — a stable identifier for the lint rule that produced it, exported as
  `LINT_CODES`. Lets `validate`'s text output group repeated warnings instead of
  printing the same explanation N times, and lets API/JSON consumers key off a
  code instead of parsing prose.
- **`GET /api/validate` and `PUT /api/files` now include lint warnings**
  (severity + code), not just compile errors — the metadata a hosting platform
  or the console needs to show config warnings without scraping logs.

### Fixed

- `config.warning` audit events rendered as a bare `· config.warning` in `-v`
  output (no detail) — `formatEvent` was missing a case for the new event type.
- `--log-format json` didn't cover the CLI's own non-audit output — the missing
  `ANTHROPIC_API_KEY` warning, `serve`'s startup banner, and the
  unhandled-rejection/uncaughtException guard still printed plain text. All
  three now respect `--log-format`/`RAVEL_LOG_FORMAT`; the banner collapses to
  one structured `"Ravel service listening"` line with `host`/`port`/`org`/
  `consoleUrl` fields instead of four lines of prose.

### Changed

- `Diagnostic` gains an optional `severity` (`"error" | "warning"`; absent =
  error). Compilation still fails on any error; only explicit warnings are advisory.
- See [docs/config-format.md](https://github.com/RunRavel/ravel/blob/main/docs/config-format.md)
  for the declarative surface and its version history. All 0.2 additions are
  additive — 0.1 teams validate unchanged.

## 0.1.0 — 2026-07-13

First public release.

### Added

- `ravel serve` serves the built operator console (`ui/dist`) from the same
  port as the API — one command, one port.
- `ravel serve --state-dir <path>` — keep runtime state (memory, audit, runs)
  outside the config checkout.
- `ravel serve --read-only-config` — disable HTTP config/secret writes
  (`PUT /api/files`, `PUT /api/secrets` → 403) for workers whose config plane
  is git. Scheduler config stays writable.
- Graceful shutdown on `SIGTERM` (in addition to `SIGINT`) — container stops
  flush cleanly.
- Documented worker contract (health/startup semantics) in
  `docs/architecture.md`; a port bind failure exits non-zero instead of hanging.
- Operator console works mounted under a path prefix (relative asset + API
  URLs) — e.g. behind a gateway at `/teams/<id>/`.
- Apache-2.0 license.

### Changed

- **Runtime state dir renamed `.businessos` → `.ravel`.** On startup at the
  default state location, an existing `.businessos` dir is renamed to `.ravel`
  automatically (audited as `state.migrated`). Update your team repo's
  `.gitignore` to cover `.ravel/`.
- Operator console and CLI rebranded BusinessOS → Ravel; the UI dev-proxy env
  var is now `RAVEL_API` (was `BUSINESSOS_API`).
