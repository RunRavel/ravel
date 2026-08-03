import { promises as fs } from "node:fs";
import { z } from "zod";
import type { Budget } from "../schemas/common.js";
import type { AuditEvent } from "./audit.js";
import { systemClock, type Clock } from "../domain/ids.js";

/**
 * Operator-set spend ceilings (WO-008, DEC-013 / asks #18 + #23) — team
 * STATE, like `scheduler.json`, never config. When this document exists it
 * governs a process's per-run budget completely: `ProcessSpec.budget` is
 * ignored outright, with no merge between the two. Absent, config governs
 * exactly as before this existed.
 *
 * Deliberately minimal: an "amount" is always USD (the unit every other cost
 * surface in this runtime already uses — the scheduler's `maxUsdPerDay`, the
 * dashboard's `usage.usd`), a "scope" is per-run or a raw rolling-window
 * duration in seconds (never a calendar period — that is a platform concept),
 * and an "action" is stop or warn. No platform concepts (orgs, tenants,
 * billing periods, "who set this") enter this shape.
 */
export const LimitScope = z.union([
  z.object({ type: z.literal("per-run") }).strict(),
  /** A rolling window, computed fresh from the audit ledger on every check — never cached in memory. */
  z.object({ type: z.literal("rolling"), seconds: z.number().int().positive() }).strict(),
]);
export type LimitScope = z.infer<typeof LimitScope>;

export const LimitAction = z.enum(["stop", "warn"]);
export type LimitAction = z.infer<typeof LimitAction>;

/**
 * `action: "warn"` is rejected for a per-run scope at validation, not silently
 * downgraded — a per-run budget is the orchestration loop's own termination
 * condition (DEC-013); making it advisory reintroduces the unbounded run it
 * exists to prevent.
 */
export const LimitEntry = z
  .object({
    scope: LimitScope,
    amountUsd: z.number().positive(),
    action: LimitAction,
  })
  .strict()
  .refine((e) => e.scope.type !== "per-run" || e.action === "stop", {
    message: `a per-run limit's action must be "stop" — "warn" would make the run's own termination condition advisory`,
  });
export type LimitEntry = z.infer<typeof LimitEntry>;

/**
 * `default` applies to any process the document doesn't name — required and
 * non-empty, so a partial document can never silently uncap a process it
 * omits (the trap DEC-013 calls out explicitly).
 */
export const BudgetLimitsDocument = z
  .object({
    default: z.array(LimitEntry).min(1, "a limits document needs at least one default entry, or every unnamed process runs uncapped"),
    processes: z.record(z.array(LimitEntry)).default({}),
  })
  .strict();
export type BudgetLimitsDocument = z.infer<typeof BudgetLimitsDocument>;

export interface LimitsStoreDeps {
  /** Where the document persists — alongside scheduler.json in the state dir. */
  configPath: string;
  /** The durable audit ledger — rolling windows are summed from it fresh each check, never from an in-memory counter. */
  events: { all: () => readonly AuditEvent[] };
  clock?: Clock;
}

/** Result of the pre-flight rolling-window gate a launch must pass. */
export interface LimitsCheck {
  blocked: boolean;
  reason?: string;
  /** Tripped "warn" entries — the caller (App) is responsible for auditing them; this store doesn't hold an AuditSink. */
  warnings: string[];
}

/**
 * Loads/persists the operator's limits document and answers the two questions
 * enforcement needs: what per-run Budget governs this process (`perRunBudget`,
 * consulted by the orchestrator instead of `ProcessSpec.budget` once a
 * document exists), and whether a rolling-window ceiling blocks a launch
 * right now (`check`, consulted before any run starts — CLI, direct API, or
 * scheduler-triggered).
 */
export class LimitsStore {
  private doc: BudgetLimitsDocument | null = null;
  private readonly clock: Clock;

  constructor(private readonly deps: LimitsStoreDeps) {
    this.clock = deps.clock ?? systemClock;
  }

