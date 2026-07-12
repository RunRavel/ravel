import { describe, it, expect, beforeEach, afterEach } from "vitest";
import os from "node:os";
import path from "node:path";
import { promises as fs } from "node:fs";
import { ProposalStore } from "../src/trust/proposals.js";
import { ActionExecutor } from "../src/trust/executor.js";
import { ApprovalBroker } from "../src/trust/approval.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import { runOfficeAction, OFFICE_TOOL_NAMES } from "../src/runtime/officeActions.js";

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "ravel-prop-"));
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("ProposalStore", () => {
  it("creates, lists by status, and updates", async () => {
    const store = new ProposalStore();
    const p = await store.create({ nodeId: "a", action: "send_email", input: { to: "x" }, cwd: "/tmp" });
    expect(p.status).toBe("pending");
    expect(store.pending()).toHaveLength(1);
    await store.setStatus(p.id, "executed");
    expect(store.pending()).toHaveLength(0);
    expect(store.get(p.id)!.status).toBe("executed");
    expect(store.get(p.id)!.executedAt).toBeDefined();
  });

  it("de-dupes identical pending proposals", async () => {
    const store = new ProposalStore();
    const a = await store.create({ runId: "r1", nodeId: "n", action: "deliver_to_client", input: { to: "c" }, cwd: "/w" });
    const b = await store.create({ runId: "r1", nodeId: "n", action: "deliver_to_client", input: { to: "c" }, cwd: "/w" });
    expect(b.id).toBe(a.id); // same proposal returned, not a duplicate
    expect(store.pending()).toHaveLength(1);
  });

  it("persists and reloads", async () => {
    const file = path.join(dir, "proposals.json");
    const s1 = new ProposalStore({ filePath: file });
    const p = await s1.create({ nodeId: "a", action: "send_email", input: { to: "x" }, cwd: "/tmp" });
    const s2 = new ProposalStore({ filePath: file });
    await s2.load();
    expect(s2.get(p.id)?.action).toBe("send_email");
  });

  it("emits created/updated events", async () => {
    const store = new ProposalStore();
    const seen: string[] = [];
    store.on("created", () => seen.push("created"));
    store.on("updated", () => seen.push("updated"));
    const p = await store.create({ nodeId: "a", action: "send_email", input: {}, cwd: "/tmp" });
    await store.setStatus(p.id, "rejected");
    expect(seen).toEqual(["created", "updated"]);
  });
});

describe("ActionExecutor", () => {
  it("runs the registered office action and writes the office log", async () => {
    const audit = new InMemoryAudit();
    const exec = new ActionExecutor(audit);
    for (const name of OFFICE_TOOL_NAMES) exec.register(name, (input, ctx) => runOfficeAction(name, input, ctx));

    const res = await exec.execute({
      id: "p1",
      nodeId: "n",
      action: "deliver_to_client",
      input: { files: "report.pdf" },
      cwd: dir,
      createdAt: "now",
      status: "approved",
    });
    expect(res.ok).toBe(true);
    const log = await fs.readFile(path.join(dir, "shared", "_office_log.md"), "utf8");
    expect(log).toContain("delivery");
    expect(audit.all().some((e) => e.type === "proposal.executed")).toBe(true);
  });

  it("fails cleanly for an unregistered action", async () => {
    const exec = new ActionExecutor(new InMemoryAudit());
    const res = await exec.execute({
      id: "p2",
      nodeId: "n",
      action: "launch_rockets",
      input: {},
      cwd: dir,
      createdAt: "now",
      status: "approved",
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/no executor registered/);
  });
});

describe("ApprovalBroker deferred mode", () => {
  it("queues a proposal and denies immediately, without blocking", async () => {
    const audit = new InMemoryAudit();
    const store = new ProposalStore();
    const broker = new ApprovalBroker(audit, { mode: "deferred", proposals: store });

    const result = await broker.decide({
      nodeId: "n",
      toolName: "mcp__office__deliver_to_client",
      input: { to: "c" },
      policy: "ask",
      cwd: "/w",
      runId: "r1",
    });

    expect(result.decision).toBe("deny");
    expect(result.proposalId).toBeDefined();
    const pending = store.pending();
    expect(pending).toHaveLength(1);
    // The namespaced MCP tool name is stored as the bare action the executor knows.
    expect(pending[0]!.action).toBe("deliver_to_client");
    expect(audit.all().some((e) => e.type === "proposal.created")).toBe(true);
  });

  it("auto/deny/dry-run never create proposals", async () => {
    const store = new ProposalStore();
    const auto = new ApprovalBroker(new InMemoryAudit(), { mode: "deferred", proposals: store });
    expect((await auto.decide({ nodeId: "n", toolName: "t", input: {}, policy: "auto" })).decision).toBe("allow");
    expect((await auto.decide({ nodeId: "n", toolName: "t", input: {}, policy: "deny" })).decision).toBe("deny");
    const dry = new ApprovalBroker(new InMemoryAudit(), { mode: "deferred", proposals: store, dryRun: true });
    expect((await dry.decide({ nodeId: "n", toolName: "t", input: {}, policy: "ask" })).decision).toBe("deny");
    expect(store.pending()).toHaveLength(0);
  });
});
