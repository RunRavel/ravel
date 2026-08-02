import { describe, it, expect } from "vitest";
import { InMemoryAudit, type AuditEvent } from "../src/trust/audit.js";
import { Observer } from "../src/trust/observability.js";
import type { Lifecycle } from "../src/runtime/lifecycle.js";
import type { ProposalStore } from "../src/trust/proposals.js";

/** Minimal lifecycle exposing one idle agent — Observer only calls `.all()`. */
function fakeLifecycle(nodeId: string): Lifecycle {
  return {
    all: () => [{ node: { id: nodeId, spec: { name: "Worker", role: "worker" } }, state: "idle", activity: {} }],
  } as unknown as Lifecycle;
}
const noProposals = { pending: () => [] } as unknown as ProposalStore;

function ev(seq: number, at: string, type: string, data: Record<string, unknown>, nodeId?: string): AuditEvent {
  return { seq, at, type, ...(nodeId !== undefined ? { nodeId } : {}), data };
}

describe("Observer — per-agent error + latency", () => {
  it("derives tasksFailed and latency (p50/mean) from paired task.started/finished", () => {
    const audit = new InMemoryAudit();
    audit.hydrate([
      ev(1, "2026-01-01T00:00:00.000Z", "task.started", { contractId: "c1", goal: "g" }, "worker"),
      ev(2, "2026-01-01T00:00:00.200Z", "task.finished", { contractId: "c1", status: "completed" }, "worker"),
      ev(3, "2026-01-01T00:00:01.000Z", "task.started", { contractId: "c2", goal: "g" }, "worker"),
      ev(4, "2026-01-01T00:00:01.400Z", "task.finished", { contractId: "c2", status: "failed" }, "worker"),
    ]);
    const obs = new Observer(audit, fakeLifecycle("worker"), noProposals);

    const agent = obs.snapshot().agents.find((a) => a.nodeId === "worker")!;
    expect(agent.tasksRun).toBe(2);
    expect(agent.tasksFailed).toBe(1); // the failed one
    expect(agent.p50Ms).toBe(200); // nearest-rank p50 of [200,400]
    expect(agent.meanMs).toBe(300);
  });

  it("reports null latency and zero failures for an agent with no finished tasks", () => {
    const audit = new InMemoryAudit();
    const obs = new Observer(audit, fakeLifecycle("worker"), noProposals);
    const agent = obs.snapshot().agents.find((a) => a.nodeId === "worker")!;
    expect(agent.tasksRun).toBe(0);
    expect(agent.tasksFailed).toBe(0);
    expect(agent.p50Ms).toBeNull();
    expect(agent.meanMs).toBeNull();
  });

  it("attributes process.turn usage to the owner node without counting it as a task (ask #14)", () => {
    const audit = new InMemoryAudit();
    audit.hydrate([
      ev(1, "2026-01-01T00:00:00.000Z", "process.turn", { turn: 1, usage: { inputTokens: 500, outputTokens: 100, usd: 0.01 } }, "worker"),
      ev(2, "2026-01-01T00:00:01.000Z", "task.started", { contractId: "c1", goal: "g" }, "worker"),
      ev(3, "2026-01-01T00:00:01.200Z", "task.finished", { contractId: "c1", status: "completed", usage: { inputTokens: 1000, outputTokens: 200, usd: 0.02 } }, "worker"),
    ]);
    const obs = new Observer(audit, fakeLifecycle("worker"), noProposals);
    const snapshot = obs.snapshot();

    const agent = snapshot.agents.find((a) => a.nodeId === "worker")!;
    expect(agent.usage.inputTokens).toBe(1500); // planner (500) + task (1000)
    expect(agent.tasksRun).toBe(1); // the planning turn is not a dispatched task
    expect(snapshot.totalUsage.inputTokens).toBe(1500);
  });

  it("counts aborted and budget_exhausted as failures", () => {
    const audit = new InMemoryAudit();
    audit.hydrate([
      ev(1, "2026-01-01T00:00:00.000Z", "task.finished", { contractId: "a", status: "aborted" }, "worker"),
      ev(2, "2026-01-01T00:00:00.000Z", "task.finished", { contractId: "b", status: "budget_exhausted" }, "worker"),
      ev(3, "2026-01-01T00:00:00.000Z", "task.finished", { contractId: "c", status: "completed" }, "worker"),
    ]);
    const obs = new Observer(audit, fakeLifecycle("worker"), noProposals);
    const agent = obs.snapshot().agents.find((a) => a.nodeId === "worker")!;
    expect(agent.tasksRun).toBe(3);
    expect(agent.tasksFailed).toBe(2);
  });
});
