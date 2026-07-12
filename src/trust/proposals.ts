import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { newId, systemClock, type Clock } from "../domain/ids.js";
import type { Proposal, ProposalStatus } from "../domain/types.js";

/** Stable hash of a tool input, for de-duping identical pending proposals. */
function hashInput(input: unknown): string {
  const stable = JSON.stringify(input, (_k, v) =>
    v && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)))
      : v,
  );
  return createHash("sha256").update(stable ?? "null").digest("hex").slice(0, 16);
}

function dedupeKey(p: Pick<Proposal, "runId" | "nodeId" | "action" | "input">): string {
  return `${p.runId ?? ""}|${p.nodeId}|${p.action}|${hashInput(p.input)}`;
}

/**
 * Durable store of proposed consequential actions awaiting human approval.
 *
 * - Source of truth is the in-memory map; the JSON file is a serialized mirror
 *   rewritten on each mutation (volumes are small — a flood is a design smell
 *   the approval queue is meant to surface, not absorb).
 * - `create` de-dupes against existing *pending* proposals on
 *   (runId, nodeId, action, inputHash), so a stray task re-dispatch can't queue
 *   the same action twice.
 * - Emits `created` / `updated` so the dashboard and the SSE event stream stay live.
 */
export class ProposalStore extends EventEmitter {
  private readonly byId = new Map<string, Proposal>();
  private writeChain: Promise<void> = Promise.resolve();

  constructor(
    private readonly opts: { filePath?: string; clock?: Clock } = {},
  ) {
    super();
  }

  private get clock(): Clock {
    return this.opts.clock ?? systemClock;
  }

  /** Load persisted proposals (call once at startup). */
  async load(): Promise<void> {
    if (!this.opts.filePath) return;
    try {
      const raw = await fs.readFile(this.opts.filePath, "utf8");
      for (const p of JSON.parse(raw) as Proposal[]) this.byId.set(p.id, p);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  /**
   * Record a proposed action. Returns the existing pending proposal if an
   * identical one is already queued (idempotent), else a new one.
   */
  async create(fields: Omit<Proposal, "id" | "createdAt" | "status">): Promise<Proposal> {
    const key = dedupeKey(fields);
    for (const existing of this.byId.values()) {
      if (existing.status === "pending" && dedupeKey(existing) === key) return existing;
    }
    const proposal: Proposal = {
      ...fields,
      id: newId("prop"),
      createdAt: this.clock.iso(),
      status: "pending",
    };
    this.byId.set(proposal.id, proposal);
    await this.persist();
    this.emit("created", proposal);
    return proposal;
  }

  get(id: string): Proposal | undefined {
    return this.byId.get(id);
  }

  list(status?: ProposalStatus): Proposal[] {
    const all = [...this.byId.values()];
    return status ? all.filter((p) => p.status === status) : all;
  }

  pending(): Proposal[] {
    return this.list("pending");
  }

  /** Update a proposal's status (and optional result/error). No-op if unknown. */
  async setStatus(id: string, status: ProposalStatus, patch: Partial<Proposal> = {}): Promise<Proposal | null> {
    const current = this.byId.get(id);
    if (!current) return null;
    const updated: Proposal = { ...current, ...patch, status };
    if (status === "approved" || status === "rejected") updated.decidedAt = this.clock.iso();
    if (status === "executed" || status === "failed") updated.executedAt = this.clock.iso();
    this.byId.set(id, updated);
    await this.persist();
    this.emit("updated", updated);
    return updated;
  }

  private async persist(): Promise<void> {
    if (!this.opts.filePath) return;
    const snapshot = JSON.stringify([...this.byId.values()]);
    this.writeChain = this.writeChain.then(async () => {
      await fs.mkdir(path.dirname(this.opts.filePath!), { recursive: true });
      await fs.writeFile(this.opts.filePath!, snapshot, "utf8");
    });
    await this.writeChain;
  }
}
