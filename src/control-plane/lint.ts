import type { Diagnostic, RegistrySnapshot, RegistryNode } from "./registry.js";
import { isMemoryWriteTool, isCatalogTool } from "../schemas/catalog.js";
import { satisfiesRange } from "../schemas/manifest.js";
import { runtimeVersion } from "../domain/version.js";
import type { SecretStore } from "../secrets/store.js";

/**
 * Advisory lint over a compiled snapshot. Unlike the structural compiler
 * (`registry.ts`), everything here is a **warning** — surfaced by `validate`
 * and at `serve` startup, never fatal. Keeping it separate keeps compilation
 * pure and gives one home for "this is legal but probably not what you want".
 *
 * Context is optional so the same pass runs with partial info at `validate`
 * (no plugins loaded, but `.env` chains resolvable) and full info at `serve`
 * (plugins loaded → real plugin tool names known).
 */
export interface LintContext {
  /** Resolves a node's `.env` chain, for the missing-env check. */
  secrets?: SecretStore;
  /**
   * Resolved plugin tool names available to a node, by node id. Present only at
   * serve (plugins loaded). When absent, the unknown-tool check is skipped —
   * plugin/MCP tool names can't be known statically.
   */
  pluginToolNamesByNode?: (nodeId: string) => string[];
  /**
   * Installed runtime version for the manifest `runtimeVersion` check. Defaults
   * to the real installed version; overridable in tests.
   */
  installedVersion?: string;
}

/** Matches `${KEY}` references (same shape the SDK substitutes in headers). */
const ENV_REF_RE = /\$\{([A-Z_][A-Z0-9_]*)\}/g;

/** All env keys a node's mcpServers reference or forward (statically discoverable). */
function referencedEnvKeys(node: RegistryNode): { httpRefs: Set<string>; stdioNames: Set<string> } {
  const httpRefs = new Set<string>();
  const stdioNames = new Set<string>();
  for (const spec of Object.values(node.tools.mcpServers)) {
    if (spec.type === "stdio") {
      for (const name of spec.env ?? []) stdioNames.add(name);
    } else {
      // http | sse — ${KEY} is substituted into header VALUES only.
      for (const value of Object.values(spec.headers ?? {})) {
        for (const m of value.matchAll(ENV_REF_RE)) httpRefs.add(m[1]!);
      }
    }
  }
  return { httpRefs, stdioNames };
}

/** Warn on generic memory WRITE grants — prefer a typed plugin tool for durable data. */
function lintMemoryWrites(node: RegistryNode, where: string, out: Diagnostic[]): void {
  for (const grant of node.tools.tools) {
    if (grant.policy === "deny") continue;
    if (isMemoryWriteTool(grant.name)) {
      out.push({
        where,
        severity: "warning",
        message: `grants generic memory write "${grant.name}" — prefer a typed plugin tool for durable domain data (agents inventing keys leads to memory sprawl; see docs/authoring-teams.md).`,
      });
    }
  }
}

/**
 * Warn when a declared env key isn't resolvable, or a `${KEY}` is used without
 * being declared. Declared set = tools.json `env[]` ∪ stdio server `env[]` names.
 * (Plugin `env` is validated at serve where the plugin is loaded.)
 */
async function lintEnv(node: RegistryNode, where: string, ctx: LintContext, out: Diagnostic[]): Promise<void> {
  const { httpRefs, stdioNames } = referencedEnvKeys(node);
  const declared = new Set<string>([...node.tools.env, ...stdioNames]);

  // A `${KEY}` referenced in a header but never declared → warn (drives explicit-only).
  for (const key of httpRefs) {
    if (!declared.has(key)) {
      out.push({
        where,
        severity: "warning",
        message: `env "${key}" is used in an mcpServers header but not declared in tools.json "env" — declare it so missing keys are caught.`,
      });
    }
  }

  // Every declared key (and used header key) should resolve at run time.
  if (ctx.secrets) {
    const resolved = await ctx.secrets.resolve(node.dir).catch(() => ({}) as Record<string, string>);
    const expected = new Set<string>([...declared, ...httpRefs]);
    for (const key of expected) {
      const present = resolved[key] !== undefined || process.env[key] !== undefined;
      if (!present) {
        out.push({
          where,
          severity: "warning",
          message: `expected env "${key}" not found in the .env chain or process.env — tools relying on it will get an empty value.`,
        });
      }
    }
  }
}

/**
 * Warn on a grant that names no known tool (a dead grant). Serve-only: needs
 * loaded plugin tool names, and can't see remote MCP tool names — so it only
 * fires for a name that is neither a catalog tool, a plugin tool, nor plausibly
 * an MCP tool (i.e. the node declares no mcpServers).
 */
function lintUnknownTools(
  node: RegistryNode,
  where: string,
  ctx: LintContext,
  out: Diagnostic[],
): void {
  if (!ctx.pluginToolNamesByNode) return; // validate-time: skip (names unknowable)
  const pluginNames = new Set(ctx.pluginToolNamesByNode(node.id));
  const hasMcpServers = Object.keys(node.tools.mcpServers).length > 0;
  for (const grant of node.tools.tools) {
    if (isCatalogTool(grant.name) || pluginNames.has(grant.name)) continue;
    // Could be a remote MCP tool (unknowable here) — only warn if there's no MCP server at all.
    if (hasMcpServers) continue;
    out.push({
      where,
      severity: "warning",
      message: `grant "${grant.name}" names no known tool (not a built-in, office, memory, or this team's plugin tool) — it is a dead grant.`,
    });
  }
}

/** Warn when the team pins a runtimeVersion the installed runtime doesn't satisfy. */
function lintRuntimeVersion(snapshot: RegistrySnapshot, ctx: LintContext, out: Diagnostic[]): void {
  const range = snapshot.manifest?.runtimeVersion;
  if (!range) return;
  const installed = ctx.installedVersion ?? runtimeVersion();
  if (!satisfiesRange(installed, range)) {
    out.push({
      where: "ravel.json",
      severity: "warning",
      message: `team pins runtimeVersion "${range}" but the installed @runravel/ravel is ${installed} — config may target a different format.`,
    });
  }
}

/** Run all advisory checks over a snapshot. Returns warning diagnostics only. */
export async function lintRegistry(snapshot: RegistrySnapshot, ctx: LintContext = {}): Promise<Diagnostic[]> {
  const out: Diagnostic[] = [];
  lintRuntimeVersion(snapshot, ctx, out);
  for (const node of snapshot.nodes.values()) {
    const where = node.id === "" ? "tools.json" : `${node.id}/tools.json`;
    lintMemoryWrites(node, where, out);
    await lintEnv(node, where, ctx, out);
    lintUnknownTools(node, where, ctx, out);
  }
  return out;
}
