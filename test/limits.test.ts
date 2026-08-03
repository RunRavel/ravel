import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { LimitsStore, BudgetLimitsDocument } from "../src/trust/limits.js";
import type { AuditEvent } from "../src/trust/audit.js";

function ev(seq: number, at: string, type: string, data: Record<string, unknown>, runId?: string): AuditEvent {
  return { seq, at, type, ...(runId !== undefined ? { runId } : {}), data };
}

let tmp: string;
let cfgPath: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "limits-"));
  cfgPath = path.join(tmp, "limits.json");
});

describe("BudgetLimitsDocument schema", () => {
  it("rejects a per-run entry with action 'warn'", () => {
    const result = BudgetLimitsDocument.safeParse({
      default: [{ scope: { type: "per-run" }, amountUsd: 2, action: "warn" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a document with no default entries", () => {
    const result = BudgetLimitsDocument.safeParse({ default: [] });
    expect(result.success).toBe(false);
  });

  it("accepts a per-run 'stop' and a rolling 'warn' together", () => {
    const result = BudgetLimitsDocument.safeParse({
      default: [
        { scope: { type: "per-run" }, amountUsd: 2, action: "stop" },
        { scope: { type: "rolling", seconds: 86400 }, amountUsd: 40, action: "warn" },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe("LimitsStore — perRunBudget", () => {
  it("returns undefined (config governs) when no document is set", async () => {
    const store = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await store.load();
    expect(store.perRunBudget("Outreach")).toBeUndefined();
  });

  it("returns {usd} from the named process entry when present", async () => {
    const store = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await store.set({
      default: [{ scope: { type: "per-run" }, amountUsd: 1, action: "stop" }],
      processes: { Outreach: [{ scope: { type: "per-run" }, amountUsd: 5, action: "stop" }] },
    });
    expect(store.perRunBudget("Outreach")).toEqual({ usd: 5 });
  });

  it("falls back to the default entry for a process not named in the document", async () => {
    const store = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await store.set({ default: [{ scope: { type: "per-run" }, amountUsd: 1, action: "stop" }] });
    expect(store.perRunBudget("SomeOtherProcess")).toEqual({ usd: 1 });
  });

  it("returns {} (not undefined) when a document exists but names no per-run entry — never falls back to config", async () => {
    const store = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await store.set({ default: [{ scope: { type: "rolling", seconds: 3600 }, amountUsd: 10, action: "warn" }] });
    expect(store.perRunBudget("Outreach")).toEqual({});
  });
});

describe("LimitsStore — rolling-window check", () => {
  it("blocks when a 'stop' rolling entry's window spend meets the limit, computed fresh from the ledger", async () => {
    const events: AuditEvent[] = [
      ev(1, "2026-01-01T00:00:00.000Z", "process.started", { process: "Outreach" }, "run-1"),
      ev(2, "2026-01-01T00:00:05.000Z", "process.finished", { process: "Outreach", usage: { usd: 30 } }, "run-1"),
    ];
    const store = new LimitsStore({
      configPath: cfgPath,
      events: { all: () => events },
      clock: { now: () => Date.parse("2026-01-01T00:00:10.000Z"), iso: () => "" },
    });
    await store.set({ default: [{ scope: { type: "rolling", seconds: 86400 }, amountUsd: 25, action: "stop" }] });
    const check = store.check("Outreach");
    expect(check.blocked).toBe(true);
    expect(check.reason).toContain("30.00");
  });

  it("warns but does not block when a 'warn' rolling entry trips", async () => {
    const events: AuditEvent[] = [
      ev(1, "2026-01-01T00:00:00.000Z", "process.started", { process: "Outreach" }, "run-1"),
      ev(2, "2026-01-01T00:00:05.000Z", "process.finished", { process: "Outreach", usage: { usd: 30 } }, "run-1"),
    ];
    const store = new LimitsStore({
      configPath: cfgPath,
      events: { all: () => events },
      clock: { now: () => Date.parse("2026-01-01T00:00:10.000Z"), iso: () => "" },
    });
    await store.set({ default: [{ scope: { type: "rolling", seconds: 86400 }, amountUsd: 25, action: "warn" }] });
    const check = store.check("Outreach");
    expect(check.blocked).toBe(false);
    expect(check.warnings).toHaveLength(1);
  });

  it("ignores spend outside the rolling window", async () => {
    const events: AuditEvent[] = [
      ev(1, "2026-01-01T00:00:00.000Z", "process.started", { process: "Outreach" }, "run-1"),
      ev(2, "2026-01-01T00:00:05.000Z", "process.finished", { process: "Outreach", usage: { usd: 30 } }, "run-1"),
    ];
    const store = new LimitsStore({
      configPath: cfgPath,
      events: { all: () => events },
      // 2 days after the spend — well outside a 1-hour window.
      clock: { now: () => Date.parse("2026-01-03T00:00:10.000Z"), iso: () => "" },
    });
    await store.set({ default: [{ scope: { type: "rolling", seconds: 3600 }, amountUsd: 1, action: "stop" }] });
    expect(store.check("Outreach").blocked).toBe(false);
  });

  it("is restart-safe: a fresh LimitsStore recomputes the same block from the same durable ledger", async () => {
    const events: AuditEvent[] = [
      ev(1, "2026-01-01T00:00:00.000Z", "process.started", { process: "Outreach" }, "run-1"),
      ev(2, "2026-01-01T00:00:05.000Z", "process.finished", { process: "Outreach", usage: { usd: 30 } }, "run-1"),
    ];
    const clock = { now: () => Date.parse("2026-01-01T00:00:10.000Z"), iso: () => "" };
    const first = new LimitsStore({ configPath: cfgPath, events: { all: () => events }, clock });
    await first.set({ default: [{ scope: { type: "rolling", seconds: 86400 }, amountUsd: 25, action: "stop" }] });

    // Simulate a worker restart: a brand-new store, reloading from disk, no in-memory state carried over.
    const second = new LimitsStore({ configPath: cfgPath, events: { all: () => events }, clock });
    await second.load();
    expect(second.check("Outreach").blocked).toBe(true);
  });
});

describe("LimitsStore — persistence", () => {
  it("persists across load() calls and clears with clear()", async () => {
    const store = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await store.set({ default: [{ scope: { type: "per-run" }, amountUsd: 2, action: "stop" }] });

    const reloaded = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await reloaded.load();
    expect(reloaded.get()).not.toBeNull();
    expect(reloaded.perRunBudget("anything")).toEqual({ usd: 2 });

    await reloaded.clear();
    expect(reloaded.get()).toBeNull();
    const afterClear = new LimitsStore({ configPath: cfgPath, events: { all: () => [] } });
    await afterClear.load();
    expect(afterClear.get()).toBeNull();
  });
});
