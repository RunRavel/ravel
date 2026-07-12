import { z } from "zod";
import { tool, createSdkMcpServer } from "@anthropic-ai/claude-agent-sdk";
import type { McpServerConfig } from "@anthropic-ai/claude-agent-sdk";
import { MemoryStore, type MemoryScope } from "./store.js";
import { withLock, lockKey, readJson, json } from "./kv.js";

/**
 * Platform-level, domain-agnostic memory tools over the generic `MemoryStore`.
 * Three shapes cover essentially any team's durable state:
 *  - **text**  — a freeform string at a key.
 *  - **json**  — a structured value (object/array/scalar) at a key, with merge.
 *  - **queue** — an append-only list with optional dedup-by-field, a cap, and
 *                clear-by-field. (Watchlists, signal logs, candidate backlogs,
 *                etc. are all queues; cursor maps are json.)
 *
 * All tools are **team-scoped by default**; pass `scope` to target the agent's
 * private memory or the org-wide store. Org *writes* are gated: they require the
 * agent to be granted `mem_allow_org_write`.
 */

const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 500;

const ScopeArg = z.enum(["agent", "team", "org"]).optional();

interface MemCtx {
  nodeId: string;
  managerNodeId: string;
  memory: MemoryStore;
}

/** Resolve the optional `scope` arg to a concrete MemoryScope (default: team). */
function resolveScope(arg: string | undefined, ctx: MemCtx): MemoryScope {
  if (arg === "agent") return { kind: "agent", nodeId: ctx.nodeId };
  if (arg === "org") return { kind: "org" };
  return { kind: "team", managerNodeId: ctx.managerNodeId };
}

/** Guard org writes behind an explicit grant; returns an error result if blocked. */
function orgWriteBlocked(scope: MemoryScope, allowOrgWrite: boolean): { ok: false; error: string } | null {
  if (scope.kind === "org" && !allowOrgWrite) {
    return { ok: false, error: "org-scope writes require the `mem_allow_org_write` grant" };
  }
  return null;
}

// --- queue operations --------------------------------------------------------

/** A value's dedup identity: the named field (stringified) or the whole item. */
function itemKey(item: unknown, dedupBy?: string): string {
  if (dedupBy && item && typeof item === "object" && dedupBy in (item as Record<string, unknown>)) {
    return `f:${String((item as Record<string, unknown>)[dedupBy])}`;
  }
  return `v:${JSON.stringify(item)}`;
}

async function queueAppend(
  memory: MemoryStore,
  scope: MemoryScope,
  key: string,
  items: unknown[],
  opts: { dedupBy?: string; cap?: number; prepend?: boolean; allowOrgWrite: boolean },
): Promise<{ ok: boolean; appended?: number; skipped?: number; count?: number; error?: string }> {
  const blocked = orgWriteBlocked(scope, opts.allowOrgWrite);
  if (blocked) return blocked;
  return withLock(lockKey(scope, key), async () => {
    const list = await readJson<unknown[]>(memory, scope, key, []);
    const seen = new Set(list.map((it) => itemKey(it, opts.dedupBy)));
    const fresh: unknown[] = [];
    let skipped = 0;
    for (const it of items) {
      const k = itemKey(it, opts.dedupBy);
      if (seen.has(k)) {
        skipped += 1;
        continue;
      }
      seen.add(k);
      fresh.push(it);
    }
    let next = opts.prepend ? [...fresh, ...list] : [...list, ...fresh];
    if (opts.cap !== undefined && next.length > opts.cap) {
      // Keep the most recent `cap`: tail when appending, head when prepending.
      next = opts.prepend ? next.slice(0, opts.cap) : next.slice(next.length - opts.cap);
    }
    if (fresh.length || next.length !== list.length) await memory.set(scope, key, JSON.stringify(next), { allowOrgWrite: opts.allowOrgWrite });
    return { ok: true, appended: fresh.length, skipped, count: next.length };
  });
}

async function queueClear(
  memory: MemoryStore,
  scope: MemoryScope,
  key: string,
  by: string,
  values: string[],
  allowOrgWrite: boolean,
): Promise<{ ok: boolean; cleared?: number; count?: number; error?: string }> {
  const blocked = orgWriteBlocked(scope, allowOrgWrite);
  if (blocked) return blocked;
  return withLock(lockKey(scope, key), async () => {
    const list = await readJson<Record<string, unknown>[]>(memory, scope, key, []);
    const drop = new Set(values.map((v) => String(v)));
    const kept = list.filter((it) => !(it && typeof it === "object" && drop.has(String(it[by]))));
    await memory.set(scope, key, JSON.stringify(kept), { allowOrgWrite });
    return { ok: true, cleared: list.length - kept.length, count: kept.length };
  });
}

// --- MCP server --------------------------------------------------------------

export const GENERIC_MEMORY_TOOL_NAMES = [
  "mem_text_get",
  "mem_text_set",
  "mem_keys",
  "mem_json_get",
  "mem_json_set",
  "mem_json_merge",
  "mem_queue_append",
  "mem_queue_list",
  "mem_queue_clear",
  // Not a tool itself — a capability grant that unlocks org-scope writes.
  "mem_allow_org_write",
];

/**
 * Build the generic memory MCP server (`mem`) for the tools an agent was granted.
 * Scoped to the agent (private), its team (default), or org (reads open; writes
 * gated by `mem_allow_org_write`).
 */
