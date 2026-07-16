import { z } from "zod";
import { PermissionPolicy } from "./common.js";

/**
 * One MCP server the agent may connect to. Mirrors the Claude Agent SDK's
 * McpServerConfig shape so entries can be passed through to the runtime with
 * minimal translation. Credentials in `env` are resolved from the host
 * environment at spawn time — never stored in the registry snapshot verbatim
 * where they could leak into logs.
 */
export const McpServerSpec = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).optional(),
      /** Env var names to forward from the host (values resolved at spawn). */
      env: z.array(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("http"),
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal("sse"),
      url: z.string().url(),
      headers: z.record(z.string()).optional(),
    })
    .strict(),
]);
export type McpServerSpec = z.infer<typeof McpServerSpec>;

/** A tool the agent may use, with its human-in-the-loop permission policy. */
export const ToolGrant = z
  .object({
    name: z.string().min(1),
    /** Default `ask` — consequential tools pause for human approval. */
    policy: PermissionPolicy.default("ask"),
    /** Optional note shown to the approver explaining what the tool does. */
    description: z.string().optional(),
  })
  .strict();
export type ToolGrant = z.infer<typeof ToolGrant>;

/**
 * The authored shape of a `tools.json` file: which tools and MCP servers an
 * agent may use, and the permission policy for each tool.
 */
export const ToolsConfig = z
  .object({
    tools: z.array(ToolGrant).default([]),
    mcpServers: z.record(McpServerSpec).default({}),
    /**
     * Host env var names this agent expects to be available (from its `.env`
     * chain or `process.env`). Declaring them lets `validate`/`serve` warn when
     * a key is missing or a `${KEY}` in an mcpServers header is used undeclared.
     * Actual use stays explicit: declare the keys your tools/servers rely on.
     */
    env: z.array(z.string()).default([]),
    /** Default policy for any tool not explicitly listed in `tools`. */
    defaultPolicy: PermissionPolicy.default("ask"),
    /**
     * Which built-in SDK file tools to auto-expose. `readonly` (default) gives
     * the agent Read/Glob/Grep so it can read its staged files. `none` withholds
     * them — for pure-judgment / memory-only agents that have no files to read
     * and would otherwise waste turns wandering the filesystem. Explicitly
     * granted built-ins (e.g. WebSearch) are unaffected either way.
     */
    builtins: z.enum(["readonly", "none"]).optional(),
  })
  .strict();
export type ToolsConfig = z.infer<typeof ToolsConfig>;

/** Parse and validate raw `tools.json` content. Throws ZodError on invalid input. */
export function parseToolsConfig(source: string): ToolsConfig {
  const data: unknown = JSON.parse(source);
  return ToolsConfig.parse(data);
}

/** The config an agent gets when it has no `tools.json` — no tools, all `ask`. */
export const EMPTY_TOOLS_CONFIG: ToolsConfig = {
  tools: [],
  mcpServers: {},
  env: [],
  defaultPolicy: "ask",
};
