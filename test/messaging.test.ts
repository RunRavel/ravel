import { describe, it, expect, afterEach } from "vitest";
import { compileRegistry, type RegistrySnapshot } from "../src/control-plane/registry.js";
import { MessageBus } from "../src/messaging/bus.js";
import { summarizeInbox } from "../src/messaging/inbox.js";
import { InMemoryAudit } from "../src/trust/audit.js";
import type { AgentMessage } from "../src/domain/types.js";
import { makeTempOrg, cleanup, agentMd } from "./helpers/tempOrg.js";

let roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(cleanup));
  roots = [];
});

/**
 * Topology:  ""(ceo) → sales(manager) → {sales/a, sales/b}
 */
async function topology(): Promise<RegistrySnapshot> {
  const root = await makeTempOrg({
    "agent.md": agentMd("CEO", { role: "ceo" }),
    "sales/agent.md": agentMd("Sales Manager", { role: "manager" }),
    "sales/a/agent.md": agentMd("Rep A", { role: "repA" }),
    "sales/b/agent.md": agentMd("Rep B", { role: "repB" }),
  });
  roots.push(root);
  const result = await compileRegistry(root, 1);
  if (!result.ok || !result.snapshot) throw new Error("compile failed");
  return result.snapshot;
}

function bus(snapshot: RegistrySnapshot, opts: { inboxCap?: number } = {}) {
  const audit = new InMemoryAudit();
  const b = new MessageBus({ audit, ...(opts.inboxCap !== undefined ? { inboxCap: opts.inboxCap } : {}) });
  b.updateTopology(snapshot);
  return { audit, b };
}

describe("MessageBus routing", () => {
  it("delivers a valid DOWN message to a direct report", async () => {
    const snap = await topology();
    const { b } = bus(snap);
    const msg = b.compose({
      fromNodeId: "sales",
      toNodeId: "sales/a",
      direction: "down",
      kind: "task",
      subject: "Do X",
      body: "details",
      priority: 5,
    });
    expect(await b.send(msg)).toBe("delivered");
    expect(b.inbox("sales/a").size()).toBe(1);
  });

  it("delivers UP (to manager) and SIDEWAYS (to peer)", async () => {
    const snap = await topology();
    const { b } = bus(snap);
    expect(
      await b.send(b.compose({ fromNodeId: "sales/a", toNodeId: "sales", direction: "up", kind: "result", subject: "done", body: "", priority: 1 })),
    ).toBe("delivered");
    expect(
      await b.send(b.compose({ fromNodeId: "sales/a", toNodeId: "sales/b", direction: "sideways", kind: "note", subject: "fyi", body: "", priority: 1 })),
    ).toBe("delivered");
  });

  it("dead-letters a message that skips the hierarchy (ceo → grandchild)", async () => {
    const snap = await topology();
    const { b } = bus(snap);
    const msg = b.compose({
      fromNodeId: "",
      toNodeId: "sales/a",
      direction: "down",
      kind: "task",
      subject: "skip-level",
      body: "",
      priority: 1,
    });
    expect(await b.send(msg)).toBe("deadletter");
    expect(b.deadLetters[0]!.reason).toBe("invalid_route");
  });

  it("dead-letters when the declared direction is wrong", async () => {
    const snap = await topology();
    const { b } = bus(snap);
    const msg = b.compose({
      fromNodeId: "sales",
      toNodeId: "sales/a",
      direction: "up", // actually down
      kind: "task",
      subject: "x",
      body: "",
      priority: 1,
    });
    expect(await b.send(msg)).toBe("deadletter");
    expect(b.deadLetters[0]!.reason).toMatch(/direction_mismatch/);
  });

  it("treats redelivery of the same id as an idempotent duplicate", async () => {
    const snap = await topology();
    const { b } = bus(snap);
    const msg = b.compose({ fromNodeId: "sales", toNodeId: "sales/a", direction: "down", kind: "note", subject: "x", body: "", priority: 1 });
    expect(await b.send(msg)).toBe("delivered");
    expect(await b.send(msg)).toBe("duplicate");
    expect(b.inbox("sales/a").size()).toBe(1);
  });

  it("escalates to the manager when a report's inbox is full", async () => {
    const snap = await topology();
    const { audit, b } = bus(snap, { inboxCap: 1 });
    const mk = (subject: string) =>
      b.compose({ fromNodeId: "sales", toNodeId: "sales/a", direction: "down", kind: "task", subject, body: "", priority: 1 });
    expect(await b.send(mk("first"))).toBe("delivered");
    expect(await b.send(mk("second"))).toBe("escalated");
    // Manager received an overflow note.
    expect(b.inbox("sales").peek().some((m) => m.subject.includes("overflow"))).toBe(true);
    expect(audit.all().some((e) => e.type === "message.backpressure")).toBe(true);
  });
});

describe("summarizeInbox", () => {
  const msg = (priority: number, subject: string, body = "x"): AgentMessage => ({
    id: `m_${subject}`,
    fromNodeId: "sales",
    toNodeId: "sales/a",
    direction: "down",
    kind: "note",
    subject,
    body,
    priority,
    enqueuedAt: new Date().toISOString(),
  });

  it("orders by priority and notes omissions when over budget", () => {
    const messages = [msg(1, "low"), msg(9, "high"), msg(5, "mid")];
    const summary = summarizeInbox(messages, 60);
    expect(summary.indexOf("high")).toBeLessThan(summary.indexOf("(+") === -1 ? Infinity : summary.indexOf("(+"));
    // High priority must appear; at least one lower one omitted given the tiny budget.
    expect(summary).toContain("high");
    expect(summary).toMatch(/\(\+\d+ more/);
  });

  it("returns a placeholder for an empty inbox", () => {
    expect(summarizeInbox([])).toBe("(no new messages)");
  });
});
