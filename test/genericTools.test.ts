import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MemoryStore, type MemoryScope } from "../src/memory/store.js";
import { readJson } from "../src/memory/kv.js";
import { queueAppend, queueClear, resolveScope, buildGenericMemoryServer } from "../src/memory/genericTools.js";

let root: string;
let memory: MemoryStore;
const ctx = { nodeId: "intel/x-watcher", managerNodeId: "intel", memory: null as unknown as MemoryStore };
const team: MemoryScope = { kind: "team", managerNodeId: "intel" };

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-generic-"));
  memory = new MemoryStore(root);
  ctx.memory = memory;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("queue ops", () => {
  it("appends, dedups by a field, and reports counts", async () => {
    const r1 = await queueAppend(memory, team, "people", [{ h: "a" }, { h: "b" }, { h: "a" }], { dedupBy: "h", allowOrgWrite: false });
    expect(r1).toMatchObject({ ok: true, appended: 2, skipped: 1, count: 2 });
    // A later batch dedups against what's already stored.
    const r2 = await queueAppend(memory, team, "people", [{ h: "b" }, { h: "c" }], { dedupBy: "h", allowOrgWrite: false });
    expect(r2.appended).toBe(1);
    expect(await readJson(memory, team, "people", [])).toHaveLength(3);
  });

  it("caps to the most recent N when appending", async () => {
    await queueAppend(memory, team, "log", [1, 2, 3, 4, 5], { cap: 3, allowOrgWrite: false });
    expect(await readJson<number[]>(memory, team, "log", [])).toEqual([3, 4, 5]);
  });

  it("prepends newest-first and caps from the front", async () => {
    await queueAppend(memory, team, "feed", [{ h: "old" }], { allowOrgWrite: false });
    await queueAppend(memory, team, "feed", [{ h: "new" }], { prepend: true, cap: 1, allowOrgWrite: false });
    expect(await readJson<{ h: string }[]>(memory, team, "feed", [])).toEqual([{ h: "new" }]);
  });

  it("clears items by field value", async () => {
    await queueAppend(memory, team, "q", [{ h: "a" }, { h: "b" }, { h: "c" }], { allowOrgWrite: false });
    const r = await queueClear(memory, team, "q", "h", ["a", "c"], false);
    expect(r).toMatchObject({ ok: true, cleared: 2, count: 1 });
    expect(await readJson<{ h: string }[]>(memory, team, "q", [])).toEqual([{ h: "b" }]);
  });
});

describe("scope routing", () => {
  it("resolves agent/team/org and defaults to team", () => {
    expect(resolveScope(undefined, ctx)).toEqual({ kind: "team", managerNodeId: "intel" });
    expect(resolveScope("agent", ctx)).toEqual({ kind: "agent", nodeId: "intel/x-watcher" });
    expect(resolveScope("org", ctx)).toEqual({ kind: "org" });
  });
});

describe("org-write gating", () => {
  it("blocks org-scope writes without the grant", async () => {
    const r = await queueAppend(memory, { kind: "org" }, "policies", [{ x: 1 }], { allowOrgWrite: false });
    expect(r).toMatchObject({ ok: false });
    expect(await readJson(memory, { kind: "org" }, "policies", [])).toHaveLength(0);
  });
  it("allows org-scope writes with the grant", async () => {
    const r = await queueAppend(memory, { kind: "org" }, "policies", [{ x: 1 }], { allowOrgWrite: true });
    expect(r).toMatchObject({ ok: true, appended: 1 });
  });
});

describe("buildGenericMemoryServer", () => {
  it("builds only when a generic memory tool is granted", () => {
    expect(buildGenericMemoryServer(["mem_queue_append", "mem_queue_list"], ctx)).not.toBeNull();
    expect(buildGenericMemoryServer([], ctx)).toBeNull();
    expect(buildGenericMemoryServer(["watchlist_list"], ctx)).toBeNull();
  });
});
