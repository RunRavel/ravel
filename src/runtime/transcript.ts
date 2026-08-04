import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * One piece of agent-authored text recorded to a run's transcript — a turn's
 * prose, in the order it was produced. `type` is `"text"` today; a future
 * `"thinking"` (extended-thinking blocks) can be added without a shape change
 * (WO-020) — enabling extended thinking itself is a separate, out-of-scope
 * decision with a real per-run token cost.
 */
export interface TranscriptEntry {
  at: string;
  nodeId: string;
  /** The dispatched task this text belongs to. Absent for a planning turn (attributed to the owner node only, like `process.turn`). */
  contractId?: string;
  type: "text";
  text: string;
}

/**
 * Persists the opt-in per-run transcript (WO-021/ask #25): the full
 * agent-authored text a run produced, not just the 2000-character fragment of
 * a task's final turn that `task.finished.summary` carries. Deliberately NOT
 * part of `audit.jsonl` — that file is read wholesale into memory on every
 * worker boot (`JsonlAudit.load()`), linearly scanned on every dashboard poll,
 * launch, and scheduler tick (`Observer`, `LimitsStore`, `Scheduler`), and
 * teed live over SSE to every connected console (`EmittingAudit`). Putting
 * ~10x the text volume there would make all four of those paths ~10x
 * heavier, in a file already flagged as unbounded (RISK-RET). A separate
 * artifact nobody reads unless asked avoids all of it.
 *
 * One file per run, alongside its shared workspace: `.ravel/runs/<runId>/transcript.jsonl`.
 * Only constructed when `AppOptions.captureTranscripts` is true — with it off,
 * nothing calls this and no transcript file is ever created.
 */
export class TranscriptStore {
  constructor(private readonly runsRoot: string) {}

  private filePath(runId: string): string {
    return path.join(this.runsRoot, runId, "transcript.jsonl");
  }

  /**
   * Append entries for one call (a task, a planning turn, or a chat
   * exchange) to its run's transcript, in order. Best-effort: a write
   * failure never throws into the caller — a missing or unreadable
   * transcript must degrade cleanly, the run itself is never at stake for it.
   */
  async append(runId: string, entries: TranscriptEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const file = this.filePath(runId);
    try {
      await fs.mkdir(path.dirname(file), { recursive: true });
      const lines = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
      await fs.appendFile(file, lines, "utf8");
    } catch {
      /* best-effort — see class doc */
    }
  }

  /** Read a run's transcript, oldest-first. `[]` if none exists (capture was off, or the run hasn't written one yet). */
  async read(runId: string): Promise<TranscriptEntry[]> {
    try {
      const raw = await fs.readFile(this.filePath(runId), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.length > 0)
        .map((line) => JSON.parse(line) as TranscriptEntry);
    } catch {
      return [];
    }
  }
}
