import { promises as fs } from "node:fs";
import type { MemoryStore } from "../memory/store.js";
import type { AuditEvent } from "../trust/audit.js";

/** Operator-configurable auto-run policy for one process. */
export interface ProcessSchedule {
  /** Auto-run on/off. */
  enabled: boolean;
  /**
   * "adaptive" — the orchestrator paces itself between [min,max] (self-pacing).
   * "cron"     — fire on a fixed 5-field cron expression (e.g. "0 9 * * *" = daily 09:00).
   */
  mode: "adaptive" | "cron";
  /** adaptive: never fire more often than this (floor on the interval). */
  minMinutes: number;
  /** adaptive: never wait longer than this (ceiling; fallback when the orch gives no hint). */
  maxMinutes: number;
  /** cron: standard 5-field expression (minute hour day-of-month month day-of-week), local time. */
  cron?: string;
  /** Optional hard safety rail: pause auto-runs once rolling-24h spend for this process hits it. */
  maxUsdPerDay?: number;
}
export interface SchedulerConfig {
  processes: Record<string, ProcessSchedule>;
}

/** Live per-process state the UI surfaces (not persisted — rebuilt on start). */
interface RunState {
  nextRunAt: number; // epoch ms; 0 = due now
  running: boolean;
  lastRunAt?: number;
  lastRunId?: string;
  lastIntervalMin?: number;
  lastReason?: string;
  pausedForBudget?: boolean;
}

export interface SchedulerDeps {
  /** Fire a process run (same path the HTTP route uses); returns the runId. */
  launch: (name: string) => Promise<string> | string;
  /** True if a run of this process is currently in flight (single-flight guard). */
  isLive: (name: string) => boolean;
  /** Team-scope manager id for a process (where the orch writes its pacing hint), or null if unknown. */
  ownerOf: (name: string) => string | null;
  memory: MemoryStore;
  /** Durable audit — used to sum rolling-24h spend per process for the budget rail. */
  events: { all: () => readonly AuditEvent[] };
  configPath: string;
  /** Structured progress line (defaults to no-op). */
  log?: (line: string) => void;
  /** Injectable clock for tests. */
  now?: () => number;
  /** Tick cadence in ms (default 20s). */
  tickMs?: number;
}

const MIN_FLOOR = 1;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * A self-pacing scheduler: fires enabled processes on an adaptive interval. The
 * orchestrator decides *how long to wait* (it writes `next_run_minutes` to team
 * memory based on data/needs — caught up → long, backlog → short); the scheduler
 * enforces the operator's [min,max] clamp, single-flight, and an optional daily
 * spend ceiling. Judgment in the LLM, safety in code.
 */
export class Scheduler {
  private config: SchedulerConfig = { processes: {} };
  private readonly state = new Map<string, RunState>();
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly now: () => number;
  private readonly tickMs: number;
  private readonly log: (line: string) => void;

  constructor(private readonly deps: SchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tickMs = deps.tickMs ?? 20_000;
    this.log = deps.log ?? (() => {});
  }

