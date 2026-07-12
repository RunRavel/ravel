import type { Usage, PermissionDecision } from "../domain/types.js";
import type { ToolsConfig } from "../schemas/tools.js";
import type { MemoryStore } from "../memory/store.js";
import type { PluginTool } from "../plugins/types.js";

/**
 * Platform services an engine may use to build the agent's tool environment
 * (e.g. memory-backed MCP tools). Kept provider-agnostic — `FakeEngine` ignores
 * it; `SdkEngine` uses it to assemble in-process MCP servers. Optional so the
 * port stays clean and older callers keep working.
 */
export interface ToolContext {
  nodeId: string;
  /** Team-memory scope (manager + direct reports share one key). */
  managerNodeId: string;
  memory: MemoryStore;
  /** This node's team plugin tools, if it ships a plugin (assembled as the `plugin` server). */
  pluginTools?: PluginTool[];
  /** The plugin's declared env vars, resolved from the host. */
  pluginEnv?: Record<string, string>;
}

export interface EngineToolUse {
  name: string;
  input: unknown;
}

/**
 * A single bounded model interaction. The runtime hands the engine a fully
 * resolved request; the engine runs the agent loop (tool calls included),
 * calling `decide` before any tool executes and reporting usage as it accrues.
 * The engine must stop promptly when `signal` aborts (kill switch / budget /
 * timeout).
 */
export interface EngineRequest {
  systemPrompt: string;
  model: string;
  /** The task or message to act on. */
  prompt: string;
  tools: ToolsConfig;
  /**
   * The built-in SDK tools to expose to the model (e.g. `["Read","Glob","Grep"]`).
   * `[]` disables all built-in tools. Scoping this is the main control on
   * per-call token cost — tool schemas are re-sent on every internal turn.
   */
  builtinTools: string[];
  /** Cap on the SDK's internal agentic turns for this single call. */
  maxTurns?: number;
  /** Platform services for building memory/connector tools (SdkEngine uses it). */
  toolContext?: ToolContext;
  /**
   * This node's resolved credentials (its `.env` chain). Used to scope per-agent
   * secrets into connector env, external-MCP stdio env, and `${VAR}` http headers —
   * callers fall back to `process.env`. Top-level (not in `toolContext`) so an
   * agent with external MCP servers but no memory still gets its keys.
   */
  nodeEnv?: Record<string, string>;
  /** Persistent per-agent working directory. */
  cwd: string;
  signal: AbortSignal;
  /** HITL gate: resolves allow/deny before a tool runs. */
  decide: (use: EngineToolUse & { rationale?: string }) => Promise<PermissionDecision>;
  /** Reports incremental usage so the runtime can enforce budgets live. */
  onUsage?: (u: Usage) => void;
}

export interface EngineResult {
  text: string;
  usage: Usage;
  stopReason: "done" | "aborted" | "error";
  /** Tool calls the model attempted (whether allowed or denied). */
  toolUses: EngineToolUse[];
  error?: string;
}

/**
 * The port the runtime depends on instead of a concrete LLM. The Claude Agent
 * SDK is one implementation (see `sdkEngine.ts`); tests use a scripted fake.
 * This keeps budget, approval, audit, and orchestration logic provider-agnostic
 * and runnable without an API key.
 */
export interface AgentEngine {
  run(req: EngineRequest): Promise<EngineResult>;
}
