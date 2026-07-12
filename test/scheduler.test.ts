import { describe, it, expect, beforeEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { Scheduler, isValidCron, nextCronTime } from "../src/service/scheduler.js";
import type { AuditEvent } from "../src/trust/audit.js";

/** Minimal fakes so the scheduler can be driven with an injected clock. */
function harness(opts: { hint?: string | null; reason?: string | null; events?: AuditEvent[] } = {}) {
  let clock = 1_000_000;
  let live = false;
  const launched: string[] = [];
  const mem = new Map<string, string>();
  if (opts.hint != null) mem.set("next_run_minutes", opts.hint);
  if (opts.reason != null) mem.set("next_run_reason", opts.reason);
  const events = opts.events ?? [];
  const memory = {
    get: async (_scope: unknown, key: string) => (mem.has(key) ? mem.get(key)! : null),
  } as never;
  return {
    launched,
    now: () => clock,
    advanceMinutes: (m: number) => (clock += m * 60_000),
    setLive: (v: boolean) => (live = v),
    deps: (configPath: string) => ({
      launch: (name: string) => {
        const id = `run-${launched.length + 1}`;
        launched.push(name);
        return id;
      },
      isLive: () => live,
      ownerOf: () => "signal-research",
      memory,
      events: { all: () => events },
      configPath,
      now: () => clock,
    }),
  };
}

let tmp: string;
beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), "sched-"));
});

describe("Scheduler", () => {
  it("is inert with no config", async () => {
    const h = harness();
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await s.start();
    await s.tick();
    expect(h.launched).toEqual([]);
    s.stop();
  });

  it("launches an enabled process, then holds single-flight while it runs", async () => {
    const h = harness({ hint: "5" });
    const cfg = path.join(tmp, "scheduler.json");
    const s = new Scheduler(h.deps(cfg));
    await s.setProcess("Analyze Corpus", { enabled: true, minMinutes: 10, maxMinutes: 360 });

    await s.tick(); // due now → launch
    expect(h.launched).toEqual(["Analyze Corpus"]);

    h.setLive(true);
    await s.tick(); // still running → no second launch
    expect(h.launched.length).toBe(1);
  });

  it("adapts the next interval from the orch hint, clamped to [min,max]", async () => {
    const h = harness({ hint: "5", reason: "backlog remained" });
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await s.setProcess("Analyze Corpus", { enabled: true, minMinutes: 10, maxMinutes: 360 });

    await s.tick(); // launch
    h.setLive(true);
    await s.tick(); // running
    h.setLive(false);
    await s.tick(); // settled → schedule next; hint 5 < min 10 → clamp up to 10

    const p = s.snapshot().processes[0]!;
    expect(p.lastIntervalMin).toBe(10);
    expect(p.lastReason).toContain("backlog remained");
    // Not due yet (10m out) → no relaunch.
    await s.tick();
    expect(h.launched.length).toBe(1);
    // After 10 minutes it fires again.
    h.advanceMinutes(10);
    await s.tick();
    expect(h.launched.length).toBe(2);
  });

  it("backs off to max when the orch leaves no hint", async () => {
    const h = harness({ hint: null });
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await s.setProcess("Analyze Corpus", { enabled: true, minMinutes: 10, maxMinutes: 120 });
    await s.tick();
    h.setLive(true);
    await s.tick();
    h.setLive(false);
    await s.tick();
    expect(s.snapshot().processes[0]!.lastIntervalMin).toBe(120);
  });

  it("pauses (does not launch) when the rolling-24h spend ceiling is hit", async () => {
    const now = 5_000_000;
    const events: AuditEvent[] = [
      { seq: 1, at: new Date(now - 60_000).toISOString(), type: "process.started", runId: "r1", data: { process: "Analyze Corpus" } },
      { seq: 2, at: new Date(now - 30_000).toISOString(), type: "process.finished", runId: "r1", data: { usage: { usd: 12 } } },
    ];
    const h = harness({ events });
    // pin the harness clock to `now`
    const deps = h.deps(path.join(tmp, "scheduler.json"));
    const s = new Scheduler({ ...deps, now: () => now });
    await s.setProcess("Analyze Corpus", { enabled: true, minMinutes: 10, maxMinutes: 360, maxUsdPerDay: 10 });
    await s.tick();
    expect(h.launched).toEqual([]);
    expect(s.snapshot().processes[0]!.pausedForBudget).toBe(true);
  });

  it("persists config and reloads it", async () => {
    const cfg = path.join(tmp, "scheduler.json");
    const h = harness();
    const s1 = new Scheduler(h.deps(cfg));
    await s1.setProcess("Analyze Corpus", { enabled: true, minMinutes: 15, maxMinutes: 200 });
    const s2 = new Scheduler(h.deps(cfg));
    await s2.loadConfig();
    const p = s2.snapshot().processes[0]!;
    expect(p.enabled).toBe(true);
    expect(p.minMinutes).toBe(15);
    expect(p.maxMinutes).toBe(200);
  });

  it("clamps invalid bounds (max >= min, min >= 1)", async () => {
    const h = harness();
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await s.setProcess("Analyze Corpus", { enabled: true, minMinutes: 0, maxMinutes: 5 });
    const p = s.snapshot().processes[0]!;
    expect(p.minMinutes).toBe(1);
    expect(p.maxMinutes).toBe(5);
  });

  it("rejects an invalid cron expression", async () => {
    const h = harness();
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await expect(s.setProcess("X", { enabled: true, mode: "cron", cron: "not a cron" })).rejects.toThrow(/cron/i);
    await expect(s.setProcess("X", { enabled: true, mode: "cron", cron: "0 9 * * *" })).resolves.toBeTruthy();
  });

  it("fires a cron process when its scheduled minute arrives", async () => {
    const h = harness();
    const s = new Scheduler(h.deps(path.join(tmp, "scheduler.json")));
    await s.setProcess("Daily", { enabled: true, mode: "cron", cron: "* * * * *" }); // every minute
    await s.tick(); // not yet due (next match is the next minute boundary)
    expect(h.launched.length).toBe(0);
    h.advanceMinutes(2);
    await s.tick();
    expect(h.launched).toEqual(["Daily"]);
  });
});

describe("cron parsing", () => {
  it("validates field shapes", () => {
    expect(isValidCron("0 9 * * *")).toBe(true);
    expect(isValidCron("*/15 * * * 1-5")).toBe(true);
    expect(isValidCron("0 9 * *")).toBe(false); // 4 fields
    expect(isValidCron("99 9 * * *")).toBe(false); // minute out of range
    expect(isValidCron(undefined)).toBe(false);
  });

  it("computes the next matching local time", () => {
    // From a fixed instant, the next "09:00 daily" is at local hour 9, minute 0.
    const from = new Date(2026, 6, 1, 10, 30, 0).getTime(); // Jul 1 2026, 10:30 local (past 9am)
    const next = nextCronTime("0 9 * * *", from)!;
    const d = new Date(next);
    expect(d.getHours()).toBe(9);
    expect(d.getMinutes()).toBe(0);
    expect(next).toBeGreaterThan(from);
  });
});