export function buildGenericMemoryServer(grantedNames: string[], ctx: MemCtx): McpServerConfig | null {
  const granted = new Set(grantedNames);
  const allowOrgWrite = granted.has("mem_allow_org_write");
  const tools = [];

  if (granted.has("mem_text_get")) {
    tools.push(
      tool("mem_text_get", "Read a freeform text value by key (team scope by default).", { key: z.string(), scope: ScopeArg }, async (a) =>
        json({ value: await ctx.memory.get(resolveScope(a["scope"] as string | undefined, ctx), String(a["key"])) }),
      ),
    );
  }
  if (granted.has("mem_text_set")) {
    tools.push(
      tool(
        "mem_text_set",
        "Write a freeform text value at a key.",
        { key: z.string(), value: z.string(), scope: ScopeArg },
        async (a) => {
          const scope = resolveScope(a["scope"] as string | undefined, ctx);
          const blocked = orgWriteBlocked(scope, allowOrgWrite);
          if (blocked) return json(blocked);
          await ctx.memory.set(scope, String(a["key"]), String(a["value"]), { allowOrgWrite });
          return json({ ok: true });
        },
      ),
    );
  }
  if (granted.has("mem_keys")) {
    tools.push(
      tool("mem_keys", "List the keys stored in a scope.", { scope: ScopeArg }, async (a) =>
        json({ keys: await ctx.memory.list(resolveScope(a["scope"] as string | undefined, ctx)) }),
      ),
    );
  }
  if (granted.has("mem_json_get")) {
    tools.push(
      tool("mem_json_get", "Read a JSON value by key.", { key: z.string(), scope: ScopeArg }, async (a) =>
        json({ value: await readJson(ctx.memory, resolveScope(a["scope"] as string | undefined, ctx), String(a["key"]), null) }),
      ),
    );
  }
  if (granted.has("mem_json_set")) {
    tools.push(
      tool(
        "mem_json_set",
        "Write a JSON value (object/array/scalar) at a key.",
        { key: z.string(), value: z.unknown(), scope: ScopeArg },
        async (a) => {
          const scope = resolveScope(a["scope"] as string | undefined, ctx);
          const blocked = orgWriteBlocked(scope, allowOrgWrite);
          if (blocked) return json(blocked);
          await ctx.memory.set(scope, String(a["key"]), JSON.stringify(a["value"] ?? null), { allowOrgWrite });
          return json({ ok: true });
        },
      ),
    );
  }
  if (granted.has("mem_json_merge")) {
    tools.push(
      tool(
        "mem_json_merge",
        "Shallow-merge a patch object into the JSON object stored at a key (creates it if absent).",
        { key: z.string(), patch: z.record(z.unknown()), scope: ScopeArg },
        async (a) => {
          const scope = resolveScope(a["scope"] as string | undefined, ctx);
          const blocked = orgWriteBlocked(scope, allowOrgWrite);
          if (blocked) return json(blocked);
          const key = String(a["key"]);
          const result = await withLock(lockKey(scope, key), async () => {
            const cur = await readJson<Record<string, unknown>>(ctx.memory, scope, key, {});
            Object.assign(cur, (a["patch"] as Record<string, unknown>) ?? {});
            await ctx.memory.set(scope, key, JSON.stringify(cur), { allowOrgWrite });
            return cur;
          });
          return json({ ok: true, value: result });
        },
      ),
    );
  }
  if (granted.has("mem_queue_append")) {
    tools.push(
      tool(
        "mem_queue_append",
        "Append items to a list at a key in ONE call. `dedupBy` skips items whose named " +
          "field already exists; `cap` keeps only the most recent N; `prepend` adds to the front.",
        {
          key: z.string(),
          items: z.array(z.unknown()),
          dedupBy: z.string().optional(),
          cap: z.number().optional(),
          prepend: z.boolean().optional(),
          scope: ScopeArg,
        },
        async (a) =>
          json(
            await queueAppend(ctx.memory, resolveScope(a["scope"] as string | undefined, ctx), String(a["key"]), (a["items"] as unknown[]) ?? [], {
              ...(a["dedupBy"] !== undefined ? { dedupBy: String(a["dedupBy"]) } : {}),
              ...(a["cap"] !== undefined ? { cap: Number(a["cap"]) } : {}),
              ...(a["prepend"] !== undefined ? { prepend: Boolean(a["prepend"]) } : {}),
              allowOrgWrite,
            }),
          ),
      ),
    );
  }
  if (granted.has("mem_queue_list")) {
    tools.push(
      tool(
        "mem_queue_list",
        "List a queue's items, bounded. Returns {total, returned, items} so you process a manageable batch.",
        { key: z.string(), limit: z.number().optional(), scope: ScopeArg },
        async (a) => {
          const all = await readJson<unknown[]>(ctx.memory, resolveScope(a["scope"] as string | undefined, ctx), String(a["key"]), []);
          const limit = Math.min(Math.max(Number(a["limit"] ?? DEFAULT_LIST_LIMIT), 1), MAX_LIST_LIMIT);
          return json({ total: all.length, returned: Math.min(limit, all.length), items: all.slice(0, limit) });
        },
      ),
    );
  }
  if (granted.has("mem_queue_clear")) {
    tools.push(
      tool(
        "mem_queue_clear",
        "Remove items from a queue whose `by` field matches one of `values`, in one call.",
        { key: z.string(), by: z.string(), values: z.array(z.string()), scope: ScopeArg },
        async (a) =>
          json(
            await queueClear(
              ctx.memory,
              resolveScope(a["scope"] as string | undefined, ctx),
              String(a["key"]),
              String(a["by"]),
              (a["values"] as string[]) ?? [],
              allowOrgWrite,
            ),
          ),
      ),
    );
  }

  if (tools.length === 0) return null;
  return createSdkMcpServer({ name: "mem", version: "1.0.0", tools });
}

// Exported for unit tests and reuse by in-tree/plugin tools.
export { queueAppend, queueClear, resolveScope };
