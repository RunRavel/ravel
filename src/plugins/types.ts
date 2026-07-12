import type { ZodRawShape } from "zod";
import type { MemoryStore, MemoryScope } from "../memory/store.js";

/**
 * Team plugin contract. A team folder ships a `plugin.ts` whose **default export**
 * is `definePlugin({...})`. The platform loads it, scopes its tools to that team,
 * and registers its gated actions on the executor — without any of the team's
 * domain code living in `src/`.
 *
 * Two kinds of capability:
 *  - `tools`   — in-process MCP tools the agent can call during reasoning. Their
 *                permission policy comes from the agent's `tools.json` (auto/ask/deny),
 *                exactly like built-in/office tools.
 *  - `actions` — deterministic handlers run by the executor AFTER a human approves
 *                a proposal. A *gated* tool is one that appears in BOTH lists with
 *                the same name and `policy:"ask"` in tools.json: the tool call is
 *                deferred to a proposal, and the action performs the real write on
 *                approval. (This is exactly how `promote_to_watchlist` works.)
 */

/** Context handed to a plugin tool handler (called during agent reasoning). */
export interface PluginToolCtx {
  memory: MemoryStore;
  nodeId: string;
  /** The team-memory scope key (manager + direct reports share it). */
  managerNodeId: string;
  /** Convenience: the resolved team `MemoryScope` for durable team state. */
  teamScope: MemoryScope;
  /** The agent's working directory for this call. */
  cwd: string;
  /** Only the env vars the plugin declared in `env`, resolved from the host. */
  env: Record<string, string>;
}

/** Context handed to a plugin executor action (run post-approval). */
export interface PluginActionCtx {
  cwd: string;
  nodeId: string;
  runId?: string;
  managerNodeId?: string;
  /** Durable store, injected by the platform so a gated action can persist its write. */
  memory: MemoryStore;
  /** The team `MemoryScope`, when the approved proposal carried a team (`managerNodeId`). */
  teamScope?: MemoryScope;
}

export interface PluginActionResult {
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface PluginTool {
  name: string;
  description: string;
  /** A Zod raw shape (e.g. `{ url: z.string() }`) — the tool's input schema. */
  schema: ZodRawShape;
  /** Returns a plain value (JSON-wrapped for the model) or an MCP content object. */
  handler: (input: Record<string, unknown>, ctx: PluginToolCtx) => Promise<unknown>;
}

export interface PluginAction {
  name: string;
  handler: (input: unknown, ctx: PluginActionCtx) => Promise<PluginActionResult>;
}

export interface PluginDefinition {
  name: string;
  version?: string;
  /** Host env var names this plugin needs (forwarded into `PluginToolCtx.env`). */
  env?: string[];
  tools?: PluginTool[];
  actions?: PluginAction[];
}

/** Identity helper a team's `plugin.ts` calls as its default export. */
export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}

/** Structural validation of a dynamically-imported plugin default export. */
export function isPluginDefinition(x: unknown): x is PluginDefinition {
  if (!x || typeof x !== "object") return false;
  const d = x as Record<string, unknown>;
  if (typeof d["name"] !== "string") return false;
  const toolsOk =
    d["tools"] === undefined ||
    (Array.isArray(d["tools"]) &&
      d["tools"].every(
        (t) => t && typeof (t as PluginTool).name === "string" && typeof (t as PluginTool).handler === "function" && typeof (t as PluginTool).schema === "object",
      ));
  const actionsOk =
    d["actions"] === undefined ||
    (Array.isArray(d["actions"]) && d["actions"].every((a) => a && typeof (a as PluginAction).name === "string" && typeof (a as PluginAction).handler === "function"));
  return toolsOk && actionsOk;
}
