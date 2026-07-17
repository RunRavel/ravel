# Changelog

All notable changes to `@runravel/ravel`. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

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
