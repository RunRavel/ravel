# Changelog

All notable changes to `@runravel/ravel`. The format follows
[Keep a Changelog](https://keepachangelog.com); versions follow semver.

## 0.1.0 — unreleased

First publishable version.

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