  /** Rehydrate from disk (called once at startup, mirroring `Scheduler.loadConfig`). Absent/invalid file → no document (config governs). */
  async load(): Promise<BudgetLimitsDocument | null> {
    try {
      const raw = await fs.readFile(this.deps.configPath, "utf8");
      this.doc = BudgetLimitsDocument.parse(JSON.parse(raw));
    } catch {
      this.doc = null;
    }
    return this.doc;
  }

  /** The current document, or null if none is set (config governs every process). */
  get(): BudgetLimitsDocument | null {
    return this.doc;
  }

  /** Validate and persist a full replacement document. Throws a ZodError on invalid input — the caller (the API route) turns that into a 400. */
  async set(doc: unknown): Promise<BudgetLimitsDocument> {
    const parsed = BudgetLimitsDocument.parse(doc);
    this.doc = parsed;
    await fs.writeFile(this.deps.configPath, JSON.stringify(parsed, null, 2), "utf8");
    return parsed;
  }

  /** Remove the document entirely — every process falls back to its config `budget` again. */
  async clear(): Promise<void> {
    this.doc = null;
    await fs.rm(this.deps.configPath, { force: true }).catch(() => {});
  }

  private entriesFor(processName: string): LimitEntry[] {
    if (!this.doc) return [];
    return this.doc.processes[processName] ?? this.doc.default;
  }

  /**
   * The per-run Budget this run must use, or `undefined` if no document is
   * set at all (config's `ProcessSpec.budget` governs, exactly as before this
   * existed). Once a document IS set, it is the only source: a process with
   * no per-run entry (only rolling entries, or none) gets `{}` — no
   * usd/tokens/seconds ceiling from this layer, config's `budget` is NOT
   * consulted. Turns still can't run away: the orchestrator's own
   * `ABSOLUTE_MAX_TURNS` loop bound is independent of this Budget entirely.
   */
  perRunBudget(processName: string): Budget | undefined {
    if (!this.doc) return undefined;
    const entry = this.entriesFor(processName).find((e) => e.scope.type === "per-run");
    return entry ? { usd: entry.amountUsd } : {};
  }

  /** USD spent by a process within the last `seconds`, joined started→finished by runId, summed fresh from the ledger every call. */
  private spentSince(processName: string, seconds: number): number {
    const since = this.clock.now() - seconds * 1000;
    const owningRun = new Map<string, string>();
    let total = 0;
    for (const e of this.deps.events.all()) {
      if (e.type === "process.started" && e.runId) owningRun.set(e.runId, String(e.data["process"] ?? ""));
      else if (e.type === "process.finished" && e.runId && owningRun.get(e.runId) === processName) {
        if (Date.parse(e.at) < since) continue;
        const usage = e.data["usage"] as { usd?: number } | undefined;
        total += usage?.usd ?? 0;
      }
    }
    return total;
  }

  /**
   * Pre-flight gate a launch must pass, evaluated fresh from the durable
   * ledger — never from an in-memory running total, so a worker restart mid-
   * window can't reset it (there is nothing cached to lose). A tripped
   * "stop" rolling entry blocks; a tripped "warn" entry is reported but never
   * blocks. Per-run entries aren't evaluated here — those bound a run already
   * in progress, via `perRunBudget` and the orchestrator's own BudgetMeter.
   */
  check(processName: string): LimitsCheck {
    const warnings: string[] = [];
    for (const entry of this.entriesFor(processName)) {
      if (entry.scope.type !== "rolling") continue;
      const spent = this.spentSince(processName, entry.scope.seconds);
      if (spent < entry.amountUsd) continue;
      const reason = `rolling ${entry.scope.seconds}s spend $${spent.toFixed(2)} ≥ limit $${entry.amountUsd}`;
      if (entry.action === "stop") return { blocked: true, reason, warnings };
      warnings.push(reason);
    }
    return { blocked: false, warnings };
  }
}
