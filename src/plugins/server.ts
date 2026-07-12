import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { json } from "../memory/kv.js";
import type { MemoryStore } from "../memory/store.js";
import type { PluginTool, PluginToolCtx } from "./types.js";

function isContent(x: unknown): x is { content: unknown[] } {
  return !!x && typeof x === "object" && Array.isArray((x as { content?: unknown }).content);
}

/**
 * Build the in-process `plugin` MCP server for a team's plugin tools that the
 * agent was granted. Tool handlers get a `PluginToolCtx` (memory, team scope,
 * cwd, declared env). A handler may return an MCP content object or a plain value
 * (JSON-wrapped for the model).
 */
export function buildPluginServer(
  grantedNames: string[],
  pluginTools: PluginTool[],
  ctx: { nodeId: string; managerNodeId: string; memory: MemoryStore; cwd: string; env: Record<string, string> },
): McpServerConfig | null {
  const granted = new Set(grantedNames);
  const toolCtx: PluginToolCtx = {
    memory: ctx.memory,
    nodeId: ctx.nodeId,
    managerNodeId: ctx.managerNodeId,
    teamScope: { kind: "team", managerNodeId: ctx.managerNodeId },
    cwd: ctx.cwd,
    env: ctx.env,
  };
  const tools = pluginTools
    .filter((t) => granted.has(t.name))
    .map((t) =>
      tool(t.name, t.description, t.schema, async (args: Record<string, unknown>) => {
        const out = await t.handler(args, toolCtx);
        return isContent(out) ? out : json(out);
      }),
    );
  if (tools.length === 0) return null;
  return createSdkMcpServer({ name: "plugin", version: "1.0.0", tools });
}
