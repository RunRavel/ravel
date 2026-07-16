import { OFFICE_TOOL_NAMES } from "../runtime/officeActions.js";
import { GENERIC_MEMORY_TOOL_NAMES } from "../memory/genericTools.js";

/**
 * The declarative catalog of built-in, grantable tool names — the single source
 * of truth for "what can an agent's tools.json legally name" among the tools the
 * runtime itself provides (built-in SDK tools, office actions, generic memory).
 *
 * Team **plugin** tools and remote **mcpServers** tools are NOT here: plugin tool
 * names aren't known until a plugin is loaded (serve time), and MCP tool names are
 * remote/unknown at compile time. Validation accounts for that (see lint.ts).
 *
 * Exported so the lint pass, the operator console, and embedders can reason about
 * grants against one authoritative list instead of hard-coding names.
 */

export type ToolKind = "builtin" | "office" | "memory";
export type ToolAccess = "read" | "write";

export interface CatalogEntry {
  name: string;
  kind: ToolKind;
  /** For memory tools: whether the tool mutates durable state. */
  access?: ToolAccess;
}

/**
 * Built-in SDK tools an author may opt into by name in tools.json. Heavy tools
 * (Bash, Edit, WebSearch, …) are off unless explicitly granted. This is the
 * canonical list; `runtime/agent.ts` imports it to decide which SDK built-ins to
 * expose per call.
 */
export const BUILTIN_TOOLS = [
  "Bash",
  "Read",
  "Write",
  "Edit",
  "Glob",
  "Grep",
  "WebSearch",
  "WebFetch",
  "TodoWrite",
  "NotebookEdit",
  "Task",
] as const;

/**
 * Generic memory tools that MUTATE durable state. Granting these lets an agent
 * write arbitrary keys in its scope — prefer a typed plugin tool for durable
 * domain data; the lint pass warns on these grants.
 */
export const MEMORY_WRITE_TOOL_NAMES = [
  "mem_text_set",
  "mem_json_set",
  "mem_json_merge",
  "mem_queue_append",
  "mem_queue_clear",
] as const;

const MEMORY_WRITE = new Set<string>(MEMORY_WRITE_TOOL_NAMES);

/** Every built-in/office/memory tool the runtime provides, tagged by kind/access. */
export const TOOL_CATALOG: CatalogEntry[] = [
  ...BUILTIN_TOOLS.map((name): CatalogEntry => ({ name, kind: "builtin" })),
  ...OFFICE_TOOL_NAMES.map((name): CatalogEntry => ({ name, kind: "office" })),
  ...GENERIC_MEMORY_TOOL_NAMES.map(
    (name): CatalogEntry => ({
      name,
      kind: "memory",
      ...(MEMORY_WRITE.has(name) ? { access: "write" as const } : { access: "read" as const }),
    }),
  ),
];

const CATALOG_NAMES = new Set(TOOL_CATALOG.map((e) => e.name));

/** True if `name` is a tool the runtime itself provides (built-in/office/memory). */
export function isCatalogTool(name: string): boolean {
  return CATALOG_NAMES.has(name);
}

/** True if `name` is a generic memory tool that mutates durable state. */
export function isMemoryWriteTool(name: string): boolean {
  return MEMORY_WRITE.has(name);
}
