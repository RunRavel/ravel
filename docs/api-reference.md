# API Reference

Ravel is usable programmatically, not just via the CLI — a hosting platform
embeds it, and team plugins build against its memory/plugin types. Everything
below is exported from `@runravel/ravel`'s single entry point,
[src/index.ts](https://github.com/RunRavel/ravel/blob/main/src/index.ts).
**Deep `src/...` imports are not part of the contract** and may change between
versions — import only from the package root.

```ts
import { App, SdkEngine } from "@runravel/ravel";
```

## Platform / runtime

### `App`

The composition root — wires the control plane (folder-tree watcher →
lifecycle), the orchestrator, agent runtimes, the message bus, memory, and the
trust layer (audit, approvals, kill switch, observability) into one object.

```ts
const app = new App({ root: "my-team", engine: new SdkEngine() });
await app.start();                              // compile the org, spawn agents, begin watching
const result = await app.runProcess("My Process", { inputs: { who: "Ravel" } });
const reply = await app.chat("growth/copywriter", "what's the status?");
app.pendingProposals();                         // Proposal[] awaiting a human decision
await app.resolveProposal(id, "approve");        // runs the executor action deterministically
app.kill("growth");                             // abort a subtree; app.clearKill("growth") to resume
app.dashboard();                                 // DashboardSnapshot: spend, per-agent state, runs
await app.stop();
```

`AppOptions.logFormat`: `"pretty"` (default) or `"json"` — how the `verbose`
sink renders each event (NDJSON with a `level`, for log aggregators). Only
takes effect when `verbose` is set.

`AppOptions`: `root` (org folder), `engine` (an `AgentEngine`), plus optional
`audit`, `dryRun`, `verbose`, `runtimeDir` (default `<root>/.ravel`),
`persistMessages`, `approvals` (`"deferred"` default, or `"sync"` for
blocking interactive approval), `watchOptions` (chokidar passthrough).

### `SdkEngine` / `FakeEngine` / `AgentEngine`

The LLM backend seam. `SdkEngine` is production — it drives the Claude Agent
SDK, builds MCP servers per call (declared `mcpServers` + in-process
`office`/`mem`/`plugin` tools), and wires `canUseTool` to Ravel's own
permission gate rather than the SDK's own prompts. `FakeEngine` is a scripted
engine for tests (no API key) — see
[src/runtime/fakeEngine.ts](https://github.com/RunRavel/ravel/blob/main/src/runtime/fakeEngine.ts)
for its programmable-turn shape.

`AgentEngine` is the interface both implement (`run(req: EngineRequest):
Promise<EngineResult>`) — the seam a second provider would implement to route
some agents to a different model family without touching the orchestrator.
`assembleMcpServers(req)` (also exported) builds the MCP server map for a call
and is asserted directly in tests without needing an API key.

## Memory

### `MemoryStore`

File-backed memory keyed by `MemoryScope` (`{kind:"agent",nodeId}` |
`{kind:"team",managerNodeId}` | `{kind:"org"}`) + a string key. Values are
plain text (markdown). `get`/`set`/`list`; `org` writes require `{
allowOrgWrite: true }` — a worker can't casually rewrite company-wide facts.

```ts
await memory.set({ kind: "team", managerNodeId: "growth" }, "notes", "...");
const notes = await memory.get({ kind: "team", managerNodeId: "growth" }, "notes");
```

### `withLock`, `lockKey`, `readJson`, `json`

Helpers for building your own memory-backed tools on top of `MemoryStore`
(used internally by the generic `mem_*` tools, and by team plugins that keep
durable state). `MemoryStore.set` is a whole-file overwrite with no locking of
its own — `withLock(lockKey(scope, key), fn)` serializes concurrent
read-modify-writes per (scope, key) so agents writing at the same time don't
clobber each other. `readJson(memory, scope, key, fallback)` reads and
`JSON.parse`s a value, returning `fallback` on missing/corrupt data. `json(v)`
wraps any value as an MCP tool text result.

### `queueAppend`, `queueClear`, `resolveScope`, `buildGenericMemoryServer`, `GENERIC_MEMORY_TOOL_NAMES`

The building blocks behind the built-in `mem_queue_append/list/clear` tools —
reusable if a plugin wants its own dedup+cap queue semantics.
`buildGenericMemoryServer` assembles the in-process `mem` MCP server from a
grant list; `GENERIC_MEMORY_TOOL_NAMES` is the full list of tool names it can
expose (`mem_text_get/set`, `mem_json_get/set/merge`,
`mem_queue_append/list/clear`, `mem_keys`) — grant these by name in
`tools.json`.

## Config validation

The building blocks behind `ravel validate` / the `-v` startup lint — useful for
a hosting platform that wants to check a team's config before deploying it, or
a console that wants to show warnings inline.

### `lintRegistry`

`lintRegistry(snapshot, ctx?): Promise<Diagnostic[]>` — runs the advisory lint
(generic memory-write grants, missing/undeclared env, unknown tool grants,
`runtimeVersion` mismatch) over a compiled `RegistrySnapshot` and returns
warning diagnostics. `LintContext` is optional and partial: pass `secrets` (a
`SecretStore`) for the env checks, `pluginToolNamesByNode` (only knowable once
plugins are loaded) to enable the unknown-tool check, and `installedVersion`
to override the runtime version read for tests.

### `Diagnostic`, `LINT_CODES`

`Diagnostic` — `{ where, message, severity?, code? }`. Absent `severity` means
error (fails compile); `"warning"` is advisory. `code` is a stable identifier
for the rule that produced a warning (`LINT_CODES.memoryWrite` = `"memory-write"`,
etc. — see [config-format.md](./config-format.md) for the full list).

### `TOOL_CATALOG`, `BUILTIN_TOOLS`, `isCatalogTool`, `isMemoryWriteTool`

The declarative catalog of tools the runtime itself provides (built-in SDK
tools, office actions, generic memory tools) — the source of truth `lintRegistry`
checks grants against. Plugin and remote-MCP tool names are never in the
catalog (unknowable statically); see `lintRegistry` above for how those are handled.

### `parseManifest`, `satisfiesRange`, `Manifest`, `runtimeVersion`

`parseManifest(source)` parses a `ravel.json` string (throws on invalid JSON/shape).
`satisfiesRange(version, range)` is the minimal semver-range check behind the
`runtimeVersion` warning (caret/tilde/exact only — not a full semver
implementation). `runtimeVersion()` returns the installed `@runravel/ravel` version.

## Plugins

What a team's `plugin.ts` builds against (see
[authoring-teams.md](./authoring-teams.md#plugints--team-code-tools--gated-actions)
for the authoring guide and a worked example).

### `definePlugin`, `isPluginDefinition`

`definePlugin(def: PluginDefinition): PluginDefinition` is an identity helper
— a team's `plugin.ts` calls it as its default export purely for type
inference; there's no magic beyond the type check.
`isPluginDefinition(x): x is PluginDefinition` is the structural validator the
loader uses on a dynamically-imported default export.

### `PluginDefinition`, `PluginTool`, `PluginAction`

```ts
interface PluginDefinition {
  name: string;
  version?: string;
  env?: string[];          // host env var names forwarded into PluginToolCtx.env
  tools?: PluginTool[];     // in-process MCP tools, permissioned via the agent's tools.json
  actions?: PluginAction[]; // executor handlers run AFTER a human approves a proposal
}
```

A **gated tool** is a `PluginTool` and a `PluginAction` sharing the same
`name`, with that name set to `policy: "ask"` in `tools.json`: the tool call
is deferred to a Proposal, and the action performs the real write on
approval. A gated tool with no matching action is un-executable.

### `PluginToolCtx`, `PluginActionCtx`, `PluginActionResult`

`PluginToolCtx` (handed to a tool handler during agent reasoning): `memory`,
`nodeId`, `managerNodeId`, `teamScope` (the resolved team `MemoryScope`),
`cwd`, `env` (only the vars the plugin declared). `PluginActionCtx` (handed to
an action handler post-approval): `cwd`, `nodeId`, `runId?`,
`managerNodeId?`, `memory`, `teamScope?`. `PluginActionResult`: `{ ok:
boolean; result?: unknown; error?: string }`.

## Trust

### `ActionHandler`, `ActionContext`, `ActionResult`

The executor's own contract (what a plugin's `PluginAction.handler` ultimately
conforms to, minus the plugin-specific context fields): `type ActionHandler =
(input: unknown, ctx: ActionContext) => Promise<ActionResult>`.
`ActionContext` is `{ cwd, nodeId, runId?, managerNodeId? }`. Actions are
registered by the bare tool name a gated call proposed (e.g.
`"deliver_to_client"`) and run deterministically on approval — no model call.
