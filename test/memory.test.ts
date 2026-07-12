import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { MemoryStore } from "../src/memory/store.js";

let root: string;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-mem-"));
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe("MemoryStore", () => {
  it("isolates agent-private memory by node id", async () => {
    const store = new MemoryStore(root);
    await store.set({ kind: "agent", nodeId: "sales/a" }, "notes", "A's notes");
    await store.set({ kind: "agent", nodeId: "sales/b" }, "notes", "B's notes");
    expect(await store.get({ kind: "agent", nodeId: "sales/a" }, "notes")).toBe("A's notes");
    expect(await store.get({ kind: "agent", nodeId: "sales/b" }, "notes")).toBe("B's notes");
  });

  it("shares team memory under a manager", async () => {
    const store = new MemoryStore(root);
    await store.set({ kind: "team", managerNodeId: "sales" }, "playbook", "team playbook");
    expect(await store.get({ kind: "team", managerNodeId: "sales" }, "playbook")).toBe("team playbook");
    expect(await store.list({ kind: "team", managerNodeId: "sales" })).toEqual(["playbook"]);
  });

  it("returns null for missing keys", async () => {
    const store = new MemoryStore(root);
    expect(await store.get({ kind: "org" }, "missing")).toBeNull();
    expect(await store.list({ kind: "org" })).toEqual([]);
  });

  it("write-gates org memory", async () => {
    const store = new MemoryStore(root);
    await expect(store.set({ kind: "org" }, "policy", "x")).rejects.toThrow(/write-gated/);
    await store.set({ kind: "org" }, "policy", "no spending over $1k without approval", { allowOrgWrite: true });
    expect(await store.get({ kind: "org" }, "policy")).toContain("$1k");
  });
});
