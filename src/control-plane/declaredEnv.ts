import type { RegistrySnapshot } from "./registry.js";
import { referencedEnvKeys } from "./lint.js";

/** One env key a node's declarative config names it needs. */
export interface DeclaredEnvEntry {
  /** Root-relative node id (POSIX slashes, `""` for the team root). */
  nodePath: string;
  key: string;
}

/**
 * Every env key a node's declarative config declares it needs: `tools.json`'s
 * own `env[]` plus any key its `mcpServers` reference (a stdio server's own
 * `env[]` names, or a `${KEY}` substituted into an http/sse header) — the same
 * "declared" set `lintRegistry`'s env checks already treat as authoritative.
 *
 * Derived purely from the compiled registry snapshot, so it never imports a
 * team's `plugin.ts` and runs fine in a bare checkout with no `node_modules`
 * installed — the same constraint `validate`/`compileRegistry` already meet.
 *
 * This is a **best-effort hint, not a complete inventory**: a plugin tool
 * handler can read `process.env` directly without declaring it, and a
 * plugin's own `env: string[]` (`plugins/types.ts`) is a separate declaration
 * this does not see — seeing it would require importing team code. See
 * docs/config-format.md for the full rationale; a consumer should present
 * this as "what the config declares", not "everything this team could need".
 */
export function declaredEnv(snapshot: RegistrySnapshot): DeclaredEnvEntry[] {
  const out: DeclaredEnvEntry[] = [];
  for (const node of snapshot.nodes.values()) {
    const { httpRefs, stdioNames } = referencedEnvKeys(node);
    const keys = new Set<string>([...node.tools.env, ...stdioNames, ...httpRefs]);
    for (const key of keys) out.push({ nodePath: node.id, key });
  }
  out.sort((a, b) => a.nodePath.localeCompare(b.nodePath) || a.key.localeCompare(b.key));
  return out;
}
