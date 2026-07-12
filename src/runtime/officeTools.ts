import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { OFFICE_ACTIONS, OFFICE_TOOL_NAMES, isOfficeAction, runOfficeAction } from "./officeActions.js";

export { OFFICE_TOOL_NAMES } from "./officeActions.js";

/** Zod input shapes for the MCP tool definitions (executor doesn't need these). */
const SHAPES: Record<string, z.ZodRawShape> = {
  send_email: { to: z.string().describe("recipient"), subject: z.string().optional(), body: z.string().optional() },
  send_proposal: { to: z.string().describe("recipient"), summary: z.string().optional() },
  deliver_to_client: {
    to: z.string().optional(),
    files: z.string().optional().describe("what is being delivered"),
    summary: z.string().optional(),
  },
};

/**
 * Build an in-process MCP server exposing only the office tools the agent was
 * granted. The tool handlers delegate to the shared `runOfficeAction`, so the
 * synchronous MCP path and the async executor path do exactly the same thing.
 * Returns null if no office tool was granted (no MCP overhead added).
 *
 * Note: under the platform's default *deferred* approval mode these tools are
 * gated to "deny" and never actually execute here — they exist so the model can
 * *request* the action, which the broker records as a proposal. The real effect
 * happens later via the executor on human approval.
 */
export function buildOfficeServer(grantedNames: string[], cwd: string): McpServerConfig | null {
  const granted = grantedNames.filter(isOfficeAction);
  if (granted.length === 0) return null;

  const tools = granted.map((name) =>
    tool(name, OFFICE_ACTIONS[name].description, SHAPES[name]!, async (args: Record<string, unknown>) => {
      const r = await runOfficeAction(name, args, { cwd });
      return { content: [{ type: "text" as const, text: r.ok ? (r.result ?? "OK") : `error: ${r.error}` }] };
    }),
  );

  return createSdkMcpServer({ name: "office", version: "1.0.0", tools });
}
