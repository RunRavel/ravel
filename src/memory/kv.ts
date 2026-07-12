import { MemoryStore, type MemoryScope } from "./store.js";

/**
 * Shared, domain-agnostic helpers over the generic `MemoryStore`. Used by both
 * the platform's generic memory tools (`genericTools.ts`) and any in-tree/plugin
 * tools that keep durable per-team state.
 *
 * `MemoryStore.set` is a whole-file overwrite with no locking, so every
 * read-modify-write goes through a per-(scope,key) async mutex to avoid lost
 * updates when agents write concurrently.
 */

// --- per-key serialization (mutex) ------------------------------------------

const chains = new Map<string, Promise<unknown>>();

/** Serialize async work per key so concurrent read-modify-writes don't clobber. */
export function withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const result = prev.then(fn, fn);
  // Swallow errors on the stored chain so one failure doesn't wedge the lock.
  chains.set(
    key,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

/** A stable lock key for a (scope, key) pair. */
export function lockKey(scope: MemoryScope, key: string): string {
  const s = scope.kind === "team" ? `team:${scope.managerNodeId}` : scope.kind === "agent" ? `agent:${scope.nodeId}` : "org";
  return `${s}#${key}`;
}

/** Read a JSON-serialized value from memory, falling back on missing/corrupt. */
export async function readJson<T>(memory: MemoryStore, scope: MemoryScope, key: string, fallback: T): Promise<T> {
  const raw = await memory.get(scope, key);
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/** Wrap any value as an MCP tool text result (`{content:[{type:"text",...}]}`). */
export function json(value: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(value) }] };
}