  async start(): Promise<void> {
    await this.loadConfig();
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    // Don't keep the process alive just for the scheduler.
    this.timer.unref?.();
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  // --- config ----------------------------------------------------------------

  async loadConfig(): Promise<SchedulerConfig> {
    try {
      const raw = await fs.readFile(this.deps.configPath, "utf8");
      const parsed = JSON.parse(raw) as SchedulerConfig;
      this.config = { processes: parsed.processes ?? {} };
    } catch {
      this.config = { processes: {} };
    }
    this.reconcileState();
    return this.config;
  }

  /** Public snapshot for the API: config merged with live state. */
  snapshot(): {
    processes: Array<ProcessSchedule & { name: string } & Partial<RunState> & { spentTodayUsd: number }>;
  } {
    return {
      processes: Object.entries(this.config.processes).map(([name, cfg]) => {
        const st = this.state.get(name);
        return {
          name,
          ...cfg,
          spentTodayUsd: round4(this.spentTodayUsd(name)),
          ...(st ? { nextRunAt: st.nextRunAt, running: st.running, lastRunAt: st.lastRunAt, lastRunId: st.lastRunId, lastIntervalMin: st.lastIntervalMin, lastReason: st.lastReason, pausedForBudget: st.pausedForBudget } : {}),
        };
      }),
    };
  }

  /** Replace one process's policy (validated) and persist. Throws on an invalid cron. */
  async setProcess(name: string, patch: Partial<ProcessSchedule>): Promise<SchedulerConfig> {
    const prev = this.config.processes[name] ?? { enabled: false, mode: "adaptive" as const, minMinutes: 15, maxMinutes: 360 };
    const mode = patch.mode ?? prev.mode ?? "adaptive";
    const cron = patch.cron ?? prev.cron;
    if (mode === "cron" && !isValidCron(cron)) {
      throw new Error(`invalid cron "${cron ?? ""}" — expected 5 fields (minute hour day-of-month month day-of-week)`);
    }
    const next: ProcessSchedule = {
      enabled: patch.enabled ?? prev.enabled,
      mode,
      minMinutes: clampInt(patch.minMinutes ?? prev.minMinutes, MIN_FLOOR, 100_000),
      maxMinutes: clampInt(patch.maxMinutes ?? prev.maxMinutes, MIN_FLOOR, 100_000),
      ...(mode === "cron" && cron ? { cron: cron.trim() } : {}),
      ...(patch.maxUsdPerDay ?? prev.maxUsdPerDay ? { maxUsdPerDay: Math.max(0, patch.maxUsdPerDay ?? prev.maxUsdPerDay ?? 0) } : {}),
    };
    if (next.maxMinutes < next.minMinutes) next.maxMinutes = next.minMinutes;
    this.config.processes[name] = next;
    await this.saveConfig();
    // Recompute this entry's next-run time under the (possibly new) policy.
    const st = this.state.get(name) ?? { nextRunAt: this.now(), running: false };
    st.nextRunAt = this.dueTime(next);
    this.state.set(name, st);
    this.reconcileState();
    return this.config;
  }

  /** Remove a process from the schedule entirely. */
  async removeProcess(name: string): Promise<SchedulerConfig> {
    delete this.config.processes[name];
    this.state.delete(name);
    await this.saveConfig();
    return this.config;
  }

  private async saveConfig(): Promise<void> {
    await fs.writeFile(this.deps.configPath, JSON.stringify(this.config, null, 2), "utf8");
  }

  /** Ensure every configured process has state; a newly-enabled one is due per its mode. */
  private reconcileState(): void {
    for (const [name, cfg] of Object.entries(this.config.processes)) {
      if (!cfg.mode) cfg.mode = "adaptive"; // tolerate legacy configs written before modes.
      if (!this.state.has(name)) this.state.set(name, { nextRunAt: this.dueTime(cfg), running: false });
    }
    for (const name of [...this.state.keys()]) {
      if (!this.config.processes[name]) this.state.delete(name);
    }
  }

  /** The next time this process should fire from now: adaptive → now (due); cron → next match. */
  private dueTime(cfg: ProcessSchedule): number {
    if (cfg.mode === "cron" && cfg.cron) return nextCronTime(cfg.cron, this.now()) ?? this.now() + cfg.maxMinutes * 60_000;
    return this.now();
  }

  // --- the loop --------------------------------------------------------------

  /** One scheduling pass (public for deterministic testing; also driven by the timer). */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      for (const [name, cfg] of Object.entries(this.config.processes)) {
        if (!cfg.enabled) continue;
        const st = this.state.get(name);
        if (!st) continue;

        const live = this.deps.isLive(name);
        if (live) {
          st.running = true;
          continue;
        }
        // The run we launched has just settled → adapt the next interval now.
        if (st.running) {
          st.running = false;
          await this.scheduleNext(name, cfg, st);
          continue;
        }
        if (this.now() < st.nextRunAt) continue;

        // Safety rail: pause (don't fire) if the daily spend ceiling is reached.
        if (cfg.maxUsdPerDay !== undefined && this.spentTodayUsd(name) >= cfg.maxUsdPerDay) {
          st.pausedForBudget = true;
          // adaptive: re-check after a min interval (spend rolls off); cron: skip to next slot.
          st.nextRunAt = cfg.mode === "cron" && cfg.cron
            ? nextCronTime(cfg.cron, this.now()) ?? this.now() + 60 * 60_000
            : this.now() + cfg.minMinutes * 60_000;
          this.log(`· scheduler: "${name}" paused — 24h spend ≥ $${cfg.maxUsdPerDay}`);
          continue;
        }
        st.pausedForBudget = false;

        try {
          const runId = await this.deps.launch(name);
          st.running = true;
          st.lastRunAt = this.now();
          st.lastRunId = runId;
          this.log(`· scheduler: launched "${name}" (${runId})`);
        } catch (err) {
          // Launch failed — back off a min interval and try again.
          st.nextRunAt = this.now() + cfg.minMinutes * 60_000;
          this.log(`· scheduler: launch of "${name}" failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    } finally {
      this.ticking = false;
    }
  }

  /** After a run settles, set the next run time — cron: next match; adaptive: orch hint, clamped. */
  private async scheduleNext(name: string, cfg: ProcessSchedule, st: RunState): Promise<void> {
    if (cfg.mode === "cron" && cfg.cron) {
      st.nextRunAt = nextCronTime(cfg.cron, this.now()) ?? this.now() + 60 * 60_000;
      st.lastReason = `cron ${cfg.cron}`;
      this.log(`· scheduler: "${name}" next per cron ${cfg.cron}`);
      return;
    }
    const owner = this.deps.ownerOf(name);
    let minutes = cfg.maxMinutes; // safe fallback: if the orch left no hint, back off.
    let reason = "no pacing hint — backing off to max";
    if (owner) {
      const raw = await this.deps.memory.get({ kind: "team", managerNodeId: owner }, "next_run_minutes").catch(() => null);
      const parsed = raw !== null ? Number.parseInt(String(raw).trim(), 10) : NaN;
      if (Number.isFinite(parsed)) {
        minutes = parsed;
        const why = await this.deps.memory.get({ kind: "team", managerNodeId: owner }, "next_run_reason").catch(() => null);
        reason = why ? String(why).slice(0, 200) : "orch pacing hint";
      }
    }
    const clamped = clampInt(minutes, cfg.minMinutes, cfg.maxMinutes);
    st.lastIntervalMin = clamped;
    st.lastReason = `${reason}${clamped !== minutes ? ` (asked ${minutes}, clamped to ${clamped})` : ""}`;
    st.nextRunAt = this.now() + clamped * 60_000;
    this.log(`· scheduler: "${name}" next in ${clamped}m — ${st.lastReason}`);
  }

  /** Rolling-24h USD spent by a process (join started→finished by runId). */
  private spentTodayUsd(name: string): number {
    const since = this.now() - DAY_MS;
    const proc = new Map<string, string>(); // runId → process name
    let total = 0;
    for (const e of this.deps.events.all()) {
      if (e.type === "process.started" && e.runId) proc.set(e.runId, String(e.data["process"] ?? ""));
      else if (e.type === "process.finished" && e.runId && proc.get(e.runId) === name) {
        if (new Date(e.at).getTime() < since) continue;
        const usage = e.data["usage"] as { usd?: number } | undefined;
        total += usage?.usd ?? 0;
      }
    }
    return total;
  }
}

function clampInt(n: number, lo: number, hi: number): number {
  const v = Math.round(Number.isFinite(n) ? n : hi);
  return Math.max(lo, Math.min(hi, v));
}
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

// --- cron (standard 5-field, local time) -------------------------------------

interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  domRestricted: boolean;
  dowRestricted: boolean;
}

// Parse one cron field — "*", "5", "1-5", step "*"+"/15", list "1,3,5", "0-23/2" — into a value set.
function parseCronField(field: string, lo: number, hi: number): Set<number> {
  const out = new Set<number>();
  for (const part of field.split(",")) {
    const [rangePart, stepPart] = part.split("/");
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) throw new Error(`bad step in "${field}"`);
    let start = lo;
    let end = hi;
    if (rangePart && rangePart !== "*") {
      const bounds = rangePart.split("-").map((n) => Number.parseInt(n, 10));
      if (bounds.some((n) => !Number.isInteger(n))) throw new Error(`bad range in "${field}"`);
      start = bounds[0]!;
      end = bounds.length > 1 ? bounds[1]! : bounds[0]!;
    }
    if (start < lo || end > hi || start > end) throw new Error(`out-of-range field "${field}"`);
    for (let v = start; v <= end; v += step) out.add(v);
  }
  return out;
}

function parseCron(expr: string): CronFields {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) throw new Error("cron must have exactly 5 fields");
  const [min, hr, dom, mon, dow] = parts as [string, string, string, string, string];
  return {
    minute: parseCronField(min, 0, 59),
    hour: parseCronField(hr, 0, 23),
    dom: parseCronField(dom, 1, 31),
    month: parseCronField(mon, 1, 12),
    dow: parseCronField(dow.replace(/7/g, "0"), 0, 6), // allow 7 as Sunday
    domRestricted: dom !== "*",
    dowRestricted: dow !== "*",
  };
}

export function isValidCron(expr: string | undefined): boolean {
  if (!expr) return false;
  try {
    parseCron(expr);
    return true;
  } catch {
    return false;
  }
}

function cronMatches(f: CronFields, d: Date): boolean {
  if (!f.minute.has(d.getMinutes())) return false;
  if (!f.hour.has(d.getHours())) return false;
  if (!f.month.has(d.getMonth() + 1)) return false;
  // Standard cron: if BOTH day-of-month and day-of-week are restricted, either matching fires.
  const domOk = f.dom.has(d.getDate());
  const dowOk = f.dow.has(d.getDay());
  if (f.domRestricted && f.dowRestricted) return domOk || dowOk;
  if (f.domRestricted) return domOk;
  if (f.dowRestricted) return dowOk;
  return true;
}

/** The next epoch-ms strictly after `afterMs` that matches the cron (local time), or undefined within ~366d. */
export function nextCronTime(expr: string, afterMs: number): number | undefined {
  let f: CronFields;
  try {
    f = parseCron(expr);
  } catch {
    return undefined;
  }
  const d = new Date(afterMs);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1); // strictly after
  const horizon = 366 * 24 * 60;
  for (let i = 0; i < horizon; i++) {
    if (cronMatches(f, d)) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}
