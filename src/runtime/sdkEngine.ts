import { query } from "@anthropic-ai/claude-agent-sdk";
import type { Options, McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import type { AgentEngine, EngineRequest, EngineResult, EngineToolUse } from "./engine.js";
import { emptyUsage, type Usage } from "../domain/types.js";
import { usageFor } from "../domain/pricing.js";
import type { McpServerSpec, ToolsConfig } from "../schemas/tools.js";
import { MODEL_IDS } from "../schemas/common.js";
import { buildOfficeServer } from "./officeTools.js";
import { buildGenericMemoryServer } from "../memory/genericTools.js";
import { buildPluginServer } from "../plugins/server.js";

/**
 * Assemble the MCP servers for a call: declared servers + in-process servers for
 * the granted tools — `office` actions, generic `mem` primitives (text/json/queue),
 * and any team-provided `plugin` tools. Domain connectors (X/PDL, watchlists, etc.)
 * live in team plugins, not the runtime. The plugin/mem servers are built only when a
 * `toolContext` is present (FakeEngine omits it). Exported so the wiring can be
 * asserted without an API key.
 */
export function assembleMcpServers(req: EngineRequest): Record<string, McpServerConfig> {
  // Per-node credentials (the agent's `.env` chain); resolved for declared MCP servers.
  const nodeEnv = req.nodeEnv ?? {};

  const servers = toSdkMcpServers(req.tools, nodeEnv);
  const grantedNames = req.tools.tools.filter((t) => t.policy !== "deny").map((t) => t.name);

  const office = buildOfficeServer(grantedNames, req.cwd);
  if (office) servers["office"] = office;

  if (req.toolContext) {
    // Generic, domain-agnostic memory primitives (text / json / queue).
    const mem = buildGenericMemoryServer(grantedNames, {
      nodeId: req.toolContext.nodeId,
      managerNodeId: req.toolContext.managerNodeId,
      memory: req.toolContext.memory,
    });
    if (mem) servers["mem"] = mem;
    // Team-provided plugin tools (scoped to this node's team).
    if (req.toolContext.pluginTools) {
      const plugin = buildPluginServer(grantedNames, req.toolContext.pluginTools, {
        nodeId: req.toolContext.nodeId,
        managerNodeId: req.toolContext.managerNodeId,
        memory: req.toolContext.memory,
        cwd: req.cwd,
        env: req.toolContext.pluginEnv ?? {},
      });
      if (plugin) servers["plugin"] = plugin;
    }
  }
  return servers;
}

/**
 * Translate our MCP specs into the SDK's McpServerConfig, resolving credentials
 * from the node's scoped env first, then the host `process.env`. So a per-agent
 * `.env` key reaches an external MCP's stdio env or `${VAR}` http headers.
 */
function toSdkMcpServers(tools: ToolsConfig, nodeEnv: Record<string, string>): Record<string, McpServerConfig> {
  const out: Record<string, McpServerConfig> = {};
  for (const [name, spec] of Object.entries(tools.mcpServers)) {
    out[name] = toSdkMcpServer(spec, nodeEnv);
  }
  return out;
}

/** Substitute `${VAR}` placeholders from the node's env, then process.env. */
function subst(value: string, nodeEnv: Record<string, string>): string {
  return value.replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_m, k: string) => nodeEnv[k] ?? process.env[k] ?? "");
}

function toSdkMcpServer(spec: McpServerSpec, nodeEnv: Record<string, string>): McpServerConfig {
  if (spec.type === "stdio") {
    const env: Record<string, string> = {};
    for (const key of spec.env ?? []) {
      const val = nodeEnv[key] ?? process.env[key];
      if (val !== undefined) env[key] = val;
    }
    return {
      type: "stdio",
      command: spec.command,
      ...(spec.args ? { args: spec.args } : {}),
      ...(Object.keys(env).length ? { env } : {}),
    };
  }
  // http | sse — substitute ${VAR} placeholders in header values from node env.
  const headers = spec.headers
    ? Object.fromEntries(Object.entries(spec.headers).map(([k, v]) => [k, subst(v, nodeEnv)]))
    : undefined;
  return {
    type: spec.type,
    url: spec.url,
    ...(headers ? { headers } : {}),
  };
}

