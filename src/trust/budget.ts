import type { Budget } from "../schemas/common.js";
import { addUsage, emptyUsage, type Usage } from "../domain/types.js";
import { systemClock, type Clock } from "../domain/ids.js";

export type BudgetLimit = "tokens" | "usd" | "seconds" | "turns";

/**
 * Tracks consumption against a Budget. The orchestrator and agent runtime check
 * `exceeded()` before each step and terminate/escalate when a ceiling is hit —
 * this is the mechanism that makes autonomous work bounded rather than a
 * perpetual loop. An empty budget ({}), means "no ceilings" and never trips.
 */
export class BudgetMeter {
  private usage: Usage = emptyUsage();
  private turns = 0;
  private readonly startedAt: number;

  constructor(
    private readonly budget: Budget,
    private readonly clock: Clock = systemClock,
  ) {
    this.startedAt = clock.now();
  }

  recordUsage(u: Usage): void {
    this.usage = addUsage(this.usage, u);
  }

  recordTurn(): void {
    this.turns += 1;
  }

  elapsedSeconds(): number {
    return (this.clock.now() - this.startedAt) / 1000;
  }

  spent(): { usage: Usage; turns: number; seconds: number } {
    return { usage: this.usage, turns: this.turns, seconds: this.elapsedSeconds() };
  }

  /** Returns the first limit that has been reached, or null if within budget. */
  exceeded(): BudgetLimit | null {
    const b = this.budget;
    if (b.tokens !== undefined && this.usage.inputTokens + this.usage.outputTokens >= b.tokens) {
      return "tokens";
    }
    if (b.usd !== undefined && this.usage.usd >= b.usd) return "usd";
    if (b.turns !== undefined && this.turns >= b.turns) return "turns";
    if (b.seconds !== undefined && this.elapsedSeconds() >= b.seconds) return "seconds";
    return null;
  }

  remaining(): Budget {
    const b = this.budget;
    const out: Budget = {};
    if (b.tokens !== undefined) {
      out.tokens = Math.max(0, b.tokens - (this.usage.inputTokens + this.usage.outputTokens));
    }
    if (b.usd !== undefined) out.usd = Math.max(0, b.usd - this.usage.usd);
    if (b.turns !== undefined) out.turns = Math.max(0, b.turns - this.turns);
    if (b.seconds !== undefined) out.seconds = Math.max(0, b.seconds - this.elapsedSeconds());
    return out;
  }
}