/**
 * The production AgentEngine: drives the Claude Agent SDK's agent loop.
 *
 * - `canUseTool` is wired to the runtime's approval gate, so every tool call is
 *   gated by our permission policy / HITL queue — not the SDK's own prompts.
 * - The kill-switch/budget abort signal is passed straight through.
 * - Usage is reported per assistant turn so the runtime can enforce token/cost
 *   budgets between turns.
 *
 * Requires ANTHROPIC_API_KEY (or an `ant auth login` profile) in the environment.
 */
export class SdkEngine implements AgentEngine {
  constructor() {
    // Claude Code (the SDK) uses a family of models, not just the one we pass
    // per agent: a background "haiku" for cheap auxiliary work (summarization,
    // topic/title detection) and a default "sonnet"/"opus" for others. Left
    // alone, this build's default sonnet is the older 4-5. Pin all three to
    // current-gen so background calls stay on models we actually chose. Any
    // value the operator already exported is respected.
    process.env["ANTHROPIC_DEFAULT_OPUS_MODEL"] ??= MODEL_IDS.opus;
    process.env["ANTHROPIC_DEFAULT_SONNET_MODEL"] ??= MODEL_IDS.sonnet;
    process.env["ANTHROPIC_DEFAULT_HAIKU_MODEL"] ??= MODEL_IDS.haiku;
    // Suppress Claude Code's non-essential network traffic (telemetry, auto-update,
    // error reporting). Note: this does NOT stop its baked-in background model
    // calls (title/topic generation, etc.) — only the ApiEngine avoids those.
    process.env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"] ??= "1";
  }

  async run(req: EngineRequest): Promise<EngineResult> {
    const abortController = new AbortController();
    // Bridge the runtime's signal into the SDK's own AbortController.
    if (req.signal.aborted) abortController.abort();
    else req.signal.addEventListener("abort", () => abortController.abort(), { once: true });

    const toolUses: EngineToolUse[] = [];

    const options: Options = {
      model: req.model,
      systemPrompt: req.systemPrompt,
      cwd: req.cwd,
      abortController,
      // Scope the built-in toolset to only what this agent needs. `[]` disables
      // all built-in tools, dropping thousands of tokens of schemas per call.
      tools: req.builtinTools,
      ...(req.maxTurns !== undefined ? { maxTurns: req.maxTurns } : {}),
      mcpServers: assembleMcpServers(req),
      permissionMode: "default",
      canUseTool: async (toolName, input) => {
        toolUses.push({ name: toolName, input });
        const decision = await req.decide({ name: toolName, input });
        if (decision === "allow") {
          return { behavior: "allow", updatedInput: input };
        }
        return {
          behavior: "deny",
          message:
            "Queued for human approval — do not retry; continue without it and note it as pending in your summary.",
          interrupt: false,
        };
      },
    };

    let finalText = "";
    let usage: Usage = emptyUsage();
    let stopReason: EngineResult["stopReason"] = "done";
    let error: string | undefined;

    try {
      for await (const message of query({ prompt: req.prompt, options })) {
        if (message.type === "assistant") {
          // Report this turn's usage (cache-aware) so the runtime can enforce
          // budgets mid-run and surface cache reads/writes.
          const u = message.message.usage;
          if (u) {
            req.onUsage?.(
              usageFor(
                req.model,
                u.input_tokens ?? 0,
                u.output_tokens ?? 0,
                u.cache_read_input_tokens ?? 0,
                u.cache_creation_input_tokens ?? 0,
              ),
            );
          }
        } else if (message.type === "result") {
          finalText = message.subtype === "success" ? message.result : "";
          // The SDK's total_cost_usd is authoritative (already cache-aware); keep
          // the token breakdown for visibility.
          usage = {
            inputTokens: message.usage.input_tokens ?? 0,
            outputTokens: message.usage.output_tokens ?? 0,
            cacheReadTokens: message.usage.cache_read_input_tokens ?? 0,
            cacheCreationTokens: message.usage.cache_creation_input_tokens ?? 0,
            usd: message.total_cost_usd,
          };
          if (message.subtype !== "success") {
            stopReason = "error";
            error = message.errors.join("; ") || message.subtype;
          }
        }
      }
    } catch (err) {
      if (abortController.signal.aborted) {
        return { text: finalText, usage, stopReason: "aborted", toolUses };
      }
      return {
        text: "",
        usage,
        stopReason: "error",
        toolUses,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    if (abortController.signal.aborted) stopReason = "aborted";
    return { text: finalText, usage, stopReason, toolUses, ...(error ? { error } : {}) };
  }
}
